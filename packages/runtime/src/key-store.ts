// SPDX-License-Identifier: Apache-2.0
import { createPrivateKey } from 'node:crypto';
import { signPayload, verifySigned } from '@acp/core';
import type { KeyPair } from '@acp/core';
import type { IdentityRole, LocalIdentityOptions, LocalIdentity } from './local-identity.js';
import { FileKeyStore, KeychainKeyStore, optionalKeyring } from '@acp/runtime-local/key-store';
export { FileKeyStore, KeychainKeyStore, optionalKeyring, keychainService } from '@acp/runtime-local/key-store';
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
  deletePassword?(): boolean | void;
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
