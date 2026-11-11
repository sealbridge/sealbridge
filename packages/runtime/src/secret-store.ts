// SPDX-License-Identifier: Apache-2.0
/** Synchronous string operations allow existing InviteStore methods to retain their API. */
export interface SecretStore {
  get(id: string): string | undefined;
  set(id: string, value: string): void;
  /** Removing an already absent entry succeeds; callers verify absence after deletion. */
  delete(id: string): void;
}


export { KeychainSecretStore, openKeychainSecretStore } from '@acp/runtime-local/secret-store';
