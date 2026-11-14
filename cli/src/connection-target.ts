// SPDX-License-Identifier: Apache-2.0
import { isInviteTarget } from '@acp/core';
import type { KeyPair } from '@acp/core';
import { ConnectionAliases, inspectStoredIdentity, InviteStore, WorkerTrustStore, workerIntakePath } from '@acp/runtime';
import type { InviteStoreOptions } from '@acp/runtime';

export async function localConnectionKeys(options: InviteStoreOptions = {}, role?: 'worker' | 'requester'): Promise<KeyPair[]> {
  const keys: KeyPair[] = [];
  for (const r of role ? [role] : ['requester', 'worker'] as const) {
    const key = (await inspectStoredIdentity(r, options)).key;
    if (key && !keys.some(k => k.did === key.did)) keys.push(key);
  }
  return keys;
}
export function localConnections(key: KeyPair, options: InviteStoreOptions = {}) {
  const store = new WorkerTrustStore(key, { path: workerIntakePath(key.did, options),
    fs: options.fs, platform: options.platform, now: options.now });
  return new ConnectionAliases(key, options).list(store.listConnections()).map(c => ({ ...c, localOwnerDid: key.did }));
}
/** Explicit invite selectors keep their historical store/expiry semantics. Only --to names opt in. */
export async function connectionTarget(name: string, options: InviteStoreOptions = {}) {
  if (!name || isInviteTarget(name) || name.startsWith('did:') || name.startsWith('saved:')) return undefined;
  const keys = await localConnectionKeys(options);
  const matches = keys.flatMap(key => localConnections(key, options)
    .filter(c => c.alias === name).map(connection => ({ key, connection })));
  if (matches.length > 1) throw new Error('CONNECTION_ALIAS_AMBIGUOUS: use connections list and rename by peer DID with --role or --key');
  if (!matches.length) return undefined;
  const match = matches[0];
  // A saved invitation alias must never silently turn into a different target or bypass expiry.
  const requester = keys[0];
  const saved = requester && (await InviteStore.open(requester, options)).list().find(i => i.alias === name);
  if (saved) throw new Error('CONNECTION_TARGET_CONFLICT: name also matches a saved invite; rename the connection or use its DID / saved: reference');
  if (match.connection.state !== 'connected') throw new Error('CONNECTION_NOT_CONNECTED');
  return match;
}
