// SPDX-License-Identifier: Apache-2.0
import { deliveryStatusRoutingId, digest, openEnvelope, projectDeliveryState, signDeliveryStatus, signEnvelope, validateManifest, verifySigned, verifyEnvelope, isEncryptedEnvelopePayload } from '@acp/core';
import type { Json, RecipientDeliveryState, SignedEnvelope, TaskManifest } from '@acp/core';
import { GatewayDeliveryService } from './outbox.js';
import { DELIVERY_RETENTION_MS, UUID, deliveryError } from './delivery-records.js';
import type { OutboxRecordV1, RecipientDeliveryRecordV1 } from './delivery-records.js';
import type { HeldRecord, HeldTransitionSink } from './held-request-store.js';
import { WorkerTrustStore, workerIntakePath } from './worker-trust-store.js';

type ConnectionState = 'none' | 'pending' | 'connected' | 'blocked';
export interface DeliveryStatusOptions {
  relayUrl?: string;
  onPublish?: () => void;
  connectionState?: (peer: string) => ConnectionState;
  relayForPeer?: (peer: string) => string | undefined;
}
/** Content-free recipient lifecycle, separate from inspection and task execution. */
class RecipientDeliveryCoordinatorImplementation {
  private readonly pendingAdmissions = new Set<string>();
  constructor(readonly service: GatewayDeliveryService, readonly options: DeliveryStatusOptions = {}) {}
  private connections(): WorkerTrustStore {
    return new WorkerTrustStore(this.service.owner, { path: workerIntakePath(this.service.owner.did, this.service.options.identityOptions),
      ...this.service.options.identityOptions, now: this.service.store.now });
  }
  connection(peer: string): ConnectionState { return this.options.connectionState?.(peer) ?? this.connections().connectionState(peer); }
  private relay(peer: string): string | undefined {
    const url = this.options.relayUrl ?? this.options.relayForPeer?.(peer);
    if (url) return url;
    const connection = this.connections().listConnections().find(c => c.peerOwnerDid === peer);
    return connection && 'relayUrl' in connection ? connection.relayUrl : undefined;
  }
  begin(messageId: string): void { this.pendingAdmissions.add(messageId); }
  end(messageId: string): void { this.pendingAdmissions.delete(messageId); }
  admit(envelope: SignedEnvelope, manifest: TaskManifest, connected: boolean, held: boolean, occurredAt = this.service.store.now()): void {
    if (manifest.protocolVersion !== '0.2.0' || !UUID.test(envelope.payload.envelopeId) || !isEncryptedEnvelopePayload(envelope.payload.payload)) return;
    const id = envelope.payload.envelopeId;
    const body = openEnvelope<{ proposal: { payload: TaskManifest } }>(envelope, this.service.owner);
    validateManifest(body?.proposal?.payload);
    if (!verifyEnvelope(envelope, this.service.owner.did) || envelope.payload.eventType !== 'PROPOSE' || envelope.payload.seq !== 0 ||
      envelope.payload.taskId !== manifest.taskId || envelope.payload.senderDid !== manifest.requester.ownerDid ||
      manifest.worker?.ownerDid !== this.service.owner.did || digest(body.proposal.payload) !== digest(manifest) ||
      !verifySigned(body.proposal as never, manifest.requester.ownerDid)) throw deliveryError('INVALID_DELIVERY_STATUS');
    this.service.store.preparedTransaction(() => {
      const previous = this.service.store.read('observations', id);
      if (previous) {
        if (previous.originalEnvelopeDigest !== digest(envelope)) throw deliveryError('DELIVERY_RECORD_CONFLICT');
        return;
      }
      if (!held) return; // Legacy grants have no synthetic held/opened facts.
      if (this.service.store.ids('observations').length >= this.service.store.limits.messages) throw deliveryError('OUTBOX_FULL');
      this.service.store.write('observations', id, { version: 1, messageId: id, localOwnerDid: this.service.owner.did,
        senderDid: manifest.requester.ownerDid, taskId: manifest.taskId, originalEnvelopeDigest: digest(envelope),
        createdAt: Date.parse(manifest.createdAt), deliveryDeadline: Date.parse(manifest.deadline),
        retainUntil: Math.max(Date.parse(manifest.createdAt), Date.parse(manifest.deadline)) + DELIVERY_RETENTION_MS,
        protocolVersion: '0.2.0', disclosure: connected ? 'connected' : 'coarse', latestState: 'received_held', nextRevision: 1,
        facts: [{ state: 'received_held', occurredAt }], published: [] });
    });
    if (held) this.observe(id, 'received_held');
  }
  /** A validated legacy grant may record its real adapter boundary without asserting owner opening. */
  handoff(envelope: SignedEnvelope, manifest: TaskManifest): void {
    const id = envelope.payload.envelopeId;
    if (manifest.protocolVersion !== '0.2.0' || !UUID.test(id) || !isEncryptedEnvelopePayload(envelope.payload.payload)) return;
    const firstHandoff = !this.service.store.read('observations', id);
    if (firstHandoff) {
      const now = this.service.store.now(), connected = this.connection(manifest.requester.ownerDid) === 'connected';
      this.service.store.preparedTransaction(() => {
        if (this.service.store.ids('observations').length >= this.service.store.limits.messages) throw deliveryError('OUTBOX_FULL');
        this.service.store.write('observations', id, {
        version: 1, messageId: id, localOwnerDid: this.service.owner.did, senderDid: manifest.requester.ownerDid,
        taskId: manifest.taskId, originalEnvelopeDigest: digest(envelope), createdAt: Date.parse(manifest.createdAt),
        deliveryDeadline: Date.parse(manifest.deadline), retainUntil: Math.max(Date.parse(manifest.createdAt), Date.parse(manifest.deadline)) + DELIVERY_RETENTION_MS,
        protocolVersion: '0.2.0', disclosure: connected ? 'connected' : 'coarse',
        latestState: 'handed_to_agent', nextRevision: 1, facts: [{ state: 'handed_to_agent', occurredAt: now }], published: [],
      }); });
      if (!connected) return; // Immutable coarse admission never publishes adapter detail.
    }
    this.recordObservation(id, 'handed_to_agent', firstHandoff);
  }
  observe(id: string, state: RecipientDeliveryState): void { this.recordObservation(id, state); }
  private recordObservation(id: string, state: RecipientDeliveryState, firstHandoff = false): void {
    if (!UUID.test(id)) return;
    this.service.store.preparedTransaction(() => {
      let r = this.service.store.read('observations', id);
      if (!r || this.service.store.now() >= r.retainUntil) return;
      this.reconcileLocked(r);
      r = this.service.store.read('observations', id)!;
      let fact = r.facts.find(f => f.state === state);
      const existingDetail = !!fact && !['received_held', 'closed'].includes(state) && !firstHandoff;
      if (!fact) {
        if (r.latestState === 'closed' || state === 'received_held' || state === 'opened' && r.latestState === 'handed_to_agent') return;
        fact = { state, occurredAt: this.service.store.now() };
        r = { ...r, facts: [...r.facts, fact], latestState: state };
        this.service.store.write('observations', id, r);
      }
      if (existingDetail || r.published.some(p => p.status.payload.state === state) || !projectDeliveryState(state, r.disclosure, this.connection(r.senderDid))) return;
      const relayUrl = this.relay(r.senderDid);
      if (!relayUrl) throw deliveryError('OUTBOX_STORE_INVALID');
      const status = signDeliveryStatus({ type: 'DeliveryStatus', version: 1, messageId: id, taskId: r.taskId,
        senderDid: r.senderDid, recipientDid: r.localOwnerDid, state, revision: r.nextRevision,
        occurredAt: fact.occurredAt, retainUntil: r.retainUntil }, this.service.owner);
      const envelope = signEnvelope({ taskId: deliveryStatusRoutingId(id), recipientDid: r.senderDid,
        seq: r.nextRevision, eventType: 'DELIVERY_STATUS', payload: status as unknown as Json }, this.service.owner,
        { encrypt: true, signedAt: new Date(this.service.store.now()).toISOString() });
      this.service.enqueueLocked([envelope], { messageId: id, peerOwnerDid: r.senderDid, relayUrl,
        deliveryDeadline: Math.min(fact.occurredAt + 86400_000, r.retainUntil), kind: 'delivery-status' });
      this.service.store.write('observations', id, { ...r, nextRevision: r.nextRevision + 1,
        published: [...r.published, { revision: r.nextRevision, status, envelopeId: envelope.payload.envelopeId }] });
    });
    this.options.onPublish?.();
  }
  /** Complete references for frames already committed before an interrupted observation write. */
  private reconcileLocked(initial: RecipientDeliveryRecordV1): void {
    let r = initial;
    for (const o of this.service.store.statusOutbox(r.messageId, r.published.map(p => p.envelopeId)).sort((a,b) => a.ordinal - b.ordinal)) {
      if (r.published.some(p => p.envelopeId === o.envelopeId)) continue;
      const fact = r.facts.at(-1)!;
      if (o.ordinal !== r.nextRevision || o.peerOwnerDid !== r.senderDid || o.envelope.payload.taskId !== deliveryStatusRoutingId(r.messageId) ||
          o.envelope.payload.eventType !== 'DELIVERY_STATUS') throw deliveryError('DELIVERY_RECORD_CONFLICT');
      // Ed25519 and the original fact timestamp reproduce the inner signed bytes. The
      // encrypted outer frame remains exactly the prepared, locally signed outbox frame.
      const status = signDeliveryStatus({ type: 'DeliveryStatus', version: 1, messageId: r.messageId, taskId: r.taskId,
        senderDid: r.senderDid, recipientDid: r.localOwnerDid, state: fact.state, revision: o.ordinal,
        occurredAt: fact.occurredAt, retainUntil: r.retainUntil }, this.service.owner);
      if (!this.service.store.read('batches', o.batchId)) this.service.store.write('batches', o.batchId,
        { version: 1, batchId: o.batchId, messageId: o.messageId, localOwnerDid: r.localOwnerDid,
          envelopeIds: [o.envelopeId], createdAt: o.createdAt, committed: true });
      r = { ...r, nextRevision: r.nextRevision + 1, published: [...r.published, { revision: o.ordinal, status, envelopeId: o.envelopeId }] };
      this.service.store.write('observations', r.messageId, r);
    }
  }
  readonly transition: HeldTransitionSink = (record, transition) => {
    if (record.kind !== 'task' || !UUID.test(record.envelope.payload.envelopeId) || this.pendingAdmissions.has(record.envelope.payload.envelopeId)) return;
    this.recoverHeld(record);
    const observation = this.service.store.read('observations', record.envelope.payload.envelopeId);
    if (observation?.latestState === 'closed') this.observe(observation.messageId, 'closed');
    if (transition !== 'completed') this.observe(record.envelope.payload.envelopeId, transition === 'held' ? 'received_held' : 'closed');
  };
  private recoverHeld(record: HeldRecord): void {
    if (record.kind !== 'task' || !UUID.test(record.envelope.payload.envelopeId)) return;
    if (this.service.store.read('observations', record.envelope.payload.envelopeId)) return;
    const body = openEnvelope<{ proposal: { payload: TaskManifest }; input: Json }>(record.envelope, this.service.owner);
    const m = body.proposal?.payload;
    validateManifest(m);
    if (!verifySigned(body.proposal as never, record.senderOwnerDid) || m.requester.ownerDid !== record.senderOwnerDid ||
      m.worker?.ownerDid !== this.service.owner.did || m.taskId !== record.taskId) throw deliveryError('INVALID_DELIVERY_STATUS');
    this.admit(record.envelope, m, false, true, record.receivedAt);
  }
  reconcile(records: HeldRecord[] = []): void {
    for (const record of records) if (!this.pendingAdmissions.has(record.envelope.payload.envelopeId)) this.transition(record, 'held');
    if (this.service.store.ids('observations').length) this.service.store.preparedTransaction(() => {
      for (const r of this.service.store.snapshot('observations')) this.reconcileLocked(r);
    });
  }
  dispatchAllowed(record: OutboxRecordV1): boolean {
    if (record.kind !== 'delivery-status') return true;
    const r = this.service.store.read('observations', record.messageId);
    const published = r?.published.find(p => p.envelopeId === record.envelopeId);
    return !!r && !!published && !!projectDeliveryState(published.status.payload.state, r.disclosure, this.connection(r.senderDid));
  }
}

