// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPrivateKey } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPair } from '../packages/core/src/index.js';
import type { KeyPair } from '../packages/core/src/index.js';
import {
  FileKeyStore, KeychainKeyStore, inspectStoredIdentity, keychainService,
  resolveStoredIdentity, selectKeyStore,
} from '../packages/runtime/src/key-store.js';
import type { IdentityStoreOptions, KeyStore, KeyringModule } from '../packages/runtime/src/key-store.js';
import { inspectLocalIdentity, resolveDataRoot, resolveOrCreateIdentity } from '../packages/runtime/src/local-identity.js';
import { AcpMcpServer } from '../packages/runtime/src/mcp-server.js';
import { diagnose } from '../cli/src/doctor.js';
import { networkCommand } from '../cli/src/network.js';
import { requestsCommand } from '../cli/src/requests.js';

const roots: string[] = [];
function fixture() {
  const home = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'sealbridge-key-store-'));
  roots.push(home);
  const secrets = new Map<string, string>();
  const entryOptions: unknown[] = [];
  const module: KeyringModule = { Entry: class {
    readonly id: string;
    constructor(service: string, account: string, options: unknown) {
      this.id = service + '/' + account;
      entryOptions.push(options);
    }
    getPassword() { return secrets.get(this.id) ?? null; }
    setPassword(value: string) { secrets.set(this.id, value); }
  } };
  const loader = vi.fn(async () => module);
  const options: IdentityStoreOptions = {
    home, env: { SEALBRIDGE_DATA_DIR: join(home, 'data') }, keyringLoader: loader,
  };
  return { home, options, secrets, loader, module, entryOptions };
}
function put(path: string, key: KeyPair) {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path, JSON.stringify(key) + '\n', { mode: 0o600 });
}
function unavailable(): never { throw new Error('native store detail'); }
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('identity store selection', () => {
  it('keeps file bytes, canonical paths and role selection unchanged', async () => {
    const { options, loader } = fixture();
    const key = await resolveStoredIdentity('requester', options);
    const path = inspectLocalIdentity('requester', options).path;
    expect(fs.readFileSync(path, 'utf8') === JSON.stringify(key) + '\n').toBe(true);
    expect(resolveOrCreateIdentity('requester', options).did).toBe(key.did);
    const store = new FileKeyStore(options);
    expect(store.load('requester')?.did).toBe(key.did);
    expect(store.createIfMissing('requester').did).toBe(key.did);
    expect(store.exists('worker')).toBe(false);
    expect(await inspectStoredIdentity('requester', options)).toMatchObject({
      backend: 'file', location: path, source: 'default', present: true,
    });
    expect((await resolveStoredIdentity('worker', options)).did).not.toBe(key.did);
    expect(loader).toHaveBeenCalled();
    if (process.platform !== 'win32') {
      expect(fs.statSync(path).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dirname(path)).mode & 0o777).toBe(0o700);
    }
  });

  it('reuses legacy files without rewriting and retains legacy conflicts', async () => {
    const { home, options } = fixture();
    const key = generateKeyPair();
    const legacy = join(home, '.acp', 'requester.private.json');
    put(legacy, key);
    const before = fs.readFileSync(legacy);
    expect((await resolveStoredIdentity('requester', options)).did).toBe(key.did);
    expect(await inspectStoredIdentity('requester', options)).toMatchObject({ source: 'legacy', location: legacy });
    expect(fs.readFileSync(legacy).equals(before)).toBe(true);
    const oldRoot = join(home, 'old');
    put(join(oldRoot, 'owner.private.json'), generateKeyPair());
    await expect(resolveStoredIdentity('requester', { ...options,
      env: { ...options.env, ACP_DATA_DIR: oldRoot } })).rejects.toThrow('IDENTITY_SELECTION_REQUIRED');
    expect(fs.existsSync(resolveDataRoot(options))).toBe(false);
  });

  it('gives explicit paths precedence over backend configuration and injection', async () => {
    const { home, options, loader } = fixture();
    const path = join(home, 'chosen.json');
    const key = generateKeyPair();
    put(path, key);
    const before = fs.readFileSync(path);
    for (const keyStore of ['keychain', {} as KeyStore] as const) {
      expect((await resolveStoredIdentity('worker', { ...options, explicitKeyPath: path, keyStore,
        env: { SEALBRIDGE_KEY_STORE: 'unknown' } })).did).toBe(key.did);
    }
    await expect(resolveStoredIdentity('worker', { ...options, keyStore: 'keychain',
      explicitKeyPath: path + '.missing' })).rejects.toThrow('IDENTITY_UNREADABLE');
    expect(fs.existsSync(path + '.missing')).toBe(false);
    expect(fs.readFileSync(path).equals(before)).toBe(true);
    expect(loader).not.toHaveBeenCalled();
  });

  it('validates environment selection and gives programmatic selection precedence', async () => {
    const { options, loader } = fixture();
    for (const value of ['', 'unknown', 'KEYCHAIN'])
      await expect(selectKeyStore('worker', { ...options, env: { ...options.env,
        SEALBRIDGE_KEY_STORE: value } })).rejects.toThrow('KEY_STORE_INVALID');
    const env = { ...options.env, SEALBRIDGE_KEY_STORE: 'keychain' };
    expect(await selectKeyStore('worker', { ...options, env })).toBeInstanceOf(KeychainKeyStore);
    loader.mockClear();
    expect(await selectKeyStore('worker', { ...options, env, keyStore: 'file' })).toBeInstanceOf(FileKeyStore);
    expect(loader).not.toHaveBeenCalled();
    expect(fs.existsSync(resolveDataRoot(options))).toBe(false);
  });

  it('retains the implicit file default when the optional package cannot load', async () => {
    const { options } = fixture();
    const keyringLoader = vi.fn(async () => unavailable());
    const key = await resolveStoredIdentity('worker', { ...options, keyringLoader });
    expect(inspectLocalIdentity('worker', options).key?.did).toBe(key.did);
    await expect(resolveStoredIdentity('requester', { ...options, keyringLoader,
      keyStore: 'keychain' })).rejects.toThrow('KEY_STORE_UNAVAILABLE');
    expect(inspectLocalIdentity('requester', options).key).toBeUndefined();
  });

  it('retains unconfigured file operation when credential inspection is unavailable', async () => {
    const { options } = fixture();
    const keyringLoader = async (): Promise<KeyringModule> => ({ Entry: class {
      getPassword(): never { return unavailable(); }
      setPassword(): never { return unavailable(); }
    } });
    const key = await resolveStoredIdentity('worker', { ...options, keyringLoader });
    expect(inspectLocalIdentity('worker', options).key?.did).toBe(key.did);
    await expect(resolveStoredIdentity('worker', { ...options, keyringLoader, keyStore: 'keychain' }))
      .rejects.toThrow(/^KEY_STORE_UNAVAILABLE$/);
  });

  it.each(['default', 'legacy'] as const)('requires explicit selection when keychain and %s file coexist', async source => {
    const { home, options } = fixture();
    const keychain = new KeychainKeyStore((await options.keyringLoader!()), options);
    const remoteKey = keychain.createIfMissing('worker');
    const fileKey = source === 'legacy' ? remoteKey : generateKeyPair();
    const path = source === 'default' ? inspectLocalIdentity('worker', options).path
      : join(home, '.acp', 'worker.private.json');
    put(path, fileKey);
    const before = fs.readFileSync(path);
    await expect(resolveStoredIdentity('worker', options)).rejects.toThrow('KEY_STORE_CONFLICT');
    expect((await resolveStoredIdentity('worker', { ...options, keyStore: 'keychain' })).did).toBe(remoteKey.did);
    expect((await resolveStoredIdentity('worker', { ...options, keyStore: 'file' })).did).toBe(fileKey.did);
    expect((await resolveStoredIdentity('worker', { ...options, explicitKeyPath: path })).did).toBe(fileKey.did);
    expect(fs.readFileSync(path).equals(before)).toBe(true);
  });

  it('does not automatically select an existing keychain-only identity', async () => {
    const { options, module } = fixture();
    new KeychainKeyStore(module, options).createIfMissing('requester');
    await expect(resolveStoredIdentity('requester', options)).rejects.toThrow('KEY_STORE_SELECTION_REQUIRED');
    expect(inspectLocalIdentity('requester', options).key).toBeUndefined();
    expect(fs.existsSync(join(resolveDataRoot(options), 'identities'))).toBe(false);
  });
});

