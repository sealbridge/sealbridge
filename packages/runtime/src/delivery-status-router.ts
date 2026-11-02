// SPDX-License-Identifier: Apache-2.0
import { DEFAULT_CLOCK_SKEW_MS, deliveryStatusRoutingId, digest, isEncryptedEnvelopePayload, openEnvelope, verifyDeliveryStatus, verifyEnvelope, validateSchema } from '@acp/core';
import type { SignedEnvelope } from '@acp/core';
import type { RelayTransport } from '@acp/relay';
import type { GatewayDeliveryService } from './outbox.js';
import { deliveryError } from './delivery-records.js';

type AttachReader = (service: GatewayDeliveryService, relay: RelayTransport, url: string, active: boolean) => void;
let attachReader: AttachReader | undefined;
/** The session host supplies its shared recipient inbox; no reader starts at module initialization. */
export function setDeliveryStatusReaderFactory(factory: AttachReader): void { attachReader = factory; }
class DeliveryStatusRouterImplementation {
  active = false;
  private readonly readers = new Map<string, RelayTransport>();
  private refreshing?: Promise<void>;
  constructor(readonly service: GatewayDeliveryService) {}
  ids(url: string): string[] {
    return this.service.store.statusMessages(e => this.service.options.onError?.(e)).filter(m => m.relayUrl === url && m.protocolVersion === '0.2.0' &&
      this.service.store.now() < m.retainUntil).map(m => deliveryStatusRoutingId(m.messageId));
  }
  async start(): Promise<void> { this.active = true; await this.refresh(); }
  stop(): void {
    this.active = false;
    for (const [url, relay] of this.readers) attachReader?.(this.service, relay, url, false);
  }
  refresh(): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.update().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async update(): Promise<void> {
    const urls = new Set(this.service.store.statusMessages(e => this.service.options.onError?.(e)).filter(m => m.protocolVersion === '0.2.0' &&
      this.service.store.now() < m.retainUntil).map(m => m.relayUrl));
    for (const url of urls) {
      try { await this.service.options.assertReceiveAllowed?.(url); }
      catch (error) {
        const previous = this.readers.get(url);
        if (previous) attachReader?.(this.service, previous, url, false);
        const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message) ? error.message : 'RELAY_UNAVAILABLE';
        this.service.options.onError?.(deliveryError(code));
        continue;
      }
      let relay = this.readers.get(url);
      if (!relay) { relay = await this.service.options.resolveTransport(url, this.service.owner); this.readers.set(url, relay); }
      if (this.active) attachReader?.(this.service, relay, url, true);
    }
    for (const [url, relay] of this.readers) if (!urls.has(url)) {
      attachReader?.(this.service, relay, url, false); this.readers.delete(url);
    }
  }
  /** Recognized control errors are consumed independently of task mailboxes. Persistence errors remain unacknowledged. */
  async route(envelope: SignedEnvelope, relay?: RelayTransport): Promise<boolean> {
    if (envelope.payload.eventType !== 'DELIVERY_STATUS') return false;
    try { this.receive(envelope); }
    catch (error) {
      if (!(error instanceof Error) || !['INVALID_DELIVERY_STATUS', 'DELIVERY_STATUS_CONFLICT'].includes(error.message)) throw error;
      this.service.options.onError?.(error);
    }
    await relay?.acknowledgeDelivery?.(this.service.owner.did, envelope.payload.envelopeId);
    return true;
  }
  receive(envelope: SignedEnvelope): void {
    const invalid = () => { throw deliveryError('INVALID_DELIVERY_STATUS'); };
    try { validateSchema('envelope', envelope); } catch { invalid(); }
    if (!verifyEnvelope(envelope, this.service.owner.did) || envelope.payload.eventType !== 'DELIVERY_STATUS' ||
      !isEncryptedEnvelopePayload(envelope.payload.payload)) invalid();
    let body: unknown;
    try { body = openEnvelope(envelope, this.service.owner); } catch { invalid(); }
    if (!verifyDeliveryStatus(body)) return invalid();
    try { validateSchema('delivery-status', body); } catch { invalid(); }
    const p = body.payload, now = this.service.store.now();
    const message = this.service.store.read('messages', p.messageId);
    if (!message || message.protocolVersion !== '0.2.0' || p.senderDid !== message.localOwnerDid ||
      p.recipientDid !== message.peerOwnerDid || p.taskId !== message.taskId || envelope.payload.senderDid !== p.recipientDid ||
      envelope.payload.taskId !== deliveryStatusRoutingId(p.messageId) || envelope.payload.seq !== p.revision ||
      p.retainUntil > message.retainUntil || now >= p.retainUntil || now >= message.retainUntil ||
      p.occurredAt < message.createdAt - DEFAULT_CLOCK_SKEW_MS || p.occurredAt > now + DEFAULT_CLOCK_SKEW_MS ||
      Date.parse(body.signature.signedAt) < p.occurredAt - DEFAULT_CLOCK_SKEW_MS ||
      Date.parse(body.signature.signedAt) > now + DEFAULT_CLOCK_SKEW_MS ||
      Date.parse(envelope.signature.signedAt) < p.occurredAt - DEFAULT_CLOCK_SKEW_MS ||
      Date.parse(envelope.signature.signedAt) > now + DEFAULT_CLOCK_SKEW_MS) invalid();
    this.service.store.transaction(() => {
      const m = this.service.store.read('messages', p.messageId)!;
      const receiptId = 'ds_' + p.messageId + '_' + p.revision;
      const receipt = this.service.store.read('receipts', receiptId);
      if (receipt && receipt.envelopeDigest !== digest(body)) throw deliveryError('DELIVERY_STATUS_CONFLICT');
      const previous = m.remoteStatus?.payload;
      if (previous && (p.revision > previous.revision && p.occurredAt < previous.occurredAt ||
        p.revision < previous.revision && p.occurredAt > previous.occurredAt)) invalid();
      if (!receipt) {
        if (this.service.store.ids('receipts').length >= this.service.store.limits.receipts) throw deliveryError('OUTBOX_FULL');
        this.service.store.write('receipts', receiptId, { version: 1, envelopeId: receiptId, localOwnerDid: m.localOwnerDid,
          senderDid: p.recipientDid, taskId: deliveryStatusRoutingId(p.messageId), envelopeDigest: digest(body), receivedAt: now,
          retainUntil: m.retainUntil, state: 'processed' });
      }
      if (previous && p.revision === previous.revision) {
        if (digest(m.remoteStatus) !== digest(body)) throw deliveryError('DELIVERY_STATUS_CONFLICT');
        return;
      }
      if (previous && p.revision < previous.revision) return;
      if (previous && p.occurredAt < previous.occurredAt) invalid();
      const rank = { queued: 0, relayed: 1, received_held: 2, opened: 3, handed_to_agent: 4, closed: 5, replied: 6 };
      // A higher revision carries a new fact but cannot undo a later lifecycle state or a verified reply.
      this.service.store.write('messages', m.messageId, { ...m, remoteStatus: body,
        status: rank[p.state] >= rank[m.status] ? p.state : m.status,
        updatedAt: Math.max(m.updatedAt, p.occurredAt), ...(p.state === 'closed' && m.status !== 'replied' ? { closedBy: 'peer' as const } : {}) });
    });
  }
}

export type DeliveryStatusRouter = Pick<DeliveryStatusRouterImplementation, keyof DeliveryStatusRouterImplementation>;
export const DeliveryStatusRouter: {
  new(service: GatewayDeliveryService): DeliveryStatusRouter;
  readonly prototype: DeliveryStatusRouter;
} = DeliveryStatusRouterImplementation;
