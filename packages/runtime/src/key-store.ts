// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { createHash, createPrivateKey } from 'node:crypto';
import { join } from 'node:path';
import { generateKeyPair, signPayload, verifySigned } from '@acp/core';
import type { KeyPair } from '@acp/core';
import {
  inspectLocalIdentity, resolveOrCreateIdentity, resolveDataRoot,
  ensurePrivateDirectory, checkPrivatePath, checkPrivateStat,
} from './local-identity.js';
import type { IdentityRole, LocalIdentityOptions, LocalIdentity } from './local-identity.js';
import { readApplicationConfig } from './application-config.js';

type Result<T> = T | Promise<T>;
export interface KeyStoreDescription {
  backend: string;
  location: string;
  source?: LocalIdentity['source'];
}
/** Embedders implement createIfMissing without replacing an existing identity. */
export interface KeyStore {
  load(role: IdentityRole): Result<KeyPair | undefined>;
  createIfMissing(role: IdentityRole): Result<KeyPair>;
  exists(role: IdentityRole): Result<boolean>;
  /** Descriptions contain only backend and location metadata. */
  describe(role: IdentityRole): Result<KeyStoreDescription>;
}
export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
}
export interface KeyringModule {
  Entry: new (service: string, account: string, options?: { linux: { store: 'secret-service' } }) => KeyringEntry;
}
export interface IdentityStoreOptions extends LocalIdentityOptions {
  /** Precedence: option, environment, application config, then file. */
  keyStore?: 'file' | 'keychain' | KeyStore;
  /** Optional native module loader, also usable by hosts and offline tests. */
  keyringLoader?: () => Promise<KeyringModule>;
}
export interface StoredIdentity extends KeyStoreDescription {
  present: boolean;
  key?: KeyPair;
}
const failure = (code: string) => new Error(code);

function validateKey(key: KeyPair): KeyPair {
  try {
    if (!key || typeof key.did !== 'string' || typeof key.privateKey !== 'string' ||
        createPrivateKey(key.privateKey).asymmetricKeyType !== 'ed25519' ||
        !verifySigned(signPayload({ type: 'LocalIdentityCheck' }, key,
          '2026-01-01T00:00:00.000Z'), key.did)) throw failure('IDENTITY_INVALID');
    return key;
  } catch { throw failure('IDENTITY_INVALID'); }
}

/** File paths, legacy selection, validation and publication retain their existing implementation. */
export class FileKeyStore implements KeyStore {
  constructor(readonly options: LocalIdentityOptions = {}) {}
  load(role: IdentityRole): KeyPair | undefined { return inspectLocalIdentity(role, this.options).key; }
  createIfMissing(role: IdentityRole): KeyPair { return resolveOrCreateIdentity(role, this.options); }
  exists(role: IdentityRole): boolean { return this.load(role) !== undefined; }
  describe(role: IdentityRole): KeyStoreDescription {
    const selected = inspectLocalIdentity(role, this.options);
    return { backend: 'file', location: selected.path, source: selected.source };
  }
}

/** Stable service name scoped to the normalized absolute data root; accounts are role names. */
export function keychainService(options: LocalIdentityOptions = {}): string {
  return 'sealbridge:' + createHash('sha256').update(resolveDataRoot(options)).digest('hex');
}

export class KeychainKeyStore implements KeyStore {
  private readonly service: string;
  constructor(private readonly module: KeyringModule, readonly options: LocalIdentityOptions = {}) {
    this.service = keychainService(options);
  }
  describe(role: IdentityRole): KeyStoreDescription {
    return { backend: 'keychain', location: this.service + '/' + role };
  }
  private entry(role: IdentityRole): KeyringEntry {
    return new this.module.Entry(this.service, role, { linux: { store: 'secret-service' } });
  }
  private secret(role: IdentityRole): string | null {
    try { return this.entry(role).getPassword(); }
    catch { throw failure('KEY_STORE_UNAVAILABLE'); }
  }
  exists(role: IdentityRole): boolean { return this.secret(role) !== null; }
  load(role: IdentityRole): KeyPair | undefined {
    const secret = this.secret(role);
    if (secret === null) return undefined;
    try {
      if (Buffer.byteLength(secret) > 16 * 1024) throw failure('IDENTITY_INVALID');
      const jwk = JSON.parse(secret);
      if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string' ||
          typeof jwk.kid !== 'string') throw failure('IDENTITY_INVALID');
      const privateKey = createPrivateKey({ key: jwk, format: 'jwk' })
        .export({ type: 'pkcs8', format: 'pem' }).toString();
      return validateKey({ did: jwk.kid, privateKey });
    } catch { throw failure('IDENTITY_INVALID'); }
  }
  createIfMissing(role: IdentityRole): KeyPair {
    const existing = this.load(role);
    if (existing) return existing;
    const io = this.options.fs ?? fs;
    const platform = this.options.platform ?? process.platform;
    const root = resolveDataRoot(this.options);
    const lock = join(root, '.keychain-' + role + '.lock');
    let fd: number | undefined;
    try {
      ensurePrivateDirectory(root, io, platform);
      checkPrivatePath(lock, io, platform);
      // The lock contains no key material and coordinates Sealbridge writers across processes.
      fd = io.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      checkPrivateStat(io.fstatSync(fd));
      const winner = this.load(role);
      if (winner) return winner;
      const key = generateKeyPair();
      const jwk = createPrivateKey(key.privateKey).export({ format: 'jwk' });
      try { this.entry(role).setPassword(JSON.stringify({ ...jwk, kid: key.did })); }
      catch { throw failure('KEY_STORE_UNAVAILABLE'); }
      const stored = this.load(role);
      if (!stored || stored.did !== key.did) throw failure('KEY_STORE_CONFLICT');
      return stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw failure('KEY_STORE_BUSY');
      if (error instanceof Error && /^(IDENTITY_|KEY_STORE_)/.test(error.message)) throw error;
      throw failure('IDENTITY_STORE_UNWRITABLE');
    } finally {
      if (fd !== undefined) { io.closeSync(fd); io.unlinkSync(lock); }
    }
  }
}

