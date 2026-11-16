import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import dns from 'node:dns/promises';
import { createInviteToken, createSignedAgentCard, digestBytes, generateKeyPair, signPayload } from '../packages/core/src/index.js';
import type { Invite, Signed } from '../packages/core/src/index.js';
import { InviteStore } from '../packages/runtime/src/invite-store.js';
import type { InviteStoreOptions } from '../packages/runtime/src/invite-store.js';
import { inspectLocalIdentity, resolveOrCreateIdentity } from '../packages/runtime/src/local-identity.js';
import { addContact, loadContacts } from '../cli/src/contacts.js';
import { acceptCommand } from '../cli/src/accept.js';

const NOW = Date.parse('2026-11-01T00:00:00.000Z');
let home: string, options: InviteStoreOptions, now: number;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  home = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'sealbridge-invites-'));
  now = NOW;
  options = { home, env: { SEALBRIDGE_DATA_DIR: join(home, 'data') }, now: () => now };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });
function fixture(name = 'Example Worker', relayEndpoint = 'https://relay.example', ttl = 60, cardTtl = 120) {
  const owner = generateKeyPair(), agent = generateKeyPair();
  const card = createSignedAgentCard({ name, agentDid: agent.did, relayEndpoint,
    expiresAt: new Date(NOW + cardTtl * 1000).toISOString(), skills: [] }, owner, agent);
  const token = createInviteToken({ agentCard: card, expiresInSeconds: ttl }, owner);
  return { token, owner, agent };
}
const pack = (signed: unknown) => 'acp-invite:' + Buffer.from(JSON.stringify(signed)).toString('base64url');

