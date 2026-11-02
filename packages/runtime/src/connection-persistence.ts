// SPDX-License-Identifier: Apache-2.0
import { digest, verifySigned, verifyEnvelope, verifyConnectionAccepted, verifyConnectionAck } from '@acp/core';
import type { ConnectionAccepted, Signed } from '@acp/core';
import type { WorkerTrustStore, ConnectionTrustState } from './worker-trust-store.js';
import type { ConnectionAcceptanceCommit, ConnectionOffer, ConnectionOutboxEntry, ConnectionPersistencePort } from './connection-service.js';

export interface StoredControlRecord {
  offer: ConnectionOffer; direction: 'incoming' | 'outgoing'; active: boolean;
  consentDigest?: string; consent?: ConnectionAcceptanceCommit['consent']; accepted?: Signed<ConnectionAccepted>;
  outbox: ConnectionOutboxEntry[]; acknowledgement?: ConnectionOutboxEntry;
}
export function validStoredControls(records: StoredControlRecord[], ownerDid: string): boolean {
  return Array.isArray(records) && records.length <= 1000 &&
    new Set(records.map(r => r.offer.requestId)).size === records.length && records.every(r => {
      const o = r.offer;
      return ['incoming', 'outgoing'].includes(r.direction) && typeof r.active === 'boolean' &&
        typeof o?.requestId === 'string' && /^sha256:[a-f0-9]{64}$/.test(o.requestDigest) &&
        (r.direction === 'incoming' ? o.toOwnerDid : o.fromOwnerDid) === ownerDid &&
        Number.isFinite(Date.parse(o.createdAt)) && Date.parse(o.expiresAt) > Date.parse(o.createdAt) &&
        Date.parse(o.expiresAt) - Date.parse(o.createdAt) <= 14 * 86400000 &&
        (!r.accepted || verifyConnectionAccepted(r.accepted)) &&
        (!r.consentDigest || /^sha256:[a-f0-9]{64}$/.test(r.consentDigest)) &&
        (!r.consent || digest(r.consent) === r.consentDigest && ('payload' in r.consent ?
          verifySigned(r.consent, ownerDid) && r.consent.payload.requestDigest === o.requestDigest :
          r.consent.inviteDigest === o.inviteDigest)) &&
        Array.isArray(r.outbox) && r.outbox.length <= 2 && r.outbox.every(b =>
          b.requestId === o.requestId && b.envelope.payload.taskId === 'conn_' + o.requestId &&
          b.envelope.payload.senderDid === ownerDid && b.envelope.payload.recipientDid === (r.direction === 'incoming' ? o.fromOwnerDid : o.toOwnerDid) &&
          verifySigned(b.envelope, ownerDid) &&
          verifyEnvelope(b.envelope, b.envelope.payload.recipientDid) &&
          Date.parse(b.deliveryDeadline) <= Date.parse(o.expiresAt));
    });
}
/** PR2 lifecycle and PR3 exchange commit under the same owner-signed file lock. */
export class StoredConnectionExchange implements ConnectionPersistencePort {
  constructor(readonly store: WorkerTrustStore) {}
  private peer(o: ConnectionOffer): string { return o.fromOwnerDid === this.store.ownerDid ? o.toOwnerDid : o.fromOwnerDid; }
  private record(s: ConnectionTrustState, o: ConnectionOffer, direction: 'incoming' | 'outgoing', now: number): StoredControlRecord {
    const peer = this.peer(o);
    if (s.denials.includes(peer)) throw new Error('CONNECTION_NOT_PENDING');
    if (Date.parse(o.expiresAt) <= now) throw new Error('CONNECTION_REQUEST_EXPIRED');
    const controls = s.controls ??= [];
    let r = controls.find(r => r.offer.requestId === o.requestId);
    if (r && (!r.active || r.direction !== direction || digest(r.offer) !== digest(o))) throw new Error('CONNECTION_NOT_PENDING');
    if (!r) {
      if (direction === 'incoming' && s.refusals.some(r => r.peerOwnerDid === peer && r.refuseUntil > now))
        throw new Error('CONNECTION_REQUEST_COOLDOWN');
      r = { offer: structuredClone(o), direction, active: true, outbox: [] }; controls.push(r);
    }
    return r;
  }
  private pending(s: ConnectionTrustState, r: StoredControlRecord, now: number): void {
    const o = r.offer, peer = this.peer(o);
    let c = s.connections.find(c => c.peerOwnerDid === peer);
    if (!c) { c = { peerOwnerDid: peer, relayUrl: o.relayUrl, state: 'pending',
      ...(o.peerAgentDid ? { peerAgentDid: o.peerAgentDid } : {}) }; s.connections.push(c); }
    if (r.direction === 'incoming') c.incoming ??= { requestId: o.requestId, requestDigest: o.requestDigest,
      receivedAt: now, expiresAt: Date.parse(o.expiresAt) };
    else c.outgoing ??= { requestId: o.requestId, requestDigest: o.requestDigest, createdAt: Date.parse(o.createdAt),
      expiresAt: Date.parse(o.expiresAt), ownerConsentDigest: r.consentDigest! };
  }
  private commit(s: ConnectionTrustState, r: StoredControlRecord, accepted: Signed<ConnectionAccepted>, now: number, source: 'request' | 'invite'): void {
    this.pending(s, r, now);
    const c = s.connections.find(c => c.peerOwnerDid === this.peer(r.offer))!;
    Object.assign(c, { state: 'connected', connectionId: accepted.payload.connectionId, connectedAt: now,
      source, localConsentDigest: r.consentDigest!,
      ...(r.direction === 'outgoing' ? { remoteAcceptanceDigest: digest(accepted) } : {}) });
    r.accepted = structuredClone(accepted);
  }
  private async lookup(id: string, direction: StoredControlRecord['direction']): Promise<ConnectionOffer | undefined> {
    return this.store.controlSnapshot().find(r => r.offer.requestId === id && r.direction === direction && r.active)?.offer;
  }
  outgoing(id: string) { return this.lookup(id, 'outgoing'); }
  incoming(id: string) { return this.lookup(id, 'incoming'); }
  async recordOutgoing(...[o, consent, outbox, now]: Parameters<ConnectionPersistencePort['recordOutgoing']>) {
    this.store.updateControls(s => {
      if (!verifySigned(consent, this.store.ownerDid) || consent.payload.requestDigest !== o.requestDigest) throw new Error('CONNECTION_NOT_PENDING');
      const r = this.record(s, o, 'outgoing', now); r.consent = structuredClone(consent); r.consentDigest = digest(consent);
      this.pending(s, r, now); r.outbox = [structuredClone(outbox)];
    });
  }
  async recordIncoming(o: ConnectionOffer, now: number) {
    return this.store.updateControls(s => {
      const r = this.record(s, o, 'incoming', now); this.pending(s, r, now);
      return r.accepted ? 'accepted' as const : 'pending' as const;
    });
  }
  private acceptInto(s: ConnectionTrustState, c: ConnectionAcceptanceCommit, source: 'request' | 'invite') {
    const retained = s.controls?.find(r => r.offer.requestId === c.offer.requestId && r.direction === 'incoming');
    if (!retained?.active || digest(retained.offer) !== digest(c.offer)) throw new Error('CONNECTION_NOT_PENDING');
    const r = this.record(s, c.offer, 'incoming', c.now);
    const p = c.accepted.payload;
    if (!verifyConnectionAccepted(c.accepted) || p.fromOwnerDid !== this.store.ownerDid || p.toOwnerDid !== c.offer.fromOwnerDid ||
        p.requestId !== c.offer.requestId || p.requestDigest !== c.offer.requestDigest || p.inviteDigest !== c.offer.inviteDigest)
      throw new Error('CONNECTION_NOT_PENDING');
    if ('payload' in c.consent ? !verifySigned(c.consent, this.store.ownerDid) || c.consent.payload.requestDigest !== c.offer.requestDigest :
      source !== 'invite' || c.consent.inviteDigest !== c.offer.inviteDigest) throw new Error('CONNECTION_NOT_PENDING');
    if (r.accepted) return;
    r.consent = structuredClone(c.consent); r.consentDigest = digest(c.consent); r.outbox = [structuredClone(c.outbox)];
    this.commit(s, r, c.accepted, c.now, source);
  }
  async accept(c: ConnectionAcceptanceCommit) { this.store.updateControls(s => this.acceptInto(s, c, 'request')); }
  async redeem(c: Parameters<ConnectionPersistencePort['redeem']>[0]) {
    return this.store.updateControls(s => {
      const b = s.inviteBindings.find(b => b.inviteDigest === c.inviteDigest);
      if (b) {
        if (b.requesterOwnerDid !== c.requesterOwnerDid) return 'other' as const;
        const connected = s.connections.some(p => p.peerOwnerDid === b.requesterOwnerDid && p.state === 'connected' && p.connectionId === b.connectionId);
        if (!connected) return 'inactive' as const;
        this.acceptInto(s, c, 'invite');
        return 'same' as const;
      }
      this.acceptInto(s, c, 'invite');
      s.inviteBindings.push({ inviteDigest: c.inviteDigest, requesterOwnerDid: c.requesterOwnerDid,
        tokenExpiresAt: Date.parse(c.tokenExpiresAt), boundAt: c.now, connectionId: c.accepted.payload.connectionId });
      return 'first' as const;
    });
  }
  async applyAccepted(c: Parameters<ConnectionPersistencePort['applyAccepted']>[0]) {
    this.store.updateControls(s => {
      const existing = s.controls?.find(r => r.offer.requestId === c.offer.requestId);
      if (!existing?.active || !existing.consentDigest) throw new Error('CONNECTION_NOT_PENDING');
      const r = this.record(s, c.offer, 'outgoing', c.now), p = c.accepted.payload;
      if (!verifyConnectionAccepted(c.accepted) || p.fromOwnerDid !== c.offer.toOwnerDid || p.toOwnerDid !== this.store.ownerDid ||
          p.requestId !== c.offer.requestId || p.requestDigest !== c.offer.requestDigest || p.inviteDigest !== c.offer.inviteDigest ||
          !verifyConnectionAck(c.acknowledgement) || c.acknowledgement.payload.fromOwnerDid !== this.store.ownerDid ||
          c.acknowledgement.payload.toOwnerDid !== c.offer.toOwnerDid || c.acknowledgement.payload.acceptedDigest !== digest(c.accepted))
        throw new Error('CONNECTION_NOT_PENDING');
      if (r.accepted) {
        if (digest(r.accepted) !== digest(c.accepted)) throw new Error('CONNECTION_NOT_PENDING');
        r.outbox = r.acknowledgement ? [r.acknowledgement] : []; return;
      }
      this.commit(s, r, c.accepted, c.now, 'request');
      r.acknowledgement = structuredClone(c.outbox); r.outbox = [r.acknowledgement];
    });
  }
  async acknowledge(ack: Parameters<ConnectionPersistencePort['acknowledge']>[0], id: string) {
    this.store.updateControls(s => {
      const r = s.controls?.find(r => r.offer.requestId === id && r.active), a = r?.accepted;
      if (a && digest(a) === ack.payload.acceptedDigest && a.payload.fromOwnerDid === ack.payload.toOwnerDid &&
          a.payload.toOwnerDid === ack.payload.fromOwnerDid) r!.outbox = [];
    });
  }
  async listOutbox(now: number) { return this.store.controlSnapshot().filter(r => r.active)
    .flatMap(r => r.outbox).filter(b => Date.parse(b.deliveryDeadline) > now); }
  async markSent(id: string) { this.store.updateControls(s => {
    for (const r of s.controls ?? []) r.outbox = r.outbox.filter(b => b.id !== id || b.envelope.payload.eventType !== 'CONNECTION_ACK');
  }); }
}
