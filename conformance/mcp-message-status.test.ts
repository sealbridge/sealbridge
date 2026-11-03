// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { digest, generateKeyPair, openEnvelope, signApproval, signEnvelope } from '../packages/core/src/index.js';
import type { SignedDeliveryStatus } from '../packages/core/src/index.js';
import { AcpMcpServer, DELIVERY_RETENTION_MS, IdempotencyStore, RecipientDeliveryCoordinator,
  RequesterPendingStore } from '../packages/runtime/src/index.js';
import type { AcpMcpServerOptions, MessageStatusResult } from '../packages/runtime/src/index.js';
import { statusFixture, statusRelayUrl } from './delivery-status-fixture.js';

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-03T00:00:00Z'));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('OFFLINE_TEST_NETWORK'); }));
});
afterEach(() => {
  try { expect(fetch).not.toHaveBeenCalled(); }
  finally { vi.restoreAllMocks(); cleanups.splice(0).forEach(f => f()); vi.unstubAllGlobals(); vi.useRealTimers(); }
});
function fixture(inspect = true) { const f = statusFixture(inspect); cleanups.push(f.cleanup); return f; }
type Fixture = ReturnType<typeof fixture>;
function server(f: Fixture, options: Partial<AcpMcpServerOptions> = {}) {
  return new AcpMcpServer({ owner: f.sender, identityOptions: f.identityOptions, now: f.now, ...options });
}
async function call(s: AcpMcpServer, args: unknown) {
  return await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'acp_message_status', arguments: args } }) as unknown as {
      error?: { code: number }; result?: { isError: boolean; content: Array<{ text: string }>; structuredContent?: MessageStatusResult };
    };
}
async function query(s: AcpMcpServer, args: unknown) {
  const response = await call(s, args);
  expect(response.error).toBeUndefined(); expect(response.result?.isError).toBe(false);
  expect(response.result?.structuredContent).toEqual(JSON.parse(response.result!.content[0].text));
  return response.result!.structuredContent!;
}
function inventory(root: string): unknown[] {
  if (!existsSync(root)) return [];
  const visit = (path: string): unknown[] => {
    const stat = lstatSync(path);
    const info = { path: relative(root, path), mode: stat.mode, mtime: stat.mtimeMs,
      hash: stat.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : null };
    return [info, ...(stat.isDirectory() ? readdirSync(path).sort().flatMap(name => visit(join(path, name))) : [])];
  };
  return visit(root);
}
async function catalog(s: AcpMcpServer) {
  const listed = await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as unknown as {
    result: { tools: Array<{ name: string; inputSchema: object; outputSchema: object; annotations: object }> };
  };
  const matches = listed.result.tools.filter(t => t.name === 'acp_message_status');
  expect(matches).toHaveLength(1); return matches[0];
}

it('lists exactly one status tool with exclusive selectors, exact result shapes and local read hints', async () => {
  const f = fixture(), s = server(f), tool = await catalog(s);
  expect(tool.annotations).toEqual({ title: 'Read local message status', readOnlyHint: true,
    destructiveHint: false, idempotentHint: true, openWorldHint: false });
  const ajv = new Ajv2020({ strict: false }), input = ajv.compile(tool.inputSchema), output = ajv.compile(tool.outputSchema);
  const p = f.enqueue();
  for (const args of [{ messageId: p.messageId }, { taskId: p.manifest.taskId }]) expect(input(args)).toBe(true);
  for (const args of [{}, { messageId: p.messageId, taskId: p.manifest.taskId }, { messageId: 'bad' },
    { taskId: '' }, { taskId: 'x', ownerDid: f.sender.did }, { taskId: 'x', path: f.root }]) {
    expect(input(args)).toBe(false); expect((await call(s, args)).error).toMatchObject({ code: -32602 });
  }
  for (const args of [null, [], 'x', { messageId: 1 }, { taskId: 2 }])
    expect((await call(s, args)).error).toMatchObject({ code: -32602 });
  const value = await query(s, { messageId: p.messageId });
  expect(output(value)).toBe(true); expect(output({ found: false })).toBe(true);
  expect(output({ found: false, taskId: 'extra' })).toBe(false);
  expect(output({ ...value, input: 'extra' })).toBe(false);
  if (!value.found) throw new Error('EXPECTED_MESSAGE');
  expect(output({ ...value, retry: { ...value.retry, extra: true } })).toBe(false);
  const init = await s.handle({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} });
  expect(init).toMatchObject({ result: { instructions: expect.stringContaining('acp_message_status') } });
});

