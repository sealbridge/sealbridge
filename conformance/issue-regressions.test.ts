// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, writeFile, rm as rmDir } from 'node:fs/promises';
import { get, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  createInviteToken,
  createRelayAuthToken,
  createSignedAgentCard,
  digest,
  generateKeyPair,
  parseAndVerifyInviteToken,
  signEnvelope,
} from '../packages/core/src/index.js';
import type { Json } from '../packages/core/src/index.js';
import { verifyAudit } from '../packages/ledger/src/index.js';
import { InMemoryRelay, createRelayFetchHandler } from '../packages/relay/src/fetch.js';
import { startLocalRelay } from '../packages/relay/src/index.js';
import { RelayDurableObject } from '../packages/relay/src/worker.js';
import {
  AcpMcpServer,
  PolicyAutoApprovalProvider,
  RequesterClient,
  WorkerNode,
  buildTaskManifest,
} from '../packages/runtime/src/index.js';
import { ClaudeCodeAdapter, runCommand } from '../packages/adapters/src/command.js';
import type { AgentTaskContext } from '../packages/adapters/src/index.js';
import { runSandbox } from '../packages/sandbox/src/index.js';

const fsMock = vi.hoisted(() => ({
  failRm: false,
  calls: [] as unknown[][],
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      fsMock.calls.push(args);
      if (fsMock.failRm) {
        const error = new Error('EBUSY: resource busy or locked, rmdir') as NodeJS.ErrnoException;
        error.code = 'EBUSY';
        throw error;
      }
      return actual.rm(...args);
    },
  };
});

afterEach(() => {
  fsMock.failRm = false;
  fsMock.calls.length = 0;
});

