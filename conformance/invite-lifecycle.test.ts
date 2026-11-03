// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInviteToken, createSignedAgentCard, generateKeyPair, signPayload } from '../packages/core/src/index.js';
import { InviteStore } from '../packages/runtime/src/invite-store.js';
import type { InviteStoreOptions } from '../packages/runtime/src/invite-store.js';
import type { SecretStore } from '../packages/runtime/src/secret-store.js';
import { AcpMcpServer, resolveStoredIdentity, WorkerTrustStore, workerIntakePath } from '../packages/runtime/src/index.js';
import { connectionsCommand } from '../cli/src/connections.js';
import { acceptCommand } from '../cli/src/accept.js';

const NOW = Date.parse('2026-11-01T00:00:00.000Z');
const pending = { pendingConfirmation: true };
let root: string, now: number, options: InviteStoreOptions, secrets: Map<string, string>, secretStore: SecretStore;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'sealbridge-invite-lifecycle-'));
  now = NOW;
  secrets = new Map();
  secretStore = { get: vi.fn(id => secrets.get(id)), set: vi.fn((id, value) => { secrets.set(id, value); }),
    delete: vi.fn(id => { secrets.delete(id); }) };
  options = { home: root, env: { SEALBRIDGE_DATA_DIR: join(root, 'data') }, now: () => now, secretStore };
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network call'); }));
});
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});
function invitation() {
  const remote = generateKeyPair();
  const card = createSignedAgentCard({ name: 'Reviewer', agentDid: remote.did,
    relayEndpoint: 'https://relay.example', skills: [], expiresAt: new Date(NOW + 86400000).toISOString() }, remote);
  return createInviteToken({ agentCard: card, expiresInSeconds: 86400 }, remote);
}
const cutoff = () => ({ olderThan: new Date(now).toISOString() });

it('keeps default saves and legacy entries outside cleanup without changing duplicate bytes', () => {
  const owner = generateKeyPair(), store = new InviteStore(owner, options), token = invitation();
  const saved = store.import(token, 'saved'), bytes = fs.readFileSync(store.path);
  expect(store.import(token, 'saved', pending)).toEqual(saved);
  expect(fs.readFileSync(store.path).equals(bytes)).toBe(true);
  now++;
  expect(store.listUnconfirmed()).toEqual([]);
  expect(store.removeUnconfirmed(cutoff())).toEqual({ removed: 0 });
  expect(fs.readFileSync(store.path).equals(bytes)).toBe(true);
  expect(store.resolve('saved').inviteToken === token).toBe(true);
});

it.each(['inline', 'external'] as const)('recovers unconfirmed %s imports after restart and uses a strict cutoff', backend => {
  const selected = backend === 'inline' ? { ...options, secretStore: undefined } : options;
  const owner = generateKeyPair(), store = new InviteStore(owner, selected), token = invitation();
  const saved = store.import(token, 'pending', pending);
  expect(saved.importState).toBe('unconfirmed');
  expect(store.removeUnconfirmed(cutoff())).toEqual({ removed: 0 });
  now++;
  const recent = store.import(invitation(), 'recent', pending);
  const restart = new InviteStore(owner, selected);
  expect(restart.listUnconfirmed()).toEqual([saved, recent]);
  expect(restart.removeUnconfirmed(cutoff())).toEqual({ removed: 1 });
  expect(restart.list()).toEqual([recent]);
  expect(restart.remove(saved.workerRef)).toBe(false);
  if (backend === 'external') {
    expect(secrets.size).toBe(1);
    expect(fs.readFileSync(store.path, 'utf8').includes('acp-invite:')).toBe(false);
  }
  expect(JSON.stringify([saved, restart.listUnconfirmed()]).includes(token)).toBe(false);
  if (process.platform !== 'win32') {
    expect(fs.statSync(store.path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dirname(store.path)).mode & 0o777).toBe(0o700);
  }
});

it('requires explicit retention before resolution and never demotes a retained or used import', () => {
  const owner = generateKeyPair(), store = new InviteStore(owner, options), token = invitation();
  const saved = store.import(token, 'pending', pending);
  expect(() => store.resolve(saved.workerRef)).toThrow('INVITE_CONFIRMATION_REQUIRED');
  expect(store.listUnconfirmed()).toEqual([saved]);
  const retained = store.retain(saved.workerRef);
  expect(retained.importState).toBeUndefined();
  expect(store.resolve(saved.workerRef).inviteToken === token).toBe(true);
  const bytes = fs.readFileSync(store.path);
  expect(store.retain('pending')).toEqual(retained);
  expect(store.import(token, 'pending', pending)).toEqual(retained);
  now++;
  expect(new InviteStore(owner, options).removeUnconfirmed(cutoff())).toEqual({ removed: 0 });
  expect(fs.readFileSync(store.path).equals(bytes)).toBe(true);
  expect(() => store.retain('absent')).toThrow('INVITE_NOT_FOUND');
});

