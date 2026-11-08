// SPDX-License-Identifier: Apache-2.0
import { DeliveryStatusRouter } from './delivery-status-router.js';
import { RecipientDeliveryCoordinator } from './delivery-status.js';
import { randomUUID } from 'node:crypto';
import { digest } from '@acp/core';
import type { KeyPair, SignedEnvelope } from '@acp/core';
import { isTransientRelayError, relayDeadline, RelayAdmissionError, RelayDuplicateEnvelopeError, waitForRelayRetry } from '@acp/relay';
import type { RelayTransport } from '@acp/relay';
import type { IdentityStoreOptions } from './key-store.js';
import { DeliveryStore } from './delivery-store.js';
import type { DeliveryWrite, PreparedDeliveryWrite } from './delivery-store.js';
import { deliveryError, DELIVERY_RETENTION_MS, requireDelivery } from './delivery-records.js';
import type { DeliveryLimits, MessageRecordV1, MessageStatus, OutboxRecordV1 } from './delivery-records.js';

export interface DeliveryContext {
  messageId: string; peerOwnerDid: string; relayUrl: string; deliveryDeadline: number;
  kind?: OutboxRecordV1['kind'];
  message?: { taskId: string; peerAgentDid: string; protocolVersion: '0.1.0' | '0.2.0'; operationId?: string };
}
export interface GatewayDeliveryOptions {
  identityOptions?: IdentityStoreOptions;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  limits?: Partial<DeliveryLimits>;
  resolveTransport: (relayUrl: string, owner: KeyPair) => RelayTransport | Promise<RelayTransport>;
  assertSendAllowed?: (context: OutboxRecordV1) => void | Promise<void>;
  /** Check retained relay bindings before starting a status reader. */
  assertReceiveAllowed?: (relayUrl: string) => void | Promise<void>;
  requestTimeoutMs?: number;
  onError?: (error: Error) => void;
  timers?: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>;
}
const delays = [60_000, 300_000, 900_000, 3_600_000];
export function outboxRetryDelay(attemptCount: number): number { return delays[Math.min(Math.max(attemptCount - 1, 0), 3)]; }
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code)) return code;
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(message) ? message : 'RELAY_UNAVAILABLE';
}

