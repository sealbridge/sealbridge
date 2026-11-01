// SPDX-License-Identifier: Apache-2.0
import type { KeyPair } from '@acp/core';
import type { RelayTransport } from '@acp/relay';
import { inspectStoredIdentity, RequesterPendingStore } from '@acp/runtime';
import type { InviteStoreOptions } from '@acp/runtime';
import { networkCommand } from './network.js';

export async function pendingCommand(args: string[], application: {
  identityOptions?: InviteStoreOptions; fetch?: typeof fetch;
  transportFactory?: (url: string, owner: KeyPair) => RelayTransport;
} = {}): Promise<void> {
  const usage = 'Usage: sealbridge pending list [--key FILE] | resubmit ID [delegate approval/relay/audit/output options] | remove ID [--key FILE]';
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
  const [action, ...rest] = args;
  if (!['list', 'remove', 'resubmit'].includes(action)) throw new Error(usage);
  const id = action === 'list' ? undefined : rest.shift();
  if (action !== 'list' && (!id || id.startsWith('--'))) throw new Error(usage);
  const keyIndex = rest.indexOf('--key');
  if (keyIndex >= 0 && (!rest[keyIndex + 1] || rest[keyIndex + 1].startsWith('--'))) throw new Error(usage);
  const identityOptions = { ...application.identityOptions,
    explicitKeyPath: keyIndex >= 0 ? rest[keyIndex + 1] : application.identityOptions?.explicitKeyPath };
  if (action !== 'resubmit' && rest.some((_, index) => keyIndex < 0 || (index !== keyIndex && index !== keyIndex + 1)))
    throw new Error(usage);
  const owner = (await inspectStoredIdentity('requester', identityOptions)).key;
  if (!owner) {
    if (action === 'list') { console.log(JSON.stringify({ requests: [] })); return; }
    throw new Error('PENDING_NOT_FOUND');
  }
  const store = new RequesterPendingStore(owner, identityOptions);
  if (action === 'list') { console.log(JSON.stringify({ requests: store.list() })); return; }
  if (action === 'remove') { store.remove(id!); console.log(JSON.stringify({ removed: id })); return; }
  const allowed = new Set(['--key', '--relay', '--audit', '--out', '--auto-approve', '--yes', '--allow-private-relay', '--verbose',
    '--execution-timeout-ms', '--task-timeout-ms', '--wait-timeout-ms', '--connect-timeout-ms',
    '--transport-idle-timeout-ms', '--heartbeat-interval-ms', '--relay-auth-retries', '--relay-auth-recovery-timeout-ms']);
  for (const arg of rest) if (arg.startsWith('--') && !allowed.has(arg)) throw new Error('INVALID_PENDING_OPTION');
  if (keyIndex < 0 && identityOptions.explicitKeyPath) rest.push('--key', identityOptions.explicitKeyPath);
  await store.resubmit(id!, (request, relayUrl) => networkCommand('delegate', rest,
    { ...application, pendingRequest: request, pendingRelayUrl: relayUrl, onDelegated: () => store.resolve(id!) }));
}