describe('issue 8: sandbox temp directory cleanup', () => {
  async function probe(): Promise<Array<Record<string, unknown>>> {
    const results: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 3; i++) {
      try {
        results.push({
          case: 'echo-' + i,
          value: await runSandbox({
            code: 'return input;',
            input: { ok: true },
            timeoutMs: 2000,
            onTool: async () => null,
          }),
        });
      } catch (e) {
        results.push({ case: 'echo-' + i, error: e instanceof Error ? e.message : String(e) });
      }
    }
    for (const kind of ['timeout', 'cancel'] as const) {
      const controller = new AbortController();
      const timer =
        kind === 'cancel' ? setTimeout(() => controller.abort('synthetic cancel'), 100) : undefined;
      try {
        await runSandbox({
          code: 'while(true){}',
          timeoutMs: 200,
          signal: controller.signal,
          onTool: async () => null,
        });
        results.push({ case: kind, result: 'unexpected success' });
      } catch (e) {
        results.push({ case: kind, error: e instanceof Error ? e.message : String(e) });
      } finally {
        clearTimeout(timer);
      }
    }
    return results;
  }

  it('keeps echo, timeout, and cancel results when removing the work directory', async () => {
    const results = await probe();
    expect(results.map((row) => row.case)).toEqual([
      'echo-0',
      'echo-1',
      'echo-2',
      'timeout',
      'cancel',
    ]);
    for (const row of results.slice(0, 3)) expect(row.value).toEqual({ ok: true });
    expect(results[3]?.error).toBe('SANDBOX_TIMEOUT');
    expect(results[4]?.error).toBe('SANDBOX_HALTED: synthetic cancel');
    expect(JSON.stringify(results)).not.toContain('EBUSY');
    const cleanups = fsMock.calls.filter((args) => String(args[0]).includes('acp-task-'));
    expect(cleanups.length).toBeGreaterThan(0);
    for (const args of cleanups) {
      expect(args[1]).toMatchObject({
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  it('does not replace a successful sandbox result when fs.rm throws EBUSY', async () => {
    fsMock.failRm = true;
    await expect(
      runSandbox({
        code: 'return input;',
        input: { ok: true },
        timeoutMs: 2000,
        onTool: async () => null,
      }),
    ).resolves.toEqual({ ok: true });
  });
});

describe('issue 9: concurrent delegate to one worker', () => {
  it('settles both concurrent tasks instead of consuming the other task inbox', async () => {
    const relay = new InMemoryRelay();
    const owner = generateKeyPair();
    const adapter = {
      id: 'synthetic',
      name: 'Synthetic echo',
      skills: [],
      executeTask: async (context: { input: Json }): Promise<Json> => context.input,
    };
    const events: string[] = [];
    const worker = new WorkerNode({
      owner,
      relay,
      adapter,
      timeoutMs: 1500,
      approvalProvider: new PolicyAutoApprovalProvider(owner),
      onEvent: (event) => events.push(event),
    });
    const controller = new AbortController();
    const running = worker.start({ signal: controller.signal });
    async function delegate(label: string) {
      const key = generateKeyPair();
      const requester = new RequesterClient({
        owner: key,
        relay,
        timeoutMs: 1500,
        approvalProvider: new PolicyAutoApprovalProvider(key),
      });
      try {
        const result = await requester.delegate({
          to: worker.invite(),
          title: label,
          description: 'Synthetic test only',
          input: { label },
        });
        return { label, state: result.state };
      } catch (e) {
        return { label, error: e instanceof Error ? e.message : String(e) };
      }
    }
    const sequential = [await delegate('sequential-1'), await delegate('sequential-2')];
    const concurrent = await Promise.all([delegate('concurrent-1'), delegate('concurrent-2')]);
    controller.abort();
    worker.stop();
    await running;
    expect(sequential).toEqual([
      { label: 'sequential-1', state: 'SETTLED' },
      { label: 'sequential-2', state: 'SETTLED' },
    ]);
    expect(concurrent).toEqual([
      { label: 'concurrent-1', state: 'SETTLED' },
      { label: 'concurrent-2', state: 'SETTLED' },
    ]);
    expect(events.filter((event) => event === 'SETTLED')).toHaveLength(4);
  });
});

describe('issue 10: durable storage recovery', () => {
  it('retries put and delete after one transient storage failure', async () => {
    const results: Record<string, unknown> = {};
    for (const failure of ['put', 'delete'] as const) {
      const data = new Map<string, unknown>();
      let calls = 0;
      let fail = false;
      const state = {
        storage: {
          get: async <T>(key: string): Promise<T | undefined> => data.get(key) as T | undefined,
          put: async (key: string, value: unknown) => {
            calls++;
            if (fail && failure === 'put') {
              fail = false;
              throw new Error('SYNTHETIC_TRANSIENT_STORAGE');
            }
            data.set(key, value);
          },
          delete: async (key: string) => {
            calls++;
            if (fail && failure === 'delete') {
              fail = false;
              throw new Error('SYNTHETIC_TRANSIENT_STORAGE');
            }
            return data.delete(key);
          },
        },
        blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
      };
      const object = new RelayDurableObject(state);
      const owner = generateKeyPair();
      async function post(name: string) {
        const card = createSignedAgentCard(
          {
            name,
            agentDid: owner.did,
            relayEndpoint: 'https://relay.local',
            skills: [],
          },
          owner,
        );
        try {
          return (
            await object.fetch(
              new Request('https://relay.local/agents', {
                method: 'POST',
                body: JSON.stringify(card),
              }),
            )
          ).status;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      }
      const first = await post('baseline');
      fail = true;
      const failed = await post('transient failure');
      const before = calls;
      const retry = await post('storage recovered');
      const visible = (await (
        await object.fetch(new Request('https://relay.local/agents'))
      ).json()) as Array<{ payload: { name: string } }>;
      const restarted = new RelayDurableObject(state);
      const persisted = (await (
        await restarted.fetch(new Request('https://relay.local/agents'))
      ).json()) as Array<{ payload: { name: string } }>;
      results[failure] = {
        first,
        failed,
        retry,
        storageCallsAfterRecovery: calls - before,
        visible: visible.map((card) => card.payload.name),
        persisted: persisted.map((card) => card.payload.name),
      };
    }
    for (const failure of ['put', 'delete']) {
      const row = results[failure] as {
        first: number;
        failed: string;
        retry: number;
        storageCallsAfterRecovery: number;
        visible: string[];
        persisted: string[];
      };
      expect(row.first).toBe(201);
      expect(row.failed).toBe('SYNTHETIC_TRANSIENT_STORAGE');
      expect(row.retry).toBe(201);
      expect(row.storageCallsAfterRecovery).toBeGreaterThan(0);
      expect(row.visible).toEqual(['storage recovered']);
      expect(row.persisted).toEqual(['storage recovered']);
    }
  });
});

describe('issue 11: unread SSE backpressure', () => {
  it('does not accept more unread envelopes than maxQueueSize', async () => {
    const owner = generateKeyPair();
    const peer = generateKeyPair();
    const relay = new InMemoryRelay();
    const handler = createRelayFetchHandler({ relay });
    const response = await handler(
      new Request('https://relay.local/stream?recipient=' + encodeURIComponent(peer.did), {
        headers: {
          authorization:
            'Bearer ' +
            createRelayAuthToken(peer, { action: 'stream', origin: 'https://relay.local' }),
        },
      }),
    );
    let sent = 0;
    let limit: unknown;
    for (let i = 0; i < 1002; i++) {
      try {
        relay.send(
          signEnvelope(
            {
              taskId: 'task_sseprobe',
              recipientDid: peer.did,
              seq: i,
              eventType: 'PING',
              payload: {},
            },
            owner,
          ),
        );
        sent++;
      } catch (error) {
        limit = error;
        break;
      }
    }
    const queued = relay.snapshot().queues.reduce((count, [, queue]) => count + queue.length, 0);
    expect(sent).toBe(relay.maxQueueSize);
    expect(queued).toBeLessThanOrEqual(relay.maxQueueSize);
    expect(queued).toBeGreaterThan(0);
    expect(limit).toBeInstanceOf(Error);
    expect((limit as Error).message).toBe('RELAY_CAPACITY');
    expect(response.body).toBeTruthy();
  });
});

describe('issue 12: spawn a .cjs binary with Node', () => {
  it('runs a .cjs binaryPath through runCommand and ClaudeCodeAdapter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-cjs-'));
    try {
      const script = join(dir, 'mock-claude.cjs');
      await writeFile(
        script,
        'let input="";process.stdin.on("data",b=>input+=b);process.stdin.on("end",()=>{' +
          'process.stdout.write(JSON.stringify({result:JSON.stringify({ok:true,echo:JSON.parse(input||"{}")}),usage:{input_tokens:1,output_tokens:1}}));' +
          '});\n',
        { mode: 0o700 },
      );
      const command = await runCommand({
        command: script,
        args: [],
        cwd: dir,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
        input: '{"n":1}',
        signal: AbortSignal.timeout(5000),
        timeoutMs: 5000,
      });
      expect(JSON.parse(command.stdout)).toMatchObject({
        result: JSON.stringify({ ok: true, echo: { n: 1 } }),
      });
      const owner = generateKeyPair();
      const worker = generateKeyPair();
      const manifest = buildTaskManifest({
        ownerDid: owner.did,
        workerDid: worker.did,
        title: 'cjs',
        description: 'fixture',
      });
      const context: AgentTaskContext = {
        taskId: manifest.taskId,
        manifest,
        input: { label: 'claude' },
        workspaceDir: dir,
        signal: AbortSignal.timeout(5000),
        callTool: async () => {
          throw new Error('TOOL_DENIED');
        },
        reportUsage: () => {},
        reportIsolation: () => {},
      };
      const output = await new ClaudeCodeAdapter({ binaryPath: script }).executeTask(context);
      expect(output).toEqual({ ok: true, echo: expect.any(Object) });
    } finally {
      await rmDir(dir, { recursive: true, force: true });
    }
  });
});

describe('issue 14: concurrent delegate from one requester', () => {
  it('routes parallel responses to the matching task mailbox', async () => {
    const relay = new InMemoryRelay();
    const owner = generateKeyPair();
    const requesterKey = generateKeyPair();
    const worker = new WorkerNode({
      owner,
      relay,
      adapter: {
        id: 'synthetic',
        name: 'echo',
        skills: [],
        executeTask: async (context) => context.input,
      },
      timeoutMs: 1500,
      approvalProvider: new PolicyAutoApprovalProvider(owner),
    });
    const controller = new AbortController();
    const running = worker.start({ signal: controller.signal });
    const requester = new RequesterClient({
      owner: requesterKey,
      relay,
      timeoutMs: 1500,
      approvalProvider: new PolicyAutoApprovalProvider(requesterKey),
    });
    async function delegate(label: string) {
      try {
        const result = await requester.delegate({
          to: worker.invite(),
          title: label,
          description: 'synthetic',
          input: { label },
        });
        return { label, state: result.state };
      } catch (error) {
        return { label, error: error instanceof Error ? error.message : String(error) };
      }
    }
    try {
      const sequential = [await delegate('seq1'), await delegate('seq2')];
      const concurrent = await Promise.all([delegate('parallel1'), delegate('parallel2')]);
      expect(sequential).toEqual([
        { label: 'seq1', state: 'SETTLED' },
        { label: 'seq2', state: 'SETTLED' },
      ]);
      expect(concurrent).toEqual([
        { label: 'parallel1', state: 'SETTLED' },
        { label: 'parallel2', state: 'SETTLED' },
      ]);
    } finally {
      controller.abort();
      worker.stop();
      await running;
    }
  });

  it('routes parallel responses when two clients share the owner and relay', async () => {
    const relay = new InMemoryRelay();
    const owner = generateKeyPair();
    const requesterKey = generateKeyPair();
    const worker = new WorkerNode({
      owner,
      relay,
      adapter: {
        id: 'synthetic',
        name: 'echo',
        skills: [],
        executeTask: async (context) => context.input,
      },
      timeoutMs: 1500,
      approvalProvider: new PolicyAutoApprovalProvider(owner),
    });
    const controller = new AbortController();
    const running = worker.start({ signal: controller.signal });
    const clients = [0, 1].map(
      () =>
        new RequesterClient({
          owner: requesterKey,
          relay,
          timeoutMs: 1500,
          approvalProvider: new PolicyAutoApprovalProvider(requesterKey),
        }),
    );
    try {
      const concurrent = await Promise.all(
        clients.map(async (requester, index) => {
          const label = 'shared-' + index;
          const result = await requester.delegate({
            to: worker.invite(),
            title: label,
            description: 'synthetic',
            input: { label },
          });
          return { label, state: result.state };
        }),
      );
      expect(concurrent).toEqual([
        { label: 'shared-0', state: 'SETTLED' },
        { label: 'shared-1', state: 'SETTLED' },
      ]);
    } finally {
      controller.abort();
      worker.stop();
      await running;
    }
  });
});

describe('issue 15: websocket unsubscribe cancels a backpressured flush', () => {
  it('leaves the envelope queued after unsubscribe', async () => {
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const originalEmit = WebSocketServer.prototype.emit;
    let backpressured = true;
    WebSocketServer.prototype.emit = function (
      this: WebSocketServer,
      event: string | symbol,
      ...args: unknown[]
    ) {
      if (event === 'connection') {
        const serverSocket = args[0] as { bufferedAmount?: number };
        Object.defineProperty(serverSocket, 'bufferedAmount', {
          configurable: true,
          get: () => (backpressured ? 1048576 : 0),
        });
      }
      return originalEmit.apply(this, [event, ...args]);
    };
    const server = await startLocalRelay();
    const client = new WebSocket(server.wsUrl);
    const received: Array<{ envelope?: unknown }> = [];
    client.on('message', (data) => {
      received.push(JSON.parse(data.toString()) as { envelope?: unknown });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('open', () => resolve());
        client.once('error', reject);
      });
      const owner = generateKeyPair();
      const peer = generateKeyPair();
      client.send(
        JSON.stringify({
          method: 'subscribe',
          recipientDid: peer.did,
          authToken: createRelayAuthToken(peer, { action: 'subscribe', origin: server.url }),
        }),
      );
      await pause(50);
      client.send(JSON.stringify({ method: 'unsubscribe' }));
      await pause(50);
      backpressured = false;
      server.relay.send(
        signEnvelope(
          {
            taskId: 'task_unsubscribe',
            recipientDid: peer.did,
            seq: 0,
            eventType: 'PING',
            payload: {},
          },
          owner,
        ),
      );
      await pause(80);
      const receivedAfterUnsubscribe = received.filter((item) => item.envelope).length;
      const remainingRelayQueue = server.relay
        .snapshot()
        .queues.reduce((count, [, queue]) => count + queue.length, 0);
      expect(receivedAfterUnsubscribe).toBe(0);
      expect(remainingRelayQueue).toBe(1);
    } finally {
      client.terminate();
      await server.close();
      WebSocketServer.prototype.emit = originalEmit;
    }
  });
});

describe('issue 17: overlapping durable storage failure', () => {
  it('rolls back the failed envelope before the queued request is saved', async () => {
    const data = new Map<string, unknown>();
    let release: () => void = () => {};
    let started: () => void = () => {};
    let failFirst = true;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((_, reject) => {
      release = () => reject(new Error('SYNTHETIC_TRANSIENT_STORAGE'));
    });
    const state = {
      storage: {
        get: async <T>(key: string): Promise<T | undefined> => data.get(key) as T | undefined,
        put: async (key: string, value: unknown) => {
          if (failFirst) {
            failFirst = false;
            started();
            await gate;
          }
          data.set(key, value);
        },
        delete: async (key: string) => data.delete(key),
      },
      blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
    };
    const object = new RelayDurableObject(state);
    const owner = generateKeyPair();
    const peer = generateKeyPair();
    const envelopeFor = (taskId: string, label: string) =>
      signEnvelope(
        {
          taskId,
          recipientDid: peer.did,
          seq: 0,
          eventType: 'PING',
          payload: { label },
        },
        owner,
      );
    const a = envelopeFor('task_overlap_a', 'A');
    const b = envelopeFor('task_overlap_b', 'B');
    async function post(envelope: ReturnType<typeof signEnvelope>) {
      try {
        const response = await object.fetch(
          new Request('https://relay.local/envelopes', {
            method: 'POST',
            body: JSON.stringify(envelope),
          }),
        );
        return { status: response.status, body: await response.text() };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
    const first = post(a);
    await entered;
    const second = post(b);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const requests = await Promise.all([first, second]);
    const retryA = await post(a);
    const restarted = new RelayDurableObject(state);
    const persisted: Array<{ status: number; label: string | null }> = [];
    for (let i = 0; i < 2; i++) {
      const response = await restarted.fetch(
        new Request('https://relay.local/envelopes?recipient=' + encodeURIComponent(peer.did), {
          headers: {
            authorization:
              'Bearer ' + createRelayAuthToken(peer, { origin: 'https://relay.local' }),
          },
        }),
      );
      persisted.push({
        status: response.status,
        label:
          response.status === 200
            ? ((await response.json()) as { payload: { payload: { label: string } } }).payload
                .payload.label
            : null,
      });
    }
    expect(requests).toEqual([{ error: 'SYNTHETIC_TRANSIENT_STORAGE' }, { status: 202, body: '' }]);
    expect(retryA).toEqual({ status: 202, body: '' });
    expect(persisted).toEqual([
      { status: 200, label: 'B' },
      { status: 200, label: 'A' },
    ]);
  });
});

describe('issue 18: http backpressure disconnect cancels the reader', () => {
  it('drops the drain listener and cancels the reader when write returns false', async () => {
    const results: Array<{
      forceBackpressure: boolean;
      readerCancelCalls: number;
      remainingDrainListeners: number;
    }> = [];
    for (const forceBackpressure of [false, true]) {
      let response: ServerResponse | undefined;
      let cancelled = 0;
      const originalWrite = ServerResponse.prototype.write;
      const originalReader = ReadableStream.prototype.getReader;
      ServerResponse.prototype.write = function (this: ServerResponse) {
        response = this;
        const actual = originalWrite.apply(
          this,
          arguments as unknown as Parameters<ServerResponse['write']>,
        );
        return forceBackpressure ? false : actual;
      } as ServerResponse['write'];
      ReadableStream.prototype.getReader = function (this: ReadableStream<Uint8Array>) {
        const reader = originalReader.call(this) as ReadableStreamDefaultReader<Uint8Array>;
        const originalCancel = reader.cancel.bind(reader);
        reader.cancel = (reason) => {
          cancelled++;
          return originalCancel(reason);
        };
        return reader;
      } as typeof originalReader;
      const server = await startLocalRelay();
      const peer = generateKeyPair();
      try {
        await new Promise<void>((resolve, reject) => {
          const request = get(
            server.url + '/stream?recipient=' + encodeURIComponent(peer.did),
            {
              headers: {
                authorization:
                  'Bearer ' + createRelayAuthToken(peer, { action: 'stream', origin: server.url }),
              },
            },
            (incoming) => {
              incoming.once('data', () => {
                incoming.destroy();
                request.destroy();
                resolve();
              });
              incoming.on('error', () => {});
            },
          );
          request.on('error', reject);
          request.setTimeout(1000, () => {
            request.destroy(new Error('probe timeout'));
          });
        });
        await new Promise((resolve) => setTimeout(resolve, 80));
        results.push({
          forceBackpressure,
          readerCancelCalls: cancelled,
          remainingDrainListeners: response?.listenerCount('drain') ?? -1,
        });
        if (forceBackpressure && response) {
          response.emit('drain');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        await server.close();
        ServerResponse.prototype.write = originalWrite;
        ReadableStream.prototype.getReader = originalReader;
      }
    }
    expect(results).toEqual([
      { forceBackpressure: false, readerCancelCalls: 1, remainingDrainListeners: 0 },
      { forceBackpressure: true, readerCancelCalls: 1, remainingDrainListeners: 0 },
    ]);
  });
});

describe('issue 20: requester relay URL switch', () => {
  it('returns an already queued envelope without sleeping for waitMs', async () => {
    const server = await startLocalRelay();
    try {
      const owner = generateKeyPair();
      const peer = generateKeyPair();
      server.relay.send(
        signEnvelope(
          {
            taskId: 'task_ready',
            recipientDid: peer.did,
            seq: 0,
            eventType: 'PING',
            payload: { label: 'ready' },
          },
          owner,
        ),
      );
      const started = Date.now();
      const response = await fetch(
        server.url + '/envelopes?recipient=' + encodeURIComponent(peer.did) + '&waitMs=1000',
        {
          headers: {
            authorization: 'Bearer ' + createRelayAuthToken(peer, { origin: server.url }),
          },
        },
      );
      const elapsedMs = Date.now() - started;
      const body = (await response.json()) as {
        envelopes: Array<{ payload: { payload: { label: string } } }>;
      };
      expect(response.status).toBe(200);
      expect(elapsedMs).toBeLessThan(200);
      expect(body.envelopes.map((envelope) => envelope.payload.payload.label)).toEqual(['ready']);
    } finally {
      await server.close();
    }
  });

  it('settles delegates on two relay URLs from one requester', async () => {
    const servers = [await startLocalRelay(), await startLocalRelay()];
    const workers: WorkerNode[] = [];
    const running: Array<Promise<unknown>> = [];
    const requesterKey = generateKeyPair();
    const requester = new RequesterClient({
      owner: requesterKey,
      timeoutMs: 2000,
      allowPrivateRelay: true,
      approvalProvider: new PolicyAutoApprovalProvider(requesterKey),
    });
    try {
      for (const server of servers) {
        const owner = generateKeyPair();
        const worker = new WorkerNode({
          owner,
          relay: server.url,
          allowPrivateRelay: true,
          timeoutMs: 2000,
          adapter: {
            id: 'echo',
            name: 'echo',
            skills: [],
            executeTask: async (context) => context.input,
          },
          approvalProvider: new PolicyAutoApprovalProvider(owner),
        });
        workers.push(worker);
        running.push(worker.start());
      }
      async function call(client: RequesterClient, index: number) {
        try {
          const result = await client.delegate({
            to: workers[index]!.invite(),
            title: 'relay switch',
            description: 'synthetic',
            input: { index },
          });
          return { relay: index, state: result.state };
        } catch (error) {
          return { relay: index, error: error instanceof Error ? error.message : String(error) };
        }
      }
      const relaySwitch = [await call(requester, 0), await call(requester, 1)];
      const fresh = new RequesterClient({
        owner: requesterKey,
        timeoutMs: 2000,
        allowPrivateRelay: true,
        approvalProvider: new PolicyAutoApprovalProvider(requesterKey),
      });
      const relaySwitchFreshControl = await call(fresh, 1);
      expect(relaySwitch).toEqual([
        { relay: 0, state: 'SETTLED' },
        { relay: 1, state: 'SETTLED' },
      ]);
      expect(relaySwitchFreshControl).toEqual({ relay: 1, state: 'SETTLED' });
      const concurrent = await Promise.all([call(requester, 0), call(requester, 1)]);
      expect(concurrent).toEqual([
        { relay: 0, state: 'SETTLED' },
        { relay: 1, state: 'SETTLED' },
      ]);
      const sameUrl = await Promise.all([call(requester, 0), call(requester, 0)]);
      expect(sameUrl).toEqual([
        { relay: 0, state: 'SETTLED' },
        { relay: 0, state: 'SETTLED' },
      ]);
    } finally {
      for (const worker of workers) worker.stop();
      await Promise.allSettled(running);
      for (const server of servers) await server.close();
    }
  });
});

describe('issue 21: durable long-poll wakes on a concurrent post', () => {
  it('returns the posted envelope before waitMs elapses', async () => {
    const data = new Map<string, unknown>();
    const state = {
      storage: {
        get: async <T>(key: string): Promise<T | undefined> => data.get(key) as T | undefined,
        put: async (key: string, value: unknown) => {
          data.set(key, value);
        },
        delete: async (key: string) => data.delete(key),
      },
      blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
    };
    const object = new RelayDurableObject(state);
    const owner = generateKeyPair();
    const peer = generateKeyPair();
    function receiveRequest() {
      return new Request(
        'https://relay.local/envelopes?recipient=' + encodeURIComponent(peer.did) + '&waitMs=200',
        {
          headers: {
            authorization:
              'Bearer ' + createRelayAuthToken(peer, { origin: 'https://relay.local' }),
          },
        },
      );
    }
    const started = Date.now();
    const poll = object.fetch(receiveRequest()).then(async (response) => ({
      status: response.status,
      elapsedMs: Date.now() - started,
      body:
        response.status === 200
          ? (
              (await response.json()) as {
                envelopes: Array<{ payload: { payload: { label: string } } }>;
              }
            ).envelopes.map((envelope) => envelope.payload.payload.label)
          : null,
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const postStarted = Date.now();
    const send = object
      .fetch(
        new Request('https://relay.local/envelopes', {
          method: 'POST',
          body: JSON.stringify(
            signEnvelope(
              {
                taskId: 'task_longpoll',
                recipientDid: peer.did,
                seq: 0,
                eventType: 'PING',
                payload: { label: 'longpoll' },
              },
              owner,
            ),
          ),
        }),
      )
      .then((response) => ({ status: response.status, elapsedMs: Date.now() - postStarted }));
    const result = { poll: await poll, send: await send };
    const next = await object.fetch(receiveRequest());
    const nextBody = (
      (await next.json()) as { envelopes: Array<{ payload: { payload: { label: string } } }> }
    ).envelopes.map((envelope) => envelope.payload.payload.label);
    expect(result.send.status).toBe(202);
    expect(result.send.elapsedMs).toBeLessThan(200);
    expect(result.poll.status).toBe(200);
    expect(result.poll.elapsedMs).toBeLessThan(200);
    expect(result.poll.body).toEqual(['longpoll']);
    expect(next.status).toBe(200);
    expect(nextBody).toEqual([]);
  });
});

describe('issue 23: cancelled durable long-poll leaves the envelope queued', () => {
  it('does not dequeue an envelope saved after the poll aborts', async () => {
    const data = new Map<string, unknown>();
    let nextPut: (() => Promise<void>) | undefined;
    const state = {
      storage: {
        get: async <T>(key: string): Promise<T | undefined> => data.get(key) as T | undefined,
        put: async (key: string, value: unknown) => {
          if (nextPut) {
            const callback = nextPut;
            nextPut = undefined;
            await callback();
          }
          data.set(key, value);
        },
        delete: async (key: string) => data.delete(key),
      },
      blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
    };
    const object = new RelayDurableObject(state);
    const sender = generateKeyPair();
    const peer = generateKeyPair();
    const cancel = new AbortController();
    function receiveRequest(signal?: AbortSignal, wait = 200) {
      return new Request(
        'https://relay.local/envelopes?recipient=' +
          encodeURIComponent(peer.did) +
          '&waitMs=' +
          wait,
        {
          headers: {
            authorization:
              'Bearer ' + createRelayAuthToken(peer, { origin: 'https://relay.local' }),
          },
          signal,
        },
      );
    }
    async function labels(responsePromise: Promise<Response>) {
      const response = await responsePromise;
      const body = (await response.json()) as {
        envelopes?: Array<{ payload: { payload: { label: string } } }>;
        error?: string;
      };
      return {
        status: response.status,
        labels: body.envelopes?.map((envelope) => envelope.payload.payload.label),
        error: body.error,
      };
    }
    const poll = labels(object.fetch(receiveRequest(cancel.signal)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const start = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    nextPut = async () => {
      entered();
      await gate;
    };
    const post = object.fetch(
      new Request('https://relay.local/envelopes', {
        method: 'POST',
        body: JSON.stringify(
          signEnvelope(
            {
              taskId: 'task_after_cancel',
              recipientDid: peer.did,
              seq: 0,
              eventType: 'PING',
              payload: { label: 'after_cancel' },
            },
            sender,
          ),
        ),
      }),
    );
    await Promise.race([start, new Promise((resolve) => setTimeout(resolve, 30))]);
    cancel.abort('synthetic disconnect');
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const cancelledPoll = await poll;
    const postStatus = (await post).status;
    const remaining = await labels(object.fetch(receiveRequest(undefined, 0)));
    expect(postStatus).toBe(202);
    expect(cancelledPoll).toMatchObject({ status: 200, labels: [] });
    expect(remaining).toMatchObject({ status: 200, labels: ['after_cancel'] });
  });
});

describe('issue 27: delegateMulti counts distinct verified workers', () => {
  it('rejects a repeated worker and a workerDid that disagrees with the invite', async () => {
    for (const variant of ['duplicate-worker', 'mismatched-labels'] as const) {
      const owner = generateKeyPair();
      const workerKey = generateKeyPair();
      const relay = new InMemoryRelay();
      let executions = 0;
      const worker = new WorkerNode({
        owner: workerKey,
        relay,
        timeoutMs: 1500,
        approvalProvider: new PolicyAutoApprovalProvider(workerKey),
        adapter: {
          id: 'synthetic',
          name: 'synthetic',
          skills: [],
          executeTask: async () => {
            executions += 1;
            return { ok: true };
          },
        },
      });
      const running = worker
        .start()
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
      const client = new RequesterClient({
        owner,
        relay,
        timeoutMs: 1500,
        approvalProvider: new PolicyAutoApprovalProvider(owner),
      });
      const target = { workerDid: workerKey.did, inviteToken: worker.invite() };
      const workers =
        variant === 'duplicate-worker'
          ? [target, target]
          : [
              { ...target, workerDid: generateKeyPair().did },
              { ...target, workerDid: generateKeyPair().did },
            ];
      await expect(
        client.delegateMulti({
          workers,
          mode: 'quorum',
          quorumSize: 2,
          title: 'synthetic boundary',
          description: 'synthetic',
          input: {},
        }),
      ).rejects.toThrow(
        variant === 'duplicate-worker' ? 'DUPLICATE_WORKER_TARGET' : 'WORKER_DID_MISMATCH',
      );
      expect(executions).toBe(0);
      worker.stop();
      await running;
    }
  });

  it('reaches quorum only across two verified worker identities', async () => {
    const owner = generateKeyPair();
    const leftKey = generateKeyPair();
    const rightKey = generateKeyPair();
    const relay = new InMemoryRelay();
    const workers = [leftKey, rightKey].map(
      (key) =>
        new WorkerNode({
          owner: key,
          relay,
          timeoutMs: 5000,
          approvalProvider: new PolicyAutoApprovalProvider(key),
          adapter: {
            id: 'same',
            name: 'same',
            skills: [],
            executeTask: async () => ({ ok: true }),
          },
        }),
    );
    const pending = Promise.all(workers.map((worker) => worker.start({ once: true })));
    const client = new RequesterClient({
      owner,
      relay,
      timeoutMs: 5000,
      approvalProvider: new PolicyAutoApprovalProvider(owner),
    });
    const result = await client.delegateMulti({
      workers: workers.map((worker) => ({
        workerDid: worker.options.owner.did,
        inviteToken: worker.invite(),
      })),
      mode: 'quorum',
      quorumSize: 2,
      title: 'two workers',
      description: 'synthetic',
      input: {},
    });
    for (const worker of workers) worker.stop();
    await pending;
    expect(result.status).toBe('SETTLED');
    expect(result.winners).toHaveLength(2);
    expect(new Set(result.winners.map((winner) => winner.workerDid))).toEqual(
      new Set([leftKey.did, rightKey.did]),
    );
    expect(result.outputDigest).toBe(digest({ ok: true }));
  });
});

describe('issue 28: concurrent reportProgress stays ordered', () => {
  async function run(parallel: boolean, fireAndForget = false) {
    const owner = generateKeyPair();
    const key = generateKeyPair();
    const relay = new InMemoryRelay();
    const steps: string[] = [];
    const worker = new WorkerNode({
      owner: key,
      relay,
      timeoutMs: 5000,
      approvalProvider: new PolicyAutoApprovalProvider(key),
      adapter: {
        id: 'progress',
        name: 'progress',
        skills: [],
        executeTask: async (ctx) => {
          const report = ctx.reportProgress;
          if (!report) throw new Error('PROGRESS_REQUIRED');
          if (fireAndForget) {
            void report({ step: 'A' });
            void report({ step: 'B' });
          } else if (parallel) {
            await Promise.all([report({ step: 'A' }), report({ step: 'B' })]);
          } else {
            await report({ step: 'A' });
            await report({ step: 'B' });
          }
          return { ok: true };
        },
      },
    });
    const pending = worker.start({ once: true });
    const client = new RequesterClient({
      owner,
      relay,
      timeoutMs: 5000,
      approvalProvider: new PolicyAutoApprovalProvider(owner),
    });
    const result = await client.delegate({
      to: worker.invite(),
      title: 'progress',
      description: 'two synthetic updates',
      input: {},
      onProgress: (progress) => {
        steps.push(progress.step);
      },
    });
    const workerResult = await pending;
    worker.stop();
    return { result, workerResult, steps };
  }

  it('settles sequential and concurrent progress with both steps audited', async () => {
    for (const parallel of [false, true]) {
      const { result, workerResult, steps } = await run(parallel);
      expect(result.state).toBe('SETTLED');
      expect(verifyAudit(result.bundle).valid).toBe(true);
      expect(workerResult?.state).toBe('SETTLED');
      expect(workerResult ? verifyAudit(workerResult.bundle).valid : false).toBe(true);
      expect(steps).toEqual(['A', 'B']);
    }
  });

  it('waits for queued progress before DELIVER when the task does not await it', async () => {
    const { result, steps } = await run(true, true);
    expect(result.state).toBe('SETTLED');
    expect(verifyAudit(result.bundle).valid).toBe(true);
    expect(steps).toEqual(['A', 'B']);
    expect(
      result.bundle.entries.filter((entry) => entry.body.eventType === 'PROGRESS'),
    ).toHaveLength(2);
  });
});

describe('issue 29: delegateMulti accepts a verified JSON null deliverable', () => {
  it('keeps null, false, zero, and empty values that a single delegate already accepts', async () => {
    const owner = generateKeyPair();
    const workerKey = generateKeyPair();
    const otherKey = generateKeyPair();
    const relay = new InMemoryRelay();
    let executions = 0;
    const worker = new WorkerNode({
      owner: workerKey,
      relay,
      timeoutMs: 5000,
      approvalProvider: new PolicyAutoApprovalProvider(workerKey),
      adapter: {
        id: 'synthetic',
        name: 'synthetic',
        skills: [],
        executeTask: async (ctx) => {
          executions += 1;
          return (ctx.input as { value: Json }).value;
        },
      },
    });
    const other = new WorkerNode({
      owner: otherKey,
      relay,
      timeoutMs: 5000,
      approvalProvider: new PolicyAutoApprovalProvider(otherKey),
      adapter: {
        id: 'synthetic-other',
        name: 'synthetic-other',
        skills: [],
        executeTask: async (ctx) => (ctx.input as { value: Json }).value,
      },
    });
    const pending = Promise.all([worker.start(), other.start()]);
    const client = new RequesterClient({
      owner,
      relay,
      timeoutMs: 5000,
      approvalProvider: new PolicyAutoApprovalProvider(owner),
    });
    const target = { workerDid: workerKey.did, inviteToken: worker.invite() };
    const control = await client.delegate({
      to: target.inviteToken,
      title: 'null control',
      description: 'synthetic',
      input: { value: null },
    });
    expect(control.state).toBe('SETTLED');
    expect(control.deliverable).toBeNull();
    const raced = await client.delegateMulti({
      workers: [target],
      mode: 'race',
      quorumSize: 2,
      title: 'synthetic boundary',
      description: 'synthetic',
      input: { value: null },
    });
    expect(raced.status).toBe('SETTLED');
    expect(raced.deliverable).toBeNull();
    expect(raced.outputDigest).toBe(digest(null));
    expect(executions).toBe(2);
    for (const value of [false, 0, '', {}] as const) {
      const result = await client.delegateMulti({
        workers: [target],
        mode: 'race',
        title: 'falsy deliverable',
        description: 'synthetic',
        input: { value },
      });
      expect(result.status).toBe('SETTLED');
      expect(result.deliverable).toEqual(value);
      expect(result.outputDigest).toBe(digest(value));
    }
    const quorum = await client.delegateMulti({
      workers: [target, { workerDid: otherKey.did, inviteToken: other.invite() }],
      mode: 'quorum',
      quorumSize: 2,
      title: 'null quorum',
      description: 'synthetic',
      input: { value: null },
    });
    expect(quorum.status).toBe('SETTLED');
    expect(quorum.deliverable).toBeNull();
    expect(quorum.winners).toHaveLength(2);
    expect(quorum.outputDigest).toBe(digest(null));
    worker.stop();
    other.stop();
    await pending;
  });
});

describe('issue 30: MCP invite expiry preserves an explicit zero', () => {
  it('rejects expiresInSeconds 0 and other invalid TTLs instead of defaulting to 3600', async () => {
    const owner = generateKeyPair();
    const server = new AcpMcpServer({ owner, relay: new InMemoryRelay() });
    async function call(expiresInSeconds: unknown) {
      const response = await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'acp_create_invite',
          arguments: { relayUrl: 'http://127.0.0.1:9', expiresInSeconds },
        },
      });
      const result = (
        response as { result: { isError?: boolean; content: Array<{ text: string }> } }
      ).result;
      return {
        isError: result.isError === true,
        value: JSON.parse(result.content[0].text) as { error?: string; inviteToken?: string },
      };
    }
    for (const expiresInSeconds of [0, -1, 2592001, Number.NaN, '3600']) {
      const created = await call(expiresInSeconds);
      expect(created.isError).toBe(true);
      expect(created.value.error).toBe('INVALID_INVITE_EXPIRY');
      expect(created.value.inviteToken).toBeUndefined();
    }
    expect(() =>
      createInviteToken(
        {
          agentCard: createSignedAgentCard(
            {
              name: 'synthetic',
              agentDid: owner.did,
              relayEndpoint: 'http://127.0.0.1:9',
              skills: [],
            },
            owner,
          ),
          expiresInSeconds: 0,
        },
        owner,
      ),
    ).toThrow('INVALID_INVITE_EXPIRY');
    const accepted = await call(60);
    expect(accepted.isError).toBe(false);
    const invite = parseAndVerifyInviteToken(accepted.value.inviteToken!, Date.now(), {
      allowPrivateRelay: true,
    });
    expect((Date.parse(invite.expiresAt) - Date.parse(invite.issuedAt)) / 1000).toBe(60);
    const multi = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'acp_delegate_multi',
        arguments: {
          mode: 'quorum',
          quorumSize: 0,
          title: 'zero quorum',
          description: 'synthetic',
          workers: [{ workerDid: owner.did }, { workerDid: generateKeyPair().did }],
        },
      },
    });
    const quorum = (multi as { result: { isError?: boolean; content: Array<{ text: string }> } })
      .result;
    expect(quorum.isError).toBe(true);
    expect(JSON.parse(quorum.content[0].text)).toMatchObject({ error: 'INVALID_QUORUM_SIZE' });
    const textual = await server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'acp_delegate_multi',
        arguments: {
          mode: 'quorum',
          quorumSize: '2',
          title: 'text quorum',
          description: 'synthetic',
          workers: [{ workerDid: owner.did }, { workerDid: generateKeyPair().did }],
        },
      },
    });
    const textQuorum = (
      textual as { result: { isError?: boolean; content: Array<{ text: string }> } }
    ).result;
    expect(textQuorum.isError).toBe(true);
    expect(JSON.parse(textQuorum.content[0].text)).toMatchObject({ error: 'INVALID_QUORUM_SIZE' });
  });
});

