import { relayRetryCode } from '@acp/relay';
// SPDX-License-Identifier: Apache-2.0
import {
  digest,
  openEnvelope,
  signAck,
  signEnvelope,
  signPayload,
  validateSchema,
  verifyEnvelope,
  verifySigned,
  verifySignature,
  contextGrantAuditPayload,
} from '@acp/core';
import type { ContextGrant, ContextGrantAuditEventType } from '@acp/core';
import { appendContextGrantAuditEvent, CONTEXT_GRANT_AUDIT_EVENTS, contextSessionAuditPayload } from './context-grant-audit.js';
import type { AckReceipt, Json, KeyPair, Signed, SignedEnvelope, Transition } from '@acp/core';
import { JsonlStore, verifyAudit } from '@acp/ledger';
import type { AuditBody, AuditBundle, AuditEntry, Checkpoint } from '@acp/ledger';
import { RelayEnvelopeExpiredError, isTransientRelayError, relayRetryDelay, waitForRelayRetry, relayDeadline } from '@acp/relay';
import type { RelayConnectionStatus } from '@acp/relay';
import type { RelayReceiveFilter, RelayTransport } from '@acp/relay';
import type { ProgressPayload } from './adapter.js';
import type { ErrorDetail, SessionResult } from './session.js';
import type { GatewayDeliveryService, DeliveryContext } from './outbox.js';
import { deliveryError } from './delivery-records.js';
export interface WireDelivery {
  service: GatewayDeliveryService;
  context: DeliveryContext;
}
/** Only known limit codes and a validated timestamp may become requester text. */
export function fixedLimitBody(body: Json): Json {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const messages: Record<string, string> = {
    MONTHLY_LIMIT_REACHED: 'The monthly intake limit is reached. It resets on the 1st at 00:00 UTC (09:00 JST). 今月の受付上限に達しました。翌月1日 9:00 JST（UTC 0時）に戻ります。',
    MONTHLY_STATE_UNAVAILABLE: 'Monthly counting state is unavailable; task rejected. 月次の使用量状態を利用できないため、依頼を拒否しました。',
    MONTHLY_MODEL_UNSUPPORTED: 'The worker cannot accept this request right now. ワーカーは現在この依頼を受け付けられません。',
    INPUT_SIZE_LIMIT_REACHED: 'This input exceeds the worker’s size limit. Split it into smaller parts. この入力はワーカーのサイズ上限を超えています。小さく分けて送ってください。',
    INPUT_BUDGET_EXCEEDED: 'This request exceeds its input-token budget. Reduce the input or submit it with a sufficient budget. この依頼は入力トークン予算を超えています。入力を減らすか、十分な予算で送ってください。',
    INPUT_SIZE_UNAVAILABLE: 'Input size could not be verified; task rejected. 入力の大きさを確認できないため、依頼を拒否しました。',
    AUTO_ACCEPT_DAILY_LIMIT_REACHED: 'Today’s free allowance is exhausted. It resets at 09:00 Japan time (00:00 UTC). 今日の無料分は使い切りました。日本時間の朝9時（UTC 0時）に戻ります。',
    DAILY_LIMIT_REACHED: 'The daily task limit is reached. It resets at 00:00 UTC. 1日の件数上限に達しました。UTC 0時に戻ります。',
    INTAKE_RATE_LIMITED: 'Too many requests. Please try later. 依頼が多すぎます。時間をおいて試してください。',
  };
  const code = typeof body.code === 'string' ? body.code : '';
  if (!Object.hasOwn(messages, code)) return body;
  const resetAt = ['MONTHLY_LIMIT_REACHED', 'AUTO_ACCEPT_DAILY_LIMIT_REACHED', 'DAILY_LIMIT_REACHED'].includes(code) &&
    typeof body.resetAt === 'string' && /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(body.resetAt) &&
    (code !== 'MONTHLY_LIMIT_REACHED' || body.resetAt.slice(8, 10) === '01') &&
    Number.isFinite(Date.parse(body.resetAt)) && new Date(body.resetAt).toISOString() === body.resetAt ? body.resetAt : undefined;
  const message = code === 'MONTHLY_LIMIT_REACHED' && body.messageKind === 'trial-reviewer'
    ? "The trial reviewer reached this month's limit and is paused until the 1st at 00:00 UTC. Try sealbridge demo or invite a friend. お試し用レビュアーは今月の上限に達したため、来月1日の日本時間朝9時まで停止しています。sealbridge demo か、友だちへの招待で試せます。"
    : code === 'INPUT_SIZE_LIMIT_REACHED' && body.messageKind === 'trial-reviewer'
      ? 'This diff is too large for the trial reviewer. Split it into smaller parts. この差分はお試し用レビュアーには大きすぎます。小さく分けて送ってください。'
      : messages[code];
  return { code, reason: message + (resetAt ? ' Resumes at ' + resetAt + ' (00:00 UTC / 日本時間の朝9時).' : ''),
    ...(resetAt ? { resetAt } : {}) };
}
/** The peer's signed ERROR, retaining optional diagnostics for programmatic callers. */
export class PeerRejectedError extends Error {
  readonly code?: string;
  readonly retryable?: false;
  readonly pendingId?: string;
  readonly pendingStoreError?: string;
  readonly originalTaskId?: string;
  readonly nextStep?: string;
  readonly detail?: ErrorDetail;
  readonly recovery?: { proposalDigest: string; result?: SessionResult;
    part?: { index: number; count: number; data: string; resultDigest: string } };
  constructor(body: Json) {
    body = fixedLimitBody(body);
    super('PEER_REJECTED: ' + JSON.stringify(body && typeof body === 'object' && !Array.isArray(body) && body.recovery
      ? { code: body.code, recovery: true } : body));
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      if (typeof body.code === 'string') this.code = body.code;
      if (body.code === 'PENDING_OWNER_APPROVAL') this.retryable = false;
      const recovery = body.recovery;
      if (recovery && typeof recovery === 'object' && !Array.isArray(recovery) &&
          typeof recovery.proposalDigest === 'string')
        this.recovery = recovery as unknown as NonNullable<PeerRejectedError['recovery']>;
      const detail = body.detail;
      if (detail && typeof detail === 'object' && !Array.isArray(detail) &&
          typeof detail.field === 'string' && typeof detail.hint === 'string' &&
          typeof detail.expected === 'string' && /^sha256:[a-f0-9]{64}$/.test(detail.expected) &&
          typeof detail.actual === 'string' && /^sha256:[a-f0-9]{64}$/.test(detail.actual))
        this.detail = { field: detail.field, expected: detail.expected, actual: detail.actual, hint: detail.hint };
    }
  }
}
export const asJson = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;
const pause = (signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('SESSION_ABORTED'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, 10);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
export async function receiveRelay(
  relay: RelayTransport,
  did: string,
  signal?: AbortSignal,
  filter?: RelayReceiveFilter,
  onStatus?: (status: RelayConnectionStatus) => void,
  onIdle?: () => Promise<SignedEnvelope | undefined>,
): Promise<SignedEnvelope> {
  let attempt = 0;
  while (true) {
    signal?.throwIfAborted();
    try {
      const e = await relay.receive(did, 1000, signal, { ...filter, lease: relay.acknowledgeDelivery !== undefined });
      onStatus?.('connected');
      attempt = 0;
      if (e) return e;
      const control = await onIdle?.();
      if (control) return control;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? new Error('SESSION_ABORTED');
      if (!isTransientRelayError(error)) { onStatus?.('unavailable'); throw error; }
      onStatus?.('reconnecting');
      console.warn('Relay poll retry ' + (attempt + 1) + ' (' + relayRetryCode(error) + ')');
      await waitForRelayRetry(relayRetryDelay(attempt++), signal);
      continue;
    }
    await pause(signal);
  }
}
/** A lost ack is retried by the HTTP client when the completed envelope is redelivered. */
export async function acknowledgeRelay(relay: RelayTransport, envelope: SignedEnvelope, signal?: AbortSignal): Promise<void> {
  try { await relay.acknowledgeDelivery?.(envelope.payload.recipientDid, envelope.payload.envelopeId, signal); }
  catch (error) { if (!isTransientRelayError(error)) throw error; }
}
interface EnvelopeWaiter {
  allowed: string[];
  resolve: (envelope: SignedEnvelope) => void;
  reject: (error: Error) => void;
}
export interface CancelBody {
  reason: string;
  cancelledBy: string;
  transition: Signed<Transition>;
}
/** Each side has only its own private key. All countersignatures arrive on wire. */
export class SessionWire {
  private outgoing = 0;
  private incoming = 0;
  private readonly recoveryParts = new Map<string, Map<number, Buffer>>();
  /** Opened session views keep the ciphertext envelope so delivery verification can check it. */
  private readonly sealedByView = new WeakMap<SignedEnvelope, SignedEnvelope>();
  private readonly inbox: SignedEnvelope[] = [];
  private readonly inboxWaiters: Array<() => void> = [];
  private readonly stashed: SignedEnvelope[] = [];
  private readonly waiters: EnvelopeWaiter[] = [];
  private readonly waiterAdded: Array<() => void> = [];
  private readonly cancelResolvers: Array<() => void> = [];
  private pumpError?: Error;
  private pumping = false;
  private dispatching = false;
  private detached = false;
  private stopped = false;
  private readonly readController = new AbortController();
  private lastHeartbeat = 0;
  private cancellation?: Promise<void>;
  /** One bilateral send at a time so PROGRESS cannot overtake its own ACK. */
  private sendTail: Promise<void> = Promise.resolve();
  private deliveryTail: Promise<void> = Promise.resolve();
  private readonly receiptAcks = new Map<string, SignedEnvelope>();
  hasCommittedSend = false;
  readonly entries: AuditEntry[] = [];
  onProgress?: (progress: ProgressPayload, envelope: SignedEnvelope) => void | Promise<void>;
  onActivity?: () => void;
  /** Aborts the running task as soon as a CANCEL frame is queued. */
  earlyCancel?: () => void;
  lastCancel?: SignedEnvelope;
  cancelHandled = false;
  constructor(
    readonly relay: RelayTransport,
    readonly owner: KeyPair,
    readonly peerDid: string,
    readonly taskId: string,
    readonly actors: [string, string],
    readonly signal: AbortSignal,
    readonly auditPath?: string,
    /** Legacy in-memory fixtures may open cleartext. Network sessions leave this false. */
    readonly allowUnencryptedEnvelopes = false,
    /** Worker admission may await inspection before seeding the initial PROPOSE. */
    private awaitingInitial = false,
    readonly delivery?: WireDelivery,
    readonly contextGrant?: ContextGrant,
  ) {
    if (!this.awaitingInitial) { this.startPump(); void this.dispatch(); }
  }
  get cancellationStarted(): boolean {
    return this.cancellation !== undefined;
  }
  close(): void {
    this.stopped = true;
    this.readController.abort(new Error('SESSION_CLOSED'));
    this.pumpError ??= new Error('SESSION_CLOSED');
    this.rejectWaiters(this.pumpError);
    for (const wake of this.inboxWaiters.splice(0)) wake();
    for (const wake of this.waiterAdded.splice(0)) wake();
  }
  /** Freeze audit mutation before a local terminal decision, including already-resolved ACKs. */
  async quiesceAudit(): Promise<AuditEntry[]> {
    this.close();
    await Promise.all([this.sendTail, this.deliveryTail.catch(() => {})]);
    return structuredClone(this.entries);
  }
  /** Liveness is signed/encrypted but does not consume audit sequence numbers or extend quota. */
  async heartbeat(): Promise<void> {
    await this.relay.send(signEnvelope({ taskId: this.taskId, recipientDid: this.peerDid,
      seq: 0, eventType: 'HEARTBEAT', payload: { sentAt: Date.now() } }, this.owner, { encrypt: true }));
  }
  /** Keep reading after the caller aborts the session signal, so CANCEL can still be sealed. */
  detachSignal(): void {
    this.detached = true;
    this.pumpError = undefined;
    if (!this.pumping) this.startPump();
  }
  cancelSession(payload?: CancelBody): Promise<void> {
    if (!this.cancellation) {
      if (!payload) return Promise.reject(new Error('CANCEL_PAYLOAD_REQUIRED'));
      this.cancellation = this.sendCancel(payload);
    }
    return this.cancellation;
  }
  waitUntilCancelHandled(): Promise<void> {
    if (this.cancelHandled) return Promise.resolve();
    return new Promise((resolve) => this.cancelResolvers.push(resolve));
  }
  private startPump(): void {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    void this.runPump();
  }
  private async runPump(): Promise<void> {
    try {
      while (!this.stopped) {
        if (!this.detached && this.signal.aborted) throw this.signal.reason ?? new Error('SESSION_ABORTED');
        const envelope = await receiveRelay(
          this.relay,
          this.owner.did,
          AbortSignal.any([this.readController.signal, ...(this.detached ? [] : [this.signal])]),
        );
        if (envelope.payload.eventType === 'DELIVERY_STATUS') {
          try {
            if (this.delivery) await this.delivery.service.statusRouter.route(envelope, this.relay);
            else await acknowledgeRelay(this.relay, envelope);
          } catch (error) { this.delivery?.service.options.onError?.(error as Error); }
          continue;
        }
        if (envelope.payload.eventType === 'CANCEL' && envelope.payload.senderDid === this.peerDid)
          this.earlyCancel?.();
        this.inbox.push(envelope);
        this.inboxWaiters.shift()?.();
      }
    } catch (error) {
      this.pumpError = error instanceof Error ? error : new Error(String(error));
    } finally {
      this.pumping = false;
      this.inboxWaiters.shift()?.();
    }
  }
  private shift(): Promise<SignedEnvelope> {
    const queued = this.inbox.shift();
    if (queued) return Promise.resolve(queued);
    if (this.pumpError) return Promise.reject(this.pumpError);
    return new Promise((resolve, reject) => {
      const wake = () => {
        const next = this.inbox.shift();
        if (next) resolve(next);
        else if (this.pumpError) reject(this.pumpError);
        else this.inboxWaiters.push(wake);
      };
      this.inboxWaiters.push(wake);
    });
  }
  private async nextEnvelope(): Promise<SignedEnvelope> {
    const ready = this.stashed.shift();
    if (ready) return ready;
    for (;;) {
      const sealed = await this.shift();
      const receipt = this.delivery?.service.store.read('receipts', sealed.payload.envelopeId);
      if (receipt) {
        if (!verifyEnvelope(sealed, this.owner.did) || sealed.payload.senderDid !== this.peerDid || receipt.senderDid !== sealed.payload.senderDid ||
          receipt.taskId !== this.taskId || receipt.envelopeDigest !== digest(sealed)) throw deliveryError('DELIVERY_RECORD_CONFLICT');
        if (receipt.state !== 'persisted') {
          const ack = this.receiptAcks.get(sealed.payload.envelopeId);
          if (ack) { try { await this.relay.send(ack); } catch { /* Admission may already be recorded. */ } }
          await acknowledgeRelay(this.relay, sealed, this.signal);
          continue;
        }
      }
      return this.check(sealed);
    }
  }
  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
  private async dispatch(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      for (;;) {
        const envelope = await this.nextEnvelope();
        const type = envelope.payload.eventType;
        if (CONTEXT_GRANT_AUDIT_EVENTS.includes(type as ContextGrantAuditEventType)) {
          validateSchema('context-grant-audit-payload', envelope.payload.payload);
          if (!this.contextGrant || digest(envelope.payload.payload) !== digest(contextGrantAuditPayload(this.contextGrant)))
            throw new Error('CONTEXT_GRANT_AUDIT_CONFLICT');
          await this.acknowledgeControl(envelope);
          continue;
        }
        if (type === 'HEARTBEAT') {
          const sentAt = (envelope.payload.payload as { sentAt?: number }).sentAt;
          if (typeof sentAt !== 'number' || !Number.isSafeInteger(sentAt) || sentAt > Date.now() + 5000)
            throw new Error('INVALID_HEARTBEAT');
          if (sentAt > this.lastHeartbeat && Date.now() - sentAt <= 60_000) {
            this.lastHeartbeat = sentAt;
            this.onActivity?.();
          }
          await acknowledgeRelay(this.relay, this.sealed(envelope), this.detached ? this.readController.signal : this.signal);
          continue;
        }
        this.onActivity?.();
        if (type === 'RECOVERY_PART') {
          await acknowledgeRelay(this.relay, this.sealed(envelope), this.detached ? this.readController.signal : this.signal);
          continue;
        }
        const index = this.waiters.findIndex((waiter) => waiter.allowed.includes(type));
        if (index >= 0) {
          this.waiters.splice(index, 1)[0].resolve(envelope);
          continue;
        }
        if (type === 'PROGRESS') {
          await this.acknowledgeControl(envelope);
          const progress = envelope.payload.payload as unknown as ProgressPayload;
          await this.onProgress?.(progress, envelope);
          continue;
        }
        if (type === 'CANCEL' && envelope.payload.senderDid === this.peerDid) {
          await this.acknowledgeControl(envelope);
          this.lastCancel = envelope;
          this.cancelHandled = true;
          for (const resolve of this.cancelResolvers.splice(0)) resolve();
          this.rejectWaiters(new Error('CANCELLED'));
          continue;
        }
        if (this.waiters.length === 0) {
          this.stashed.push(envelope);
          await new Promise<void>((resolve) => this.waiterAdded.push(resolve));
          continue;
        }
        this.waiters.shift()?.reject(new Error('UNEXPECTED_SESSION_EVENT: ' + type));
      }
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      if (!this.pumpError) this.pumpError = wrapped;
      this.rejectWaiters(wrapped);
      for (const resolve of this.cancelResolvers.splice(0)) resolve();
    } finally {
      this.dispatching = false;
      if (!this.stopped && !this.pumpError && (this.waiters.length > 0 || this.inbox.length > 0))
        void this.dispatch();
    }
  }
  private async watchDelivery(envelope: SignedEnvelope): Promise<void> {
    const signal = this.readController.signal;
    let attempt = 0;
    try {
      while (!signal.aborted && !this.stopped) {
        await waitForRelayRetry(attempt ? relayRetryDelay(attempt - 1) : 1000, signal);
        try {
          const notice = await this.relay.deliveryStatus!(envelope, signal);
          attempt = 0;
          if (!notice || notice.payload.state === 'unknown') return;
          if (notice.payload.state === 'expired') throw new RelayEnvelopeExpiredError(notice);
        } catch (error) {
          if (!isTransientRelayError(error)) throw error;
          attempt++;
        }
      }
    } catch (error) {
      if (signal.aborted || this.stopped) return;
      this.pumpError = error instanceof Error ? error : new Error('RELAY_STATUS_FAILED');
      this.readController.abort(this.pumpError);
      this.rejectWaiters(this.pumpError);
      for (const wake of this.inboxWaiters.splice(0)) wake();
    }
  }
  private prepare(eventType: string, payload: unknown): SignedEnvelope {
    return signEnvelope({ taskId: this.taskId, recipientDid: this.peerDid,
      seq: this.outgoing++, eventType, payload: asJson(payload) }, this.owner, { encrypt: true });
  }
  private dispatchPrepared(envelopes: SignedEnvelope[]): Promise<void> {
    if (!this.delivery) return this.dispatchBatch(envelopes);
    // Preserve this wire's sequence while independent tasks write and send concurrently.
    const run = this.deliveryTail.then(() => this.dispatchBatch(envelopes));
    this.deliveryTail = run.catch(() => {});
    return run;
  }
  private async dispatchBatch(envelopes: SignedEnvelope[]): Promise<void> {
    if (this.stopped) throw new Error('SESSION_CLOSED');
    const signal = this.detached ? this.readController.signal : this.signal;
    signal.throwIfAborted();
    if (this.delivery) {
      const { service, context } = this.delivery;
      await service.prepare(signal);
      const first = envelopes[0];
      if (first.payload.eventType === 'PROPOSE') context.messageId = first.payload.envelopeId;
      await service.enqueuePrepared(envelopes, { ...context, ...(first.payload.eventType !== 'PROPOSE' ? { message: undefined } : {}) }, signal);
      const batchId = service.store.read('outbox', first.payload.envelopeId)!.batchId;
      this.hasCommittedSend = true;
      for (const envelope of envelopes) {
        try { await service.sendPrepared(envelope.payload.envelopeId, signal); }
        catch (error) {
          if (error instanceof Error && error.message === 'OUTBOX_DEADLINE_EXPIRED') throw new Error('TASK_TIMEOUT');
          throw error;
        }
        const pin = service.store.read('outbox', envelope.payload.envelopeId)?.relayDid;
        if (pin) this.relay.restoreDeliveryStatusPin?.(envelope.payload.envelopeId, pin);
        if (this.relay.deliveryStatus) void this.watchDelivery(envelope);
      }
      // All members' admission results and identity pins have been consumed by this wire.
      // Remove the completed batch now so subsequent frames do not scan its ciphertext.
      service.finishBatch(batchId);
    } else for (const envelope of envelopes) {
      this.hasCommittedSend = true;
      await relayDeadline(Promise.resolve(this.relay.send(envelope)), 2_147_483_647, signal);
      if (this.relay.deliveryStatus) void this.watchDelivery(envelope);
    }
  }
  async rawSend(eventType: string, payload: unknown): Promise<void> {
    await this.dispatchPrepared([this.prepare(eventType, payload)]);
  }
  private async complete(envelope: SignedEnvelope): Promise<void> {
    const sealed = this.sealed(envelope);
    if (this.delivery) await this.delivery.service.store.receiptPrepared(sealed, this.delivery.context.deliveryDeadline,
      'processed', this.detached ? this.readController.signal : this.signal);
    await acknowledgeRelay(this.relay, sealed, this.detached ? this.readController.signal : this.signal);
  }
  /** Ciphertext that still matches the outer signature, when `view` was opened for the session. */
  sealed(view: SignedEnvelope): SignedEnvelope {
    return this.sealedByView.get(view) ?? view;
  }
  private check(e: SignedEnvelope): SignedEnvelope {
    if (
      !verifyEnvelope(e, this.owner.did) ||
      e.payload.senderDid !== this.peerDid ||
      e.payload.taskId !== this.taskId ||
      (!['ERROR', 'HEARTBEAT'].includes(e.payload.eventType) && e.payload.seq !== this.incoming)
    )
      throw new Error('INVALID_OR_REPLAYED_SESSION_ENVELOPE');
    // The signature covers ciphertext. Open a copy so later session code reads plaintext.
    const view = structuredClone(e);
    view.payload.payload = asJson(
      openEnvelope(e, this.owner, {
        requireEncrypted: !this.allowUnencryptedEnvelopes,
      }),
    );
    this.sealedByView.set(view, e);
    if (view.payload.eventType === 'HEARTBEAT') return view;
    if (view.payload.eventType === 'ERROR') {
      const error = new PeerRejectedError(view.payload.payload);
      // A restart may reset the peer's sequence counter. The signed, encrypted
      // interruption is terminal even while waiting for ACCEPT or its receipt.
      if (error.code === 'TASK_INTERRUPTED') throw error;
      // Restart notifications are independent of the lost session's wire counters.
      // Sender, recipient, task, signature and encryption were checked above.
      if (error.recovery) {
        const part = error.recovery.part;
        if (part) {
          if (!Number.isSafeInteger(part.index) || !Number.isSafeInteger(part.count) ||
              part.index < 0 || part.index >= part.count || typeof part.data !== 'string' ||
              typeof part.resultDigest !== 'string') throw new Error('INVALID_RECOVERY_OUTCOME');
          const key = digest({ proposalDigest: error.recovery.proposalDigest, code: error.code,
            count: part.count, resultDigest: part.resultDigest });
          const parts = this.recoveryParts.get(key) ?? new Map<number, Buffer>();
          parts.set(part.index, Buffer.from(part.data, 'base64'));
          this.recoveryParts.set(key, parts);
          if (parts.size !== part.count) {
            view.payload.eventType = 'RECOVERY_PART';
            return view;
          }
          const result = JSON.parse(Buffer.concat(Array.from({ length: part.count }, (_, index) => parts.get(index)!)).toString('utf8')) as SessionResult;
          if (digest(result) !== part.resultDigest) throw new Error('INVALID_RECOVERY_OUTCOME');
          error.recovery.result = result;
          this.recoveryParts.delete(key);
        }
        throw error;
      }
    }
    if (e.payload.seq !== this.incoming++) throw new Error('INVALID_OR_REPLAYED_SESSION_ENVELOPE');
    if (view.payload.eventType === 'ERROR') throw new PeerRejectedError(view.payload.payload);
    return view;
  }
  private acceptInitial(expected: string | string[], initial: SignedEnvelope): SignedEnvelope {
    const envelope = this.check(initial);
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (!allowed.includes(envelope.payload.eventType))
      throw new Error('UNEXPECTED_SESSION_EVENT: ' + envelope.payload.eventType);
    return envelope;
  }
  async rawReceive(expected: string | string[], initial?: SignedEnvelope): Promise<SignedEnvelope> {
    if (this.stopped) throw new Error('SESSION_CLOSED');
    if (initial) {
      const envelope = this.acceptInitial(expected, initial);
      if (this.awaitingInitial) { this.awaitingInitial = false; this.startPump(); void this.dispatch(); }
      return envelope;
    }
    if (this.pumpError && this.inbox.length === 0 && this.stashed.length === 0)
      return Promise.reject(this.pumpError);
    const allowed = Array.isArray(expected) ? expected : [expected];
    const envelope = await new Promise<SignedEnvelope>((resolve, reject) => {
      this.waiters.push({ allowed, resolve, reject });
      this.waiterAdded.shift()?.();
      void this.dispatch();
    });
    if (envelope.payload.eventType === 'ATTEST') await this.complete(envelope);
    return envelope;
  }
  private append(entry: AuditEntry): void {
    if (this.stopped) throw new Error('SESSION_CLOSED');
    validateSchema('audit-entry', entry);
    if (this.auditPath) new JsonlStore(this.auditPath).append(entry);
    this.entries.push(entry);
  }
  private body(eventType: string, payload: Json, actorDid: string, receiverDid: string): AuditBody {
    return {
      taskId: this.taskId,
      seq: this.entries.length,
      prevEntryHash: this.entries.at(-1)?.entryHash ?? null,
      actorDid,
      receiverDid,
      eventType,
      payload: this.contextGrant ? contextSessionAuditPayload(eventType, payload, this.contextGrant) : payload,
    };
  }
  private async acknowledgeControl(event: SignedEnvelope): Promise<void> {
    const audit = await this.nextEnvelope();
    if (audit.payload.eventType !== 'AUDIT_ENTRY')
      throw new Error('UNEXPECTED_SESSION_EVENT: ' + audit.payload.eventType);
    await this.recordPeer(event, audit);
  }
  private async recordPeer(event: SignedEnvelope, audit: SignedEnvelope): Promise<void> {
    const signed = audit.payload.payload as unknown as Signed<AuditBody>;
    const expected = this.body(
      event.payload.eventType,
      event.payload.payload,
      this.peerDid,
      this.owner.did,
    );
    if (
      !verifySigned(signed, this.peerDid) ||
      digest(signed.payload) !== digest(expected) ||
      !verifySignature(expected, signed.signature, this.peerDid)
    )
      throw new Error('INVALID_AUDIT_ENTRY');
    const ack = signAck(
      {
        type: 'AckReceipt',
        taskId: this.taskId,
        entryHash: digest(expected),
        actorDid: this.peerDid,
        receiverDid: this.owner.did,
      },
      this.owner,
    );
    this.append({
      body: expected,
      entryHash: digest(expected),
      actorSignature: signed.signature,
      counterSignature: ack,
    });
    const frame = this.prepare('AUDIT_ACK', ack);
    this.receiptAcks.set(event.payload.envelopeId, frame);
    this.receiptAcks.set(audit.payload.envelopeId, frame);
    await this.complete(audit);
    if (event.payload.eventType !== 'PROPOSE') await this.complete(event);
    await this.dispatchPrepared([frame]);
  }
  async sendEvent(eventType: string, payload: unknown): Promise<void> {
    const run = this.sendTail.then(() => this.transmit(eventType, payload));
    this.sendTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  async contextEvent(eventType: ContextGrantAuditEventType): Promise<void> {
    if (!this.contextGrant) return;
    await appendContextGrantAuditEvent((type, payload) => this.sendEvent(type, payload), eventType, this.contextGrant);
  }
  private async transmit(eventType: string, payload: unknown): Promise<void> {
    if (this.stopped) throw new Error('SESSION_CLOSED');
    const data = asJson(payload),
      body = this.body(eventType, data, this.owner.did, this.peerDid),
      draft = signPayload(body, this.owner);
    await this.dispatchPrepared([this.prepare(eventType, data), this.prepare('AUDIT_ENTRY', draft)]);
    const ackFrame = await this.rawReceive('AUDIT_ACK');
    const ack = ackFrame.payload.payload as unknown as AckReceipt;
    if (
      !verifySigned(ack, this.peerDid) ||
      ack.payload.type !== 'AckReceipt' ||
      ack.payload.taskId !== this.taskId ||
      ack.payload.actorDid !== this.owner.did ||
      ack.payload.receiverDid !== this.peerDid ||
      ack.payload.entryHash !== digest(body)
    )
      throw new Error('INVALID_AUDIT_ACK');
    this.append({
      body,
      entryHash: digest(body),
      actorSignature: draft.signature,
      counterSignature: ack,
    });
    await this.complete(ackFrame);
  }
  async receiveEvent(
    eventType: string | string[],
    initial?: SignedEnvelope,
  ): Promise<SignedEnvelope> {
    const e = await this.rawReceive(eventType, initial),
      signed = await this.rawReceive('AUDIT_ENTRY');
    await this.recordPeer(e, signed);
    return e;
  }
  private async sendCancel(payload: CancelBody): Promise<void> {
    await this.sendEvent('CANCEL', payload);
    this.rejectWaiters(new Error('CANCELLED'));
  }
  private checkpoint(): Checkpoint {
    return {
      type: 'AuditCheckpoint',
      taskId: this.taskId,
      count: this.entries.length,
      head: this.entries.at(-1)?.entryHash ?? null,
      actors: this.actors,
    };
  }
  private seal(checkpoint: AuditBundle['checkpoint']): AuditBundle {
    if (this.stopped) throw new Error('SESSION_CLOSED');
    const bundle = { entries: this.entries, checkpoint };
    if (!verifyAudit(bundle, { taskId: this.taskId, actors: this.actors }).valid)
      throw new Error('INVALID_BILATERAL_AUDIT');
    if (this.auditPath) new JsonlStore(this.auditPath).seal(checkpoint);
    return bundle;
  }
  async finishRequester(): Promise<AuditBundle> {
    const actor = signPayload(this.checkpoint(), this.owner);
    await this.rawSend('CHECKPOINT', actor);
    const frame = await this.rawReceive('CHECKPOINT_ACK');
    const receiver = frame.payload.payload as unknown as Signed<
      Signed<Checkpoint>
    >;
    const bundle = this.seal({ actor, receiver });
    await this.complete(frame);
    return bundle;
  }
  async finishWorker(onSealed?: (bundle: AuditBundle) => void): Promise<AuditBundle> {
    const frame = await this.rawReceive('CHECKPOINT');
    const actor = frame.payload.payload as unknown as Signed<Checkpoint>;
    if (!verifySigned(actor, this.peerDid) || digest(actor.payload) !== digest(this.checkpoint()))
      throw new Error('INVALID_AUDIT_CHECKPOINT');
    const receiver = signPayload(actor, this.owner),
      bundle = this.seal({ actor, receiver });
    onSealed?.(bundle);
    await this.complete(frame);
    await this.rawSend('CHECKPOINT_ACK', receiver);
    return bundle;
  }
}