describe('keychain identity storage', () => {
  it('stores private JWK JSON, reuses entries and separates roles and data roots', async () => {
    const { options, secrets, module, entryOptions } = fixture();
    const configured = { ...options, keyStore: 'keychain' as const };
    const key = await resolveStoredIdentity('worker', configured);
    expect((await resolveStoredIdentity('worker', configured)).did).toBe(key.did);
    const secret = JSON.parse(secrets.get(keychainService(options) + '/worker')!);
    expect(Object.keys(secret).sort()).toEqual(['crv', 'd', 'kid', 'kty', 'x']);
    expect(secret.kid).toBe(key.did);
    expect(secret.kty).toBe('OKP');
    expect(secret.crv).toBe('Ed25519');
    expect(typeof secret.d).toBe('string');
    expect(createPrivateKey({ key: secret, format: 'jwk' }).asymmetricKeyType).toBe('ed25519');
    expect((await resolveStoredIdentity('requester', configured)).did).not.toBe(key.did);
    const other = { ...options, env: { SEALBRIDGE_DATA_DIR: join(options.home!, 'other') } };
    expect(new KeychainKeyStore(module, other).exists('worker')).toBe(false);
    expect(keychainService(other)).not.toBe(keychainService(options));
    expect(keychainService({ ...options, env: { SEALBRIDGE_DATA_DIR: resolveDataRoot(options) + '/.' } }))
      .toBe(keychainService(options));
    expect(keychainService(options)).toMatch(/^sealbridge:[a-f0-9]{64}$/);
    expect(entryOptions.every(value => JSON.stringify(value) === '{"linux":{"store":"secret-service"}}')).toBe(true);
    expect(fs.readdirSync(resolveDataRoot(options))).toEqual([]);
  });

  it.each(['load', 'constructor', 'read', 'write'] as const)('returns a redacted unavailable error for %s failures', async stage => {
    const { options } = fixture();
    const module: KeyringModule = { Entry: class {
      constructor() { if (stage === 'constructor') unavailable(); }
      getPassword() { if (stage === 'read') unavailable(); return null; }
      setPassword() { unavailable(); }
    } };
    const configured = { ...options, keyStore: 'keychain' as const,
      keyringLoader: async () => { if (stage === 'load') unavailable(); return module; } };
    await expect(resolveStoredIdentity('worker', configured)).rejects.toThrow(/^KEY_STORE_UNAVAILABLE$/);
    expect(inspectLocalIdentity('worker', options).key).toBeUndefined();
    if (fs.existsSync(resolveDataRoot(options))) expect(fs.readdirSync(resolveDataRoot(options))).toEqual([]);
  });

  it.each(['{', '{}', 'x'.repeat(16385)])('retains an invalid existing entry (case %#)', async raw => {
    const { options, secrets } = fixture();
    const id = keychainService(options) + '/requester';
    secrets.set(id, raw);
    await expect(resolveStoredIdentity('requester', { ...options, keyStore: 'keychain' }))
      .rejects.toThrow(/^IDENTITY_INVALID$/);
    expect(secrets.get(id) === raw).toBe(true);
    expect(fs.existsSync(resolveDataRoot(options))).toBe(false);
  });

  it('rejects a JWK with a different DID without replacing it', async () => {
    const { options, secrets } = fixture();
    const jwk = createPrivateKey(generateKeyPair().privateKey).export({ format: 'jwk' });
    const raw = JSON.stringify({ ...jwk, kid: generateKeyPair().did });
    secrets.set(keychainService(options) + '/worker', raw);
    await expect(resolveStoredIdentity('worker', { ...options, keyStore: 'keychain' }))
      .rejects.toThrow(/^IDENTITY_INVALID$/);
    expect(secrets.get(keychainService(options) + '/worker') === raw).toBe(true);
  });

  it('leaves an existing creation lock and entry unchanged', () => {
    const { options, module, secrets } = fixture();
    const root = resolveDataRoot(options);
    fs.mkdirSync(root, { mode: 0o700 });
    const lock = join(root, '.keychain-worker.lock');
    fs.writeFileSync(lock, '', { mode: 0o600 });
    expect(() => new KeychainKeyStore(module, options).createIfMissing('worker')).toThrow('KEY_STORE_BUSY');
    expect(fs.existsSync(lock)).toBe(true);
    expect(secrets.size).toBe(0);
  });

  it('loads a concurrently created entry after acquiring the creation lock', () => {
    const { options, module, secrets } = fixture();
    const winner = generateKeyPair();
    const jwk = createPrivateKey(winner.privateKey).export({ format: 'jwk' });
    const io = { ...fs, openSync: ((...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args);
      if (String(args[0]).endsWith('.keychain-worker.lock'))
        secrets.set(keychainService(options) + '/worker', JSON.stringify({ ...jwk, kid: winner.did }));
      return fd;
    }) as typeof fs.openSync };
    expect(new KeychainKeyStore(module, { ...options, fs: io }).createIfMissing('worker').did).toBe(winner.did);
    expect(fs.readdirSync(resolveDataRoot(options))).toEqual([]);
  });
});

