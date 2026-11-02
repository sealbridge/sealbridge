// SPDX-License-Identifier: Apache-2.0
import { digest, isEncryptedEnvelopePayload, resolveDid, validateManifest, validateSchema, verifyEnvelope, verifySigned } from '@acp/core';
import type { ApprovalReceipt, Json, TaskManifest, Signed, SignedEnvelope } from '@acp/core';
import { createHash } from 'node:crypto';

export const DELIVERY_RETENTION_MS = 7 * 86400_000;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type MessageStatus = 'queued' | 'relayed' | 'received_held' | 'opened' | 'handed_to_agent' | 'replied' | 'closed';
export type OutboxState = 'pending' | 'admitted' | 'closed';
export type RecipientDeliveryState = 'received_held' | 'opened' | 'handed_to_agent' | 'closed';
/** Reserved local extension contract; emission and routing are separate work. */
export interface DeliveryStatus {
  type: 'DeliveryStatus'; version: 1; messageId: string; taskId: string;
  senderDid: string; recipientDid: string; state: RecipientDeliveryState;
  revision: number; occurredAt: number; retainUntil: number;
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
export interface PreparedIdempotentAction {
  childIndex: number; manifest: TaskManifest; input: Json; relayUrl: string;
  peerOwnerDid: string; peerAgentDid: string; messageId?: string; approvalTargetDigest: string;
}
export interface IdempotencyAuthorization {
  targetDigest: string; receipt?: ApprovalReceipt; approvedAt: number; policy?: 'configured-auto';
}
export interface IdempotencyOperationV1 {
  version: 1; operationId: string; localOwnerDid: string; tool: string; requestDigest: string;
  createdAt: number; retainUntil: number;
  phase: 'reserved' | 'awaiting_approval' | 'approved' | 'sending' | 'finished';
  messageIds: string[]; taskIds: string[]; preparedActions: PreparedIdempotentAction[];
  approvals?: Array<IdempotencyAuthorization & { childIndex: number }>;
  response?: { isError: boolean; value: Json };
  lease?: { holderId: string; until: number };
}
export interface IdempotencyBindingV1 {
  version: 1; localOwnerDid: string; tool: string; keyHash: string; requestDigest: string;
  operationId: string; createdAt: number; retainUntil: number;
}
export interface DeliveryRecords {
  operations: IdempotencyOperationV1; idempotency: IdempotencyBindingV1;
  messages: MessageRecordV1; outbox: OutboxRecordV1; batches: OutboxBatchV1; receipts: InboundReceiptV1;
}
export interface DeliveryLimits {
  operations: number; cachedResultBytes: number; operationBytes: number;
  activeEnvelopes: number; envelopeBytes: number; wireBytes: number; messages: number; receipts: number; recordBytes: number;
}
export const DEFAULT_DELIVERY_LIMITS: DeliveryLimits = {
  operations: 10_000, cachedResultBytes: 16 * 1024 * 1024, operationBytes: 4 * 1024 * 1024,
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
  validateSignedShape(value);
  const p = value.payload;
  exact(p, ['type', 'version', 'messageId', 'taskId', 'senderDid', 'recipientDid', 'state', 'revision', 'occurredAt', 'retainUntil']);
  requireDelivery(p.type === 'DeliveryStatus' && p.version === 1 && uuid(p.messageId) && text(p.taskId) &&
    ['received_held', 'opened', 'handed_to_agent', 'closed'].includes(String(p.state)) &&
    integer(p.revision) && Number(p.revision) >= 1 && integer(p.occurredAt) && integer(p.retainUntil) && Number(p.retainUntil) >= Number(p.occurredAt));
  did(p.senderDid); did(p.recipientDid);
  requireDelivery(verifySigned(value, p.recipientDid as string));
}
/** Validate exact version-one local records before they can affect transport. */
export function validateDeliveryRecord<K extends keyof DeliveryRecords>(kind: K, value: unknown, ownerDid: string): asserts value is DeliveryRecords[K] {
  const common = ['version', 'localOwnerDid'];
  const fields: Record<keyof DeliveryRecords, [string[], string[]]> = {
    operations: [['operationId', 'tool', 'requestDigest', 'createdAt', 'retainUntil', 'phase', 'messageIds', 'taskIds', 'preparedActions'], ['approvals', 'response', 'lease']],
    idempotency: [['tool', 'keyHash', 'requestDigest', 'operationId', 'createdAt', 'retainUntil'], []],
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
  if (kind === 'operations' || kind === 'idempotency') {
    validateIdempotencyRecord(kind, r, ownerDid);
  } else if (kind === 'messages') {
    requireDelivery(['0.1.0', '0.2.0'].includes(String(r.protocolVersion)) &&
      ['queued', 'relayed', 'received_held', 'opened', 'handed_to_agent', 'replied', 'closed'].includes(String(r.status)) &&
      hash(r.proposalEnvelopeDigest) && r.retainUntil === Math.max(Number(r.createdAt), Number(r.deliveryDeadline)) + DELIVERY_RETENTION_MS);
    if ('closedBy' in r) requireDelivery(['deadline', 'local', 'peer'].includes(String(r.closedBy)));
    if ('remoteStatus' in r) {
      validateDeliveryStatus(r.remoteStatus);
      const p = r.remoteStatus.payload;
      requireDelivery(p.messageId === r.messageId && p.taskId === r.taskId && p.senderDid === ownerDid && p.recipientDid === r.peerOwnerDid && p.retainUntil === r.retainUntil);
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

export const IDEMPOTENCY_TOOLS = ['acp_delegate_task', 'acp_delegate_multi', 'acp_resubmit_pending_request'] as const;
function validateIdempotencyRecord(kind: 'operations' | 'idempotency', r: Record<string, unknown>, owner: string): void {
  requireDelivery(IDEMPOTENCY_TOOLS.includes(r.tool as typeof IDEMPOTENCY_TOOLS[number]) && hash(r.requestDigest) &&
    integer(r.createdAt) && integer(r.retainUntil) && Number(r.retainUntil) >= Number(r.createdAt));
  if (kind === 'idempotency') { requireDelivery(typeof r.keyHash === 'string' && /^[a-f0-9]{64}$/.test(r.keyHash)); return; }
  requireDelivery(['reserved', 'awaiting_approval', 'approved', 'sending', 'finished'].includes(String(r.phase)) &&
    Array.isArray(r.messageIds) && r.messageIds.every(uuid) && new Set(r.messageIds).size === r.messageIds.length &&
    Array.isArray(r.taskIds) && r.taskIds.every(text) && new Set(r.taskIds).size === r.taskIds.length &&
    Array.isArray(r.preparedActions) && r.preparedActions.length <= 1024);
  const indices = new Set<number>();
  for (const a of r.preparedActions) {
    exact(a, ['childIndex', 'manifest', 'input', 'relayUrl', 'peerOwnerDid', 'peerAgentDid', 'approvalTargetDigest'], ['messageId']);
    requireDelivery(integer(a.childIndex) && !indices.has(Number(a.childIndex)) && hash(a.approvalTargetDigest) && text(a.relayUrl));
    indices.add(Number(a.childIndex));
    validateManifest(a.manifest as TaskManifest);
    const manifest = a.manifest as TaskManifest;
    requireDelivery(manifest.requester.ownerDid === owner && manifest.worker?.ownerDid === a.peerOwnerDid &&
      manifest.worker?.agentDid === a.peerAgentDid && r.taskIds.includes(manifest.taskId));
    did(a.peerOwnerDid); did(a.peerAgentDid); digest(a.input);
    if ('messageId' in a) requireDelivery(uuid(a.messageId) && r.messageIds.includes(a.messageId));
  }
  if ('approvals' in r) {
    requireDelivery(Array.isArray(r.approvals) && r.approvals.length <= r.preparedActions.length);
    const approved = new Set<number>();
    for (const a of r.approvals) {
      exact(a, ['childIndex', 'targetDigest', 'approvedAt'], ['receipt', 'policy']);
      const action = r.preparedActions.find(p => p.childIndex === a.childIndex);
      requireDelivery(action && !approved.has(Number(a.childIndex)) && a.targetDigest === action.approvalTargetDigest && integer(a.approvedAt));
      approved.add(Number(a.childIndex));
      requireDelivery(('receipt' in a) !== ('policy' in a));
      if ('receipt' in a) {
        validateSchema('approval-receipt', a.receipt);
        const receipt = a.receipt as ApprovalReceipt;
        requireDelivery(verifySigned(receipt, owner) && receipt.payload.taskId === (action.manifest as TaskManifest).taskId &&
          receipt.payload.gate === 'external_side_effect' && receipt.payload.targetDigest === a.targetDigest && receipt.payload.decision === 'APPROVED');
      } else requireDelivery(a.policy === 'configured-auto');
    }
  }
  if ('response' in r) { exact(r.response, ['isError', 'value']); requireDelivery(typeof r.response.isError === 'boolean'); digest(r.response.value); }
  requireDelivery((r.phase === 'finished') === ('response' in r));
  if ('lease' in r) { exact(r.lease, ['holderId', 'until']); requireDelivery(uuid(r.lease.holderId) && integer(r.lease.until) && r.phase !== 'finished'); }
}