describe('local invitation store', () => {
  it.skipIf(process.platform === 'win32').each(['/var', '/tmp'])('shares Darwin %s alias handling with default identities', alias => {
    const virtualHome = alias + '/folders/sealbridge-invites';
    const realPath = (path: fs.PathLike) => String(path).startsWith(virtualHome)
      ? home + String(path).slice(virtualHome.length) : String(path);
    const directory = fs.lstatSync(home);
    const io = { ...fs,
      lstatSync: ((path: fs.PathLike) => String(path) === alias
        ? { ...directory, uid: 0, isSymbolicLink: () => true }
        : String(path).startsWith(virtualHome) ? fs.lstatSync(realPath(path)) : directory) as typeof fs.lstatSync,
      readlinkSync: (() => '/private' + alias) as unknown as typeof fs.readlinkSync,
      openSync: ((path, flags, mode) => fs.openSync(realPath(path), flags, mode)) as typeof fs.openSync,
      mkdirSync: ((path, opts) => fs.mkdirSync(realPath(path), opts)) as typeof fs.mkdirSync,
      linkSync: (from, to) => fs.linkSync(realPath(from), realPath(to)),
      renameSync: (from, to) => fs.renameSync(realPath(from), realPath(to)),
      unlinkSync: path => fs.unlinkSync(realPath(path)),
    } satisfies typeof fs;
    const selected: InviteStoreOptions = { ...options, home: virtualHome, platform: 'darwin',
      env: { SEALBRIDGE_DATA_DIR: virtualHome + '/data' }, fs: io };
    const owner = resolveOrCreateIdentity('requester', selected);
    expect(inspectLocalIdentity('requester', selected).key).toEqual(owner);
    const store = new InviteStore(owner, selected), { token } = fixture();
    expect(store.list()).toEqual([]);
    const saved = store.import(token, 'reviewer');
    expect(new InviteStore(owner, selected).list()).toEqual([saved]);
    expect(store.resolve('reviewer').inviteToken).toBe(token);
    expect(store.remove('reviewer')).toBe(true);
    expect(store.list()).toEqual([]);
    expect(() => new InviteStore(owner, { ...selected, platform: 'linux' }).list()).toThrow('INVITE_STORE_INVALID');
    const untrusted = { ...io, readlinkSync: (() => '/elsewhere') as unknown as typeof io.readlinkSync };
    expect(() => new InviteStore(owner, { ...selected, fs: untrusted }).import(token)).toThrow('INVITE_STORE_INVALID');
  });
  it('imports all core link formats idempotently, persists signed bindings, and never fetches or resolves DNS', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('UNEXPECTED_FETCH'));
    const lookup = vi.spyOn(dns, 'lookup').mockRejectedValue(new Error('UNEXPECTED_DNS'));
    const local = generateKeyPair(), { token, owner, agent } = fixture();
    const store = new InviteStore(local, options);
    const first = store.import('https://sealbridge.app/i#' + token, 'reviewer');
    const bytes = fs.readFileSync(store.path, 'utf8');
    expect(store.import(token, 'reviewer')).toEqual(first);
    expect(store.import('acp://invite?token=' + token.slice(11))).toEqual(first);
    expect(fs.readFileSync(store.path, 'utf8')).toBe(bytes);
    expect(first).toMatchObject({ alias: 'reviewer', ownerDid: owner.did, agentDid: agent.did, status: 'current' });
    expect(new InviteStore(local, options).list()).toEqual([first]);
    expect(store.resolve(first.workerRef).inviteToken).toBe(token);
    expect(store.resolve('reviewer').inviteToken).toBe(token);
    expect(JSON.stringify([first, store.list()])).not.toContain(token);
    expect(JSON.stringify(first)).not.toContain(local.privateKey);
    expect(store.path).toBe(join(home, 'data', 'invites', digestBytes(local.did).slice(7) + '.json'));
    expect(fs.readdirSync(join(home, 'data'))).toEqual(['invites']); // no contacts/reciprocal identity
    expect(fetcher).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled();
    if (process.platform !== 'win32') {
      expect(fs.statSync(store.path).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dirname(store.path)).mode & 0o777).toBe(0o700);
    }
  });
  it('leaves existing contacts and their admission flags unchanged on import and removal', () => {
    const owner = generateKeyPair(), contacts = join(home, 'contacts.json');
    const previous = addContact(contacts, owner, fixture().token);
    const contents = fs.readFileSync(contacts, 'utf8');
    const store = new InviteStore(owner, options);
    const saved = store.import(fixture().token, 'reviewer');
    expect(loadContacts(contacts, owner.did)).toEqual(previous);
    store.remove(saved.workerRef);
    expect(fs.readFileSync(contacts, 'utf8')).toBe(contents);
    expect(fs.readdirSync(home).sort()).toEqual(['contacts.json', 'data']);
  });
  it('keeps local owners separate and generates stable ASCII aliases from display data', () => {
    const local = generateKeyPair(), { token } = fixture('日本語 <message>');
    const a = new InviteStore(local, options), b = new InviteStore(generateKeyPair(), options);
    const first = a.import(token);
    expect(first.alias).toMatch(/^message-[a-f0-9]{12}$/);
    expect(b.list()).toEqual([]);
    expect(b.import(token).workerRef).not.toBe(first.workerRef);
    expect(new InviteStore(local, options).import(token)).toEqual(first);
    expect(() => b.resolve(first.workerRef)).toThrow('INVITE_NOT_FOUND');
  });
  it('never rebinds a colliding alias or silently renames an identical invite', () => {
    const store = new InviteStore(generateKeyPair(), options);
    const a = fixture(), b = fixture();
    const first = store.import(a.token, 'reviewer');
    expect(() => store.import(b.token, 'reviewer')).toThrow('ALIAS_EXISTS');
    expect(() => store.import(a.token, 'renamed')).toThrow('ALIAS_EXISTS');
    expect(store.list()).toEqual([first]);
    expect(store.remove(first.workerRef)).toBe(true);
    expect(store.remove('reviewer')).toBe(false);
    expect(store.import(b.token, 'reviewer').workerRef).not.toBe(first.workerRef);
    expect(() => store.resolve(first.workerRef)).toThrow('INVITE_NOT_FOUND');
  });
  it.each(['', 'a b', 'a/b', 'a:b', '日本語', 'a'.repeat(65)])('rejects invalid alias %j before mutation', alias => {
    const store = new InviteStore(generateKeyPair(), options);
    expect(() => store.import(fixture().token, alias)).toThrow('INVALID_ALIAS');
    expect(fs.existsSync(store.path)).toBe(false);
  });
  it.each(['invite', 'card'] as const)('lists expired %s entries but gates import and resolution at the boundary', which => {
    const { token } = fixture('Expiry', 'https://relay.example', which === 'invite' ? 10 : 60, which === 'card' ? 10 : 120);
    const store = new InviteStore(generateKeyPair(), options);
    const first = store.import(token);
    now = NOW + 9999; expect(store.resolve(first.workerRef).inviteToken).toBe(token);
    now++; expect(store.list()[0].status).toBe('expired');
    expect(() => store.resolve(first.alias)).toThrow('INVITE_EXPIRED');
    expect(() => store.import(token)).toThrow('INVITE_EXPIRED');
    expect(store.remove(first.alias)).toBe(true);
  });
  it.each(['signature', 'card', 'binding', 'schema', 'future'] as const)('rejects invalid invitation %s before writing', mutation => {
    const { token, owner } = fixture();
    let signed = JSON.parse(Buffer.from(token.slice(11), 'base64url').toString()) as Signed<Invite>;
    if (mutation === 'signature') signed.signature.signature = 'ed25519:' + 'A'.repeat(86);
    else {
      if (mutation === 'card') signed.payload.agentCard.payload.name = 'Changed';
      if (mutation === 'binding') signed.payload.agentDid = generateKeyPair().did;
      if (mutation === 'schema') signed.payload.type = 'Other' as 'AgentInvite';
      if (mutation === 'future') signed.payload.issuedAt = new Date(NOW + 120000).toISOString();
      signed = signPayload(signed.payload, owner);
    }
    const store = new InviteStore(generateKeyPair(), options);
    expect(() => store.import(pack(signed))).toThrow('INVALID_OR_EXPIRED_INVITE');
    expect(fs.existsSync(join(home, 'data'))).toBe(false);
  });
  it('enforces self-owner and relay policy locally, retaining private-relay opt-in and metadata denial', () => {
    const remote = fixture();
    expect(() => new InviteStore(remote.owner, options).import(remote.token)).toThrow('SELF_DELEGATION_NOT_ALLOWED');
    expect(() => new InviteStore(generateKeyPair(), { ...options,
      relayPolicy: { configured: 'https://other.example' } }).import(remote.token)).toThrow('CONFLICTING_RELAY');
    const local = fixture('Local', 'http://127.0.0.1:8787');
    expect(() => new InviteStore(generateKeyPair(), options).import(local.token)).toThrow('SSRF_BLOCKED_RELAY_URL');
    const localOwner = generateKeyPair();
    const privateEntry = new InviteStore(localOwner, { ...options,
      relayPolicy: { allowPrivateRelay: true } }).import(local.token);
    const restricted = new InviteStore(localOwner, options);
    expect(restricted.list()).toEqual([privateEntry]);
    expect(() => restricted.resolve(privateEntry.workerRef)).toThrow('SSRF_BLOCKED_RELAY_URL');
    expect(() => new InviteStore(generateKeyPair(), { ...options,
      relayPolicy: { allowPrivateRelay: true } }).import(fixture('Metadata', 'http://169.254.169.254').token))
      .toThrow('SSRF_BLOCKED_RELAY_URL');
  });
  it.each(['json', 'signature', 'binding', 'duplicate', 'schema', 'token', 'foreign-owner', 'oversize'] as const)('rejects %s store content without echoing retained material', mutation => {
    const local = generateKeyPair(), store = new InviteStore(local, options), { token } = fixture();
    store.import(token, 'worker');
    const signed = JSON.parse(fs.readFileSync(store.path, 'utf8'));
    if (mutation === 'binding') signed.payload.entries[0].relayUrl = 'https://changed.example';
    if (mutation === 'duplicate') signed.payload.entries.push(signed.payload.entries[0]);
    if (mutation === 'schema') signed.payload.version = 2;
    if (mutation === 'token') signed.payload.entries[0].inviteToken = fixture().token;
    const changed = mutation === 'signature' ? { ...signed, payload: { ...signed.payload, version: 2 } }
      : signPayload(signed.payload, mutation === 'foreign-owner' ? generateKeyPair() : local);
    fs.writeFileSync(store.path, mutation === 'json' ? '{' : mutation === 'oversize' ? 'x'.repeat(4 * 1024 * 1024 + 1) : JSON.stringify(changed));
    expect(() => store.list()).toThrow('INVITE_STORE_INVALID');
    expect(() => store.import(token)).toThrow('INVITE_STORE_INVALID');
    expect(() => store.remove('worker')).toThrow('INVITE_STORE_INVALID');
  });
  it('reads CRLF JSON, rejects non-files/linked paths, and checks POSIX permissions', () => {
    const store = new InviteStore(generateKeyPair(), options);
    store.import(fixture().token);
    fs.writeFileSync(store.path, JSON.stringify(JSON.parse(fs.readFileSync(store.path, 'utf8')), null, 2).replace(/\n/g, '\r\n') + '\r\n');
    expect(store.list()).toHaveLength(1);
    if (process.platform !== 'win32') {
      fs.chmodSync(store.path, 0o644); expect(() => store.list()).toThrow('INVITE_STORE_INVALID');
      fs.chmodSync(store.path, 0o600);
    }
    fs.unlinkSync(store.path); fs.mkdirSync(store.path, { mode: 0o700 });
    expect(() => store.list()).toThrow('INVITE_STORE_INVALID');
    fs.rmdirSync(store.path);
    const target = join(home, 'target'); fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, store.path, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => store.list()).toThrow('INVITE_STORE_INVALID');
  });
  it('returns bounded contention without removing a live lock or changing the store', () => {
    const store = new InviteStore(generateKeyPair(), options), first = store.import(fixture().token);
    const bytes = fs.readFileSync(store.path, 'utf8');
    fs.writeFileSync(store.path + '.lock', 'other writer', { mode: 0o600 });
    expect(() => store.remove(first.alias)).toThrow('INVITE_STORE_BUSY');
    expect(() => store.import(fixture().token)).toThrow('INVITE_STORE_BUSY');
    expect(store.list()).toEqual([first]);
    expect(fs.readFileSync(store.path, 'utf8')).toBe(bytes);
    expect(fs.readFileSync(store.path + '.lock', 'utf8')).toBe('other writer');
    fs.unlinkSync(store.path + '.lock'); expect(store.remove(first.alias)).toBe(true);
  });
  it('holds the exclusive lock through publication so another live writer cannot replace it', () => {
    const owner = generateKeyPair(), store = new InviteStore(owner, options);
    store.import(fixture().token, 'first');
    const competing = fixture().token;
    const io = { ...fs, renameSync: ((from, to) => {
      expect(() => store.import(competing, 'competing')).toThrow('INVITE_STORE_BUSY');
      fs.renameSync(from, to);
    }) as typeof fs.renameSync };
    new InviteStore(owner, { ...options, fs: io }).import(fixture().token, 'second');
    expect(store.list().map(e => e.alias)).toEqual(['first', 'second']);
  });
  it.each(['write', 'flush', 'rename'] as const)('preserves the committed store on %s failure and cleans up owned temporaries', stage => {
    const owner = generateKeyPair(), store = new InviteStore(owner, options);
    store.import(fixture().token);
    const bytes = fs.readFileSync(store.path, 'utf8'), io = { ...fs };
    if (stage === 'write') io.writeSync = ((fd: number, bytes: Buffer, offset: number, length: number) => {
      if (bytes.length > 100) throw new Error('retained material');
      return fs.writeSync(fd, bytes, offset, length);
    }) as typeof fs.writeSync;
    if (stage === 'flush') io.fsyncSync = fd => { if (fs.fstatSync(fd).size > 100) throw new Error('retained material'); };
    if (stage === 'rename') io.renameSync = () => { throw new Error('retained material'); };
    const failing = new InviteStore(owner, { ...options, fs: io });
    expect(() => failing.import(fixture().token)).toThrow('INVITE_STORE_INVALID');
    expect(fs.readFileSync(store.path, 'utf8')).toBe(bytes);
    expect(fs.readdirSync(dirname(store.path))).toEqual([store.path.slice(dirname(store.path).length + 1)]);
  });
});

