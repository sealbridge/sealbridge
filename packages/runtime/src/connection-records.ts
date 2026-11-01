// SPDX-License-Identifier: Apache-2.0
import { digest, verifySigned } from '@acp/core';
import type { Invite, Json, Signed } from '@acp/core';

export const CONNECTION_DAY_MS = 86_400_000;
export const CONNECTION_OFFER_TTL_MS = 14 * CONNECTION_DAY_MS;
export const CONNECTION_REFUSAL_TTL_MS = 7 * CONNECTION_DAY_MS;
export const CONNECTION_CAPACITY = { connections: 1000, inviteBindings: 1000, outbox: 100,
  priorApprovedPeers: 1000, refusals: 1000 } as const;
export type ConnectionState = 'none' | 'pending' | 'connected' | 'blocked';
export type ConnectionTrust = 'unknown' | 'limited' | 'denied';
export interface ConnectionIncomingOffer {
  requestId: string; requestDigest: string; receivedAt: number; expiresAt: number;
}
export interface ConnectionOutgoingOffer {
  requestId: string; requestDigest: string; createdAt: number; expiresAt: number; ownerConsentDigest: string;
}
export interface ConnectionRecord {
  peerOwnerDid: string; peerAgentDid?: string; relayUrl: string;
  state: 'pending' | 'connected';
  incoming?: ConnectionIncomingOffer; outgoing?: ConnectionOutgoingOffer;
  connectionId?: string; connectedAt?: number; source?: 'request' | 'invite' | 'prior-approval';
  localConsentDigest?: string; remoteAcceptanceDigest?: string;
}
export interface InviteBindingRecord {
  inviteDigest: string; requesterOwnerDid: string; boundAt: number; tokenExpiresAt: number; connectionId: string;
}
export interface PriorApprovedPeer {
  peerOwnerDid: string; lastApprovedAt?: number; sourceRequestIds: string[]; legacyTrust: 'limited' | 'trusted';
}
/** Callers supply owner-signed control data and omit invitation tokens and task input. */
export interface ConnectionOutboxRecord {
  eventId: string; peerOwnerDid: string; relayUrl: string; signedEvent: Signed<Json>;
  deliveryDeadline: number; state: 'pending' | 'delivered';
}
export interface ConnectionData {
  connections: ConnectionRecord[]; inviteBindings: InviteBindingRecord[];
  refusals: Array<{ peerOwnerDid: string; refuseUntil: number }>;
  priorApprovedPeers: PriorApprovedPeer[]; outbox: ConnectionOutboxRecord[];
}
export interface ConnectionPeer { peerOwnerDid: string; peerAgentDid?: string; relayUrl: string }
export interface ConnectionSummary {
  peerOwnerDid: string; peerAgentDid?: string; relayUrl?: string; state: Exclude<ConnectionState, 'none'>;
}
export interface RecordOutgoingConnection extends ConnectionPeer { outgoing: ConnectionOutgoingOffer }
export interface RecordIncomingConnection extends ConnectionPeer { incoming: ConnectionIncomingOffer }
export interface ApproveConnectionInput {
  peerOwnerDid: string; requestId: string; requestDigest: string; connectionId: string;
  localConsentDigest: string; outbox: ConnectionOutboxRecord; source?: 'request' | 'prior-approval';
}
/** The exchange layer verifies remote signature and identities before calling this port. */
export interface ApplyConnectionAcceptedInput {
  peerOwnerDid: string; requestId: string; requestDigest: string; connectionId: string;
  remoteAcceptanceDigest: string;
}
/** Pass a parsed, verified, unrevoked issuer invitation and an authenticated requester owner DID. */
export interface BindInviteFirstUseInput extends ConnectionPeer {
  invite: Invite; connectionId: string; localConsentDigest: string; outbox: ConnectionOutboxRecord;
}
/** Structural port for owner-local persistence; it has no transport or review policy. */
export interface ConnectionPersistence {
  connectionState(peerOwnerDid: string): ConnectionState;
  connectionLevel(peerOwnerDid: string): ConnectionTrust;
  listConnections(): ConnectionSummary[];
  listPriorApprovedPeers(): PriorApprovedPeer[];
  recordOutgoing(input: RecordOutgoingConnection): void;
  recordIncoming(input: RecordIncomingConnection): void;
  approveConnection(input: ApproveConnectionInput): void;
  applyAccepted(input: ApplyConnectionAcceptedInput): void;
  rejectConnection(peerOwnerDid: string): void;
  disconnect(peerOwnerDid: string): void;
  block(peerOwnerDid: string): void;
  unblock(peerOwnerDid: string): void;
  bindInviteFirstUse(input: BindInviteFirstUseInput): 'first' | 'same' | 'other';
  listConnectionOutbox(): ConnectionOutboxRecord[];
  markConnectionEventDelivered(eventId: string): void;
}
/** Explicit adapter with no store-specific fields exposed to consumers. */
export function connectionPersistencePort(store: ConnectionPersistence): ConnectionPersistence {
  return {
    connectionState: did => store.connectionState(did), connectionLevel: did => store.connectionLevel(did),
    listConnections: () => store.listConnections(), listPriorApprovedPeers: () => store.listPriorApprovedPeers(),
    recordOutgoing: input => store.recordOutgoing(input), recordIncoming: input => store.recordIncoming(input),
    approveConnection: input => store.approveConnection(input), applyAccepted: input => store.applyAccepted(input),
    rejectConnection: did => store.rejectConnection(did), disconnect: did => store.disconnect(did),
    block: did => store.block(did), unblock: did => store.unblock(did),
    bindInviteFirstUse: input => store.bindInviteFirstUse(input),
    listConnectionOutbox: () => store.listConnectionOutbox(),
    markConnectionEventDelivered: id => store.markConnectionEventDelivered(id),
  };
}
export function emptyConnectionData(): ConnectionData {
  return { connections: [], inviteBindings: [], refusals: [], priorApprovedPeers: [], outbox: [] };
}
export function projectConnectionState(data: ConnectionData, denials: string[], peer: string, now: number): ConnectionState {
  if (denials.includes(peer)) return 'blocked';
  const r = data.connections.find(c => c.peerOwnerDid === peer);
  return r?.state === 'connected' ? 'connected' : r &&
    ((r.incoming?.expiresAt ?? 0) > now || (r.outgoing?.expiresAt ?? 0) > now) ? 'pending' : 'none';
}
export function projectConnectionTrust(state: ConnectionState): ConnectionTrust {
  return state === 'blocked' ? 'denied' : state === 'connected' ? 'limited' : 'unknown';
}
export function pruneConnectionData(data: ConnectionData, now: number): void {
  data.connections = data.connections.filter(c => {
    if (c.state === 'connected') return true;
    if (c.incoming && c.incoming.expiresAt <= now) delete c.incoming;
    if (c.outgoing && c.outgoing.expiresAt <= now) delete c.outgoing;
    return !!(c.incoming || c.outgoing);
  });
  data.inviteBindings = data.inviteBindings.filter(b => b.tokenExpiresAt > now);
  data.refusals = data.refusals.filter(r => r.refuseUntil > now);
  data.outbox = data.outbox.filter(e => e.deliveryDeadline > now);
}
export function assertConnectionCapacity(data: ConnectionData): void {
  for (const key of Object.keys(CONNECTION_CAPACITY) as Array<keyof typeof CONNECTION_CAPACITY>)
    if (data[key].length > CONNECTION_CAPACITY[key]) throw new Error('CONNECTION_STORE_FULL');
}
const text = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\p{Cc}\p{Cf}]/u.test(v);
const did = (v: unknown): v is string => text(v) && v.startsWith('did:');
const hash = (v: unknown): v is string => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8_640_000_000_000_000;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function keys(v: object, allowed: string[]): boolean { return Object.keys(v).every(k => allowed.includes(k)); }
function relay(v: unknown): v is string {
  if (!text(v, 2048)) return false;
  try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; }
  catch { return false; }
}
export function validConnectionPeer(p: ConnectionPeer): boolean {
  return object(p) && did(p.peerOwnerDid) && (p.peerAgentDid === undefined || did(p.peerAgentDid)) && relay(p.relayUrl);
}
export function assertConnectionOwnerDid(peerOwnerDid: string): void {
  if (!did(peerOwnerDid)) throw new Error('INTAKE_STORE_INVALID');
}
export function validConnectionOffer(o: ConnectionIncomingOffer | ConnectionOutgoingOffer, outgoing: boolean): boolean {
  if (!object(o) || !text(o.requestId, 128) || !hash(o.requestDigest) || !time(o.expiresAt)) return false;
  const start = outgoing ? (o as ConnectionOutgoingOffer).createdAt : (o as ConnectionIncomingOffer).receivedAt;
  return time(start) && o.expiresAt > start && o.expiresAt - start <= CONNECTION_OFFER_TTL_MS &&
    (outgoing ? hash((o as ConnectionOutgoingOffer).ownerConsentDigest) &&
      keys(o, ['requestId', 'requestDigest', 'createdAt', 'expiresAt', 'ownerConsentDigest']) :
      keys(o, ['requestId', 'requestDigest', 'receivedAt', 'expiresAt']));
}
export function validConnectionOutbox(e: ConnectionOutboxRecord, owner: string): boolean {
  return object(e) && keys(e, ['eventId', 'peerOwnerDid', 'relayUrl', 'signedEvent', 'deliveryDeadline', 'state']) &&
    text(e.eventId, 128) && did(e.peerOwnerDid) && relay(e.relayUrl) && time(e.deliveryDeadline) &&
    ['pending', 'delivered'].includes(e.state) && object(e.signedEvent) && verifySigned(e.signedEvent, owner) &&
    Buffer.byteLength(JSON.stringify(e)) <= 8192;
}
export function assertConnectionCommit(connectionId: string, consentDigest: string): void {
  if (!text(connectionId, 128) || !hash(consentDigest)) throw new Error('INTAKE_STORE_INVALID');
}
/** Validate the persisted lifecycle, including uniqueness and explicit connected consent. */
export function validConnectionData(d: ConnectionData, owner: string): boolean {
  if (!object(d) || !(Object.keys(CONNECTION_CAPACITY) as Array<keyof typeof CONNECTION_CAPACITY>)
    .every(k => Array.isArray(d[k]) && d[k].length <= CONNECTION_CAPACITY[k])) return false;
  const unique = <T>(rows: T[], key: (r: T) => string) => new Set(rows.map(key)).size === rows.length;
  if (d.connections.some(c => !validConnectionPeer(c) ||
    !keys(c, ['peerOwnerDid', 'peerAgentDid', 'relayUrl', 'state', 'incoming', 'outgoing', 'connectionId', 'connectedAt', 'source', 'localConsentDigest', 'remoteAcceptanceDigest']) ||
    (c.incoming !== undefined && !validConnectionOffer(c.incoming, false)) ||
    (c.outgoing !== undefined && !validConnectionOffer(c.outgoing, true)) ||
    (c.state === 'pending' ? !(c.incoming || c.outgoing) ||
      ['connectionId', 'connectedAt', 'source', 'localConsentDigest', 'remoteAcceptanceDigest'].some(k => Object.hasOwn(c, k)) :
      c.state !== 'connected' || !text(c.connectionId, 128) || !time(c.connectedAt) ||
      !['request', 'invite', 'prior-approval'].includes(c.source!) || !hash(c.localConsentDigest) ||
      (c.source !== 'invite' && !(c.incoming || c.outgoing)) ||
      (!c.incoming && c.source !== 'invite' && !hash(c.remoteAcceptanceDigest)) ||
      (c.remoteAcceptanceDigest !== undefined && !hash(c.remoteAcceptanceDigest))))) return false;
  if (d.inviteBindings.some(b => !object(b) || !keys(b, ['inviteDigest', 'requesterOwnerDid', 'boundAt', 'tokenExpiresAt', 'connectionId']) ||
      !hash(b.inviteDigest) || !did(b.requesterOwnerDid) || !time(b.boundAt) || !time(b.tokenExpiresAt) ||
      b.tokenExpiresAt <= b.boundAt || !text(b.connectionId, 128)) ||
    d.refusals.some(r => !object(r) || !keys(r, ['peerOwnerDid', 'refuseUntil']) || !did(r.peerOwnerDid) || !time(r.refuseUntil)) ||
    d.priorApprovedPeers.some(p => !object(p) || !keys(p, ['peerOwnerDid', 'lastApprovedAt', 'sourceRequestIds', 'legacyTrust']) ||
      !did(p.peerOwnerDid) || (p.lastApprovedAt !== undefined && !time(p.lastApprovedAt)) ||
      !['limited', 'trusted'].includes(p.legacyTrust) || !Array.isArray(p.sourceRequestIds) || p.sourceRequestIds.length > 200 ||
      p.sourceRequestIds.some(id => !text(id, 128)) || new Set(p.sourceRequestIds).size !== p.sourceRequestIds.length) ||
    d.outbox.some(e => !validConnectionOutbox(e, owner))) return false;
  return unique(d.connections, c => c.peerOwnerDid) && unique(d.inviteBindings, b => b.inviteDigest) &&
    unique(d.refusals, r => r.peerOwnerDid) && unique(d.priorApprovedPeers, p => p.peerOwnerDid) && unique(d.outbox, e => e.eventId);
}
/** Canonical parsed invitations have the same digest for each supported URI encoding. */
export function connectionInviteDigest(invite: Invite): string { return digest(invite); }
