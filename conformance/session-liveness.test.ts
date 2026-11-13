// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, signEnvelope } from '../packages/core/src/index.js';
import type { Json } from '../packages/core/src/index.js';
import { createRelayFetchHandler, HttpRelayClient, InMemoryRelay, SseRelayClient, isTransientRelayError, RelayAuthRecoveryExhaustedError, RelayDuplicateEnvelopeError } from '../packages/relay/src/index.js';
import type { RelayTransport } from '../packages/relay/src/index.js';
import { AcpMcpServer, PolicyAutoApprovalProvider, RequesterClient, WorkerNode } from '../packages/runtime/src/index.js';
import type { AgentAdapter, DelegateOptions, WorkerNodeOptions } from '../packages/runtime/src/index.js';
import { TaskJournal } from '../packages/runtime/src/task-journal.js';
import { workerJson } from '../cli/src/worker-json.js';
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
  const worker = new WorkerNode({ autoAccept: { version: 1, enabled: true, from: 'anyone', work: 'write', limits: {} }, checkPeer: () => 'trusted', owner: workerKey, relay: workerRelay, relayUrl: origin,
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
  it('interrupts active work on auth exhaustion and never replays it after reconnect', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const directory = mkdtempSync(join(tmpdir(), 'worker-auth-interruption-'));
    cleanup.push(async () => { rmSync(directory, { recursive: true, force: true }); });
    let fail = false, executions = 0;
    const statuses: string[] = [];
    const f = fixture({ fetcher: base => async (input, init) => {
      if (fail && new URL(String(input)).pathname === '/envelopes' && new URL(String(input)).searchParams.get('recipient') === f.workerKey.did)
        throw new RelayAuthRecoveryExhaustedError('receive', 4, 120_000);
      return base(input, init);
    }, execute: async ctx => {
      executions++;
      fail = true;
      return new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }));
    }, worker: { auditPath: join(directory, 'worker.jsonl'), auditInterruptionFormat: 1, onStatus: status => statuses.push(status) } });
    const running = f.worker.start();
    const checked = expect(f.task({ taskTimeoutMs: 120_000, executionTimeoutMs: 120_000, transportIdleTimeoutMs: 120_000 }))
      .rejects.toMatchObject({ code: 'TASK_INTERRUPTED' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(statuses).toContain('unavailable');
    expect(executions).toBe(1);
    await vi.waitFor(() => expect((f.worker as unknown as { mailboxes: Map<string, unknown> }).mailboxes.size).toBe(0));
    fail = false;
    await vi.advanceTimersByTimeAsync(60_000);
    await checked;
    expect(executions).toBe(1);
    f.worker.stop();
    await running;
  });

  it('keeps a continuous worker alive after auth exhaustion and reconnects when relay returns', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let unavailable = true;
    const statuses: string[] = [];
    const f = fixture({ fetcher: base => async (input, init) =>
      unavailable && new URL(String(input)).searchParams.get('recipient') === f.workerKey.did
        ? new Response(null, { status: 401 }) : base(input, init),
      worker: { authRecoveryTimeoutMs: 100, onStatus: status => statuses.push(status) } });
    // fixture injects a transport, so configure the HTTP client's recovery window too.
    // Its default is deliberately exercised here (120 seconds).
    let ended = false;
    const running = f.worker.start().finally(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(statuses.at(-1)).toBe('unavailable');
    expect(ended).toBe(false);
    unavailable = false;
    await vi.advanceTimersByTimeAsync(59_999);
    const result = f.task();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(result).resolves.toMatchObject({ state: 'SETTLED' });
    f.worker.stop();
    await running;
  });

  it('survives real 401 exhaustion then duplicate recovery notification admission and accepts a later task', async () => {
    vi.useFakeTimers();
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const directory = mkdtempSync(join(tmpdir(), 'worker-duplicate-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const inboxPath = join(directory, 'inbox.jsonl');
    let fail = true, duplicates = 0, ended = false, seeded = false;
    const diagnostics: string[] = [], credentials: string[] = [];
    const f = fixture({ fetcher: base => async (input, init) => {
      const url = new URL(String(input));
      const auth = new Headers(init?.headers).get('authorization');
      if (auth) credentials.push(auth);
      if (fail && url.searchParams.get('recipient') === f.workerKey.did)
        return new Response('secret response body', { status: 401, headers: { date: new Date().toUTCString() } });
      if (init?.method === 'POST' && JSON.parse(String(init.body)).payload.eventType === 'ERROR') {
        await base(input, init); // Prior admission whose acknowledgement was lost.
        duplicates++;
        return base(input, init); // Real handler returns strict REPLAYED_ENVELOPE/400.
      }
      return base(input, init);
    }, worker: { inboxPath, onStatus: (status, error) => {
      diagnostics.push(workerJson({ status, ...(error ? { error } : {}) }));
      if (error && 'code' in error && error.code === 'RELAY_AUTH_RECOVERY_EXHAUSTED' && !seeded) {
        seeded = true;
        const journal = (f.worker as unknown as { taskJournal: TaskJournal }).taskJournal;
        journal.save({ version: 1, taskId: 'previous-task', requesterDid: f.requesterKey.did,
          envelopeId: 'previous-envelope', proposalDigest: 'sha256:' + 'a'.repeat(64), phase: 'terminal',
          invocations: [], outcome: { code: 'TASK_INTERRUPTED' }, notificationPending: true });
        journal.close();
      }
    } } });
    const running = f.worker.start().finally(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(seeded).toBe(true);
    expect(ended).toBe(false);
    fail = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(duplicates).toBe(1);
    expect(ended).toBe(false);
    const task = f.task();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(task).resolves.toMatchObject({ state: 'SETTLED' });
    const journal = new TaskJournal(inboxPath + '.tasks.jsonl', f.workerKey);
    journal.load();
    expect(journal.tasks.get('previous-task')?.notificationPending).toBe(false);
    journal.close();
    const output = JSON.stringify([diagnostics, warnings.mock.calls]);
    expect(output).toContain('clock matches');
    expect(output).not.toContain('secret response body');
    for (const credential of credentials) expect(output).not.toContain(credential);
    expect(output).not.toContain(f.workerKey.privateKey);
    expect(output).not.toContain(f.requesterKey.privateKey);
    f.worker.stop();
    await running;
  });

  it.each(['http-401', 'wrapped-401', 'wrapped-registration-401', 'message-exhausted', 'wrapped-message-exhausted'])(
    'retries reconciliation after auth exhaustion and three %s failures, then accepts a task', async failure => {
      vi.useFakeTimers();
      const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const directory = mkdtempSync(join(tmpdir(), 'worker-recovery-401-'));
      cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
      const inboxPath = join(directory, 'inbox.jsonl');
      let failPoll = true, notifications = 0, ended = false, seeded = false;
      const diagnostics: string[] = [], credentials: string[] = [];
      const f = fixture({ fetcher: base => async (input, init) => {
        const url = new URL(String(input));
        const auth = new Headers(init?.headers).get('authorization');
        if (auth) credentials.push(auth);
        if (failPoll && url.searchParams.get('recipient') === f.workerKey.did)
          return new Response('private auth body', { status: 401 });
        if (init?.method === 'POST' && JSON.parse(String(init.body)).payload.eventType === 'ERROR' && ++notifications <= 3) {
          if (failure === 'http-401') return new Response('private send body', { status: 401 });
          const cause = new Error(failure === 'wrapped-registration-401' ? 'RELAY_REGISTRATION_REJECTED: 401 private detail'
            : failure === 'wrapped-401' ? 'RELAY_REJECTED: 401 private detail'
            : 'RELAY_AUTH_RECOVERY_EXHAUSTED: private detail');
          if (failure === 'message-exhausted') throw cause;
          throw new TypeError('fetch failed', { cause: new Error('transport wrapper private detail', { cause }) });
        }
        return base(input, init);
      }, worker: { inboxPath, onStatus: (status, error) => {
        diagnostics.push(workerJson({ status, ...(error ? { error } : {}) }));
        if (error && 'code' in error && error.code === 'RELAY_AUTH_RECOVERY_EXHAUSTED' && !seeded) {
          seeded = true;
          const journal = (f.worker as unknown as { taskJournal: TaskJournal }).taskJournal;
          journal.save({ version: 1, taskId: 'previous-task', requesterDid: f.requesterKey.did,
            envelopeId: 'previous-envelope', proposalDigest: 'sha256:' + 'a'.repeat(64), phase: 'terminal',
            invocations: [], outcome: { code: 'TASK_INTERRUPTED' }, notificationPending: true });
        }
      } } });
      const running = f.worker.start().finally(() => { ended = true; });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(seeded).toBe(true);
      failPoll = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        await vi.advanceTimersByTimeAsync(59_999);
        expect(notifications).toBe(attempt - 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(notifications).toBe(attempt);
        expect(diagnostics.at(-1)).toContain('unavailable');
        expect(ended).toBe(false);
      }
      await vi.advanceTimersByTimeAsync(60_000);
      expect(notifications).toBe(4);
      expect(ended).toBe(false);
      const task = f.task();
      await vi.advanceTimersByTimeAsync(5000);
      await expect(task).resolves.toMatchObject({ state: 'SETTLED' });
      const output = JSON.stringify([diagnostics, warnings.mock.calls]);
      expect(output).not.toContain('private auth body');
      expect(output).not.toContain('private send body');
      expect(output).not.toContain('private detail');
      for (const credential of credentials) expect(output).not.toContain(credential);
      expect(output).not.toContain(f.workerKey.privateKey);
      f.worker.stop();
      await running;
    });

  it.each([false, true])('preserves duplicate failure outside persistent start (once=%s)', async once => {
    const owner = generateKeyPair();
    const worker = new WorkerNode({ owner, adapter: adapter(), relay: {
      send: async () => { throw new RelayDuplicateEnvelopeError(); }, receive: () => undefined,
    } });
    cleanup.push(() => worker.stop());
    const envelope = signEnvelope({ taskId: 'same', recipientDid: generateKeyPair().did,
      seq: 0, eventType: 'ERROR', payload: {} }, owner);
    if (once) {
      const starting = worker.start({ once: true });
      await expect(worker.relay.send(envelope)).rejects.toBeInstanceOf(RelayDuplicateEnvelopeError);
      worker.stop();
      await starting;
    } else await expect(worker.relay.send(envelope)).rejects.toBeInstanceOf(RelayDuplicateEnvelopeError);
  });

  it('retries initial publication after exhausted registration transport retries', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = true, ended = false;
    const statuses: string[] = [];
    const f = fixture({ fetcher: base => async (input, init) =>
      fail && new URL(String(input)).pathname === '/agents'
        ? new Response('secret registration body', { status: 503 }) : base(input, init),
      worker: { publishToRegistry: true, onStatus: (status, error) => statuses.push(workerJson({ status, error })) } });
    const running = f.worker.start().finally(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statuses.join()).toContain('unavailable');
    expect(ended).toBe(false);
    fail = false;
    const task = f.task();
    await vi.advanceTimersByTimeAsync(65_000);
    await expect(task).resolves.toMatchObject({ state: 'SETTLED' });
    expect(statuses.join()).not.toContain('secret registration body');
    f.worker.stop();
    await running;
  });

  it('retries a pending notification when initial checkpoint reconciliation cannot send', async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), 'worker-initial-reconcile-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const inboxPath = join(directory, 'inbox.jsonl');
    let fail = true, ended = false, notifications = 0;
    const statuses: string[] = [];
    const f = fixture({ fetcher: base => async (input, init) => {
      if (init?.method === 'POST' && JSON.parse(String(init.body)).payload.eventType === 'ERROR') {
        notifications++;
        if (fail) return new Response('secret notify body', { status: 503 });
      }
      return base(input, init);
    }, worker: { inboxPath, onStatus: (status, error) => statuses.push(workerJson({ status, error })) } });
    const journal = new TaskJournal(inboxPath + '.tasks.jsonl', f.workerKey);
    journal.load();
    journal.save({ version: 1, taskId: 'previous-task', requesterDid: f.requesterKey.did,
      envelopeId: 'previous-envelope', proposalDigest: 'sha256:' + 'a'.repeat(64), phase: 'terminal',
      invocations: [], outcome: { code: 'TASK_INTERRUPTED' }, notificationPending: true });
    journal.close();
    const running = f.worker.start().finally(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(statuses.join()).toContain('unavailable');
    expect(ended).toBe(false);
    fail = false;
    const task = f.task();
    await vi.advanceTimersByTimeAsync(65_000);
    await expect(task).resolves.toMatchObject({ state: 'SETTLED' });
    expect(notifications).toBe(2);
    expect(statuses.join()).not.toContain('secret notify body');
    f.worker.stop();
    await running;
  });

  it('retains a recovered proposal across an ack failure outside the listener loop', async () => {
    vi.useFakeTimers();
    let original: Parameters<RelayTransport['send']>[0] | undefined;
    let failAck = false, failedAcks = 0, executions = 0;
    const directory = mkdtempSync(join(tmpdir(), 'worker-recovery-ack-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const statuses: string[] = [];
    const f = fixture({ fetcher: base => async (input, init) => {
      if (init?.method === 'POST' && new URL(String(input)).pathname === '/envelopes') {
        const envelope = JSON.parse(String(init.body));
        if (envelope.payload.eventType === 'PROPOSE') original = envelope;
      }
      if (failAck && init?.method === 'DELETE' && new URL(String(input)).searchParams.get('recipient') === f.workerKey.did) {
        failedAcks++;
        return new Response('secret ack body', { status: 500 });
      }
      return base(input, init);
    }, execute: async () => { executions++; return { ok: true }; },
      worker: { inboxPath: join(directory, 'inbox.jsonl'), onStatus: (status, error) => statuses.push(workerJson({ status, error })) } });
    await Promise.all([f.task(), f.worker.start({ once: true })]);
    expect(executions).toBe(1);
    const repeated = signEnvelope(original!.payload, f.requesterKey);
    f.relay.send(repeated);
    failAck = true;
    let ended = false;
    const running = f.worker.start().finally(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(failedAcks).toBe(1);
    expect(statuses.join()).toContain('unavailable');
    expect(ended).toBe(false);
    failAck = false;
    const task = f.task();
    await vi.advanceTimersByTimeAsync(65_000);
    await expect(task).resolves.toMatchObject({ state: 'SETTLED' });
    expect(executions).toBe(2); // Replayed proposal never executes again.
    expect(f.relay.snapshot().queues.flatMap(([, q]) => q).some(e =>
      e.payload.envelopeId === repeated.payload.envelopeId)).toBe(false);
    expect(statuses.join()).not.toContain('secret ack body');
    f.worker.stop();
    await running;
  });

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
    expect(approve.mock.calls.filter(([request]) => request.gate === 'contract_acceptance')).toHaveLength(0);
    expect(result.bundle.entries.filter(entry => entry.body.eventType === 'ACCEPT')).toHaveLength(1);
    expect(publications).toBe(0);
  });

  it('propagates one-shot worker auth exhaustion through the supervisor without restarting its budget', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const owner = generateKeyPair();
    const fetcher = vi.fn(async () => new Response('ignored response', { status: 401 }));
    const execute = vi.fn();
    const statuses: string[] = [];
    const worker = new WorkerNode({ autoAccept: { version: 1, enabled: true, from: 'anyone', work: 'write', limits: {} }, checkPeer: () => 'trusted', owner, relay: new HttpRelayClient(origin, fetcher, owner, { maxAuthRecoveryAttempts: 3 }),
      adapter: adapter(execute), connectTimeoutMs: 50, onStatus: status => statuses.push(status) });
    cleanup.push(() => worker.stop());
    const checked = expect(worker.start({ once: true })).rejects.toMatchObject({ code: 'RELAY_AUTH_RECOVERY_EXHAUSTED',
      message: expect.stringContaining('clock') });
    await vi.advanceTimersByTimeAsync(10_000);
    await checked;
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(execute).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toBe('unavailable');
  });

  it.each([
    'RELAY_REJECTED: 403', 'RELAY_REGISTRATION_REJECTED: 403',
    'RELAY_REJECTED: 400', 'RELAY_AUTH_REQUIRED', 'RELAY_TAMPERING_DETECTED',
    'RELAY_PROXY_AUTH_FAILED', 'RELAY_PROXY_TLS_FAILED', 'SSRF_BLOCKED_RELAY_URL',
    'SSE_BUFFER_OVERFLOW', 'SSE_CAPACITY',
  ])('does not hide permanent %s behind a recoverable 401 wrapper', async failure => {
    const owner = generateKeyPair();
    const register = vi.fn(async () => {
      throw new Error('RELAY_REGISTRATION_REJECTED: 401 private wrapper', {
        cause: new Error(failure + (failure.includes(':') ? ' private body' : '')),
      });
    });
    const statuses: string[] = [];
    const worker = new WorkerNode({ owner, adapter: adapter(), publishToRegistry: true,
      relay: { send() {}, receive() { return undefined; }, register },
      onStatus: (status, error) => statuses.push(workerJson({ status, error })) });
    cleanup.push(() => worker.stop());
    await expect(worker.start()).rejects.toThrow(failure.replace('RELAY_REGISTRATION_REJECTED', 'RELAY_REJECTED'));
    expect(register).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toContain('unavailable');
    expect(statuses.join()).not.toContain('private');
  });

  it.each(['RELAY_NEW_TEMPORARY_FAILURE', 'SSE_NEW_TEMPORARY_FAILURE', 'cyclic-401'])(
    'retries unclassified relay failures and bounded cyclic causes: %s', async failure => {
      vi.useFakeTimers();
      let registrations = 0;
      const cyclic = new Error('RELAY_REGISTRATION_REJECTED: 401');
      cyclic.cause = cyclic;
      const f = fixture({ fetcher: base => async (input, init) => {
        if (new URL(String(input)).pathname === '/agents' && ++registrations === 1)
          throw failure === 'cyclic-401' ? cyclic : new Error(failure);
        return base(input, init);
      }, worker: { publishToRegistry: true } });
      let ended = false;
      const running = f.worker.start().finally(() => { ended = true; });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(registrations).toBe(1);
      expect(ended).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(registrations).toBe(2);
      const task = f.task();
      await vi.advanceTimersByTimeAsync(5000);
      await expect(task).resolves.toMatchObject({ state: 'SETTLED' });
      f.worker.stop();
      await running;
    });

  it.each([403])('stops a worker on permanent HTTP %s without a restart loop', async status => {
    const owner = generateKeyPair();
    const receive = vi.fn().mockRejectedValue(new Error('RELAY_REJECTED: ' + status + ' private response text'));
    const statuses: string[] = [];
    const worker = new WorkerNode({ autoAccept: { version: 1, enabled: true, from: 'anyone', work: 'write', limits: {} }, checkPeer: () => 'trusted', owner, relay: { send() {}, receive }, adapter: adapter(),
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
