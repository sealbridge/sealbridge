// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInviteToken, createRevocationNotice, createSignedAgentCard, digest, generateKeyPair, parseAndVerifyInviteToken, RevocationRegistry, signEnvelope } from '../packages/core/src/index.js';
import type { SignedEnvelope } from '../packages/core/src/index.js';
import { ConnectionAdmissionReview, ConnectionRouter, HeldRequestReview, heldContentDigest, InviteStore, WorkerTrustStore, workerIntakePath } from '../packages/runtime/src/index.js';
import { connectionsCommand } from '../cli/src/connections.js';

const EPOCH = Date.parse('2030-01-01T00:00:00.000Z'), RELAY = 'https://relay.example';
const roots: string[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(EPOCH); });
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'connection-admission-review-')); roots.push(root);
  const identityOptions = { env: { SEALBRIDGE_DATA_DIR: root } }, now = () => Date.now();
  const keys = [generateKeyPair(), generateKeyPair(), generateKeyPair()];
  const frames: SignedEnvelope[] = [];
  const options = keys.map((owner, i) => ({ owner, relayUrl: RELAY, now,
    heldOptions: identityOptions,
    store: new WorkerTrustStore(owner, { path: workerIntakePath(owner.did, identityOptions), now }),
    agentCard: createSignedAgentCard({ name: 'Peer ' + i, agentDid: owner.did, relayEndpoint: RELAY,
      skills: [], protocolVersions: ['0.2.0'], now: EPOCH }, owner),
    relay: { send: vi.fn(async (envelope: SignedEnvelope) => { frames.push(envelope); }), receive: vi.fn(),
      acknowledgeDelivery: vi.fn(async () => {}) },
    onConnectionEvent: vi.fn(),
  }));
  const reviews = keys.map(owner => new HeldRequestReview(owner, { ...identityOptions, now }));
  const routers = options.map((o, i) => new ConnectionRouter({ ...o, review: reviews[i],
    humanReview: { kind: 'human', review: async () => true } }));
  const token = createInviteToken({ agentCard: options[0].agentCard, expiresInSeconds: 2592000,
    issuedAt: new Date(EPOCH).toISOString() }, keys[0]);
  const inviteDigest = digest(parseAndVerifyInviteToken(token, EPOCH));
  const queue = () => new ConnectionAdmissionReview({ ...options[0], inviteAlias: d => d === inviteDigest ? 'local-label' : undefined });
  async function incoming(i = 1, inviteToken: string | undefined = token) {
    const requested = await routers[i].service.request({ toOwnerDid: keys[0].did, inviteToken,
      message: 'Private request message' });
    const envelope = frames.find(e => e.payload.taskId === 'conn_' + requested.requestId)!;
    await routers[0].consume(envelope);
    return { requested, envelope };
  }
  function files(path = root): string[] {
    return readdirSync(path).flatMap(n => { const p = join(path, n); return statSync(p).isDirectory() ? files(p) : [p]; });
  }
  return { root, identityOptions, now, keys, frames, options, reviews, routers, token, inviteDigest, queue, incoming, files };
}

it('lists only public metadata without changing held receipts or default admission', async () => {
  const f = fixture(), { envelope } = await f.incoming();
  await f.routers[0].consume(envelope);
  const before = f.files().map(path => [path, readFileSync(path, 'utf8')]);
  const rows = f.queue().list();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ localOwnerDid: f.keys[0].did, peerOwnerDid: f.keys[1].did,
    peerAgentDid: f.keys[1].did, peerDisplayName: 'Peer 1', inviteAlias: 'local-label', receivedAt: EPOCH,
    expiresAt: EPOCH + 86400000, relayUrl: RELAY });
  expect(rows[0].shortPeerOwnerDid).toContain('…');
  expect(JSON.stringify(rows)).not.toContain('Private request message');
  expect(JSON.stringify(rows)).not.toContain('acp-invite:');
  expect(f.files().map(path => [path, readFileSync(path, 'utf8')])).toEqual(before);
  expect(f.reviews[0].list()[0]).toMatchObject({ state: 'held', inspectionStatus: 'unavailable' });
  expect(f.options[0].store.connectionState(f.keys[1].did)).toBe('pending');
  expect(f.options[0].relay.send).not.toHaveBeenCalled();
});