it('queries a due queued proposal and lists tools without transport, delivery startup, approval or adapter calls', async () => {
  const f = fixture(), p = f.enqueue();
  f.outgoing.store.transaction(() => {
    const r = f.outgoing.store.read('outbox', p.messageId)!;
    f.outgoing.store.write('outbox', p.messageId, { ...r, attemptCount: 3, nextAttemptAt: f.epoch - 1 });
  });
  const spies = [vi.spyOn(f.transport, 'send'), vi.spyOn(f.transport, 'receive'), vi.spyOn(f.transport, 'discover'),
    vi.spyOn(f.outgoing, 'start'), vi.spyOn(f.outgoing, 'drainDue'), vi.spyOn(f.outgoing.statusRouter, 'start')];
  const acknowledge = vi.fn(), factory = vi.fn(() => ({ ...f.transport, acknowledgeDelivery: acknowledge }));
  const approval = vi.fn();
  const s = server(f, { relay: { ...f.transport, acknowledgeDelivery: acknowledge }, transportFactory: factory,
    deliveryService: f.outgoing, deliveryOptions: { resolveTransport: factory },
    requireInteractiveApproval: true, approvalProvider: { kind: 'human', approve: approval } });
  s.stopDelivery();
  const before = inventory(f.root);
  await catalog(s); await s.handle({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} });
  for (let n = 0; n < 2; n++) {
    expect(await query(s, { messageId: p.messageId })).toMatchObject({ found: true, status: 'queued', source: 'local',
      updatedAt: f.epoch, retry: { pending: true, attemptCount: 3, nextAttemptAt: f.epoch - 1 }, recipientStatus: null });
    expect(await query(s, { taskId: p.manifest.taskId })).toMatchObject({ messageId: p.messageId });
  }
  expect(inventory(f.root)).toEqual(before);
  for (const spy of [...spies, acknowledge, factory, approval, f.human.approve, f.execute]) expect(spy).not.toHaveBeenCalled();
  expect(f.frames).toEqual([]);
});

it('reads relayed admission and reports retained proposal attempts, excluding other envelopes', async () => {
  const f = fixture(), p = f.enqueue(); await f.outgoing.sendPrepared(p.messageId);
  expect(await query(server(f), { messageId: p.messageId })).toMatchObject({ status: 'relayed', source: 'relay',
    retry: { pending: false, attemptCount: 1, nextAttemptAt: null }, recipientStatus: null });
  const audit = signEnvelope({ taskId: p.manifest.taskId, recipientDid: f.recipient.did, seq: 1,
    eventType: 'AUDIT_ENTRY', payload: {} }, f.sender, { encrypt: true });
  f.outgoing.enqueue([audit], { messageId: p.messageId, peerOwnerDid: f.recipient.did,
    relayUrl: statusRelayUrl, deliveryDeadline: Date.parse(p.manifest.deadline) });
  f.outgoing.store.transaction(() => {
    const r = f.outgoing.store.read('outbox', audit.payload.envelopeId)!;
    f.outgoing.store.write('outbox', r.envelopeId, { ...r, attemptCount: 99 });
  });
  expect(await query(server(f), { messageId: p.messageId })).toMatchObject({ retry: { attemptCount: 1 } });
  const proposal = f.outgoing.store.read('outbox', p.messageId)!;
  f.outgoing.store.transaction(() => f.outgoing.store.finishBatch(proposal.batchId));
  expect(await query(server(f), { messageId: p.messageId })).toMatchObject({ status: 'relayed',
    retry: { pending: false, attemptCount: 0, nextAttemptAt: null } });
});

