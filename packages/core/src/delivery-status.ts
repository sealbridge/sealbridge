// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { canonicalize, resolveDid, signPayload, verifySigned } from './crypto.js';
import type { KeyPair, Signed } from './types.js';

export type RecipientDeliveryState = 'received_held' | 'opened' | 'handed_to_agent' | 'closed';
export interface DeliveryStatus {
  type: 'DeliveryStatus'; version: 1; messageId: string; taskId: string;
  senderDid: string; recipientDid: string; state: RecipientDeliveryState;
  revision: number; occurredAt: number; retainUntil: number;
}
export type SignedDeliveryStatus = Signed<DeliveryStatus>;
export const DELIVERY_MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function exact(v: unknown, fields: string[]): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    fields.length === Object.keys(v).length && fields.every(k => Object.hasOwn(v, k));
}
export function deliveryStatusRoutingId(messageId: string): string {
  if (!DELIVERY_MESSAGE_ID.test(messageId)) throw new Error('INVALID_DELIVERY_STATUS');
  return 'ds_' + createHash('sha256').update(messageId, 'utf8').digest('hex');
}
/** Timeless structural and recipient signature verification. Live binding is gateway-local. */
export function verifyDeliveryStatus(value: unknown): value is SignedDeliveryStatus {
  try {
    if (!exact(value, ['payload', 'signature']) || !exact(value.payload,
      ['type', 'version', 'messageId', 'taskId', 'senderDid', 'recipientDid', 'state', 'revision', 'occurredAt', 'retainUntil']) ||
      !exact(value.signature, ['signerDid', 'canonicalization', 'payloadDigest', 'signedAt', 'signature'])) return false;
    const p = value.payload, s = value.signature;
    resolveDid(p.senderDid as string); resolveDid(p.recipientDid as string);
    return p.type === 'DeliveryStatus' && p.version === 1 && typeof p.messageId === 'string' && DELIVERY_MESSAGE_ID.test(p.messageId) &&
      typeof p.taskId === 'string' && p.taskId.length > 0 && Buffer.byteLength(p.taskId) <= 4096 &&
      ['received_held', 'opened', 'handed_to_agent', 'closed'].includes(String(p.state)) &&
      [p.revision, p.occurredAt, p.retainUntil].every(n => Number.isSafeInteger(n) && Number(n) >= 0) &&
      Number(p.revision) >= 1 && Number(p.retainUntil) >= Number(p.occurredAt) &&
      s.signerDid === p.recipientDid && s.canonicalization === 'RFC8785-JCS' &&
      typeof s.payloadDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(s.payloadDigest) &&
      typeof s.signedAt === 'string' && /^\d{4}-\d\d-\d\d[Tt]\d\d:\d\d:\d\d(?:\.\d+)?(?:[Zz]|[+-]\d\d:\d\d)$/.test(s.signedAt) && Number.isFinite(Date.parse(s.signedAt)) &&
      typeof s.signature === 'string' && /^ed25519:[A-Za-z0-9_-]{86}$/.test(s.signature) &&
      Buffer.byteLength(canonicalize(value)) <= 16 * 1024 && verifySigned(value as unknown as SignedDeliveryStatus, p.recipientDid as string);
  } catch { return false; }
}
export function signDeliveryStatus(payload: DeliveryStatus, owner: KeyPair): SignedDeliveryStatus {
  try {
    const signed = signPayload(payload, owner, new Date(payload.occurredAt).toISOString());
    if (verifyDeliveryStatus(signed)) return signed;
  } catch { /* Normalize invalid payload/signing inputs to the protocol code. */ }
  throw new Error('INVALID_DELIVERY_STATUS');
}
/** The same projection is used when recording a fact and immediately before dispatch. */
export function projectDeliveryState(state: RecipientDeliveryState, disclosure: 'coarse' | 'connected',
  connection: 'none' | 'pending' | 'connected' | 'blocked'): RecipientDeliveryState | undefined {
  if (connection === 'blocked') return;
  return state === 'received_held' || state === 'closed' || disclosure === 'connected' && connection === 'connected' ? state : undefined;
}
