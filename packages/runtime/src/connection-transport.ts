// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import {
  canonicalize, connectionEventName, connectionRoutingId, encryptEnvelopePayload,
  isConnectionEvent, openEnvelope, signPayload, verifySigned,
  verifyConnectionRequest, verifyConnectionAccepted, verifyConnectionAck,
} from '@acp/core';
import type { ConnectionControl, ConnectionRequest, Json, KeyPair, Signed, SignedEnvelope } from '@acp/core';

export interface ConnectionFrame {
  requestId: string;
  event: Signed<ConnectionControl>;
  inviteToken?: string;
}
export interface ConnectionTransport {
  send(relayUrl: string, envelope: SignedEnvelope): Promise<void>;
}
function validEvent(event: Signed<ConnectionControl>): boolean {
  switch (event?.payload?.type) {
    case 'ConnectionRequest': return verifyConnectionRequest(event as Signed<ConnectionRequest>);
    case 'ConnectionAccepted': return verifyConnectionAccepted(event as Parameters<typeof verifyConnectionAccepted>[0]);
    case 'ConnectionAck': return verifyConnectionAck(event as Parameters<typeof verifyConnectionAck>[0]);
    default: return false;
  }
}
function validateFrame(frame: ConnectionFrame): void {
  if (!validEvent(frame.event)) {
    const type = frame.event?.payload?.type;
    throw new Error(type === 'ConnectionRequest' ? 'INVALID_CONNECTION_REQUEST'
      : type === 'ConnectionAccepted' ? 'INVALID_CONNECTION_ACCEPTED'
        : type === 'ConnectionAck' ? 'INVALID_CONNECTION_ACK' : 'INVALID_CONNECTION_CONTROL');
  }
  connectionRoutingId(frame.requestId);
  const p = frame.event.payload;
  if (p.type !== 'ConnectionAck' && p.requestId !== frame.requestId) throw new Error('INVALID_CONNECTION_CONTROL');
  if (frame.inviteToken !== undefined && (p.type !== 'ConnectionRequest' ||
      typeof frame.inviteToken !== 'string' || frame.inviteToken.length > 68 * 1024 || !p.inviteDigest))
    throw new Error('INVALID_CONNECTION_REQUEST');
}

/** Owner-addressed control frames use a routing namespace independent of task sessions. */
export function sealConnectionFrame(
  frame: ConnectionFrame, owner: KeyPair, now: number, envelopeId: string = randomUUID(),
): SignedEnvelope {
  validateFrame(frame);
  const p = frame.event.payload;
  if (p.fromOwnerDid !== owner.did) throw new Error('INVALID_CONNECTION_CONTROL');
  const header = {
    taskId: connectionRoutingId(frame.requestId), seq: 0, eventType: connectionEventName(p),
    senderDid: owner.did, recipientDid: p.toOwnerDid,
  };
  const body = p.type === 'ConnectionRequest'
    ? { request: frame.event, ...(frame.inviteToken === undefined ? {} : { inviteToken: frame.inviteToken }) }
    : frame.event;
  return signPayload({
    type: 'SignedEnvelope', envelopeId, ...header,
    payload: encryptEnvelopePayload(body as unknown as Json, header),
  }, owner, new Date(now).toISOString());
}

export function openConnectionFrame(envelope: SignedEnvelope, owner: KeyPair): ConnectionFrame {
  try {
    const h = envelope.payload;
    if (!isConnectionEvent(h.eventType) || h.type !== 'SignedEnvelope' || h.seq !== 0 ||
        h.recipientDid !== owner.did || !h.taskId.startsWith('conn_') || !h.envelopeId ||
        !verifySigned(envelope, h.senderDid) ||
        Object.keys(envelope).sort().join() !== 'payload,signature' ||
        Object.keys(envelope.signature).sort().join() !== 'canonicalization,payloadDigest,signature,signedAt,signerDid' ||
        Object.keys(h).sort().join() !== 'envelopeId,eventType,payload,recipientDid,senderDid,seq,taskId,type' ||
        Buffer.byteLength(canonicalize(envelope)) > 256 * 1024)
      throw new Error();
    const body = openEnvelope<unknown>(envelope, owner);
    let event: Signed<ConnectionControl>, inviteToken: string | undefined;
    if (h.eventType === 'CONNECTION_REQUEST') {
      const b = body as { request: Signed<ConnectionRequest>; inviteToken?: string };
      if (!b || Object.keys(b).some((k) => k !== 'request' && k !== 'inviteToken')) throw new Error();
      event = b.request;
      inviteToken = b.inviteToken;
    } else event = body as Signed<ConnectionControl>;
    const frame: ConnectionFrame = { requestId: h.taskId.slice(5), event,
      ...(inviteToken === undefined ? {} : { inviteToken }) };
    validateFrame(frame);
    if (connectionEventName(event.payload) !== h.eventType || event.payload.fromOwnerDid !== h.senderDid ||
        event.payload.toOwnerDid !== h.recipientDid) throw new Error();
    return frame;
  } catch (error) {
    if (error instanceof Error && ['UNENCRYPTED_ENVELOPE_REJECTED', 'INVALID_CONNECTION_REQUEST',
      'INVALID_CONNECTION_ACCEPTED', 'INVALID_CONNECTION_ACK'].includes(error.message)) throw error;
    throw new Error('INVALID_CONNECTION_CONTROL');
  }
}

/** Retry the same signed notification with a fresh relay envelope ID. Inner consent stays unchanged. */
export function retryConnectionEnvelope(envelope: SignedEnvelope, owner: KeyPair, now: number): SignedEnvelope {
  if (envelope.payload.senderDid !== owner.did || !isConnectionEvent(envelope.payload.eventType) ||
      !verifySigned(envelope, owner.did)) throw new Error('INVALID_CONNECTION_CONTROL');
  return signPayload({ ...envelope.payload, envelopeId: randomUUID() }, owner, new Date(now).toISOString());
}
