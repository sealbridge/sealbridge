// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { digest, encryptEnvelopePayload, signPayload, verifySigned } from './crypto.js';
import { validateSchema } from './schema.js';
import type {
  Ack,
  Approval,
  ApprovalReceipt,
  Envelope,
  Gate,
  KeyPair,
  SignedEnvelope,
  Usage,
} from './types.js';
export function signApproval(
  taskId: string,
  gate: Gate,
  target: unknown,
  key: KeyPair,
  decision: Approval['decision'] = 'APPROVED',
): ApprovalReceipt {
  return signPayload(
    {
      type: 'ApprovalReceipt',
      receiptId: randomUUID(),
      taskId,
      gate,
      targetDigest: digest(target),
      decision,
      approvedAt: new Date().toISOString(),
    },
    key,
  );
}
export function verifyApproval(
  receipt: ApprovalReceipt,
  ownerDid: string,
  taskId: string,
  gate: Gate,
  target: unknown,
): boolean {
  try {
    validateSchema('approval-receipt', receipt);
    const p = receipt.payload;
    return (
      verifySigned(receipt, ownerDid) &&
      p.taskId === taskId &&
      p.gate === gate &&
      p.targetDigest === digest(target) &&
      p.decision === 'APPROVED'
    );
  } catch {
    return false;
  }
}
export function signUsage(payload: Usage, key: KeyPair) {
  const r = signPayload(payload, key);
  validateSchema('usage-receipt', r);
  return r;
}
export function signAck(payload: Ack, key: KeyPair) {
  if (payload.receiverDid !== key.did) throw new Error('ACK_RECEIVER');
  return signPayload(payload, key);
}
export function signEnvelope(
  payload: Omit<Envelope, 'type' | 'envelopeId' | 'senderDid'>,
  key: KeyPair,
  options?: { encrypt?: boolean; signedAt?: string },
): SignedEnvelope {
  const envelope: Envelope = {
    ...payload,
    type: 'SignedEnvelope',
    envelopeId: randomUUID(),
    senderDid: key.did,
  };
  if (options?.encrypt)
    envelope.payload = encryptEnvelopePayload(envelope.payload, {
      taskId: envelope.taskId,
      seq: envelope.seq,
      eventType: envelope.eventType,
      senderDid: envelope.senderDid,
      recipientDid: envelope.recipientDid,
    });
  return signPayload(envelope, key, options?.signedAt);
}
export function verifyEnvelope(envelope: SignedEnvelope, recipientDid?: string): boolean {
  try {
    validateSchema('envelope', envelope);
    return (
      verifySigned(envelope, envelope.payload.senderDid) &&
      (!recipientDid || envelope.payload.recipientDid === recipientDid)
    );
  } catch {
    return false;
  }
}