/** Attach local terminal intents for owner CLI operations; lifecycle startup remains explicit. */
export function attachHeldDeliveryStatus(owner: import('@acp/core').KeyPair, review: import('./held-request-review.js').HeldRequestReview,
  identityOptions: import('./key-store.js').IdentityStoreOptions, store: WorkerTrustStore, now?: () => number): GatewayDeliveryService {
  const service = new GatewayDeliveryService(owner, { identityOptions, now, resolveTransport: () => { throw deliveryError('RELAY_UNAVAILABLE'); } });
  service.recipientStatus = new RecipientDeliveryCoordinator(service, { connectionState: peer => store.connectionState(peer),
    relayForPeer: peer => { const c = store.listConnections().find(c => c.peerOwnerDid === peer); return c && 'relayUrl' in c ? c.relayUrl : undefined; } });
  review.store.setTransitionSink(service.recipientStatus.transition);
  return service;
}

export type RecipientDeliveryCoordinator = Pick<RecipientDeliveryCoordinatorImplementation, keyof RecipientDeliveryCoordinatorImplementation>;
export const RecipientDeliveryCoordinator: {
  new(service: GatewayDeliveryService, options?: DeliveryStatusOptions): RecipientDeliveryCoordinator;
  readonly prototype: RecipientDeliveryCoordinator;
} = RecipientDeliveryCoordinatorImplementation;