it('marks only owner-supplied aliases and preserves legacy metadata without inferring intent', () => {
  const owner = generateKeyPair(), store = new InviteStore(owner, options), token = fixture().token;
  const automatic = store.import(token);
  expect(automatic.aliasExplicit).toBeUndefined();
  expect(store.list()[0].aliasExplicit).toBeUndefined();
  const explicit = store.import(token, automatic.alias);
  expect(explicit.aliasExplicit).toBe(true);
  expect(new InviteStore(owner, options).list()[0].aliasExplicit).toBe(true);
  const signed = JSON.parse(fs.readFileSync(store.path, 'utf8'));
  delete signed.payload.entries[0].aliasExplicit;
  fs.unlinkSync(store.aliasPath);
  fs.writeFileSync(store.path, JSON.stringify(signPayload(signed.payload, owner)));
  const legacyBytes = fs.readFileSync(store.path);
  expect(new InviteStore(owner, options).list()[0].aliasExplicit).toBeUndefined();
  expect(new InviteStore(owner, options).import(token).aliasExplicit).toBeUndefined();
  expect(fs.readFileSync(store.path)).toEqual(legacyBytes);
});
it.each([false, 'true', 1, null])('rejects an invalid signed aliasExplicit marker: %j', value => {
  const owner = generateKeyPair(), store = new InviteStore(owner, options);
  store.import(fixture().token, 'buddy');
  const signed = JSON.parse(fs.readFileSync(store.path, 'utf8'));
  signed.payload.entries[0].aliasExplicit = value;
  fs.writeFileSync(store.path, JSON.stringify(signPayload(signed.payload, owner)));
  expect(() => store.list()).toThrow('INVITE_STORE_INVALID');
});
it('treats unreadable intent as absent and accepts when sidecar publication fails', () => {
  const owner = generateKeyPair(), store = new InviteStore(owner, options), token = fixture().token;
  store.import(token, 'chosen');
  const io = { ...fs, openSync: ((path, ...args) => {
    if (String(path) === store.aliasPath) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
    return (fs.openSync as any)(path, ...args);
  }) as typeof fs.openSync };
  const unreadable = new InviteStore(owner, { ...options, fs: io });
  expect(unreadable.list()[0].aliasExplicit).toBeUndefined();
  expect(unreadable.resolve('chosen').inviteToken).toBe(token);
  const failing = new InviteStore(owner, { ...options, fs: { ...fs, renameSync: (from, to) => {
    if (String(to) === store.aliasPath) throw new Error('sidecar unavailable');
    fs.renameSync(from, to);
  } } });
  const imported = failing.import(fixture().token, 'second');
  expect(imported.alias).toBe('second');
  expect(imported.aliasExplicit).toBe(false);
  expect(store.list()).toMatchObject([{ alias: 'chosen', aliasExplicit: true }, { alias: 'second' }]);
  expect(store.list()[1].aliasExplicit).toBeUndefined();
});

