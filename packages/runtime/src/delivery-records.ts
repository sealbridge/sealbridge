// SPDX-License-Identifier: Apache-2.0
import { digest, isEncryptedEnvelopePayload, resolveDid, validateSchema, verifyEnvelope, verifySigned } from '@acp/core';
import type { Signed, SignedEnvelope } from '@acp/core';
import { createHash } from 'node:crypto';

export const DELIVERY_RETENTION_MS = 7 * 86400_000;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type MessageStatus = 'queued' | 'relayed' | 'received_held' | 'opened' | 'handed_to_agent' | 'replied' | 'closed';
export type OutboxState = 'pending' | 'admitted' | 'closed';
export type { DeliveryStatus, RecipientDeliveryState } from '@acp/core';
import type { DeliveryStatus, RecipientDeliveryState, SignedDeliveryStatus } from '@acp/core';
import { verifyDeliveryStatus, DEFAULT_CLOCK_SKEW_MS } from '@acp/core';
export interface RecipientDeliveryRecordV1 {
  version: 1; messageId: string; localOwnerDid: string; senderDid: string;
  taskId: string; originalEnvelopeDigest: string;
  createdAt: number; deliveryDeadline: number; retainUntil: number;
  protocolVersion: '0.1.0' | '0.2.0'; disclosure: 'coarse' | 'connected';
  latestState: RecipientDeliveryState; nextRevision: number;
  facts: Array<{ state: RecipientDeliveryState; occurredAt: number }>;
  published: Array<{ revision: number; status: SignedDeliveryStatus; envelopeId: string }>;
}
export interface MessageRecordV1 {
  version: 1; messageId: string; localOwnerDid: string; peerOwnerDid: string; peerAgentDid: string;
  taskId: string; relayUrl: string; protocolVersion: '0.1.0' | '0.2.0';
  createdAt: number; deliveryDeadline: number; retainUntil: number; status: MessageStatus; updatedAt: number;
  proposalEnvelopeDigest: string; lastError?: string; closedBy?: 'deadline' | 'local' | 'peer';
  operationId?: string; remoteStatus?: Signed<DeliveryStatus>; replyEnvelopeId?: string;
}
export interface OutboxRecordV1 {
  version: 1; envelopeId: string; messageId: string; batchId: string; kind: 'task' | 'delivery-status';
  localOwnerDid: string; peerOwnerDid: string; relayUrl: string; envelopeDigest: string; envelope: SignedEnvelope;
  createdAt: number; deliveryDeadline: number; state: OutboxState; attemptCount: number;
  nextAttemptAt: number; ordinal: number; lease?: { holderId: string; until: number };
  admittedAt?: number; lastError?: string; relayDid?: string;
}
export interface OutboxBatchV1 {
  version: 1; batchId: string; localOwnerDid: string; messageId: string;
  envelopeIds: string[]; createdAt: number; committed: true;
}
export interface InboundReceiptV1 {
  version: 1; envelopeId: string; localOwnerDid: string; senderDid: string; taskId: string;
  envelopeDigest: string; receivedAt: number; retainUntil: number;
  state: 'persisted' | 'processed' | 'terminal'; outcomeCode?: string;
}
export interface DeliveryRecords {
  observations: RecipientDeliveryRecordV1; messages: MessageRecordV1; outbox: OutboxRecordV1; batches: OutboxBatchV1; receipts: InboundReceiptV1;
}
export interface DeliveryLimits {
  activeEnvelopes: number; envelopeBytes: number; wireBytes: number; messages: number; receipts: number; recordBytes: number;
}
export const DEFAULT_DELIVERY_LIMITS: DeliveryLimits = {
  activeEnvelopes: 1024, envelopeBytes: 32 * 1024 * 1024, wireBytes: 256 * 1024,
  messages: 10_000, receipts: 10_000, recordBytes: 1024 * 1024,
};
export function deliveryError(code: string): Error { return Object.assign(new Error(code), { code }); }
/** The existing wire schema also permits non-UUID identifiers from other producers. */
export function receiptFileId(id: string): string {
  requireDelivery(typeof id === 'string' && id.length > 0 && Buffer.byteLength(id) <= 4096);
  if (UUID.test(id)) return id;
  const hex = createHash('sha256').update(id, 'utf8').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function requireDelivery(condition: unknown): asserts condition {
  if (!condition) throw deliveryError('OUTBOX_STORE_INVALID');
}
export function exact(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  requireDelivery(value && typeof value === 'object' && !Array.isArray(value));
  const keys = Object.keys(value);
  requireDelivery(required.every(k => keys.includes(k)) && keys.every(k => required.includes(k) || optional.includes(k)));
}
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const text = (v: unknown) => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 4096;
const hash = (v: unknown) => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown) => typeof v === 'string' && UUID.test(v);
function did(v: unknown): void { requireDelivery(text(v)); resolveDid(v as string); }
function signature(v: unknown): void {
  exact(v, ['signerDid', 'canonicalization', 'payloadDigest', 'signedAt', 'signature']);
  did(v.signerDid);
  requireDelivery(v.canonicalization === 'RFC8785-JCS' && hash(v.payloadDigest) &&
    typeof v.signedAt === 'string' && Number.isFinite(Date.parse(v.signedAt)) &&
    typeof v.signature === 'string' && /^ed25519:[A-Za-z0-9_-]{86}$/.test(v.signature));
}
export function validateSignedShape(value: unknown): asserts value is Signed<unknown> {
  exact(value, ['payload', 'signature']); signature(value.signature);
}
export function validateDeliveryStatus(value: unknown): asserts value is Signed<DeliveryStatus> {
  requireDelivery(verifyDeliveryStatus(value));
}
/** Validate exact version-one local records before they can affect transport. */
export function validateDeliveryRecord<K extends keyof DeliveryRecords>(kind: K, value: unknown, ownerDid: string): asserts value is DeliveryRecords[K] {
  const common = ['version', 'localOwnerDid'];
  const fields: Record<keyof DeliveryRecords, [string[], string[]]> = {
    observations: [['messageId', 'senderDid', 'taskId', 'originalEnvelopeDigest', 'createdAt', 'deliveryDeadline', 'retainUntil', 'protocolVersion', 'disclosure', 'latestState', 'nextRevision', 'facts', 'published'], []],
    messages: [['messageId', 'peerOwnerDid', 'peerAgentDid', 'taskId', 'relayUrl', 'protocolVersion', 'createdAt', 'deliveryDeadline', 'retainUntil', 'status', 'updatedAt', 'proposalEnvelopeDigest'], ['lastError', 'closedBy', 'operationId', 'remoteStatus', 'replyEnvelopeId']],
    outbox: [['envelopeId', 'messageId', 'batchId', 'kind', 'peerOwnerDid', 'relayUrl', 'envelopeDigest', 'envelope', 'createdAt', 'deliveryDeadline', 'state', 'attemptCount', 'nextAttemptAt', 'ordinal'], ['lease', 'admittedAt', 'lastError', 'relayDid']],
    batches: [['batchId', 'messageId', 'envelopeIds', 'createdAt', 'committed'], []],
    receipts: [['envelopeId', 'senderDid', 'taskId', 'envelopeDigest', 'receivedAt', 'retainUntil', 'state'], ['outcomeCode']],
  };
  exact(value, [...common, ...fields[kind][0]], fields[kind][1]);
  const r = value;
  requireDelivery(r.version === 1 && r.localOwnerDid === ownerDid); did(ownerDid);
  for (const k of ['messageId', 'envelopeId', 'batchId', 'operationId', 'replyEnvelopeId']) if (k in r)
    requireDelivery(kind === 'receipts' && k === 'envelopeId' ? text(r[k]) : uuid(r[k]));
  for (const k of ['createdAt', 'deliveryDeadline', 'retainUntil', 'updatedAt', 'receivedAt', 'attemptCount', 'nextAttemptAt', 'ordinal', 'admittedAt']) if (k in r) requireDelivery(integer(r[k]));
  for (const k of ['peerOwnerDid', 'peerAgentDid', 'senderDid', 'relayDid']) if (k in r) did(r[k]);
  for (const k of ['lastError', 'outcomeCode']) if (k in r) requireDelivery(typeof r[k] === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(r[k] as string));
  if ('taskId' in r) requireDelivery(text(r.taskId));
  if ('relayUrl' in r) {
    requireDelivery(text(r.relayUrl));
    const url = new URL(r.relayUrl as string);
    requireDelivery(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search);
  }
  if (kind === 'observations') {
    requireDelivery(r.protocolVersion === '0.2.0' && ['coarse', 'connected'].includes(String(r.disclosure)) && hash(r.originalEnvelopeDigest) &&
      r.retainUntil === Math.max(Number(r.createdAt), Number(r.deliveryDeadline)) + DELIVERY_RETENTION_MS &&
      integer(r.nextRevision) && Number(r.nextRevision) >= 1 && Number(r.nextRevision) <= 5 &&
      Array.isArray(r.facts) && r.facts.length >= 1 && r.facts.length <= 4 && Array.isArray(r.published) && r.published.length <= 4);
    const facts = r.facts as RecipientDeliveryRecordV1['facts'], published = r.published as RecipientDeliveryRecordV1['published'];
    const states = ['received_held', 'opened', 'handed_to_agent', 'closed'];
    facts.forEach((f, i) => {
      exact(f, ['state', 'occurredAt']);
      requireDelivery(states.includes(f.state) && integer(f.occurredAt) && f.occurredAt >= Number(r.createdAt) - DEFAULT_CLOCK_SKEW_MS && f.occurredAt < Number(r.retainUntil) &&
        (!i || f.occurredAt >= facts[i - 1].occurredAt));
    });
    requireDelivery(new Set(facts.map(f => f.state)).size === facts.length && r.latestState === facts.at(-1)!.state && r.nextRevision === published.length + 1);
    published.forEach((p, i) => {
      exact(p, ['revision', 'status', 'envelopeId']); validateDeliveryStatus(p.status);
      const v = p.status.payload;
      requireDelivery(uuid(p.envelopeId) && p.revision === i + 1 && v.revision === p.revision && v.messageId === r.messageId &&
        v.taskId === r.taskId && v.recipientDid === ownerDid && v.senderDid === r.senderDid && v.retainUntil === r.retainUntil &&
        facts.some(f => f.state === v.state && f.occurredAt === v.occurredAt) &&
        (r.disclosure !== 'coarse' || ['received_held', 'closed'].includes(v.state)));
    });
  } else if (kind === 'messages') {
    requireDelivery(['0.1.0', '0.2.0'].includes(String(r.protocolVersion)) &&
      ['queued', 'relayed', 'received_held', 'opened', 'handed_to_agent', 'replied', 'closed'].includes(String(r.status)) &&
      hash(r.proposalEnvelopeDigest) && r.retainUntil === Math.max(Number(r.createdAt), Number(r.deliveryDeadline)) + DELIVERY_RETENTION_MS);
    if ('closedBy' in r) requireDelivery(['deadline', 'local', 'peer'].includes(String(r.closedBy)));
    if ('remoteStatus' in r) {
      validateDeliveryStatus(r.remoteStatus);
      const p = r.remoteStatus.payload;
      requireDelivery(p.messageId === r.messageId && p.taskId === r.taskId && p.senderDid === ownerDid && p.recipientDid === r.peerOwnerDid && p.retainUntil <= Number(r.retainUntil));
    }
  } else if (kind === 'outbox') {
    requireDelivery(['task', 'delivery-status'].includes(String(r.kind)) && ['pending', 'admitted', 'closed'].includes(String(r.state)));
    validateSchema('envelope', r.envelope);
    const e = r.envelope as SignedEnvelope;
    requireDelivery(verifyEnvelope(e, r.peerOwnerDid as string) && e.payload.senderDid === ownerDid &&
      e.payload.envelopeId === r.envelopeId && digest(e) === r.envelopeDigest &&
      isEncryptedEnvelopePayload(e.payload.payload));
    if ('lease' in r) { exact(r.lease, ['holderId', 'until']); requireDelivery(uuid(r.lease.holderId) && integer(r.lease.until)); }
  } else if (kind === 'batches') {
    requireDelivery(r.committed === true && Array.isArray(r.envelopeIds) && r.envelopeIds.length >= 1 && r.envelopeIds.length <= 2 &&
      r.envelopeIds.every(uuid) && new Set(r.envelopeIds).size === r.envelopeIds.length);
  } else {
    requireDelivery(hash(r.envelopeDigest) && ['persisted', 'processed', 'terminal'].includes(String(r.state)) && Number(r.retainUntil) >= Number(r.receivedAt));
  }
}
export function effectiveMessage(record: MessageRecordV1, now: number): MessageRecordV1 | undefined {
  if (now >= record.retainUntil) return;
  return now >= record.deliveryDeadline && ['queued', 'relayed'].includes(record.status)
    ? { ...record, status: 'closed', closedBy: 'deadline' } : record;
}
