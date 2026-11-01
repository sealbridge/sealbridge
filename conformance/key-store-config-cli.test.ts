// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AcpMcpServer } from '../packages/runtime/dist/index.js';
import { createInviteToken, createSignedAgentCard, generateKeyPair, verifySigned } from '../packages/core/src/index.js';
import { keyStoreSelection, KeychainKeyStore, resolveStoredIdentity, inspectStoredIdentity } from '../packages/runtime/src/key-store.js';
import type { IdentityStoreOptions, KeyringModule } from '../packages/runtime/src/key-store.js';
import { inspectLocalIdentity, resolveDataRoot } from '../packages/runtime/src/local-identity.js';
import { readApplicationConfig, setApplicationKeyStore } from '../packages/runtime/src/application-config.js';
import { configCommand } from '../cli/src/config.js';
import { boardCommand } from '../cli/src/board.js';
import { contactsCommand, loadContacts } from '../cli/src/contacts.js';
import { inviteShareCommand, openInvite } from '../cli/src/invite-share.js';
import { mcpServerCommand } from '../cli/src/mcp.js';
import { networkCommand } from '../cli/src/network.js';
import { diagnose } from '../cli/src/doctor.js';

vi.mock('node:readline/promises', () => ({ createInterface: () => ({ question: async () => 'yes', close() {} }) }));
const roots: string[] = [];
function fixture() {
  const home = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'sealbridge-store-cli-'));
  roots.push(home);
  const entries = new Map<string, string>();
  const module: KeyringModule = { Entry: class {
    id: string;
    constructor(service: string, account: string) { this.id = service + '/' + account; }
    getPassword() { return entries.get(this.id) ?? null; }
    setPassword(value: string) { entries.set(this.id, value); }
  } };
  const loader = vi.fn(async () => module);
  const options: IdentityStoreOptions = { home, env: { SEALBRIDGE_DATA_DIR: join(home, 'data') }, keyringLoader: loader };
  return { home, options, entries, module, loader, root: resolveDataRoot(options) };
}
function put(path: string, value: string) {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path, value, { mode: 0o600 });
}
function incoming(home: string, owner = generateKeyPair()) {
  const token = createInviteToken({ agentCard: createSignedAgentCard({ name: 'Peer', agentDid: owner.did,
    relayEndpoint: 'https://relay.example', skills: [], expiresAt: new Date(Date.now() + 3600000).toISOString() }, owner) }, owner);
  const file = join(home, 'invite.txt');
  put(file, token);
  return { file, token, owner };
}
function postArgs(home: string) {
  const input = join(home, 'input.json'), out = join(home, 'post.json');
  put(input, '{"message":"hello"}');
  return { out, args: ['post', '--relay', 'https://relay.example', '--what', 'Return JSON', '--skill', 'json',
    '--task-type', 'echo', '--deadline', new Date(Date.now() + 3600000).toISOString(), '--max-input-tokens', '10',
    '--max-output-tokens', '10', '--max-tool-calls', '1', '--max-wall-seconds', '10', '--input-file', input, '--out', out] };
}
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// Every test in this file uses local I/O and the in-memory credential loader.
function offline() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Unexpected network request'); });
  return vi.spyOn(console, 'log').mockImplementation(() => {});
}

