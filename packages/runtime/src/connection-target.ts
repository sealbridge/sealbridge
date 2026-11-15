// SPDX-License-Identifier: Apache-2.0
import { isInviteTarget } from '@acp/core';
import type { KeyPair } from '@acp/core';
import { ConnectionAliases } from './connection-aliases.js';
import { inspectStoredIdentity } from './key-store.js';
import { InviteStore } from './invite-store.js';
import { WorkerTrustStore, workerIntakePath } from './worker-trust-store.js';
import type { InviteStoreOptions } from './invite-store.js';

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
  return new ConnectionAliases(key, options).list(store.listConnections()).map(c => ({ ...c, acceptance: 'acceptance' in c ? c.acceptance ?? 'folder-policy' : 'folder-policy', localOwnerDid: key.did }));
}
/** Explicit invite selectors keep their historical store/expiry semantics. Only CLI --to / MCP to names opt in. */
export async function connectionTarget(name: string, options: InviteStoreOptions = {}, selectedKeys?: KeyPair[]) {
  if (!name || isInviteTarget(name) || name.startsWith('did:') || name.startsWith('saved:')) return undefined;
  const keys = selectedKeys ?? await localConnectionKeys(options);
  const named = keys.flatMap(key => localConnections(key, options)
    .filter(c => c.alias === name).map(connection => ({ key, connection })));
  const matches = named.filter(m => m.connection.state === 'connected');
  // Active saved invitations preserve historical confirmation checks.
  const requester = keys[0];
  const saved = requester && (await InviteStore.open(requester, options)).list().find(i => i.alias === name);
  if (saved) {
    if (matches.some(m => m.connection.peerOwnerDid !== saved.ownerDid))
      throw new Error('CONNECTION_TARGET_CONFLICT: connected alias and saved invite identify different peers; rename the connection or use a saved: reference');
    if (saved.status !== 'expired' || !matches.length) return undefined;
  }
  if (matches.length > 1) throw new Error('CONNECTION_ALIAS_AMBIGUOUS: use connections list and rename by peer DID with --role or --key');
  if (!matches.length && named.length) throw new Error('CONNECTION_NOT_CONNECTED');
  if (!matches.length) throw new Error('CONNECTION_NOT_FOUND');
  return matches[0];
}

/** Advisory only: local consent never proves the peer's current execution policy. */
export function connectionAcceptanceWarning() {
  return { code: 'PEER_APPROVAL_MAY_BE_REQUIRED',
    message: 'This work may wait for the peer owner approval; current peer acceptance settings are not known locally.' };
}
export function connectionTargetGuidance(code: string) {
  const list = ' Use sealbridge connections list or acp_list_connections to see local names. / sealbridge connections list または acp_list_connections で名前を確認してください。';
  if (code === 'CONNECTION_NOT_FOUND') return 'Connection name was not found. / 指定した接続名が見つかりません。' + list;
  if (code === 'CONNECTION_ALIAS_AMBIGUOUS') return 'Connection name is ambiguous; rename by peer DID with connections alias and --role or --key. / 接続名が重複しています。DID と --role または --key を指定して別名に変更してください。' + list;
  if (code === 'CONNECTION_TARGET_CONFLICT') return 'Connection and saved invitation identify different peer DIDs; rename the connection or use a saved: reference. / 接続と保存済み招待の DID が異なります。接続名を変更するか saved: 参照を使ってください。' + list;
  if (code === 'CONNECTION_NOT_CONNECTED') return 'This peer is not connected. / この相手とは接続されていません。' + list;
  return undefined;
}
