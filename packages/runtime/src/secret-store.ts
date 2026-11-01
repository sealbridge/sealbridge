// SPDX-License-Identifier: Apache-2.0
import { keychainService, optionalKeyring } from './key-store.js';
import type { IdentityStoreOptions, KeyringModule } from './key-store.js';

/** Synchronous string operations allow existing InviteStore methods to retain their API. */
export interface SecretStore {
  get(id: string): string | undefined;
  set(id: string, value: string): void;
  delete(id: string): void;
}

/** Uses the identity service with distinct invitation account names. */
export class KeychainSecretStore implements SecretStore {
  private readonly service: string;
  constructor(private readonly module: KeyringModule, options: IdentityStoreOptions = {}) {
    this.service = keychainService(options);
  }
  private entry(id: string) {
    if (!/^invite:[a-f0-9]{64}$/.test(id)) throw new Error('INVITE_SECRET_INVALID');
    return new this.module.Entry(this.service, id, { linux: { store: 'secret-service' } });
  }
  get(id: string): string | undefined {
    try { return this.entry(id).getPassword() ?? undefined; }
    catch { throw new Error('KEY_STORE_UNAVAILABLE'); }
  }
  set(id: string, value: string): void {
    try { this.entry(id).setPassword(value); }
    catch { throw new Error('KEY_STORE_UNAVAILABLE'); }
  }
  delete(id: string): void {
    try {
      const entry = this.entry(id);
      if (entry.getPassword() === null) return;
      if (!entry.deletePassword) throw new Error();
      entry.deletePassword();
      if (entry.getPassword() !== null) throw new Error();
    } catch { throw new Error('KEY_STORE_UNAVAILABLE'); }
  }
}

export async function openKeychainSecretStore(options: IdentityStoreOptions = {}): Promise<SecretStore> {
  return new KeychainSecretStore((await optionalKeyring(options, true))!, options);
}
