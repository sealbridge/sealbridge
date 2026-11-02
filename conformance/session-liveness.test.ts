// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, signEnvelope } from '../packages/core/src/index.js';
import type { Json } from '../packages/core/src/index.js';
import { createRelayFetchHandler, HttpRelayClient, InMemoryRelay, SseRelayClient, isTransientRelayError } from '../packages/relay/src/index.js';
import type { RelayTransport } from '../packages/relay/src/index.js';
import { AcpMcpServer, PolicyAutoApprovalProvider, RequesterClient, WorkerNode } from '../packages/runtime/src/index.js';
import type { AgentAdapter, DelegateOptions, WorkerNodeOptions } from '../packages/runtime/src/index.js';
import { SessionTimeouts } from '../packages/runtime/src/session-timeouts.js';

const origin = 'https://relay.example';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((r, fail) => { resolve = r; reject = fail; });
  return { promise, resolve, reject };
}
function adapter(execute?: AgentAdapter['executeTask']): AgentAdapter {
  return { id: 'liveness', name: 'liveness', skills: [], async executeTask(context) {
    context.reportIsolation?.('subprocess_restricted');
    return execute ? execute(context) : { ok: true };
  } };
}
function fixture(options: { sse?: boolean; fetcher?: (base: typeof fetch) => typeof fetch;
  execute?: AgentAdapter['executeTask']; worker?: Partial<WorkerNodeOptions> } = {}) {
  const relay = new InMemoryRelay();
  const handler = createRelayFetchHandler({ relay });
  const base: typeof fetch = async (input, init) => handler(new Request(input, init));
  const fetcher = options.fetcher?.(base) ?? base;
  const requesterKey = generateKeyPair(), workerKey = generateKeyPair();
  const Client = options.sse ? SseRelayClient : HttpRelayClient;
  const workerRelay = new Client(origin, fetcher, workerKey, { requestTimeoutMs: options.worker?.connectTimeoutMs });
  const requesterRelay = new Client(origin, fetcher, requesterKey);
  if (options.sse) cleanup.push(async () => {
    await (workerRelay as SseRelayClient).close();
    await (requesterRelay as SseRelayClient).close();
  });
  const worker = new WorkerNode({ checkPeer: () => 'trusted', owner: workerKey, relay: workerRelay, relayUrl: origin,
    adapter: adapter(options.execute), approvalProvider: new PolicyAutoApprovalProvider(workerKey),
    ...options.worker });
  cleanup.push(() => worker.stop());
  const requester = new RequesterClient({ owner: requesterKey, relay: requesterRelay,
    approvalProvider: new PolicyAutoApprovalProvider(requesterKey) });
  const task = (overrides: Partial<DelegateOptions> = {}) => requester.delegate({
    to: worker.invite(), title: 'liveness', description: 'local task', input: {}, ...overrides,
  });
  return { worker, requester, task, relay, workerKey, requesterKey };
}