it.each(['received_held', 'opened', 'handed_to_agent', 'closed'] as const)('projects verified recipient %s without exposing task content', async state => {
  const f = fixture(), p = f.enqueue(), event = f.status(p, { state });
  f.outgoing.statusRouter.receive(event.envelope);
  const s = server(f), value = await query(s, { messageId: p.messageId });
  expect(value).toMatchObject({ found: true, status: state, source: 'recipient', recipientStatus: event.signed,
    retry: { pending: false, nextAttemptAt: null } });
  const tool = await catalog(s), validate = new Ajv2020({ strict: false }).compile(tool.outputSchema);
  expect(validate(value)).toBe(true);
  for (const text of ['fixture content', 'proposalEnvelopeDigest', 'envelopeDigest', 'operationId', 'relayUrl',
    'approval', 'report', 'idempotencyKey', 'deliverable']) expect(JSON.stringify(value)).not.toContain(text);
  if (!value.found) throw new Error('EXPECTED_MESSAGE');
  expect(validate({ ...value, recipientStatus: { ...event.signed,
    payload: { ...event.signed.payload, detail: 'extra' } } })).toBe(false);
});

it('reads successive recipient revisions from another store without refreshing or changing the original message', async () => {
  const f = fixture(), p = f.enqueue(), s = server(f), states = ['received_held', 'opened', 'handed_to_agent', 'closed'] as const;
  expect(await query(s, { taskId: p.manifest.taskId })).toMatchObject({ status: 'queued', recipientStatus: null });
  for (const [index, state] of states.entries()) {
    f.setNow(f.epoch + index + 1);
    const event = f.status(p, { state, revision: index + 1 });
    f.outgoing.statusRouter.receive(event.envelope);
    const before = inventory(f.root);
    const value = await query(s, { messageId: p.messageId });
    expect(value).toMatchObject({ messageId: p.messageId, taskId: p.manifest.taskId, status: state,
      source: 'recipient', updatedAt: f.now(), recipientStatus: event.signed });
    expect(await query(s, { taskId: p.manifest.taskId })).toEqual(value);
    expect(inventory(f.root)).toEqual(before);
  }
  expect(f.frames).toEqual([]);
});

