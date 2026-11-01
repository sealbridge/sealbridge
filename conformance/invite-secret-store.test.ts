// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInviteToken, createSignedAgentCard, digest, digestBytes, generateKeyPair,
  parseAndVerifyInviteToken, signApproval, signPayload } from '../packages/core/src/index.js';
import { AcpMcpServer, InviteStore, KeychainSecretStore, WorkerNode, keychainService,
  RequesterPendingStore, buildTaskManifest, resolveStoredIdentity } from '../packages/runtime/src/index.js';
import type { InviteStoreOptions, KeyringModule, SecretStore } from '../packages/runtime/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { acceptCommand } from '../cli/src/accept.js';
import { invitesMigrateCommand } from '../cli/src/invites-migrate.js';
import { pendingCommand } from '../cli/src/pending.js';

const NOW = Date.parse('2026-11-01T00:00:00.000Z');
let home: string, options: InviteStoreOptions;
let secrets: Map<string, string>, loader: Mock<() => Promise<KeyringModule>>, module: KeyringModule;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  home = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'sealbridge-invite-secret-'));
  secrets = new Map();
  module = { Entry: class {
    readonly id: string;
    constructor(service: string, account: string) { this.id = service + '/' + account; }
    getPassword() { return secrets.get(this.id) ?? null; }
    setPassword(value: string) { secrets.set(this.id, value); }
    deletePassword() { return secrets.delete(this.id); }
  } };
  loader = vi.fn(async () => module);
  options = { home, env: { SEALBRIDGE_DATA_DIR: join(home, 'data') }, keyringLoader: loader };
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network call'); }));
});
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  fs.rmSync(home, { recursive: true, force: true });
});
function invitation() {
  const owner = generateKeyPair();
  const card = createSignedAgentCard({ name: 'Reviewer', agentDid: owner.did,
    relayEndpoint: 'https://relay.example', skills: [] }, owner);
  return createInviteToken({ agentCard: card, expiresInSeconds: 3600 }, owner);
}
function configure() {
  fs.mkdirSync(join(home, 'data'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(home, 'data', 'config.json'), JSON.stringify({ version: 1, relays: ['https://relay.example'], keyStore: 'keychain' }), { mode: 0o600 });
}
function raw(store: InviteStore) { return JSON.parse(fs.readFileSync(store.path, 'utf8')); }
function account(saved: { workerRef: string }) { return keychainService(options) + '/invite:' + saved.workerRef.slice(6); }
async function call(server: AcpMcpServer, name: string, args: Record<string, unknown> = {}) {
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name, arguments: args } }) as any;
  return { error: response.result.isError, value: JSON.parse(response.result.content[0].text) };
}

