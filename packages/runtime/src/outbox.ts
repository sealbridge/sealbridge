// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { digest } from '@acp/core';
import type { KeyPair, SignedEnvelope } from '@acp/core';
import { isTransientRelayError, relayDeadline, RelayAdmissionError, RelayDuplicateEnvelopeError, waitForRelayRetry } from '@acp/relay';
import type { RelayTransport } from '@acp/relay';
import type { IdentityStoreOptions } from './key-store.js';
import { DeliveryStore } from './delivery-store.js';
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
  private controller = new AbortController();
  private active = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly attempts = new Map<string, Promise<void>>();
  private readonly terminalErrors = new Map<string, Error>();
  private readonly maintenance = new Set<() => void>();
  onMaintenance(callback: () => void): void { this.maintenance.add(callback); }
  private readonly sleep: NonNullable<GatewayDeliveryOptions['sleep']>;
  private readonly timers: NonNullable<GatewayDeliveryOptions['timers']>;
  constructor(readonly owner: KeyPair, readonly options: GatewayDeliveryOptions) {
    this.store = new DeliveryStore(owner, { ...options.identityOptions, now: options.now, limits: options.limits });
    this.sleep = options.sleep ?? waitForRelayRetry; this.timers = options.timers ?? globalThis;
  }
  async start(): Promise<void> {
    if (this.active) return;
    if (this.controller.signal.aborted) this.controller = new AbortController();
    this.active = true;
    // Do not create an empty store during lifecycle-only startup.
    if (this.store.ids('batches', e => this.report(e)).length || this.store.ids('receipts', e => this.report(e)).length || this.store.ids('messages', e => this.report(e)).length)
      this.store.maintain(error => this.report(error));
    for (const callback of this.maintenance) callback();
    await this.drainDue(this.controller.signal);
    this.schedule();
  }
  stop(): void {
    this.active = false;
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
      void this.drainDue(this.controller.signal).then(() => {
        this.store.maintain(error => this.report(error));
        for (const id of this.terminalErrors.keys()) if (!this.store.read('outbox', id)) this.terminalErrors.delete(id);
        for (const callback of this.maintenance) callback();
      }).catch(e => this.report(e)).finally(() => this.schedule());
    }, 60_000);
    this.timer.unref?.();
  }
  /** Publish all immutable members before the batch marker makes any member dispatchable. */
  enqueue(prepared: readonly SignedEnvelope[], context: DeliveryContext): string[] {
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
    this.store.transaction(() => {
      if (message) requireDelivery(first.payload.eventType === 'PROPOSE' && first.payload.envelopeId === c.messageId && first.payload.taskId === message.taskId);
      this.store.assertCapacity(records, message);
      for (const r of records) {
        const prior = this.store.read('outbox', r.envelopeId);
        if (prior) throw deliveryError('DELIVERY_RECORD_CONFLICT');
        this.store.write('outbox', r.envelopeId, r);
      }
      if (message) {
        const prior = this.store.read('messages', message.messageId);
        if (prior) throw deliveryError('DELIVERY_RECORD_CONFLICT');
        this.store.write('messages', message.messageId, message);
      }
      const marker = { version: 1 as const, batchId, messageId: c.messageId, localOwnerDid: this.owner.did,
        envelopeIds: records.map(r => r.envelopeId), createdAt: now, committed: true as const };
      this.store.write('batches', batchId, marker);
      this.store.committed(batchId);
    });
    return records.map(r => r.envelopeId);
  }
  private ordered(): OutboxRecordV1[] {
    const records: OutboxRecordV1[] = [];
    for (const id of this.store.ids('batches', e => this.report(e))) {
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
    for (const r of this.ordered()) {
      combined.throwIfAborted();
      try { await this.attempt(r.envelopeId, combined); } catch (error) { this.report(error); }
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
        const blockers = this.ordered().filter(other => other.messageId === next.messageId && other.state === 'pending' && other.ordinal < next.ordinal);
        const time = Math.min(next.deliveryDeadline, Math.max(next.nextAttemptAt, next.lease?.until ?? 0,
          ...blockers.map(r => Math.max(r.nextAttemptAt, r.lease?.until ?? this.store.now() + 60_000))));
        await this.sleep(Math.max(1, time - this.store.now()), combined);
      }
    }
  }
  private attempt(id: string, signal: AbortSignal): Promise<void> {
    const prior = this.attempts.get(id);
    if (prior) return prior;
    const run = this.attemptOnce(id, signal).finally(() => this.attempts.delete(id));
    this.attempts.set(id, run); return run;
  }
  private async attemptOnce(id: string, signal: AbortSignal): Promise<void> {
    const holderId = randomUUID();
    const claimed = this.store.transaction(() => {
      const r = this.store.read('outbox', id);
      if (!r || r.state !== 'pending') return;
      const batch = this.store.committed(r.batchId);
      if (!batch.length) return;
      const now = this.store.now();
      if (now >= r.deliveryDeadline) {
        if (r.kind === 'delivery-status') this.store.write('outbox', id, { ...r, state: 'closed', lastError: 'OUTBOX_DEADLINE_EXPIRED' });
        else this.closeLocked(r.messageId, 'OUTBOX_DEADLINE_EXPIRED', 'deadline');
        return;
      }
      if (r.nextAttemptAt > now || r.lease && r.lease.until > now) return;
      if (this.ordered().some(other => other.messageId === r.messageId && other.state === 'pending' &&
        (other.ordinal < r.ordinal || other.envelopeId !== id && other.lease && other.lease.until > now))) return;
      const next = { ...r, lease: { holderId, until: now + 60_000 }, attemptCount: r.attemptCount + 1 };
      this.store.write('outbox', id, next); return next;
    });
    if (!claimed) return;
    let error: unknown, admitted = false, relayDid: string | undefined;
    try {
      const ceiling = Math.min(this.options.requestTimeoutMs ?? 45_000, 45_000, claimed.deliveryDeadline - this.store.now());
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, ceiling))]);
      await relayDeadline((async () => {
        attemptSignal.throwIfAborted();
        await this.options.assertSendAllowed?.(structuredClone(claimed));
        attemptSignal.throwIfAborted();
        const relay = await this.options.resolveTransport(claimed.relayUrl, this.owner);
        attemptSignal.throwIfAborted();
        if (this.store.now() >= claimed.deliveryDeadline) throw deliveryError('OUTBOX_DEADLINE_EXPIRED');
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
    this.store.transaction(() => {
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
        this.store.write('outbox', id, r);
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
      this.store.write('outbox', id, r);
    });
    if (signal.aborted) signal.throwIfAborted();
  }
  private closeLocked(messageId: string, code: string, closedBy: 'deadline' | 'local' | 'peer'): void {
    const now = this.store.now();
    for (const r of this.store.snapshot('outbox', e => this.report(e))) if (r.messageId === messageId && r.kind === 'task' && r.state === 'pending') {
      const next = { ...r, state: 'closed' as const, lastError: code }; delete next.lease;
      this.store.write('outbox', r.envelopeId, next);
    }
    const m = this.store.read('messages', messageId);
    if (m && ['queued', 'relayed'].includes(m.status)) this.store.write('messages', messageId, { ...m, status: 'closed', closedBy, lastError: code, updatedAt: now });
  }
  closeMessage(messageId: string, code = 'CANCELLED'): void {
    this.store.transaction(() => this.closeLocked(messageId, code, code === 'OUTBOX_DEADLINE_EXPIRED' ? 'deadline' : 'local'));
  }
  markPeerObserved(messageId: string, observation: { status: MessageStatus; envelopeId: string }): void {
    this.store.transaction(() => {
      const m = this.store.read('messages', messageId);
      requireDelivery(observation.envelopeId === messageId);
      for (const r of this.store.snapshot('outbox', e => this.report(e))) if (r.envelopeId === messageId && r.state === 'pending') {
        const next = { ...r, state: 'admitted' as const, admittedAt: this.store.now() }; delete next.lease;
        this.store.write('outbox', r.envelopeId, next);
      }
      if (m && (['queued', 'relayed'].includes(m.status) || observation.status === 'replied'))
        this.store.write('messages', messageId, { ...m, status: observation.status, updatedAt: this.store.now() });
    });
  }
}
/** Structural public interface permits source and built hosts to share a service. */
export type GatewayDeliveryService = Pick<GatewayDeliveryServiceImplementation, keyof GatewayDeliveryServiceImplementation>;
export const GatewayDeliveryService: {
  new(owner: KeyPair, options: GatewayDeliveryOptions): GatewayDeliveryService;
  readonly prototype: GatewayDeliveryService;
} = GatewayDeliveryServiceImplementation;
