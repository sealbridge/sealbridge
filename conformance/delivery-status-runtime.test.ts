// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { deliveryStatusRoutingId, digest, generateKeyPair, signEnvelope, signPayload } from '../packages/core/src/index.js';
import type { Json } from '../packages/core/src/index.js';
import { classifyEnvelopeRole, RelayDuplicateEnvelopeError } from '../packages/relay/src/index.js';
import { GatewayDeliveryService, RecipientDeliveryCoordinator, HeldRequestReview, DELIVERY_RETENTION_MS } from '../packages/runtime/src/index.js';
import { countDeliveryFs } from './outbox-fixture.js';
import { statusFixture, statusRelayUrl } from './delivery-status-fixture.js';
const cleanups: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => { vi.restoreAllMocks(); cleanups.splice(0).forEach(f => f()); vi.useRealTimers(); });
function fixture(inspect = true) { const f = statusFixture(inspect); cleanups.push(f.cleanup); return f; }
it('retains verified recipient facts independently of duplicate, delayed and reordered status frames', () => {
  const f = fixture(), p = f.enqueue();
  const one = f.status(p), two = f.status(p, { state: 'opened', revision: 2 });
  f.outgoing.statusRouter.receive(two.envelope); f.outgoing.statusRouter.receive(one.envelope); f.outgoing.statusRouter.receive(two.envelope);
  expect(f.outgoing.store.getMessage(p.messageId)).toMatchObject({ status: 'opened', remoteStatus: two.signed });
  const conflict = f.status(p, { state: 'closed', revision: 2 });
  expect(() => f.outgoing.statusRouter.receive(conflict.envelope)).toThrow('DELIVERY_STATUS_CONFLICT');
  const earlierConflict = f.status(p, { state: 'closed', revision: 1 });
  expect(() => f.outgoing.statusRouter.receive(earlierConflict.envelope)).toThrow('DELIVERY_STATUS_CONFLICT');
  f.setNow(f.epoch + 2 * 86400_000);
  f.outgoing.statusRouter.receive(f.status(p, { state: 'handed_to_agent', revision: 3, occurredAt: f.epoch + 1000 }).envelope);
  expect(f.outgoing.store.getMessage(p.messageId)?.status).toBe('handed_to_agent');
  f.outgoing.store.transaction(() => { const m = f.outgoing.store.read('messages', p.messageId)!;
    f.outgoing.store.write('messages', m.messageId, { ...m, status: 'replied', replyEnvelopeId: randomUUID() }); });
  f.outgoing.statusRouter.receive(f.status(p, { state: 'closed', revision: 4 }).envelope);
  expect(f.outgoing.store.getMessage(p.messageId)?.status).toBe('replied');
});
it.each(['message','task','direction','signer','seq','routing','cleartext','future','future-signature','horizon','chronology','relay'] as const)('discards %s status without creating records or affecting a task', async kind => {
  const f = fixture(), p = f.enqueue(); let { envelope, signed } = f.status(p);
  if (kind === 'message') envelope = f.status(p, { messageId: randomUUID() }).envelope;
  if (kind === 'task') envelope = f.status(p, { taskId: 'different_task' }).envelope;
  if (kind === 'direction') envelope = f.status(p, { senderDid: f.recipient.did }).envelope;
  if (kind === 'signer' || kind === 'relay') envelope = signEnvelope({ ...envelope.payload,
    payload: signPayload(kind === 'relay' ? { type: 'RelayDeliveryStatus', status: 'pending' } : signed.payload, generateKeyPair()) as unknown as Json }, f.recipient, { encrypt: true });
  if (kind === 'seq') envelope = f.status(p, {}, { seq: 2 }).envelope;
  if (kind === 'routing') envelope = f.status(p, {}, { taskId: 'task_wrong' }).envelope;
  if (kind === 'cleartext') envelope = signEnvelope({ ...envelope.payload, payload: signed as unknown as Json }, f.recipient);
  if (kind === 'future-signature') envelope = signPayload(envelope.payload, f.recipient, new Date(f.now() + 600_000).toISOString());
  if (kind === 'future') envelope = f.status(p, { occurredAt: f.now() + 600_000 }).envelope;
  if (kind === 'horizon') envelope = f.status(p, { retainUntil: signed.payload.retainUntil + 1 }).envelope;
  if (kind === 'chronology') {
    f.outgoing.statusRouter.receive(f.status(p, { occurredAt: f.epoch + 100, revision: 1 }).envelope);
    envelope = f.status(p, { occurredAt: f.epoch, revision: 2 }).envelope;
  }
  const ack = vi.fn();
  await expect(f.outgoing.statusRouter.route(envelope, { send: vi.fn(), receive: vi.fn(), acknowledgeDelivery: ack })).resolves.toBe(true);
  expect(ack).toHaveBeenCalledOnce(); expect(f.errors).toHaveBeenCalled();
  expect(f.outgoing.store.ids('messages')).toEqual([p.messageId]);
  expect(f.execute).not.toHaveBeenCalled(); expect(f.human.approve).not.toHaveBeenCalled();
});
it('hides status at the fixed seven-day horizon without extending it on reads', () => {
  const f = fixture(), p = f.enqueue(), frame = f.status(p);
  f.outgoing.statusRouter.receive(frame.envelope);
  const retain = Date.parse(p.manifest.deadline) + DELIVERY_RETENTION_MS;
  f.setNow(retain - 1); expect(f.outgoing.store.getMessage(p.messageId)?.retainUntil).toBe(retain);
  const bytes = readFileSync(f.outgoing.store.path('messages', p.messageId));
  f.setNow(retain); expect(f.outgoing.store.getMessage(p.messageId)).toBeUndefined();
  expect(() => f.outgoing.statusRouter.receive(frame.envelope)).toThrow('INVALID_DELIVERY_STATUS');
  expect(readFileSync(f.outgoing.store.path('messages', p.messageId))).toEqual(bytes);
});
it('does not acknowledge a valid status when local persistence fails', async () => {
  const f = fixture(), p = f.enqueue(), ack = vi.fn();
  vi.spyOn(f.outgoing.store, 'write').mockImplementation(() => { throw new Error('OUTBOX_STORE_UNWRITABLE'); });
  await expect(f.outgoing.statusRouter.route(f.status(p).envelope,
    { send: vi.fn(), receive: vi.fn(), acknowledgeDelivery: ack })).rejects.toThrow('OUTBOX_STORE_UNWRITABLE');
  expect(ack).not.toHaveBeenCalled();
});
it('keeps delivery control independent of bilateral role inference and produces no status loop', async () => {
  const f = fixture(), p = f.enqueue(), frame = f.status(p).envelope;
  expect(classifyEnvelopeRole(frame)).toBe('requester');
  expect(frame.payload.taskId).toBe(deliveryStatusRoutingId(p.messageId));
  await f.outgoing.statusRouter.route(frame, f.transport);
  expect(f.outgoing.store.snapshot('observations')).toEqual([]); expect(f.frames).toEqual([]);
});
it('reconciles the same prepared status after an interrupted reference write and retries identical ciphertext', async () => {
  const f = fixture(), p = f.enqueue();
  f.incoming.recipientStatus = new RecipientDeliveryCoordinator(f.incoming, { relayUrl: statusRelayUrl, connectionState: () => 'none' });
  const write = f.incoming.store.write.bind(f.incoming.store);
  const interrupted = vi.spyOn(f.incoming.store, 'write').mockImplementation((kind, id, record) => {
    if (kind === 'observations' && 'published' in record && record.published.length) throw new Error('OUTBOX_STORE_UNWRITABLE');
    write(kind, id, record);
  });
  expect(() => f.incoming.recipientStatus.admit(p.envelope, p.manifest, false, true)).toThrow('OUTBOX_STORE_UNWRITABLE');
  interrupted.mockRestore();
  const original = f.incoming.store.snapshot('outbox')[0];
  const sent: unknown[] = []; let attempt = 0;
  const restarted = new GatewayDeliveryService(f.recipient, { identityOptions: f.identityOptions, now: f.now,
    resolveTransport: () => ({ send: e => { sent.push(e); if (++attempt === 1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      throw new RelayDuplicateEnvelopeError(); }, receive: vi.fn() }) });
  cleanups.push(() => restarted.stop());
  restarted.recipientStatus = new RecipientDeliveryCoordinator(restarted, { relayUrl: statusRelayUrl, connectionState: () => 'none' });
  await restarted.start();
  expect(restarted.store.read('observations', p.messageId)?.published[0]).toMatchObject({ revision: 1, envelopeId: original.envelopeId });
  f.setNow(f.now() + 60_000); await restarted.drainDue();
  expect(sent).toEqual([original.envelope, original.envelope]);
  expect(restarted.store.snapshot('outbox')[0]).toMatchObject({ state: 'admitted', attemptCount: 2 });
  expect(restarted.store.read('observations', p.messageId)?.published).toHaveLength(1);
  if (process.platform !== 'win32') {
    expect(statSync(restarted.store.path('observations', p.messageId)).mode & 0o777).toBe(0o600);
    expect(statSync(restarted.store.root).mode & 0o777).toBe(0o700);
  }
});
it('continues receiving after a terminal held call and after gateway restart without an agent wake', async () => {
  const f = fixture(false);
  await f.client.startDelivery();
  expect((await f.attempt())[0]).toMatchObject({ status: 'rejected', reason: { code: 'PENDING_OWNER_APPROVAL' } });
  const m = f.outgoing.store.snapshot('messages')[0];
  await f.incoming.drainDue();
  await vi.waitFor(() => expect(f.outgoing.store.getMessage(m.messageId)?.remoteStatus?.payload.state).toBe('received_held'));
  f.client.stopDelivery();
  const restarted = new GatewayDeliveryService(f.sender, { identityOptions: f.identityOptions, now: f.now, resolveTransport: () => f.transport });
  cleanups.push(() => restarted.stop()); await restarted.start();
  f.review.discard(f.review.list()[0].id); await f.incoming.drainDue();
  await vi.waitFor(() => expect(restarted.store.getMessage(m.messageId)?.remoteStatus?.payload.state).toBe('closed'));
  expect(f.execute).not.toHaveBeenCalled(); expect(f.human.approve).not.toHaveBeenCalled();
});
it('shares status and task routing when the same DID is a worker and requester', async () => {
  const f = fixture();
  const { WorkerNode, PolicyAutoApprovalProvider, WorkerTrustStore, workerIntakePath } = await import('../packages/runtime/src/index.js');
  const store = new WorkerTrustStore(f.sender, { path: workerIntakePath(f.sender.did, f.identityOptions), now: f.now });
  const { completeInspection } = await import('./connections-fixture.js');
  const review = new HeldRequestReview(f.sender, { ...f.identityOptions, now: f.now, provider: completeInspection });
  const approval = new PolicyAutoApprovalProvider(f.sender), execute = vi.fn(async (c: { input: Json }) => c.input);
  const worker = new WorkerNode({ owner: f.sender, relay: f.transport, relayUrl: statusRelayUrl, identityOptions: f.identityOptions, now: f.now,
    deliveryService: f.outgoing, intakeStore: store, connectionStore: store, heldReview: review, taskTimeoutMs: 86400_000,
    approvalProvider: approval, ownerApprovalProvider: { kind: 'human', approve: approval.approve.bind(approval) },
    adapter: { id: 'echo', name: 'Echo', skills: [], executeTask: execute } });
  cleanups.push(() => worker.stop()); await f.client.startDelivery();
  const [result] = await Promise.all([f.client.delegate({ to: worker.invite(), title: 'Same identity', description: 'Separate roles', input: {} }), worker.start({ once: true })]);
  const m = f.outgoing.store.snapshot('messages')[0];
  expect(result.state).toBe('SETTLED'); expect(execute).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(f.outgoing.store.getMessage(m.messageId)?.remoteStatus?.payload.state).toBe('handed_to_agent'));
  expect(f.outgoing.store.getMessage(m.messageId)?.status).toBe('replied');
  expect(result.bundle.entries.some(e => e.body.eventType === 'DELIVERY_STATUS')).toBe(false);
});
it('uses no unfiltered status read when no outgoing messages are retained', async () => {
  const f = fixture(), receive = vi.spyOn(f.transport, 'receive');
  await f.outgoing.start(); await f.outgoing.statusRouter.refresh();
  expect(receive).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
});
it('does not acknowledge or delete held input when status persistence fails', async () => {
  const f=fixture(),p=f.proposal(),ack=vi.fn();
  const {WorkerNode}=await import('../packages/runtime/src/index.js');
  const worker=new WorkerNode({...f.worker.options,relay:{send:f.transport.send,
    receive:did=>f.relay.receive(did),acknowledgeDelivery:ack}});
  cleanups.push(()=>worker.stop());
  const write=f.incoming.store.write.bind(f.incoming.store);
  vi.spyOn(f.incoming.store,'write').mockImplementation((kind,id,value)=>{
    if(kind==='observations') throw new Error('OUTBOX_STORE_UNWRITABLE');
    write(kind,id,value as never);
  });
  f.relay.send(p.envelope);await expect(worker.runOnce()).rejects.toThrow();
  expect(ack).not.toHaveBeenCalled();expect(f.review.list()).toHaveLength(1);
  expect(f.execute).not.toHaveBeenCalled();expect(f.human.approve).not.toHaveBeenCalled();
});
it('receives statuses through existing relay role classification using only retained routing IDs', async () => {
  const f=fixture(),p=f.enqueue(),pending=[f.status(p).envelope];
  const receive=vi.fn((_did:string,_ms?:number,_signal?:AbortSignal,filter?:import('../packages/relay/src/index.js').RelayReceiveFilter)=>{
    // Earlier relay versions classify unrecognized control events as worker-directed.
    if(filter?.role==='requester') return undefined;
    const ids=Array.isArray(filter?.taskId)?filter.taskId:[filter?.taskId];
    if(pending[0]&&ids.includes(pending[0].payload.taskId)) return pending.shift();
    return undefined;
  });
  const service=new GatewayDeliveryService(f.sender,{identityOptions:f.identityOptions,now:f.now,resolveTransport:()=>({send:()=>{},receive})});
  cleanups.push(()=>service.stop());await service.start();
  await vi.waitFor(()=>expect(service.store.getMessage(p.messageId)?.remoteStatus?.payload.state).toBe('received_held'));
  expect(receive.mock.calls.every(c=>Array.isArray(c[3]?.taskId)&&c[3]!.taskId!.length>0)).toBe(true);
  expect(f.execute).not.toHaveBeenCalled();
});
it('checks the current MCP relay allowlist before resuming a retained status reader', async () => {
  const f=fixture();f.enqueue();
  const {AcpMcpServer}=await import('../packages/runtime/src/mcp-server.js');const transportFactory=vi.fn(()=>f.transport);
  const server=new AcpMcpServer({owner:f.sender,identityOptions:f.identityOptions,allowedRelayUrls:['https://other.example'],transportFactory,
    deliveryOptions:{resolveTransport:transportFactory,now:f.now,onError:f.errors}});
  cleanups.push(()=>server.stopDelivery());await server.startDelivery();
  expect(transportFactory).not.toHaveBeenCalled();expect(f.errors).toHaveBeenCalledWith(expect.objectContaining({message:'MCP_RELAY_NOT_ALLOWED'}));
  expect(f.execute).not.toHaveBeenCalled();expect(f.human.approve).not.toHaveBeenCalled();
});