it.each(['settled', 'held'] as const)('queries the original %s keyed MCP send and updated recipient observations after cached retries', async outcome => {
  const f = fixture(outcome === 'settled');
  const approve = vi.fn(async (request: Parameters<NonNullable<AcpMcpServerOptions['approvalProvider']>['approve']>[0]) =>
    signApproval(request.taskId, request.gate, request.target, f.sender));
  const options: Partial<AcpMcpServerOptions> = { relay: statusRelayUrl, transportFactory: () => f.transport,
    deliveryService: f.outgoing, approvalProvider: { kind: 'human', approve } };
  const s = server(f, options);
  cleanups.push(() => s.stopDelivery());
  const args = { inviteToken: f.worker.invite(), title: 'Keyed message status', input: { n: 1 },
    idempotencyKey: 'status-observation' };
  const send = async (target: AcpMcpServer) => await target.handle({ jsonrpc: '2.0', id: 10, method: 'tools/call',
    params: { name: 'acp_delegate_task', arguments: args } }) as unknown as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
  const running = f.worker.start({ once: true }).catch(error => {
    expect(outcome).toBe('held'); expect(error.message).toBe('PENDING_OWNER_APPROVAL');
  });
  const [first, concurrent] = await Promise.all([send(s), send(s), running]);
  const result = JSON.parse(first.result.content[0].text);
  expect(first.result.isError).toBe(outcome === 'held');
  expect(result).toMatchObject(outcome === 'held'
    ? { error: 'PENDING_OWNER_APPROVAL', retryable: false } : { status: 'SETTLED' });
  expect(concurrent.result).toEqual(first.result);
  const proposals = () => f.frames.filter(e => e.payload.eventType === 'PROPOSE');
  expect(proposals()).toHaveLength(1);
  const original = proposals()[0], messageId = original.payload.envelopeId, taskId = original.payload.taskId;
  const records = new IdempotencyStore(f.sender, { ...f.identityOptions, now: f.now }).records;
  const operation = records.snapshot('operations')[0];
  expect(operation).toMatchObject({ phase: 'finished', messageIds: [messageId], taskIds: [taskId],
    preparedActions: [{ messageId, manifest: { taskId, protocolVersion: '0.2.0' } }] });
  expect(records.read('messages', messageId)).toMatchObject({ operationId: operation.operationId,
    proposalEnvelopeDigest: digest(original) });

  s.stopDelivery();
  const restarted = server(f, { ...options, deliveryService: undefined });
  const approvals = approve.mock.calls.length;
  const pending = new RequesterPendingStore(f.sender, f.identityOptions);
  const pendingBefore = pending.list();
  expect((await send(restarted)).result).toEqual(first.result);
  expect(await query(restarted, { taskId })).toMatchObject({ messageId, taskId,
    status: outcome === 'held' ? 'received_held' : 'replied' });

  const expectedStates = outcome === 'held' ? ['received_held'] : ['received_held', 'opened', 'handed_to_agent'];
  await f.incoming.drainDue();
  const statuses = () => f.frames.filter(e => e.payload.eventType === 'DELIVERY_STATUS');
  expect(statuses().map(e => openEnvelope<SignedDeliveryStatus>(e, f.sender).payload.state)).toEqual(expectedStates);
  for (const frame of statuses()) await f.outgoing.statusRouter.route(frame);
  const latest = openEnvelope<SignedDeliveryStatus>(statuses().at(-1)!, f.sender);
  const value = await query(restarted, { messageId });
  expect(value).toMatchObject({ messageId, taskId, status: outcome === 'held' ? 'received_held' : 'replied',
    source: outcome === 'held' ? 'recipient' : 'reply', recipientStatus: latest });
  expect(await query(restarted, { taskId })).toEqual(value);

  if (outcome === 'held') {
    expect(pendingBefore).toHaveLength(1); expect(pendingBefore[0].attempts).toBe(1);
    f.setNow(f.epoch + 1000);
    f.review.discard(f.review.list()[0].id);
    await f.incoming.drainDue();
    await f.outgoing.statusRouter.route(statuses().at(-1)!);
    expect(await query(restarted, { messageId })).toMatchObject({ messageId, taskId, status: 'closed', source: 'recipient',
      updatedAt: f.now(), recipientStatus: { payload: { messageId, taskId, state: 'closed', revision: 2 } } });
  }
  const current = await query(restarted, { messageId });
  expect((await send(restarted)).result).toEqual(first.result);
  const snapshot = inventory(f.root);
  expect(await query(restarted, { taskId })).toEqual(current);
  expect(inventory(f.root)).toEqual(snapshot);
  expect(records.read('operations', operation.operationId)).toEqual(operation);
  expect(pending.list()).toEqual(pendingBefore);
  expect(proposals()).toEqual([original]); expect(approve).toHaveBeenCalledTimes(approvals);
  expect(f.execute).toHaveBeenCalledTimes(outcome === 'held' ? 0 : 1);
});

it('preserves held, opened, handoff and reply facts after the delivery deadline', async () => {
  const f = fixture();
  for (const state of ['received_held', 'opened', 'handed_to_agent', 'replied'] as const) {
    f.setNow(f.epoch); const p = f.enqueue();
    if (state === 'replied') f.outgoing.markPeerObserved(p.messageId, { status: state, envelopeId: p.messageId, replyEnvelopeId: randomUUID() });
    else f.outgoing.statusRouter.receive(f.status(p, { state }).envelope);
    f.setNow(Date.parse(p.manifest.deadline));
    expect(await query(server(f), { messageId: p.messageId })).toMatchObject({ status: state,
      source: state === 'replied' ? 'reply' : 'recipient', retry: { pending: false, nextAttemptAt: null } });
  }
});

it.each(['queued', 'relayed'] as const)('computes %s closure at the deadline and hides it at the fixed seven-day boundary without writes', async state => {
  const f = fixture(), p = f.enqueue(), s = server(f);
  if (state === 'relayed') await f.outgoing.sendPrepared(p.messageId);
  const record = f.outgoing.store.read('messages', p.messageId)!;
  expect(record.retainUntil).toBe(record.deliveryDeadline + DELIVERY_RETENTION_MS);
  const before = inventory(f.root);
  f.setNow(record.deliveryDeadline - 1);
  expect(await query(s, { messageId: p.messageId })).toMatchObject({ status: state });
  f.setNow(record.deliveryDeadline);
  expect(await query(s, { messageId: p.messageId })).toMatchObject({ status: 'closed', source: 'local', updatedAt: record.updatedAt,
    retry: { pending: false, nextAttemptAt: null } });
  f.setNow(record.retainUntil - 1);
  expect(await query(s, { taskId: p.manifest.taskId })).toMatchObject({ status: 'closed' });
  f.setNow(record.retainUntil);
  expect(await query(s, { messageId: p.messageId })).toEqual({ found: false });
  expect(await query(s, { taskId: p.manifest.taskId })).toEqual({ found: false });
  expect(inventory(f.root)).toEqual(before);
});

