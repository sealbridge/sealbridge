// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, signPayload } from '../packages/core/src/index.js';
import type { KeyPair } from '../packages/core/src/index.js';
import { ConnectionRouter, HeldRequestReview, InviteStore, KeychainSecretStore, WorkerTrustStore,
  resolveStoredIdentity, syncConnections, workerIntakePath } from '../packages/runtime/src/index.js';
import type { IdentityStoreOptions, KeyringModule } from '../packages/runtime/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { connectionsCommand } from '../cli/src/connections.js';
import { completeInspection } from './connections-fixture.js';
import { card, DAY, EPOCH, invite, RELAY } from './connection-fixture.js';

const roots: string[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(EPOCH);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network call'); }));
});
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function directory() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'connection-status-')); roots.push(root); return root;
}
async function fixture(inspection = true) {
  const root = directory(), secrets = new Map<string, string>();
  const module: KeyringModule = { Entry: class {
    readonly id: string;
    constructor(service: string, account: string) { this.id = service + '/' + account; }
    getPassword() { return secrets.get(this.id) ?? null; }
    setPassword(value: string) { secrets.set(this.id, value); }
    deletePassword() { return secrets.delete(this.id); }
  } };
  let clock = EPOCH;
  const now = () => clock;
  const identityOptions: IdentityStoreOptions = { home: root, env: { SEALBRIDGE_DATA_DIR: join(root, 'data') },
    keyStore: 'file', keyringLoader: async () => module };
  const owner = await resolveStoredIdentity('requester', identityOptions), peer = generateKeyPair();
  const token = invite(peer);
  const invites = await InviteStore.open(owner, { ...identityOptions, now,
    secretStore: new KeychainSecretStore(module, identityOptions) });
  const saved = invites.import(token, 'reviewer');
  const store = (key: KeyPair) => new WorkerTrustStore(key, { path: workerIntakePath(key.did, identityOptions), now });
  const relay = new InMemoryRelay({ now });
  const router = (key: KeyPair, inspected = inspection) => new ConnectionRouter({ owner: key,
    store: store(key), relay, relayUrl: RELAY, now, agentCard: card(key),
    review: new HeldRequestReview(key, { ...identityOptions, now, provider: inspected ? completeInspection : undefined }),
    humanReview: { kind: 'human', review: async () => true } });
  const transportFactory = vi.fn(() => relay), output = vi.fn();
  const options = { identityOptions, now, transportFactory, output, review: vi.fn(async () => true) };
  const status = async (ref = saved.workerRef, extra: string[] = []) => {
    output.mockClear();
    await connectionsCommand(['status', ref, ...extra], options);
    return JSON.parse(output.mock.calls[0][0]);
  };
  const confirm = () => connectionsCommand(['confirm-invite', saved.alias], options);
  return { root, identityOptions, now, owner, peer, token, invites, saved, store, relay, router, options,
    status, confirm, advance(ms: number) { clock += ms; vi.setSystemTime(clock); } };
}

it('observes invite confirmation, remote application and ACK across one-shot syncs and restarts', async () => {
  const f = await fixture();
  expect(await f.status()).toMatchObject({ role: 'requester', status: 'none', state: 'none' });
  expect(f.options.transportFactory).not.toHaveBeenCalled();
  await f.confirm();
  const pending = await f.status(f.saved.alias);
  expect(pending).toMatchObject({ peerOwnerDid: f.peer.did, status: 'pending_peer', state: 'pending', direction: 'outgoing' });
  expect(pending.requestId).toBeTypeOf('string');
  await syncConnections(f.router(f.peer), { once: true });
  // Peer redemption alone does not update the sender's local snapshot.
  expect(await f.status()).toMatchObject({ status: 'pending_peer' });
  expect(f.store(f.peer).connectionStatus(f.owner.did)).toMatchObject({ status: 'connected', acknowledgementPending: true });
  await connectionsCommand(['sync', '--role', 'requester', '--relay', RELAY, '--once'], f.options);
  const connected = await f.status();
  expect(connected).toMatchObject({ status: 'connected', state: 'connected', requestId: pending.requestId,
    acknowledgementPending: false, connectedAt: EPOCH });
  expect(connected.connectionId).toBeTypeOf('string');
  await syncConnections(f.router(f.peer), { once: true });
  // The sender's pre-receive flush queued a request retry ahead of its ACK.
  expect(f.store(f.peer).connectionStatus(f.owner.did)).toMatchObject({ acknowledgementPending: true });
  await syncConnections(f.router(f.peer), { once: true });
  expect(f.store(f.peer).connectionStatus(f.owner.did)).toMatchObject({ acknowledgementPending: false });
  expect(f.store(f.owner).connectionLevel(f.peer.did)).toBe('limited');
  expect(f.store(f.owner).level(f.peer.did)).toBe('unknown');
  const before = readFileSync(workerIntakePath(f.owner.did, f.identityOptions));
  f.options.transportFactory.mockClear(); f.options.review.mockClear();
  expect(await f.status(f.peer.did)).toMatchObject({ status: 'connected', connectionId: connected.connectionId });
  expect(readFileSync(workerIntakePath(f.owner.did, f.identityOptions))).toEqual(before);
  expect(f.options.transportFactory).not.toHaveBeenCalled(); expect(f.options.review).not.toHaveBeenCalled();
  expect(JSON.stringify(f.options.output.mock.calls)).not.toContain('acp-invite:');
  expect(readFileSync(f.invites.path, 'utf8')).not.toContain(f.token);
  expect(before.toString()).not.toContain(f.token);
  f.advance(15 * DAY);
  // Expiry of the saved invitation does not erase an established connection.
  expect(await f.status()).toMatchObject({ status: 'connected' });
  f.store(f.owner).updateControls(() => {});
  expect(f.store(f.owner).connectionStatus(f.peer.did)).toMatchObject({ status: 'connected' });
  expect(f.store(f.owner).connectionStatus(f.peer.did)).not.toHaveProperty('acknowledgementPending');
});