function memoryStore(): KeyStore & { keys: Map<string, KeyPair> } {
  const keys = new Map<string, KeyPair>();
  return {
    keys,
    load: vi.fn(async role => keys.get(role)),
    createIfMissing: vi.fn(async role => {
      if (!keys.has(role)) keys.set(role, generateKeyPair());
      return keys.get(role)!;
    }),
    exists: vi.fn(async role => keys.has(role)),
    describe: vi.fn(async role => ({ backend: 'embedded', location: 'app/' + role })),
  };
}

describe('embedding and application entry points', () => {
  it('uses injected stores without loading the native module or creating files', async () => {
    const { options, loader } = fixture();
    const store = memoryStore();
    const configured = { ...options, keyStore: store, env: { SEALBRIDGE_KEY_STORE: 'unknown' } };
    const key = await resolveStoredIdentity('worker', configured);
    expect((await resolveStoredIdentity('worker', configured)).did).toBe(key.did);
    expect(await inspectStoredIdentity('worker', configured)).toMatchObject({
      backend: 'embedded', location: 'app/worker', present: true,
    });
    expect(store.createIfMissing).toHaveBeenCalledTimes(1);
    expect(loader).not.toHaveBeenCalled();
    expect(fs.existsSync(resolveDataRoot(options))).toBe(false);
  });

  it('keeps MCP initialization and discovery lazy and shares one owner across signing calls', async () => {
    const { options } = fixture();
    const store = memoryStore();
    const server = new AcpMcpServer({ identityOptions: { ...options, keyStore: store },
      transportFactory: () => ({ discover: async () => [] } as never) });
    for (const method of ['initialize', 'tools/list', 'ping'])
      await server.handle({ jsonrpc: '2.0', id: 1, method });
    const call = (name: string, args = {}) => server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name, arguments: args } });
    await call('acp_discover_workers');
    expect(store.load).not.toHaveBeenCalled();
    const responses = await Promise.all([call('acp_create_invite'), call('acp_create_invite')]);
    expect(responses.every(value => !JSON.stringify(value).includes('"isError":true'))).toBe(true);
    expect(store.createIfMissing).toHaveBeenCalledTimes(1);
    expect(store.keys.has('requester')).toBe(true);
    expect(store.keys.has('worker')).toBe(false);
    expect(fs.existsSync(resolveDataRoot(options))).toBe(false);
  });

  it('uses the worker store for CLI invite signing and requests listing', async () => {
    const { options } = fixture();
    const store = memoryStore();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await networkCommand('invite', ['create'], { identityOptions: { ...options, keyStore: store } });
    expect(output.mock.calls[0][0]).toMatch(/^acp-invite:/);
    expect(store.keys.has('worker')).toBe(true);
    expect(store.keys.has('requester')).toBe(false);
    const reviewOutput = vi.fn();
    await requestsCommand(['list'], { identityOptions: { ...options, keyStore: store }, output: reviewOutput });
    expect(reviewOutput).toHaveBeenCalledWith('{"requests":[]}');
    expect(store.createIfMissing).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(join(resolveDataRoot(options), 'identities'))).toBe(false);
  });

  it('reports configured backend and presence offline without creating identities or fetching', async () => {
    const { options, module, secrets } = fixture();
    const fetch = vi.fn(async () => { throw new Error('unexpected fetch'); });
    const configured = { ...options, keyStore: 'keychain' as const };
    const absent = await diagnose({ identityOptions: configured, offline: true, fetch });
    expect(absent[2]).toMatchObject({ ok: true });
    expect(absent[2].message).toContain('[keychain]');
    expect(absent[2].message).toContain('created on first use');
    expect(secrets.size).toBe(0);
    expect(fs.existsSync(resolveDataRoot(options))).toBe(false);
    new KeychainKeyStore(module, options).createIfMissing('requester');
    const present = await diagnose({ identityOptions: configured, offline: true, fetch });
    expect(present[2].message).toContain('/requester (present) [keychain]');
    expect(present[2].message).toContain('/worker (created on first use) [keychain]');
    const failed = await diagnose({ identityOptions: { ...configured, keyringLoader: async () => unavailable() },
      offline: true, fetch });
    expect(failed[2]).toMatchObject({ ok: false });
    expect(failed[2].message).toContain('KEY_STORE_UNAVAILABLE');
    expect(failed[2].message).toContain('[keychain]');
    const conflict = await diagnose({ identityOptions: options, offline: true, fetch });
    expect(conflict[2]).toMatchObject({ ok: false, message: 'KEY_STORE_SELECTION_REQUIRED' });
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.readdirSync(resolveDataRoot(options))).toEqual([]);
  });

  it('honors environment file selection in the built CLI', async () => {
    const { options, home } = fixture();
    await promisify(execFile)(process.execPath, ['cli/dist/index.js', 'invite', 'create'], {
      env: { ...process.env, ...options.env, HOME: home, SEALBRIDGE_KEY_STORE: 'file' },
    });
    expect(inspectLocalIdentity('worker', options).key?.did).toMatch(/^did:key:/);
    expect(inspectLocalIdentity('requester', options).key).toBeUndefined();
  });
});
