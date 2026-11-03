// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { deliveryStatusRoutingId, digest, generateKeyPair, openEnvelope, signApproval, signEnvelope, signPayload } from '../packages/core/src/index.js';
import type { Json, SignedDeliveryStatus } from '../packages/core/src/index.js';
import { classifyEnvelopeRole, RelayDuplicateEnvelopeError } from '../packages/relay/src/index.js';
import { GatewayDeliveryService, RecipientDeliveryCoordinator, HeldRequestReview, DELIVERY_RETENTION_MS, IdempotencyStore, RequesterClient, idempotencyFailure } from '../packages/runtime/src/index.js';
import type { BeforeProposeContext } from '../packages/runtime/src/index.js';
import { countDeliveryFs } from './outbox-fixture.js';
import { statusFixture, statusRelayUrl } from './delivery-status-fixture.js';
const cleanups: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => { vi.restoreAllMocks(); cleanups.splice(0).forEach(f => f()); vi.unstubAllGlobals(); vi.useRealTimers(); });
function fixture(inspect = true) { const f = statusFixture(inspect); cleanups.push(f.cleanup); return f; }
function interceptSyncWrite(io: typeof import('node:fs'), before: () => void): typeof io.writeSync {
  return ((fd: number, bytes: NodeJS.ArrayBufferView, offset?: number | null, length?: number | null, position?: number | null) => {
    before(); return io.writeSync(fd, bytes, offset, length, position);
  }) as typeof io.writeSync;
}
it('writes recipient facts, status batches and revision receipts with closed publication handles and no file flushes', async () => {
  const f = fixture(), p = f.enqueue(), io = f.incoming.store.io;
  const handles = new Map<number, string>(), roots: string[] = [];
  let writes = 0, suppression = false;
  const identityOptions = { ...f.identityOptions, fs: { ...io,
    openSync: (path: Parameters<typeof io.openSync>[0], flags: string | number, mode?: Parameters<typeof io.openSync>[2]) => {
      const fd = io.openSync(path, flags, mode); handles.set(fd, String(path)); return fd;
    },
    closeSync: (fd: number) => { io.closeSync(fd); handles.delete(fd); },
    writeSync: interceptSyncWrite(io, () => {
      if (!suppression) expect(roots.every(root => !existsSync(join(root, '.lock')))).toBe(true);
      writes++;
    }),
    fsyncSync: () => { throw new Error('UNEXPECTED_FILE_FLUSH'); },
    fsync: Object.assign(() => { throw new Error('UNEXPECTED_FILE_FLUSH'); }, io.fsync),
    renameSync: (from: Parameters<typeof io.renameSync>[0], to: Parameters<typeof io.renameSync>[1]) => {
      expect([...handles.values()].some(path => path === String(from) || path === String(to))).toBe(false);
      io.renameSync(from, to);
    },
  } };
  const options = { identityOptions, now: f.now, resolveTransport: () => f.transport };
  const incoming = new GatewayDeliveryService(f.recipient, options), outgoing = new GatewayDeliveryService(f.sender, options);
  cleanups.push(() => { incoming.stop(); outgoing.stop(); });
  roots.push(incoming.store.root, outgoing.store.root);
  let connection: 'connected' | 'blocked' = 'connected';
  incoming.recipientStatus = new RecipientDeliveryCoordinator(incoming, { relayUrl: statusRelayUrl, connectionState: () => connection });
  incoming.recipientStatus.admit(p.envelope, p.manifest, true, true);
  incoming.recipientStatus.observe(p.messageId, 'opened');
  incoming.recipientStatus.handoff(p.envelope, p.manifest);
  incoming.recipientStatus.observe(p.messageId, 'closed');
  incoming.recipientStatus.reconcile();
  const record = incoming.store.read('observations', p.messageId)!;
  expect(record.published.map(p => p.status.payload.state)).toEqual(['received_held', 'opened', 'handed_to_agent', 'closed']);
  expect(() => incoming.store.preparedTransaction(() => incoming.store.write('observations', p.messageId,
    { ...record, disclosure: 'coarse' }))).toThrow('OUTBOX_STORE_INVALID');
  const ack = vi.fn(() => {
    expect(outgoing.store.getMessage(p.messageId)?.remoteStatus?.payload.revision).toBe(1);
    expect(outgoing.store.ids('receipts')).toHaveLength(1);
  });
  await outgoing.statusRouter.route(f.status(p).envelope, { send: vi.fn(), receive: vi.fn(), acknowledgeDelivery: ack });
  expect(ack).toHaveBeenCalledOnce();
  outgoing.markPeerObserved(p.messageId, { status: 'replied', envelopeId: p.messageId, replyEnvelopeId: randomUUID() });
  expect(outgoing.store.getMessage(p.messageId)?.status).toBe('replied');
  connection = 'blocked'; suppression = true;
  await incoming.drainStatuses();
  expect(f.frames).toEqual([]); expect(incoming.store.ids('outbox')).toEqual([]);
  expect(writes).toBeGreaterThan(0); expect(handles.size).toBe(0);
  for (const root of roots) expect(readdirSync(root, { recursive: true }).map(String).filter(path => path.endsWith('.tmp'))).toEqual([]);
});
it('rechecks status receipts and message state after another revision publishes during a write', async () => {
  const f = fixture(), p = f.enqueue(), io = f.outgoing.store.io;
  let concurrent = false;
  const service = new GatewayDeliveryService(f.sender, { ...f.outgoing.options, identityOptions: { ...f.identityOptions, fs: { ...io,
    writeSync: interceptSyncWrite(io, () => {
      expect(existsSync(join(service.store.root, '.lock'))).toBe(false);
      if (!concurrent) {
        concurrent = true;
        f.outgoing.statusRouter.receive(f.status(p, { state: 'opened', revision: 2 }).envelope);
      }
    }),
  } } });
  cleanups.push(() => service.stop());
  const ack = vi.fn();
  await service.statusRouter.route(f.status(p).envelope, { send: vi.fn(), receive: vi.fn(), acknowledgeDelivery: ack });
  expect(service.store.getMessage(p.messageId)).toMatchObject({ status: 'opened', remoteStatus: { payload: { revision: 2 } } });
  expect(service.store.ids('receipts')).toHaveLength(2); expect(ack).toHaveBeenCalledOnce();
  expect(readdirSync(service.store.root, { recursive: true }).map(String).filter(path => path.endsWith('.tmp'))).toEqual([]);
});
it('rechecks revision receipt capacity after another message publishes during a write', async () => {
  const f = fixture(), p = f.enqueue(), other = f.enqueue(), io = f.outgoing.store.io;
  let concurrent = false;
  const service = new GatewayDeliveryService(f.sender, { ...f.outgoing.options, limits: { receipts: 1 },
    identityOptions: { ...f.identityOptions, fs: { ...io, writeSync: interceptSyncWrite(io, () => {
      if (!concurrent) { concurrent = true; f.outgoing.statusRouter.receive(f.status(other).envelope); }
    }) } } });
  cleanups.push(() => service.stop());
  const ack = vi.fn();
  await expect(service.statusRouter.route(f.status(p).envelope,
    { send: vi.fn(), receive: vi.fn(), acknowledgeDelivery: ack })).rejects.toThrow('OUTBOX_FULL');
  expect(service.store.ids('receipts')).toHaveLength(1); expect(ack).not.toHaveBeenCalled();
  expect(service.store.getMessage(p.messageId)?.remoteStatus).toBeUndefined();
  expect(readdirSync(service.store.root, { recursive: true }).map(String).filter(path => path.endsWith('.tmp'))).toEqual([]);
});
it('retains a lifecycle fact when outbox capacity rejects its status publication', () => {
  const f = fixture(), p = f.proposal();
  const service = new GatewayDeliveryService(f.recipient, { ...f.incoming.options, limits: { activeEnvelopes: 1 } });
  cleanups.push(() => service.stop());
  service.recipientStatus = new RecipientDeliveryCoordinator(service, { relayUrl: statusRelayUrl, connectionState: () => 'connected' });
  service.recipientStatus.admit(p.envelope, p.manifest, true, true);
  expect(() => service.recipientStatus.observe(p.messageId, 'opened')).toThrow('OUTBOX_FULL');
  const record = service.store.read('observations', p.messageId)!;
  expect(record.facts.map(fact => fact.state)).toEqual(['received_held', 'opened']);
  expect(record.published.map(p => p.status.payload.state)).toEqual(['received_held']);
  service.store.transaction(() => {
    const queued = service.store.snapshot('outbox')[0];
    service.store.write('outbox', queued.envelopeId, { ...queued, state: 'closed' });
  });
  service.recipientStatus.observe(p.messageId, 'opened');
  expect(service.store.read('observations', p.messageId)?.published).toHaveLength(1);
});
it('leaves status unacknowledged and publishes no revision receipt after a write failure', async () => {
  const f = fixture(), p = f.enqueue(), io = f.outgoing.store.io;
  const service = new GatewayDeliveryService(f.sender, { ...f.outgoing.options, identityOptions: { ...f.identityOptions, fs: { ...io,
    writeSync: () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); },
  } } });
  cleanups.push(() => service.stop());
  const ack = vi.fn();
  await expect(service.statusRouter.route(f.status(p).envelope,
    { send: vi.fn(), receive: vi.fn(), acknowledgeDelivery: ack })).rejects.toThrow('OUTBOX_STORE_UNWRITABLE');
  expect(ack).not.toHaveBeenCalled(); expect(service.store.ids('receipts')).toEqual([]);
  expect(service.store.getMessage(p.messageId)?.remoteStatus).toBeUndefined();
  expect(readdirSync(service.store.root, { recursive: true }).map(String).filter(path => path.endsWith('.tmp'))).toEqual([]);
});
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
  vi.spyOn(f.outgoing.store, 'publishWrite').mockImplementation(() => { throw new Error('OUTBOX_STORE_UNWRITABLE'); });
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
  const publish = f.incoming.store.publishWrite.bind(f.incoming.store);
  const interrupted = vi.spyOn(f.incoming.store, 'publishWrite').mockImplementation(write => {
    const { kind, record } = write;
    if (kind === 'observations' && 'published' in record && record.published.length) throw new Error('OUTBOX_STORE_UNWRITABLE');
    publish(write);
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

it.each(['settled', 'held'] as const)('keeps %s keyed retries on the original envelope and delivery observations across restart', async outcome => {
  vi.setSystemTime(Date.UTC(2030, 0, 1));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('OFFLINE_TEST_NETWORK'); }));
  const f = statusFixture(outcome === 'settled');
  cleanups.push(f.cleanup);
  const beforePropose = vi.fn(async ({ manifest, input, relay }: BeforeProposeContext) => {
    const target = { manifest, input, relay, fanOut: 1, description: manifest.task.description };
    return { targetDigest: digest(target), approvedAt: f.now(),
      receipt: signApproval(manifest.taskId, 'external_side_effect', target, f.sender) };
  });
  const args = { to: f.worker.invite(), title: 'Keyed delivery', description: 'Return JSON', input: { n: 1 },
    idempotencyKey: 'delivery-observation', beforePropose };
  const call = async (client: RequesterClient) => {
    try { return { isError: false, value: await client.delegate(args) }; }
    catch (error) { return idempotencyFailure(error); }
  };
  const [first, concurrent] = await Promise.all([call(f.client), call(f.client), f.worker.start({ once: true }).catch(error => {
    expect(outcome).toBe('held'); expect(error.message).toBe('PENDING_OWNER_APPROVAL');
  })]);
  expect(concurrent).toEqual(first);
  expect(first).toMatchObject(outcome === 'settled'
    ? { isError: false, value: { state: 'SETTLED' } }
    : { isError: true, value: { error: 'PENDING_OWNER_APPROVAL', retryable: false } });
  expect(await call(f.client)).toEqual(first);
  expect(beforePropose).toHaveBeenCalledOnce();
  const proposals = () => f.frames.filter(e => e.payload.eventType === 'PROPOSE');
  expect(proposals()).toHaveLength(1);
  const original = proposals()[0], messageId = original.payload.envelopeId;
  const records = new IdempotencyStore(f.sender, { ...f.identityOptions, now: f.now }).records;
  const operation = records.snapshot('operations')[0];
  expect(operation).toMatchObject({ version: 1, phase: 'finished', messageIds: [messageId],
    preparedActions: [{ messageId, manifest: { taskId: original.payload.taskId, protocolVersion: '0.2.0' } }] });
  expect(records.snapshot('messages')).toHaveLength(1);
  expect(records.read('messages', messageId)).toMatchObject({ version: 1, operationId: operation.operationId,
    proposalEnvelopeDigest: digest(original) });
  const observation = f.incoming.store.read('observations', messageId)!;
  const expectedStates = outcome === 'settled' ? ['received_held', 'opened', 'handed_to_agent'] : ['received_held'];
  expect(observation).toMatchObject({ version: 1, messageId, originalEnvelopeDigest: digest(original) });
  expect(observation.facts.map(fact => fact.state)).toEqual(expectedStates);

  f.client.stopDelivery();
  const restarted = new GatewayDeliveryService(f.sender, f.outgoing.options);
  const client = new RequesterClient({ ...f.client.options, deliveryService: restarted });
  cleanups.push(() => client.stopDelivery());
  expect(await call(client)).toEqual(first);
  expect(restarted.store.read('operations', operation.operationId)).toEqual(operation);
  if (outcome === 'held') {
    f.review.discard(f.review.list()[0].id);
    expectedStates.push('closed');
  }
  await f.incoming.drainDue();
  // Route retained frames directly: no socket or polling clock is required.
  const statuses = f.frames.filter(e => e.payload.eventType === 'DELIVERY_STATUS');
  expect(statuses.map(e => openEnvelope<SignedDeliveryStatus>(e, f.sender).payload.state)).toEqual(expectedStates);
  for (const envelope of statuses) {
    await restarted.statusRouter.route(envelope);
    await restarted.statusRouter.route(envelope);
  }
  expect(restarted.store.getMessage(messageId)).toMatchObject({ operationId: operation.operationId,
    status: outcome === 'settled' ? 'replied' : 'closed', remoteStatus: { payload: {
      messageId, taskId: original.payload.taskId, state: expectedStates.at(-1), revision: expectedStates.length,
    } } });
  const receipts = restarted.store.snapshot('receipts');
  expect(receipts.filter(r => r.envelopeId.startsWith('ds_'))).toHaveLength(expectedStates.length);
  const message = restarted.store.read('messages', messageId);
  const facts = f.incoming.store.read('observations', messageId);
  expect(await call(client)).toEqual(first);
  expect(restarted.store.read('messages', messageId)).toEqual(message);
  expect(restarted.store.snapshot('receipts')).toEqual(receipts);
  expect(restarted.store.read('operations', operation.operationId)).toEqual(operation);
  expect(f.incoming.store.snapshot('observations')).toEqual([facts]);
  expect(f.incoming.store.read('observations', messageId)?.facts.map(fact => fact.state)).toEqual(expectedStates);
  expect(proposals()).toEqual([original]);
  expect(beforePropose).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
  expect(f.execute).toHaveBeenCalledTimes(outcome === 'settled' ? 1 : 0);
  expect(f.human.approve).toHaveBeenCalledTimes(outcome === 'settled' ? 1 : 0);
});