it('treats a normal duplicate import as an explicit save without changing its original import time', () => {
  const store = new InviteStore(generateKeyPair(), options), token = invitation();
  const saved = store.import(token, 'pending', pending);
  now++;
  expect(() => store.import(token, 'other')).toThrow('ALIAS_EXISTS');
  expect(store.listUnconfirmed()).toEqual([saved]);
  const retained = store.import(token, 'pending');
  expect(retained.importState).toBeUndefined();
  expect(retained.importedAt).toBe(saved.importedAt);
  expect(store.listUnconfirmed()).toEqual([]);
});

it.each(['delete', 'readback'] as const)('keeps removal retryable after secret %s failure without returning backend details', stage => {
  const owner = generateKeyPair(), store = new InviteStore(owner, options), token = invitation();
  const saved = store.import(token), bytes = fs.readFileSync(store.path);
  vi.mocked(secretStore.delete).mockImplementation(() => {
    expect(fs.existsSync(store.path + '.lock')).toBe(true);
    if (stage === 'delete') throw new Error(token);
  });
  expect(() => store.remove(saved.workerRef)).toThrow(/^INVITE_SECRET_DELETE_FAILED$/);
  expect(fs.readFileSync(store.path).equals(bytes)).toBe(true);
  expect(store.list()).toEqual([saved]);
  vi.mocked(secretStore.delete).mockImplementation(id => { secrets.delete(id); });
  expect(new InviteStore(owner, options).remove(saved.workerRef)).toBe(true);
  expect(store.remove(saved.workerRef)).toBe(false);
  expect(secrets.size).toBe(0);
});

it('retries removal after secret deletion succeeded but metadata publication failed', () => {
  const owner = generateKeyPair(), store = new InviteStore(owner, options), saved = store.import(invitation());
  const bytes = fs.readFileSync(store.path);
  const failing = new InviteStore(owner, { ...options, fs: { ...fs, renameSync: () => { throw new Error('publish detail'); } } });
  expect(() => failing.remove(saved.alias)).toThrow('INVITE_STORE_INVALID');
  expect(secrets.size).toBe(0);
  expect(fs.readFileSync(store.path).equals(bytes)).toBe(true);
  expect(fs.readdirSync(dirname(store.path))).toEqual([basename(store.path)]);
  expect(() => store.resolve(saved.alias)).toThrow('INVITE_SECRET_MISSING');
  expect(new InviteStore(owner, options).remove(saved.workerRef)).toBe(true);
  expect(store.list()).toEqual([]);
});

it('retries partially completed cleanup using token-free pending metadata', () => {
  const owner = generateKeyPair(), store = new InviteStore(owner, options);
  const first = store.import(invitation(), 'first', pending), second = store.import(invitation(), 'second', pending);
  const bytes = fs.readFileSync(store.path);
  now++;
  vi.mocked(secretStore.delete).mockImplementationOnce(id => { secrets.delete(id); })
    .mockImplementationOnce(() => { throw new Error('backend detail'); });
  expect(() => store.removeUnconfirmed(cutoff())).toThrow(/^INVITE_SECRET_DELETE_FAILED$/);
  expect(secrets.size).toBe(1);
  expect(fs.readFileSync(store.path).equals(bytes)).toBe(true);
  expect(new InviteStore(owner, options).listUnconfirmed()).toEqual([first, second]);
  expect(store.removeUnconfirmed(cutoff())).toEqual({ removed: 2 });
  expect(store.removeUnconfirmed(cutoff())).toEqual({ removed: 0 });
  expect(secrets.size).toBe(0);
});

it('serializes cleanup with retention and resolution before returning any token', () => {
  const owner = generateKeyPair(), store = new InviteStore(owner, options), saved = store.import(invitation(), 'pending', pending);
  const other = new InviteStore(owner, options);
  now++;
  vi.mocked(secretStore.delete).mockImplementation(id => {
    expect(() => other.retain(saved.workerRef)).toThrow('INVITE_STORE_BUSY');
    expect(() => other.resolve(saved.workerRef)).toThrow('INVITE_CONFIRMATION_REQUIRED');
    secrets.delete(id);
  });
  expect(store.removeUnconfirmed(cutoff())).toEqual({ removed: 1 });
  expect(() => other.resolve(saved.workerRef)).toThrow('INVITE_NOT_FOUND');
});

