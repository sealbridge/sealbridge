// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createRevocationNotice, digest, generateKeyPair, parseAndVerifyInviteToken, RevocationRegistry, signConnectionRequest, signPayload,
} from '../packages/core/src/index.js';
import type { ConnectionRequest, Signed } from '../packages/core/src/index.js';
import { openConnectionFrame, sealConnectionFrame } from '../packages/runtime/src/connection-transport.js';
import { DAY, EPOCH, FixturePort, card, fixture, invite } from './connection-fixture.js';

const fixtures: ReturnType<typeof fixture>[] = [];
const setup = () => { const f = fixture(); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
function spelled(token: string): string {
  const parsed = JSON.parse(Buffer.from(token.slice(11), 'base64url').toString());
  parsed.payload = Object.fromEntries(Object.entries(parsed.payload).reverse());
  return 'acp://invite?token=' + Buffer.from(JSON.stringify(parsed, null, 2)).toString('base64url');
}
async function send(f: ReturnType<typeof fixture>, who: number, token: string) {
  await f.service(who).request({ toOwnerDid: f.owners[1].did, inviteToken: token });
  return f.frames.filter((e) => e.payload.eventType === 'CONNECTION_REQUEST' && e.payload.senderDid === f.owners[who].did).at(-1)!;
}

describe('first-use connection invite redemption', () => {
  it('requires recipient owner confirmation; parsing and possession record no consent', async () => {
    const f = setup(), token = invite(f.owners[1]);
    parseAndVerifyInviteToken(token, f.now());
    expect(f.ports[0].read().connected).toEqual({});
    await expect(f.service(0, { humanReview: undefined }).request({ toOwnerDid: f.owners[1].did, inviteToken: token }))
      .rejects.toThrow('APPROVAL_CHANNEL_UNAVAILABLE');
    expect(f.frames).toEqual([]);
    const envelope = await send(f, 0, token);
    expect(f.ports[0].read().connected).toEqual({});
    const result = await f.service(1, { humanReview: undefined }).receive(envelope);
    expect(result.status).toBe('connected');
    const acceptance = f.frames.find((e) => e.payload.eventType === 'CONNECTION_ACCEPTED')!;
    await f.service(0).receive(acceptance);
    expect(Object.keys(f.ports[0].read().connected)).toEqual([f.owners[1].did]);
    const persisted = readFileSync(f.ports[0].path, 'utf8') + readFileSync(f.ports[1].path, 'utf8');
    expect(persisted).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('acp-invite');
    for (const event of f.frames) expect(JSON.stringify(event)).not.toContain(token);
  });
  it('atomically binds one owner across two service/port instances and holds the other owner', async () => {
    const f = setup(), token = invite(f.owners[1]);
    const a = await send(f, 0, token), b = await send(f, 2, spelled(token));
    const secondPort = new FixturePort(f.ports[1].path, f.owners[1]);
    const results = await Promise.all([
      f.service(1).receive(a), f.service(1, { persistence: secondPort }).receive(b),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['connected', 'pending']);
    expect(results.find((r) => r.status === 'pending')?.code).toBe('PENDING_OWNER_APPROVAL');
    const state = f.ports[1].read();
    const inviteDigest = digest(parseAndVerifyInviteToken(token, f.now()));
    expect(Object.keys(state.bindings)).toEqual([inviteDigest]);
    expect(Object.keys(state.connected)).toEqual([state.bindings[inviteDigest].owner]);
    expect(Object.keys(state.accepted)).toHaveLength(1);
    expect(Object.keys(state.outbox)).toHaveLength(1);
    const other = state.bindings[inviteDigest].owner === f.owners[0].did ? f.owners[2].did : f.owners[0].did;
    expect(Object.values(state.incoming).some((o) => o.fromOwnerDid === other)).toBe(true);
  });
  it('keeps same-owner repeats idempotent without rebinding a new offer after disconnect', async () => {
    const f = setup(), token = invite(f.owners[1]), envelope = await send(f, 0, token);
    await f.service(1).receive(envelope);
    const before = f.ports[1].read();
    await f.service(1).receive(envelope);
    expect(f.ports[1].read().bindings).toEqual(before.bindings);
    expect(f.ports[1].read().accepted).toEqual(before.accepted);
    expect(Object.values(f.ports[1].read().connected)).toEqual(Object.values(before.connected));
    f.ports[1].removePeer(f.owners[0].did);
    const newOffer = await send(f, 0, spelled(token));
    expect(await f.service(1).receive(newOffer)).toMatchObject({ status: 'pending', code: 'PENDING_OWNER_APPROVAL' });
    expect(f.ports[1].read().bindings).toEqual(before.bindings);
    expect(f.ports[1].read().connected).toEqual({});
  });
  it('does not publish a partial binding when the atomic redemption write fails', async () => {
    const f = setup(), token = invite(f.owners[1]), envelope = await send(f, 0, token);
    f.inspection.status = 'unavailable';
    await f.service(1).receive(envelope);
    f.inspection.status = 'complete';
    const secondPort = new FixturePort(f.ports[1].path, f.owners[1]);
    // Fail the redemption write after the duplicate incoming record is committed.
    const original = secondPort.redeem.bind(secondPort);
    secondPort.redeem = async (commit) => { secondPort.failNext = true; return original(commit); };
    await expect(f.service(1, { persistence: secondPort }).receive(envelope)).rejects.toThrow('FIXTURE_WRITE_FAILED');
    expect(secondPort.read().bindings).toEqual({});
    expect(secondPort.read().connected).toEqual({});
    expect(secondPort.read().outbox).toEqual({});
    await f.service(1).receive(envelope);
    expect(Object.keys(secondPort.read().bindings)).toHaveLength(1);
  });
  it('validates owner, agent, relay, digest, expiry and revocation before holding or binding', async () => {
    const f = setup(), token = invite(f.owners[1]), envelope = await send(f, 0, token);
    const request = openConnectionFrame(envelope, f.owners[1]).event as Signed<ConnectionRequest>;
    const altered = (inviteToken: string, requestOverride: Partial<ConnectionRequest> = {}) => sealConnectionFrame({
      requestId: request.payload.requestId,
      event: signConnectionRequest({ ...request.payload, ...requestOverride }, f.owners[0]), inviteToken,
    }, f.owners[0], f.now());
    await expect(f.service(1).receive(altered(invite(f.owners[2])))).rejects.toThrow('INVITE_WORKER_MISMATCH');
    await expect(f.service(1).receive(altered(invite(f.owners[1], card(f.owners[1], generateKeyPair())))))
      .rejects.toThrow('INVITE_WORKER_MISMATCH');
    const otherRelay = 'https://other.example/relay';
    const otherCard = signPayload({ ...f.options[1].agentCard.payload, relayEndpoint: otherRelay }, f.owners[1], new Date(EPOCH).toISOString());
    const otherInvite = signPayload({ ...parseAndVerifyInviteToken(token, f.now()), relayUrl: otherRelay, agentCard: otherCard },
      f.owners[1], new Date(EPOCH).toISOString());
    await expect(f.service(1).receive(altered('acp-invite:' + Buffer.from(JSON.stringify(otherInvite)).toString('base64url'))))
      .rejects.toThrow('INVITE_WORKER_MISMATCH');
    await expect(f.service(1).receive(altered('acp-invite:invalid'))).rejects.toThrow('INVALID_OR_EXPIRED_INVITE');
    await expect(f.service(1).receive(altered(token, { inviteDigest: digest('different') }))).rejects.toThrow('INVALID_CONNECTION_REQUEST');
    const registry = new RevocationRegistry();
    registry.revoke(createRevocationNotice({ targetType: 'invite', targetId: digest(parseAndVerifyInviteToken(token, f.now())),
      reason: 'Retired', revokedAt: new Date(EPOCH).toISOString() }, f.owners[1]));
    await expect(f.service(1, { revocations: registry }).receive(envelope)).rejects.toThrow('TOKEN_REVOKED');
    f.advance(DAY);
    await expect(f.service(1, { revocations: registry }).receive(envelope)).rejects.toThrow('TOKEN_REVOKED');
    await expect(f.service(1).receive(envelope)).rejects.toThrow('INVITE_EXPIRED');
    expect(f.ports[1].read().bindings).toEqual({});
    expect(f.ports[1].read().incoming).toEqual({});
    expect(f.inspection.held.size).toBe(0);
  });
  it('checks effective card expiry and does not redeem an uninspected invite request', async () => {
    const f = setup();
    const shortCard = signPayload({ ...f.options[1].agentCard.payload, expiresAt: new Date(EPOCH + 1000).toISOString() },
      f.owners[1], new Date(EPOCH).toISOString());
    const token = invite(f.owners[1], shortCard), envelope = await send(f, 0, token);
    f.inspection.status = 'unavailable';
    expect(await f.service(1).receive(envelope)).toMatchObject({ code: 'PENDING_OWNER_APPROVAL', retryable: false });
    expect(f.ports[1].read().bindings).toEqual({});
    f.advance(1000);
    f.inspection.status = 'complete';
    await expect(f.service(1).receive(envelope)).rejects.toThrow('INVITE_EXPIRED');
    expect(f.ports[1].read().bindings).toEqual({});
  });
  it('retains a committed connection when its invitation later expires or is revoked', async () => {
    const f = setup(), token = invite(f.owners[1]), envelope = await send(f, 0, token);
    await f.service(1).receive(envelope);
    const connected = f.ports[1].read().connected;
    f.advance(DAY);
    await expect(f.service(1).receive(envelope)).rejects.toThrow('INVITE_EXPIRED');
    expect(f.ports[1].read().connected).toEqual(connected);
  });
});