function inlineLegacy(owner: ReturnType<typeof generateKeyPair>, store: InviteStore) {
  const signed = JSON.parse(fs.readFileSync(store.path, 'utf8'));
  signed.payload.entries[0].aliasExplicit = true;
  fs.writeFileSync(store.path, JSON.stringify(signPayload(signed.payload, owner)));
  fs.unlinkSync(store.aliasPath);
}
it.each(['held-lock', 'read-only'] as const)('reads verified legacy aliases when migration encounters %s and retries on write', reason => {
  const owner = generateKeyPair(), store = new InviteStore(owner, options), token = fixture().token;
  store.import(token, 'buddy'); inlineLegacy(owner, store);
  const before = fs.readFileSync(store.path);
  if (reason === 'held-lock') fs.writeFileSync(store.path + '.lock', 'another writer', { mode: 0o600 });
  const io = reason === 'held-lock' ? fs : { ...fs, openSync: ((path, flags, ...args) => {
    if (typeof flags === 'number' && (flags & fs.constants.O_CREAT))
      throw Object.assign(new Error('read-only directory'), { code: 'EROFS' });
    return (fs.openSync as any)(path, flags, ...args);
  }) as typeof fs.openSync };
  const reader = new InviteStore(owner, { ...options, fs: io });
  expect(reader.list()[0]).toMatchObject({ alias: 'buddy', aliasExplicit: true });
  expect(reader.resolve('buddy').inviteToken).toBe(token);
  expect(fs.readFileSync(store.path)).toEqual(before);
  if (reason === 'held-lock') {
    expect(fs.readFileSync(store.path + '.lock', 'utf8')).toBe('another writer');
    expect(() => reader.import(token, 'buddy')).toThrow('INVITE_STORE_BUSY');
    fs.unlinkSync(store.path + '.lock');
  } else expect(() => reader.import(token, 'buddy')).toThrow('INVITE_STORE_UNWRITABLE');
  expect(store.import(token, 'buddy').aliasExplicit).toBe(true);
  expect(JSON.parse(fs.readFileSync(store.path, 'utf8')).payload.entries[0]).not.toHaveProperty('aliasExplicit');
  expect(store.list()[0].aliasExplicit).toBe(true);
});
it('publishes migration intent before replacing the store and survives interruption at that boundary', () => {
  const owner = generateKeyPair(), store = new InviteStore(owner, options), token = fixture().token;
  store.import(token, 'buddy'); inlineLegacy(owner, store);
  const before = fs.readFileSync(store.path);
  const reader = new InviteStore(owner, { ...options, fs: { ...fs, renameSync: (from, to) => {
    expect(fs.existsSync(store.path + '.lock')).toBe(true);
    if (String(to) === store.path) {
      expect(JSON.parse(fs.readFileSync(store.aliasPath, 'utf8')).payload.marks).toHaveLength(1);
      throw new Error('simulated interruption');
    }
    fs.renameSync(from, to);
  } } });
  expect(reader.list()[0].aliasExplicit).toBe(true);
  expect(fs.readFileSync(store.path)).toEqual(before);
  const legacy = JSON.parse(before.toString());
  delete legacy.payload.entries[0].aliasExplicit;
  fs.writeFileSync(store.path, JSON.stringify(signPayload(legacy.payload, owner)));
  expect(store.list()[0].aliasExplicit).toBe(true);
});
it('keeps legacy inline intent when the sidecar cannot be published', () => {
  const owner = generateKeyPair(), store = new InviteStore(owner, options);
  store.import(fixture().token, 'buddy'); inlineLegacy(owner, store);
  fs.mkdirSync(store.aliasPath, { mode: 0o700 });
  expect(store.list()[0].aliasExplicit).toBe(true);
  expect(JSON.parse(fs.readFileSync(store.path, 'utf8')).payload.entries[0].aliasExplicit).toBe(true);
  fs.rmdirSync(store.aliasPath);
  expect(store.import(store.resolve('buddy').inviteToken, 'buddy').aliasExplicit).toBe(true);
  expect(JSON.parse(fs.readFileSync(store.path, 'utf8')).payload.entries[0]).not.toHaveProperty('aliasExplicit');
});