it('keeps unknown, pending and former-open task recipient detail coarse after later connection', async () => {
  for (const initial of ['none', 'pending', 'former-open'] as const) {
    const f = fixture(), p = f.enqueue();
    let connection: 'none' | 'pending' | 'connected' = initial === 'pending' ? 'pending' : 'none';
    const coordinator = new RecipientDeliveryCoordinator(f.incoming, { relayUrl: statusRelayUrl, connectionState: () => connection });
    coordinator.admit(p.envelope, p.manifest, false, true);
    const consume = async () => {
      await f.incoming.drainDue();
      for (const frame of f.frames.filter(e => e.payload.eventType === 'DELIVERY_STATUS')) f.outgoing.statusRouter.receive(frame);
    };
    await consume();
    expect(await query(server(f, { owner: f.recipient }), { messageId: p.messageId })).toEqual({ found: false });
    expect(await query(server(f), { messageId: p.messageId })).toMatchObject({ status: 'received_held',
      recipientStatus: { payload: { state: 'received_held', revision: 1 } } });
    coordinator.observe(p.messageId, 'opened'); coordinator.observe(p.messageId, 'handed_to_agent');
    connection = 'connected'; coordinator.reconcile(); await consume();
    expect(await query(server(f), { messageId: p.messageId })).toMatchObject({ status: 'received_held' });
    coordinator.observe(p.messageId, 'closed'); await consume();
    const value = await query(server(f), { messageId: p.messageId });
    expect(value).toMatchObject({ status: 'closed', recipientStatus: { payload: { state: 'closed', revision: 2 } } });
    expect(JSON.stringify(value)).not.toMatch(/opened|handed_to_agent/);
  }
});

it('returns absent for missing roots, identities, unknown and foreign IDs without creating local files', async () => {
  const f = fixture(), unknown = randomUUID(), before = inventory(f.root);
  const identityOptions = { env: { SEALBRIDGE_DATA_DIR: join(f.root, 'missing'), HOME: join(f.root, 'home') },
    keyStore: 'file' as const, keyringLoader: async () => { throw new Error('KEY_STORE_UNAVAILABLE'); } };
  for (const s of [server(f), new AcpMcpServer({ identityOptions, now: f.now })]) {
    expect(await query(s, { messageId: unknown })).toEqual({ found: false });
    expect(await query(s, { taskId: 'no C2 record' })).toEqual({ found: false });
  }
  expect(inventory(f.root)).toEqual(before);
  const p = f.enqueue(), snapshot = inventory(f.root);
  expect(await query(server(f, { owner: generateKeyPair() }), { messageId: p.messageId })).toEqual({ found: false });
  expect(await query(server(f, { owner: generateKeyPair() }), { taskId: p.manifest.taskId })).toEqual({ found: false });
  expect(inventory(f.root)).toEqual(snapshot);
});

it('requires messageId when a task selector matches multiple retained peers', async () => {
  const f = fixture(), p = f.enqueue(), peer = generateKeyPair();
  const frame = signEnvelope({ taskId: p.manifest.taskId, recipientDid: peer.did, eventType: 'PROPOSE', seq: 0, payload: {} }, f.sender, { encrypt: true });
  f.outgoing.enqueue([frame], { messageId: frame.payload.envelopeId, peerOwnerDid: peer.did, relayUrl: statusRelayUrl,
    deliveryDeadline: Date.parse(p.manifest.deadline), message: { taskId: p.manifest.taskId, peerAgentDid: peer.did, protocolVersion: '0.2.0' } });
  const s = server(f), before = inventory(f.root), response = await call(s, { taskId: p.manifest.taskId });
  expect(response.result?.isError).toBe(true);
  expect(JSON.parse(response.result!.content[0].text)).toEqual({ error: 'MESSAGE_STATUS_AMBIGUOUS' });
  expect(await query(s, { messageId: p.messageId })).toMatchObject({ peerDid: f.recipient.did });
  expect(await query(s, { messageId: frame.payload.envelopeId })).toMatchObject({ peerDid: peer.did });
  expect(inventory(f.root)).toEqual(before);
});