describe('imported invitation string storage', () => {
  it('retains the original signed file bytes and synchronous API under file selection', async () => {
    const owner = generateKeyPair(), token = invitation(), invite = parseAndVerifyInviteToken(token);
    const store = await InviteStore.open(owner, options), saved = store.import(token, 'reviewer');
    const inviteDigest = digest(invite), importedAt = new Date(NOW).toISOString();
    const entry = { id: digest({ localOwnerDid: owner.did, inviteDigest }).slice(7), alias: 'reviewer',
      displayName: invite.agentCard.payload.name, ownerDid: invite.ownerDid, agentDid: invite.agentDid,
      relayUrl: invite.relayUrl, inviteToken: token, inviteDigest, importedAt,
      effectiveExpiresAt: new Date(Math.min(Date.parse(invite.expiresAt), Date.parse(invite.agentCard.payload.expiresAt))).toISOString() };
    const expected = JSON.stringify(signPayload({ type: 'StoredInvites', version: 1,
      localOwnerDid: owner.did, entries: [entry] }, owner, importedAt)) + '\n';
    expect(fs.readFileSync(store.path, 'utf8') === expected).toBe(true);
    expect((await InviteStore.open(owner, options)).list()).toEqual([saved]);
    const bytes = fs.readFileSync(store.path);
    expect(store.import(token, 'reviewer')).toEqual(saved);
    expect(fs.readFileSync(store.path).equals(bytes)).toBe(true);
    expect(new InviteStore(owner, options).resolve('reviewer').inviteToken === token).toBe(true);
    expect(loader).not.toHaveBeenCalled(); expect(secrets.size).toBe(0);
  });

  it('uses config selection for CLI import, MCP reference delegation, restart and removal', async () => {
    configure();
    const relay = new InMemoryRelay(), workerOwner = generateKeyPair();
    const local = await resolveStoredIdentity('requester', options);
    const approve = (owner: typeof local) => ({ approve: vi.fn(async r =>
      signApproval(r.taskId, r.gate, r.target, owner, 'APPROVED')) });
    const worker = new WorkerNode({ owner: workerOwner, relay, relayUrl: 'https://relay.example',
      adapter: { id: 'echo', name: 'Echo', skills: [], executeTask: async ctx => ctx.input },
      approvalProvider: approve(workerOwner) });
    const token = worker.invite(), log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const server = new AcpMcpServer({ identityOptions: options, relay, approvalProvider: approve(local) });
    await acceptCommand('accept', [token, '--alias', 'reviewer'], options);
    const saved = JSON.parse(log.mock.calls.at(-1)![0]);
    const store = await InviteStore.open(local, options), metadata = raw(store).payload.entries[0];
    expect(metadata.inviteToken).toBeUndefined();
    expect(metadata.inviteSecret).toBe('invite:' + saved.workerRef.slice(6));
    expect(metadata.tokenDigest).toBe(digestBytes(token));
    expect(fs.readFileSync(store.path, 'utf8').includes(token)).toBe(false);
    expect(secrets.get(account(saved)) === token).toBe(true);
    expect(fs.existsSync(join(home, 'data', 'identities'))).toBe(false);
    const listed = await call(server, 'acp_list_invites');
    expect(listed).toEqual({ error: false, value: { count: 1, invites: [saved] } });
    expect(JSON.stringify(listed).includes(token)).toBe(false);
    const pending = worker.start();
    try {
      const result = await call(server, 'acp_delegate_task', { workerRef: 'reviewer', title: 'Echo', input: { echo: true }, taskTimeoutMs: 5000 });
      expect(result).toMatchObject({ error: false, value: { status: 'SETTLED', deliverable: { echo: true }, auditBundle: { valid: true } } });
      expect(JSON.stringify(result).includes(token)).toBe(false);
      const retained = new RequesterPendingStore(local, options);
      const manifest = buildTaskManifest({ ownerDid: local.did, workerDid: workerOwner.did,
        title: 'Echo', description: 'Return JSON' });
      const pendingId = retained.save({ workerRef: 'reviewer', relayUrl: 'https://relay.example',
        manifest, input: { echo: true }, timeouts: { taskTimeoutMs: 5000 } });
      await pendingCommand(['resubmit', pendingId, '--auto-approve'], { identityOptions: options,
        transportFactory: () => relay });
      expect(retained.list()[0].state).toBe('resolved');
      expect(fs.readFileSync(retained.path, 'utf8').includes(token)).toBe(false);
      const restart = new AcpMcpServer({ identityOptions: options, relay });
      expect(await call(restart, 'acp_list_invites')).toEqual(listed);
      expect(await call(restart, 'acp_remove_invite', { workerRef: saved.workerRef }))
        .toEqual({ error: false, value: { removed: true } });
      expect(secrets.has(account(saved))).toBe(false);
      expect((await InviteStore.open(local, options)).list()).toEqual([]);
    } finally { worker.stop(); await pending; }
  });

  it('resolves persisted references after switching back to file selection and supports injection', async () => {
    const owner = generateKeyPair(), token = invitation();
    const embedded: SecretStore = { get: vi.fn(id => secrets.get(id)),
      set: vi.fn((id, value) => { secrets.set(id, value); }), delete: vi.fn(id => { secrets.delete(id); }) };
    const store = new InviteStore(owner, { ...options, secretStore: embedded });
    const saved = store.import(token);
    expect(store.resolve(saved.workerRef).inviteToken === token).toBe(true);
    expect(new InviteStore(owner, { ...options, secretStore: embedded }).list()).toEqual([saved]);
    expect(store.remove(saved.workerRef)).toBe(true);
    expect(embedded.delete).toHaveBeenCalledOnce();
    const keychain = await InviteStore.open(owner, { ...options, keyStore: 'keychain' });
    keychain.import(token);
    expect((await InviteStore.open(owner, options)).resolve(saved.workerRef).inviteToken === token).toBe(true);
    const mcp = new AcpMcpServer({ owner, identityOptions: { ...options, secretStore: new KeychainSecretStore(module, options) } });
    expect((await call(mcp, 'acp_list_invites')).value.count).toBe(1);
  });

  it('reads mixed inline and referenced entries without automatically changing legacy bytes', async () => {
    const owner = generateKeyPair(), first = invitation(), second = invitation();
    const file = new InviteStore(owner, options), legacy = file.import(first, 'legacy');
    const before = fs.readFileSync(file.path);
    const keychain = await InviteStore.open(owner, { ...options, keyStore: 'keychain' });
    expect(keychain.import(first, 'legacy')).toEqual(legacy);
    expect(fs.readFileSync(file.path).equals(before)).toBe(true);
    const saved = keychain.import(second, 'external');
    expect(raw(keychain).payload.entries[0].inviteToken === first).toBe(true);
    expect(raw(keychain).payload.entries[1].inviteToken).toBeUndefined();
    expect(keychain.list()).toEqual([legacy, saved]);
    expect((await InviteStore.open(owner, options)).list()).toEqual([legacy, saved]);
    expect(keychain.resolve('legacy').inviteToken === first).toBe(true);
    const third = invitation(), selectedFile = await InviteStore.open(owner, options);
    selectedFile.import(third, 'file-again');
    expect(raw(selectedFile).payload.entries[2].inviteToken === third).toBe(true);
    expect([...secrets.keys()]).toEqual([account(saved)]);
  });

  it('separates invitation accounts by local owner and data root', async () => {
    const owner = generateKeyPair(), otherOwner = generateKeyPair(), token = invitation();
    const selected = { ...options, keyStore: 'keychain' as const };
    const first = (await InviteStore.open(owner, selected)).import(token);
    const second = (await InviteStore.open(otherOwner, selected)).import(token);
    expect(first.workerRef).not.toBe(second.workerRef);
    const otherRoot = { ...selected, env: { SEALBRIDGE_DATA_DIR: join(home, 'other') } };
    expect((await InviteStore.open(owner, otherRoot)).list()).toEqual([]);
    (await InviteStore.open(owner, otherRoot)).import(token);
    expect(secrets.size).toBe(3);
    expect(secrets.has(keychainService(otherRoot) + '/invite:' + first.workerRef.slice(6))).toBe(true);
    expect([...secrets.keys()].every(id => /\/invite:[a-f0-9]{64}$/.test(id))).toBe(true);
  });

  it.each(['signature', 'metadata', 'reference', 'extra'] as const)('validates signed reference %s before returning tokens', async stage => {
    const owner = generateKeyPair(), store = await InviteStore.open(owner, { ...options, keyStore: 'keychain' });
    store.import(invitation());
    const signed = raw(store);
    if (stage === 'signature') signed.payload.version = 2;
    if (stage === 'metadata') signed.payload.entries[0].displayName = 'Different';
    if (stage === 'reference') signed.payload.entries[0].inviteSecret = 'requester';
    if (stage === 'extra') signed.payload.entries[0].extra = 'field';
    fs.writeFileSync(store.path, JSON.stringify(stage === 'signature' ? signed : signPayload(signed.payload, owner)));
    expect(() => store.list()).toThrow('INVITE_STORE_INVALID');
  });

  it.each(['missing', 'mismatch', 'read'] as const)('reports %s referenced strings without rewriting metadata', async stage => {
    const owner = generateKeyPair(), store = await InviteStore.open(owner, { ...options, keyStore: 'keychain' });
    const saved = store.import(invitation()), before = fs.readFileSync(store.path);
    const id = account(saved);
    if (stage === 'missing') secrets.delete(id);
    if (stage === 'mismatch') secrets.set(id, 'different value');
    if (stage === 'read') vi.spyOn(module.Entry.prototype, 'getPassword').mockImplementation(() => { throw new Error('native detail'); });
    const error = stage === 'missing' ? 'INVITE_SECRET_MISSING' : stage === 'mismatch' ? 'INVITE_SECRET_MISMATCH' : 'KEY_STORE_UNAVAILABLE';
    expect(() => store.list()).toThrow(error);
    expect(() => store.resolve(saved.workerRef)).toThrow(error);
    expect(fs.readFileSync(store.path).equals(before)).toBe(true);
    if (stage === 'missing') expect(store.remove(saved.workerRef)).toBe(true);
  });

  it.each(['loader', 'constructor', 'read', 'write', 'readback'] as const)('retains file state on keychain %s failure with no inline fallback', async stage => {
    const owner = generateKeyPair(), token = invitation();
    const file = new InviteStore(owner, options); file.import(invitation(), 'legacy');
    const before = fs.readFileSync(file.path);
    const broken: KeyringModule = { Entry: class {
      constructor() { if (stage === 'constructor') throw new Error('native detail'); }
      getPassword(): string | null { if (stage === 'read') throw new Error('native detail'); return null; }
      setPassword() { if (stage === 'write') throw new Error('native detail'); }
    } };
    const selected = { ...options, keyStore: 'keychain' as const,
      keyringLoader: async () => { if (stage === 'loader') throw new Error('native detail'); return broken; } };
    const action = async () => (await InviteStore.open(owner, selected)).import(token);
    await expect(action()).rejects.toThrow(stage === 'readback' ? 'INVITE_SECRET_MISMATCH' : 'KEY_STORE_UNAVAILABLE');
    expect(fs.readFileSync(file.path).equals(before)).toBe(true);
    expect(fs.readdirSync(dirname(file.path))).toEqual([file.path.split('/').at(-1)]);
  });

  it('reports cleanup failure after metadata removal and retains the lock through cleanup', async () => {
    const owner = generateKeyPair(), store = await InviteStore.open(owner, { ...options, keyStore: 'keychain' });
    const saved = store.import(invitation());
    vi.spyOn(module.Entry.prototype, 'deletePassword').mockImplementation(() => {
      expect(fs.existsSync(store.path + '.lock')).toBe(true);
      expect(() => store.import(invitation())).toThrow('INVITE_STORE_BUSY');
      throw new Error('native detail');
    });
    expect(() => store.remove(saved.workerRef)).toThrow('INVITE_SECRET_DELETE_FAILED');
    expect(store.list()).toEqual([]); expect(secrets.has(account(saved))).toBe(true);
    expect(fs.existsSync(store.path + '.lock')).toBe(false);
  });
});