it('approves after restart with limited consent and first-use binding while leaving tasks held', async () => {
  const f = fixture(), { requested, envelope } = await f.incoming();
  const content = { manifest: { marker: 'task' }, input: { text: 'Task input' } };
  const task = signEnvelope({ taskId: 'task_held', recipientDid: f.keys[0].did, seq: 0, eventType: 'PROPOSE', payload: content }, f.keys[1], { encrypt: true });
  f.reviews[0].hold({ kind: 'task', taskId: 'task_held', senderOwnerDid: f.keys[1].did,
    contentDigest: heldContentDigest('task', content), deadline: EPOCH + 86400000, envelope: task });
  const restarted = new ConnectionAdmissionReview({ ...f.options[0], store: new WorkerTrustStore(f.keys[0], {
    path: workerIntakePath(f.keys[0].did, f.identityOptions), now: f.now }) });
  expect(await restarted.approve(requested.requestId)).toMatchObject({ status: 'connected' });
  expect(f.options[0].store.connectionLevel(f.keys[1].did)).toBe('limited');
  expect(f.options[0].store.hasExplicitLegacyGrant(f.keys[1].did)).toBe(false);
  expect(f.options[0].store.level(f.keys[1].did)).toBe('unknown');
  expect(f.options[0].store.controlSnapshot()[0].consent).toHaveProperty('payload.type', 'ConnectionConsent');
  expect(f.reviews[0].list()).toMatchObject([{ kind: 'task', state: 'held', inspectionStatus: 'pending' }]);
  await expect(f.reviews[0].inspect(f.reviews[0].list()[0].id)).resolves.toMatchObject({ inspectionStatus: 'unavailable' });
  expect(restarted.list()).toEqual([]);
  await expect(restarted.approve(requested.requestId)).rejects.toThrow('CONNECTION_NOT_PENDING');
  const state = JSON.parse(readFileSync(workerIntakePath(f.keys[0].did, f.identityOptions), 'utf8')).payload;
  expect(state.inviteBindings).toMatchObject([{ inviteDigest: f.inviteDigest, requesterOwnerDid: f.keys[1].did }]);
  await f.routers[0].consume(envelope);
  expect(f.options[0].onConnectionEvent).toHaveBeenCalledOnce();
  for (const path of f.files()) {
    expect(readFileSync(path, 'utf8')).not.toContain(f.token);
    expect(readFileSync(path, 'utf8')).not.toContain('Private request message');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  }
});

it('retains the original binding when a different owner explicitly receives consent', async () => {
  const f = fixture(); await f.incoming(); await f.queue().approve(f.queue().list()[0].id);
  const other = await f.incoming(2);
  expect(f.options[0].store.connectionState(f.keys[2].did)).toBe('pending');
  await f.queue().approve(other.requested.requestId);
  expect(f.options[0].store.connectionLevel(f.keys[2].did)).toBe('limited');
  const state = JSON.parse(readFileSync(workerIntakePath(f.keys[0].did, f.identityOptions), 'utf8')).payload;
  expect(state.inviteBindings).toMatchObject([{ requesterOwnerDid: f.keys[1].did }]);
  expect(state.inviteBindings).toHaveLength(1);
});