it('attempts blocked read-time migration only once per instance and retries on explicit import', () => {
  const owner = generateKeyPair(), store = new InviteStore(owner, options), token = fixture().token;
  store.import(token, 'buddy'); inlineLegacy(owner, store);
  const before = fs.readFileSync(store.path);
  const publish = vi.fn((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === store.aliasPath) throw Object.assign(new Error('blocked'), { code: 'EACCES' });
    fs.renameSync(from, to);
  });
  const reader = new InviteStore(owner, { ...options, fs: { ...fs, renameSync: publish } });
  expect(reader.list()[0].aliasExplicit).toBe(true);
  const attempts = publish.mock.calls.length;
  expect(attempts).toBe(1); // Only the sidecar was attempted; the main store was not rewritten.
  expect(fs.readFileSync(store.path)).toEqual(before);
  reader.list(); reader.listUnconfirmed(); reader.resolve('buddy');
  expect(publish).toHaveBeenCalledTimes(attempts);
  expect(reader.import(token, 'buddy').aliasExplicit).toBe(true); // Legacy inline intent survives.
  expect(publish.mock.calls.length).toBeGreaterThan(attempts);
});

it.each(['EACCES', 'EPERM', 'EROFS'])('explains an unwritable invite folder (%s) without damaging existing data', errno => {
  const owner = generateKeyPair(), store = new InviteStore(owner, options), token = fixture().token;
  store.import(token, 'buddy');
  const before = fs.readFileSync(store.path);
  const failing = new InviteStore(owner, { ...options, fs: { ...fs, openSync: ((path, flags, ...args) => {
    if (String(path) === store.path + '.lock') throw Object.assign(new Error('write denied'), { code: errno });
    return (fs.openSync as any)(path, flags, ...args);
  }) as typeof fs.openSync } });
  expect(() => failing.import(fixture().token, 'other')).toThrow('INVITE_STORE_UNWRITABLE');
  try { failing.import(token, 'buddy'); } catch (error) {
    const message = (error as Error).message;
    expect(message).toContain(dirname(store.path));
    expect(message).toContain('Grant the current user write access');
    expect(message).toContain('書き込み権限を付けるか');
    expect(message).toContain('SEALBRIDGE_DATA_DIR');
  }
  expect(fs.readFileSync(store.path)).toEqual(before);
  expect(fs.existsSync(store.path + '.lock')).toBe(false);
});

