// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInviteToken, createSignedAgentCard, digest, generateKeyPair, signApproval } from '../packages/core/src/index.js';
import type { Json, KeyPair } from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { AcpMcpServer, IdempotencyStore, InviteStore, PolicyAutoApprovalProvider, RequesterClient,
  RequesterPendingStore, WorkerNode, buildTaskManifest } from '../packages/runtime/src/index.js';
import type { AcpMcpServerOptions, ApprovalProvider } from '../packages/runtime/src/index.js';
import { body, deferred, form, harness, initialize, toolCall } from './mcp-approval-helpers.js';

// Pin compatibility to this fixture's clock; idempotency does not test retirement.
const protocolPolicy = { releasedAt: '2030-01-01T00:00:00Z',
  sendLegacyUntilDays: 90, receiveLegacyUntilDays: 180 } as const;
const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.UTC(2030, 0, 1));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('OFFLINE_TEST_NETWORK'); })); });
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    expect(fetch).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); }
});
function setup() {
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'mcp-idempotency-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const identityOptions = { env: { SEALBRIDGE_DATA_DIR: join(root, 'data') } };
  const owner = generateKeyPair(), remote = generateKeyPair(), relay = new InMemoryRelay();
  const execute = vi.fn(async (context: { input: Json }) => context.input);
  const worker = new WorkerNode({ protocolPolicy, owner: remote, relay, relayUrl: 'https://relay.example', identityOptions,
    autoAccept: { version: 1, enabled: true, from: 'anyone', work: 'write', limits: {} }, checkPeer: () => 'trusted', approvalProvider: new PolicyAutoApprovalProvider(remote),
    adapter: { id: 'echo', name: 'Echo', skills: [], executeTask: execute } });
  const approve = vi.fn(async (request: Parameters<ApprovalProvider['approve']>[0]) =>
    signApproval(request.taskId, request.gate, request.target, owner));
  const transport = vi.fn(() => relay);
  const options: AcpMcpServerOptions = { protocolPolicy, owner, identityOptions, relay: 'https://relay.example',
    transportFactory: transport, approvalProvider: { approve } };
  const server = new AcpMcpServer(options);
  const send = vi.spyOn(relay, 'send');
  const args = { workerDid: remote.did, title: 'Echo', description: 'Return JSON', input: { a: 1, b: 2 }, idempotencyKey: 'example' };
  const store = () => new IdempotencyStore(owner, identityOptions);
  const invitation = (peer: KeyPair) => createInviteToken({ agentCard: createSignedAgentCard({
    name: 'Echo', agentDid: peer.did, relayEndpoint: 'https://relay.example', skills: [],
  }, peer) }, peer);
  function start() { const running = worker.start(); cleanups.push(async () => { worker.stop(); await running; server.stopDelivery(); }); }
  return { root, identityOptions, owner, remote, relay, execute, worker, approve, options, server, send, args, transport, start, store, invitation };
}
async function call(server: AcpMcpServer, args: Record<string, unknown>, tool = 'acp_delegate_task') {
  return await server.handle(toolCall('call', args, tool)) as any;
}
const proposals = (f: ReturnType<typeof setup>) => f.send.mock.calls.filter(([e]) => e.payload.eventType === 'PROPOSE');

