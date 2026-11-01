// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CONNECTION_OFFER_LIFETIME_MS, digest, generateKeyPair, signConnectionAccepted,
  signConnectionRequest, signPayload, validateConnectionRequest, verifyConnectionAccepted,
  verifyConnectionAck, verifyConnectionRequest,
} from '../packages/core/src/index.js';
import type { ConnectionAccepted, ConnectionRequest, Signed, SignedEnvelope } from '../packages/core/src/index.js';
import { openConnectionFrame, sealConnectionFrame } from '../packages/runtime/src/connection-transport.js';
import { DAY, EPOCH, FixturePort, card, fixture } from './connection-fixture.js';

const fixtures: ReturnType<typeof fixture>[] = [];
const setup = () => { const f = fixture(); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
function request(f: ReturnType<typeof fixture>, overrides: Partial<ConnectionRequest> = {}) {
  return signConnectionRequest({ type: 'ConnectionRequest', v: 1, protocolVersion: '0.2.0',
    requestId: 'request_1', fromOwnerDid: f.owners[0].did, toOwnerDid: f.owners[1].did,
    agentCard: f.options[0].agentCard, message: '', createdAt: new Date(EPOCH).toISOString(),
    expiresAt: new Date(EPOCH + DAY).toISOString(), ...overrides }, f.owners[0]);
}
async function pending(f: ReturnType<typeof fixture>) {
  await f.service(0).request({ toOwnerDid: f.owners[1].did, message: 'Connect for review' });
  const envelope = f.frames.shift()!;
  expect(await f.service(1).receive(envelope)).toMatchObject({ status: 'pending', code: 'PENDING_OWNER_APPROVAL' });
  return envelope;
}

describe('connection control validation', () => {
  it('counts Unicode code points and bounds identifiers, fields, lifetimes and card ownership', () => {
    const f = setup(), valid = request(f, { message: '😀'.repeat(240) });
    expect(verifyConnectionRequest(valid)).toBe(true);
    expect(() => request(f, { message: '😀'.repeat(241) })).toThrow('INVALID_CONNECTION_REQUEST');
    expect(() => request(f, { expiresAt: new Date(EPOCH + CONNECTION_OFFER_LIFETIME_MS + 1).toISOString() })).toThrow();
    expect(() => request(f, { requestId: '../request' })).toThrow();
    expect(() => request(f, { createdAt: '2026-02-30T00:00:00.000Z' })).toThrow();
    expect(validateConnectionRequest({ ...valid.payload, extra: true })).toBe(false);
    expect(validateConnectionRequest({ ...valid.payload, agentCard: f.options[1].agentCard })).toBe(false);
    expect(validateConnectionRequest({ ...valid.payload, message: '\ud800' })).toBe(false);
    expect(validateConnectionRequest(null)).toBe(false);
    expect(verifyConnectionRequest(signPayload(valid.payload, f.owners[2], new Date(EPOCH).toISOString()))).toBe(false);
    valid.payload.message = 'changed';
    expect(verifyConnectionRequest(valid)).toBe(false);
  });
  it('verifies distinct agent delegation, proposal binding and bounded card bodies', () => {
    const f = setup(), delegated = card(f.owners[0], generateKeyPair());
    expect(verifyConnectionRequest(request(f, { agentCard: delegated, originProposalDigest: digest('proposal') }))).toBe(true);
    const changed = structuredClone(delegated);
    changed.payload.agentDid = f.owners[2].did;
    expect(() => request(f, { agentCard: changed })).toThrow();
    const large = signPayload({ ...f.options[0].agentCard.payload, description: 'a'.repeat(65536) }, f.owners[0], new Date(EPOCH).toISOString());
    expect(() => request(f, { agentCard: large })).toThrow();
  });
  it('rejects accepted and ACK payload variants outside the control profile', async () => {
    const f = setup(), incoming = await pending(f);
    await f.service(1).approve(incoming);
    const accepted = openConnectionFrame(f.frames.at(-1)!, f.owners[0]).event as Signed<ConnectionAccepted>;
    for (const patch of [{ trust: 'trusted' }, { expiresAt: new Date(EPOCH + DAY).toISOString() },
      { eventId: 'a'.repeat(97) }, { requestDigest: 'sha256:ABC' }, { protocolVersion: '0.1.0' }]) {
      expect(verifyConnectionAccepted(signPayload({ ...accepted.payload, ...patch }, f.owners[1], new Date(EPOCH).toISOString()) as Signed<ConnectionAccepted>)).toBe(false);
    }
    await f.service(0).receive(f.frames.at(-1)!);
    const ack = openConnectionFrame(f.frames.at(-1)!, f.owners[1]).event as Parameters<typeof verifyConnectionAck>[0];
    expect(verifyConnectionAck(signPayload({ ...ack.payload, protocolVersion: '0.2.0' }, f.owners[0], new Date(EPOCH).toISOString()))).toBe(false);
    expect(verifyConnectionAck(signPayload(ack.payload, f.owners[2], new Date(EPOCH).toISOString()))).toBe(false);
  });
});

describe('standalone connection consent exchange', () => {
  it('persists bilateral limited consent and ACK outside any task session, across restarts', async () => {
    const f = setup(), incoming = await pending(f);
    expect(f.ports[0].read().connected).toEqual({});
    expect(f.ports[1].read().connected).toEqual({});
    await f.service(1).approve(incoming);
    const acceptance = f.frames.find((e) => e.payload.eventType === 'CONNECTION_ACCEPTED')!;
    const p = openConnectionFrame(acceptance, f.owners[0]).event as Signed<ConnectionAccepted>;
    expect(verifyConnectionAccepted(p)).toBe(true);
    expect(p.payload.trust).toBe('limited');
    expect(p.payload).not.toHaveProperty('expiresAt');
    expect(await f.service(0).receive(acceptance)).toMatchObject({ status: 'connected' });
    const ack = f.frames.find((e) => e.payload.eventType === 'CONNECTION_ACK')!;
    expect(verifyConnectionAck(openConnectionFrame(ack, f.owners[1]).event as Parameters<typeof verifyConnectionAck>[0])).toBe(true);
    await f.service(1).receive(ack);
    await f.service(1).receive(ack);
    expect(f.ports[1].read().acked).toEqual([digest(p)]);
    expect(Object.keys(f.ports[1].read().outbox)).toEqual([]);
    expect(Object.values(f.ports[0].read().connected)).toEqual(Object.values(f.ports[1].read().connected));
    f.advance(365 * DAY);
    expect(new FixturePort(f.ports[0].path, f.owners[0]).read().connected[f.owners[1].did]).toBe(p.payload.connectionId);
    expect(f.inspection.held.size).toBe(0);
  });
  it('requires human review for outgoing and incoming consent and an exact inspection completion', async () => {
    const f = setup();
    await expect(f.service(0, { humanReview: undefined }).request({ toOwnerDid: f.owners[1].did })).rejects.toThrow('APPROVAL_CHANNEL_UNAVAILABLE');
    await expect(f.service(0, { humanReview: { kind: 'human', review: async () => false } }).request({ toOwnerDid: f.owners[1].did })).rejects.toThrow('APPROVAL_REJECTED');
    expect(f.frames).toEqual([]);
    const incoming = await pending(f);
    await expect(f.service(1, { humanReview: undefined }).approve(incoming)).rejects.toThrow('APPROVAL_CHANNEL_UNAVAILABLE');
    f.inspection.mismatch = true;
    await expect(f.service(1).approve(incoming)).rejects.toThrow('INSPECTION_INCOMPLETE');
    f.inspection.mismatch = false;
    f.inspection.status = 'error';
    await expect(f.service(1).approve(incoming)).rejects.toThrow('INSPECTION_INCOMPLETE');
    expect(f.ports[1].read().connected).toEqual({});
  });
  it('rechecks owner state and offer deadline after asynchronous review', async () => {
    const f = setup(), incoming = await pending(f);
    await expect(f.service(1, { humanReview: { kind: 'human', review: async () => {
      f.ports[1].removePeer(f.owners[0].did, true);
      return true;
    } } }).approve(incoming)).rejects.toThrow('CONNECTION_NOT_PENDING');
    expect(f.ports[1].read().connected).toEqual({});
    await expect(f.service(2, { humanReview: { kind: 'human', review: async () => {
      f.advance(14 * DAY);
      return true;
    } } }).request({ toOwnerDid: f.owners[0].did })).rejects.toThrow('CONNECTION_REQUEST_EXPIRED');
    expect(f.ports[2].read().outgoing).toEqual({});
  });
  it('holds unavailable inspection and leaves failed held persistence unacknowledged', async () => {
    const f = setup();
    await f.service(0).request({ toOwnerDid: f.owners[1].did });
    const envelope = f.frames[0];
    await expect(f.service(1, { inspection: undefined }).receive(envelope)).rejects.toThrow('INSPECTION_UNAVAILABLE');
    expect(f.ports[1].read().incoming).toEqual({});
    f.inspection.failHold = true;
    await expect(f.service(1).receive(envelope)).rejects.toThrow('FIXTURE_HOLD_FAILED');
    expect(f.ports[1].read().incoming).toEqual({});
    f.inspection.failHold = false;
    f.inspection.status = 'unavailable';
    expect(await f.service(1).receive(envelope)).toMatchObject({ code: 'PENDING_OWNER_APPROVAL' });
    expect([...f.inspection.held.values()][0].expiresAt).toBe(new Date(EPOCH + DAY).toISOString());
    f.advance(1000);
    await f.service(1).receive(envelope);
    expect([...f.inspection.held.values()][0].expiresAt).toBe(new Date(EPOCH + DAY).toISOString());
  });
  it('keeps committed notification after send failure and retries the same signed event', async () => {
    const f = setup(), incoming = await pending(f);
    const result = await f.service(1, { transport: { send: async () => { throw new Error('offline'); } } }).approve(incoming);
    expect(result).toMatchObject({ status: 'connected', code: 'CONNECTION_DELIVERY_PENDING' });
    const before = f.ports[1].read();
    expect(Object.keys(before.connected)).toEqual([f.owners[0].did]);
    await f.service(1).flushOutbox();
    const acceptance = f.frames.at(-1)!;
    expect(digest(openConnectionFrame(acceptance, f.owners[0]).event)).toBe(digest(Object.values(before.accepted)[0]));
    expect(acceptance.payload.envelopeId).not.toBe(Object.values(before.outbox)[0].envelope.payload.envelopeId);
    await f.service(0).receive(acceptance);
    const originalAck = f.frames.at(-1)!;
    f.frames.splice(0);
    await f.service(0).receive(acceptance);
    expect(digest(openConnectionFrame(f.frames.at(-1)!, f.owners[1]).event)).toBe(digest(openConnectionFrame(originalAck, f.owners[1]).event));
    await f.service(1).receive(f.frames.at(-1)!);
    expect(Object.keys(f.ports[1].read().outbox)).toEqual([]);
  });
  it('does not send or acknowledge connection writes that fail publication', async () => {
    const f = setup();
    f.ports[0].failNext = true;
    await expect(f.service(0).request({ toOwnerDid: f.owners[1].did })).rejects.toThrow('FIXTURE_WRITE_FAILED');
    expect(f.frames).toEqual([]);
    const incoming = await pending(f);
    f.ports[1].failNext = true;
    await expect(f.service(1).approve(incoming)).rejects.toThrow('FIXTURE_WRITE_FAILED');
    expect(f.ports[1].read().connected).toEqual({});
    await f.service(1).approve(incoming);
    const acceptance = f.frames.at(-1)!;
    f.frames.splice(0);
    f.ports[0].failNext = true;
    await expect(f.service(0).receive(acceptance)).rejects.toThrow('FIXTURE_WRITE_FAILED');
    expect(f.ports[0].read().connected).toEqual({});
    expect(f.frames).toEqual([]);
    expect(readFileSync(f.ports[0].path, 'utf8')).not.toContain('privateKey');
  });
  it('persists receipt before ACKing delivery and ignores foreign or reordered ACKs', async () => {
    const f = setup(), incoming = await pending(f);
    await f.service(1).approve(incoming);
    const acceptance = f.frames.at(-1)!;
    await f.service(0).receive(acceptance);
    const ackEnvelope = f.frames.at(-1)!, frame = openConnectionFrame(ackEnvelope, f.owners[1]);
    f.ports[1].failNext = true;
    await expect(f.service(1).receive(ackEnvelope)).rejects.toThrow('FIXTURE_WRITE_FAILED');
    expect(f.ports[1].read().acked).toEqual([]);
    expect(Object.keys(f.ports[1].read().outbox)).toHaveLength(1);
    const ack = frame.event as Parameters<typeof verifyConnectionAck>[0];
    const foreign = sealConnectionFrame({ requestId: frame.requestId,
      event: signPayload({ ...ack.payload, fromOwnerDid: f.owners[2].did }, f.owners[2], new Date(EPOCH).toISOString()),
    }, f.owners[2], f.now());
    await f.service(1).receive(foreign);
    await f.service(1).receive(sealConnectionFrame({ ...frame, requestId: 'other_request' }, f.owners[0], f.now()));
    expect(f.ports[1].read().acked).toEqual([]);
    await f.service(1).receive(ackEnvelope);
    expect(f.ports[1].read().acked).toHaveLength(1);
  });
  it.each(['withdrawal', 'disconnect', 'block'])('keeps %s ahead of late and repeated acceptance', async (kind) => {
    const f = setup(), incoming = await pending(f);
    await f.service(1).approve(incoming);
    const acceptance = f.frames.at(-1)!;
    if (kind !== 'withdrawal') await f.service(0).receive(acceptance);
    f.ports[0].removePeer(f.owners[1].did, kind === 'block');
    await expect(f.service(0).receive(acceptance)).rejects.toThrow('CONNECTION_NOT_PENDING');
    expect(f.ports[0].read().connected).toEqual({});
  });
  it('rejects foreign, unsolicited, mismatched and expired acceptance and bounds retries', async () => {
    const f = setup(), incoming = await pending(f);
    await f.service(1).approve(incoming);
    const acceptance = f.frames.at(-1)!;
    const frame = openConnectionFrame(acceptance, f.owners[0]);
    const event = frame.event as Signed<ConnectionAccepted>;
    const changed = (patch: Partial<ConnectionAccepted>, signer = f.owners[1]): SignedEnvelope => sealConnectionFrame({
      requestId: patch.requestId ?? frame.requestId, event: signConnectionAccepted({ ...event.payload, ...patch }, signer),
    }, signer, f.now());
    await expect(f.service(0).receive(changed({ requestDigest: digest('other') }))).rejects.toThrow('CONNECTION_NOT_PENDING');
    await expect(f.service(0).receive(changed({ fromOwnerDid: f.owners[2].did }, f.owners[2]))).rejects.toThrow('CONNECTION_NOT_PENDING');
    await expect(f.service(0).receive(changed({ requestId: 'unsolicited' }))).rejects.toThrow();
    const future = changed({ acceptedAt: new Date(EPOCH + 61_000).toISOString() });
    await expect(f.service(0).receive(future)).rejects.toThrow('INVALID_CONNECTION_ACCEPTED');
    f.advance(14 * DAY);
    await expect(f.service(0).receive(acceptance)).rejects.toThrow('CONNECTION_REQUEST_EXPIRED');
    f.frames.splice(0);
    await f.service(1).flushOutbox();
    expect(f.frames).toEqual([]);
    expect(f.ports[0].read().connected).toEqual({});
  });
});