it.each(['new', 'duplicate'] as const)('reports false for unsaved explicit intent on %s import and recovers on retry', kind => {
  const owner = generateKeyPair(), store = new InviteStore(owner, options), token = fixture().token;
  if (kind === 'duplicate') store.import(token);
  const alias = kind === 'duplicate' ? store.list()[0].alias : 'chosen';
  const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
  const failing = new InviteStore(owner, { ...options, fs: { ...fs, renameSync: (from, to) => {
    if (String(to) === store.aliasPath) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    fs.renameSync(from, to);
  } } });
  expect(failing.import(token, alias)).toMatchObject({ alias, aliasExplicit: false });
  expect(store.list()[0].aliasExplicit).toBeUndefined();
  expect(store.resolve(alias).inviteToken).toBe(token);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toContain('explicit invite alias metadata could not be read or saved');
  expect(warn.mock.calls[0][0]).toContain('招待別名の明示指定を読み取り・保存できませんでした');
  expect(store.import(token, alias).aliasExplicit).toBe(true);
  expect(new InviteStore(owner, options).list()[0].aliasExplicit).toBe(true);
});

it.skipIf(process.platform === 'win32').each([false, true])('repairs owner sidecar permissions on accept, or reports failed repair: %s', async denied => {
  const owner = generateKeyPair(), store = new InviteStore(owner, options), token = fixture().token;
  store.import(token, 'buddy');
  fs.chmodSync(store.aliasPath, 0o644);
  const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
  const repair = vi.fn((fd: number, mode: fs.Mode) => {
    if (denied) throw Object.assign(new Error('repair denied'), { code: 'EPERM' });
    fs.fchmodSync(fd, mode);
  });
  const writer = await InviteStore.open(owner, { ...options, fs: { ...fs, fchmodSync: repair } });
  expect(writer.import(token, 'buddy').aliasExplicit).toBe(!denied);
  expect(fs.statSync(store.aliasPath).mode & 0o777).toBe(denied ? 0o644 : 0o600);
  expect(warn).toHaveBeenCalledTimes(denied ? 1 : 0);
});

