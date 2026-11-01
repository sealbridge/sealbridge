// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPair, digest, signEnvelope, signPayload, createRevocationNotice,
  RevocationRegistry, openEnvelope } from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { WorkerNode, RequesterClient, PolicyAutoApprovalProvider, WorkerTrustStore, buildTaskManifest,
  AcpMcpServer } from '../packages/runtime/src/index.js';
import type { WorkerNodeOptions } from '../packages/runtime/src/index.js';
import type { SignedEnvelope } from '../packages/core/src/index.js';
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'sealbridge-intake-'));
  vi.stubEnv('SEALBRIDGE_DATA_DIR', root); vi.stubEnv('ACP_DATA_DIR', root);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const task = { title: 'Review\u001b[31m', description: 'Review request', input: { privateTaskText: 'do not store in intake' } };
function fixture(options: Partial<WorkerNodeOptions> = {}) {
  const owner = generateKeyPair(), requester = generateKeyPair(), relay = new InMemoryRelay();
  const frames: SignedEnvelope[] = [], send = relay.send.bind(relay);
  relay.send = e => { frames.push(e); return send(e); };
  const adapter = { id: 'echo', name: 'Echo', skills: [], executeTask: vi.fn(async ctx => ctx.input) };
  const provider = new PolicyAutoApprovalProvider(owner);
  const approve = vi.spyOn(provider, 'approve');
  const store = new WorkerTrustStore(owner);
  const worker = new WorkerNode({ owner, relay, adapter, accessMode: 'open', timeoutMs: 1000,
    approvalProvider: provider, intakeStore: store, ...options });
  const client = new RequesterClient({ owner: requester, relay, timeoutMs: 1000,
    approvalProvider: new PolicyAutoApprovalProvider(requester) });
  async function attempt(to = owner.did) {
    return Promise.allSettled([client.delegate({ ...task, to }), worker.start({ once: true })]);
  }
  return { owner, requester, relay, frames, adapter, approve, store, worker, client, attempt };
}
it('quarantines validated unknown input without ACCEPT, adapter, inbox, or receive hook', async () => {
  const inbox = join(root, 'inbox.jsonl'), hook = vi.fn();
  const f = fixture({ inboxPath: inbox, onInboxRecord: hook });
  const results = await f.attempt();
  expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'PENDING_OWNER_APPROVAL' } });
  expect(results[1]).toMatchObject({ status: 'rejected', reason: { message: 'PENDING_OWNER_APPROVAL' } });
  expect(f.adapter.executeTask).not.toHaveBeenCalled(); expect(f.approve).not.toHaveBeenCalled();
  expect(hook).not.toHaveBeenCalled(); expect(existsSync(inbox)).toBe(false);
  expect(f.store.list()).toHaveLength(1);
  expect(JSON.stringify(f.store.list())).not.toContain('privateTaskText');
  expect(f.store.list()[0].title).toContain('\\u001b');
  const outgoing = f.frames.filter(e => e.payload.senderDid === f.owner.did);
  expect(outgoing.map(e => e.payload.eventType)).toEqual(['ERROR']);
  expect(openEnvelope(outgoing[0], f.requester)).toMatchObject({ code: 'PENDING_OWNER_APPROVAL',
    reason: expect.stringContaining('Do not retry automatically') });
  const checkpoint = readFileSync(inbox + '.tasks.jsonl', 'utf8');
  expect(checkpoint).toContain('PENDING_OWNER_APPROVAL'); expect(checkpoint).not.toContain('SETTLED');
  // The transient slot was released. A new attempt deduplicates the active peer request.
  await f.attempt(); expect(f.store.list()).toHaveLength(1);
});
it('requires a separate owner channel for limited LLM peers, even with automatic policy', async () => {
  const f = fixture({ adapterKind: 'llm', automaticApproval: true });
  const results = await f.attempt(f.worker.invite());
  expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'APPROVAL_CHANNEL_UNAVAILABLE' } });
  expect(f.approve).not.toHaveBeenCalled(); expect(f.adapter.executeTask).not.toHaveBeenCalled();
  const ownerDecision = new PolicyAutoApprovalProvider(f.owner), reviewed = vi.spyOn(ownerDecision, 'approve');
  f.worker.options.ownerApprovalProvider = ownerDecision;
  expect((await f.attempt(f.worker.invite()))[0]).toMatchObject({ status: 'fulfilled', value: { state: 'SETTLED' } });
  expect(reviewed).toHaveBeenCalledOnce(); expect(f.approve).not.toHaveBeenCalled();
});
it.each(['limited', 'trusted'] as const)('admits a fresh tokenless task with a %s grant; never replays the queued task', async trust => {
  const f = fixture({ adapterKind: 'llm', automaticApproval: true });
  await f.attempt(); const request = f.store.list()[0];
  f.store.decide(request.id, 'approve', trust);
  if (trust === 'limited') f.worker.options.ownerApprovalProvider = new PolicyAutoApprovalProvider(f.owner);
  expect(f.adapter.executeTask).not.toHaveBeenCalled();
  expect((await f.attempt())[0]).toMatchObject({ status: 'fulfilled', value: { state: 'SETTLED' } });
  expect(f.adapter.executeTask).toHaveBeenCalledOnce();
  expect(f.approve).toHaveBeenCalledTimes(trust === 'trusted' ? 1 : 0);
  f.store.decide(request.id, 'deny');
  const count = f.frames.filter(e => e.payload.senderDid === f.owner.did).length;
  const m = buildTaskManifest({ ownerDid: f.requester.did, workerDid: f.owner.did, title: 'Denied', description: 'Denied' });
  f.relay.send(signEnvelope({ taskId: m.taskId, recipientDid: f.owner.did, seq: 0, eventType: 'PROPOSE',
    payload: { proposal: signPayload(m, f.requester), input: {}, capabilityChains: [] } as never }, f.requester, { encrypt: true }));
  await f.worker.runOnce().catch(() => undefined);
  expect(f.frames.filter(e => e.payload.senderDid === f.owner.did)).toHaveLength(count);
});
it.each(['allow', 'any'] as const)('preserves explicit %s elevation and automatic acceptance', async kind => {
  const f = fixture({ adapterKind: 'llm', automaticApproval: true });
  if (kind === 'any') f.worker.acceptance.allowAnyRequester = true;
  else f.worker.acceptance.allowedRequesterDids = [f.requester.did];
  expect((await f.attempt())[0]).toMatchObject({ status: 'fulfilled', value: { state: 'SETTLED' } });
  expect(f.store.list()).toEqual([]);
});
it('keeps invite-only and explicit requester exclusions outside the pending queue', async () => {
  for (const options of [{ accessMode: 'invite-only' as const }, { allowedRequesterDids: ['did:key:other'] }]) {
    const f = fixture(options);
    const results = await f.attempt();
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: options.accessMode ? 'INVITE_REQUIRED' : 'PROPOSAL_REJECTED' } });
    expect(f.store.list()).toEqual([]);
  }
});
it('checks expired invite revocations before open fallback', async () => {
  const registry = new RevocationRegistry(), f = fixture({ revocation: registry });
  const token = f.worker.invite(1), realNow = Date.now();
  registry.revoke(createRevocationNotice({ targetType: 'invite', targetId: token, reason: 'owner decision' }, f.owner));
  vi.spyOn(Date, 'now').mockReturnValue(realNow + 2000);
  // Raw proposal bypasses requester-side expired-invite validation.
  const m = buildTaskManifest({ ownerDid: f.requester.did, workerDid: f.owner.did, title: 'Expired', description: 'Expired' });
  f.relay.send(signEnvelope({ taskId: m.taskId, recipientDid: f.owner.did, seq: 0, eventType: 'PROPOSE',
    payload: { proposal: signPayload(m, f.requester), input: {}, capabilityChains: [], inviteToken: token } as never }, f.requester, { encrypt: true }));
  await expect(f.worker.runOnce()).rejects.toThrow('TOKEN_REVOKED'); expect(f.store.list()).toEqual([]);
});
it('drops excluded peers without any outgoing worker frame, including recovery', async () => {
  const f = fixture({ allowedPeerDids: [], allowAnyRequester: true, inboxPath: join(root, 'inbox') });
  const m = buildTaskManifest({ ownerDid: f.requester.did, workerDid: f.owner.did, title: 'Excluded', description: 'Excluded' });
  f.relay.send(signEnvelope({ taskId: m.taskId, recipientDid: f.owner.did, seq: 0, eventType: 'PROPOSE',
    payload: { proposal: signPayload(m, f.requester), input: {}, capabilityChains: [] } as never }, f.requester, { encrypt: true }));
  await f.worker.runOnce().catch(() => undefined);
  expect(f.frames.filter(e => e.payload.senderDid === f.owner.did)).toEqual([]);
  expect(f.store.list()).toEqual([]); expect(f.adapter.executeTask).not.toHaveBeenCalled();
});
it('reports exact terminal pending status through MCP without retrying', async () => {
  const f = fixture(); await f.worker.register();
  const server = new AcpMcpServer({ owner: f.requester, relay: f.relay,
    approvalProvider: new PolicyAutoApprovalProvider(f.requester) });
  const done = f.worker.start({ once: true }).catch(() => undefined);
  const result = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'acp_delegate_task', arguments: { workerDid: f.owner.did, title: 'Review', description: 'Review', input: {} } } });
  await done;
  const response = result as { result: { isError: boolean; content: Array<{ text: string }> } };
  expect(response.result.isError).toBe(true);
  expect(JSON.parse(response.result.content[0].text)).toMatchObject({ error: 'PENDING_OWNER_APPROVAL', retryable: false, pendingId: expect.any(String), nextStep: expect.stringContaining('pending resubmit') });
  expect(f.frames.filter(e => e.payload.eventType === 'PROPOSE')).toHaveLength(1);
});
it('rereads a denial before progress or delivery from an already running adapter', async () => {
  const f = fixture(); await f.attempt(); const id = f.store.list()[0].id;
  f.store.decide(id, 'approve', 'trusted');
  f.adapter.executeTask.mockImplementationOnce(async ctx => {
    f.store.decide(id, 'deny');
    await ctx.reportProgress?.({ step: 'after owner decision' });
    return ctx.input;
  });
  const prior = f.frames.length;
  const results = await f.attempt();
  expect(results[0].status).toBe('rejected');
  const sent = f.frames.slice(prior).filter(e => e.payload.senderDid === f.owner.did);
  expect(sent.some(e => ['PROGRESS', 'DELIVER', 'ERROR'].includes(e.payload.eventType))).toBe(false);
});
it('reconciles a queue-backed received checkpoint to terminal pending after restart', async () => {
  const f = fixture({ inboxPath: join(root, 'recovery') }); await f.attempt();
  const { TaskJournal } = await import('../packages/runtime/src/task-journal.js');
  const journal = new TaskJournal(join(root, 'recovery.tasks.jsonl'), f.owner); journal.load();
  const checkpoint = [...journal.tasks.values()][0];
  journal.save({ ...checkpoint, phase: 'received', outcome: undefined, notificationPending: undefined });
  const events: string[] = [];
  const restarted = new WorkerNode({ ...f.worker.options, onEvent: event => events.push(event) });
  const controller = new AbortController(); controller.abort();
  await restarted.start({ signal: controller.signal });
  const reloaded = new TaskJournal(join(root, 'recovery.tasks.jsonl'), f.owner); reloaded.load();
  expect(reloaded.tasks.get(checkpoint.taskId)).toMatchObject({ phase: 'terminal', outcome: { code: 'PENDING_OWNER_APPROVAL' } });
  expect(events).not.toContain('ACCEPT'); expect(events).not.toContain('INTERRUPTED');
  expect(f.adapter.executeTask).not.toHaveBeenCalled();
});
it('does not acknowledge a proposal or execute when durable intake publication fails', async () => {
  const f = fixture();
  f.worker.options.intakeStore = f.store;
  vi.spyOn(f.store, 'enqueue').mockImplementation(() => { throw new Error('INTAKE_STORE_UNWRITABLE'); });
  const results = await f.attempt();
  expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'INTAKE_STORE_UNWRITABLE' } });
  expect(f.store.list()).toEqual([]); expect(f.approve).not.toHaveBeenCalled();
  expect(f.frames.filter(e => e.payload.senderDid === f.owner.did).map(e => e.payload.eventType)).toEqual(['ERROR']);
});
it('requires fresh task IDs after admission, including when input or digest changes', async () => {
  const f = fixture();
  const manifest = buildTaskManifest({ ownerDid: f.requester.did, workerDid: f.owner.did, title: 'Original', description: 'Original' });
  const attempt = () => Promise.allSettled([f.client.delegate({ ...task, to: f.owner.did, manifest }), f.worker.start({ once: true })]);
  await attempt(); f.store.decide(f.store.list()[0].id, 'approve', 'trusted');
  manifest.task.description = 'Changed proposal with the same task ID';
  const result = await attempt();
  expect(result[0]).toMatchObject({ status: 'rejected', reason: { code: 'PENDING_OWNER_APPROVAL' } });
  expect(f.adapter.executeTask).not.toHaveBeenCalled();
});
it('recognizes a newly allowed contact and rereads a later contact revocation', async () => {
  let allowed = false;
  const f = fixture({ adapterKind: 'llm', automaticApproval: true, checkPeer: () => allowed ? 'trusted' : undefined });
  allowed = true;
  expect((await f.attempt(f.worker.invite()))[0]).toMatchObject({ status: 'fulfilled', value: { state: 'SETTLED' } });
  expect(f.approve).toHaveBeenCalledOnce(); expect(f.store.list()).toEqual([]);
  f.worker.options.checkPeer = () => { throw new Error('CONTACT_REVOKED'); };
  const prior = f.frames.length;
  const m = buildTaskManifest({ ownerDid: f.requester.did, workerDid: f.owner.did, title: 'Revoked', description: 'Revoked' });
  f.relay.send(signEnvelope({ taskId: m.taskId, recipientDid: f.owner.did, seq: 0, eventType: 'PROPOSE',
    payload: { proposal: signPayload(m, f.requester), input: {}, capabilityChains: [] } as never }, f.requester, { encrypt: true }));
  await expect(f.worker.runOnce()).rejects.toThrow('CONTACT_REVOKED');
  expect(f.frames.slice(prior).filter(e => e.payload.senderDid === f.owner.did)).toEqual([]);
});