/** Durable transport admission, independent of task execution and owner decisions. */
class GatewayDeliveryServiceImplementation {
  readonly store: DeliveryStore;
  readonly statusRouter: DeliveryStatusRouter;
  recipientStatus: RecipientDeliveryCoordinator;
  private controller = new AbortController();
  private active = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly attempts = new Map<string, Promise<void>>();
  private readonly terminalErrors = new Map<string, Error>();
  private readonly maintenance = new Set<(signal: AbortSignal) => void | Promise<void>>();
  onMaintenance(callback: (signal: AbortSignal) => void | Promise<void>): void { this.maintenance.add(callback); }
  private readonly sleep: NonNullable<GatewayDeliveryOptions['sleep']>;
  private readonly timers: NonNullable<GatewayDeliveryOptions['timers']>;
  constructor(readonly owner: KeyPair, readonly options: GatewayDeliveryOptions) {
    this.store = new DeliveryStore(owner, { ...options.identityOptions, now: options.now, limits: options.limits });
    this.statusRouter = new DeliveryStatusRouter(this);
    this.recipientStatus = new RecipientDeliveryCoordinator(this);
    this.sleep = options.sleep ?? waitForRelayRetry; this.timers = options.timers ?? globalThis;
  }
  async start(): Promise<void> {
    if (this.active) return;
    if (this.controller.signal.aborted) this.controller = new AbortController();
    this.active = true;
    if (this.store.ids('observations', e => this.report(e)).length) await this.prepare();
    this.recipientStatus.reconcile();
    // Do not create an empty store during lifecycle-only startup.
    if (this.store.ids('observations', e => this.report(e)).length || this.store.ids('batches', e => this.report(e)).length || this.store.ids('receipts', e => this.report(e)).length || this.store.ids('messages', e => this.report(e)).length)
      await this.store.maintainInBackground(error => this.report(error), this.controller.signal);
    for (const callback of this.maintenance) { this.controller.signal.throwIfAborted(); await callback(this.controller.signal); }
    await this.drainDue(this.controller.signal);
    await this.statusRouter.start();
    this.schedule();
  }
  stop(): void {
    this.active = false;
    this.statusRouter.stop();
    this.timers.clearTimeout(this.timer);
    this.controller.abort(deliveryError('OUTBOX_STOPPED'));
    this.terminalErrors.clear();
  }
  private report(error: unknown): void {
    const normalized = deliveryError(errorCode(error));
    if (this.options.onError) this.options.onError(normalized);
    else console.warn(normalized.message);
  }
  private schedule(): void {
    if (!this.active) return;
    this.timer = this.timers.setTimeout(() => {
      void this.prepare().then(() => this.recipientStatus.reconcile()).then(() => this.drainDue(this.controller.signal)).then(async () => {
        void this.statusRouter.refresh().catch(e => this.report(e));
        await this.store.maintainInBackground(error => this.report(error), this.controller.signal);
        for (const id of this.terminalErrors.keys()) {
          await new Promise<void>(resolve => setImmediate(resolve));
          this.controller.signal.throwIfAborted();
          if (!this.store.read('outbox', id)) this.terminalErrors.delete(id);
        }
        for (const callback of this.maintenance) { this.controller.signal.throwIfAborted(); await callback(this.controller.signal); }
      }).catch(e => this.report(e)).finally(() => this.schedule());
    }, 60_000);
    this.timer.unref?.();
  }
  async prepare(signal?: AbortSignal): Promise<void> {
    await this.store.prepare(AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]));
  }
  private buildBatch(prepared: readonly SignedEnvelope[], context: DeliveryContext) {
    const frames = structuredClone(prepared), c = structuredClone(context);
    const now = this.store.now(), batchId = randomUUID();
    requireDelivery(frames.length >= 1 && frames.length <= 2 && (c.kind !== 'delivery-status' || frames.length === 1));
    requireDelivery(frames.length !== 2 || frames[1].payload.eventType === 'AUDIT_ENTRY' &&
      frames[1].payload.seq === frames[0].payload.seq + 1 && frames[1].payload.taskId === frames[0].payload.taskId);
    const records: OutboxRecordV1[] = frames.map(e => ({ version: 1, envelopeId: e.payload.envelopeId,
      messageId: c.messageId, batchId, kind: c.kind ?? 'task', localOwnerDid: this.owner.did,
      peerOwnerDid: c.peerOwnerDid, relayUrl: c.relayUrl, envelopeDigest: digest(e), envelope: e,
      createdAt: now, deliveryDeadline: c.deliveryDeadline, state: 'pending', attemptCount: 0, nextAttemptAt: now,
      ordinal: e.payload.seq }));
    const first = frames[0];
    const message: MessageRecordV1 | undefined = c.message ? { version: 1, messageId: c.messageId,
      localOwnerDid: this.owner.did, peerOwnerDid: c.peerOwnerDid, peerAgentDid: c.message.peerAgentDid,
      taskId: c.message.taskId, relayUrl: c.relayUrl, protocolVersion: c.message.protocolVersion,
      createdAt: now, deliveryDeadline: c.deliveryDeadline, retainUntil: Math.max(now, c.deliveryDeadline) + DELIVERY_RETENTION_MS,
      status: 'queued', updatedAt: now, proposalEnvelopeDigest: digest(first),
      ...(c.message.operationId ? { operationId: c.message.operationId } : {}) } : undefined;
    if (message) requireDelivery(first.payload.eventType === 'PROPOSE' && first.payload.envelopeId === c.messageId && first.payload.taskId === message.taskId);
    const marker = { version: 1 as const, batchId, messageId: c.messageId, localOwnerDid: this.owner.did,
      envelopeIds: records.map(r => r.envelopeId), createdAt: now, committed: true as const };
    return { records, message, marker };
  }
  private batchOperation(message?: MessageRecordV1) {
    if (!message?.operationId) return;
    const operation = this.store.read('operations', message.operationId);
    const action = operation?.preparedActions.find(a => a.manifest.taskId === message.taskId);
    requireDelivery(operation && operation.phase !== 'finished' && action &&
      operation.approvals?.some(a => a.childIndex === action.childIndex) &&
      action.peerOwnerDid === message.peerOwnerDid && action.peerAgentDid === message.peerAgentDid &&
      action.relayUrl === message.relayUrl &&
      Date.parse(action.manifest.deadline) === message.deliveryDeadline);
    const prior = JSON.stringify(operation);
    action.messageId = message.messageId;
    operation.messageIds = operation.preparedActions.flatMap(a => a.messageId ? [a.messageId] : []); operation.phase = 'sending';
    return { prior, record: operation };
  }
  private publishBatch({ records, message, marker }: ReturnType<GatewayDeliveryServiceImplementation['buildBatch']>, prepared?: PreparedDeliveryWrite[],
    operation?: ReturnType<GatewayDeliveryServiceImplementation['batchOperation']>): string[] | undefined {
    const publish = (write: DeliveryWrite) => {
      if (prepared) this.store.publishWrite(prepared.find(p => p.kind === write.kind && p.id === write.id)!);
      else this.store.write(write.kind, write.id, write.record);
    };
    const ids = this.store.transaction(() => {
      if (operation && JSON.stringify(this.store.read('operations', operation.record.operationId)) !== operation.prior) return;
      return this.publishBatchLocked({ records, message, marker }, publish, operation);
    });
    if (ids) void this.statusRouter.refresh().catch(e => this.report(e));
    return ids;
  }
  private publishBatchLocked({ records, message, marker }: ReturnType<GatewayDeliveryServiceImplementation['buildBatch']>,
    publish: (write: DeliveryWrite) => void,
    operation?: ReturnType<GatewayDeliveryServiceImplementation['batchOperation']>): string[] {
    this.store.assertCapacity(records, message);
    for (const r of records) {
      const prior = this.store.read('outbox', r.envelopeId);
      if (prior) throw deliveryError('DELIVERY_RECORD_CONFLICT');
      publish({ kind: 'outbox', id: r.envelopeId, record: r });
    }
    if (message) {
      const prior = this.store.read('messages', message.messageId);
      if (prior) throw deliveryError('DELIVERY_RECORD_CONFLICT');
      publish({ kind: 'messages', id: message.messageId, record: message });
    }
    if (operation) publish({ kind: 'operations', id: operation.record.operationId, record: operation.record });
    publish({ kind: 'batches', id: marker.batchId, record: marker });
    this.store.committed(marker.batchId);
    return records.map(r => r.envelopeId);
  }
  private batchWrites(batch: ReturnType<GatewayDeliveryServiceImplementation['buildBatch']>): DeliveryWrite[] {
    const writes: DeliveryWrite[] = batch.records.map(record => ({ kind: 'outbox', id: record.envelopeId, record }));
    if (batch.message) writes.push({ kind: 'messages', id: batch.message.messageId, record: batch.message });
    writes.push({ kind: 'batches', id: batch.marker.batchId, record: batch.marker });
    return writes;
  }
  /** Publish all immutable members before the batch marker makes any member dispatchable. */
  enqueue(prepared: readonly SignedEnvelope[], context: DeliveryContext): string[] {
    const batch = this.buildBatch(prepared, context);
    if (!batch.message?.operationId) return this.publishBatch(batch)!;
    for (;;) {
      const operation = this.batchOperation(batch.message)!;
      const update = this.store.prepareWritesSync([...this.batchWrites(batch),
        { kind: 'operations', id: operation.record.operationId, record: operation.record }]);
      try {
        // Complete synchronous keyed writes before acquiring the publication lock.
        const ids = this.publishBatch(batch, update, operation);
        if (ids) return ids;
      } finally { this.store.discardWrites(update); }
    }
  }
  /** Independent batches write concurrently without holding the signer lock or blocking relay readers. */
  async enqueuePrepared(frames: readonly SignedEnvelope[], context: DeliveryContext, signal?: AbortSignal): Promise<string[]> {
    const batch = this.buildBatch(frames, context);
    const prepared = await this.store.prepareWrites(this.batchWrites(batch));
    try {
      // A concurrent writer (another process closing a held attempt) changes the
      // directory stamp. preparedMode then refuses to scan inside the lock.
      // Refresh outside the lock instead of failing the new batch permanently.
      let busy = 0;
      for (;;) {
        const operation = this.batchOperation(batch.message);
        const update = operation ? await this.store.prepareWrites([{ kind: 'operations', id: operation.record.operationId, record: operation.record }]) : [];
        try {
          await this.prepare(signal);
          try {
            const ids = this.publishBatch(batch, [...prepared, ...update], operation);
            if (ids) return ids;
          } catch (error) {
            if (!(error instanceof Error) || error.message !== 'OUTBOX_STORE_BUSY' || ++busy > 3) throw error;
          }
        } finally { this.store.discardWrites(update); }
      }
    } finally { this.store.discardWrites(prepared); }
  }
  /** C4 stages status frames and observation references in one prepared transaction. */
  enqueueLocked(frames: readonly SignedEnvelope[], context: DeliveryContext): string[] {
    return this.publishBatchLocked(this.buildBatch(frames, context), write => this.store.write(write.kind, write.id, write.record));
  }
  private async ordered(signal: AbortSignal): Promise<OutboxRecordV1[]> {
    const records: OutboxRecordV1[] = [];
    for (const id of this.store.ids('batches', e => this.report(e))) {
      await new Promise<void>(resolve => setImmediate(resolve));
      signal.throwIfAborted();
      try { records.push(...this.store.committed(id)); }
      catch (error) { this.report(error); }
    }
    return records.sort((a, b) => a.createdAt - b.createdAt || a.ordinal - b.ordinal);
  }
  /** Cleanup can be retried by maintenance after admission has already completed. */
  finishBatch(batchId: string): void {
    try { this.store.transaction(() => this.store.finishBatch(batchId)); }
    catch (error) { this.report(error); }
  }
  async drainDue(signal?: AbortSignal): Promise<void> {
    const combined = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
    for (const r of await this.ordered(combined)) {
      await new Promise<void>(resolve => setImmediate(resolve));
      combined.throwIfAborted();
      try { await this.attempt(r.envelopeId, combined); } catch (error) { this.report(error); }
    }
  }
  /** One attempt per due control frame; background lifecycle owns subsequent retries. */
  async drainStatuses(): Promise<void> {
    try { await this.prepare(); } catch (error) { this.report(error); return; }
    for (const r of this.store.statusOutbox().sort((a, b) => a.createdAt - b.createdAt || a.ordinal - b.ordinal)) {
      if (this.controller.signal.aborted) return;
      try {
        await this.attempt(r.envelopeId, this.controller.signal);
        if (!this.controller.signal.aborted) this.finishBatch(r.batchId);
      } catch (error) { if (!this.controller.signal.aborted) this.report(error); }
    }
  }
  async sendPrepared(envelopeId: string, signal?: AbortSignal): Promise<void> {
    const combined = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
    for (;;) {
      combined.throwIfAborted();
      const r = this.store.read('outbox', envelopeId);
      if (!r) throw this.terminalErrors.get(envelopeId) ?? deliveryError('OUTBOX_STORE_INVALID');
      const committed = this.store.committed(r.batchId);
      if (!committed.some(member => member.envelopeId === envelopeId)) throw deliveryError('OUTBOX_STORE_INVALID');
      if (r.state === 'admitted') return;
      if (r.state === 'closed') throw this.terminalErrors.get(envelopeId) ?? deliveryError(r.lastError ?? 'OUTBOX_DEADLINE_EXPIRED');
      await this.attempt(envelopeId, combined);
      const next = this.store.read('outbox', envelopeId);
      if (next?.state === 'pending') {
        const blockers = await this.retryBusy(combined, () => this.store.pending(next.messageId).filter(other => other.kind === next.kind && other.ordinal < next.ordinal));
        const time = Math.min(next.deliveryDeadline, Math.max(next.nextAttemptAt, next.lease?.until ?? 0,
          ...blockers.map(r => Math.max(r.nextAttemptAt, r.lease?.until ?? this.store.now() + 60_000))));
        await this.sleep(Math.max(1, time - this.store.now()), combined);
      }
    }
  }
  /** Another publisher invalidated the prepared index. Rebuild outside the signer lock, then retry. */
  private async retryBusy<T>(signal: AbortSignal, operation: () => T): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return operation(); }
      catch (error) {
        last = error;
        if (attempt === 2 || !(error instanceof Error) || error.message !== 'OUTBOX_STORE_BUSY') throw error;
        await this.prepare(signal);
      }
    }
    throw last;
  }
  private attempt(id: string, signal: AbortSignal): Promise<void> {
    const prior = this.attempts.get(id);
    if (prior) return prior;
    const run = this.attemptOnce(id, signal).finally(() => this.attempts.delete(id));
    this.attempts.set(id, run); return run;
  }
  private async attemptOnce(id: string, signal: AbortSignal): Promise<void> {
    await this.prepare(signal);
    const holderId = randomUUID();
    const claimed = await this.retryBusy(signal, () => this.store.transaction(() => {
      const r = this.store.read('outbox', id);
      if (!r || r.state !== 'pending') return;
      const batch = this.store.committed(r.batchId);
      if (!batch.length) return;
      const now = this.store.now();
      // Suppression/expiry bookkeeping can replay; every attempt rechecks disclosure and deadline.
      if (r.kind === 'delivery-status' && !this.recipientStatus.dispatchAllowed(r)) {
        this.store.write('outbox', id, { ...r, state: 'closed', lastError: 'DELIVERY_STATUS_NOT_SUPPORTED' }); return;
      }
      if (now >= r.deliveryDeadline) {
        if (r.kind === 'delivery-status') this.store.write('outbox', id, { ...r, state: 'closed', lastError: 'OUTBOX_DEADLINE_EXPIRED' });
        else this.closeLocked(r.messageId, 'OUTBOX_DEADLINE_EXPIRED', 'deadline');
        return;
      }
      if (r.nextAttemptAt > now || r.lease && r.lease.until > now) return;
      if (this.store.pending(r.messageId).some(other => other.kind === r.kind && (other.ordinal < r.ordinal || other.envelopeId !== id && other.lease && other.lease.until > now))) return;
      const next = { ...r, lease: { holderId, until: now + 60_000 }, attemptCount: r.attemptCount + 1 };
      // A lost lease or attempt counter only repeats the same immutable envelope.
      this.store.write('outbox', id, next); return next;
    }));
    if (!claimed) return;
    let error: unknown, admitted = false, relayDid: string | undefined;
    try {
      const ceiling = Math.min(this.options.requestTimeoutMs ?? 45_000, 45_000, claimed.deliveryDeadline - this.store.now());
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, ceiling))]);
      await relayDeadline((async () => {
        attemptSignal.throwIfAborted();
        await this.options.assertSendAllowed?.(structuredClone(claimed));
        attemptSignal.throwIfAborted();
        if (claimed.kind === 'delivery-status' && !this.recipientStatus.dispatchAllowed(claimed)) throw deliveryError('DELIVERY_STATUS_NOT_SUPPORTED');
        const relay = await this.options.resolveTransport(claimed.relayUrl, this.owner);
        attemptSignal.throwIfAborted();
        if (this.store.now() >= claimed.deliveryDeadline) throw deliveryError('OUTBOX_DEADLINE_EXPIRED');
        if (claimed.kind === 'delivery-status' && !this.recipientStatus.dispatchAllowed(claimed)) throw deliveryError('DELIVERY_STATUS_NOT_SUPPORTED');
        await relay.send(structuredClone(claimed.envelope));
        relayDid = relay.getDeliveryStatusPin?.(claimed.envelopeId);
      })(), Math.max(1, ceiling), signal);
      admitted = true;
    } catch (e) {
      error = e;
      const value = e as RelayDuplicateEnvelopeError;
      admitted = e instanceof Error && e.name === 'RelayDuplicateEnvelopeError' && value.code === 'REPLAYED_ENVELOPE' &&
        value.status === 400 && e.message === 'RELAY_REJECTED: 400';
    }
    // Leave an interrupted attempt's lease for bounded recovery; shutdown does not publish an outcome.
    signal.throwIfAborted();
    await this.prepare(signal);
    await this.retryBusy(signal, () => this.store.transaction(() => {
      const r = this.store.read('outbox', id);
      if (!r || r.state !== 'pending' || r.lease?.holderId !== holderId) return;
      delete r.lease;
      const now = this.store.now();
      if (admitted) {
        r.state = 'admitted'; r.admittedAt = now; delete r.lastError;
        if (relayDid) r.relayDid = relayDid;
        const m = r.kind === 'task' && this.store.read('messages', r.messageId);
        if (m && r.envelopeId === m.messageId && m.status === 'queued') this.store.write('messages', m.messageId, { ...m, status: 'relayed', updatedAt: now });
      } else if (now >= r.deliveryDeadline || !isTransientRelayError(error)) {
        if (error instanceof Error && now < r.deliveryDeadline) this.terminalErrors.set(id, error);
        const code = now >= r.deliveryDeadline ? 'OUTBOX_DEADLINE_EXPIRED' : errorCode(error);
        if (r.kind === 'delivery-status') this.store.write('outbox', id, { ...r, state: 'closed', lastError: code });
        else this.closeLocked(r.messageId, code, now >= r.deliveryDeadline ? 'deadline' : 'local');
        return;
      } else {
        r.lastError = errorCode(error);
        const detail = error as RelayAdmissionError;
        const hint = error instanceof Error && error.name === 'RelayAdmissionError' && detail.status === 429 &&
          detail.code === 'RELAY_RETRY_LATER' && Number.isSafeInteger(detail.retryAfterMs) &&
          detail.retryAfterMs! > 0 && detail.retryAfterMs! <= 3_600_000 ? detail.retryAfterMs! : 0;
        r.nextAttemptAt = Math.min(r.deliveryDeadline, now + Math.max(outboxRetryDelay(r.attemptCount), hint));
      }
      // Admission and retry scheduling may be replayed after interruption; enqueue remains published.
      this.store.write('outbox', id, r);
    }));
    if (signal.aborted) signal.throwIfAborted();
  }
  private closeLocked(messageId: string, code: string, closedBy: 'deadline' | 'local' | 'peer'): void {
    const now = this.store.now();
    for (const summary of this.store.pending(messageId)) if (summary.kind === 'task') {
      const r = this.store.read('outbox', summary.envelopeId)!;
      const next = { ...r, state: 'closed' as const, lastError: code }; delete next.lease;
      this.store.write('outbox', r.envelopeId, next);
    }
    const m = this.store.read('messages', messageId);
    if (m && ['queued', 'relayed'].includes(m.status)) this.store.write('messages', messageId, { ...m, status: 'closed', closedBy, lastError: code, updatedAt: now });
  }
  closeMessage(messageId: string, code = 'CANCELLED'): void {
    this.store.transaction(() => this.closeLocked(messageId, code, code === 'OUTBOX_DEADLINE_EXPIRED' ? 'deadline' : 'local'));
  }
  markPeerObserved(messageId: string, observation: { status: MessageStatus; envelopeId: string; replyEnvelopeId?: string }): void {
    const change = () => {
      const m = this.store.read('messages', messageId);
      requireDelivery(observation.envelopeId === messageId);
      const r = this.store.read('outbox', messageId);
      if (r?.state === 'pending') {
        const next = { ...r, state: 'admitted' as const, admittedAt: this.store.now() }; delete next.lease;
        this.store.write('outbox', r.envelopeId, next);
      }
      if (m && (['queued', 'relayed'].includes(m.status) || observation.status === 'replied'))
        this.store.write('messages', messageId, { ...m, status: observation.status, updatedAt: this.store.now(),
          ...(observation.replyEnvelopeId ? { replyEnvelopeId: observation.replyEnvelopeId } : {}) });
    };
    if (observation.replyEnvelopeId) this.store.preparedTransaction(change);
    else this.store.transaction(change);
  }
}
/** Structural public interface permits source and built hosts to share a service. */
export type GatewayDeliveryService = Pick<GatewayDeliveryServiceImplementation, keyof GatewayDeliveryServiceImplementation>;
export const GatewayDeliveryService: {
  new(owner: KeyPair, options: GatewayDeliveryOptions): GatewayDeliveryService;
  readonly prototype: GatewayDeliveryService;
} = GatewayDeliveryServiceImplementation;