async function optionalKeyring(options: IdentityStoreOptions, required: boolean): Promise<KeyringModule | undefined> {
  // A variable specifier keeps the native package optional for TypeScript and packaging.
  const name = '@napi-rs/keyring';
  try {
    const module: KeyringModule = await (options.keyringLoader ? options.keyringLoader() : import(name));
    if (typeof module.Entry !== 'function') throw failure('KEY_STORE_UNAVAILABLE');
    return module;
  } catch {
    if (required) throw failure('KEY_STORE_UNAVAILABLE');
    return undefined;
  }
}

export interface KeyStoreSelection {
  keyStore: 'file' | 'keychain' | KeyStore;
  source: 'option' | 'env' | 'config' | 'default';
}

/** Resolve selection metadata without loading a backend or creating an identity. */
export function keyStoreSelection(options: IdentityStoreOptions = {}): KeyStoreSelection {
  if (options.explicitKeyPath !== undefined) return { keyStore: 'file', source: 'option' };
  const env = options.env ?? process.env;
  let keyStore = options.keyStore ?? env.SEALBRIDGE_KEY_STORE;
  let source: KeyStoreSelection['source'] = options.keyStore !== undefined ? 'option' : 'env';
  if (keyStore === undefined) {
    // Relay opt-in is evaluated by relay consumers, independently of identity storage.
    keyStore = readApplicationConfig({ ...options, allowPrivateRelay: true }).keyStore;
    source = keyStore === undefined ? 'default' : 'config';
  }
  if (keyStore !== undefined && keyStore !== 'file' && keyStore !== 'keychain' &&
      (typeof keyStore !== 'object' || keyStore === null)) throw failure('KEY_STORE_INVALID');
  return { keyStore: keyStore ?? 'file', source };
}

/** Inspect the other backend without creating entries; optional keychain inspection may be unavailable. */
export async function otherKeyStorePresence(selected: 'file' | 'keychain', options: IdentityStoreOptions = {}): Promise<string[]> {
  const module = selected === 'file' ? await optionalKeyring(options, false) : undefined;
  if (selected === 'file' && !module) return ['keychain: inspection unavailable'];
  const other = selected === 'file' ? new KeychainKeyStore(module!, options) : new FileKeyStore(options);
  const warnings: string[] = [];
  for (const role of ['requester', 'worker'] as const) {
    try {
      if (await other.exists(role)) warnings.push(`${role}: identity also present in ${selected === 'file' ? 'keychain' : 'file'} backend; no identity was moved`);
    } catch (error) {
      warnings.push(`${role}: other backend inspection returned ${(error as Error).message}`);
    }
  }
  return warnings;
}

/** Explicit file paths always bypass backend configuration and optional module loading. */
export async function selectKeyStore(role: IdentityRole, options: IdentityStoreOptions = {}): Promise<KeyStore> {
  if (options.explicitKeyPath !== undefined) return new FileKeyStore(options);
  const selection = keyStoreSelection(options);
  const selected = selection.source === 'default' ? undefined : selection.keyStore;
  if (selected !== undefined && typeof selected === 'object' && selected !== null) return selected;
  if (selected === 'file') return new FileKeyStore(options);
  if (selected !== undefined && selected !== 'keychain') throw failure('KEY_STORE_INVALID');
  const module = await optionalKeyring(options, selected === 'keychain');
  if (selected === 'keychain') return new KeychainKeyStore(module!, options);
  const file = new FileKeyStore(options);
  let keychainPresent = false;
  if (module) {
    try { keychainPresent = new KeychainKeyStore(module, options).exists(role); }
    catch (error) {
      // No keychain was selected; retain file operation when inspection is unavailable.
      if (!(error instanceof Error) || error.message !== 'KEY_STORE_UNAVAILABLE') throw error;
    }
  }
  if (keychainPresent) {
    if (file.exists(role)) throw failure('KEY_STORE_CONFLICT');
    throw failure('KEY_STORE_SELECTION_REQUIRED');
  }
  return file;
}

/** Read-only inspection used by doctor and peer review; never creates an identity. */
export async function inspectStoredIdentity(role: IdentityRole, options: IdentityStoreOptions = {}): Promise<StoredIdentity> {
  const store = await selectKeyStore(role, options);
  const description = await store.describe(role);
  const key = await store.load(role);
  return { ...description, present: key !== undefined, key: key === undefined ? undefined : validateKey(key) };
}

/** Resolve the configured store, preserving its create-if-missing semantics. */
export async function resolveStoredIdentity(role: IdentityRole, options: IdentityStoreOptions = {}): Promise<KeyPair> {
  const store = await selectKeyStore(role, options);
  const existing = await store.load(role);
  return validateKey(existing ?? await store.createIfMissing(role));
}
