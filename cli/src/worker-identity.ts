// SPDX-License-Identifier: Apache-2.0
import { migrateWorkerIdentity, revokeWorkerIdentity } from '@acp/runtime';
import type { IdentityStoreOptions } from '@acp/runtime';
export async function workerIdentityCommand(action: string, args: string[], options: IdentityStoreOptions = {}) {
  if (args.includes('--help')) {
    console.log('Usage: sealbridge worker migrate|revoke-delegate [--dry-run | --apply]\nStop old workers before applying migration. Keys and connection stores are retained; backups are under <data-root>/worker-delegation/backups/.');
    return;
  }
  if (args.some(a => !['--dry-run', '--apply'].includes(a)) ||
      (args.includes('--dry-run') && args.includes('--apply'))) throw new Error('INVALID_WORKER_MIGRATION_OPTIONS');
  const result = await (action === 'migrate' ? migrateWorkerIdentity : revokeWorkerIdentity)(options, !args.includes('--apply'));
  console.log(JSON.stringify(result, null, 2));
}
