// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, digestBytes, signPayload, verifySigned } from '@acp/core';
import type { KeyPair, Signed } from '@acp/core';
import type { IdentityStoreOptions } from './key-store.js';
import {
  checkPath,
  inspectDirectory,
  privateDirectory,
  readPrivateFile,
  resolveDataRoot,
  writePrivateFile,
} from './local-identity.js';
import { InviteStore } from './invite-store.js';
import type { ConnectionSummary } from './connection-records.js';

const aliasPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function defaultConnectionAlias(displayName?: string): string {
  return (
    displayName
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64) || 'peer'
  );
}
interface Aliases {
  type: 'ConnectionAliases';
  version: 1;
  localOwnerDid: string;
  aliases: Record<string, string>;
}
/** A separate owner-signed sidecar keeps strict older connection-store readers compatible. */
export class ConnectionAliases {
  readonly path: string;
  private readonly io: typeof fs;
  private readonly directory: string;
  constructor(
    private readonly owner: KeyPair,
    private readonly options: IdentityStoreOptions = {},
  ) {
    this.io = options.fs ?? fs;
    this.directory = join(resolveDataRoot(options), 'connection-aliases');
    this.path = join(this.directory, digestBytes(owner.did).slice(7) + '.json');
  }
  private read(): Record<string, string> {
    for (const path of [resolveDataRoot(this.options), this.directory]) {
      try {
        inspectDirectory(path, this.io, this.options.platform);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const bytes = readPrivateFile(this.path, this.io, 256 * 1024, this.options.platform);
    if (bytes === undefined) return {};
    try {
      const signed = JSON.parse(bytes) as Signed<Aliases>,
        p = signed.payload;
      if (
        !verifySigned(signed, this.owner.did) ||
        p.type !== 'ConnectionAliases' ||
        p.version !== 1 ||
        p.localOwnerDid !== this.owner.did ||
        !p.aliases ||
        Array.isArray(p.aliases) ||
        typeof p.aliases !== 'object' ||
        Object.entries(p.aliases).some(
          ([did, alias]) =>
            !did.startsWith('did:') || typeof alias !== 'string' || !aliasPattern.test(alias),
        )
      )
        throw new Error();
      return p.aliases;
    } catch {
      throw new Error('CONNECTION_ALIAS_STORE_INVALID');
    }
  }
  list<T extends ConnectionSummary>(connections: T[]): Array<T & { alias: string }> {
    const aliases = this.read();
    return connections.map((c) => ({
      ...c,
      alias: aliases[c.peerOwnerDid] ?? defaultConnectionAlias(c.peerDisplayName),
    }));
  }
  rename(
    peerOwnerDid: string,
    alias: string,
    connections: ConnectionSummary[],
    initialize = false,
  ) {
    if (!(initialize ? aliasPattern : /^[a-z0-9][a-z0-9_-]{0,63}$/).test(alias))
      throw new Error('INVALID_CONNECTION_ALIAS: use 1–64 lowercase letters, digits, _ or -');
    if (!connections.some((c) => c.peerOwnerDid === peerOwnerDid))
      throw new Error('CONNECTION_NOT_FOUND');
    privateDirectory(resolveDataRoot(this.options), this.io, this.options.platform);
    privateDirectory(this.directory, this.io, this.options.platform);
    const lock = this.path + '.lock',
      temporary = join(this.directory, '.' + randomUUID() + '.tmp');
    try {
      writePrivateFile(lock, Buffer.from(String(process.pid)), this.io, this.options.platform);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error(
          'CONNECTION_ALIAS_STORE_BUSY: check that no alias writer is alive before manually removing the lock file ' +
            lock,
        );
      throw error;
    }
    let written = false;
    try {
      const aliases = this.read();
      if (initialize && aliases[peerOwnerDid] !== undefined)
        return { alias: aliases[peerOwnerDid] };
      const savedAlias = alias;
      const used = new Set(
        connections
          .filter((c) => c.peerOwnerDid !== peerOwnerDid)
          .map((c) => aliases[c.peerOwnerDid] ?? defaultConnectionAlias(c.peerDisplayName)),
      );
      if (initialize)
        for (const [did, value] of Object.entries(aliases))
          if (did !== peerOwnerDid) used.add(value);
      const collision = used.has(alias);
      if (collision) {
        if (!initialize) throw new Error('CONNECTION_ALIAS_EXISTS');
        const base = defaultConnectionAlias(
          connections.find((c) => c.peerOwnerDid === peerOwnerDid)?.peerDisplayName,
        );
        alias = base;
        for (let n = 2; used.has(alias); n++)
          alias = base.slice(0, 64 - String(n).length - 1) + '-' + n;
      }
      aliases[peerOwnerDid] = alias;
      const bytes = Buffer.from(
        JSON.stringify(
          signPayload<Aliases>(
            { type: 'ConnectionAliases', version: 1, localOwnerDid: this.owner.did, aliases },
            this.owner,
          ),
        ) + '\n',
      );
      if (bytes.length > 256 * 1024) throw new Error('CONNECTION_ALIAS_STORE_FULL');
      writePrivateFile(temporary, bytes, this.io, this.options.platform);
      written = true;
      checkPath(this.path, this.io, this.options.platform);
      this.io.renameSync(temporary, this.path);
      written = false;
      return {
        alias,
        ...(collision
          ? {
              aliasWarning: {
                code: 'CONNECTION_ALIAS_EXISTS',
                savedAlias,
                message:
                  'Saved invite alias "' +
                  savedAlias +
                  '" is used by a different peer; connection name is "' +
                  alias +
                  '".' +
                  '\n保存した招待名 "' +
                  savedAlias +
                  '" は別の相手が使用中のため、接続名は "' +
                  alias +
                  '" になりました。',
              },
            }
          : {}),
      };
    } finally {
      if (written) this.io.unlinkSync(temporary);
      this.io.unlinkSync(lock);
    }
  }
}

/** Initialize only a new importer record. The verified invite digest selects saved metadata, never identity. */
export async function nameInviteConnection(
  owner: KeyPair,
  options: IdentityStoreOptions,
  inviteDigest: string,
  peer: ConnectionSummary,
  before: ConnectionSummary[],
  connections: ConnectionSummary[],
) {
  const aliases = new ConnectionAliases(owner, options);
  if (before.some((c) => c.peerOwnerDid === peer.peerOwnerDid)) return {};
  const saved = (await InviteStore.open(owner, options))
    .list()
    .find(
      (i) =>
        i.workerRef === 'saved:' + digest({ localOwnerDid: owner.did, inviteDigest }).slice(7) &&
        i.aliasExplicit === true &&
        i.ownerDid === peer.peerOwnerDid &&
        i.importState !== 'unconfirmed',
    );
  if (!saved) return { alias: aliases.list([peer])[0].alias };
  return aliases.rename(peer.peerOwnerDid, saved.alias, connections, true);
}
