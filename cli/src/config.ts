// SPDX-License-Identifier: Apache-2.0
import { setApplicationKeyStore } from '@acp/runtime/application-config';
import { keyStoreSelection, selectKeyStore, otherKeyStorePresence } from '@acp/runtime/key-store';
import type { IdentityStoreOptions } from '@acp/runtime/key-store';

const USAGE = 'Usage: sealbridge config key-store [file|keychain]';

/** Read or persist selection without moving or creating identities. */
export async function configCommand(args: string[], options: IdentityStoreOptions = {}): Promise<void> {
  if (args.length === 1 && args[0] === '--help') { console.log(USAGE); return; }
  if (args[0] !== 'key-store' || args.length > 2) throw new Error(USAGE);
  const value = args[1];
  if (value !== undefined) {
    if (value !== 'file' && value !== 'keychain') throw new Error('KEY_STORE_INVALID');
    const configured: IdentityStoreOptions = { ...options, explicitKeyPath: undefined, keyStore: value };
    for (const role of ['requester', 'worker'] as const)
      await (await selectKeyStore(role, configured)).exists(role);
    const warnings = await otherKeyStorePresence(value, configured);
    setApplicationKeyStore(value, { ...options, allowPrivateRelay: true });
    for (const warning of warnings) console.warn(warning);
  }
  const selection = keyStoreSelection(options);
  console.log(JSON.stringify({ keyStore: typeof selection.keyStore === 'object' ? 'custom' : selection.keyStore,
    source: selection.source }));
}