it('routes and sends status without reopening an unrelated backlog beyond the verified-record cache', async () => {
  const f = fixture(), counted = countDeliveryFs(f.incoming.store.io);
  const service = new GatewayDeliveryService(f.recipient, { identityOptions: { ...f.identityOptions, fs: counted.fs }, now: f.now,
    resolveTransport: () => f.transport, onError: f.errors });
  cleanups.push(() => service.stop());
  service.recipientStatus = new RecipientDeliveryCoordinator(service, { relayUrl: statusRelayUrl, connectionState: () => 'none' });
  for (let i = 0; i < 130; i++) {
    const taskId = 'task_backlog_' + i;
    const envelope = signEnvelope({ taskId, recipientDid: f.sender.did, seq: 0, eventType: 'PROPOSE', payload: {} }, f.recipient, { encrypt: true });
    service.enqueue([envelope], { messageId: envelope.payload.envelopeId, peerOwnerDid: f.sender.did, relayUrl: statusRelayUrl,
      deliveryDeadline: f.now() + 86400_000, message: { taskId, peerAgentDid: f.sender.did, protocolVersion: '0.2.0' } });
  }
  await service.prepare();
  counted.reset();
  expect(service.statusRouter.ids(statusRelayUrl)).toHaveLength(130);
  expect(service.statusRouter.ids(statusRelayUrl)).toHaveLength(130);
  const copy = service.store.statusMessages(); copy[0].relayUrl = 'https://other.example';
  expect(service.statusRouter.ids(statusRelayUrl)).toHaveLength(130);
  expect(counted.counts.readSync).toBe(0); expect(counted.counts.readdirSync).toBe(0);
  const p = f.proposal();
  counted.reset();
  service.recipientStatus.admit(p.envelope, p.manifest, false, true);
  service.recipientStatus.observe(p.messageId, 'closed');
  expect(counted.counts.readSync).toBe(0); expect(counted.counts.readdirSync).toBe(0);
  expect(counted.counts.fsyncSync + counted.asyncCounts.fsync).toBe(0);
  counted.reset();
  await service.drainStatuses();
  expect(f.frames.filter(e => e.payload.eventType === 'DELIVERY_STATUS')).toHaveLength(2);
  expect(counted.total()).toBeLessThanOrEqual(40);
  expect(counted.counts.readSync).toBe(0); expect(counted.counts.readdirSync).toBe(0); expect(counted.counts.fsyncSync).toBe(0);
  expect(service.store.ids('outbox')).toHaveLength(130);
  // Another store's publication is discovered in yielding preparation before routing resumes.
  const peer = new GatewayDeliveryService(f.recipient, { identityOptions: f.identityOptions, now: f.now, resolveTransport: () => f.transport });
  cleanups.push(() => peer.stop()); await peer.prepare();
  const frame = signEnvelope({ taskId: 'task_other_store', recipientDid: f.sender.did, seq: 0, eventType: 'PROPOSE', payload: {} }, f.recipient, { encrypt: true });
  peer.enqueue([frame], { messageId: frame.payload.envelopeId, peerOwnerDid: f.sender.did, relayUrl: statusRelayUrl, deliveryDeadline: f.now() + 86400_000,
    message: { taskId: frame.payload.taskId, peerAgentDid: f.sender.did, protocolVersion: '0.2.0' } });
  await service.prepare(); counted.reset();
  expect(service.statusRouter.ids(statusRelayUrl)).toHaveLength(131); expect(counted.counts.readSync).toBe(0);
});