// Every transport here is an in-process Fetch bridge. No sockets or deployed relay are used.
describe('session liveness and recovery', () => {
  it('reconnects SSE after a transient close and settles the task with fresh authentication', async () => {
    let streams = 0;
    const credentials: string[] = [];
    const f = fixture({ sse: true, fetcher: base => async (input, init) => {
      if (new URL(String(input)).pathname === '/stream') {
        streams++;
        credentials.push(new Headers(init?.headers).get('authorization') ?? '');
        if (streams === 1) {
          const response = await base(input, init);
          const reader = response.body!.getReader();
          return new Response(new ReadableStream({ async start(controller) {
            try {
              for (;;) {
                const { value, done } = await reader.read();
                if (done) { controller.close(); return; }
                controller.enqueue(value);
                // Disconnect after delivering the first actual frame of the live task.
                if (new TextDecoder().decode(value).includes('data: ')) {
                  controller.close();
                  await reader.cancel();
                  return;
                }
              }
            } catch (error) { controller.error(error); }
          }, cancel: () => reader.cancel() }));
        }
      }
      return base(input, init);
    } });
    const running = f.worker.start({ once: true });
    const [result] = await Promise.all([f.task(), running]);
    expect(result.state).toBe('SETTLED');
    expect(streams).toBeGreaterThanOrEqual(3);
    expect(new Set(credentials).size).toBe(credentials.length);
  });

  it('preserves unacknowledged SSE frames across reconnects and acknowledges resumed delivery', async () => {
    vi.useFakeTimers();
    const key = generateKeyPair();
    const relay = new InMemoryRelay();
    const handler = createRelayFetchHandler({ relay });
    const frame = signEnvelope({ taskId: 'resume', recipientDid: key.did, seq: 0,
      eventType: 'PROPOSE', payload: {} }, key);
    relay.send(frame);
    let connections = 0;
    const client = new SseRelayClient(origin, async (input, init) => {
      if (new URL(String(input)).pathname === '/stream' && ++connections === 1) {
        // Lease the frame, then drop the connection before any bytes reach the consumer.
        const response = await handler(new Request(input, init));
        const reader = response.body!.getReader();
        await reader.read();
        await reader.read();
        await reader.cancel();
        return new Response(new ReadableStream({ start(c) { c.close(); } }));
      }
      return handler(new Request(input, init));
    }, key);
    cleanup.push(() => client.close());
    const receiving = (async () => {
      for (;;) { const e = await client.receive(key.did, 1000); if (e) return e; }
    })();
    await vi.advanceTimersByTimeAsync(32_000);
    expect(await receiving).toEqual(frame);
    await client.acknowledgeDelivery(key.did, frame.payload.envelopeId);
    expect(relay.snapshot().queues.flatMap(([, queue]) => queue)).toEqual([]);
  });

  it.each([401, 403])('keeps SSE HTTP %s terminal across subsequent reads (401 recovery disabled)', async status => {
    vi.useFakeTimers();
    const owner = generateKeyPair();
    const fetcher = vi.fn(async () => new Response('private response text', { status }));
    const client = new SseRelayClient(origin, fetcher as typeof fetch, owner, { maxAuthRecoveryAttempts: status === 401 ? 0 : 3 });
    cleanup.push(() => client.close());
    await expect(client.receive(owner.did)).rejects.toThrow('RELAY_REJECTED: ' + status);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(client.receive(owner.did)).rejects.toThrow('RELAY_REJECTED: ' + status);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(client.connectionStatus).toBe('unavailable');
  });

  it('interrupts SSE reconnect backoff when its owner aborts', async () => {
    const owner = generateKeyPair(), stop = new AbortController();
    const attempted = deferred<void>();
    const fetcher = vi.fn(async () => {
      attempted.resolve();
      return new Response(new ReadableStream({ start(c) { c.close(); } }));
    });
    const client = new SseRelayClient(origin, fetcher as typeof fetch, owner);
    cleanup.push(() => client.close());
    const receiving = client.receive(owner.did, 30_000, stop.signal);
    const rejected = expect(receiving).rejects.toThrow('owner stopped');
    await attempted.promise;
    stop.abort(new Error('owner stopped'));
    await rejected;
    await client.close();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('supervises a dropped worker connection without rerunning execution', async () => {
    let dropped = false, executions = 0;
    const statuses: string[] = [];
    const f = fixture({ fetcher: base => async (input, init) => {
      if (!dropped && new URL(String(input)).pathname === '/envelopes' && !init?.method && new URL(String(input)).searchParams.get('role') === 'worker') {
        dropped = true;
        throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      }
      return base(input, init);
    }, execute: async () => { executions++; return { ok: true }; },
    worker: { onStatus: status => statuses.push(status) } });
    const [result] = await Promise.all([f.task(), f.worker.start({ once: true })]);
    expect(result.state).toBe('SETTLED');
    expect(statuses).toContain('reconnecting');
    expect(statuses).toContain('connected');
    expect(statuses.at(-1)).toBe('stopped');
    expect(executions).toBe(1);
  });

  it.each(['idle poll', 'running poll', 'acknowledgement'])('recovers a worker 401 during %s with one execution', async phase => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let rejected = false, executions = 0, publications = 0;
    const f = fixture({ fetcher: base => async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/agents' && init?.method === 'POST') publications++;
      const workerPoll = url.pathname === '/envelopes' && !init?.method && url.searchParams.get('role') === 'worker';
      const reject = phase === 'acknowledgement'
        ? init?.method === 'DELETE' && executions > 0
        : workerPoll && (phase === 'idle poll' || executions > 0);
      if (!rejected && reject) {
        rejected = true;
        return new Response('ignored response', { status: 401 });
      }
      return base(input, init);
    }, execute: async () => {
      executions++;
      await new Promise<void>(resolve => setTimeout(resolve, 300));
      return { ok: true };
    }, worker: { connectTimeoutMs: 2000, publishToRegistry: false } });
    const approve = vi.spyOn(f.worker.options.approvalProvider!, 'approve');
    const both = Promise.all([f.task(), f.worker.start({ once: true })]);
    await vi.advanceTimersByTimeAsync(10_000);
    const [result] = await both;
    expect(result.state).toBe('SETTLED');
    expect(result.deliverable).toEqual({ ok: true });
    expect(rejected).toBe(true);
    expect(executions).toBe(1);
    expect(approve.mock.calls.filter(([request]) => request.gate === 'contract_acceptance')).toHaveLength(1);
    expect(publications).toBe(0);
  });

  it('propagates worker auth exhaustion through the supervisor without restarting its budget', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const owner = generateKeyPair();
    const fetcher = vi.fn(async () => new Response('ignored response', { status: 401 }));
    const execute = vi.fn();
    const statuses: string[] = [];
    const worker = new WorkerNode({ checkPeer: () => 'trusted', owner, relay: new HttpRelayClient(origin, fetcher, owner),
      adapter: adapter(execute), connectTimeoutMs: 50, onStatus: status => statuses.push(status) });
    cleanup.push(() => worker.stop());
    const checked = expect(worker.start()).rejects.toMatchObject({ code: 'RELAY_AUTH_RECOVERY_EXHAUSTED',
      message: expect.stringContaining('system clock') });
    await vi.advanceTimersByTimeAsync(10_000);
    await checked;
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(execute).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toBe('unavailable');
  });

  it.each([401, 403])('stops a worker on permanent HTTP %s without a restart loop', async status => {
    const owner = generateKeyPair();
    const receive = vi.fn().mockRejectedValue(new Error('RELAY_REJECTED: ' + status + ' private response text'));
    const statuses: string[] = [];
    const worker = new WorkerNode({ checkPeer: () => 'trusted', owner, relay: { send() {}, receive }, adapter: adapter(),
      onStatus: value => statuses.push(value) });
    await expect(worker.start()).rejects.toThrow('RELAY_REJECTED: ' + status);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toBe('unavailable');
  });

  it.each(['RELAY_REJECTED: 401 private response text', 'RELAY_REJECTED: 403 private response text',
    'RELAY_TAMPERING_DETECTED'])('fails every attached requester task on terminal relay failure: %s', async failure => {
    const read = deferred<never>();
    const receive = vi.fn(() => read.promise);
    const relay: RelayTransport = { send() {}, receive };
    const client = new RequesterClient({ owner: generateKeyPair(), relay });
    const to = generateKeyPair().did;
    const tasks = [client.delegate({ to, title: 'one', description: 'local task', input: {} }),
      client.delegate({ to, title: 'two', description: 'local task', input: {} })];
    const results = Promise.allSettled(tasks);
    // Both calls attach before the shared reader fails.
    await Promise.resolve();
    read.reject(new Error(failure));
    for (const result of await results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason.message).toBe(failure.replace(' private response text', ''));
      }
    }
    expect(receive).toHaveBeenCalledTimes(1);
  });

  it('surfaces a closed requester inbox without waiting for an error send on the failed relay', async () => {
    const owner = generateKeyPair();
    const send = vi.fn((envelope: Parameters<RelayTransport['send']>[0]) =>
      envelope.payload.eventType === 'ERROR' ? new Promise<void>(() => {}) : undefined);
    const client = new RequesterClient({ owner, relay: { send,
      receive: async () => { throw new Error('RELAY_REJECTED: 401'); } } });
    await expect(client.delegate({ to: generateKeyPair().did, title: 'local', description: 'local task',
      input: {} })).rejects.toThrow('RELAY_REJECTED: 401');
    expect(send.mock.calls.some(([envelope]) => envelope.payload.eventType === 'ERROR')).toBe(false);
  });

  it('completes a healthy task beyond two minutes when the agreed budget allows it', async () => {
    vi.useFakeTimers();
    const started = deferred<void>(), output = deferred<Json>();
    const f = fixture({ execute: async () => { started.resolve(); return output.promise; } });
    const both = Promise.all([f.task({ budget: { maxWallClockSeconds: 240 } }), f.worker.start({ once: true })]);
    await vi.advanceTimersByTimeAsync(100);
    await started.promise;
    await vi.advanceTimersByTimeAsync(125_000);
    output.resolve({ ok: true });
    await vi.advanceTimersByTimeAsync(100);
    expect((await both)[0].state).toBe('SETTLED');
  });

  it('keeps heartbeats separate from the execution budget', async () => {
    vi.useFakeTimers();
    const started = deferred<void>();
    const f = fixture({ execute: async context => {
      started.resolve();
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      return null;
    }, worker: { heartbeatIntervalMs: 100 } });
    const result = f.task({ budget: { maxWallClockSeconds: 1 }, heartbeatIntervalMs: 100 });
    const running = f.worker.start({ once: true });
    const checked = Promise.allSettled([result, running]);
    await vi.advanceTimersByTimeAsync(100);
    await started.promise;
    await vi.advanceTimersByTimeAsync(1500);
    const outcomes = await checked;
    expect(outcomes[0].status).toBe('rejected');
    expect(outcomes[1].status).toBe('rejected');
  });

  it('expires a peer wait independently of the overall task timeout', async () => {
    vi.useFakeTimers();
    const client = new RequesterClient({ owner: generateKeyPair(), relay: new InMemoryRelay(),
      waitTimeoutMs: 50, taskTimeoutMs: 2000 });
    const result = expect(client.delegate({ to: generateKeyPair().did, title: 'offline peer',
      description: 'local task', input: {} })).rejects.toThrow('PEER_WAIT_TIMEOUT');
    await vi.advanceTimersByTimeAsync(100);
    await result;
  });

  it('reports a terminal relay status in MCP tool results without response text', async () => {
    const receive = vi.fn(async () => { throw new Error('RELAY_REJECTED: 401 private response text'); });
    const owner = generateKeyPair();
    const server = new AcpMcpServer({ owner, relay: { send() {}, receive },
      approvalProvider: new PolicyAutoApprovalProvider(owner) });
    const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'acp_delegate_task', arguments: { workerDid: generateKeyPair().did, title: 'local',
        description: 'local task', input: {} },
    } });
    expect(response).toMatchObject({ result: { isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: 'RELAY_REJECTED: 401' }) }] } });
    expect(receive).toHaveBeenCalledTimes(1);
  });

  it('enforces an overall task timeout while waiting for the peer', async () => {
    vi.useFakeTimers();
    const client = new RequesterClient({ owner: generateKeyPair(), relay: new InMemoryRelay(),
      taskTimeoutMs: 50, waitTimeoutMs: 2000 });
    const result = expect(client.delegate({ to: generateKeyPair().did, title: 'offline',
      description: 'local task', input: {} })).rejects.toThrow('TASK_TIMEOUT');
    await vi.advanceTimersByTimeAsync(100);
    await result;
  });

  it('proposes the execution timeout as a contract budget and rejects incompatible worker limits before ACCEPT', async () => {
    const execute = vi.fn(async () => null);
    const f = fixture({ execute, worker: { executionTimeoutMs: 1000 } });
    const outcomes = await Promise.allSettled([f.task({ executionTimeoutMs: 2000 }),
      f.worker.start({ once: true })]);
    expect(outcomes[0]).toMatchObject({ status: 'rejected', reason: { message: expect.stringContaining('INCOMPATIBLE_TIMEOUTS') } });
    expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: { message: expect.stringContaining('INCOMPATIBLE_TIMEOUTS') } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an incompatible peer idle timeout before worker acceptance', async () => {
    const execute = vi.fn(async () => null);
    const f = fixture({ execute, worker: { heartbeatIntervalMs: 30_000 } });
    const outcomes = await Promise.allSettled([f.task({ transportIdleTimeoutMs: 20_000 }),
      f.worker.start({ once: true })]);
    expect(outcomes[0]).toMatchObject({ status: 'rejected', reason: { code: 'INCOMPATIBLE_TIMEOUTS',
      detail: { field: 'peerIdleTimeoutMs' } } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not retry a permanent auth error wrapped in a transport failure', () => {
    expect(isTransientRelayError(new TypeError('fetch failed', {
      cause: new Error('RELAY_REJECTED: 403'),
    }))).toBe(false);
  });

  it('detects a silent peer during execution without extending the contract deadline', async () => {
    vi.useFakeTimers();
    const timer = new SessionTimeouts({ taskTimeoutMs: 1000, heartbeatIntervalMs: 1,
      transportIdleTimeoutMs: 20 }, new Date(Date.now() + 1000).toISOString());
    timer.executing(900);
    await vi.advanceTimersByTimeAsync(21);
    expect(timer.signal.reason.message).toBe('PEER_IDLE_TIMEOUT');
    timer.close();
  });

  it('rejects incompatible execution and overall timeouts before sending a proposal', async () => {
    const send = vi.fn();
    const client = new RequesterClient({ owner: generateKeyPair(), relay: { send, receive() { return undefined; } } });
    await expect(client.delegate({ to: generateKeyPair().did, title: 'limits', description: 'local task', input: {},
      executionTimeoutMs: 2000, taskTimeoutMs: 1000 })).rejects.toThrow('INCOMPATIBLE_TIMEOUTS');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not let authenticated activity renew the overall deadline', async () => {
    vi.useFakeTimers();
    const timer = new SessionTimeouts({ taskTimeoutMs: 100, heartbeatIntervalMs: 1,
      transportIdleTimeoutMs: 20 }, new Date(Date.now() + 1000).toISOString());
    timer.executing(1000);
    for (let i = 0; i < 10; i++) { await vi.advanceTimersByTimeAsync(10); timer.activity(); }
    expect(timer.signal.reason.message).toBe('TASK_TIMEOUT');
    timer.close();
  });
});
