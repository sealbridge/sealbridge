// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CONNECTION_OFFER_LIFETIME_MS, MAX_AGENT_CARD_EXPIRY_MS, createInviteToken,
  createSignedAgentCard, generateKeyPair, parseAndVerifyInviteToken, signPayload,
  verifyConnectionRequest, verifySignedAgentCard,
} from '../packages/core/src/index.js';
import { openConnectionFrame } from '../packages/runtime/src/connection-transport.js';
import { workerIntakePath } from '../packages/runtime/src/index.js';
import { reissueInvite, setupInvite } from '../cli/src/invite-share.js';
import { admissionFixture } from './connections-fixture.js';
import { DAY, EPOCH, fixture } from './connection-fixture.js';

const cleanups: Array<() => void> = [];
// Date is fixed for unrelated live checks; the injected construction clock advances on every read.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(EPOCH); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});
function advancingClock() {
  let time = EPOCH;
  return { now: () => time++, peek: () => time, advance: (ms: number) => { time += ms; } };
}

it.each(['none', 'limited', 'trusted'] as const)(
  'records an exact 14-day incoming offer with an advancing clock and %s legacy grant', async trust => {
    const clock = advancingClock(), f = admissionFixture({ now: clock.now }, true);
    cleanups.push(f.cleanup);
    if (trust !== 'none') {
      const path = workerIntakePath(f.owner.did, f.identityOptions);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, JSON.stringify(signPayload({ version: 1, workerOwnerDid: f.owner.did, requests: [],
        grants: [{ did: f.requester.did, trust, expiresAt: EPOCH + DAY }], denials: [] },
      f.owner, new Date(EPOCH).toISOString())), { mode: 0o600 });
    }
    await expect(f.raw()).rejects.toThrow('PENDING_OWNER_APPROVAL');
    const connection = f.store.listConnections()[0];
    if (!('incoming' in connection) || !connection.incoming) throw new Error('Expected incoming offer');
    expect(connection.incoming.expiresAt - connection.incoming.receivedAt).toBe(CONNECTION_OFFER_LIFETIME_MS);
    expect(f.store.connectionState(f.requester.did)).toBe('pending');
    expect(f.store.list()[0].state).toBe('pending');
    expect(f.review.list()).toHaveLength(1);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.human.approve).not.toHaveBeenCalled();
    expect(f.approve).not.toHaveBeenCalled();
  },
);

it('records an exact 14-day outgoing request with an advancing clock', async () => {
  const f = fixture(), clock = advancingClock(); cleanups.push(f.cleanup);
  const result = await f.service(0, { now: clock.now }).request({ toOwnerDid: f.owners[1].did });
  expect(result.status).toBe('pending');
  const request = openConnectionFrame(f.frames[0], f.owners[1]).event;
  if (request.payload.type !== 'ConnectionRequest') throw new Error('Expected connection request');
  expect(verifyConnectionRequest({ ...request, payload: request.payload })).toBe(true);
  expect(Date.parse(request.payload.expiresAt) - Date.parse(request.payload.createdAt)).toBe(CONNECTION_OFFER_LIFETIME_MS);
  const saved = f.ports[0].read();
  expect(saved.outgoing[result.requestId].expiresAt).toBe(request.payload.expiresAt);
  expect(saved.outbox[result.requestId].deliveryDeadline).toBe(request.payload.expiresAt);
});

it('retains explicit request expiry with an advancing clock and rejects one millisecond beyond the maximum', async () => {
  const f = fixture(), clock = advancingClock(); cleanups.push(f.cleanup);
  const service = f.service(0, { now: clock.now }), expiresAt = new Date(EPOCH + DAY).toISOString();
  const result = await service.request({ toOwnerDid: f.owners[1].did, expiresAt });
  expect(f.ports[0].read().outgoing[result.requestId].expiresAt).toBe(expiresAt);
  const current = advancingClock();
  const invalid = f.service(0, { now: current.now });
  await expect(invalid.request({ toOwnerDid: f.owners[1].did,
    expiresAt: new Date(current.peek() + CONNECTION_OFFER_LIFETIME_MS + 1).toISOString(),
  })).rejects.toThrow('INVALID_CONNECTION_REQUEST');
});

it('creates a worker card at the maximum lifetime with an advancing clock', () => {
  const clock = advancingClock();
  const f = admissionFixture({ now: clock.now, inviteTtlSeconds: MAX_AGENT_CARD_EXPIRY_MS / 1000 });
  cleanups.push(f.cleanup);
  const card = f.worker.agentCard;
  expect(Date.parse(card.payload.expiresAt) - Date.parse(card.signature.signedAt)).toBe(MAX_AGENT_CARD_EXPIRY_MS);
  expect(verifySignedAgentCard(card, EPOCH)).toBe(true);
});

it.each([undefined, MAX_AGENT_CARD_EXPIRY_MS / 1000])(
  'renews a worker card with one timestamp and configured TTL %s', async inviteTtlSeconds => {
    const clock = advancingClock(), f = admissionFixture({ now: clock.now }); cleanups.push(f.cleanup);
    f.worker.options.inviteTtlSeconds = inviteTtlSeconds;
    clock.advance(MAX_AGENT_CARD_EXPIRY_MS + 1);
    await f.worker.register();
    const card = f.worker.agentCard;
    expect(Date.parse(card.payload.expiresAt) - Date.parse(card.signature.signedAt)).toBe((inviteTtlSeconds ?? 86400) * 1000);
    expect(verifySignedAgentCard(card, clock.now())).toBe(true);
  },
);

function cliInvite() {
  const owner = generateKeyPair();
  const card = createSignedAgentCard({ name: 'Clock fixture', agentDid: owner.did,
    relayEndpoint: 'https://relay.example', skills: [], now: EPOCH }, owner);
  return { owner, token: createInviteToken({ agentCard: card, issuedAt: new Date(EPOCH).toISOString() }, owner) };
}

it('reissues an invite and card from one timestamp with an advancing CLI clock', () => {
  const f = cliInvite(), clock = advancingClock();
  vi.spyOn(Date, 'now').mockImplementation(clock.now);
  const token = reissueInvite(f.token, f.owner, MAX_AGENT_CARD_EXPIRY_MS / 1000);
  const invite = parseAndVerifyInviteToken(token, EPOCH), card = invite.agentCard;
  expect(Date.parse(card.payload.expiresAt) - Date.parse(card.signature.signedAt)).toBe(MAX_AGENT_CARD_EXPIRY_MS);
  expect(invite.issuedAt).toBe(card.signature.signedAt);
  expect(invite.expiresAt).toBe(card.payload.expiresAt);
});

it('creates a reciprocal invite and card from one timestamp with an advancing CLI clock', () => {
  const f = cliInvite(), clock = advancingClock(), root = mkdtempSync(join(tmpdir(), 'connection-clock-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  vi.spyOn(Date, 'now').mockImplementation(clock.now);
  const out = join(root, 'reciprocal.txt');
  setupInvite(f.token, join(root, 'identity.json'), join(root, 'contacts.json'), out);
  const invite = parseAndVerifyInviteToken(readFileSync(out, 'utf8'), EPOCH), card = invite.agentCard;
  expect(Date.parse(card.payload.expiresAt) - Date.parse(card.signature.signedAt)).toBe(DAY);
  expect(invite.issuedAt).toBe(card.signature.signedAt);
  expect(invite.expiresAt).toBe(card.payload.expiresAt);
});