it('retains pending state if retention publication fails, and adds no writes when resolving ordinary saves', () => {
  const owner = generateKeyPair(), store = new InviteStore(owner, options), saved = store.import(invitation(), 'pending', pending);
  const failing = new InviteStore(owner, { ...options, fs: { ...fs, renameSync: () => { throw new Error('publish detail'); } } });
  expect(() => failing.retain(saved.workerRef)).toThrow('INVITE_STORE_INVALID');
  expect(store.listUnconfirmed()).toEqual([saved]);
  store.retain(saved.workerRef);
  const flush = vi.fn(() => { throw new Error('unexpected flush'); });
  const readOnly = new InviteStore(owner, { ...options, fs: { ...fs, fsyncSync: flush } });
  expect(readOnly.resolve(saved.workerRef).inviteToken.startsWith('acp-invite:')).toBe(true);
  expect(flush).not.toHaveBeenCalled();
});

it('preserves pending provenance through explicit keychain migration', () => {
  const owner = generateKeyPair(), inline = new InviteStore(owner, { ...options, secretStore: undefined });
  const saved = inline.import(invitation(), 'pending', pending);
  const store = new InviteStore(owner, options);
  expect(store.migrateToKeychain()).toEqual({ count: 1, dryRun: false });
  expect(store.listUnconfirmed()).toEqual([saved]);
  now++;
  expect(store.removeUnconfirmed(cutoff())).toEqual({ removed: 1 });
  expect(secrets.size).toBe(0);
});

it('rejects unknown provenance and invalid cleanup cutoffs without changing stored bytes', () => {
  const owner = generateKeyPair(), store = new InviteStore(owner, options);
  store.import(invitation(), 'pending', pending);
  const bytes = fs.readFileSync(store.path);
  for (const olderThan of ['invalid', new Date(NOW + 1).toISOString()]) {
    expect(() => store.removeUnconfirmed({ olderThan })).toThrow('INVITE_CLEANUP_INVALID_CUTOFF');
    expect(fs.readFileSync(store.path).equals(bytes)).toBe(true);
  }
  const signed = JSON.parse(bytes.toString());
  signed.payload.entries[0].importState = 'other';
  fs.writeFileSync(store.path, JSON.stringify(signPayload(signed.payload, owner)), { mode: 0o600 });
  expect(() => store.listUnconfirmed()).toThrow('INVITE_STORE_INVALID');
  expect(() => store.removeUnconfirmed(cutoff())).toThrow('INVITE_STORE_INVALID');
});

it.each([true, false])('retains imports before a CLI connection attempt while keeping owner approval explicit (%s)', async approved => {
  const owner = await resolveStoredIdentity('requester', options), store = new InviteStore(owner, options);
  const token = invitation(), saved = store.import(token, 'pending', pending);
  const trust = new WorkerTrustStore(owner, { path: workerIntakePath(owner.did, options), now: () => now });
  const review = vi.fn(async () => {
    expect(store.listUnconfirmed()).toEqual([]);
    expect(trust.connectionState(saved.ownerDid)).toBe('none');
    return approved;
  });
  const send = vi.fn(async () => {
    expect(trust.connectionState(saved.ownerDid)).toBe('pending');
    expect(store.listUnconfirmed()).toEqual([]);
  }), output = vi.fn();
  const attempt = connectionsCommand(['confirm-invite', saved.workerRef], {
    identityOptions: options, now: () => now, review, output,
    transportFactory: () => ({ send, receive: vi.fn() }),
  });
  if (approved) await attempt;
  else await expect(attempt).rejects.toThrow('APPROVAL_REJECTED');
  expect(review).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledTimes(approved ? 1 : 0);
  now++;
  expect(new InviteStore(owner, options).removeUnconfirmed(cutoff())).toEqual({ removed: 0 });
  expect(JSON.stringify(output.mock.calls).includes(token)).toBe(false);
});

it('keeps pending imports out of MCP delegation until retained and supports retry through existing removal tools', async () => {
  const owner = await resolveStoredIdentity('requester', options), store = new InviteStore(owner, options);
  const token = invitation(), saved = store.import(token, 'pending', pending);
  const server = new AcpMcpServer({ owner, identityOptions: options, now: () => now });
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'acp_delegate_task', arguments: { workerRef: saved.workerRef, title: 'Review', input: {} },
  } });
  expect(JSON.stringify(response)).toContain('INVITE_CONFIRMATION_REQUIRED');
  expect(JSON.stringify(response).includes(token)).toBe(false);
  expect(store.listUnconfirmed()).toEqual([saved]);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.mocked(secretStore.delete).mockImplementationOnce(() => { throw new Error(token); });
  await expect(acceptCommand('invites', ['remove', saved.workerRef], options)).rejects.toThrow(/^INVITE_SECRET_DELETE_FAILED$/);
  expect(store.listUnconfirmed()).toEqual([saved]);
  const removed = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'acp_remove_invite', arguments: { workerRef: saved.workerRef },
  } });
  expect(JSON.stringify(removed)).toContain('removed');
  expect(store.list()).toEqual([]);
  expect(secrets.size).toBe(0);
  await acceptCommand('invites', ['remove', saved.workerRef], options);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({ removed: false });
  expect(JSON.stringify([log.mock.calls, removed]).includes(token)).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