it('completes ordinary connection acceptance and ACK without resolving invitation secrets', async () => {
  const f = fixture();
  const secrets = new Map<string, string>();
  const secretStore = { get: vi.fn((id: string) => secrets.get(id)),
    set: vi.fn((id: string, value: string) => { secrets.set(id, value); }), delete: vi.fn((id: string) => { secrets.delete(id); }) };
  const saved = new InviteStore(f.keys[1], { ...f.identityOptions, secretStore });
  saved.import(f.token, 'issuer'); secretStore.get.mockClear();
  const { requested } = await f.incoming();
  // Request without an invite uses the same metadata-only review.
  const ordinary = await f.routers[2].service.request({ toOwnerDid: f.keys[0].did });
  await f.routers[0].consume(f.frames.find(e => e.payload.taskId === 'conn_' + ordinary.requestId)!);
  await f.queue().approve(ordinary.requestId);
  const accepted = f.frames.find(e => e.payload.eventType === 'CONNECTION_ACCEPTED' && e.payload.recipientDid === f.keys[2].did)!;
  await f.routers[2].consume(accepted);
  await f.routers[0].consume(f.frames.find(e => e.payload.eventType === 'CONNECTION_ACK')!);
  expect(f.options[2].store.connectionLevel(f.keys[0].did)).toBe('limited');
  expect(f.queue().list()).toMatchObject([{ requestId: requested.requestId }]);
  expect(secretStore.get).not.toHaveBeenCalled();
  expect(JSON.stringify(saved.list())).not.toContain('acp-invite:');
});

it('checks the current peer policy before owner approval', async () => {
  const f = fixture(), { requested } = await f.incoming();
  const queue = new ConnectionAdmissionReview({ ...f.options[0], assertPeer: () => { throw new Error('PEER_NOT_ALLOWED'); } });
  await expect(queue.approve(requested.requestId)).rejects.toThrow('PEER_NOT_ALLOWED');
  expect(f.reviews[0].list()[0].inspectionStatus).toBe('unavailable');
});

it.each(['expired', 'revoked'] as const)('rechecks an %s invitation before inspection and consent', async condition => {
  const f = fixture();
  const token = createInviteToken({ agentCard: f.options[0].agentCard, expiresInSeconds: 3600,
    issuedAt: new Date(EPOCH).toISOString() }, f.keys[0]);
  const { requested } = await f.incoming(1, token);
  const revocations = new RevocationRegistry();
  if (condition === 'expired') vi.setSystemTime(EPOCH + 2 * 3600000);
  else revocations.revoke(createRevocationNotice({ targetType: 'invite', targetId: digest(parseAndVerifyInviteToken(token, EPOCH)),
    reason: 'Retired', revokedAt: new Date(EPOCH).toISOString() }, f.keys[0]));
  const queue = new ConnectionAdmissionReview({ ...f.options[0], revocations });
  await expect(queue.approve(requested.requestId)).rejects.toThrow(condition === 'expired' ? 'INVITE_EXPIRED' : 'TOKEN_REVOKED');
  expect(f.reviews[0].list()[0].inspectionStatus).toBe('unavailable');
  expect(f.options[0].store.connectionState(f.keys[1].did)).toBe('pending');
});

it('bounds display labels and omits invitation strings and control characters', async () => {
  const f = fixture();
  f.routers[1].service.setAgentCard(createSignedAgentCard({ name: 'Peer\n\u202e acp-invite:Example_token',
    agentDid: f.keys[1].did, relayEndpoint: RELAY, skills: [], protocolVersions: ['0.2.0'], now: EPOCH }, f.keys[1]));
  await f.incoming();
  const queue = new ConnectionAdmissionReview({ ...f.options[0], inviteAlias: () => 'x'.repeat(200) });
  expect(queue.list()[0].peerDisplayName).toBe('Peer [invitation]');
  expect(queue.list()[0].inviteAlias).toHaveLength(120);
});

it('rejects with the existing cooldown and does not restore consent on repeated delivery', async () => {
  const f = fixture(), { envelope, requested } = await f.incoming();
  f.queue().reject(requested.requestId);
  expect(f.queue().list()).toEqual([]); expect(f.reviews[0].list()).toEqual([]);
  expect(f.options[0].store.connectionState(f.keys[1].did)).toBe('none');
  await f.routers[0].route(envelope);
  expect(f.queue().list()).toEqual([]);
  expect(f.options[0].relay.send).not.toHaveBeenCalled();
  await expect(f.queue().approve(requested.requestId)).rejects.toThrow('CONNECTION_NOT_PENDING');
});