it('accept returns token-free JSON for unsaved alias intent and explains an unwritable folder', async () => {
  const owner = resolveOrCreateIdentity('requester', options), store = new InviteStore(owner, options), token = fixture().token;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
  await acceptCommand('accept', [token, '--alias', 'buddy'], { ...options, fs: { ...fs, renameSync: (from, to) => {
    if (String(to) === store.aliasPath) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    fs.renameSync(from, to);
  } } });
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ alias: 'buddy', aliasExplicit: false });
  expect(log.mock.calls.at(-1)![0]).not.toContain(token);
  expect(warn).toHaveBeenCalledTimes(1);
  await expect(acceptCommand('accept', [token, '--alias', 'buddy'], { ...options, fs: { ...fs, mkdirSync: ((path, ...args) => {
    if (String(path) === dirname(store.path)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return (fs.mkdirSync as any)(path, ...args);
  }) as typeof fs.mkdirSync } })).rejects.toThrow('INVITE_STORE_UNWRITABLE');
});

it.each([true, false])('reports the data root when its creation is denied (errno path: %s)', withPath => {
  const root = options.env!.SEALBRIDGE_DATA_DIR!;
  fs.mkdirSync(root, { mode: 0o700 });
  const store = new InviteStore(generateKeyPair(), { ...options, fs: { ...fs, mkdirSync: ((path, ...args) => {
    if (String(path) === root) throw Object.assign(new Error('denied'), { code: 'EACCES', ...(withPath ? { path: root } : {}) });
    return (fs.mkdirSync as any)(path, ...args);
  }) as typeof fs.mkdirSync } });
  try { store.import(fixture().token, 'buddy'); throw new Error('expected failure'); }
  catch (error) {
    const message = (error as Error).message;
    expect(message).toContain(`at "${root}"`);
    expect(message).toContain(`access to "${root}"`);
    expect(message).toContain(`「${root}」に現在のユーザーの書き込み権限`);
    expect(message).not.toContain(join(root, 'invites'));
  }
});

it.each(['README.md', 'README.ja.md', 'docs/connections/invite-lifecycle.md', 'docs/connections/invite-lifecycle.ja.md',
  'docs/connections/invite-and-roles.md', 'docs/connections/invite-and-roles.ja.md', 'AGENTS.md', 'SKILL.md'])('documents boolean alias results in valid UTF-8: %s', file => {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
  expect(text).toContain('aliasExplicit: false');
  expect(text).toContain(file.includes('.ja.') ? 'キーの有無ではなく値' : file === 'AGENTS.md' || file === 'SKILL.md' ? 'not key presence' : 'rather than whether the key exists');
});

it('falls back to the nearest existing parent when a nested data root has no errno path', () => {
  const root = join(home, 'missing', 'nested');
  const store = new InviteStore(generateKeyPair(), { ...options, env: { SEALBRIDGE_DATA_DIR: root }, fs: { ...fs,
    mkdirSync: (() => { throw Object.assign(new Error('denied'), { code: 'EROFS' }); }) as typeof fs.mkdirSync,
  } });
  expect(() => store.import(fixture().token, 'buddy')).toThrow(`at "${home}"`);
});