describe('issue 32: over-budget progress stops the tool before the backend runs', () => {
  it('rejects the same turn as the un-awaited budget report', async () => {
    const owner = generateKeyPair();
    const key = generateKeyPair();
    const relay = new InMemoryRelay();
    let backendCalls = 0;
    const worker = new WorkerNode({
      owner: key,
      relay,
      timeoutMs: 1500,
      approvalProvider: new PolicyAutoApprovalProvider(key),
      tools: { read: { resource: () => 'mcp://synthetic/read', readOnly: true } },
      toolBackend: {
        callTool: async () => {
          backendCalls += 1;
          return { content: [] };
        },
      },
      adapter: {
        id: 'quota',
        name: 'quota',
        skills: [],
        executeTask: async (ctx) => {
          void Promise.resolve(
            ctx.reportProgress?.({ step: 'over', metrics: { inputTokens: 11 } }),
          ).catch(() => undefined);
          await ctx.callTool?.('read', {});
          return { ok: true };
        },
      },
    });
    const summarize = (pending: Promise<unknown>): Promise<{ state?: string; error?: string }> =>
      pending.then(
        (value) => ({ state: (value as { state?: string } | undefined)?.state }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
      );
    const pending = summarize(worker.start({ once: true }));
    const client = new RequesterClient({
      owner,
      relay,
      timeoutMs: 1500,
      approvalProvider: new PolicyAutoApprovalProvider(owner),
    });
    const requester = await summarize(
      client.delegate({
        to: worker.invite(),
        title: 'quota',
        description: 'synthetic counter only',
        input: {},
        budget: { maxInputTokens: 10 },
        capabilities: [
          {
            capabilityId: 'cap_synthetic_read',
            resource: 'mcp://synthetic/read',
            allowedTools: ['read'],
            maxInvocations: 2,
            argConstraints: { type: 'object' },
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
        ],
      }),
    );
    const workerResult = await pending;
    worker.stop();
    expect(backendCalls).toBe(0);
    expect(requester.error).toContain('PEER_REJECTED');
    expect(requester.error).toContain('BUDGET');
    expect(workerResult.error).toContain('BUDGET_EXCEEDED');
  });

  it('still runs a tool when the reported usage stays inside the budget', async () => {
    const owner = generateKeyPair();
    const key = generateKeyPair();
    const relay = new InMemoryRelay();
    let backendCalls = 0;
    const worker = new WorkerNode({
      owner: key,
      relay,
      timeoutMs: 5000,
      approvalProvider: new PolicyAutoApprovalProvider(key),
      tools: { read: { resource: () => 'mcp://synthetic/read', readOnly: true } },
      toolBackend: {
        callTool: async () => {
          backendCalls += 1;
          return { content: [] };
        },
      },
      adapter: {
        id: 'quota-ok',
        name: 'quota-ok',
        skills: [],
        executeTask: async (ctx) => {
          await ctx.reportProgress?.({ step: 'inside', metrics: { inputTokens: 1 } });
          await ctx.callTool?.('read', {});
          return { ok: true };
        },
      },
    });
    const pending = worker.start({ once: true });
    const client = new RequesterClient({
      owner,
      relay,
      timeoutMs: 5000,
      approvalProvider: new PolicyAutoApprovalProvider(owner),
    });
    const result = await client.delegate({
      to: worker.invite(),
      title: 'within budget',
      description: 'synthetic',
      input: {},
      budget: { maxInputTokens: 10 },
      capabilities: [
        {
          capabilityId: 'cap_synthetic_read',
          resource: 'mcp://synthetic/read',
          allowedTools: ['read'],
          maxInvocations: 2,
          argConstraints: { type: 'object' },
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      ],
    });
    const workerResult = await pending;
    worker.stop();
    expect(result.state).toBe('SETTLED');
    expect(workerResult?.state).toBe('SETTLED');
    expect(backendCalls).toBe(1);
    expect(verifyAudit(result.bundle).valid).toBe(true);
  });
});

describe('issue 33: owner DID and agent DID address the same worker', () => {
  it('accepts an owner DID in delegate and delegateMulti when agentDid differs', async () => {
    const owner = generateKeyPair();
    const key = generateKeyPair();
    const agent = generateKeyPair();
    const relay = new InMemoryRelay();
    let executions = 0;
    const worker = new WorkerNode({
      accessMode: 'open', allowAnyRequester: true,
      owner: key,
      agentDid: agent.did,
      agentKey: agent,
      relay,
      timeoutMs: 1500,
      publishToRegistry: true,
      approvalProvider: new PolicyAutoApprovalProvider(key),
      adapter: {
        id: 'alias',
        name: 'alias',
        skills: [],
        executeTask: async () => {
          executions += 1;
          return { ok: true };
        },
      },
    });
    const pending = worker
      .start()
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    const client = new RequesterClient({
      owner,
      relay,
      timeoutMs: 1500,
      approvalProvider: new PolicyAutoApprovalProvider(owner),
    });
    const result: Record<string, { state?: string; deliverable?: Json; error?: string }> = {};
    try {
      for (const mode of ['single-owner', 'multi-owner', 'multi-agent-invite'] as const) {
        try {
          const settled =
            mode === 'single-owner'
              ? await client.delegate({
                  to: key.did,
                  title: 'alias',
                  description: 'synthetic',
                  input: {},
                })
              : await client.delegateMulti({
                  workers: [
                    mode === 'multi-owner'
                      ? { workerDid: key.did }
                      : { workerDid: agent.did, inviteToken: worker.invite() },
                  ],
                  mode: 'race',
                  title: 'alias',
                  description: 'synthetic',
                  input: {},
                });
          result[mode] = {
            state: 'state' in settled ? settled.state : settled.status,
            deliverable: settled.deliverable,
          };
        } catch (error) {
          result[mode] = { error: error instanceof Error ? error.message : String(error) };
        }
      }
    } finally {
      worker.stop();
      await pending;
    }
    expect(executions).toBe(3);
    expect(result['single-owner']).toMatchObject({ state: 'SETTLED', deliverable: { ok: true } });
    expect(result['multi-owner']).toMatchObject({ state: 'SETTLED', deliverable: { ok: true } });
    expect(result['multi-agent-invite']).toMatchObject({
      state: 'SETTLED',
      deliverable: { ok: true },
    });
  });

  it('binds owner-addressed and agent-addressed races to the canonical agentDid', async () => {
    const owner = generateKeyPair();
    const key = generateKeyPair();
    const agent = generateKeyPair();
    const relay = new InMemoryRelay();
    const worker = new WorkerNode({
      accessMode: 'open', allowAnyRequester: true,
      owner: key,
      agentDid: agent.did,
      agentKey: agent,
      relay,
      timeoutMs: 5000,
      publishToRegistry: true,
      approvalProvider: new PolicyAutoApprovalProvider(key),
      adapter: {
        id: 'alias',
        name: 'alias',
        skills: [],
        executeTask: async () => ({ ok: true }),
      },
    });
    const pending = worker.start();
    const client = new RequesterClient({
      owner,
      relay,
      timeoutMs: 5000,
      approvalProvider: new PolicyAutoApprovalProvider(owner),
    });
    const byOwner = await client.delegateMulti({
      workers: [{ workerDid: key.did }],
      mode: 'race',
      title: 'owner alias',
      description: 'synthetic',
      input: {},
    });
    const byAgent = await client.delegateMulti({
      workers: [{ workerDid: agent.did }],
      mode: 'race',
      title: 'agent alias',
      description: 'synthetic',
      input: {},
    });
    worker.stop();
    await pending;
    expect(byOwner.status).toBe('SETTLED');
    expect(byOwner.winners.map((winner) => winner.workerDid)).toEqual([agent.did]);
    expect(byAgent.status).toBe('SETTLED');
    expect(byAgent.winners.map((winner) => winner.workerDid)).toEqual([agent.did]);
    expect(verifyAudit(byOwner.receipts[0].bundle).valid).toBe(true);
  });

  it('does not let owner and agent aliases of one worker satisfy a quorum of two', async () => {
    const owner = generateKeyPair();
    const key = generateKeyPair();
    const agent = generateKeyPair();
    const relay = new InMemoryRelay();
    let executions = 0;
    const worker = new WorkerNode({
      owner: key,
      agentDid: agent.did,
      agentKey: agent,
      relay,
      timeoutMs: 5000,
      publishToRegistry: true,
      approvalProvider: new PolicyAutoApprovalProvider(key),
      adapter: {
        id: 'alias',
        name: 'alias',
        skills: [],
        executeTask: async () => {
          executions += 1;
          return { ok: true };
        },
      },
    });
    const pending = worker.start();
    const client = new RequesterClient({
      owner,
      relay,
      timeoutMs: 5000,
      approvalProvider: new PolicyAutoApprovalProvider(owner),
    });
    await expect(
      client.delegateMulti({
        workers: [{ workerDid: key.did }, { workerDid: agent.did }],
        mode: 'quorum',
        quorumSize: 2,
        title: 'same worker',
        description: 'synthetic',
        input: {},
      }),
    ).rejects.toThrow('DUPLICATE_WORKER_TARGET');
    await expect(
      client.delegateMulti({
        workers: [{ workerDid: key.did }, { workerDid: agent.did, inviteToken: worker.invite() }],
        mode: 'quorum',
        quorumSize: 2,
        title: 'same worker invite',
        description: 'synthetic',
        input: {},
      }),
    ).rejects.toThrow('DUPLICATE_WORKER_TARGET');
    await expect(
      client.delegateMulti({
        workers: [{ workerDid: key.did, inviteToken: worker.invite() }],
        mode: 'race',
        title: 'owner label on invite',
        description: 'synthetic',
        input: {},
      }),
    ).rejects.toThrow('WORKER_DID_MISMATCH');
    expect(executions).toBe(0);
    worker.stop();
    await pending;
  });

  it('counts an owner-addressed worker and a different worker as two quorum votes', async () => {
    const owner = generateKeyPair();
    const key = generateKeyPair();
    const agent = generateKeyPair();
    const other = generateKeyPair();
    const relay = new InMemoryRelay();
    const alias = new WorkerNode({
      accessMode: 'open', allowAnyRequester: true,
      owner: key,
      agentDid: agent.did,
      agentKey: agent,
      relay,
      timeoutMs: 5000,
      publishToRegistry: true,
      approvalProvider: new PolicyAutoApprovalProvider(key),
      adapter: {
        id: 'alias',
        name: 'alias',
        skills: [],
        executeTask: async () => ({ ok: true }),
      },
    });
    const second = new WorkerNode({
      accessMode: 'open', allowAnyRequester: true,
      owner: other,
      relay,
      timeoutMs: 5000,
      publishToRegistry: true,
      approvalProvider: new PolicyAutoApprovalProvider(other),
      adapter: {
        id: 'second',
        name: 'second',
        skills: [],
        executeTask: async () => ({ ok: true }),
      },
    });
    const pending = Promise.all([alias.start({ once: true }), second.start({ once: true })]);
    const client = new RequesterClient({
      owner,
      relay,
      timeoutMs: 5000,
      approvalProvider: new PolicyAutoApprovalProvider(owner),
    });
    const result = await client.delegateMulti({
      workers: [{ workerDid: key.did }, { workerDid: other.did }],
      mode: 'quorum',
      quorumSize: 2,
      title: 'two workers',
      description: 'synthetic',
      input: {},
    });
    for (const node of [alias, second]) node.stop();
    await pending;
    expect(result.status).toBe('SETTLED');
    expect(result.deliverable).toEqual({ ok: true });
    expect(new Set(result.winners.map((winner) => winner.workerDid))).toEqual(
      new Set([agent.did, other.did]),
    );
  });
});

describe('issue 35: invalid reportProgress poisons the session', () => {
  it('keeps a caught INVALID_PROGRESS from settling and still stops a gated budget overrun', async () => {
    for (const mode of ['gated-valid-over', 'invalid-caught-over'] as const) {
      const owner = generateKeyPair();
      const key = generateKeyPair();
      const relay = new InMemoryRelay();
      let backendCalls = 0;
      let progressSeen = false;
      let held = false;
      let release: () => void = () => undefined;
      let entered: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const send = relay.send.bind(relay);
      relay.send = async (envelope) => {
        if (mode === 'gated-valid-over' && envelope.payload.eventType === 'PROGRESS')
          progressSeen = true;
        if (
          mode === 'gated-valid-over' &&
          progressSeen &&
          !held &&
          envelope.payload.eventType === 'AUDIT_ACK' &&
          envelope.payload.senderDid === owner.did
        ) {
          held = true;
          entered();
          await gate;
        }
        return send(envelope);
      };
      const worker = new WorkerNode({
        owner: key,
        relay,
        timeoutMs: 1500,
        approvalProvider: new PolicyAutoApprovalProvider(key),
        tools: { read: { resource: () => 'mcp://synthetic/read', readOnly: true } },
        toolBackend: {
          callTool: async () => {
            backendCalls += 1;
            return { content: [] };
          },
        },
        adapter: {
          id: 'boundary',
          name: 'boundary',
          skills: [],
          executeTask: async (ctx) => {
            if (mode === 'gated-valid-over') {
              void Promise.resolve(
                ctx.reportProgress?.({ step: 'first', metrics: { inputTokens: 1 } }),
              ).catch(() => undefined);
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  reached,
                  new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('GATE_TIMEOUT')), 1000);
                  }),
                ]);
              } finally {
                clearTimeout(timer);
              }
            }
            void Promise.resolve(
              ctx.reportProgress?.({
                step: mode === 'invalid-caught-over' ? '' : 'over',
                metrics: { inputTokens: 11 },
              }),
            ).catch(() => undefined);
            try {
              await ctx.callTool?.('read', {});
            } finally {
              release();
            }
            return { ok: true };
          },
        },
      });
      const summarize = (pending: Promise<unknown>): Promise<{ state?: string; error?: string }> =>
        pending.then(
          (value) => ({ state: (value as { state?: string } | undefined)?.state }),
          (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
        );
      const pending = summarize(worker.start({ once: true }));
      const client = new RequesterClient({
        owner,
        relay,
        timeoutMs: 1500,
        approvalProvider: new PolicyAutoApprovalProvider(owner),
      });
      const requester = await summarize(
        client.delegate({
          to: worker.invite(),
          title: 'boundary',
          description: 'synthetic counter',
          input: {},
          budget: { maxInputTokens: 10 },
          capabilities: [
            {
              capabilityId: 'cap_synthetic_read',
              resource: 'mcp://synthetic/read',
              allowedTools: ['read'],
              maxInvocations: 2,
              argConstraints: { type: 'object' },
              expiresAt: new Date(Date.now() + 60000).toISOString(),
            },
          ],
        }),
      );
      release();
      const workerResult = await pending;
      worker.stop();
      if (mode === 'gated-valid-over') {
        expect(held).toBe(true);
        expect(backendCalls).toBe(0);
        expect(requester.error).toBe('PEER_REJECTED: {"code":"BUDGET"}');
        expect(workerResult.error).toContain('EXECUTION_ABORTED: BUDGET_EXCEEDED:');
      } else {
        expect(held).toBe(false);
        expect(backendCalls).toBe(1);
        expect(requester.error).toBe('PEER_REJECTED: {"code":"INVALID"}');
        expect(workerResult.error).toBe('INVALID_PROGRESS');
      }
    }
  });
});