it('returns a fixed code for malformed retained messages or proposal records without exposing file text', async () => {
  for (const kind of ['messages', 'outbox'] as const) {
    const f = fixture(), p = f.enqueue();
    writeFileSync(f.outgoing.store.path(kind, p.messageId), 'malformed private fixture', { mode: 0o600 });
    const before = inventory(f.root);
    const response = await call(server(f), { messageId: p.messageId });
    expect(response.result?.isError).toBe(true); expect(response.result?.structuredContent).toBeUndefined();
    expect(JSON.parse(response.result!.content[0].text)).toEqual({ error: 'OUTBOX_STORE_INVALID' });
    expect(inventory(f.root)).toEqual(before);
  }
});

it('restarts with inspected signer state and reads legacy observations without initializing clients or creating identities', async () => {
  const f = fixture(), p = f.enqueue(f.proposal('0.1.0'));
  const load = vi.fn(() => f.sender), createIfMissing = vi.fn(() => f.sender), factory = vi.fn();
  const options: AcpMcpServerOptions = { now: f.now, transportFactory: factory,
    identityOptions: { ...f.identityOptions, keyStore: { load, createIfMissing,
      exists: () => true, describe: () => ({ backend: 'fixture', location: 'local' }) } } };
  const before = inventory(f.root);
  for (let n = 0; n < 2; n++) {
    const s = new AcpMcpServer(options); await catalog(s);
    expect(load).toHaveBeenCalledTimes(n);
    expect(await query(s, { messageId: p.messageId })).toMatchObject({ status: 'queued', recipientStatus: null });
  }
  expect(load).toHaveBeenCalledTimes(2); expect(createIfMissing).not.toHaveBeenCalled();
  expect(factory).not.toHaveBeenCalled(); expect(inventory(f.root)).toEqual(before);
  f.outgoing.markPeerObserved(p.messageId, { status: 'received_held', envelopeId: p.messageId });
  expect(await query(new AcpMcpServer(options), { messageId: p.messageId })).toMatchObject({
    status: 'received_held', source: 'local', recipientStatus: null, retry: { pending: false, nextAttemptAt: null },
  });
});

it('reads the configured delivery store and clock without starting an injected service or transport', async () => {
  const f = fixture(), p = f.enqueue();
  const unusedRoot = { env: { SEALBRIDGE_DATA_DIR: join(f.root, 'unused') } };
  const resolveTransport = vi.fn(), start = vi.spyOn(f.outgoing, 'start');
  const before = inventory(f.root);
  const injected = server(f, { identityOptions: unusedRoot, deliveryService: f.outgoing });
  expect(await query(injected, { messageId: p.messageId })).toMatchObject({ found: true, status: 'queued' });
  const configured = server(f, { identityOptions: unusedRoot, now: () => 0,
    deliveryOptions: { identityOptions: f.identityOptions, now: f.now, resolveTransport } });
  f.setNow(Date.parse(p.manifest.deadline));
  expect(await query(configured, { messageId: p.messageId })).toMatchObject({ status: 'closed' });
  const mismatch = await call(server(f, { owner: f.recipient, deliveryService: f.outgoing }), { messageId: p.messageId });
  expect(mismatch.result?.isError).toBe(true);
  expect(JSON.parse(mismatch.result!.content[0].text)).toEqual({ error: 'OUTBOX_STORE_INVALID' });
  const bounded = await call(server(f, { deliveryOptions: { identityOptions: f.identityOptions,
    now: f.now, limits: { recordBytes: 16 }, resolveTransport } }), { messageId: p.messageId });
  expect(bounded.result?.isError).toBe(true);
  expect(JSON.parse(bounded.result!.content[0].text)).toEqual({ error: 'OUTBOX_STORE_INVALID' });
  expect(resolveTransport).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  expect(inventory(f.root)).toEqual(before);
});
