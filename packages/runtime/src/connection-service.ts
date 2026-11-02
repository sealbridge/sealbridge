// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import {
  assertConnectionRequestCurrent, CONNECTION_OFFER_LIFETIME_MS, DEFAULT_CLOCK_SKEW_MS,
  digest, parseAndVerifyInviteToken, signConnectionAccepted, signConnectionAck,
  signConnectionRequest, signPayload, validateRelayEndpointUrl, verifyConnectionRequest,
  verifySignedAgentCard,
} from '@acp/core';
import type {
  ConnectionAccepted, ConnectionAck, ConnectionRequest, Invite, KeyPair, RevocationList,
  Signed, SignedAgentCard, SignedEnvelope,
} from '@acp/core';
import { openConnectionFrame, retryConnectionEnvelope, sealConnectionFrame } from './connection-transport.js';
import type { ConnectionFrame, ConnectionTransport } from './connection-transport.js';

/** Content-free offer metadata. Bodies belong to the injected held-content port. */
export interface ConnectionOffer {
  requestId: string;
  requestDigest: string;
  fromOwnerDid: string;
  toOwnerDid: string;
  peerAgentDid?: string;
  relayUrl: string;
  createdAt: string;
  expiresAt: string;
  inviteDigest?: string;
}
export interface ConnectionConsent {
  type: 'ConnectionConsent';
  v: 1;
  ownerDid: string;
  requestDigest: string;
  decidedAt: string;
}
export interface ConnectionOutboxEntry {
  id: string;
  requestId: string;
  relayUrl: string;
  deliveryDeadline: string;
  envelope: SignedEnvelope;
}
export interface ConnectionAcceptanceCommit {
  offer: ConnectionOffer;
  accepted: Signed<ConnectionAccepted>;
  outbox: ConnectionOutboxEntry;
  consent: Signed<ConnectionConsent> | { inviteDigest: string };
  now: number;
}
export interface ConnectionRedemptionCommit extends ConnectionAcceptanceCommit {
  inviteDigest: string;
  requesterOwnerDid: string;
  tokenExpiresAt: string;
}

/**
 * All mutations are durable and atomic, scoped to the selected local owner DID.
 * Implementations serialize concurrent writers and enforce these preconditions under lock:
 * - record operations reject conflicting request IDs and blocked/withdrawn/tombstoned offers;
 *   repeated incoming requests return their retained decision without creating a new offer;
 * - accept checks the recorded incoming digest, deadline and current owner decision,
 *   retaining signed local consent with the connection and acceptance/outbox;
 * - redeem binds first owner + limited connection + acceptance/outbox in one write;
 *   same means the exact original offer is still connected, inactive means a same-owner
 *   reuse has no matching active offer, and other writes no authority;
 * - apply checks the exact outgoing digest, owners, deadline, invite digest and consent,
 *   then writes limited connection + ACK outbox before returning; duplicates requeue the
 *   original ACK, including after markSent, without changing consent or connection state;
 * - disconnect/block/withdraw supersede duplicates; retained decisions prevent restoration;
 * - acknowledge checks the acceptance digest, request ID and both owners against the outbox,
 *   durably marks receipt, and treats duplicate/unknown ACKs as no-ops.
 * No connection operation creates trusted authority or task execution permission.
 */
