// SPDX-License-Identifier: Apache-2.0
import { protocolTestNow } from './protocol-test-clock.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInviteToken, createSignedAgentCard, digest, generateKeyPair, parseAndVerifyInviteToken,
  signPayload } from '../packages/core/src/index.js';
import type { KeyPair, SignedAgentCard, SignedEnvelope } from '../packages/core/src/index.js';
import { AcpMcpServer, ConnectionRouter, HeldRequestReview, InviteStore, WorkerTrustStore,
  workerIntakePath } from '../packages/runtime/src/index.js';
import { connectionsCommand } from '../cli/src/connections.js';
import type { ConnectionPeer, ConnectionStatus } from '../cli/src/sdk.js';
import { admissionFixture, completeInspection } from './connections-fixture.js';

const NOW = protocolTestNow('2026-11-03T00:00:00.000Z');
const RELAY = 'https://relay.example';
let root: string;
const now = () => NOW;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  root = mkdtempSync(join(tmpdir(), 'connection-display-name-'));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network call'); }));
});
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});
function card(owner: KeyPair, name: string, agent = owner): SignedAgentCard {
  return createSignedAgentCard({ name, agentDid: agent.did, agentKey: agent, relayEndpoint: RELAY,
    skills: [], protocolVersions: ['0.2.0'], now: NOW }, owner);
}
function fixture(inspection = true, backend: 'file' | 'keychain' = 'keychain') {
  const secrets = new Map<string, string>();
  const identityOptions = { env: { SEALBRIDGE_DATA_DIR: root, SEALBRIDGE_KEY_STORE: backend },
    keyringLoader: async () => ({ Entry: class {
      constructor(_service: string, readonly id: string) {}
      getPassword() { return secrets.get(this.id) ?? null; }
      setPassword(value: string) { secrets.set(this.id, value); }
      deletePassword() { return secrets.delete(this.id); }
    } }) };

  const frames: SignedEnvelope[] = [];
  const keys = [generateKeyPair(), generateKeyPair()];
  const keyPath = join(root, 'requester.private.json');
  writeFileSync(keyPath, JSON.stringify(keys[0]), { mode: 0o600 });
  const options = keys.map((owner, index) => ({
    owner, now, relayUrl: RELAY, agentCard: card(owner, index ? '査読者' : 'Requester'),
    store: new WorkerTrustStore(owner, { path: workerIntakePath(owner.did, identityOptions), now }),
    review: new HeldRequestReview(owner, { ...identityOptions, now, provider: inspection ? completeInspection : undefined }),
    humanReview: { kind: 'human' as const, review: vi.fn(async () => true) },
    relay: { send: vi.fn(async (envelope: SignedEnvelope) => { frames.push(envelope); }), receive: vi.fn() },
  }));
  const routers = options.map(o => new ConnectionRouter(o));
  function take(index: number, eventType: string) {
    const at = frames.findIndex(e => e.payload.recipientDid === keys[index].did && e.payload.eventType === eventType);
    if (at < 0) throw new Error('FRAME_NOT_FOUND');
    return frames.splice(at, 1)[0];
  }
  return { keys, keyPath, secrets, options, routers, take, identityOptions };
}
async function listMcp(owner: KeyPair, identityOptions: ReturnType<typeof fixture>['identityOptions'], name = 'acp_list_connections') {
  const server = new AcpMcpServer({ owner, identityOptions, now });
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }) as any;
  return response.result.structuredContent.connections;
}