describe('persisted identity store selection', () => {
  it('uses option, environment, config, then default precedence without creating identities', async () => {
    offline();
    const { options, root, entries } = fixture();
    expect(keyStoreSelection(options)).toEqual({ keyStore: 'file', source: 'default' });
    expect(fs.existsSync(root)).toBe(false);
    setApplicationKeyStore('keychain', options);
    expect(keyStoreSelection(options)).toEqual({ keyStore: 'keychain', source: 'config' });
    const env = { ...options.env, SEALBRIDGE_KEY_STORE: 'file' };
    expect(keyStoreSelection({ ...options, env })).toEqual({ keyStore: 'file', source: 'env' });
    expect(keyStoreSelection({ ...options, env, keyStore: 'keychain' })).toEqual({ keyStore: 'keychain', source: 'option' });
    expect(keyStoreSelection({ ...options, env: { ...env, SEALBRIDGE_KEY_STORE: 'invalid' }, keyStore: 'file' }))
      .toEqual({ keyStore: 'file', source: 'option' });
    expect(await inspectStoredIdentity('requester', options)).toMatchObject({ backend: 'keychain', present: false });
    expect(entries.size).toBe(0);
    expect(fs.readdirSync(root)).toEqual(['config.json']);
  });

  it('retains scalar relays and unknown fields on change and preserves exact bytes when unchanged', () => {
    offline();
    const { options, root } = fixture();
    const path = join(root, 'config.json');
    const value = { version: 1, relay: 'https://relay.example/', future: { nested: [1, 'two'] }, keyStore: 'file' };
    const raw = JSON.stringify(value, null, 3).replace(/\n/g, '\r\n') + '\r\n';
    put(path, raw);
    setApplicationKeyStore('file', options);
    expect(fs.readFileSync(path, 'utf8')).toBe(raw);
    setApplicationKeyStore('keychain', options);
    expect(JSON.parse(fs.readFileSync(path, 'utf8'))).toEqual({ ...value, keyStore: 'keychain' });
    expect(readApplicationConfig(options)).toMatchObject({ relays: ['https://relay.example'], future: value.future, keyStore: 'keychain' });
    expect(fs.readdirSync(root)).toEqual(['config.json']);
    if (process.platform !== 'win32') expect(fs.statSync(path).mode & 0o777).toBe(0o600);
  });

  it.each(['unknown', '', null, 3, {}])('rejects invalid config backend %# without changing its bytes', value => {
    offline();
    const { options, root } = fixture();
    const raw = JSON.stringify({ version: 1, relays: ['https://relay.example'], keyStore: value });
    put(join(root, 'config.json'), raw);
    expect(() => keyStoreSelection(options)).toThrow('APP_CONFIG_INVALID');
    expect(() => setApplicationKeyStore('file', options)).toThrow('APP_CONFIG_INVALID');
    expect(fs.readFileSync(join(root, 'config.json'), 'utf8')).toBe(raw);
    expect(fs.readdirSync(root)).toEqual(['config.json']);
  });

  it('reads and sets selection with no key creation and reports an overriding environment', async () => {
    const log = offline();
    const { options, root, entries } = fixture();
    await configCommand(['key-store'], options);
    expect(log).toHaveBeenLastCalledWith('{"keyStore":"file","source":"default"}');
    expect(fs.existsSync(root)).toBe(false);
    await configCommand(['key-store', 'keychain'], options);
    expect(log).toHaveBeenLastCalledWith('{"keyStore":"keychain","source":"config"}');
    expect(entries.size).toBe(0);
    expect(fs.readdirSync(root)).toEqual(['config.json']);
    const configured = { ...options, env: { ...options.env, SEALBRIDGE_KEY_STORE: 'file' } };
    await configCommand(['key-store', 'keychain'], configured);
    expect(log).toHaveBeenLastCalledWith('{"keyStore":"file","source":"env"}');
    expect(readApplicationConfig(options).keyStore).toBe('keychain');
    await expect(configCommand(['key-store', 'other'], options)).rejects.toThrow('KEY_STORE_INVALID');
    await expect(configCommand(['key-store', 'file', 'extra'], options)).rejects.toThrow('Usage:');
  });

  it('reports identities in the other backend without moving or replacing either role', async () => {
    offline();
    const { options, module, entries } = fixture();
    const file = await resolveStoredIdentity('requester', { ...options, keyStore: 'file' });
    const chain = new KeychainKeyStore(module, options).createIfMissing('worker');
    const path = inspectLocalIdentity('requester', options).path;
    const bytes = fs.readFileSync(path);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await configCommand(['key-store', 'keychain'], options);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('requester: identity also present in file'));
    await configCommand(['key-store', 'file'], options);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('worker: identity also present in keychain'));
    expect(fs.readFileSync(path)).toEqual(bytes);
    expect(inspectLocalIdentity('requester', options).key?.did).toBe(file.did);
    expect(new KeychainKeyStore(module, options).load('worker')?.did).toBe(chain.did);
    expect(entries.size).toBe(1);
  });

  it('retains config bytes when keychain is unavailable and retains existing update locks', async () => {
    offline();
    const { options, loader, root } = fixture();
    setApplicationKeyStore('file', options);
    const before = fs.readFileSync(join(root, 'config.json'));
    loader.mockRejectedValue(new Error('Unavailable'));
    await expect(configCommand(['key-store', 'keychain'], options)).rejects.toThrow('KEY_STORE_UNAVAILABLE');
    expect(fs.readFileSync(join(root, 'config.json'))).toEqual(before);
    put(join(root, '.config.lock'), '');
    expect(() => setApplicationKeyStore('keychain', options)).toThrow('APP_CONFIG_BUSY');
    expect(fs.existsSync(join(root, '.config.lock'))).toBe(true);
    expect(fs.readFileSync(join(root, 'config.json'))).toEqual(before);
  });

  it.each(['default', 'config', 'env', 'option'] as const)('reports %s selection in offline doctor', async source => {
    offline();
    const { options, entries } = fixture();
    if (source === 'config') setApplicationKeyStore('keychain', options);
    if (source === 'env') options.env!.SEALBRIDGE_KEY_STORE = 'keychain';
    if (source === 'option') options.keyStore = 'keychain';
    const fetch = vi.fn();
    const checks = await diagnose({ identityOptions: options, offline: true, fetch });
    expect(checks[2].ok).toBe(true);
    expect(checks[2].message).toContain(`selection: ${source === 'default' ? 'file' : 'keychain'} (${source})`);
    expect(fetch).not.toHaveBeenCalled();
    expect(entries.size).toBe(0);
  });
});

