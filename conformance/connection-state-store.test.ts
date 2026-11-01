// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInviteToken, createSignedAgentCard, digest, generateKeyPair, parseAndVerifyInviteToken,
  signPayload, verifySigned } from '../packages/core/src/index.js';
import type { Invite, Json, KeyPair, Signed } from '../packages/core/src/index.js';
import { WorkerTrustStore, workerIntakePath, buildTaskManifest, CONNECTION_DAY_MS as DAY,
  CONNECTION_OFFER_TTL_MS as TTL, emptyConnectionData, connectionPersistencePort } from '../packages/runtime/src/index.js';
import type { ConnectionOutboxRecord, ApplyConnectionAcceptedInput } from '../packages/runtime/src/index.js';

const NOW = Date.parse('2026-11-02T00:00:00.000Z');
const RELAY = 'https://relay.example.test';
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'sealbridge-connections-'));
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const owner = generateKeyPair(), peer = generateKeyPair(); let clock = NOW;
  const path = workerIntakePath(owner.did, { env: { SEALBRIDGE_DATA_DIR: join(root, 'data') } });
  const options = { path, now: () => clock };
  const store = new WorkerTrustStore(owner, options);
  return { owner, peer, path, options, store, setTime: (t: number) => { clock = t; },
    restart: () => new WorkerTrustStore(owner, options) };
}
type Fixture = ReturnType<typeof fixture>;
function incoming(f: Fixture, peerOwnerDid = f.peer.did, requestId = 'incoming') {
  return { peerOwnerDid, relayUrl: RELAY,
    incoming: { requestId, requestDigest: digest(requestId), receivedAt: NOW, expiresAt: NOW + TTL } };
}
function outgoing(f: Fixture, peerOwnerDid = f.peer.did) {
  return { peerOwnerDid, relayUrl: RELAY, outgoing: { requestId: 'outgoing', requestDigest: digest('outgoing'),
    createdAt: NOW, expiresAt: NOW + TTL, ownerConsentDigest: digest('sender consent') } };
}
function event(f: Fixture, peerOwnerDid = f.peer.did, eventId = 'accepted', deliveryDeadline = NOW + TTL): ConnectionOutboxRecord {
  return { eventId, peerOwnerDid, relayUrl: RELAY, state: 'pending', deliveryDeadline,
    signedEvent: signPayload<Json>({ type: 'ConnectionAccepted', eventId, toOwnerDid: peerOwnerDid }, f.owner) };
}
function approval(f: Fixture, peerOwnerDid = f.peer.did) {
  const request = incoming(f, peerOwnerDid).incoming;
  return { peerOwnerDid, requestId: request.requestId, requestDigest: request.requestDigest,
    connectionId: 'connection', localConsentDigest: digest('receiver consent'), outbox: event(f, peerOwnerDid) };
}
function accepted(f: Fixture): ApplyConnectionAcceptedInput {
  const request = outgoing(f).outgoing;
  return { peerOwnerDid: f.peer.did, requestId: request.requestId, requestDigest: request.requestDigest,
    connectionId: 'connection', remoteAcceptanceDigest: digest('remote acceptance') };
}
function invite(f: Fixture): { token: string; parsed: Invite } {
  const card = createSignedAgentCard({ name: 'Worker', agentDid: f.owner.did, relayEndpoint: RELAY,
    skills: [], expiresAt: new Date(NOW + 20 * DAY).toISOString() }, f.owner);
  const token = createInviteToken({ agentCard: card, issuedAt: new Date(NOW).toISOString(), expiresInSeconds: 30 * 86400 }, f.owner);
  return { token, parsed: parseAndVerifyInviteToken(token, NOW) };
}
function binding(f: Fixture, parsed = invite(f).parsed, peerOwnerDid = f.peer.did) {
  return { invite: parsed, peerOwnerDid, relayUrl: RELAY, connectionId: 'invite-connection',
    localConsentDigest: digest(parsed), outbox: event(f, peerOwnerDid) };
}
function read(f: Fixture): Signed<Record<string, any>> { return JSON.parse(fs.readFileSync(f.path, 'utf8')); }
function seed(f: Fixture, fields: Record<string, unknown> = {}) {
  const payload = { version: 2, workerOwnerDid: f.owner.did, requests: [], grants: [], denials: [], ...emptyConnectionData(), ...fields };
  fs.mkdirSync(dirname(f.path), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f.path, JSON.stringify(signPayload(payload, f.owner)) + '\n', { mode: 0o600 });
}
function legacy(f: Fixture, trust: 'limited' | 'trusted' = 'limited') {
  const manifest = buildTaskManifest({ ownerDid: f.peer.did, workerDid: f.owner.did, title: 'Retained', description: 'Metadata' });
  manifest.deadline = new Date(NOW + DAY).toISOString();
  f.store.enqueue(manifest, {}); const request = f.store.list()[0]; f.store.decide(request.id, 'approve', trust);
  return request;
}