it('retains verified invite and incoming card names after invitation removal and restart', async () => {
  const f = fixture();
  const invites = await InviteStore.open(f.keys[0], { ...f.identityOptions, now });
  const token = createInviteToken({ agentCard: f.options[1].agentCard }, f.keys[1]);
  const saved = invites.import(token, 'reviewer');
  const output = vi.fn();
  await connectionsCommand(['confirm-invite', saved.workerRef, '--key', f.keyPath], { identityOptions: f.identityOptions, now,
    review: async () => true, output, transportFactory: () => f.options[0].relay });
  expect(f.options[0].store.listConnections()[0]).toMatchObject({ state: 'pending', peerDisplayName: '査読者' });
  expect(await listMcp(f.keys[0], f.identityOptions, 'acp_list_connection_requests'))
    .toMatchObject([{ peerDisplayName: '査読者', peerOwnerDid: f.keys[1].did }]);
  expect(readFileSync(invites.path, 'utf8')).not.toContain(token);
  invites.remove(saved.workerRef); expect(f.secrets.size).toBe(0);
  await f.routers[1].consume(f.take(1, 'CONNECTION_REQUEST'));
  expect(f.options[1].store.listConnections()[0]).toMatchObject({ state: 'connected', peerDisplayName: 'Sealbridge requester' });
  const restarted = new ConnectionRouter({ ...f.options[0], store: new WorkerTrustStore(f.keys[0], {
    path: workerIntakePath(f.keys[0].did, f.identityOptions), now }) });
  await restarted.consume(f.take(0, 'CONNECTION_ACCEPTED'));
  expect(restarted.options.store.listConnections()[0]).toMatchObject({ state: 'connected', peerDisplayName: '査読者',
    peerOwnerDid: f.keys[1].did, peerAgentDid: f.keys[1].did });
  await connectionsCommand(['list', '--role', 'requester', '--key', f.keyPath], { identityOptions: f.identityOptions, now, output });
  expect(JSON.parse(output.mock.calls.at(-1)![0]).connections[0]).toMatchObject({ peerDisplayName: '査読者' });
  expect(await listMcp(f.keys[0], f.identityOptions)).toMatchObject([{ peerDisplayName: '査読者' }]);
  for (const key of f.keys) {
    const path = workerIntakePath(key.did, f.identityOptions);
    expect(readFileSync(path, 'utf8')).not.toContain(token);
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    }
  }
  expect(JSON.stringify(output.mock.calls)).not.toContain(token);
});

it('keeps name-free pending controls readable and permits inspected approval after upgrade', async () => {
  const f = fixture();
  await f.routers[0].service.request({ toOwnerDid: f.keys[1].did });
  const envelope = f.take(1, 'CONNECTION_REQUEST');
  await f.routers[1].consume(envelope);
  const path = workerIntakePath(f.keys[1].did, f.identityOptions);
  const state = JSON.parse(readFileSync(path, 'utf8')).payload;
  for (const c of state.connections) delete c.peerDisplayName;
  for (const r of state.controls) delete r.offer.peerDisplayName;
  writeFileSync(path, JSON.stringify(signPayload(state, f.keys[1], new Date(NOW).toISOString())));
  const bytes = readFileSync(path);
  expect(f.options[1].store.listConnections()[0]).not.toHaveProperty('peerDisplayName');
  expect(readFileSync(path)).toEqual(bytes);
  await f.routers[1].consume(envelope);
  expect(f.options[1].store.listConnections()[0]).toMatchObject({ state: 'pending', peerDisplayName: 'Requester' });
  await f.routers[1].approve(envelope);
  expect(f.options[1].store.listConnections()[0]).toMatchObject({ state: 'connected', peerDisplayName: 'Requester' });
  await f.routers[0].consume(f.take(0, 'CONNECTION_ACCEPTED'));
  expect(f.options[0].store.listConnections()[0]).not.toHaveProperty('peerDisplayName');
});

it('uses a verified discovery card locally and rejects mismatched cards before consent or send', async () => {
  const f = fixture(), owner = f.keys[1], agent = generateKeyPair();
  const peerAgentCard = card(owner, 'Discovery peer', agent);
  await f.routers[0].service.request({ toOwnerDid: owner.did, peerAgentCard });
  expect(f.options[0].store.listConnections()[0]).toMatchObject({ peerOwnerDid: owner.did,
    peerAgentDid: agent.did, peerDisplayName: 'Discovery peer', state: 'pending' });
  const reviewed = f.options[0].humanReview.review.mock.calls.length, sent = f.options[0].relay.send.mock.calls.length;
  for (const invalid of [card(generateKeyPair(), 'Discovery peer'),
    { ...peerAgentCard, payload: { ...peerAgentCard.payload, name: 'Changed' } },
    createSignedAgentCard({ name: 'Other relay', agentDid: owner.did, relayEndpoint: 'https://other.example', skills: [], now: NOW }, owner)]) {
    await expect(f.routers[0].service.request({ toOwnerDid: owner.did, peerAgentCard: invalid })).rejects.toThrow('INVALID_AGENT_CARD');
  }
  expect(f.options[0].humanReview.review).toHaveBeenCalledTimes(reviewed);
  expect(f.options[0].relay.send).toHaveBeenCalledTimes(sent);
});