it('keeps unavailable inspection and remote rejection pending at the sender', async () => {
  const f = await fixture(false); await f.confirm();
  await syncConnections(f.router(f.peer), { once: true });
  expect(f.store(f.peer).connectionStatus(f.owner.did)).toMatchObject({ status: 'pending_owner', direction: 'incoming' });
  expect(f.router(f.peer).options.review.list()).toHaveLength(1);
  expect(await f.status()).toMatchObject({ status: 'pending_peer' });
  f.store(f.peer).rejectConnection(f.owner.did);
  expect(f.store(f.peer).connectionStatus(f.owner.did)).toMatchObject({ status: 'inactive', state: 'none' });
  expect(await f.status()).toMatchObject({ status: 'pending_peer' });
});

it('reports a pending request after send failure and a pending ACK after local acceptance', async () => {
  const f = await fixture();
  const sender = f.router(f.owner);
  const send = vi.spyOn(f.relay, 'send').mockImplementation(() => { throw new Error('offline'); });
  await sender.service.request({ toOwnerDid: f.peer.did, inviteToken: f.token });
  expect(await f.status()).toMatchObject({ status: 'pending_peer' });
  send.mockRestore();
  await sender.service.flushOutbox();
  await syncConnections(f.router(f.peer), { once: true });
  const accepted = f.relay.receive(f.owner.did, 0)!;
  const failAck = vi.spyOn(f.relay, 'send').mockImplementation(() => { throw new Error('offline'); });
  await sender.consume(accepted);
  expect(await f.status()).toMatchObject({ status: 'connected', acknowledgementPending: true });
  failAck.mockRestore();
  await sender.service.flushOutbox();
  expect(await f.status()).toMatchObject({ status: 'connected', acknowledgementPending: false });
});

it.each(['withdraw', 'disconnect', 'block'] as const)('retains the local %s decision in status', async action => {
  const f = await fixture(); await f.confirm();
  const store = f.store(f.owner), requestId = store.connectionStatus(f.peer.did).requestId!;
  if (action === 'withdraw') store.withdrawConnection(f.peer.did, requestId);
  else store[action](f.peer.did);
  expect(await f.status()).toMatchObject({ status: action === 'block' ? 'blocked' : 'inactive', requestId });
  if (action === 'block') {
    store.unblock(f.peer.did);
    expect(await f.status()).toMatchObject({ status: 'inactive' });
  }
});

it('projects offer expiry without modifying files and returns none after existing record pruning', async () => {
  const f = await fixture(); await f.confirm();
  const path = workerIntakePath(f.owner.did, f.identityOptions), bytes = readFileSync(path);
  f.advance(DAY);
  // Invite expiry precedes the offer's independent 14-day deadline.
  expect(await f.status()).toMatchObject({ status: 'pending_peer' });
  f.advance(13 * DAY);
  expect(await f.status()).toMatchObject({ status: 'expired', state: 'none', expiresAt: EPOCH + 14 * DAY });
  expect(readFileSync(path)).toEqual(bytes);
  f.store(f.owner).updateControls(() => {});
  expect(await f.status()).toMatchObject({ status: 'none' });
});

it('reads version 1 stores and version 2 stores without exchange controls', async () => {
  const f = await fixture(), path = workerIntakePath(f.owner.did, f.identityOptions);
  // Publish a version 1 fixture with the store's existing directory policy.
  f.store(f.owner).block(generateKeyPair().did);
  function publish(payload: object) {
    writeFileSync(path + '.fixture', JSON.stringify(signPayload(payload, f.owner, new Date(EPOCH).toISOString())), { mode: 0o600 });
    renameSync(path + '.fixture', path);
  }
  publish({ version: 1, workerOwnerDid: f.owner.did, requests: [], grants: [], denials: [] });
  expect(await f.status()).toMatchObject({ status: 'none' });
  await f.confirm();
  const data = JSON.parse(readFileSync(path, 'utf8')).payload;
  delete data.controls; publish(data);
  expect(await f.status()).toMatchObject({ status: 'pending_peer', direction: 'outgoing' });
  f.advance(14 * DAY);
  expect(await f.status()).toMatchObject({ status: 'expired' });
});

it('does not create identities on status and keeps roles and unknown references distinct', async () => {
  const empty = directory(), output = vi.fn();
  await connectionsCommand(['status', 'reviewer'], { identityOptions: { home: empty,
    env: { SEALBRIDGE_DATA_DIR: join(empty, 'data') } }, output });
  expect(JSON.parse(output.mock.calls[0][0])).toEqual({ role: 'requester', status: 'none', state: 'none' });
  expect(existsSync(join(empty, 'data'))).toBe(false);
  const f = await fixture(); await f.confirm();
  await resolveStoredIdentity('worker', f.identityOptions);
  expect(await f.status(f.peer.did, ['--role', 'worker'])).toMatchObject({ role: 'worker', status: 'none' });
  await expect(f.status('missing')).rejects.toThrow('INVITE_NOT_FOUND');
  const foreign = generateKeyPair();
  expect(await f.status(foreign.did)).toMatchObject({ status: 'none', peerOwnerDid: foreign.did });
  expect(await f.status(f.owner.did)).toMatchObject({ status: 'none', peerOwnerDid: f.owner.did });
});
