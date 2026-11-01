// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createSignedAgentCard, digest, generateKeyPair, PROTOCOL_DAY_MS, signPayload,
  supportedReceiveVersions, supportedSendVersions,
} from '../packages/core/src/index.js';
import type { KeyPair, ProtocolCompatibilityPolicy, SignedAgentCard } from '../packages/core/src/index.js';
import { ProtocolPeerStore, protocolPeerPath } from '../packages/runtime/src/index.js';

let root: string, clock: number;
const release = Date.parse('2030-01-01T00:00:00.000Z');
const policy: ProtocolCompatibilityPolicy = {
  releasedAt: '2030-01-01T00:00:00.000Z', sendLegacyUntilDays: 90, receiveLegacyUntilDays: 180,
};
beforeEach(() => {
  root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'sealbridge-protocol-'));
  clock = release; vi.useFakeTimers(); vi.setSystemTime(clock);
});
afterEach(() => { vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });
function options() { return { env: { SEALBRIDGE_DATA_DIR: join(root, 'data') }, home: root, now: () => clock }; }
function card(owner: KeyPair, protocolVersions?: string[], agent: KeyPair = owner): SignedAgentCard {
  return createSignedAgentCard({ agentDid: agent.did, agentKey: agent,
    name: 'Worker', relayEndpoint: 'https://relay.example', skills: [], protocolVersions }, owner);
}
it('inspects absent data without creating files or identities', () => {
  const owner = generateKeyPair(), peer = generateKeyPair(), store = new ProtocolPeerStore(owner, options());
  expect(store.path).toBe(protocolPeerPath(owner.did, options()));
  expect(store.snapshot()).toEqual({ version: 1, localOwnerDid: owner.did, observations: [] });
  expect(store.floor(peer.did, peer.did)).toBeUndefined();
  expect(fs.readdirSync(root)).toEqual([]);
});
it('records signed current capability and preserves a raised floor across restart and lower cards', () => {
  const owner = generateKeyPair(), peer = generateKeyPair(), store = new ProtocolPeerStore(owner, options());
  const legacy = card(peer);
  expect(store.observe(peer.did, peer.did, [legacy])?.highestVersion).toBe('0.1.0');
  const current = card(peer, ['9.0.0', '0.2.0', '0.1.0']);
  const entry = store.observe(peer.did, peer.did, [current]);
  expect(entry).toEqual({ ownerDid: peer.did, agentDid: peer.did, highestVersion: '0.2.0',
    cardDigest: digest(current), observedAt: new Date(clock).toISOString() });
  const restart = new ProtocolPeerStore(owner, options());
  expect(restart.floor(peer.did, peer.did)).toBe('0.2.0');
  expect(restart.observe(peer.did, peer.did, [legacy])).toEqual(entry);
  expect(restart.observe(peer.did, peer.did, [card(peer, ['9.0.0'])])).toEqual(entry);
  const bytes = fs.readFileSync(store.path, 'utf8').replace(/\n/g, '\r\n');
  fs.writeFileSync(store.path, bytes);
  restart.snapshot(); restart.floor(peer.did, peer.did);
  expect(fs.readFileSync(store.path, 'utf8')).toBe(bytes);
  if (process.platform !== 'win32') {
    expect(fs.statSync(store.path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dirname(store.path)).mode & 0o777).toBe(0o700);
  }
});
it('resolves current cards before raising a floor and retains only locally understood versions', () => {
  const owner = generateKeyPair(), peer = generateKeyPair(), store = new ProtocolPeerStore(owner, options());
  const older = card(peer, ['0.2.0']);
  clock += 1000; vi.setSystemTime(clock);
  const newer = card(peer, ['0.1.0']);
  for (const cards of [[older, newer], [newer, older]]) {
    expect(store.observe(peer.did, peer.did, cards)?.highestVersion).toBe('0.1.0');
    expect(store.snapshot().observations[0].cardDigest).toBe(digest(newer));
  }
  const unknown = generateKeyPair();
  expect(store.observe(unknown.did, unknown.did, [card(unknown, ['9.0.0'])])).toBeUndefined();
  expect(store.floor(unknown.did, unknown.did)).toBeUndefined();
});
it('scopes observations to both peer owner and agent and to the selected local DID', () => {
  const owner = generateKeyPair(), otherLocal = generateKeyPair(), peer = generateKeyPair(), agent = generateKeyPair();
  const store = new ProtocolPeerStore(owner, options()), other = new ProtocolPeerStore(otherLocal, options());
  store.observe(peer.did, agent.did, [card(peer, ['0.2.0'], agent)]);
  expect(store.floor(peer.did, agent.did)).toBe('0.2.0');
  expect(store.floor(peer.did, peer.did)).toBeUndefined();
  expect(store.floor(otherLocal.did, agent.did)).toBeUndefined();
  expect(other.floor(peer.did, agent.did)).toBeUndefined();
  other.observe(peer.did, peer.did, [card(peer)]);
  expect(other.path).not.toBe(store.path);
  expect(store.snapshot().observations).toHaveLength(1);
});
it('rejects invalid, expired, mismatched and future-dated cards without replacing observations', () => {
  const owner = generateKeyPair(), peer = generateKeyPair(), store = new ProtocolPeerStore(owner, options());
  const valid = card(peer, ['0.2.0']); store.observe(peer.did, peer.did, [valid]);
  const bytes = fs.readFileSync(store.path, 'utf8');
  const changed = structuredClone(valid); changed.payload.protocolVersions = ['0.1.0'];
  const foreign = signPayload(valid.payload, owner);
  const future = signPayload(valid.payload, peer, new Date(clock + 120_000).toISOString());
  for (const invalid of [changed, foreign, future])
    expect(() => store.observe(peer.did, peer.did, [invalid])).toThrow('PROTOCOL_STORE_INVALID');
  expect(() => store.observe(owner.did, peer.did, [valid])).toThrow('PROTOCOL_STORE_INVALID');
  clock += 25 * 3600_000;
  expect(() => store.observe(peer.did, peer.did, [valid])).toThrow('PROTOCOL_STORE_INVALID');
  expect(fs.readFileSync(store.path, 'utf8')).toBe(bytes);
});
it('requires the agent delegation and an unambiguous current owner for a separate agent DID', () => {
  const local = generateKeyPair(), owner = generateKeyPair(), otherOwner = generateKeyPair(), agent = generateKeyPair();
  const store = new ProtocolPeerStore(local, options());
  const valid = card(owner, ['0.2.0'], agent), other = card(otherOwner, ['0.2.0'], agent);
  const payload = structuredClone(valid.payload); delete payload.agentDelegation;
  expect(() => store.observe(owner.did, agent.did, [signPayload(payload, owner)])).toThrow('PROTOCOL_STORE_INVALID');
  expect(() => store.observe(owner.did, agent.did, [valid, other])).toThrow('PROTOCOL_STORE_INVALID');
  expect(store.floor(owner.did, agent.did)).toBeUndefined();
  expect(store.observe(owner.did, agent.did, [valid])?.highestVersion).toBe('0.2.0');
});
it('persists policy phase monotonically with an epoch binding across clock rollback and restart', () => {
  const owner = generateKeyPair(), store = new ProtocolPeerStore(owner, options());
  store.observePolicy(policy);
  clock += 90 * PROTOCOL_DAY_MS;
  expect(supportedSendVersions(store.observePolicy(policy), clock)).toEqual(['0.2.0']);
  clock = release;
  const restart = new ProtocolPeerStore(owner, options());
  expect(supportedSendVersions(restart.observePolicy(policy), clock)).toEqual(['0.2.0']);
  expect(supportedReceiveVersions(restart.observePolicy(policy), clock)).toEqual(['0.2.0', '0.1.0']);
  clock += 180 * PROTOCOL_DAY_MS;
  restart.observePolicy(policy); clock = release;
  expect(supportedReceiveVersions(restart.observePolicy(policy), clock)).toEqual(['0.2.0']);
  const bytes = fs.readFileSync(store.path, 'utf8');
  expect(() => restart.observePolicy({ ...policy, releasedAt: '2029-01-01T00:00:00.000Z' })).toThrow('PROTOCOL_STORE_INVALID');
  expect(fs.readFileSync(store.path, 'utf8')).toBe(bytes);
});
it('preserves the established floor on lock contention and failed atomic publication', () => {
  const owner = generateKeyPair(), peer = generateKeyPair(), store = new ProtocolPeerStore(owner, options());
  store.observe(peer.did, peer.did, [card(peer)]);
  const bytes = fs.readFileSync(store.path, 'utf8');
  fs.writeFileSync(store.path + '.lock', '', { mode: 0o600 });
  expect(() => store.observe(peer.did, peer.did, [card(peer, ['0.2.0'])])).toThrow('PROTOCOL_STORE_BUSY');
  expect(fs.existsSync(store.path + '.lock')).toBe(true); fs.unlinkSync(store.path + '.lock');
  const failing = new ProtocolPeerStore(owner, { ...options(), fs: { ...fs, renameSync: () => { throw new Error('injected'); } } });
  expect(() => failing.observe(peer.did, peer.did, [card(peer, ['0.2.0'])])).toThrow('PROTOCOL_STORE_UNWRITABLE');
  expect(fs.readFileSync(store.path, 'utf8')).toBe(bytes);
  expect(fs.readdirSync(dirname(store.path))).toEqual([basename(store.path)]);
  expect(store.floor(peer.did, peer.did)).toBe('0.1.0');
  store.observe(peer.did, peer.did, [card(peer, ['0.2.0'])]);
  expect(store.floor(peer.did, peer.did)).toBe('0.2.0');
});
it('serializes two store instances and reads the latest committed state before mutation', () => {
  const owner = generateKeyPair(), first = generateKeyPair(), second = generateKeyPair();
  const competing = new ProtocolPeerStore(owner, options());
  let observed = false;
  const store = new ProtocolPeerStore(owner, { ...options(), fs: { ...fs,
    renameSync: ((...args: Parameters<typeof fs.renameSync>) => {
      expect(() => competing.observe(second.did, second.did, [card(second)])).toThrow('PROTOCOL_STORE_BUSY');
      observed = true; fs.renameSync(...args);
    }) as typeof fs.renameSync,
  } });
  store.observe(first.did, first.did, [card(first, ['0.2.0'])]);
  expect(observed).toBe(true);
  competing.observe(second.did, second.did, [card(second)]);
  expect(store.snapshot().observations).toHaveLength(2);
});
it('rejects altered, foreign and malformed signed stores without replacing their bytes', () => {
  const owner = generateKeyPair(), peer = generateKeyPair(), store = new ProtocolPeerStore(owner, options());
  store.observe(peer.did, peer.did, [card(peer, ['0.2.0'])]);
  const valid = JSON.parse(fs.readFileSync(store.path, 'utf8'));
  const modified = structuredClone(valid); modified.payload.observations[0].highestVersion = '0.1.0';
  const duplicate = { ...valid.payload, observations: [...valid.payload.observations, ...valid.payload.observations] };
  for (const invalid of [modified, signPayload(valid.payload, peer), {},
    signPayload(duplicate, owner), signPayload({ ...valid.payload, maximumObservedPhase: 1 }, owner),
    signPayload({ ...valid.payload, observations: [{ ...valid.payload.observations[0], highestVersion: '9.0.0' }] }, owner)]) {
    const bytes = JSON.stringify(invalid); fs.writeFileSync(store.path, bytes);
    expect(() => store.floor(peer.did, peer.did)).toThrow('PROTOCOL_STORE_INVALID');
    expect(() => store.observe(peer.did, peer.did, [card(peer)])).toThrow('PROTOCOL_STORE_INVALID');
    expect(fs.readFileSync(store.path, 'utf8')).toBe(bytes);
  }
});
it('checks private file and directory modes and rejects non-file data', () => {
  const owner = generateKeyPair(), store = new ProtocolPeerStore(owner, options()); store.observePolicy(policy);
  if (process.platform !== 'win32') {
    fs.chmodSync(store.path, 0o644); expect(() => store.snapshot()).toThrow('PROTOCOL_STORE_INVALID'); fs.chmodSync(store.path, 0o600);
    fs.chmodSync(dirname(store.path), 0o755); expect(() => store.snapshot()).toThrow('PROTOCOL_STORE_INVALID'); fs.chmodSync(dirname(store.path), 0o700);
  }
  fs.unlinkSync(store.path); fs.mkdirSync(store.path, { mode: 0o700 });
  expect(() => store.snapshot()).toThrow('PROTOCOL_STORE_INVALID');
});
it('retains established observations when the store reaches its entry or byte bounds', () => {
  const owner = generateKeyPair(), peer = generateKeyPair(), store = new ProtocolPeerStore(owner, options());
  const entry = store.observe(peer.did, peer.did, [card(peer, ['0.2.0'])])!;
  const dids = Array.from({ length: 32 }, () => generateKeyPair().did);
  const observations = Array.from({ length: 1000 }, (_, index) => ({ ...entry,
    ownerDid: dids[Math.floor(index / 32)], agentDid: dids[index % 32] }));
  const state = { version: 1, localOwnerDid: owner.did, observations };
  const bytes = JSON.stringify(signPayload(state, owner, new Date(clock).toISOString()));
  fs.writeFileSync(store.path, bytes);
  expect(() => store.observe(peer.did, peer.did, [card(peer)])).toThrow('PROTOCOL_STORE_UNWRITABLE');
  expect(fs.readFileSync(store.path, 'utf8')).toBe(bytes);
  expect(store.floor(dids[0], dids[0])).toBe('0.2.0');
  fs.writeFileSync(store.path, Buffer.alloc(1024 * 1024 + 1, 32));
  expect(() => store.snapshot()).toThrow('PROTOCOL_STORE_INVALID');
  expect(fs.statSync(store.path).size).toBe(1024 * 1024 + 1);
});