it.each(['missing invites', 'missing lock', 'existing file', 'existing directory'] as const)(
  'names an existing recovery folder for OS error.path pointing to %s', kind => {
    const owner = generateKeyPair(), store = new InviteStore(owner, options), token = fixture().token;
    const root = options.env!.SEALBRIDGE_DATA_DIR!, invites = dirname(store.path);
    fs.mkdirSync(root, { mode: 0o700 });
    if (kind !== 'missing invites') store.import(token, 'buddy');
    const failedPath = kind === 'missing invites' || kind === 'existing directory' ? invites :
      kind === 'missing lock' ? store.path + '.lock' : store.path;
    const expected = kind === 'missing invites' ? root : invites;
    const denied = () => { throw Object.assign(new Error('denied'), { code: 'EACCES', path: failedPath }); };
    const failing = new InviteStore(owner, { ...options, fs: { ...fs,
      mkdirSync: ((path, ...args) => {
        if (kind === 'missing invites' && String(path) === invites) denied();
        return (fs.mkdirSync as any)(path, ...args);
      }) as typeof fs.mkdirSync,
      openSync: ((path, flags, ...args) => {
        if (String(path) === store.path + '.lock') denied();
        return (fs.openSync as any)(path, flags, ...args);
      }) as typeof fs.openSync,
    } });
    expect(fs.existsSync(failedPath)).toBe(kind === 'existing file' || kind === 'existing directory');
    expect(fs.statSync(expected).isDirectory()).toBe(true);
    expect(() => failing.import(token, 'buddy')).toThrow(new Error(
      `INVITE_STORE_UNWRITABLE: Cannot write invitation data at "${expected}". Grant the current user write access to "${expected}" or select a writable SEALBRIDGE_DATA_DIR.\n招待データのパス「${expected}」に書き込めません。「${expected}」に現在のユーザーの書き込み権限を付けるか、書き込み可能な SEALBRIDGE_DATA_DIR を指定してください。`,
    ));
    expect(fs.existsSync(store.path + '.lock')).toBe(false);
    if (kind !== 'missing invites') expect(store.list()[0]).toMatchObject({ alias: 'buddy', aliasExplicit: true });
  },
);
it('retains per-entry intent from an earlier sidecar after unrelated store changes', () => {
  const owner = generateKeyPair(), store = new InviteStore(owner, options);
  store.import(fixture().token, 'buddy');
  const signed = JSON.parse(fs.readFileSync(store.aliasPath, 'utf8'));
  signed.payload.recordsDigest = 'sha256:' + '0'.repeat(64);
  fs.writeFileSync(store.aliasPath, JSON.stringify(signPayload(signed.payload, owner)));
  expect(store.list()[0]).toMatchObject({ alias: 'buddy', aliasExplicit: true });
});
it('keeps existing intent when store replacement fails during removal', () => {
  const owner = generateKeyPair(), store = new InviteStore(owner, options);
  store.import(fixture().token, 'buddy');
  const before = fs.readFileSync(store.path);
  const failing = new InviteStore(owner, { ...options, fs: { ...fs, renameSync: (from, to) => {
    if (String(to) === store.path) throw new Error('store publication interrupted');
    fs.renameSync(from, to);
  } } });
  expect(() => failing.remove('buddy')).toThrow('INVITE_STORE_INVALID');
  expect(fs.readFileSync(store.path)).toEqual(before);
  expect(store.list()[0]).toMatchObject({ alias: 'buddy', aliasExplicit: true });
});
it('keeps per-entry intent absent after an old-style record alias change', () => {
  const owner = generateKeyPair(), store = new InviteStore(owner, options);
  store.import(fixture().token, 'buddy');
  const signed = JSON.parse(fs.readFileSync(store.path, 'utf8'));
  signed.payload.entries[0].alias = 'renamed';
  fs.writeFileSync(store.path, JSON.stringify(signPayload(signed.payload, owner)));
  expect(store.list()[0].alias).toBe('renamed');
  expect(store.list()[0].aliasExplicit).toBeUndefined();
});
it.each(['directory', 'symlink', 'permissions'] as const)('warns once in both languages for an unsafe %s sidecar without blocking use', kind => {
  const owner = generateKeyPair(), store = new InviteStore(owner, options), token = fixture().token;
  store.import(token, 'buddy');
  const io = { ...fs, lstatSync: ((path, ...args) => {
    const stat = (fs.lstatSync as any)(path, ...args);
    if (String(path) !== store.aliasPath) return stat;
    if (kind === 'symlink') return { ...stat, isSymbolicLink: () => true };
    if (kind === 'directory') return { ...stat, isSymbolicLink: () => false, isFile: () => false };
    throw Object.assign(new Error('unsafe permissions'), { code: 'EACCES' });
  }) as typeof fs.lstatSync };
  const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
  const reader = new InviteStore(owner, { ...options, fs: io });
  expect(reader.list()[0].aliasExplicit).toBeUndefined();
  expect(reader.resolve('buddy').inviteToken).toBe(token);
  expect(reader.import(token, 'buddy').alias).toBe('buddy');
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toContain('explicit invite alias metadata could not be read or saved');
  expect(warn.mock.calls[0][0]).toContain('招待別名の明示指定を読み取り・保存できませんでした');
});