it('keeps equal names under separate owner DIDs and preserves names in prior approval metadata', async () => {
  const f = fixture();
  for (const peer of [f.keys[1], generateKeyPair()]) f.options[0].store.recordIncoming({ peerOwnerDid: peer.did, peerDisplayName: 'Reviewer', relayUrl: RELAY,
    incoming: { requestId: peer.did, requestDigest: digest(peer.did), receivedAt: NOW, expiresAt: NOW + 86400000 } });
  f.options[0].store.updateControls(s => {
    s.priorApprovedPeers.push({ peerOwnerDid: f.keys[1].did, sourceRequestIds: [], legacyTrust: 'limited' });
  });
  const rows = f.options[0].store.listConnections();
  expect(rows).toHaveLength(2); expect(new Set(rows.map(r => r.peerOwnerDid)).size).toBe(2);
  expect(rows.every(r => 'peerDisplayName' in r && r.peerDisplayName === 'Reviewer')).toBe(true);
  expect(f.options[0].store.connectionLevel(f.keys[1].did)).toBe('unknown');
  f.options[0].store.disconnect(f.keys[1].did);
  expect(f.options[0].store.listPriorApprovedPeers()).toEqual([{ peerOwnerDid: f.keys[1].did,
    peerDisplayName: 'Reviewer', sourceRequestIds: [], legacyTrust: 'limited' }]);
  const output = vi.fn();
  await connectionsCommand(['prior-approved', '--role', 'requester', '--key', f.keyPath], { identityOptions: f.identityOptions, now, output });
  expect(JSON.parse(output.mock.calls[0][0]).priorApprovedPeers[0]).toMatchObject({ peerDisplayName: 'Reviewer' });
});

it.each(['task', 'binding'] as const)('retains the first known name when a pending peer redeems an invite (%s)', mode => {
  const f = fixture(), store = f.options[0].store;
  const peer = { peerOwnerDid: f.keys[1].did, relayUrl: RELAY };
  store.recordIncoming({ ...peer, peerDisplayName: 'First name',
    incoming: { requestId: 'incoming', requestDigest: digest('incoming'), receivedAt: NOW, expiresAt: NOW + 86400000 } });
  const token = createInviteToken({ agentCard: f.options[0].agentCard }, f.keys[0]);
  const invite = parseAndVerifyInviteToken(token, NOW);
  if (mode === 'task') expect(store.redeemTaskInvite(invite, peer, 'connection')).toBe('first');
  else expect(store.bindInviteFirstUse({ ...peer, peerDisplayName: 'Later name', invite, connectionId: 'connection',
    localConsentDigest: digest('consent'), outbox: { eventId: 'accepted', peerOwnerDid: peer.peerOwnerDid, relayUrl: RELAY,
      signedEvent: signPayload({ type: 'ConnectionAccepted' }, f.keys[0]), deliveryDeadline: NOW + 3600000, state: 'pending' } })).toBe('first');
  expect(store.listConnections()[0]).toMatchObject({ ...peer, state: 'connected', peerDisplayName: 'First name' });
});

it('holds a named incoming request when inspection is unavailable', async () => {
  const f = fixture(false);
  await f.routers[0].service.request({ toOwnerDid: f.keys[1].did });
  const envelope = f.take(1, 'CONNECTION_REQUEST');
  await f.routers[1].consume(envelope);
  expect(f.options[1].store.listConnections()[0]).toMatchObject({ state: 'pending', peerDisplayName: 'Requester' });
  await expect(f.routers[1].approve(envelope)).rejects.toThrow('INSPECTION_INCOMPLETE');
  expect(f.options[1].humanReview.review).not.toHaveBeenCalled();
  expect(f.options[1].store.connectionLevel(f.keys[0].did)).toBe('unknown');
});

