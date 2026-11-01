// SPDX-License-Identifier: Apache-2.0
import { InviteStore, inspectStoredIdentity, openKeychainSecretStore } from '@acp/runtime';
import type { InviteStoreOptions } from '@acp/runtime';

const USAGE = 'Usage: sealbridge invites migrate --to keychain [--dry-run] [--key <file>]';

/** Selects the existing requester independently of the migration destination. */
export async function invitesMigrateCommand(args: string[], options: InviteStoreOptions = {}): Promise<void> {
  if (args.length === 1 && args[0] === '--help') { console.log(USAGE); return; }
  let target: string | undefined, key: string | undefined, dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--to' && target === undefined && args[i + 1]) target = args[++i];
    else if (args[i] === '--key' && key === undefined && args[i + 1] && !args[i + 1].startsWith('--')) key = args[++i];
    else if (args[i] === '--dry-run' && !dryRun) dryRun = true;
    else throw new Error(USAGE);
  }
  if (target !== 'keychain') throw new Error(USAGE);
  const selected = { ...options, explicitKeyPath: key ?? options.explicitKeyPath };
  const owner = (await inspectStoredIdentity('requester', selected)).key;
  if (!owner) { console.log(JSON.stringify({ count: 0, dryRun })); return; }
  const secretStore = options.secretStore ?? await openKeychainSecretStore(selected);
  const store = new InviteStore(owner, { ...selected, secretStore });
  console.log(JSON.stringify(store.migrateToKeychain(dryRun)));
}
