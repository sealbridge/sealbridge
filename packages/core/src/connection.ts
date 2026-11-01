// SPDX-License-Identifier: Apache-2.0
import { canonicalize, resolveDid, signPayload, verifySigned } from './crypto.js';
import { DEFAULT_CLOCK_SKEW_MS, verifySignedAgentCard } from './discovery.js';
import type { SignedAgentCard } from './discovery.js';
import type { KeyPair, Signed } from './types.js';

export const CONNECTION_OFFER_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
export const CONNECTION_CONTROL_MAX_BYTES = 64 * 1024;
export const CONNECTION_EVENTS = ['CONNECTION_REQUEST', 'CONNECTION_ACCEPTED', 'CONNECTION_ACK'] as const;
export type ConnectionEventName = typeof CONNECTION_EVENTS[number];

export interface ConnectionRequest {
  type: 'ConnectionRequest';
  v: 1;
  protocolVersion: '0.2.0';
  requestId: string;
  fromOwnerDid: string;
  toOwnerDid: string;
  agentCard: SignedAgentCard;
  message: string;
  createdAt: string;
  expiresAt: string;
  inviteDigest?: string;
  originProposalDigest?: string;
}
export interface ConnectionAccepted {
  type: 'ConnectionAccepted';
  v: 1;
  protocolVersion: '0.2.0';
  eventId: string;
  connectionId: string;
  requestId: string;
  requestDigest: string;
  fromOwnerDid: string;
  toOwnerDid: string;
  acceptedAt: string;
  trust: 'limited';
  inviteDigest?: string;
}
export interface ConnectionAck {
  type: 'ConnectionAck';
  v: 1;
  eventId: string;
  acceptedDigest: string;
  fromOwnerDid: string;
  toOwnerDid: string;
  receivedAt: string;
}
export type ConnectionControl = ConnectionRequest | ConnectionAccepted | ConnectionAck;

