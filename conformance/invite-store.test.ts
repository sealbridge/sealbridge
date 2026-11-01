import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import dns from 'node:dns/promises';
import { createInviteToken, createSignedAgentCard, digestBytes, generateKeyPair, signPayload } from '../packages/core/src/index.js';
import type { Invite, Signed } from '../packages/core/src/index.js';
import { InviteStore } from '../packages/runtime/src/invite-store.js';
import type { InviteStoreOptions } from '../packages/runtime/src/invite-store.js';
import { addContact, loadContacts } from '../cli/src/contacts.js';

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
