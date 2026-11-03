// SPDX-License-Identifier: Apache-2.0
import { digest, openEnvelope } from '@acp/core';
import type { ConnectionRequest, Signed } from '@acp/core';
import { ConnectionRouter } from './connection-router.js';
import type { ConnectionRouterOptions } from './connection-router.js';
import { HeldRequestReview, heldContentDigest } from './held-request-review.js';
import type { HeldRequestStoreOptions } from './held-request-store.js';
import { openConnectionFrame } from './connection-transport.js';

export interface InboundConnectionSummary {
  id: string; requestId: string; requestDigest: string;
  localOwnerDid: string; peerOwnerDid: string; peerAgentDid: string;
  shortLocalOwnerDid: string; shortPeerOwnerDid: string; shortPeerAgentDid: string;
  peerDisplayName?: string; inviteAlias?: string;
  createdAt: string; receivedAt: number; expiresAt: number; relayUrl: string;
}
export interface ConnectionAdmissionReviewOptions extends Omit<ConnectionRouterOptions, 'review' | 'humanReview'> {
  heldOptions?: HeldRequestStoreOptions;
  /** Optional local label lookup by public invite digest. No invitation is resolved. */
  inviteAlias?: (inviteDigest: string) => string | undefined;
}
function label(value: string): string {
  return [...value.replace(/acp-invite:[A-Za-z0-9_-]+/g, '[invitation]')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')].slice(0, 120).join('');
}
const shortDid = (did: string) => did.slice(0, 16) + '…' + did.slice(-8);

/** Owner-facing admission queue. The host calls decisions only for explicit owner actions. */
export class ConnectionAdmissionReview {
  private readonly review: HeldRequestReview;
  private readonly now: () => number;
  constructor(private readonly options: ConnectionAdmissionReviewOptions) {
    if (options.store.ownerDid !== options.owner.did) throw new Error('INVALID_CONNECTION_OWNER');
    this.now = options.now ?? Date.now;
    this.review = new HeldRequestReview(options.owner, { ...options.heldOptions, now: this.now });
  }
  private entries() {
    const controls = this.options.store.controlSnapshot();
    return this.review.store.records().filter(record => record.kind === 'connection' && record.expiresAt > this.now())
      .flatMap(record => {
        const control = controls.find(c => c.direction === 'incoming' && c.active && !c.accepted &&
          c.offer.requestId === record.requestId && c.offer.relayUrl === this.options.relayUrl &&
          Date.parse(c.offer.expiresAt) > this.now());
        if (!control || this.options.store.connectionState(control.offer.fromOwnerDid) !== 'pending') return [];
        const frame = openConnectionFrame(record.envelope, this.options.owner);
        if (frame.event.payload.type !== 'ConnectionRequest' || digest(frame.event) !== control.offer.requestDigest ||
            frame.event.payload.fromOwnerDid !== record.senderOwnerDid ||
            heldContentDigest('connection', openEnvelope(record.envelope, this.options.owner)) !== record.contentDigest)
          throw new Error('INVALID_CONNECTION_REQUEST');
        return [{ record, request: frame.event as Signed<ConnectionRequest>, offer: control.offer }];
      });
  }
  /** Read-only public metadata projection; messages, task content and tokens are omitted. */
  list(): InboundConnectionSummary[] {
    return this.entries().map(({ record, request, offer }) => {
      const p = request.payload, peerAgentDid = p.agentCard.payload.agentDid;
      const alias = p.inviteDigest ? this.options.inviteAlias?.(p.inviteDigest) : undefined;
      return { id: record.id, requestId: p.requestId, requestDigest: offer.requestDigest,
        localOwnerDid: this.options.owner.did, peerOwnerDid: p.fromOwnerDid, peerAgentDid,
        shortLocalOwnerDid: shortDid(this.options.owner.did), shortPeerOwnerDid: shortDid(p.fromOwnerDid),
        shortPeerAgentDid: shortDid(peerAgentDid), peerDisplayName: label(p.agentCard.payload.name),
        ...(alias === undefined ? {} : { inviteAlias: label(alias) }),
        createdAt: p.createdAt, receivedAt: record.receivedAt, expiresAt: record.expiresAt, relayUrl: offer.relayUrl };
    }).sort((a, b) => a.receivedAt - b.receivedAt || a.id.localeCompare(b.id));
  }
  private entry(id: string) {
    const entry = this.entries().find(e => e.record.id === id || e.offer.requestId === id);
    if (!entry) throw new Error('CONNECTION_NOT_PENDING');
    return entry;
  }
  /** Explicit owner approval grants limited connection consent; it never opens a task. */
  async approve(id: string) {
    const { record } = this.entry(id);
    this.options.assertPeer?.(record.senderOwnerDid);
    // This provider exists only during this owner operation, never on the receiving router.
    const review = new HeldRequestReview(this.options.owner, { ...this.options.heldOptions, now: this.now,
      provider: { async inspect(envelope, context) {
        const frame = openConnectionFrame(envelope, context.owner);
        if (context.kind !== 'connection' || frame.event.payload.type !== 'ConnectionRequest' ||
            context.envelopeDigest !== digest(envelope) ||
            context.contentDigest !== heldContentDigest('connection', openEnvelope(envelope, context.owner)))
          throw new Error('INVALID_CONNECTION_REQUEST');
        return { ownerDid: context.owner.did, kind: context.kind, envelopeDigest: context.envelopeDigest,
          contentDigest: context.contentDigest, status: 'complete',
          reportDigest: digest({ type: 'ConnectionAdmissionMetadata', v: 1, requestDigest: digest(frame.event) }) };
      } } });
    const router = new ConnectionRouter({ ...this.options, review,
      humanReview: { kind: 'human', review: async () => true } });
    return router.approve(record.envelope);
  }
  /** Reject uses the existing peer cooldown and discards that peer's held content. */
  reject(id: string): void {
    const { offer } = this.entry(id);
    this.options.store.rejectConnection(offer.fromOwnerDid);
    this.review.discardPeer(offer.fromOwnerDid);
  }
}
