// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInviteToken, createSignedAgentCard, digest, generateKeyPair, parseAndVerifyInviteToken } from '../packages/core/src/index.js';
import { ConnectionAliases, defaultConnectionAlias, InviteStore, resolveStoredIdentity, WorkerTrustStore, workerIntakePath } from '../packages/runtime/src/index.js';
import { connectionTarget, localConnections } from '../cli/src/connection-target.js';
import { connectionsCommand } from '../cli/src/connections.js';
import { networkCommand } from '../cli/src/network.js';
import { protocolTestNow } from './protocol-test-clock.js';

let root: string;
let options: { home: string; env: { SEALBRIDGE_DATA_DIR: string } };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(protocolTestNow('2026-11-14T00:00:00Z'));
  root = mkdtempSync(join(tmpdir(), 'connection-aliases-'));
  options = { home: root, env: { SEALBRIDGE_DATA_DIR: root } };
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });
async function connect(role: 'worker' | 'requester', name: string) {
  const key = await resolveStoredIdentity(role, options), peer = generateKeyPair();
  const card = createSignedAgentCard({ name, agentDid: peer.did, relayEndpoint: 'https://relay.example', skills: [], protocolVersions: ['0.2.0'] }, peer);
  const token = createInviteToken({ agentCard: card }, peer);
  // Seed the pre-existing on-disk invite connection format; no new fields or migration.
  const localCard = createSignedAgentCard({ name: 'Local ' + peer.did, agentDid: key.did, relayEndpoint: 'https://relay.example', skills: [] }, key);
  const invite = parseAndVerifyInviteToken(createInviteToken({ agentCard: localCard }, key));
  const store = new WorkerTrustStore(key, { path: workerIntakePath(key.did, options) });
  store.redeemTaskInvite(invite, { peerOwnerDid: peer.did, peerAgentDid: peer.did, peerDisplayName: name, relayUrl: 'https://relay.example' }, 'test-' + peer.did);
  return { key, peer, store, token };
}
it('reads old connection records without rewriting and renames only the signed alias sidecar', async () => {
  const f = await connect('worker', 'Review Bot');
  const path = workerIntakePath(f.key.did, options), before = readFileSync(path);
  expect(defaultConnectionAlias('Review Bot')).toBe('review-bot');
  expect(defaultConnectionAlias('査読者')).toBe('peer');
  expect(localConnections(f.key, options)[0]).toMatchObject({ alias: 'review-bot', peerOwnerDid: f.peer.did, state: 'connected' });
  const output = vi.fn();
  await connectionsCommand(['alias', f.peer.did, 'reviewer'], { identityOptions: options, output });
  expect((await connectionTarget('reviewer', options))?.key.did).toBe(f.key.did);
  expect(readFileSync(path)).toEqual(before);
  expect(new WorkerTrustStore(f.key, { path }).connectionState(f.peer.did)).toBe('connected');
  await connectionsCommand(['list'], { identityOptions: options, output });
  expect(JSON.parse(output.mock.calls.at(-1)![0]).connections[0]).toMatchObject({ alias: 'reviewer', localOwnerDid: f.key.did, peerOwnerDid: f.peer.did, state: 'connected' });
});
it('rejects identical default names and cross-key ambiguity instead of choosing a peer', async () => {
  const a = await connect('worker', 'Peer'), b = await connect('requester', 'Peer');
  await expect(connectionTarget('peer', options)).rejects.toThrow('CONNECTION_ALIAS_AMBIGUOUS');
  await expect(connectionsCommand(['alias', 'peer', 'chosen'], { identityOptions: options })).rejects.toThrow('CONNECTION_ALIAS_AMBIGUOUS');
  await connectionsCommand(['alias', a.peer.did, 'chosen', '--role', 'worker'], { identityOptions: options, output: vi.fn() });
  expect((await connectionTarget('chosen', options))?.connection.peerOwnerDid).toBe(a.peer.did);
  expect((await connectionTarget('peer', options))?.connection.peerOwnerDid).toBe(b.peer.did);
});
it('fails clearly on unknown targets and preserves literal DID/invite/saved references', async () => {
  expect(await connectionTarget('missing', options)).toBeUndefined();
  await expect(networkCommand('delegate', ['--to', 'missing', '--title', 'T', '--description', 'D', '--input', '{}', '--auto-approve'], { identityOptions: options })).rejects.toThrow('INVITE_NOT_FOUND');
  for (const name of ['did:key:test', 'saved:test']) expect(await connectionTarget(name, options)).toBeUndefined();
});
it('rejects connection/invite alias conflicts and never bypasses saved invite expiry', async () => {
  const a = await connect('requester', 'reviewer'), b = await connect('worker', 'Other');
  const invites = await InviteStore.open(a.key, options);
  invites.import(b.token, 'reviewer');
  await expect(connectionTarget('reviewer', options)).rejects.toThrow('CONNECTION_TARGET_CONFLICT');
  const saved = invites.list()[0];
  expect(await connectionTarget(saved.workerRef, options)).toBeUndefined();
  vi.setSystemTime(Date.now() + 2 * 86400000);
  expect(() => invites.resolve(saved.workerRef)).toThrow('INVITE_EXPIRED');
  await expect(connectionTarget('reviewer', options)).rejects.toThrow('CONNECTION_TARGET_CONFLICT');
  for (const [flag, value] of [['--to', saved.workerRef], ['--peer-ref', 'reviewer'], ['--invite', 'reviewer']]) {
    await expect(networkCommand('delegate', [flag, value, '--title', 'T', '--description', 'D', '--input', '{}', '--auto-approve'],
      { identityOptions: options })).rejects.toThrow('INVITE_EXPIRED');
  }
});
it.each(['pending', 'connected'] as const)('preserves saved alias resolution and expiry for the same peer with a %s connection', async state => {
  const f = await connect('requester', 'Muse');
  const invites = await InviteStore.open(f.key, options);
  invites.import(f.token, 'muse');
  if (state === 'pending') {
    f.store.disconnect(f.peer.did);
    f.store.recordOutgoing({ peerOwnerDid: f.peer.did, peerDisplayName: 'Muse', relayUrl: 'https://relay.example',
      outgoing: { requestId: 'pending', requestDigest: digest('offer'), createdAt: Date.now(),
        expiresAt: Date.now() + 60000, ownerConsentDigest: digest('consent') } });
  }
  expect(await connectionTarget('muse', options)).toBeUndefined();
  expect(invites.resolve('muse').invite.ownerDid).toBe(f.peer.did);
  vi.setSystemTime(Date.now() + 2 * 86400000);
  expect(await connectionTarget('muse', options)).toBeUndefined();
  await expect(networkCommand('delegate', ['--to', 'muse', '--title', 'T', '--description', 'D', '--input', '{}', '--auto-approve'],
    { identityOptions: options })).rejects.toThrow('INVITE_EXPIRED');
});
it('does not let a pending different-peer connection alias shadow a saved invite', async () => {
  const f = await connect('requester', 'Muse'), other = await connect('worker', 'Other');
  f.store.disconnect(f.peer.did);
  f.store.recordOutgoing({ peerOwnerDid: f.peer.did, peerDisplayName: 'Muse', relayUrl: 'https://relay.example',
    outgoing: { requestId: 'pending', requestDigest: digest('offer'), createdAt: Date.now(),
      expiresAt: Date.now() + 60000, ownerConsentDigest: digest('consent') } });
  const invites = await InviteStore.open(f.key, options);
  invites.import(other.token, 'muse');
  expect(await connectionTarget('muse', options)).toBeUndefined();
  expect(invites.resolve('muse').invite.ownerDid).toBe(other.peer.did);
});
it('keeps historical top-level list identity fields while identifying aggregate rows separately', async () => {
  const f = await connect('worker', 'One'); await connect('requester', 'Two');
  const output = vi.fn();
  await connectionsCommand(['list'], { identityOptions: options, output });
  expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ localOwnerDid: f.key.did, role: 'worker', scope: 'all',
    connections: [expect.objectContaining({ localOwnerDid: expect.any(String) }), expect.objectContaining({ localOwnerDid: expect.any(String) })] });
});
it('explains safe manual recovery from an alias lock without deleting a possibly active writer lock', async () => {
  const f = await connect('worker', 'One');
  const aliases = new ConnectionAliases(f.key, options);
  aliases.rename(f.peer.did, 'one', f.store.listConnections());
  writeFileSync(aliases.path + '.lock', '999999999', { mode: 0o600 });
  expect(() => aliases.rename(f.peer.did, 'new', f.store.listConnections())).toThrow('check that no alias writer is alive');
  expect(readFileSync(aliases.path + '.lock', 'utf8')).toBe('999999999');
});
it('rejects blocked aliases before transmitting and retains a user rename across blocking', async () => {
  const f = await connect('worker', 'Reviewer');
  new ConnectionAliases(f.key, options).rename(f.peer.did, 'reviewer', f.store.listConnections());
  f.store.block(f.peer.did);
  const transportFactory = vi.fn();
  await expect(networkCommand('delegate', ['--to', 'reviewer', '--title', 'T', '--description', 'D', '--input', '{}', '--auto-approve'],
    { identityOptions: options, transportFactory })).rejects.toThrow('CONNECTION_NOT_CONNECTED');
  expect(transportFactory).not.toHaveBeenCalled();
});
it('rejects alias collisions, reserved syntax and forged sidecar data', async () => {
  const a = await connect('worker', 'One'), b = await connect('worker', 'Two');
  const aliases = new ConnectionAliases(a.key, options);
  expect(() => aliases.rename(a.peer.did, 'two', a.store.listConnections())).toThrow('CONNECTION_ALIAS_EXISTS');
  expect(() => aliases.rename(a.peer.did, 'did:key:other', a.store.listConnections())).toThrow('INVALID_CONNECTION_ALIAS');
  expect(localConnections(b.key, options)).toHaveLength(2);
  aliases.rename(a.peer.did, 'chosen', a.store.listConnections());
  const forged = JSON.parse(readFileSync(aliases.path, 'utf8'));
  forged.payload.aliases[a.peer.did] = 'forged';
  writeFileSync(aliases.path, JSON.stringify(forged));
  expect(() => localConnections(a.key, options)).toThrow('CONNECTION_ALIAS_STORE_INVALID');
});