export interface ConnectionPersistencePort {
  outgoing(requestId: string): Promise<ConnectionOffer | undefined>;
  incoming(requestId: string): Promise<ConnectionOffer | undefined>;
  recordOutgoing(offer: ConnectionOffer, consent: Signed<ConnectionConsent>, outbox: ConnectionOutboxEntry, now: number): Promise<void>;
  recordIncoming(offer: ConnectionOffer, now: number): Promise<'pending' | 'accepted'>;
  accept(commit: ConnectionAcceptanceCommit): Promise<void>;
  redeem(commit: ConnectionRedemptionCommit): Promise<'first' | 'same' | 'other' | 'inactive'>;
  applyAccepted(commit: {
    offer: ConnectionOffer; accepted: Signed<ConnectionAccepted>;
    acknowledgement: Signed<ConnectionAck>; outbox: ConnectionOutboxEntry; now: number;
  }): Promise<void>;
  acknowledge(ack: Signed<ConnectionAck>, requestId: string, now: number): Promise<void>;
  listOutbox(now: number): Promise<ConnectionOutboxEntry[]>;
  /** Retain sent notifications until application ACK (ACK notifications need no further ACK). */
  markSent(id: string, now: number): Promise<void>;
}
export interface ConnectionHumanReviewProvider {
  readonly kind: 'human';
  review(context: {
    reason: 'outgoing' | 'incoming' | 'confirm-invite';
    localOwnerDid: string;
    peerOwnerDid: string;
    requestDigest: string;
    request: Signed<ConnectionRequest>;
  }): Promise<boolean>;
}
export interface ConnectionInspectionPort {
  /** Persist the encrypted original, capped at min(offer deadline, first receivedAt + 24h).
   * Duplicate holds retain the original deadline; expired content cannot be renewed. */
  hold(envelope: SignedEnvelope, context: { contentDigest: string; expiresAt: string; receivedAt: string }): Promise<void>;
  /** Complete means the returned digest identifies this immutable held content. */
  inspect(contentDigest: string): Promise<{ status: 'complete' | 'unavailable' | 'error'; contentDigest: string }>;
  discard(contentDigest: string): Promise<void>;
}
export interface ConnectionServiceOptions {
  owner: KeyPair;
  agentCard: SignedAgentCard;
  relayUrl: string;
  persistence: ConnectionPersistencePort;
  transport: ConnectionTransport;
  humanReview?: ConnectionHumanReviewProvider;
  inspection?: ConnectionInspectionPort;
  revocations?: RevocationList;
  allowPrivateRelay?: boolean;
  now?: () => number;
  id?: () => string;
}
export type ConnectionServiceResult = {
  requestId: string;
  status: 'pending' | 'connected' | 'acknowledged';
  code?: 'PENDING_OWNER_APPROVAL' | 'CONNECTION_DELIVERY_PENDING';
  retryable?: false;
};