describe('explicit invitation migration', () => {
  it('supports CLI dry run, apply and repeated apply while keeping the requester file unchanged', async () => {
    const local = await resolveStoredIdentity('requester', { ...options, keyStore: 'file' });
    const file = new InviteStore(local, options), token = invitation(), saved = file.import(token, 'reviewer');
    const before = fs.readFileSync(file.path);
    const identity = join(home, 'data', 'identities', 'requester.private.json');
    const keyBefore = fs.readFileSync(identity);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await invitesMigrateCommand(['--to', 'keychain', '--dry-run'], options);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({ count: 1, dryRun: true });
    expect(fs.readFileSync(file.path).equals(before)).toBe(true); expect(secrets.size).toBe(0);
    await invitesMigrateCommand(['--to', 'keychain'], options);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({ count: 1, dryRun: false });
    expect(raw(file).payload.entries[0].inviteToken).toBeUndefined();
    expect(secrets.get(account(saved)) === token).toBe(true);
    const opened = await InviteStore.open(local, options);
    expect(opened.list()).toEqual([saved]); expect(opened.resolve('reviewer').inviteToken === token).toBe(true);
    expect(fs.readFileSync(identity).equals(keyBefore)).toBe(true);
    const migrated = fs.readFileSync(file.path);
    await invitesMigrateCommand(['--to', 'keychain'], options);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({ count: 0, dryRun: false });
    expect(fs.readFileSync(file.path).equals(migrated)).toBe(true);
  });

  it.each(['write', 'readback', 'conflict', 'publish'] as const)('retains original bytes when migration fails at %s', async stage => {
    const owner = generateKeyPair(), file = new InviteStore(owner, options);
    const first = file.import(invitation(), 'first'), second = file.import(invitation(), 'second');
    const before = fs.readFileSync(file.path);
    const store = await InviteStore.open(owner, { ...options, keyStore: 'keychain',
      fs: stage === 'publish' ? { ...fs, renameSync: () => { throw new Error('filesystem detail'); } } : fs });
    if (stage === 'write') vi.spyOn(module.Entry.prototype as { setPassword(value: string): void }, 'setPassword').mockImplementation(function (this: { id: string }, value: string) {
      if (this.id === account(second)) throw new Error('native detail');
      secrets.set(this.id, value);
    });
    if (stage === 'readback') vi.spyOn(module.Entry.prototype, 'setPassword').mockImplementation(() => {});
    if (stage === 'conflict') secrets.set(account(first), 'different value');
    const expected = { write: 'KEY_STORE_UNAVAILABLE', readback: 'INVITE_SECRET_MISMATCH',
      conflict: 'INVITE_SECRET_CONFLICT', publish: 'INVITE_STORE_INVALID' }[stage];
    expect(() => store.migrateToKeychain()).toThrow(expected);
    expect(fs.readFileSync(file.path).equals(before)).toBe(true); expect(file.list()).toHaveLength(2);
    expect(fs.existsSync(file.path + '.lock')).toBe(false);
  });

  it('preserves an existing lock and leaves the keychain untouched during contention', async () => {
    const owner = generateKeyPair(), file = new InviteStore(owner, options); file.import(invitation());
    const before = fs.readFileSync(file.path);
    fs.writeFileSync(file.path + '.lock', 'writer', { mode: 0o600 });
    const store = await InviteStore.open(owner, { ...options, keyStore: 'keychain' });
    expect(() => store.migrateToKeychain()).toThrow('INVITE_STORE_BUSY');
    expect(fs.readFileSync(file.path).equals(before)).toBe(true);
    expect(fs.readFileSync(file.path + '.lock', 'utf8')).toBe('writer'); expect(secrets.size).toBe(0);
  });
});
