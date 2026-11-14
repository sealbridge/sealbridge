// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digestBytes, signPayload, verifySigned } from '@acp/core';
import type { KeyPair, Signed } from '@acp/core';
import type { IdentityStoreOptions } from './key-store.js';
import { checkPath, inspectDirectory, privateDirectory, readPrivateFile, resolveDataRoot, writePrivateFile } from './local-identity.js';
import type { ConnectionSummary } from './connection-records.js';

const aliasPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export function defaultConnectionAlias(displayName?: string): string {
  return displayName?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'peer';
}
interface Aliases { type: 'ConnectionAliases'; version: 1; localOwnerDid: string; aliases: Record<string, string> }
/** A separate owner-signed sidecar keeps strict older connection-store readers compatible. */
export class ConnectionAliases {
  readonly path: string;
  private readonly io: typeof fs;
  private readonly directory: string;
  constructor(private readonly owner: KeyPair, private readonly options: IdentityStoreOptions = {}) {
    this.io = options.fs ?? fs;
    this.directory = join(resolveDataRoot(options), 'connection-aliases');
    this.path = join(this.directory, digestBytes(owner.did).slice(7) + '.json');
  }
  private read(): Record<string, string> {
    for (const path of [resolveDataRoot(this.options), this.directory]) {
      try { inspectDirectory(path, this.io, this.options.platform); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const bytes = readPrivateFile(this.path, this.io, 256 * 1024, this.options.platform);
    if (bytes === undefined) return {};
    try {
      const signed = JSON.parse(bytes) as Signed<Aliases>, p = signed.payload;
      if (!verifySigned(signed, this.owner.did) || p.type !== 'ConnectionAliases' || p.version !== 1 ||
          p.localOwnerDid !== this.owner.did || !p.aliases || Array.isArray(p.aliases) || typeof p.aliases !== 'object' ||
          Object.entries(p.aliases).some(([did, alias]) => !did.startsWith('did:') || typeof alias !== 'string' || !aliasPattern.test(alias)))
        throw new Error();
      return p.aliases;
    } catch { throw new Error('CONNECTION_ALIAS_STORE_INVALID'); }
  }
  list<T extends ConnectionSummary>(connections: T[]): Array<T & { alias: string }> {
    const aliases = this.read();
    return connections.map(c => ({ ...c, alias: aliases[c.peerOwnerDid] ?? defaultConnectionAlias(c.peerDisplayName) }));
  }
  rename(peerOwnerDid: string, alias: string, connections: ConnectionSummary[]): void {
    if (!aliasPattern.test(alias)) throw new Error('INVALID_CONNECTION_ALIAS: use 1–64 lowercase letters, digits, _ or -');
    if (!connections.some(c => c.peerOwnerDid === peerOwnerDid)) throw new Error('CONNECTION_NOT_FOUND');
    privateDirectory(resolveDataRoot(this.options), this.io, this.options.platform);
    privateDirectory(this.directory, this.io, this.options.platform);
    const lock = this.path + '.lock', temporary = join(this.directory, '.' + randomUUID() + '.tmp');
    try { writePrivateFile(lock, Buffer.from(String(process.pid)), this.io, this.options.platform); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('CONNECTION_ALIAS_STORE_BUSY'); throw error; }
    let written = false;
    try {
      const aliases = this.read();
      if (connections.some(c => c.peerOwnerDid !== peerOwnerDid &&
          (aliases[c.peerOwnerDid] ?? defaultConnectionAlias(c.peerDisplayName)) === alias)) throw new Error('CONNECTION_ALIAS_EXISTS');
      aliases[peerOwnerDid] = alias;
      const bytes = Buffer.from(JSON.stringify(signPayload<Aliases>({ type: 'ConnectionAliases', version: 1,
        localOwnerDid: this.owner.did, aliases }, this.owner)) + '\n');
      if (bytes.length > 256 * 1024) throw new Error('CONNECTION_ALIAS_STORE_FULL');
      writePrivateFile(temporary, bytes, this.io, this.options.platform); written = true;
      checkPath(this.path, this.io, this.options.platform);
      this.io.renameSync(temporary, this.path); written = false;
    } finally {
      if (written) this.io.unlinkSync(temporary);
      this.io.unlinkSync(lock);
    }
  }
}