it.each([false, true])('uses only verified discovery names for task invitation peers (card=%s)', async published => {
  const f = admissionFixture({ now });
  try {
    if (published) f.relay.register(card(f.requester, 'Published requester'));
    const manifest = f.manifest(); manifest.requester.displayName = 'Manifest label';
    await expect(f.raw(manifest, f.worker.invite())).rejects.toThrow('PENDING_OWNER_APPROVAL');
    const connection = f.store.listConnections()[0];
    expect(connection).toMatchObject({ peerOwnerDid: f.requester.did, state: 'connected' });
    if (published) expect(connection.peerDisplayName).toBe('Published requester');
    else expect(connection).not.toHaveProperty('peerDisplayName');
    expect(f.human.approve).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});

it('passes the discovered worker card into the requester connection exchange', async () => {
  const f = admissionFixture({ now });
  try {
    await f.worker.register();
    const store = new WorkerTrustStore(f.requester, { path: workerIntakePath(f.requester.did, f.identityOptions), now });
    const consent = vi.fn(async () => true);
    f.client.options.connectionStore = store; f.client.options.identityOptions = f.identityOptions;
    f.client.options.now = now; f.client.options.connectionReview = { kind: 'human', review: consent };
    expect((await f.attempt())[0]).toMatchObject({ status: 'rejected', reason: { code: 'PENDING_OWNER_APPROVAL' } });
    expect(store.listConnections()[0]).toMatchObject({ peerOwnerDid: f.owner.did,
      peerDisplayName: f.worker.agentCard.payload.name, state: 'pending' });
    expect(consent).toHaveBeenCalledOnce(); expect(f.execute).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});

it.each([null, 12, ''])('rejects invalid stored peer display metadata (%s)', name => {
  const f = fixture();
  f.options[0].store.recordIncoming({ peerOwnerDid: f.keys[1].did, relayUrl: RELAY,
    incoming: { requestId: 'pending', requestDigest: digest('pending'), receivedAt: NOW, expiresAt: NOW + 86400000 } });
  const path = workerIntakePath(f.keys[0].did, f.identityOptions), state = JSON.parse(readFileSync(path, 'utf8')).payload;
  state.connections[0].peerDisplayName = name;
  writeFileSync(path, JSON.stringify(signPayload(state, f.keys[0], new Date(NOW).toISOString())));
  expect(() => f.options[0].store.listConnections()).toThrow('INTAKE_STORE_INVALID');
});

it.each(['file', 'keychain'] as const)('retains a pending %s import on confirmation and keeps established names during unconfirmed cleanup', async backend => {
  const f = fixture(true, backend);
  const invites = await InviteStore.open(f.keys[0], { ...f.identityOptions, now });
  const token = createInviteToken({ agentCard: f.options[1].agentCard }, f.keys[1]);
  const saved = invites.import(token, 'reviewer', { pendingConfirmation: true });
  expect(invites.listUnconfirmed()).toEqual([saved]);
  expect(() => invites.resolve(saved.workerRef)).toThrow('INVITE_CONFIRMATION_REQUIRED');
  expect(f.options[0].store.connectionStatus(f.keys[1].did)).not.toHaveProperty('peerDisplayName');
  const output = vi.fn(), transportFactory = vi.fn(() => f.options[0].relay);
  const commandOptions = { identityOptions: f.identityOptions, now, output, transportFactory,
    review: vi.fn(async () => {
      expect(invites.listUnconfirmed()).toEqual([]);
      expect(invites.resolve(saved.workerRef).invite.agentCard.payload.name).toBe('査読者');
      return true;
    }) };
  await connectionsCommand(['confirm-invite', saved.alias, '--key', f.keyPath], commandOptions);
  expect(commandOptions.review).toHaveBeenCalledOnce();
  expect(invites.list()[0]).not.toHaveProperty('importState');
  expect(f.options[0].store.connectionStatus(f.keys[1].did)).toMatchObject({ status: 'pending_peer', peerDisplayName: '査読者' });
  await f.routers[1].consume(f.take(1, 'CONNECTION_REQUEST'));
  await f.routers[0].consume(f.take(0, 'CONNECTION_ACCEPTED'));
  expect(f.options[0].store.connectionStatus(f.keys[1].did)).toMatchObject({ status: 'connected', peerDisplayName: '査読者' });

  // A different pending invitation from the same owner is eligible for cleanup.
  const unconfirmedToken = createInviteToken({ agentCard: card(f.keys[1], 'Later name') }, f.keys[1]);
  const unconfirmed = invites.import(unconfirmedToken, 'temporary', { pendingConfirmation: true });
  const path = workerIntakePath(f.keys[0].did, f.identityOptions), bytes = readFileSync(path);
  const reopened = await InviteStore.open(f.keys[0], { ...f.identityOptions, now: () => NOW + 1 });
  expect(reopened.removeUnconfirmed({ olderThan: new Date(NOW + 1).toISOString() })).toEqual({ removed: 1 });
  expect(reopened.list().map(i => i.workerRef)).toEqual([saved.workerRef]);
  expect(() => reopened.resolve(unconfirmed.workerRef)).toThrow('INVITE_NOT_FOUND');
  expect(reopened.remove(saved.workerRef)).toBe(true);
  expect(f.secrets.size).toBe(0);
  transportFactory.mockClear(); commandOptions.review.mockClear();
  await connectionsCommand(['status', f.keys[1].did, '--key', f.keyPath], commandOptions);
  expect(JSON.parse(output.mock.calls.at(-1)![0])).toMatchObject({ status: 'connected', peerDisplayName: '査読者' });
  const restarted = new WorkerTrustStore(f.keys[0], { path, now });
  const status: ConnectionStatus = restarted.connectionStatus(f.keys[1].did);
  expect(status).toMatchObject({ status: 'connected', peerDisplayName: '査読者' });
  expect(restarted.listConnections()).toMatchObject([{ peerDisplayName: '査読者' }]);
  expect(readFileSync(path)).toEqual(bytes);
  expect(transportFactory).not.toHaveBeenCalled(); expect(commandOptions.review).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(JSON.stringify(output.mock.calls)).not.toContain(token);
  expect(JSON.stringify(output.mock.calls)).not.toContain(unconfirmedToken);
});

it('projects named and unnamed status from one snapshot without rewriting legacy records', async () => {
  const f = fixture(false), peer = f.keys[1].did;
  expect(f.options[0].store.connectionStatus(peer)).toEqual({ peerOwnerDid: peer, state: 'none', status: 'none' });
  await f.routers[0].service.request({ toOwnerDid: peer });
  await f.routers[1].consume(f.take(1, 'CONNECTION_REQUEST'));
  const unnamed = f.options[0].store.connectionStatus(peer);
  expect(unnamed).toMatchObject({ status: 'pending_peer' });
  expect(unnamed).not.toHaveProperty('peerDisplayName');
  expect(f.options[1].store.connectionStatus(f.keys[0].did)).toMatchObject({ status: 'pending_owner', peerDisplayName: 'Requester' });
  const path = workerIntakePath(peer, f.identityOptions);
  const state = JSON.parse(readFileSync(path, 'utf8')).payload;
  for (const c of state.connections) delete c.peerDisplayName;
  for (const r of state.controls) delete r.offer.peerDisplayName;
  writeFileSync(path, JSON.stringify(signPayload(state, f.keys[1], new Date(NOW).toISOString())));
  const bytes = readFileSync(path);
  expect(f.options[1].store.connectionStatus(f.keys[0].did)).toMatchObject({ status: 'pending_owner' });
  expect(f.options[1].store.connectionStatus(f.keys[0].did)).not.toHaveProperty('peerDisplayName');
  expect(readFileSync(path)).toEqual(bytes);
});

it('retains the applicable offer name in inactive status after withdrawal and restart', async () => {
  const f = fixture(), peer = f.keys[1].did;
  const peerAgentCard = f.options[1].agentCard;
  await f.routers[0].service.request({ toOwnerDid: peer, peerAgentCard });
  const store = f.options[0].store;
  const status = store.connectionStatus(peer);
  expect(status).toMatchObject({ status: 'pending_peer', peerDisplayName: '査読者' });
  const known: ConnectionPeer = { peerOwnerDid: peer, peerDisplayName: status.peerDisplayName, relayUrl: RELAY };
  store.withdrawConnection(peer, status.requestId!);
  expect(store.listConnections()).toEqual([]);
  const path = workerIntakePath(f.keys[0].did, f.identityOptions), bytes = readFileSync(path);
  const restarted = new WorkerTrustStore(f.keys[0], { path, now });
  expect(restarted.connectionStatus(peer)).toMatchObject({ peerOwnerDid: known.peerOwnerDid,
    peerDisplayName: known.peerDisplayName, status: 'inactive', state: 'none', requestId: status.requestId });
  expect(readFileSync(path)).toEqual(bytes);
});