/** Signed connection exchange; task execution remains a separate owner decision. */
export class ConnectionService {
  private readonly now: () => number;
  private readonly id: () => string;
  constructor(private readonly options: ConnectionServiceOptions) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    validateRelayEndpointUrl(options.relayUrl, options);
    if (!verifySignedAgentCard(options.agentCard, this.now()) ||
        options.agentCard.payload.ownerDid !== options.owner.did ||
        options.agentCard.payload.relayEndpoint !== options.relayUrl) throw new Error('INVALID_AGENT_CARD');
  }
  setAgentCard(card: SignedAgentCard): void {
    if (!verifySignedAgentCard(card, this.now()) || card.payload.ownerDid !== this.options.owner.did ||
        card.payload.relayEndpoint !== this.options.relayUrl) throw new Error('INVALID_AGENT_CARD');
    this.options.agentCard = card;
  }
  private iso(): string { return new Date(this.now()).toISOString(); }
  private async review(reason: 'outgoing' | 'incoming' | 'confirm-invite', request: Signed<ConnectionRequest>): Promise<Signed<ConnectionConsent>> {
    const provider = this.options.humanReview;
    if (!provider || provider.kind !== 'human') throw new Error('APPROVAL_CHANNEL_UNAVAILABLE');
    const p = request.payload;
    const requestDigest = digest(request);
    const approved = await provider.review({ reason, localOwnerDid: this.options.owner.did,
      peerOwnerDid: p.fromOwnerDid === this.options.owner.did ? p.toOwnerDid : p.fromOwnerDid,
      requestDigest, request: structuredClone(request) });
    if (approved !== true) throw new Error('APPROVAL_REJECTED');
    assertConnectionRequestCurrent(p, this.now());
    return signPayload({ type: 'ConnectionConsent', v: 1, ownerDid: this.options.owner.did,
      requestDigest, decidedAt: this.iso() }, this.options.owner, this.iso());
  }
  private invite(token: string, expectedOwner: string, expectedAgent?: string): Invite {
    const now = this.now();
    // Historical verification permits revocation to precede expiry, as in current admission.
    const invite = parseAndVerifyInviteToken(token, now, { allowPrivateRelay: this.options.allowPrivateRelay, allowExpired: true });
    if (invite.ownerDid !== expectedOwner || (expectedAgent && invite.agentDid !== expectedAgent) ||
        invite.relayUrl !== this.options.relayUrl) throw new Error('INVITE_WORKER_MISMATCH');
    this.options.revocations?.assertNotRevoked('invite', digest(invite));
    this.options.revocations?.assertNotRevoked('invite', token);
    if (Math.min(Date.parse(invite.expiresAt), Date.parse(invite.agentCard.payload.expiresAt)) <= now)
      throw new Error('INVITE_EXPIRED');
    return invite;
  }
  private offer(request: Signed<ConnectionRequest>, outgoing = false, peerAgentDid?: string): ConnectionOffer {
    const p = request.payload;
    return { requestId: p.requestId, requestDigest: digest(request), fromOwnerDid: p.fromOwnerDid,
      toOwnerDid: p.toOwnerDid,
      ...(!outgoing ? { peerAgentDid: p.agentCard.payload.agentDid } : peerAgentDid ? { peerAgentDid } : {}),
      relayUrl: this.options.relayUrl, createdAt: p.createdAt, expiresAt: p.expiresAt,
      ...(p.inviteDigest ? { inviteDigest: p.inviteDigest } : {}) };
  }
  private outbox(frame: ConnectionFrame, deadline: string): ConnectionOutboxEntry {
    return { id: frame.event.payload.type === 'ConnectionRequest' ? frame.requestId : frame.event.payload.eventId,
      requestId: frame.requestId, relayUrl: this.options.relayUrl, deliveryDeadline: deadline,
      envelope: sealConnectionFrame(frame, this.options.owner, this.now(), this.id()) };
  }
  async request(input: {
    toOwnerDid: string; message?: string; expiresAt?: string; inviteToken?: string; originProposalDigest?: string; deferDelivery?: boolean;
  }): Promise<ConnectionServiceResult> {
    const invite = input.inviteToken === undefined ? undefined : this.invite(input.inviteToken, input.toOwnerDid);
    const request = signConnectionRequest({ type: 'ConnectionRequest', v: 1, protocolVersion: '0.2.0',
      requestId: this.id(), fromOwnerDid: this.options.owner.did, toOwnerDid: input.toOwnerDid,
      agentCard: this.options.agentCard, message: input.message ?? '', createdAt: this.iso(),
      expiresAt: input.expiresAt ?? new Date(this.now() + CONNECTION_OFFER_LIFETIME_MS).toISOString(),
      ...(invite ? { inviteDigest: digest(invite) } : {}),
      ...(input.originProposalDigest === undefined ? {} : { originProposalDigest: input.originProposalDigest }),
    }, this.options.owner);
    const consent = await this.review(invite ? 'confirm-invite' : 'outgoing', request);
    const offer = this.offer(request, true, invite?.agentDid);
    const outbox = this.outbox({ requestId: offer.requestId, event: request,
      ...(input.inviteToken === undefined ? {} : { inviteToken: input.inviteToken }) }, offer.expiresAt);
    await this.options.persistence.recordOutgoing(offer, consent, outbox, this.now());
    const delivered = input.deferDelivery ? true : await this.flushOutbox();
    return { requestId: offer.requestId, status: 'pending', ...(!delivered ? { code: 'CONNECTION_DELIVERY_PENDING' } : {}) };
  }
  private checkRequest(frame: ConnectionFrame): Signed<ConnectionRequest> {
    const request = frame.event as Signed<ConnectionRequest>;
    if (!verifyConnectionRequest(request) || request.payload.toOwnerDid !== this.options.owner.did ||
        request.payload.agentCard.payload.relayEndpoint !== this.options.relayUrl)
      throw new Error('INVALID_CONNECTION_REQUEST');
    assertConnectionRequestCurrent(request.payload, this.now());
    if (!verifySignedAgentCard(request.payload.agentCard, this.now())) throw new Error('INVALID_AGENT_CARD');
    if (request.payload.inviteDigest && !frame.inviteToken) throw new Error('INVALID_CONNECTION_REQUEST');
    if (frame.inviteToken !== undefined) {
      const invite = this.invite(frame.inviteToken, this.options.owner.did, this.options.agentCard.payload.agentDid);
      if (digest(invite) !== request.payload.inviteDigest) throw new Error('INVALID_CONNECTION_REQUEST');
    }
    return request;
  }
  /** Validate an attached request before the task path mutates invitation or intake state. */
  validateRequest(envelope: SignedEnvelope): void {
    const frame = openConnectionFrame(envelope, this.options.owner);
    if (frame.event.payload.type !== 'ConnectionRequest') throw new Error('INVALID_CONNECTION_REQUEST');
    this.checkRequest(frame);
  }
  private async inspect(envelope: SignedEnvelope, request: Signed<ConnectionRequest>): Promise<boolean> {
    const port = this.options.inspection;
    if (!port) return false;
    const contentDigest = digest(request), now = this.now();
    await port.hold(envelope, { contentDigest, receivedAt: new Date(now).toISOString(),
      expiresAt: new Date(Math.min(Date.parse(request.payload.expiresAt), now + 24 * 60 * 60 * 1000)).toISOString() });
    let completion;
    try { completion = await port.inspect(contentDigest); } catch { return false; }
    return completion?.status === 'complete' && completion.contentDigest === contentDigest;
  }
  private async accept(request: Signed<ConnectionRequest>, consent: ConnectionAcceptanceCommit['consent'], token?: string): Promise<'connected' | 'pending'> {
    const offer = this.offer(request);
    assertConnectionRequestCurrent(request.payload, this.now());
    const accepted = signConnectionAccepted({ type: 'ConnectionAccepted', v: 1, protocolVersion: '0.2.0',
      eventId: this.id(), connectionId: connectionIdFor(this.options.owner.did, offer.fromOwnerDid), requestId: offer.requestId, requestDigest: offer.requestDigest,
      fromOwnerDid: this.options.owner.did, toOwnerDid: offer.fromOwnerDid, acceptedAt: this.iso(), trust: 'limited',
      ...(offer.inviteDigest ? { inviteDigest: offer.inviteDigest } : {}) }, this.options.owner);
    const commit: ConnectionAcceptanceCommit = { offer, accepted, consent, now: this.now(),
      outbox: this.outbox({ requestId: offer.requestId, event: accepted }, offer.expiresAt) };
    if (token !== undefined) {
      const invite = this.invite(token, this.options.owner.did, this.options.agentCard.payload.agentDid);
      const outcome = await this.options.persistence.redeem({ ...commit, inviteDigest: digest(invite),
        requesterOwnerDid: offer.fromOwnerDid,
        tokenExpiresAt: new Date(Math.min(Date.parse(invite.expiresAt), Date.parse(invite.agentCard.payload.expiresAt))).toISOString() });
      if (outcome === 'other' || outcome === 'inactive') return 'pending';
    } else await this.options.persistence.accept(commit);
    await this.options.inspection?.discard(offer.requestDigest);
    return 'connected';
  }
  /** Caller acknowledges relay delivery only after this resolves. No task mailbox is involved. */
  async receive(envelope: SignedEnvelope): Promise<ConnectionServiceResult> {
    const frame = openConnectionFrame(envelope, this.options.owner), p = frame.event.payload;
    if (p.type === 'ConnectionRequest') {
      const request = this.checkRequest(frame);
      const complete = await this.inspect(envelope, request);
      // Without durable held content, leave relay delivery unacknowledged.
      if (!this.options.inspection) throw new Error('INSPECTION_UNAVAILABLE');
      const decision = await this.options.persistence.recordIncoming(this.offer(request), this.now());
      if (decision === 'accepted') {
        await this.options.inspection.discard(digest(request));
        const delivered = await this.flushOutbox();
        return { requestId: frame.requestId, status: 'connected', ...(!delivered ? { code: 'CONNECTION_DELIVERY_PENDING' } : {}) };
      }
      if (complete && frame.inviteToken !== undefined) {
        const status = await this.accept(request, { inviteDigest: p.inviteDigest! }, frame.inviteToken);
        if (status === 'connected') {
          const delivered = await this.flushOutbox();
          return { requestId: frame.requestId, status, ...(!delivered ? { code: 'CONNECTION_DELIVERY_PENDING' } : {}) };
        }
      }
      return { requestId: frame.requestId, status: 'pending', code: 'PENDING_OWNER_APPROVAL', retryable: false };
    }
    if (p.type === 'ConnectionAccepted') {
      const offer = await this.options.persistence.outgoing(frame.requestId);
      if (!offer || offer.fromOwnerDid !== this.options.owner.did || offer.toOwnerDid !== p.fromOwnerDid ||
          offer.requestDigest !== p.requestDigest || offer.inviteDigest !== p.inviteDigest)
        throw new Error('CONNECTION_NOT_PENDING');
      if (Date.parse(offer.expiresAt) <= this.now()) throw new Error('CONNECTION_REQUEST_EXPIRED');
      if (Date.parse(p.acceptedAt) < Date.parse(offer.createdAt) || Date.parse(p.acceptedAt) >= Date.parse(offer.expiresAt) ||
          Date.parse(p.acceptedAt) > this.now() + DEFAULT_CLOCK_SKEW_MS) throw new Error('INVALID_CONNECTION_ACCEPTED');
      const acknowledgement = signConnectionAck({ type: 'ConnectionAck', v: 1, eventId: this.id(),
        acceptedDigest: digest(frame.event), fromOwnerDid: this.options.owner.did, toOwnerDid: p.fromOwnerDid,
        receivedAt: this.iso() }, this.options.owner);
      await this.options.persistence.applyAccepted({ offer, accepted: frame.event as Signed<ConnectionAccepted>,
        acknowledgement, outbox: this.outbox({ requestId: frame.requestId, event: acknowledgement }, offer.expiresAt), now: this.now() });
      const delivered = await this.flushOutbox();
      return { requestId: frame.requestId, status: 'connected', ...(!delivered ? { code: 'CONNECTION_DELIVERY_PENDING' } : {}) };
    }
    if (Date.parse(p.receivedAt) > this.now() + DEFAULT_CLOCK_SKEW_MS) throw new Error('INVALID_CONNECTION_ACK');
    await this.options.persistence.acknowledge(frame.event as Signed<ConnectionAck>, frame.requestId, this.now());
    return { requestId: frame.requestId, status: 'acknowledged' };
  }
  async approve(envelope: SignedEnvelope): Promise<ConnectionServiceResult> {
    const frame = openConnectionFrame(envelope, this.options.owner);
    const request = this.checkRequest(frame), offer = await this.options.persistence.incoming(frame.requestId);
    if (!offer || offer.requestDigest !== digest(request)) throw new Error('CONNECTION_NOT_PENDING');
    if (!await this.inspect(envelope, request)) throw new Error('INSPECTION_INCOMPLETE');
    const consent = await this.review('incoming', request);
    await this.accept(request, consent);
    const delivered = await this.flushOutbox();
    return { requestId: frame.requestId, status: 'connected', ...(!delivered ? { code: 'CONNECTION_DELIVERY_PENDING' } : {}) };
  }
  /** Retries only retained control notifications, each bounded by its original offer deadline. */
  async flushOutbox(): Promise<boolean> {
    let delivered = true;
    for (const entry of await this.options.persistence.listOutbox(this.now())) {
      if (Date.parse(entry.deliveryDeadline) <= this.now()) continue;
      try {
        await this.options.transport.send(entry.relayUrl, retryConnectionEnvelope(entry.envelope, this.options.owner, this.now()));
        await this.options.persistence.markSent(entry.id, this.now());
      } catch { delivered = false; }
    }
    return delivered;
  }
}

/** Both owners derive the same ID, with the smaller DID as the base. */
export function connectionIdFor(left: string, right: string): string {
  return 'connection_' + digest([left, right].sort()).slice(7);
}
