// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { CONNECTION_EVENTS, digest, encryptEnvelopePayload, signConnectionRequest, signPayload } from '../packages/core/src/index.js';
import type { Json, SignedEnvelope } from '../packages/core/src/index.js';
import { classifyEnvelopeRole, InMemoryRelay } from '../packages/relay/src/fetch.js';
import { openConnectionFrame, sealConnectionFrame } from '../packages/runtime/src/connection-transport.js';
import { EPOCH, DAY, fixture } from './connection-fixture.js';

const fixtures: ReturnType<typeof fixture>[] = [];
const setup = () => { const f = fixture(); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });

describe('connection control routing', () => {
  it.each(CONNECTION_EVENTS)('routes %s to the worker role without changing task role or audit sequence state', (eventType) => {
    const f = setup(), relay = new InMemoryRelay({ now: f.now });
    const frame = signPayload({ type: 'SignedEnvelope' as const, envelopeId: 'routing_' + eventType,
      taskId: 'conn_routing', seq: 0, senderDid: f.owners[0].did, recipientDid: f.owners[1].did,
      eventType, payload: {} }, f.owners[0], new Date(EPOCH).toISOString());
    const state = { crossRole: new Map<string, 'worker' | 'requester'>([[f.owners[1].did, 'requester']]),
      lastPrimaryRole: 'requester' as const, pendingAckRoles: ['worker' as const], workerSeq: 5, requesterSeq: 8 };
    const before = structuredClone(state);
    expect(classifyEnvelopeRole(frame, state)).toBe('worker');
    expect(state).toEqual(before);
    relay.send(frame);
    expect(relay.receive(f.owners[1].did, undefined, undefined, { role: 'requester', taskId: 'conn_routing' })).toBeUndefined();
    expect(relay.receive(f.owners[1].did, undefined, undefined, { role: 'worker' })).toEqual(frame);
    relay.send(signPayload({ ...frame.payload, envelopeId: frame.payload.envelopeId + '_same',
      senderDid: f.owners[1].did }, f.owners[1], new Date(EPOCH).toISOString()));
    expect(relay.receive(f.owners[1].did, undefined, undefined, { role: 'requester', taskId: 'conn_routing' })).toBeUndefined();
    expect(relay.receive(f.owners[1].did, undefined, undefined, { role: 'worker' })?.payload.eventType).toBe(eventType);
  });
  it('retains worker classification through a relay snapshot and delivers after task mailbox teardown', async () => {
    const f = setup(), relay = new InMemoryRelay({ now: f.now });
    await f.service(0).request({ toOwnerDid: f.owners[1].did });
    const request = f.frames.shift()!;
    await f.service(1).receive(request);
    await f.service(1).approve(request);
    const acceptance = f.frames.at(-1)!;
    relay.send(acceptance);
    const restored = new InMemoryRelay({ now: f.now });
    restored.restore(relay.snapshot());
    expect(restored.receive(f.owners[0].did, undefined, undefined, { role: 'requester', taskId: 'finished-task' })).toBeUndefined();
    const delivery = restored.receive(f.owners[0].did, undefined, undefined, { role: 'worker' })!;
    expect(await f.service(0).receive(delivery)).toMatchObject({ status: 'connected' });
  });
  it('binds signed inner/outer owners, recipient, event, namespace and encryption', () => {
    const f = setup();
    const request = signConnectionRequest({ type: 'ConnectionRequest', v: 1, protocolVersion: '0.2.0',
      requestId: 'r1', fromOwnerDid: f.owners[0].did, toOwnerDid: f.owners[1].did,
      agentCard: f.options[0].agentCard, message: 'Review this offer', createdAt: new Date(EPOCH).toISOString(),
      expiresAt: new Date(EPOCH + DAY).toISOString(), inviteDigest: digest('invite') }, f.owners[0]);
    const envelope = sealConnectionFrame({ requestId: 'r1', event: request, inviteToken: 'acp-invite:fixture' }, f.owners[0], EPOCH);
    expect(envelope.payload).toMatchObject({ taskId: 'conn_r1', seq: 0, eventType: 'CONNECTION_REQUEST' });
    expect(JSON.stringify(envelope)).not.toContain('acp-invite:fixture');
    expect(openConnectionFrame(envelope, f.owners[1]).event).toEqual(request);
    expect(() => openConnectionFrame(envelope, f.owners[2])).toThrow('INVALID_CONNECTION_CONTROL');
    for (const patch of [{ taskId: 'task_r1' }, { taskId: 'conn_other' }, { seq: 1 },
      { eventType: 'CONNECTION_ACCEPTED' }, { recipientDid: f.owners[2].did }]) {
      const changed = signPayload({ ...envelope.payload, ...patch }, f.owners[0], new Date(EPOCH).toISOString());
      expect(() => openConnectionFrame(changed, f.owners[1])).toThrow('INVALID_CONNECTION_CONTROL');
    }
    const cleartext = signPayload({ ...envelope.payload, payload: { request } as unknown as SignedEnvelope['payload']['payload'] },
      f.owners[0], new Date(EPOCH).toISOString());
    expect(() => openConnectionFrame(cleartext, f.owners[1])).toThrow('UNENCRYPTED_ENVELOPE_REJECTED');
    const foreign = signPayload({ ...envelope.payload, senderDid: f.owners[2].did }, f.owners[2], new Date(EPOCH).toISOString());
    expect(() => openConnectionFrame(foreign, f.owners[1])).toThrow('INVALID_CONNECTION_CONTROL');
    const header = { taskId: 'conn_r1', seq: 0, eventType: 'CONNECTION_ACCEPTED',
      senderDid: f.owners[1].did, recipientDid: f.owners[0].did };
    const unsupported = signPayload({ type: 'ConnectionAccepted', v: 1, protocolVersion: '0.2.0',
      eventId: 'a1', connectionId: 'c1', requestId: 'r1', requestDigest: digest(request),
      fromOwnerDid: f.owners[1].did, toOwnerDid: f.owners[0].did,
      acceptedAt: new Date(EPOCH).toISOString(), trust: 'trusted' }, f.owners[1], new Date(EPOCH).toISOString());
    const invalidAccepted = signPayload({ type: 'SignedEnvelope' as const, envelopeId: 'unsupported', ...header,
      payload: encryptEnvelopePayload(unsupported as unknown as Json, header) }, f.owners[1], new Date(EPOCH).toISOString());
    expect(() => openConnectionFrame(invalidAccepted, f.owners[0])).toThrow('INVALID_CONNECTION_ACCEPTED');
  });
});