it('lists all preparatory surfaces without creating directories, identity files or store files', () => {
  const f = fixture(), port = connectionPersistencePort(f.store);
  expect(port.connectionState(f.peer.did)).toBe('none'); expect(port.connectionLevel(f.peer.did)).toBe('unknown');
  expect(port.listConnections()).toEqual([]); expect(port.listPriorApprovedPeers()).toEqual([]);
  expect(port.listConnectionOutbox()).toEqual([]); expect(fs.readdirSync(root)).toEqual([]);
});
it('keeps v1 reads and legacy mutations at v1, including CRLF listing', () => {
  const f = fixture(); legacy(f, 'trusted');
  const bytes = JSON.stringify(read(f), null, 2).replace(/\n/g, '\r\n') + '\r\n'; fs.writeFileSync(f.path, bytes);
  expect(f.store.listConnections()).toEqual([]); expect(f.store.connectionLevel(f.peer.did)).toBe('unknown');
  expect(f.store.level(f.peer.did)).toBe('trusted'); expect(f.store.listPriorApprovedPeers()).toHaveLength(1);
  expect(fs.readFileSync(f.path, 'utf8')).toBe(bytes);
  f.store.enqueue(buildTaskManifest({ ownerDid: generateKeyPair().did, workerDid: f.owner.did, title: 'New', description: 'New' }), {});
  expect(read(f).payload.version).toBe(1);
});
it('migrates only on explicit connection mutation, preserving finite grants, denials, IDs and retained evidence', () => {
  const f = fixture(); const request = legacy(f, 'trusted'), denied = generateKeyPair().did;
  const original = read(f).payload;
  original.denials = [denied]; original.grants.push({ did: 'did:key:expired', trust: 'limited', expiresAt: NOW - 1 });
  fs.writeFileSync(f.path, JSON.stringify(signPayload(original, f.owner)));
  f.store.recordOutgoing(outgoing(f, generateKeyPair().did));
  const stored = read(f); expect(verifySigned(stored, f.owner.did)).toBe(true);
  expect(stored.payload.version).toBe(2); expect(stored.payload.requests[0].id).toBe(request.id);
  expect(stored.payload.grants).toEqual([original.grants[0]]); expect(stored.payload.denials).toEqual([denied]);
  expect(f.store.connectionState(f.peer.did)).toBe('none'); expect(f.store.level(f.peer.did)).toBe('trusted');
  expect(f.store.connectionState(denied)).toBe('blocked');
  expect(f.store.listPriorApprovedPeers()).toEqual(expect.arrayContaining([
    { peerOwnerDid: f.peer.did, sourceRequestIds: [request.id], legacyTrust: 'trusted' },
    { peerOwnerDid: 'did:key:expired', sourceRequestIds: [], legacyTrust: 'limited' },
  ]));
  const first = fs.readFileSync(f.path, 'utf8'); f.restart().recordOutgoing(outgoing(f, stored.payload.connections[0].peerOwnerDid));
  expect(fs.readFileSync(f.path, 'utf8')).toBe(first);
});
it('retains prior-approved evidence before history and expired grants are pruned', () => {
  const f = fixture(); const request = legacy(f);
  const payload = read(f).payload;
  payload.requests = Array.from({ length: 200 }, (_, i) => ({ ...payload.requests[0], id: 'request-' + i }));
  fs.writeFileSync(f.path, JSON.stringify(signPayload(payload, f.owner)));
  f.setTime(NOW + 2 * DAY); f.store.disconnect('did:key:unrelated');
  expect(read(f).payload.requests).toHaveLength(100); expect(read(f).payload.grants).toEqual([]);
  expect(f.store.listPriorApprovedPeers()[0].sourceRequestIds).toHaveLength(200);
  expect(f.store.listPriorApprovedPeers()[0].legacyTrust).toBe('limited');
  expect(f.store.listPriorApprovedPeers()[0].lastApprovedAt).toBeUndefined();
  expect(f.store.connectionState(f.peer.did)).toBe('none'); expect(request.id).toBeTruthy();
});
it('keeps simultaneous incoming and outgoing offers pending without granting trust', () => {
  const f = fixture(); f.store.recordIncoming(incoming(f)); f.store.recordOutgoing(outgoing(f));
  expect(f.store.connectionState(f.peer.did)).toBe('pending'); expect(f.store.connectionLevel(f.peer.did)).toBe('unknown');
  expect(f.store.listConnections()[0]).toMatchObject({ incoming: incoming(f).incoming, outgoing: outgoing(f).outgoing });
  f.store.recordIncoming(incoming(f)); f.store.recordOutgoing(outgoing(f));
  expect(f.store.listConnections()).toHaveLength(1);
  expect(() => f.store.recordIncoming(incoming(f, f.peer.did, 'another'))).toThrow('CONNECTION_ALREADY_DECIDED');
});
it('commits limited connection consent and its outbox together and keeps it indefinitely across restart', () => {
  const f = fixture(); f.store.recordIncoming(incoming(f)); f.store.approveConnection(approval(f));
  const restart = f.restart(); expect(restart.connectionState(f.peer.did)).toBe('connected');
  expect(restart.connectionLevel(f.peer.did)).toBe('limited'); expect(restart.level(f.peer.did)).toBe('unknown');
  expect(restart.hasTrustedGrant()).toBe(false); expect(restart.listConnectionOutbox()).toEqual([event(f)]);
  expect(read(f).payload.connections[0]).not.toHaveProperty('expiresAt');
  expect(read(f).payload.connections[0]).not.toHaveProperty('trust');
  restart.markConnectionEventDelivered('accepted'); expect(restart.listConnectionOutbox()).toEqual([]);
  restart.approveConnection(approval(f)); expect(restart.listConnectionOutbox()).toEqual([]);
  f.setTime(NOW + 365 * DAY); expect(f.restart().connectionLevel(f.peer.did)).toBe('limited');
  f.store.disconnect('did:key:unrelated'); expect(read(f).payload.outbox).toEqual([]);
  expect(f.store.connectionLevel(f.peer.did)).toBe('limited');
});
it('applies only an acceptance matching locally consented outgoing evidence and treats duplicates as idempotent', () => {
  const f = fixture(); expect(() => f.store.applyAccepted(accepted(f))).toThrow('CONNECTION_NOT_FOUND');
  expect(fs.existsSync(f.path)).toBe(false);
  f.store.recordOutgoing(outgoing(f));
  expect(() => f.store.applyAccepted({ ...accepted(f), requestDigest: digest('different') })).toThrow('CONNECTION_ALREADY_DECIDED');
  expect(() => f.store.applyAccepted({ ...accepted(f), remoteAcceptanceDigest: '' })).toThrow('INTAKE_STORE_INVALID');
  f.store.applyAccepted(accepted(f)); f.restart().applyAccepted(accepted(f));
  expect(f.store.listConnections()[0]).toMatchObject({ localConsentDigest: outgoing(f).outgoing.ownerConsentDigest,
    remoteAcceptanceDigest: accepted(f).remoteAcceptanceDigest });
  expect(() => f.store.applyAccepted({ ...accepted(f), connectionId: 'different' })).toThrow('CONNECTION_ALREADY_DECIDED');
  f.setTime(NOW + 365 * DAY); f.store.applyAccepted(accepted(f)); expect(f.store.connectionLevel(f.peer.did)).toBe('limited');
});
it('uses exact fourteen-day offer expiry and leaves read bytes intact', () => {
  const f = fixture(); f.store.recordOutgoing(outgoing(f)); const bytes = fs.readFileSync(f.path, 'utf8');
  f.setTime(NOW + TTL - 1); expect(f.store.connectionState(f.peer.did)).toBe('pending');
  f.setTime(NOW + TTL); expect(f.store.connectionState(f.peer.did)).toBe('none'); expect(f.store.listConnections()).toEqual([]);
  expect(() => f.store.applyAccepted(accepted(f))).toThrow('CONNECTION_REQUEST_EXPIRED');
  expect(fs.readFileSync(f.path, 'utf8')).toBe(bytes);
  f.store.disconnect('did:key:unrelated'); expect(read(f).payload.connections).toEqual([]);
});
it('rejects an expired incoming decision and rejects malformed offer lifetimes', () => {
  const f = fixture(); f.store.recordIncoming(incoming(f)); f.setTime(NOW + TTL);
  expect(() => f.store.approveConnection(approval(f))).toThrow('CONNECTION_REQUEST_EXPIRED');
  expect(() => f.store.rejectConnection(f.peer.did)).toThrow('CONNECTION_REQUEST_EXPIRED');
  const g = fixture(); const o = outgoing(g);
  expect(() => g.store.recordOutgoing({ ...o, outgoing: { ...o.outgoing, expiresAt: NOW + TTL + 1 } })).toThrow('INTAKE_STORE_INVALID');
  expect(() => g.store.recordOutgoing({ ...o, outgoing: { ...o.outgoing, createdAt: NOW + 1 } })).toThrow('INTAKE_STORE_INVALID');
  expect(fs.existsSync(g.path)).toBe(false);
});
it('refuses incoming offers for exactly seven days without a permanent denial or a legacy task denial', () => {
  const f = fixture(); f.store.recordIncoming(incoming(f)); f.store.rejectConnection(f.peer.did);
  expect(f.store.connectionState(f.peer.did)).toBe('none'); expect(f.store.level(f.peer.did)).toBe('unknown');
  f.store.enqueue(buildTaskManifest({ ownerDid: f.peer.did, workerDid: f.owner.did, title: 'Task', description: 'Task' }), {});
  f.setTime(NOW + 7 * DAY - 1); expect(() => f.store.recordIncoming(incoming(f))).toThrow('CONNECTION_REQUEST_COOLDOWN');
  f.setTime(NOW + 7 * DAY); f.restart().recordIncoming(incoming(f));
  expect(f.store.connectionState(f.peer.did)).toBe('pending'); expect(read(f).payload.refusals).toEqual([]);
});
it('retains a finite legacy grant when an incoming connection offer is refused', () => {
  const f = fixture(); legacy(f, 'trusted'); f.store.recordIncoming(incoming(f)); f.store.rejectConnection(f.peer.did);
  expect(f.store.connectionState(f.peer.did)).toBe('none'); expect(f.store.level(f.peer.did)).toBe('trusted');
  expect(f.store.hasTrustedGrant()).toBe(true);
});
it('requires current incoming evidence for a prior-approved connect decision', () => {
  const f = fixture(); legacy(f, 'trusted');
  expect(() => f.store.approveConnection({ ...approval(f), source: 'prior-approval' })).toThrow('CONNECTION_NOT_FOUND');
  f.store.recordIncoming(incoming(f)); f.store.approveConnection({ ...approval(f), source: 'prior-approval' });
  expect(f.store.connectionLevel(f.peer.did)).toBe('limited'); expect(f.store.listConnections()[0]).toMatchObject({ source: 'prior-approval' });
});
it('disconnects, blocks and unblocks locally without restoring grants, offers or late acceptance', () => {
  const f = fixture(); legacy(f, 'trusted'); f.store.recordOutgoing(outgoing(f)); f.store.applyAccepted(accepted(f));
  f.store.disconnect(f.peer.did); expect(f.store.connectionState(f.peer.did)).toBe('none');
  expect(f.store.level(f.peer.did)).toBe('unknown'); expect(() => f.store.applyAccepted(accepted(f))).toThrow('CONNECTION_NOT_FOUND');
  f.store.recordOutgoing(outgoing(f)); f.store.block(f.peer.did); expect(f.store.connectionState(f.peer.did)).toBe('blocked');
  expect(f.store.connectionLevel(f.peer.did)).toBe('denied'); expect(f.store.listConnections()).toEqual([{ peerOwnerDid: f.peer.did, state: 'blocked' }]);
  expect(() => f.store.recordIncoming(incoming(f))).toThrow('CONNECTION_ALREADY_DECIDED');
  expect(() => f.store.applyAccepted(accepted(f))).toThrow('CONNECTION_ALREADY_DECIDED');
  f.store.unblock(f.peer.did); expect(f.store.connectionState(f.peer.did)).toBe('none');
  expect(f.store.level(f.peer.did)).toBe('unknown'); expect(() => f.store.applyAccepted(accepted(f))).toThrow('CONNECTION_NOT_FOUND');
  expect(f.store.listPriorApprovedPeers()).toHaveLength(1);
});
it('preserves the legacy deny meaning after a store has been upgraded', () => {
  const f = fixture(); const r = legacy(f); f.store.recordIncoming(incoming(f)); f.store.approveConnection(approval(f));
  f.store.decide(r.id, 'deny'); expect(f.restart().connectionState(f.peer.did)).toBe('blocked');
  expect(f.store.listConnectionOutbox()).toEqual([]); f.store.unblock(f.peer.did);
  expect(f.store.connectionState(f.peer.did)).toBe('none');
});
it('binds canonical parsed invitations to the requester owner and retains the binding through lifecycle removal', () => {
  const f = fixture(), i = invite(f), input = binding(f, i.parsed);
  expect(f.store.bindInviteFirstUse(input)).toBe('first'); expect(f.store.connectionLevel(f.peer.did)).toBe('limited');
  const otherEncoding = parseAndVerifyInviteToken('acp://invite?token=' + i.token.slice(11), NOW);
  expect(f.restart().bindInviteFirstUse({ ...input, invite: otherEncoding, peerAgentDid: generateKeyPair().did })).toBe('same');
  const link = parseAndVerifyInviteToken('https://sealbridge.app/i#' + i.token, NOW);
  const other = generateKeyPair().did;
  expect(f.store.bindInviteFirstUse(binding(f, link, other))).toBe('other'); expect(f.store.connectionState(other)).toBe('none');
  expect(read(f).payload.inviteBindings[0].tokenExpiresAt).toBe(NOW + 20 * DAY);
  f.store.disconnect(f.peer.did); expect(f.store.listConnectionOutbox()).toEqual([]);
  expect(f.store.bindInviteFirstUse(input)).toBe('same'); expect(f.store.connectionState(f.peer.did)).toBe('none');
  f.store.block(f.peer.did); f.store.unblock(f.peer.did);
  expect(f.store.bindInviteFirstUse(input)).toBe('same'); expect(f.store.connectionState(f.peer.did)).toBe('none');
  expect(fs.readFileSync(f.path, 'utf8')).not.toContain(i.token);
});
it('keeps first use atomic across competing store instances with exactly one owner binding', () => {
  const f = fixture(), input = binding(f), other = binding(f, input.invite, generateKeyPair().did);
  const competing = f.restart(); let calls = 0;
  const io = { ...fs, renameSync: ((...args: Parameters<typeof fs.renameSync>) => {
    calls++; expect(() => competing.bindInviteFirstUse(other)).toThrow('INTAKE_STORE_BUSY'); return fs.renameSync(...args);
  }) as typeof fs.renameSync };
  expect(new WorkerTrustStore(f.owner, { ...f.options, fs: io }).bindInviteFirstUse(input)).toBe('first');
  expect(calls).toBe(1); expect(competing.bindInviteFirstUse(other)).toBe('other');
  expect(read(f).payload.inviteBindings).toHaveLength(1); expect(read(f).payload.outbox).toHaveLength(1);
  expect(competing.connectionState(other.peerOwnerDid)).toBe('none');
});
it('allows an explicitly reissued invitation after disconnect and preserves an existing connection on binding', () => {
  const f = fixture(), first = binding(f); f.store.bindInviteFirstUse(first); f.store.disconnect(f.peer.did);
  f.setTime(NOW + 1000); vi.setSystemTime(NOW + 1000);
  const renewed = binding(f); expect(digest(renewed.invite)).not.toBe(digest(first.invite));
  expect(f.store.bindInviteFirstUse(renewed)).toBe('first'); expect(read(f).payload.inviteBindings).toHaveLength(2);
  f.setTime(NOW + 2000); vi.setSystemTime(NOW + 2000);
  const next = { ...binding(f), outbox: event(f, f.peer.did, 'next-acceptance') };
  const connection = read(f).payload.connections[0];
  expect(f.store.bindInviteFirstUse(next)).toBe('first'); expect(read(f).payload.connections).toEqual([connection]);
});
it('leaves v1 bytes intact when publication fails during binding or owner approval', () => {
  const f = fixture(); legacy(f); const bytes = fs.readFileSync(f.path, 'utf8');
  const foreign = binding(f, invite(fixture()).parsed);
  expect(() => f.store.bindInviteFirstUse(foreign)).toThrow('INTAKE_STORE_INVALID');
  const mismatched = { ...binding(f), outbox: event(f, generateKeyPair().did) };
  expect(() => f.store.bindInviteFirstUse(mismatched)).toThrow('INTAKE_STORE_INVALID');
  expect(fs.readFileSync(f.path, 'utf8')).toBe(bytes);
  const failing = new WorkerTrustStore(f.owner, { ...f.options, fs: { ...fs, renameSync: () => { throw new Error('injected'); } } });
  expect(() => failing.bindInviteFirstUse(binding(f))).toThrow('INTAKE_STORE_UNWRITABLE');
  expect(fs.readFileSync(f.path, 'utf8')).toBe(bytes); expect(f.store.connectionState(f.peer.did)).toBe('none');
  expect(fs.existsSync(f.path + '.lock')).toBe(false); expect(fs.readdirSync(dirname(f.path))).toEqual(['intake.json']);
  f.store.recordIncoming(incoming(f)); const pending = fs.readFileSync(f.path, 'utf8');
  expect(() => failing.approveConnection(approval(f))).toThrow('INTAKE_STORE_UNWRITABLE');
  expect(fs.readFileSync(f.path, 'utf8')).toBe(pending); expect(f.store.listConnectionOutbox()).toEqual([]);
});
it('prunes binding and delivery metadata at expiry without expiring an established connection', () => {
  const f = fixture(), input = binding(f); f.store.bindInviteFirstUse(input);
  const bytes = fs.readFileSync(f.path, 'utf8'); f.setTime(NOW + 20 * DAY);
  expect(f.store.listConnectionOutbox()).toEqual([]); expect(f.store.connectionLevel(f.peer.did)).toBe('limited');
  expect(fs.readFileSync(f.path, 'utf8')).toBe(bytes);
  expect(() => f.store.bindInviteFirstUse(input)).toThrow('CONNECTION_REQUEST_EXPIRED');
  f.store.disconnect('did:key:unrelated'); expect(read(f).payload.inviteBindings).toEqual([]);
  expect(f.store.connectionLevel(f.peer.did)).toBe('limited');
});
function connectedRecords(count: number) {
  return Array.from({ length: count }, (_, i) => ({ peerOwnerDid: 'did:key:peer-' + i, relayUrl: RELAY,
    state: 'connected', connectionId: 'connection-' + i, connectedAt: NOW, source: 'invite', localConsentDigest: digest(i) }));
}
it('caps connections without evicting live relationships and permits a removal at capacity', () => {
  const f = fixture(); seed(f, { connections: connectedRecords(1000) }); const bytes = fs.readFileSync(f.path, 'utf8');
  expect(() => f.store.recordIncoming(incoming(f))).toThrow('CONNECTION_STORE_FULL');
  expect(fs.readFileSync(f.path, 'utf8')).toBe(bytes); f.store.disconnect('did:key:peer-0');
  f.store.recordIncoming(incoming(f)); expect(f.store.listConnections()).toHaveLength(1000);
});
it('caps first-use bindings and prunes expired entries before capacity checks', () => {
  const f = fixture(); const rows = Array.from({ length: 1000 }, (_, i) => ({ inviteDigest: digest(i), requesterOwnerDid: 'did:key:bound-' + i,
    boundAt: NOW - DAY, tokenExpiresAt: NOW + DAY, connectionId: 'bound-' + i }));
  seed(f, { inviteBindings: rows }); const bytes = fs.readFileSync(f.path, 'utf8');
  expect(() => f.store.bindInviteFirstUse(binding(f))).toThrow('CONNECTION_STORE_FULL'); expect(fs.readFileSync(f.path, 'utf8')).toBe(bytes);
  rows[0].tokenExpiresAt = NOW; seed(f, { inviteBindings: rows });
  expect(f.store.bindInviteFirstUse(binding(f))).toBe('first'); expect(read(f).payload.inviteBindings).toHaveLength(1000);
});
it('caps acceptance outbox atomically and frees expired delivery records', () => {
  const f = fixture(); const outbox = Array.from({ length: 100 }, (_, i) => event(f, 'did:key:out-' + i, 'event-' + i));
  seed(f, { outbox }); f.store.recordIncoming(incoming(f)); const bytes = fs.readFileSync(f.path, 'utf8');
  expect(() => f.store.approveConnection(approval(f))).toThrow('CONNECTION_STORE_FULL'); expect(fs.readFileSync(f.path, 'utf8')).toBe(bytes);
  outbox[0].deliveryDeadline = NOW;
  seed(f, { outbox, connections: [{ ...incoming(f), state: 'pending' }] });
  f.store.approveConnection(approval(f)); expect(read(f).payload.outbox).toHaveLength(100);
});
it('keeps mutation room under the byte ceiling and never drops denials for capacity', () => {
  const f = fixture(); const denials = Array.from({ length: 2000 }, (_, i) => 'did:key:' + String(i).padStart(4, '0') + 'x'.repeat(495));
  seed(f, { denials }); expect(fs.statSync(f.path).size).toBeLessThan(1024 * 1024);
  expect(() => f.store.recordIncoming(incoming(f))).toThrow('CONNECTION_STORE_FULL');
  f.store.block(f.peer.did); expect(f.store.connectionState(f.peer.did)).toBe('blocked');
  expect(read(f).payload.denials).toEqual([...denials, f.peer.did]);
});
it('bounds pending offers and prior approval history without discarding existing rows', () => {
  const f = fixture(); const connections = Array.from({ length: 100 }, (_, i) => ({ ...incoming(f, 'did:key:pending-' + i), state: 'pending' }));
  seed(f, { connections }); expect(() => f.store.recordOutgoing(outgoing(f))).toThrow('CONNECTION_STORE_FULL');
  const peers = Array.from({ length: 1000 }, (_, i) => ({ peerOwnerDid: 'did:key:prior-' + i, sourceRequestIds: [], legacyTrust: 'limited' }));
  seed(f, { priorApprovedPeers: peers, grants: [{ did: f.peer.did, trust: 'trusted', expiresAt: NOW + DAY }] });
  const bytes = fs.readFileSync(f.path, 'utf8'); expect(() => f.store.disconnect('did:key:unrelated')).toThrow('CONNECTION_STORE_FULL');
  expect(fs.readFileSync(f.path, 'utf8')).toBe(bytes);
});
it('rejects invalid v2 lifecycle data and foreign signatures without replacing existing bytes', () => {
  const f = fixture(); const valid = connectedRecords(1)[0];
  for (const fields of [
    { connections: [{ ...valid, trust: 'trusted' }] }, { connections: [{ ...valid, connectedAt: null }] },
    { connections: [{ ...valid, localConsentDigest: null }] }, { connections: [valid, valid] },
    { connections: [{ peerOwnerDid: f.peer.did, relayUrl: RELAY, state: 'pending' }] },
    { connections: [{ ...valid, expiresAt: NOW + DAY }] }, { connections: [valid], denials: [valid.peerOwnerDid] },
    { inviteBindings: [{ inviteDigest: digest('invite'), requesterOwnerDid: f.peer.did, boundAt: NOW, tokenExpiresAt: NOW, connectionId: 'x' }] },
    { outbox: [{ ...event(f), signedEvent: signPayload<Json>({}, generateKeyPair()) }] },
  ]) {
    seed(f, fields); const bytes = fs.readFileSync(f.path, 'utf8');
    expect(() => f.store.listConnections()).toThrow('INTAKE_STORE_INVALID');
    expect(() => f.store.block(f.peer.did)).toThrow('INTAKE_STORE_INVALID'); expect(fs.readFileSync(f.path, 'utf8')).toBe(bytes);
  }
  seed(f); const other = new WorkerTrustStore(generateKeyPair(), f.options);
  expect(() => other.connectionState(f.peer.did)).toThrow('INTAKE_STORE_INVALID');
});
it('checks private paths and occupied locks, and preserves connection state on a flush failure', () => {
  const f = fixture(); f.store.recordIncoming(incoming(f)); const bytes = fs.readFileSync(f.path, 'utf8');
  if (process.platform !== 'win32') {
    expect(fs.statSync(f.path).mode & 0o777).toBe(0o600); expect(fs.statSync(dirname(f.path)).mode & 0o777).toBe(0o700);
    fs.chmodSync(f.path, 0o644); expect(() => f.store.listConnections()).toThrow('INTAKE_STORE_INVALID'); fs.chmodSync(f.path, 0o600);
    fs.chmodSync(dirname(f.path), 0o755); expect(() => f.store.listConnections()).toThrow('INTAKE_STORE_INVALID'); fs.chmodSync(dirname(f.path), 0o700);
  }
  fs.writeFileSync(f.path + '.lock', '', { mode: 0o600 });
  expect(() => f.store.approveConnection(approval(f))).toThrow('INTAKE_STORE_BUSY'); expect(fs.existsSync(f.path + '.lock')).toBe(true);
  fs.unlinkSync(f.path + '.lock');
  const failing = new WorkerTrustStore(f.owner, { ...f.options, fs: { ...fs, fsyncSync: () => { throw new Error('injected'); } } });
  expect(() => failing.approveConnection(approval(f))).toThrow('INTAKE_STORE_UNWRITABLE');
  expect(fs.readFileSync(f.path, 'utf8')).toBe(bytes); expect(fs.readdirSync(dirname(f.path))).toEqual(['intake.json']);
});
it('rejects linked files and non-file entries and handles bounded partial reads', () => {
  const f = fixture(); seed(f);
  const partial = new WorkerTrustStore(f.owner, { ...f.options, fs: { ...fs,
    readSync: ((fd: number, buffer: Buffer, offset: number, length: number, position: number | null) =>
      fs.readSync(fd, buffer, offset, Math.min(length, 17), position)) as typeof fs.readSync } });
  expect(partial.listConnections()).toEqual([]);
  fs.renameSync(f.path, f.path + '.original');
  if (process.platform !== 'win32') {
    fs.symlinkSync(f.path + '.original', f.path); expect(() => f.store.listConnections()).toThrow('INTAKE_STORE_INVALID'); fs.unlinkSync(f.path);
  }
  fs.mkdirSync(f.path, { mode: 0o700 }); expect(() => f.store.listConnections()).toThrow('INTAKE_STORE_INVALID');
});
it('uses separate local-owner paths and returns detached connection snapshots in memory', () => {
  const f = fixture(); const memory = new WorkerTrustStore(f.owner, { now: () => NOW });
  memory.recordIncoming(incoming(f)); const snapshot = memory.listConnections(); snapshot[0].peerOwnerDid = 'did:key:changed';
  expect(memory.connectionState(f.peer.did)).toBe('pending');
  f.store.recordIncoming(incoming(f)); f.store.approveConnection(approval(f));
  const otherOwner: KeyPair = generateKeyPair(); const other = new WorkerTrustStore(otherOwner, {
    path: workerIntakePath(otherOwner.did, { env: { SEALBRIDGE_DATA_DIR: join(root, 'data') } }), now: () => NOW });
  expect(other.connectionState(f.peer.did)).toBe('none'); expect(other.listPriorApprovedPeers()).toEqual([]);
});