describe('CLI identity stores', () => {
  it('keeps MCP startup and listing lazy, then signs with the configured requester keychain', async () => {
    offline();
    const { options, entries, root } = fixture();
    setApplicationKeyStore('keychain', options);
    vi.spyOn(AcpMcpServer.prototype, 'serve').mockImplementation(async function (this: AcpMcpServer) {
      for (const method of ['initialize', 'tools/list']) await this.handle({ jsonrpc: '2.0', id: 1, method });
      const call = (name: string) => this.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: {} } });
      await call('acp_list_invites'); await call('acp_list_pending_requests');
      expect(entries.size).toBe(0);
      const result = await call('acp_create_invite');
      expect(JSON.stringify(result)).not.toContain('"isError":true');
    });
    await mcpServerCommand([], options);
    expect(entries.size).toBe(1);
    expect((await inspectStoredIdentity('requester', options)).present).toBe(true);
    expect((await inspectStoredIdentity('worker', options)).present).toBe(false);
    expect(fs.existsSync(join(root, 'identities'))).toBe(false);
  });

  it('signs board posts and contact updates with the configured requester keychain', async () => {
    offline();
    const { options, root, home, entries } = fixture();
    setApplicationKeyStore('keychain', options);
    const post = postArgs(home);
    await boardCommand(post.args, options);
    const key = (await inspectStoredIdentity('requester', options)).key!;
    expect(verifySigned(JSON.parse(fs.readFileSync(post.out, 'utf8')), key.did)).toBe(true);
    const peer = incoming(home), contacts = join(home, 'contacts.json');
    await contactsCommand(['add', peer.token, '--file', contacts], options);
    await contactsCommand(['allow', peer.owner.did, '--file', contacts], options);
    expect(loadContacts(contacts, key.did)).toMatchObject([{ allow: true, ownerDid: peer.owner.did }]);
    expect(entries.size).toBe(1);
    expect(fs.existsSync(join(root, 'identities'))).toBe(false);
  });

  it('lists board entries and contacts without creating role identities', async () => {
    const log = offline();
    const { options, root, home, entries } = fixture();
    setApplicationKeyStore('keychain', options);
    const dir = join(home, 'board'); fs.mkdirSync(dir);
    await boardCommand(['list', '--dir', dir], options);
    expect(log).toHaveBeenLastCalledWith('[]');
    await contactsCommand(['list', '--file', join(home, 'contacts.json')], options);
    expect(log).toHaveBeenLastCalledWith('{"version":1,"contacts":[]}');
    expect(entries.size).toBe(0);
    expect(fs.readdirSync(root)).toEqual(['config.json']);
  });

  it('uses the worker role for board claims before any relay request', async () => {
    offline();
    const { options, home, entries } = fixture();
    setApplicationKeyStore('keychain', options);
    const post = postArgs(home);
    await boardCommand(post.args, options);
    const peer = generateKeyPair(), cardPath = join(home, 'card.json');
    put(cardPath, JSON.stringify(createSignedAgentCard({ name: 'Peer', agentDid: peer.did,
      relayEndpoint: 'https://relay.example', skills: [] }, peer)));
    await expect(boardCommand(['claim', '--post', post.out, '--card', cardPath], options))
      .rejects.toThrow('INVALID_BOARD_CLAIM');
    expect((await inspectStoredIdentity('worker', options)).present).toBe(true);
    expect(entries.size).toBe(2);
  });

  it('keeps legacy requester files and contacts locations when no backend selection is present', async () => {
    const log = offline();
    const { options, home, root, loader } = fixture();
    loader.mockRejectedValue(new Error('Module absent'));
    const key = generateKeyPair(), legacy = join(home, '.acp', 'requester.private.json');
    const raw = JSON.stringify(key); put(legacy, raw);
    const peer = incoming(home), contacts = join(home, 'contacts.json');
    const out = join(home, 'reciprocal.txt');
    await inviteShareCommand('open', ['--file', peer.file, '--contacts', contacts, '--out', out], options);
    expect(JSON.parse(log.mock.calls.at(-1)![0]).local.keyFile).toBe(legacy);
    await contactsCommand(['list', '--file', contacts], options);
    expect(JSON.parse(log.mock.calls.at(-1)![0]).contacts[0].ownerDid).toBe(peer.owner.did);
    expect(fs.readFileSync(legacy, 'utf8')).toBe(raw);
    expect(fs.existsSync(join(root, 'identities'))).toBe(false);
  });

  it('opens invites and signs reissue requests with requester, and reissues with worker', async () => {
    const log = offline();
    const { options, root, home, module, entries } = fixture();
    setApplicationKeyStore('keychain', options);
    const peer = incoming(home), contacts = join(home, 'contacts.json'), out = join(home, 'reciprocal.txt');
    await networkCommand('invite', ['open', '--file', peer.file, '--contacts', contacts, '--out', out], { identityOptions: options });
    const key = (await inspectStoredIdentity('requester', options)).key!;
    expect(openInvite(fs.readFileSync(out, 'utf8')).ownerDid).toBe(key.did);
    expect(JSON.parse(log.mock.calls.at(-1)![0]).local).toMatchObject({ ownerDid: key.did, keyStore: 'keychain', role: 'requester' });
    expect(JSON.parse(log.mock.calls.at(-1)![0]).local.keyFile).toBeUndefined();
    const request = join(home, 'request.json');
    await inviteShareCommand('request-reissue', ['--file', peer.file, '--out', request], options);
    expect(verifySigned(JSON.parse(fs.readFileSync(request, 'utf8')), key.did)).toBe(true);
    const worker = new KeychainKeyStore(module, options).createIfMissing('worker');
    const issued = incoming(home, worker), renewed = join(home, 'renewed.txt');
    await inviteShareCommand('reissue', ['--file', issued.file, '--out', renewed], options);
    expect(openInvite(fs.readFileSync(renewed, 'utf8')).ownerDid).toBe(worker.did);
    expect(entries.size).toBe(2);
    expect(fs.existsSync(join(root, 'identities'))).toBe(false);
  });

  it('retains default contacts and reciprocal output directories with keychain selection', async () => {
    const log = offline();
    const { options, home } = fixture();
    const contactsRoot = join(home, 'contacts-root');
    vi.stubEnv('ACP_DATA_DIR', contactsRoot);
    setApplicationKeyStore('keychain', options);
    const peer = incoming(home);
    await inviteShareCommand('open', ['--file', peer.file], options);
    const local = JSON.parse(log.mock.calls.at(-1)![0]).local;
    expect(dirname(local.reciprocalInviteFile)).toBe(contactsRoot);
    expect(loadContacts(join(contactsRoot, 'contacts.json'), local.ownerDid)).toMatchObject([{ ownerDid: peer.owner.did }]);
    expect(fs.existsSync(join(contactsRoot, 'owner.private.json'))).toBe(false);
  });

  it('keeps explicit files independent of unavailable keychains across the command paths', async () => {
    offline();
    const { options, home, loader, root } = fixture();
    setApplicationKeyStore('keychain', options);
    loader.mockRejectedValue(new Error('Unavailable'));
    const key = generateKeyPair(), path = join(home, 'explicit.json');
    const raw = JSON.stringify(key); put(path, raw);
    const post = postArgs(home);
    await boardCommand([...post.args, '--key', path], options);
    expect(verifySigned(JSON.parse(fs.readFileSync(post.out, 'utf8')), key.did)).toBe(true);
    const peer = incoming(home), contacts = join(home, 'contacts.json');
    await contactsCommand(['add', peer.token, '--key', path, '--file', contacts], options);
    const out = join(home, 'reciprocal.txt');
    await inviteShareCommand('open', ['--file', peer.file, '--key', path, '--contacts', contacts, '--out', out], options);
    expect(openInvite(fs.readFileSync(out, 'utf8')).ownerDid).toBe(key.did);
    const request = join(home, 'request.json');
    await inviteShareCommand('request-reissue', ['--file', peer.file, '--key', path, '--out', request], options);
    expect(verifySigned(JSON.parse(fs.readFileSync(request, 'utf8')), key.did)).toBe(true);
    vi.spyOn(AcpMcpServer.prototype, 'serve').mockImplementation(async function (this: AcpMcpServer) {
      const response = await this.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'acp_create_invite', arguments: {} } }) as any;
      expect(openInvite(JSON.parse(response.result.content[0].text).inviteToken).ownerDid).toBe(key.did);
    });
    await mcpServerCommand(['--key', path], options);
    expect(fs.readFileSync(path, 'utf8')).toBe(raw);
    expect(loader).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual(['config.json']);
  });

  it.each(['board', 'contacts', 'invite', 'mcp'] as const)('returns an unavailable selected keychain on %s without file fallback', async command => {
    offline();
    const { options, home, loader, root } = fixture();
    const fileKey = await resolveStoredIdentity('requester', { ...options, keyStore: 'file' });
    const keyPath = inspectLocalIdentity('requester', options).path;
    const raw = fs.readFileSync(keyPath);
    setApplicationKeyStore('keychain', options);
    loader.mockRejectedValue(new Error('Unavailable'));
    if (command === 'board') await expect(boardCommand(postArgs(home).args, options)).rejects.toThrow('KEY_STORE_UNAVAILABLE');
    if (command === 'contacts') await expect(contactsCommand(['list'], options)).rejects.toThrow('KEY_STORE_UNAVAILABLE');
    if (command === 'invite') {
      const peer = incoming(home);
      await expect(inviteShareCommand('request-reissue', ['--file', peer.file, '--out', join(home, 'request.json')], options))
        .rejects.toThrow('KEY_STORE_UNAVAILABLE');
      expect(fs.existsSync(join(home, 'request.json'))).toBe(false);
    }
    if (command === 'mcp') {
      vi.spyOn(AcpMcpServer.prototype, 'serve').mockImplementation(async function (this: AcpMcpServer) {
        const response = await this.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'acp_create_invite', arguments: {} } });
        expect(JSON.stringify(response)).toContain('KEY_STORE_UNAVAILABLE');
      });
      await mcpServerCommand([], options);
    }
    expect(fs.readFileSync(keyPath)).toEqual(raw);
    expect(inspectLocalIdentity('requester', options).key?.did).toBe(fileKey.did);
    expect(fs.existsSync(join(root, 'identities', 'worker.private.json'))).toBe(false);
  });
});
