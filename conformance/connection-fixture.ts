// SPDX-License-Identifier: Apache-2.0
// Test-only signed persistence and inspection ports; no runtime store implementation.
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  digest, generateKeyPair, signPayload, verifySigned, agentCardDelegationStatement,
} from '../packages/core/src/index.js';
import type { ConnectionAccepted, KeyPair, Signed, SignedAgentCard, SignedEnvelope } from '../packages/core/src/index.js';
import { ConnectionService } from '../packages/runtime/src/connection-service.js';
import type {
  ConnectionAcceptanceCommit, ConnectionConsent, ConnectionInspectionPort, ConnectionOffer,
  ConnectionOutboxEntry, ConnectionPersistencePort, ConnectionRedemptionCommit, ConnectionServiceOptions,
} from '../packages/runtime/src/connection-service.js';

export const EPOCH = Date.parse('2026-11-02T00:00:00.000Z');
export const DAY = 86_400_000;
export const RELAY = 'https://relay.example/connection';
export function card(owner: KeyPair, agent = owner): SignedAgentCard {
  const fields = { ownerDid: owner.did, agentDid: agent.did, relayEndpoint: RELAY,
    expiresAt: new Date(EPOCH + 30 * DAY).toISOString() };
  return signPayload({ type: 'AgentCard', version: '0.2.0', name: 'Connection fixture',
    description: 'Offline exchange', skills: [], costModes: ['worker_byok'], ...fields,
    ...(agent.did === owner.did ? {} : { agentDelegation: signPayload(agentCardDelegationStatement(fields), agent,
      new Date(EPOCH).toISOString()).signature }),
  }, owner, new Date(EPOCH).toISOString());
}
export function invite(owner: KeyPair, agentCard = card(owner), expiresAt = EPOCH + DAY): string {
  const signed = signPayload({ type: 'AgentInvite', ownerDid: owner.did, agentDid: agentCard.payload.agentDid,
    relayUrl: RELAY, agentCard, issuedAt: new Date(EPOCH).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
  }, owner, new Date(EPOCH).toISOString());
  return 'acp-invite:' + Buffer.from(JSON.stringify(signed)).toString('base64url');
}
interface State {
  incoming: Record<string, ConnectionOffer>;
  outgoing: Record<string, ConnectionOffer>;
  consents: Record<string, Signed<ConnectionConsent>>;
  accepted: Record<string, Signed<ConnectionAccepted>>;
  outbox: Record<string, ConnectionOutboxEntry>;
  acknowledgements: Record<string, ConnectionOutboxEntry>;
  bindings: Record<string, { owner: string; requestId: string; tokenExpiresAt: string }>;
  connected: Record<string, string>;
  removed: string[];
  blocked: string[];
  acked: string[];
  sent: string[];
}
export class FixturePort implements ConnectionPersistencePort {
  failNext = false;
  constructor(readonly path: string, readonly owner: KeyPair) {}
  read(): State {
    if (!existsSync(this.path)) return { incoming: {}, outgoing: {}, consents: {}, accepted: {}, outbox: {},
      bindings: {}, connected: {}, removed: [], blocked: [], acked: [], sent: [], acknowledgements: {} };
    const signed = JSON.parse(readFileSync(this.path, 'utf8')) as Signed<State>;
    if (!verifySigned(signed, this.owner.did)) throw new Error('FIXTURE_INVALID');
    return signed.payload;
  }
  private mutate<T>(fn: (s: State) => T): T {
    const state = this.read(), result = fn(state);
    if (this.failNext) { this.failNext = false; throw new Error('FIXTURE_WRITE_FAILED'); }
    writeFileSync(this.path + '.tmp', JSON.stringify(signPayload(state, this.owner, new Date(EPOCH).toISOString())), { mode: 0o600 });
    renameSync(this.path + '.tmp', this.path);
    return result;
  }
  private assertOffer(s: State, offer: ConnectionOffer, now: number): void {
    const peer = offer.fromOwnerDid === this.owner.did ? offer.toOwnerDid : offer.fromOwnerDid;
    if (s.removed.includes(offer.requestId) || s.blocked.includes(peer)) throw new Error('CONNECTION_NOT_PENDING');
    if (Date.parse(offer.expiresAt) <= now) throw new Error('CONNECTION_REQUEST_EXPIRED');
  }
  private record(s: State, map: Record<string, ConnectionOffer>, offer: ConnectionOffer, now: number): void {
    this.assertOffer(s, offer, now);
    if (map[offer.requestId] && digest(map[offer.requestId]) !== digest(offer)) throw new Error('INVALID_CONNECTION_REQUEST');
    map[offer.requestId] = offer;
  }
  async outgoing(id: string) { return this.read().outgoing[id]; }
  async incoming(id: string) { return this.read().incoming[id]; }
  async recordOutgoing(offer: ConnectionOffer, consent: Signed<ConnectionConsent>, outbox: ConnectionOutboxEntry, now: number) {
    this.mutate((s) => {
      if (!verifySigned(consent, this.owner.did) || consent.payload.requestDigest !== offer.requestDigest) throw new Error('FIXTURE_CONSENT');
      this.record(s, s.outgoing, offer, now);
      s.consents[offer.requestId] = consent;
      s.outbox[outbox.id] = outbox;
    });
  }
  async recordIncoming(offer: ConnectionOffer, now: number) {
    return this.mutate((s) => {
      this.record(s, s.incoming, offer, now);
      return s.accepted[offer.requestId] ? 'accepted' as const : 'pending' as const;
    });
  }
  private acceptInto(s: State, c: ConnectionAcceptanceCommit): void {
    this.assertOffer(s, c.offer, c.now);
    if (s.incoming[c.offer.requestId]?.requestDigest !== c.offer.requestDigest) throw new Error('CONNECTION_NOT_PENDING');
    if (s.accepted[c.offer.requestId]) return;
    s.connected[c.offer.fromOwnerDid] = c.accepted.payload.connectionId;
    if ('payload' in c.consent) s.consents[c.offer.requestId] = c.consent;
    s.accepted[c.offer.requestId] = c.accepted;
    s.outbox[c.outbox.id] = c.outbox;
  }
  async accept(c: ConnectionAcceptanceCommit) { this.mutate((s) => this.acceptInto(s, c)); }
  async redeem(c: ConnectionRedemptionCommit): Promise<'first' | 'same' | 'other' | 'inactive'> {
    return this.mutate((s) => {
      const binding = s.bindings[c.inviteDigest];
      if (binding) {
        if (binding.owner !== c.requesterOwnerDid) return 'other';
        return binding.requestId === c.offer.requestId && !!s.connected[binding.owner] && !s.removed.includes(binding.requestId)
          ? 'same' : 'inactive';
      }
      this.acceptInto(s, c);
      s.bindings[c.inviteDigest] = { owner: c.requesterOwnerDid, requestId: c.offer.requestId, tokenExpiresAt: c.tokenExpiresAt };
      return 'first';
    });
  }
  async applyAccepted(c: Parameters<ConnectionPersistencePort['applyAccepted']>[0]) {
    this.mutate((s) => {
      this.assertOffer(s, c.offer, c.now);
      const offer = s.outgoing[c.offer.requestId];
      if (!offer || digest(offer) !== digest(c.offer) || !s.consents[offer.requestId] ||
          c.accepted.payload.fromOwnerDid !== offer.toOwnerDid || c.accepted.payload.toOwnerDid !== this.owner.did ||
          c.accepted.payload.requestDigest !== offer.requestDigest || c.accepted.payload.inviteDigest !== offer.inviteDigest)
        throw new Error('CONNECTION_NOT_PENDING');
      const existing = s.accepted[offer.requestId];
      if (existing) {
        if (digest(existing) !== digest(c.accepted)) throw new Error('CONNECTION_NOT_PENDING');
        const original = s.acknowledgements[offer.requestId];
        if (original) s.outbox[original.id] = original;
        return;
      }
      s.connected[offer.toOwnerDid] = c.accepted.payload.connectionId;
      s.accepted[offer.requestId] = c.accepted;
      delete s.outbox[offer.requestId];
      s.outbox[c.outbox.id] = c.outbox;
      s.acknowledgements[offer.requestId] = c.outbox;
    });
  }
  async acknowledge(ack: Parameters<ConnectionPersistencePort['acknowledge']>[0], requestId: string) {
    this.mutate((s) => {
      const accepted = s.accepted[requestId];
      if (!accepted || digest(accepted) !== ack.payload.acceptedDigest ||
          accepted.payload.fromOwnerDid !== ack.payload.toOwnerDid || accepted.payload.toOwnerDid !== ack.payload.fromOwnerDid) return;
      s.acked = [...new Set([...s.acked, ack.payload.acceptedDigest])];
      delete s.outbox[accepted.payload.eventId];
    });
  }
  async listOutbox(now: number) { return Object.values(this.read().outbox).filter((o) => Date.parse(o.deliveryDeadline) > now); }
  async markSent(id: string) {
    this.mutate((s) => {
      s.sent.push(id);
      if (s.outbox[id]?.envelope.payload.eventType === 'CONNECTION_ACK') delete s.outbox[id];
    });
  }
  removePeer(peer: string, block = false) {
    this.mutate((s) => {
      delete s.connected[peer];
      if (block) s.blocked.push(peer);
      for (const o of [...Object.values(s.incoming), ...Object.values(s.outgoing)]) {
        if (o.fromOwnerDid === peer || o.toOwnerDid === peer) {
          s.removed.push(o.requestId);
          for (const [id, entry] of Object.entries(s.outbox)) if (entry.requestId === o.requestId) delete s.outbox[id];
        }
      }
    });
  }
}
export class FixtureInspection implements ConnectionInspectionPort {
  status: 'complete' | 'unavailable' | 'error' = 'complete';
  mismatch = false;
  failHold = false;
  held = new Map<string, { envelope: SignedEnvelope; expiresAt: string }>();
  discarded: string[] = [];
  async hold(envelope: SignedEnvelope, context: { contentDigest: string; expiresAt: string }) {
    if (this.failHold) throw new Error('FIXTURE_HOLD_FAILED');
    if (!this.held.has(context.contentDigest)) this.held.set(context.contentDigest, { envelope, expiresAt: context.expiresAt });
  }
  async inspect(contentDigest: string) { return { status: this.status, contentDigest: this.mismatch ? digest('different') : contentDigest }; }
  async discard(contentDigest: string) { this.held.delete(contentDigest); this.discarded.push(contentDigest); }
}
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'connection-exchange-'));
  let clock = EPOCH, sequence = 0;
  const frames: SignedEnvelope[] = [];
  const owners = [generateKeyPair(), generateKeyPair(), generateKeyPair()];
  const inspection = new FixtureInspection();
  const options = owners.map((owner, i): ConnectionServiceOptions => ({ owner, agentCard: card(owner), relayUrl: RELAY,
    persistence: new FixturePort(join(root, String(i) + '.json'), owner), inspection,
    humanReview: { kind: 'human', review: async () => true },
    transport: { send: async (_relay, envelope) => { frames.push(envelope); } },
    now: () => clock, id: () => 'event_' + ++sequence,
  }));
  return { root, owners, options, inspection, frames, ports: options.map((o) => o.persistence as FixturePort),
    service: (i: number, overrides: Partial<ConnectionServiceOptions> = {}) => new ConnectionService({ ...options[i], ...overrides }),
    now: () => clock, advance: (ms: number) => { clock += ms; },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