it.each(['expired', 'blocked', 'disconnected'] as const)('excludes %s requests from review decisions', async condition => {
  const f = fixture(), { requested } = await f.incoming();
  if (condition === 'expired') vi.setSystemTime(EPOCH + 86400000);
  else if (condition === 'blocked') f.options[0].store.block(f.keys[1].did);
  else f.options[0].store.disconnect(f.keys[1].did);
  expect(f.queue().list()).toEqual([]);
  await expect(f.queue().approve(requested.requestId)).rejects.toThrow('CONNECTION_NOT_PENDING');
  expect(() => f.queue().reject(requested.requestId)).toThrow('CONNECTION_NOT_PENDING');
});

it('retains acceptance for outbox delivery after a transport failure', async () => {
  const f = fixture(), { requested } = await f.incoming();
  f.options[0].relay.send.mockRejectedValueOnce(new Error('DELIVERY_UNAVAILABLE'));
  expect(await f.queue().approve(requested.requestId)).toMatchObject({ status: 'connected', code: 'CONNECTION_DELIVERY_PENDING' });
  expect(f.queue().list()).toEqual([]);
  expect(await f.routers[0].service.flushOutbox()).toBe(true);
  expect(f.options[0].store.connectionLevel(f.keys[1].did)).toBe('limited');
});

it('provides CLI review without a configured inspector and requires owner confirmation', async () => {
  const f = fixture(), { requested } = await f.incoming();
  const key = join(f.root, 'owner.private.json'); writeFileSync(key, JSON.stringify(f.keys[0]), { mode: 0o600 });
  const output = vi.fn(), transportFactory = vi.fn(() => f.options[0].relay);
  const options = { identityOptions: f.identityOptions, now: f.now, output, transportFactory };
  await connectionsCommand(['review', 'list', '--key', key], options);
  expect(JSON.parse(output.mock.calls[0][0]).requests).toHaveLength(1);
  expect(transportFactory).not.toHaveBeenCalled();
  await expect(connectionsCommand(['review', 'approve', requested.requestId, '--key', key], {
    ...options, review: async () => false })).rejects.toThrow('APPROVAL_REJECTED');
  expect(f.reviews[0].list()[0].inspectionStatus).toBe('unavailable');
  const review = vi.fn(async (summary: string) => {
    expect(summary).toContain(f.keys[0].did); expect(summary).toContain(f.keys[1].did); return true;
  });
  await connectionsCommand(['review', 'approve', requested.requestId, '--key', key], { ...options, review });
  expect(review).toHaveBeenCalledOnce();
  expect(f.options[0].store.connectionLevel(f.keys[1].did)).toBe('limited');
  expect(JSON.stringify(output.mock.calls)).not.toContain('acp-invite:');
  expect(JSON.stringify(review.mock.calls)).not.toContain('Private request message');
});

it('lists an empty CLI queue without creating identities and refuses unattended flags', async () => {
  const f = fixture(), root = join(f.root, 'unused'), identityOptions = { env: { SEALBRIDGE_DATA_DIR: root } };
  const output = vi.fn();
  await connectionsCommand(['review', 'list'], { identityOptions, output });
  expect(JSON.parse(output.mock.calls[0][0])).toEqual({ requests: [] });
  expect(existsSync(root)).toBe(false);
  await expect(connectionsCommand(['review', 'approve', 'request', '--yes'], { identityOptions })).rejects.toThrow('INVALID_CONNECTION_OPTION');
});

it('rejects through the CLI using the held record ID without creating a transport', async () => {
  const f = fixture(); await f.incoming();
  const key = join(f.root, 'owner.private.json'); writeFileSync(key, JSON.stringify(f.keys[0]), { mode: 0o600 });
  const transportFactory = vi.fn(() => f.options[0].relay), output = vi.fn();
  await connectionsCommand(['review', 'reject', f.queue().list()[0].id, '--key', key], {
    identityOptions: f.identityOptions, now: f.now, review: async () => true, output, transportFactory });
  expect(transportFactory).not.toHaveBeenCalled();
  expect(f.queue().list()).toEqual([]);
  expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ state: 'none' });
});