describe('MCP send-tool idempotency', () => {
  it('returns one persisted result for concurrent, sequential and restarted calls with one pre-send approval', async () => {
    const f = setup(); f.start();
    const entered = deferred<void>(), release = deferred<void>();
    f.approve.mockImplementation(async r => {
      if (r.gate === 'external_side_effect') { entered.resolve(); await release.promise; }
      return signApproval(r.taskId, r.gate, r.target, f.owner);
    });
    const first = call(f.server, f.args); await entered.promise;
    const duplicate = call(f.server, { ...f.args, input: { b: 2, a: 1 } });
    const other = new AcpMcpServer(f.options);
    expect(body(await call(other, f.args))).toMatchObject({ error: 'IDEMPOTENCY_IN_PROGRESS', taskIds: [expect.any(String)] });
    release.resolve(); const response = await first;
    expect(body(response)).toMatchObject({ status: 'SETTLED', deliverable: f.args.input });
    expect((await duplicate).result).toEqual(response.result);
    expect((await call(f.server, f.args)).result).toEqual(response.result);
    expect((await call(new AcpMcpServer({ ...f.options, allowedWorkerDids: [] }), f.args)).result).toEqual(response.result);
    expect(proposals(f)).toHaveLength(1); expect(f.execute).toHaveBeenCalledOnce();
    expect(f.approve.mock.calls.filter(([r]) => r.gate === 'external_side_effect')).toHaveLength(1);
    expect(f.approve.mock.calls.filter(([r]) => r.gate === 'final_verification')).toHaveLength(1);
    const operation = f.store().records.snapshot('operations')[0];
    expect(operation.response).toEqual({ isError: false, value: body(response) });
    expect(operation.messageIds).toHaveLength(1);
    expect(f.store().records.read('messages', operation.messageIds[0])?.operationId).toBe(operation.operationId);
    expect(operation.preparedActions[0].messageId).toBe(operation.messageIds[0]);
    expect(operation.preparedActions[0].relayUrl).toBe('https://relay.example');
    expect(operation.approvals?.[0].receipt?.payload.gate).toBe('external_side_effect');
  });
  it.each([
    { input: { a: 9 } }, { workerDid: generateKeyPair().did }, { outputSchema: { type: 'number' } },
    { budget: { maxOutputTokens: 2 } }, { taskTimeoutMs: 900_000 }, { waitTimeoutMs: 900_000 },
    { connectTimeoutMs: 60_000 }, { executionTimeoutMs: 2000 }, { minimumIsolationLevel: 'oci_container' },
    { relayUrl: 'https://other.example' }, { relayUrl: 'invalid endpoint' }, { title: 'Changed' }, { description: 'Changed' },
  ])('conflicts before approval or transmission when content changes (%#)', async change => {
    const f = setup();
    f.approve.mockImplementation(async () => { throw new Error('APPROVAL_REJECTED'); });
    expect(body(await call(f.server, f.args)).error).toBe('APPROVAL_REJECTED');
    expect(body(await call(f.server, { ...f.args, ...change })).error).toBe('IDEMPOTENCY_CONFLICT');
    expect(f.approve).toHaveBeenCalledOnce(); expect(proposals(f)).toHaveLength(0);
  });
  it('materializes equivalent defaults and rejects unknown keyed arguments', async () => {
    const f = setup(); f.approve.mockImplementation(async () => { throw new Error('APPROVAL_REJECTED'); });
    const args = { ...f.args }; delete (args as any).description;
    const first = await call(f.server, args);
    expect((await call(f.server, { ...args, description: args.title, outputSchema: {}, taskTimeoutMs: 600_000,
      budget: { maxOutputTokens: 10000 }, minimumIsolationLevel: 'subprocess_restricted' })).result).toEqual(first.result);
    expect(await call(f.server, { ...args, unexpected: 1 })).toMatchObject({ error: { code: -32602 } });
    expect(f.approve).toHaveBeenCalledOnce();
  });
  it.each(['', 'x'.repeat(201), 'é'.repeat(101), '\ud800', '\udc00', 7, null])('rejects invalid MCP keys before preparation (%#)', async key => {
    const f = setup();
    expect(await call(f.server, { ...f.args, idempotencyKey: key })).toMatchObject({ error: { code: -32602 } });
    expect(f.approve).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
    expect(fs.existsSync(f.store().records.root)).toBe(false);
  });
  it('caches unavailable approval and explicit rejection without transmission', async () => {
    const f = setup();
    const options = { ...f.options, approvalProvider: undefined, requireInteractiveApproval: true };
    const server = new AcpMcpServer(options);
    const first = await call(server, f.args);
    expect(body(first).error).toContain('APPROVAL_CHANNEL_UNAVAILABLE');
    expect((await call(new AcpMcpServer(f.options), f.args)).result).toEqual(first.result);
    const denied = { ...f.args, idempotencyKey: 'denied' };
    f.approve.mockImplementation(async r => signApproval(r.taskId, r.gate, r.target, f.owner, 'REJECTED'));
    const rejected = await call(f.server, denied);
    expect(body(rejected).error).toBe('APPROVAL_REJECTED');
    expect((await call(new AcpMcpServer(f.options), denied)).result).toEqual(rejected.result);
    expect(f.approve).toHaveBeenCalledOnce(); expect(proposals(f)).toHaveLength(0);
  });
  it('caches a cancelled owner prompt and never opens another prompt for its key', async () => {
    const f = setup();
    const h = harness({ ...f.options, approvalProvider: undefined, requireInteractiveApproval: true });
    try {
      await initialize(h, { elicitation: { form: {} } });
      h.send(toolCall('first', f.args)); await form(h);
      h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'first' } });
      const first = await h.next(m => m.id === 'first');
      expect(body(first).error).toBe('APPROVAL_ABORTED');
      h.send(toolCall('second', f.args));
      expect((await h.next(m => m.id === 'second')).result).toEqual(first.result);
      expect(h.messages.filter(m => m.method === 'elicitation/create')).toHaveLength(1);
      expect(proposals(f)).toHaveLength(0);
    } finally { await h.close(); }
  });
  it('keeps a held result and one explicit resubmission attempt across restarts', async () => {
    const f = setup();
    // The default intake path holds an unconnected peer and never invokes an adapter.
    const heldWorker = new WorkerNode({ protocolPolicy, owner: f.remote, identityOptions: f.identityOptions,
      relay: f.relay, relayUrl: 'https://relay.example', approvalProvider: new PolicyAutoApprovalProvider(f.remote),
      adapter: { id: 'echo', name: 'Echo', skills: [], executeTask: f.execute } });
    const running = heldWorker.start(); cleanups.push(async () => { heldWorker.stop(); await running; });
    const first = await call(f.server, f.args);
    expect(body(first)).toMatchObject({ error: 'PENDING_OWNER_APPROVAL', retryable: false, pendingId: expect.any(String) });
    expect((await call(new AcpMcpServer(f.options), f.args)).result).toEqual(first.result);
    const pending = new RequesterPendingStore(f.owner, f.identityOptions), pendingId = body(first).pendingId;
    expect(pending.list()[0].attempts).toBe(1);
    const args = { pendingId, idempotencyKey: 'resubmission' };
    const fresh = await call(f.server, args, 'acp_resubmit_pending_request');
    expect(body(fresh)).toMatchObject({ error: 'PENDING_OWNER_APPROVAL', retryable: false, pendingId });
    pending.resolve(pendingId);
    expect((await call(new AcpMcpServer(f.options), args, 'acp_resubmit_pending_request')).result).toEqual(fresh.result);
    expect(pending.list()[0].attempts).toBe(2);
    expect(proposals(f)).toHaveLength(2); expect(f.execute).not.toHaveBeenCalled();
    expect(body(await call(f.server, { ...args, pendingId: 'different' }, 'acp_resubmit_pending_request')).error).toBe('IDEMPOTENCY_CONFLICT');
  });
  it('returns the first alias result after rebinding and after invitation expiry', async () => {
    const f = setup(); f.start();
    const invites = await InviteStore.open(f.owner, f.identityOptions);
    invites.import(f.worker.invite(), 'reviewer');
    const args = { ...f.args, workerRef: 'reviewer' }; delete (args as any).workerDid;
    const first = await call(f.server, args); expect(body(first).status).toBe('SETTLED');
    invites.remove('reviewer');
    const another = new WorkerNode({ protocolPolicy, owner: generateKeyPair(), relay: f.relay, relayUrl: 'https://relay.example',
      adapter: { id: 'echo', name: 'Echo', skills: [], executeTask: f.execute } });
    invites.import(another.invite(), 'reviewer');
    vi.setSystemTime(Date.now() + 3600_001);
    expect((await call(new AcpMcpServer(f.options), args)).result).toEqual(first.result);
    expect(proposals(f)).toHaveLength(1); expect(f.execute).toHaveBeenCalledOnce();
  });
  it.each(['quorum', 'race'] as const)('prepares a complete ordered %s fan-out and repeats no child or approval', async mode => {
    const f = setup(); f.start();
    const otherOwner = generateKeyPair();
    const other = new WorkerNode({ protocolPolicy, owner: otherOwner, relay: f.relay, relayUrl: 'https://relay.example', autoAccept: { version: 1, enabled: true, from: 'anyone', work: 'write', limits: {} }, checkPeer: () => 'trusted',
      approvalProvider: new PolicyAutoApprovalProvider(otherOwner), adapter: { id: 'echo', name: 'Echo', skills: [], executeTask: f.execute } });
    const running = other.start(); cleanups.push(async () => { other.stop(); await running; });
    f.approve.mockImplementation(async r => {
      if (r.gate === 'external_side_effect') {
        const operation = f.store().records.snapshot('operations')[0];
        expect(operation.preparedActions).toHaveLength(2);
        expect((r.target as any).fanOut).toBe(2);
      }
      return signApproval(r.taskId, r.gate, r.target, f.owner);
    });
    const args = { title: 'Echo', description: 'Return JSON', input: { n: 1 }, mode, quorumSize: 2, idempotencyKey: 'multi',
      workers: [{ workerDid: f.remote.did, inviteToken: f.invitation(f.remote) },
        { workerDid: otherOwner.did, inviteToken: f.invitation(otherOwner) }] };
    const firstCall = call(f.server, args, 'acp_delegate_multi'), secondCall = call(f.server, args, 'acp_delegate_multi');
    const [first, second] = await Promise.all([firstCall, secondCall]);
    const executions = f.execute.mock.calls.length;
    expect(executions).toBeGreaterThanOrEqual(mode === 'quorum' ? 2 : 1);
    expect(executions).toBeLessThanOrEqual(2);
    expect(body(first)).toMatchObject({ status: 'SETTLED', taskIds: [expect.any(String), expect.any(String)] });
    expect(second.result).toEqual(first.result);
    expect((await call(new AcpMcpServer(f.options), args, 'acp_delegate_multi')).result).toEqual(first.result);
    const operation = f.store().records.snapshot('operations')[0];
    expect(operation.preparedActions.map(a => a.childIndex)).toEqual([0, 1]);
    expect(operation.taskIds).toEqual(operation.preparedActions.map(a => a.manifest.taskId));
    expect(operation.messageIds).toEqual(operation.preparedActions.map(a => a.messageId));
    expect(proposals(f)).toHaveLength(2); expect(f.execute).toHaveBeenCalledTimes(executions);
    expect(f.approve.mock.calls.filter(([r]) => r.gate === 'external_side_effect')).toHaveLength(2);
    for (const change of [{ mode: mode === 'race' ? 'quorum' : 'race' }, { quorumSize: 1 }, { workers: [...args.workers].reverse() }, { workers: [args.workers[0]] }])
      expect(body(await call(f.server, { ...args, ...change }, 'acp_delegate_multi')).error).toBe('IDEMPOTENCY_CONFLICT');
  });
  it('reports multi preparation capacity before any recipient approval', async () => {
    const f = setup();
    const server = new AcpMcpServer({ ...f.options, idempotencyOptions: { limits: { operationBytes: 4096 } } });
    const otherOwner = generateKeyPair();
    const args = { title: 'Echo', description: 'Return JSON', input: { text: 'x'.repeat(500) },
      mode: 'quorum', idempotencyKey: 'capacity', workers: [{ workerDid: f.remote.did, inviteToken: f.invitation(f.remote) },
        { workerDid: otherOwner.did, inviteToken: f.invitation(otherOwner) }] };
    const first = await call(server, args, 'acp_delegate_multi');
    expect(body(first)).toEqual({ error: 'IDEMPOTENCY_STORE_FULL' });
    expect((await call(new AcpMcpServer(f.options), args, 'acp_delegate_multi')).result).toEqual(first.result);
    expect(f.approve).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it('caches final-verification refusal after one execution', async () => {
    const f = setup(); f.start();
    f.approve.mockImplementation(async r => signApproval(r.taskId, r.gate, r.target, f.owner,
      r.gate === 'final_verification' ? 'REJECTED' : 'APPROVED'));
    const first = await call(f.server, f.args);
    expect(body(first).error).toContain('APPROVAL_REQUIRED: final_verification');
    expect((await call(new AcpMcpServer(f.options), f.args)).result).toEqual(first.result);
    expect(f.execute).toHaveBeenCalledOnce(); expect(proposals(f)).toHaveLength(1);
    expect(f.approve.mock.calls.filter(([r]) => r.gate === 'external_side_effect')).toHaveLength(1);
    expect(f.approve.mock.calls.filter(([r]) => r.gate === 'final_verification')).toHaveLength(1);
  });
  it('supports keyed runtime sends and requires returned evidence from a pre-send hook', async () => {
    const f = setup(); f.start();
    const client = new RequesterClient({ protocolPolicy, owner: f.owner, identityOptions: f.identityOptions, relay: f.relay,
      approvalProvider: new PolicyAutoApprovalProvider(f.owner) });
    const beforePropose = vi.fn(async ({ manifest, input, relay }: any) => {
      const target = { manifest, input, relay, fanOut: 1, description: manifest.task.description };
      return { targetDigest: digest(target), approvedAt: Date.now(), receipt: signApproval(manifest.taskId, 'external_side_effect', target, f.owner) };
    });
    const args = { to: f.remote.did, title: 'Runtime', description: 'Return JSON', input: null, idempotencyKey: 'runtime', beforePropose };
    const [first, duplicate] = await Promise.all([client.delegate(args), client.delegate(args)]);
    expect(await client.delegate({ ...args, auditPath: join(f.root, 'unused.jsonl'), onProgress: vi.fn() })).toEqual(first);
    expect(fs.existsSync(join(f.root, 'unused.jsonl'))).toBe(false);
    expect(duplicate).toEqual(first); expect(beforePropose).toHaveBeenCalledOnce(); expect(f.execute).toHaveBeenCalledOnce();
    await expect(client.delegate({ ...args, capabilities: [{ capabilityId: 'changed', resource: 'example', allowedTools: [], maxInvocations: 1, expiresAt: new Date(Date.now() + 600_000).toISOString() }] })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await expect(client.delegate({ ...args, idempotencyKey: 'void', beforePropose: async () => {} })).rejects.toThrow('IDEMPOTENCY_AUTHORIZATION_REQUIRED');
    const manifest = buildTaskManifest({ ownerDid: f.owner.did, workerDid: f.remote.did, title: 'Runtime', description: 'Return JSON' });
    const pending = new RequesterPendingStore(f.owner, f.identityOptions);
    const id = pending.save({ to: f.remote.did, manifest, input: null, timeouts: {} });
    const run = vi.fn((request: Parameters<RequesterClient['delegate']>[0]) => client.delegate(request));
    const result = await pending.resubmit(id, run, { idempotencyKey: 'runtime-resubmit' });
    expect(await new RequesterPendingStore(f.owner, f.identityOptions).resubmit(id, run, { idempotencyKey: 'runtime-resubmit' })).toEqual(result);
    expect(run).toHaveBeenCalledOnce(); expect(pending.list()[0].attempts).toBe(2);
  });
});

it.each(['microvm', 'wasm', '', 'unknown', null, 1, {}, []])('rejects invalid MCP minimumIsolationLevel %j before side effects', async minimumIsolationLevel => {
  const f = setup();
  for (const tool of ['acp_delegate_task', 'acp_delegate_multi']) {
    for (const keyed of [false, true]) {
      const args: Record<string, unknown> = { ...f.args, minimumIsolationLevel };
      if (!keyed) delete args.idempotencyKey;
      const response = await call(f.server, args, tool);
      expect(response.error).toEqual({ code: -32602, message: 'Invalid minimumIsolationLevel: expected subprocess_restricted or oci_container' });
    }
  }
  expect(f.approve).not.toHaveBeenCalled();
  expect(f.transport).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
  expect(fs.existsSync(join(f.root, 'data'))).toBe(false);
});
