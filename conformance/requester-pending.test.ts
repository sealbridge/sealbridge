// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPair, openEnvelope, createRevocationNotice, digest, parseAndVerifyInviteToken } from '../packages/core/src/index.js';
import type { SignedEnvelope } from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { AcpMcpServer, RequesterClient, RequesterPendingStore, WorkerNode, WorkerTrustStore,
  PolicyAutoApprovalProvider, buildTaskManifest, resolveOrCreateIdentity, requesterPendingPath,
  resolveDataRoot, InviteStore } from '../packages/runtime/src/index.js';
import { networkCommand } from '../cli/src/network.js';
import { pendingCommand } from '../cli/src/pending.js';
import { body, form, harness, initialize, toolCall } from './mcp-approval-helpers.js';
import { formatCliError } from '../cli/src/error-messages.js';

let root: string;
const url = 'https://relay.sealbridge.dev';
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
  root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'sealbridge-pending-'));
  vi.stubEnv('SEALBRIDGE_DATA_DIR', root); vi.stubEnv('ACP_DATA_DIR', root);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('UNEXPECTED_NETWORK'); });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
const task = { title: 'Echo', description: 'Return JSON', input: { retainedInput: ['one', 2] } };
function fixture() {
  const owner = generateKeyPair(), requester = resolveOrCreateIdentity('requester');
  const relay = new InMemoryRelay(), intake = new WorkerTrustStore(owner);
  const frames: SignedEnvelope[] = [], send = relay.send.bind(relay);
  relay.send = e => { frames.push(e); return send(e); };
  const execute = vi.fn(async context => context.input);
  const worker = new WorkerNode({ owner, relay, relayUrl: url,  intakeStore: intake,
    approvalProvider: new PolicyAutoApprovalProvider(owner),
    adapter: { id: 'echo', name: 'Echo', skills: [], executeTask: execute }, timeoutMs: 2000 });
  const pending = new RequesterPendingStore(requester);
  const client = new RequesterClient({ owner: requester, relay, pendingStore: pending,
    pendingRelayUrl: url, approvalProvider: new PolicyAutoApprovalProvider(requester), timeoutMs: 2000 });
  async function run<T>(action: () => Promise<T>): Promise<T> {
    const done = worker.start({ once: true }).catch(() => undefined);
    try { return await action(); } finally { await done; }
  }
  return { owner, requester, relay, intake, frames, execute, worker, pending, client, run };
}
async function call(server: AcpMcpServer, name: string, args: object = {}) {
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const result = (response as { result?: { isError: boolean; content: Array<{ text: string }> }; error?: unknown });
  if (!result.result) return { rpcError: result.error };
  return { ...JSON.parse(result.result.content[0].text), isError: result.result.isError };
}
it('retains held tasks across restart and explicitly resubmits fresh task ids after review', async () => {
  const f = fixture();
  const error = await f.run(() => f.client.delegate({ ...task, to: f.owner.did })).catch(e => e);
  expect(error).toMatchObject({ code: 'PENDING_OWNER_APPROVAL', retryable: false, pendingId: expect.any(String) });
  const original = f.pending.list()[0];
  expect(JSON.parse(formatCliError(error))).toMatchObject({ error: 'PENDING_OWNER_APPROVAL', retryable: false,
    pendingId: original.id, nextStep: expect.stringContaining('pending resubmit') });
  expect(f.execute).not.toHaveBeenCalled();
  const restarted = new RequesterPendingStore(f.requester);
  expect(restarted.list()).toEqual([original]);
  await expect(f.run(() => restarted.resubmit(original.id, request => f.client.delegate(request))))
    .rejects.toMatchObject({ code: 'PENDING_OWNER_APPROVAL', pendingId: original.id });
  expect(restarted.list()).toMatchObject([{ id: original.id, state: 'pending', attempts: 2 }]);
  expect(restarted.list()[0].lastTaskId).not.toBe(original.originalTaskId);
  expect(f.intake.list()).toHaveLength(1);
  f.intake.decide(f.intake.list()[0].id, 'approve', 'trusted');
  expect(f.execute).not.toHaveBeenCalled();
  const result = await f.run(() => restarted.resubmit(original.id, request => f.client.delegate(request)));
  expect(result).toMatchObject({ state: 'SETTLED', deliverable: task.input });
  expect(result.taskId).not.toBe(original.originalTaskId);
  expect(restarted.list()).toMatchObject([{ id: original.id, state: 'resolved', attempts: 3 }]);
  expect(f.execute).toHaveBeenCalledOnce();
  const proposed = f.frames.filter(e => e.payload.eventType === 'PROPOSE').map(e => openEnvelope(e, f.owner) as any);
  expect(new Set(proposed.map(p => p.proposal.payload.taskId)).size).toBe(3);
  expect(proposed.map(p => p.input)).toEqual([task.input, task.input, task.input]);
  await expect(restarted.resubmit(original.id, async () => undefined)).rejects.toThrow('PENDING_ALREADY_RESOLVED');
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it('MCP lists local observations and resubmits through current outbound and form approval checks', async () => {
  const f = fixture();
  const factory = vi.fn(() => f.relay);
  const opts = { owner: f.requester, relay: url, transportFactory: factory };
  const server = new AcpMcpServer(opts);
  const held = await f.run(() => call(server, 'acp_delegate_task', { ...task, workerDid: f.owner.did }));
  expect(held).toMatchObject({ error: 'PENDING_OWNER_APPROVAL', retryable: false, pendingId: expect.any(String) });
  const id = held.pendingId;
  const initialCount = f.frames.length;
  expect(await call(server, 'acp_list_pending_requests')).toMatchObject({ requests: [{ id, state: 'pending' }] });
  expect(f.frames).toHaveLength(initialCount);
  f.intake.decide(f.intake.list()[0].id, 'approve', 'trusted');
  factory.mockClear();
  const blockedWorker = new AcpMcpServer({ ...opts, allowedWorkerDids: [] });
  expect(await call(blockedWorker, 'acp_resubmit_pending_request', { pendingId: id })).toMatchObject({ error: 'MCP_WORKER_NOT_ALLOWED' });
  const blockedRelay = new AcpMcpServer({ ...opts, allowedRelayUrls: ['https://other.example'] });
  expect(await call(blockedRelay, 'acp_resubmit_pending_request', { pendingId: id })).toMatchObject({ error: 'MCP_RELAY_NOT_ALLOWED' });
  const form = new AcpMcpServer({ ...opts, requireInteractiveApproval: true });
  expect(await call(form, 'acp_resubmit_pending_request', { pendingId: id })).toMatchObject({ error: expect.stringContaining('APPROVAL_CHANNEL_UNAVAILABLE') });
  expect(factory).not.toHaveBeenCalled(); expect(f.frames).toHaveLength(initialCount); expect(f.execute).not.toHaveBeenCalled();
  const result = await f.run(() => call(new AcpMcpServer(opts), 'acp_resubmit_pending_request', { pendingId: id }));
  expect(result).toMatchObject({ status: 'SETTLED', deliverable: task.input });
  expect(result.taskId).not.toBe(held.originalTaskId);
  expect(f.pending.list()[0]).toMatchObject({ id, state: 'resolved', attempts: 5 });
  expect(await call(server, 'acp_resubmit_pending_request', {})).toHaveProperty('rpcError');
  expect(await call(server, 'acp_list_pending_requests', { unexpected: true })).toHaveProperty('rpcError');
});
it('CLI records and resubmits with the same requester identity and fresh output paths', async () => {
  const f = fixture(), output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const application = { transportFactory: () => f.relay };
  const held = await f.run(() => networkCommand('delegate', ['--to', f.owner.did, '--title', task.title,
    '--description', task.description, '--input', JSON.stringify(task.input), '--auto-approve'], application)).catch(e => e);
  expect(held).toMatchObject({ code: 'PENDING_OWNER_APPROVAL', pendingId: expect.any(String) });
  await pendingCommand(['list'], application);
  expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toMatchObject({ requests: [{ id: held.pendingId }] });
  f.intake.decide(f.intake.list()[0].id, 'approve', 'trusted');
  const out = join(root, 'result.json'), audit = join(root, 'resubmitted.jsonl');
  await f.run(() => pendingCommand(['resubmit', held.pendingId, '--auto-approve', '--out', out, '--audit', audit], application));
  expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual(task.input);
  expect(fs.readFileSync(audit, 'utf8')).toContain('SETTLED');
  expect(f.pending.list()[0]).toMatchObject({ state: 'resolved', attempts: 2 });
  await pendingCommand(['remove', held.pendingId]); expect(f.pending.list()).toEqual([]);
  await pendingCommand(['--help']);
  expect(output).toHaveBeenLastCalledWith(expect.stringContaining('pending list'));
});
it('store summaries omit content and invitation material, and files follow private conventions', async () => {
  const f = fixture(), token = f.worker.invite();
  const manifest = buildTaskManifest({ ownerDid: f.requester.did, workerDid: f.owner.did, ...task });
  const id = f.pending.save({ to: token, relayUrl: url, manifest, input: task.input, timeouts: {} });
  const summary = JSON.stringify(f.pending.list());
  expect(summary).not.toContain(token); expect(summary).not.toContain('retainedInput'); expect(summary).not.toContain('Return JSON');
  const listed = await call(new AcpMcpServer({ owner: f.requester }), 'acp_list_pending_requests');
  expect(JSON.stringify(listed)).not.toContain('acp-invite:');
  expect(JSON.stringify(listed)).not.toContain('privateKey');
  expect(JSON.stringify(listed)).not.toContain('retainedInput');
  if (process.platform !== 'win32') {
    expect(fs.statSync(f.pending.path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dirname(f.pending.path)).mode & 0o777).toBe(0o700);
  }
  await f.pending.resubmit(id, async request => { expect(request.to).toBe(token); });
});
it('expires without renewing retention, bounds records and bytes, and removes locally', async () => {
  const owner = generateKeyPair(), worker = generateKeyPair(); let now = Date.now();
  const store = new RequesterPendingStore(owner, { now: () => now });
  const request = { to: worker.did, relayUrl: url,
    manifest: buildTaskManifest({ ownerDid: owner.did, workerDid: worker.did, ...task }), input: task.input, timeouts: {} };
  const id = store.save(request), expiry = store.list()[0].expiresAt;
  now += 1000;
  await expect(store.resubmit(id, async () => { throw Object.assign(new Error('PENDING_OWNER_APPROVAL'), { code: 'PENDING_OWNER_APPROVAL' }); })).rejects.toThrow('PENDING_OWNER_APPROVAL');
  expect(store.list()[0]).toMatchObject({ expiresAt: expiry, lastChecked: now, attempts: 2 });
  for (let i = 1; i < 100; i++) store.save(request);
  expect(() => store.save(request)).toThrow('PENDING_STORE_FULL');
  store.remove(id); expect(store.list()).toHaveLength(99);
  expect(() => store.save({ ...request, input: 'x'.repeat(256 * 1024) })).toThrow('PENDING_STORE_FULL');
  const bytes = fs.readFileSync(store.path, 'utf8'); now = expiry + 1001;
  expect(store.list().every(r => r.state === 'expired')).toBe(true);
  expect(fs.readFileSync(store.path, 'utf8')).toBe(bytes);
  const expired = store.list()[0].id;
  await expect(store.resubmit(expired, async () => undefined)).rejects.toThrow('PENDING_EXPIRED');
  store.save(request); expect(store.list()).toHaveLength(1);
});
it('serializes mutations, retains earlier data on publication failure and rejects changed files', async () => {
  const f = fixture(); await f.run(() => f.client.delegate({ ...task, to: f.owner.did })).catch(() => undefined);
  const id = f.pending.list()[0].id, bytes = fs.readFileSync(f.pending.path, 'utf8');
  fs.writeFileSync(f.pending.path + '.lock', '', { mode: 0o600 });
  expect(() => f.pending.remove(id)).toThrow('PENDING_STORE_BUSY'); fs.unlinkSync(f.pending.path + '.lock');
  const broken = new RequesterPendingStore(f.requester, { fs: { ...fs, renameSync: () => { throw new Error('injected'); } } });
  expect(() => broken.remove(id)).toThrow('PENDING_STORE_UNWRITABLE');
  expect(fs.readFileSync(f.pending.path, 'utf8')).toBe(bytes);
  expect(fs.existsSync(f.pending.path + '.lock')).toBe(false);
  expect(fs.readdirSync(dirname(f.pending.path)).filter(p => p.endsWith('.tmp'))).toEqual([]);
  await f.pending.resubmit(id, async () => {
    await expect(new RequesterPendingStore(f.requester).resubmit(id, async () => undefined)).rejects.toThrow('PENDING_STORE_BUSY');
    expect(() => f.pending.remove(id)).toThrow('PENDING_STORE_BUSY');
  });
  if (process.platform !== 'win32') {
    fs.chmodSync(f.pending.path, 0o644); expect(() => f.pending.list()).toThrow('PENDING_STORE_INVALID'); fs.chmodSync(f.pending.path, 0o600);
  }
  fs.writeFileSync(f.pending.path, '{}'); expect(() => f.pending.list()).toThrow('PENDING_STORE_INVALID');
});
it('keeps denied and other terminal observations locally without another automatic attempt', async () => {
  const f = fixture(); await f.run(() => f.client.delegate({ ...task, to: f.owner.did })).catch(() => undefined);
  const id = f.pending.list()[0].id, run = vi.fn(async () => { throw Object.assign(new Error('REQUEST_DENIED'), { code: 'REQUEST_DENIED' }); });
  await expect(f.pending.resubmit(id, run)).rejects.toThrow('REQUEST_DENIED');
  expect(f.pending.list()[0]).toMatchObject({ state: 'failed', attempts: 2, lastError: 'REQUEST_DENIED' });
  expect(run).toHaveBeenCalledOnce(); expect(f.execute).not.toHaveBeenCalled();
});
it('preserves default data-root precedence, legacy keys and opt-in library persistence', async () => {
  const owner = generateKeyPair(), legacy = join(root, '.acp'); fs.mkdirSync(legacy, { mode: 0o700 });
  const keyPath = join(legacy, 'requester.private.json'); fs.writeFileSync(keyPath, JSON.stringify(owner), { mode: 0o600 });
  const identityOptions = { env: { ACP_DATA_DIR: join(root, 'old-root') }, home: root };
  expect(resolveOrCreateIdentity('requester', identityOptions).did).toBe(owner.did);
  expect(requesterPendingPath(owner.did, identityOptions)).toContain(join(root, 'old-root', 'requesters'));
  expect(resolveDataRoot({ ...identityOptions, env: { ...identityOptions.env, SEALBRIDGE_DATA_DIR: root } })).toBe(root);
  expect(fs.existsSync(join(root, 'old-root', 'identities'))).toBe(false);
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await pendingCommand(['list'], { identityOptions: { env: { SEALBRIDGE_DATA_DIR: join(root, 'empty') }, home: join(root, 'empty-home') } });
  expect(output).toHaveBeenLastCalledWith('{"requests":[]}'); expect(fs.existsSync(join(root, 'empty'))).toBe(false);
  expect(await call(new AcpMcpServer({ identityOptions: { env: { SEALBRIDGE_DATA_DIR: join(root, 'empty') }, home: join(root, 'empty-home') } }), 'acp_list_pending_requests')).toMatchObject({ requests: [] });
  expect(fs.existsSync(join(root, 'empty'))).toBe(false);
  const f = fixture(), client = new RequesterClient({ owner: f.requester, relay: f.relay, timeoutMs: 2000 });
  await expect(f.run(() => client.delegate({ ...task, to: f.owner.did }))).rejects.toMatchObject({ code: 'PENDING_OWNER_APPROVAL', retryable: false });
  expect(fs.existsSync(f.pending.path)).toBe(false);
});

it('MCP resubmission requires new outbound and final host forms for the fresh task', async () => {
  const f = fixture();
  await f.run(() => f.client.delegate({ ...task, to: f.owner.did })).catch(() => undefined);
  const record = f.pending.list()[0]; f.intake.decide(f.intake.list()[0].id, 'approve', 'trusted');
  const h = harness({ owner: f.requester, relay: url, transportFactory: () => f.relay, requireInteractiveApproval: true });
  try {
    await initialize(h, { elicitation: { form: {} } });
    const frameCount = f.frames.length;
    h.send(toolCall('resubmit', { pendingId: record.id }, 'acp_resubmit_pending_request'));
    const outbound = await form(h);
    expect(outbound.params.message).toContain('external_side_effect');
    expect(outbound.params.message).not.toContain('acp-invite:');
    expect(f.frames).toHaveLength(frameCount); expect(f.execute).not.toHaveBeenCalled();
    const done = f.worker.start({ once: true });
    try {
      h.send({ jsonrpc: '2.0', id: outbound.id, result: { action: 'accept', content: { approved: true } } });
      const final = await form(h, 1);
      expect(final.params.message).toContain('final_verification');
      h.send({ jsonrpc: '2.0', id: final.id, result: { action: 'accept', content: { approved: true } } });
      const result = body(await h.next(m => m.id === 'resubmit'));
      expect(result).toMatchObject({ status: 'SETTLED', deliverable: task.input });
      expect(result.taskId).not.toBe(record.originalTaskId);
      await done;
    } finally { f.worker.stop(); await done.catch(() => undefined); }
    expect(f.pending.list()[0]).toMatchObject({ state: 'resolved', attempts: 2 });
  } finally { await h.close(); }
});
it('reports local persistence errors while retaining the existing pending error contract', async () => {
  const f = fixture();
  const failing = new RequesterPendingStore(f.requester, { fs: { ...fs, renameSync: () => { throw new Error('injected'); } } });
  f.client.options.pendingStore = failing;
  const error = await f.run(() => f.client.delegate({ ...task, to: f.owner.did })).catch(e => e);
  expect(error).toMatchObject({ code: 'PENDING_OWNER_APPROVAL', retryable: false, pendingStoreError: 'PENDING_STORE_UNWRITABLE' });
  expect(f.pending.list()).toEqual([]); expect(f.execute).not.toHaveBeenCalled();
  expect(JSON.parse(formatCliError(error))).toMatchObject({ error: 'PENDING_OWNER_APPROVAL', retryable: false,
    pendingStoreError: 'PENDING_STORE_UNWRITABLE' });
});
it('rejects retained invite expiry without sending a task and does not expose the invitation', async () => {
  const f = fixture(); let now = Date.now();
  const pending = new RequesterPendingStore(f.requester, { now: () => now });
  const token = f.worker.invite(1);
  const manifest = buildTaskManifest({ ownerDid: f.requester.did, workerDid: f.owner.did, ...task });
  const id = pending.save({ to: token, relayUrl: url, manifest, input: task.input, timeouts: {} });
  now += 2000; vi.spyOn(Date, 'now').mockReturnValue(now);
  const server = new AcpMcpServer({ owner: f.requester, relay: url, transportFactory: () => f.relay });
  const result = await call(server, 'acp_resubmit_pending_request', { pendingId: id });
  expect(result).toMatchObject({ error: 'INVITE_EXPIRED', isError: true });
  expect(JSON.stringify(result)).not.toContain(token); expect(f.frames).toEqual([]);
  expect(pending.list()[0]).toMatchObject({ state: 'failed', lastError: 'INVITE_EXPIRED' });
});

it('keeps a completed CLI resubmission resolved when its requested output file already exists', async () => {
  const f = fixture(), application = { transportFactory: () => f.relay };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await f.run(() => networkCommand('delegate', ['--to', f.owner.did, '--title', task.title,
    '--description', task.description, '--input', JSON.stringify(task.input), '--auto-approve'], application)).catch(() => undefined);
  const id = f.pending.list()[0].id; f.intake.decide(f.intake.list()[0].id, 'approve', 'trusted');
  const out = join(root, 'existing.json'); fs.writeFileSync(out, 'previous');
  await expect(f.run(() => pendingCommand(['resubmit', id, '--auto-approve', '--out', out], application))).rejects.toMatchObject({ code: 'EEXIST' });
  expect(fs.readFileSync(out, 'utf8')).toBe('previous');
  expect(f.pending.list()[0]).toMatchObject({ state: 'resolved', attempts: 2 });
  expect(f.execute).toHaveBeenCalledOnce();
});
it('checks store ownership, signatures, file types and byte bounds before using a record', async () => {
  const f = fixture(); await f.run(() => f.client.delegate({ ...task, to: f.owner.did })).catch(() => undefined);
  const bytes = fs.readFileSync(f.pending.path, 'utf8');
  const other = new RequesterPendingStore(generateKeyPair()); fs.mkdirSync(dirname(other.path), { recursive: true, mode: 0o700 });
  fs.writeFileSync(other.path, bytes, { mode: 0o600 }); expect(() => other.list()).toThrow('PENDING_STORE_INVALID');
  fs.writeFileSync(f.pending.path, 'x'.repeat(4 * 1024 * 1024 + 1));
  expect(() => f.pending.list()).toThrow('PENDING_STORE_INVALID');
  fs.unlinkSync(f.pending.path); fs.mkdirSync(f.pending.path, { mode: 0o700 });
  expect(() => f.pending.list()).toThrow('PENDING_STORE_INVALID'); fs.rmdirSync(f.pending.path);
  if (process.platform !== 'win32') {
    fs.symlinkSync(other.path, f.pending.path); expect(() => f.pending.list()).toThrow('PENDING_STORE_INVALID');
    expect(() => f.pending.remove('unused')).toThrow('PENDING_STORE_INVALID');
    expect(fs.readFileSync(other.path, 'utf8')).toBe(bytes);
  }
});
it('uses an explicitly selected requester key without changing the default identity or its records', async () => {
  const f = fixture(), explicit = generateKeyPair(), keyFile = join(root, 'selected.private.json');
  fs.writeFileSync(keyFile, JSON.stringify(explicit), { mode: 0o600 });
  const manifest = buildTaskManifest({ ownerDid: explicit.did, workerDid: f.owner.did, ...task });
  const selected = new RequesterPendingStore(explicit);
  const id = selected.save({ to: f.owner.did, relayUrl: url, manifest, input: task.input, timeouts: {} });
  f.intake.enqueue(manifest, task.input); f.intake.decide(f.intake.list()[0].id, 'approve', 'trusted');
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await pendingCommand(['list', '--key', keyFile]);
  expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toMatchObject({ requests: [{ id }] });
  await pendingCommand(['list']); expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toEqual({ requests: [] });
  await f.run(() => pendingCommand(['resubmit', id, '--key', keyFile, '--auto-approve'], { transportFactory: () => f.relay }));
  expect(selected.list()[0]).toMatchObject({ state: 'resolved' }); expect(f.pending.list()).toEqual([]);
  expect(resolveOrCreateIdentity('requester').did).toBe(f.requester.did);
});

// Simulate a worker that holds an invited proposal at its intake gate.
async function heldAlias(useAlias = false) {
  const f = fixture(), invites = new InviteStore(f.requester), token = f.worker.invite(60);
  const saved = invites.import(token, 'reviewer');
  const opts = { owner: f.requester, relay: url, transportFactory: vi.fn(() => f.relay) };
  const server = new AcpMcpServer(opts);
  const gate = vi.spyOn(f.intake, 'pendingTask').mockReturnValue(true);
  const held = await f.run(() => call(server, 'acp_delegate_task', {
    ...task, workerRef: useAlias ? 'reviewer' : saved.workerRef,
  }));
  gate.mockRestore();
  f.intake.decide(f.intake.list()[0].id, 'approve', 'trusted');
  expect(held).toMatchObject({ error: 'PENDING_OWNER_APPROVAL', pendingId: expect.any(String) });
  return { ...f, invites, token, saved, opts, server, held };
}
it.each([false, true])('retains a saved reference without copying its token and resolves it on MCP resubmission (alias: %s)', async useAlias => {
  const f = await heldAlias(useAlias);
  const stored = JSON.parse(fs.readFileSync(f.pending.path, 'utf8')).payload.records[0].request;
  expect(stored.workerRef).toBe(useAlias ? 'reviewer' : f.saved.workerRef);
  expect(stored).not.toHaveProperty('to');
  expect(JSON.stringify(stored)).not.toContain(f.token);
  const listed = await call(f.server, 'acp_list_pending_requests');
  expect(JSON.stringify([f.held, listed])).not.toContain('acp-invite:');
  const result = await f.run(() => call(new AcpMcpServer(f.opts), 'acp_resubmit_pending_request', { pendingId: f.held.pendingId }));
  expect(result).toMatchObject({ status: 'SETTLED', deliverable: task.input });
  expect(result.taskId).not.toBe(f.held.originalTaskId);
  expect(JSON.stringify(result)).not.toContain(f.token);
  expect(f.pending.list()).toMatchObject([{ state: 'resolved', attempts: 2 }]);
  expect(f.execute).toHaveBeenCalledOnce();
});
it.each(['removed', 'expired', 'revoked', 'worker-policy', 'relay-policy', 'approval'])(
  'rechecks a pending saved reference before transmission: %s', async mode => {
    const f = await heldAlias();
    const options = { ...f.opts };
    const server = new AcpMcpServer({ ...options,
      ...(mode === 'worker-policy' ? { allowedWorkerDids: [] } : {}),
      ...(mode === 'relay-policy' ? { allowedRelayUrls: [] } : {}),
      ...(mode === 'approval' ? { requireInteractiveApproval: true } : {}),
    });
    if (mode === 'removed') f.invites.remove(f.saved.workerRef);
    if (mode === 'expired') vi.setSystemTime(Date.now() + 60_000);
    if (mode === 'revoked') server.revocation.revoke(createRevocationNotice({
      targetType: 'invite', targetId: digest(parseAndVerifyInviteToken(f.token)), reason: 'Replaced',
    }, f.owner));
    const expected = { removed: 'INVITE_NOT_FOUND', expired: 'INVITE_EXPIRED', revoked: 'TOKEN_REVOKED',
      'worker-policy': 'MCP_WORKER_NOT_ALLOWED', 'relay-policy': 'MCP_RELAY_NOT_ALLOWED',
      approval: 'APPROVAL_CHANNEL_UNAVAILABLE' }[mode];
    f.opts.transportFactory.mockClear();
    const count = f.frames.length;
    const result = await call(server, 'acp_resubmit_pending_request', { pendingId: f.held.pendingId });
    expect(result).toMatchObject({ error: expect.stringContaining(expected!), isError: true });
    expect(JSON.stringify(result)).not.toContain('acp-invite:');
    expect(f.opts.transportFactory).not.toHaveBeenCalled();
    expect(f.frames).toHaveLength(count); expect(f.execute).not.toHaveBeenCalled();
    expect(f.pending.list()).toMatchObject([{ state: 'failed', attempts: 2 }]);
  });
it('resolves an MCP-retained workerRef during CLI resubmission and fails locally when removed', async () => {
  const f = await heldAlias(true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  f.invites.remove('reviewer');
  await expect(pendingCommand(['resubmit', f.held.pendingId, '--auto-approve'], f.opts)).rejects.toThrow('INVITE_NOT_FOUND');
  expect(f.execute).not.toHaveBeenCalled();
  f.invites.import(f.token, 'reviewer');
  await f.run(() => pendingCommand(['resubmit', f.held.pendingId, '--auto-approve'], f.opts));
  expect(f.pending.list()).toMatchObject([{ state: 'resolved', attempts: 3 }]);
  expect(f.execute).toHaveBeenCalledOnce();
});
