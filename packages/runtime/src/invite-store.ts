// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, digestBytes, inviteTokenFromUri, parseAndVerifyInviteToken, signPayload, verifySigned } from '@acp/core';
import type { Invite, KeyPair, Signed } from '@acp/core';
import { checkPath, inspectDirectory, privateDirectory, readPrivateFile, resolveDataRoot, writePrivateFile } from './local-identity.js';
import type { LocalIdentityOptions } from './local-identity.js';
import { selectApplicationRelay } from './relay-selection.js';
import type { RelaySelectionOptions } from './relay-selection.js';

interface StoredInvite {
  id: string;
  alias: string;
  displayName: string;
  ownerDid: string;
  agentDid: string;
  relayUrl: string;
  inviteToken: string;
  inviteDigest: string;
  importedAt: string;
  effectiveExpiresAt: string;
}
interface StoredInvites {
  type: 'StoredInvites';
  version: 1;
  localOwnerDid: string;
  entries: StoredInvite[];
}
export interface SavedInvite {
  workerRef: string;
  alias: string;
  displayName: string;
  ownerDid: string;
  agentDid: string;
  relayUrl: string;
  importedAt: string;
  effectiveExpiresAt: string;
  status: 'current' | 'expired';
}
export interface InviteStoreOptions extends LocalIdentityOptions {
  now?: () => number;
  relayPolicy?: RelaySelectionOptions;
}
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const aliasPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
function exactKeys(value: object, keys: string): boolean {
  return Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
}
/** Owner-scoped bearer invitations. Public results deliberately omit the token. */
export class InviteStore {
  readonly path: string;
  private readonly root: string;
  private readonly directory: string;
  private readonly io: typeof fs;
  private readonly now: () => number;
  constructor(private readonly owner: KeyPair, private readonly options: InviteStoreOptions = {}) {
    this.root = resolveDataRoot(options);
    this.directory = join(this.root, 'invites');
    this.path = join(this.directory, digestBytes(owner.did).slice(7) + '.json');
    this.io = options.fs ?? fs;
    this.now = options.now ?? Date.now;
  }
  private verify(token: string, now: number, allowExpired = false, historical = false): Invite {
    const invite = parseAndVerifyInviteToken(token, now, {
      allowExpired, allowPrivateRelay: historical || this.options.relayPolicy?.allowPrivateRelay,
    });
    if (invite.ownerDid === this.owner.did) throw new Error('SELF_DELEGATION_NOT_ALLOWED');
    return invite;
  }
  private entry(token: string, alias: string, importedAt: string, invite: Invite): StoredInvite {
    const inviteDigest = digest(invite);
    return {
      id: digest({ localOwnerDid: this.owner.did, inviteDigest }).slice(7), alias,
      displayName: invite.agentCard.payload.name, ownerDid: invite.ownerDid,
      agentDid: invite.agentDid, relayUrl: invite.relayUrl, inviteToken: token, inviteDigest, importedAt,
      effectiveExpiresAt: new Date(Math.min(Date.parse(invite.expiresAt),
        Date.parse(invite.agentCard.payload.expiresAt))).toISOString(),
    };
  }
  private read(): StoredInvite[] {
    try {
      for (const path of [this.root, this.directory]) {
        try { inspectDirectory(path, this.io); }
        catch (error) { if (code(error) !== 'ENOENT') throw error; }
      }
      const contents = readPrivateFile(this.path, this.io, MAX_STORE_BYTES);
      if (contents === undefined) return [];
      const signed = JSON.parse(contents) as Signed<StoredInvites>;
      const p = signed.payload;
      if (!exactKeys(signed, 'payload,signature') || !verifySigned(signed, this.owner.did) ||
          !exactKeys(p, 'type,version,localOwnerDid,entries') || p.type !== 'StoredInvites' ||
          p.version !== 1 || p.localOwnerDid !== this.owner.did || !Array.isArray(p.entries)) throw new Error();
      const ids = new Set<string>(), aliases = new Set<string>();
      for (const e of p.entries) {
        if (!e || !exactKeys(e, 'id,alias,displayName,ownerDid,agentDid,relayUrl,inviteToken,inviteDigest,importedAt,effectiveExpiresAt') ||
            Object.values(e).some(v => typeof v !== 'string') || !aliasPattern.test(e.alias) ||
            !Number.isFinite(Date.parse(e.importedAt)) || Date.parse(e.importedAt) > this.now() ||
            ids.has(e.id) || aliases.has(e.alias)) throw new Error();
        // Check historic import validity and all persisted metadata against the signed token.
        const invite = this.verify(e.inviteToken, Date.parse(e.importedAt), false, true);
        this.verify(e.inviteToken, this.now(), true, true);
        if (e.inviteToken !== inviteTokenFromUri(e.inviteToken) ||
            digest(e) !== digest(this.entry(e.inviteToken, e.alias, e.importedAt, invite))) throw new Error();
        ids.add(e.id); aliases.add(e.alias);
      }
      return p.entries;
    } catch { throw new Error('INVITE_STORE_INVALID'); }
  }
  private publicEntry(e: StoredInvite): SavedInvite {
    const { alias, displayName, ownerDid, agentDid, relayUrl, importedAt, effectiveExpiresAt } = e;
    return { workerRef: 'saved:' + e.id, alias, displayName, ownerDid, agentDid, relayUrl,
      importedAt, effectiveExpiresAt, status: Date.parse(effectiveExpiresAt) <= this.now() ? 'expired' : 'current' };
  }
  list(): SavedInvite[] { return this.read().map(e => this.publicEntry(e)); }
  /** Strict validation occurs on every resolution; an expired invite never becomes a DID target. */
  resolve(workerRef: string): { inviteToken: string; invite: Invite } {
    const e = this.find(this.read(), workerRef);
    if (!e) throw new Error('INVITE_NOT_FOUND');
    const invite = this.verify(e.inviteToken, this.now());
    selectApplicationRelay({ ...this.options.relayPolicy, inviteRelay: invite.relayUrl });
    return { inviteToken: e.inviteToken, invite };
  }
  private find(entries: StoredInvite[], ref: string): StoredInvite | undefined {
    return entries.find(e => ref === 'saved:' + e.id || ref === e.alias);
  }
  private mutate<T>(change: (entries: StoredInvite[]) => { entries: StoredInvite[]; result: T; changed: boolean }): T {
    const lock = this.path + '.lock';
    const temporary = join(this.directory, '.' + randomUUID() + '.tmp');
    let locked = false, written = false;
    try {
      privateDirectory(this.root, this.io);
      privateDirectory(this.directory, this.io);
      try { writePrivateFile(lock, Buffer.from(String(process.pid) + '\n'), this.io); locked = true; }
      catch (error) {
        if (code(error) === 'EEXIST') throw new Error('INVITE_STORE_BUSY');
        throw error;
      }
      const { entries, result, changed } = change(this.read());
      if (!changed) return result;
      const bytes = Buffer.from(JSON.stringify(signPayload<StoredInvites>({
        type: 'StoredInvites', version: 1, localOwnerDid: this.owner.did, entries,
      }, this.owner, new Date(this.now()).toISOString())) + '\n');
      if (bytes.length > MAX_STORE_BYTES) throw new Error('INVITE_STORE_INVALID');
      writePrivateFile(temporary, bytes, this.io); written = true;
      checkPath(this.path, this.io);
      this.io.renameSync(temporary, this.path); written = false;
      return result;
    } catch (error) {
      if (error instanceof Error && /^(INVITE_|ALIAS_|INVALID_ALIAS)/.test(error.message)) throw error;
      throw new Error('INVITE_STORE_INVALID');
    } finally {
      if (written) this.io.unlinkSync(temporary);
      if (locked) this.io.unlinkSync(lock);
    }
  }
  import(link: string, alias?: string): SavedInvite {
    const now = this.now();
    const invite = this.verify(link, now);
    selectApplicationRelay({ ...this.options.relayPolicy, inviteRelay: invite.relayUrl });
    if (alias !== undefined && !aliasPattern.test(alias)) throw new Error('INVALID_ALIAS');
    const suffix = digest(invite).slice(7, 19);
    const slug = invite.agentCard.payload.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'worker';
    const entry = this.entry(inviteTokenFromUri(link), alias ?? slug + '-' + suffix, new Date(now).toISOString(), invite);
    return this.mutate(entries => {
      const duplicate = entries.find(e => e.inviteDigest === entry.inviteDigest);
      if (duplicate) {
        if (alias !== undefined && alias !== duplicate.alias) throw new Error('ALIAS_EXISTS');
        return { entries, result: this.publicEntry(duplicate), changed: false };
      }
      if (entries.some(e => e.alias === entry.alias)) throw new Error('ALIAS_EXISTS');
      return { entries: [...entries, entry], result: this.publicEntry(entry), changed: true };
    });
  }
  remove(workerRef: string): boolean {
    return this.mutate(entries => {
      const entry = this.find(entries, workerRef);
      return { entries: entries.filter(e => e !== entry), result: !!entry, changed: !!entry };
    });
  }
}