export function isConnectionEvent(value: string): value is ConnectionEventName {
  return (CONNECTION_EVENTS as readonly string[]).includes(value);
}
export function connectionEventName(value: ConnectionControl): ConnectionEventName {
  return value.type === 'ConnectionRequest' ? 'CONNECTION_REQUEST'
    : value.type === 'ConnectionAccepted' ? 'CONNECTION_ACCEPTED' : 'CONNECTION_ACK';
}
export function connectionRoutingId(requestId: string): string {
  if (!validId(requestId)) throw new Error('INVALID_CONNECTION_REQUEST');
  return 'conn_' + requestId;
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value);
}
function validDigest(value: unknown): boolean {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}
function instant(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : NaN;
}
function fields(value: object, required: string[], optional: string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function common(value: ConnectionControl): boolean {
  resolveDid(value.fromOwnerDid);
  resolveDid(value.toOwnerDid);
  return value.v === 1 && value.fromOwnerDid !== value.toOwnerDid &&
    Buffer.byteLength(canonicalize(value)) <= CONNECTION_CONTROL_MAX_BYTES;
}
/** Structural validation is timeless; live expiry checks are separate. */
export function validateConnectionRequest(value: unknown): value is ConnectionRequest {
  try {
    const p = value as ConnectionRequest;
    const created = instant(p.createdAt), expires = instant(p.expiresAt);
    return fields(p, ['type', 'v', 'protocolVersion', 'requestId', 'fromOwnerDid', 'toOwnerDid',
      'agentCard', 'message', 'createdAt', 'expiresAt'], ['inviteDigest', 'originProposalDigest']) &&
      common(p) && p.type === 'ConnectionRequest' && p.protocolVersion === '0.2.0' && validId(p.requestId) &&
      typeof p.message === 'string' && [...p.message].length <= 240 &&
      Number.isFinite(created) && expires > created && expires - created <= CONNECTION_OFFER_LIFETIME_MS &&
      p.agentCard.payload.ownerDid === p.fromOwnerDid && verifySignedAgentCard(p.agentCard, created) &&
      (p.inviteDigest === undefined || validDigest(p.inviteDigest)) &&
      (p.originProposalDigest === undefined || validDigest(p.originProposalDigest));
  } catch { return false; }
}
export function validateConnectionAccepted(value: unknown): value is ConnectionAccepted {
  try {
    const p = value as ConnectionAccepted;
    return fields(p, ['type', 'v', 'protocolVersion', 'eventId', 'connectionId', 'requestId',
      'requestDigest', 'fromOwnerDid', 'toOwnerDid', 'acceptedAt', 'trust'], ['inviteDigest']) &&
      common(p) && p.type === 'ConnectionAccepted' && p.protocolVersion === '0.2.0' &&
      [p.eventId, p.connectionId, p.requestId].every(validId) && validDigest(p.requestDigest) &&
      Number.isFinite(instant(p.acceptedAt)) && p.trust === 'limited' &&
      (p.inviteDigest === undefined || validDigest(p.inviteDigest));
  } catch { return false; }
}
export function validateConnectionAck(value: unknown): value is ConnectionAck {
  try {
    const p = value as ConnectionAck;
    return fields(p, ['type', 'v', 'eventId', 'acceptedDigest', 'fromOwnerDid', 'toOwnerDid', 'receivedAt']) &&
      common(p) && p.type === 'ConnectionAck' && validId(p.eventId) && validDigest(p.acceptedDigest) &&
      Number.isFinite(instant(p.receivedAt));
  } catch { return false; }
}
function signedShape(value: Signed<unknown>): boolean {
  return fields(value, ['payload', 'signature']) && fields(value.signature,
    ['signerDid', 'canonicalization', 'payloadDigest', 'signedAt', 'signature']);
}
export function verifyConnectionRequest(value: Signed<ConnectionRequest>): boolean {
  try { return signedShape(value) && validateConnectionRequest(value.payload) && verifySigned(value, value.payload.fromOwnerDid); }
  catch { return false; }
}
export function verifyConnectionAccepted(value: Signed<ConnectionAccepted>): boolean {
  try { return signedShape(value) && validateConnectionAccepted(value.payload) && verifySigned(value, value.payload.fromOwnerDid); }
  catch { return false; }
}
export function verifyConnectionAck(value: Signed<ConnectionAck>): boolean {
  try { return signedShape(value) && validateConnectionAck(value.payload) && verifySigned(value, value.payload.fromOwnerDid); }
  catch { return false; }
}
export function assertConnectionRequestCurrent(value: ConnectionRequest, now: number): void {
  if (!Number.isFinite(now) || Date.parse(value.createdAt) > now + DEFAULT_CLOCK_SKEW_MS)
    throw new Error('INVALID_CONNECTION_REQUEST');
  if (Date.parse(value.expiresAt) <= now) throw new Error('CONNECTION_REQUEST_EXPIRED');
}
export function signConnectionRequest(value: ConnectionRequest, owner: KeyPair): Signed<ConnectionRequest> {
  if (!validateConnectionRequest(value) || value.fromOwnerDid !== owner.did) throw new Error('INVALID_CONNECTION_REQUEST');
  return signPayload(value, owner, value.createdAt);
}
export function signConnectionAccepted(value: ConnectionAccepted, owner: KeyPair): Signed<ConnectionAccepted> {
  if (!validateConnectionAccepted(value) || value.fromOwnerDid !== owner.did) throw new Error('INVALID_CONNECTION_ACCEPTED');
  return signPayload(value, owner, value.acceptedAt);
}
export function signConnectionAck(value: ConnectionAck, owner: KeyPair): Signed<ConnectionAck> {
  if (!validateConnectionAck(value) || value.fromOwnerDid !== owner.did) throw new Error('INVALID_CONNECTION_ACK');
  return signPayload(value, owner, value.receivedAt);
}
