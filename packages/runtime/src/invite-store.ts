// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, digestBytes, inviteTokenFromUri, parseAndVerifyInviteToken, signPayload, verifySigned } from '@acp/core';
import type { Invite, KeyPair, Signed } from '@acp/core';
import { checkPath, inspectDirectory, privateDirectory, readPrivateFile, resolveDataRoot, writePrivateFile } from './local-identity.js';
import { keyStoreSelection } from './key-store.js';
import type { IdentityStoreOptions } from './key-store.js';
import { openKeychainSecretStore } from './secret-store.js';
import type { SecretStore } from './secret-store.js';
import { selectApplicationRelay } from './relay-selection.js';
import type { RelaySelectionOptions } from './relay-selection.js';

interface StoredInvite {
  id: string;
  alias: string;
  displayName: string;
  ownerDid: string;
  agentDid: string;
  relayUrl: string;
  inviteToken?: string;
  inviteSecret?: string;
  tokenDigest?: string;
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
export interface InviteStoreOptions extends IdentityStoreOptions {
  /** External token storage; omitted file selection retains inline signed entries. */
  secretStore?: SecretStore;
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
  private secretStore?: SecretStore;
  /** Loads the optional backend; the constructor and synchronous methods remain available. */
  static async open(owner: KeyPair, options: InviteStoreOptions = {}): Promise<InviteStore> {
    const store = new InviteStore(owner, options);
    if (!options.secretStore && (store.selection() === 'keychain' ||
        store.readMetadata().some(e => e.inviteSecret !== undefined))) {
      store.secretStore = await openKeychainSecretStore(options);
    }
    return store;
  }
  private selection() {
    // An explicit identity file chooses the signer, independently of invitation storage.
    return keyStoreSelection({ ...this.options, explicitKeyPath: undefined }).keyStore;
  }
  constructor(private readonly owner: KeyPair, private readonly options: InviteStoreOptions = {}) {
    this.root = resolveDataRoot(options);
    this.directory = join(this.root, 'invites');
    this.path = join(this.directory, digestBytes(owner.did).slice(7) + '.json');
    this.io = options.fs ?? fs;
    this.now = options.now ?? Date.now;
    this.secretStore = options.secretStore;
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
  private readMetadata(): StoredInvite[] {
    try {
      for (const path of [this.root, this.directory]) {
        try { inspectDirectory(path, this.io, this.options.platform); }
        catch (error) { if (code(error) !== 'ENOENT') throw error; }
      }
      const contents = readPrivateFile(this.path, this.io, MAX_STORE_BYTES, this.options.platform);
      if (contents === undefined) return [];
      const signed = JSON.parse(contents) as Signed<StoredInvites>;
      const p = signed.payload;
      if (!exactKeys(signed, 'payload,signature') || !verifySigned(signed, this.owner.did) ||
          !exactKeys(p, 'type,version,localOwnerDid,entries') || p.type !== 'StoredInvites' ||
          p.version !== 1 || p.localOwnerDid !== this.owner.did || !Array.isArray(p.entries)) throw new Error();
      const ids = new Set<string>(), aliases = new Set<string>();
      for (const e of p.entries) {
        const external = e?.inviteSecret !== undefined;
        const fields = 'id,alias,displayName,ownerDid,agentDid,relayUrl,inviteDigest,importedAt,effectiveExpiresAt,';
        if (!e || !exactKeys(e, fields + (external ? 'inviteSecret,tokenDigest' : 'inviteToken')) ||
            Object.values(e).some(v => typeof v !== 'string') || !aliasPattern.test(e.alias) ||
            !Number.isFinite(Date.parse(e.importedAt)) || Date.parse(e.importedAt) > this.now() ||
            ids.has(e.id) || aliases.has(e.alias)) throw new Error();
        if (external && (e.inviteSecret !== 'invite:' + e.id || !/^[a-f0-9]{64}$/.test(e.id) ||
            !/^sha256:[a-f0-9]{64}$/.test(e.tokenDigest!))) throw new Error();
        if (!external) this.validateToken(e, e.inviteToken!);
        ids.add(e.id); aliases.add(e.alias);
      }
      return p.entries;
    } catch { throw new Error('INVITE_STORE_INVALID'); }
  }
  private validateToken(e: StoredInvite, token: string): void {
    try {
      const invite = this.verify(token, Date.parse(e.importedAt), false, true);
      this.verify(token, this.now(), true, true);
      const expected = this.entry(token, e.alias, e.importedAt, invite);
      if (e.inviteSecret !== undefined) {
        delete expected.inviteToken;
        expected.inviteSecret = 'invite:' + expected.id;
        expected.tokenDigest = digestBytes(token);
      }
      if (token !== inviteTokenFromUri(token) || digest(e) !== digest(expected)) throw new Error();
    } catch { throw new Error('INVITE_STORE_INVALID'); }
  }
  private token(e: StoredInvite): string {
    if (e.inviteToken !== undefined) return e.inviteToken;
    if (!this.secretStore) throw new Error('KEY_STORE_UNAVAILABLE');
    let token: string | undefined;
    try { token = this.secretStore.get(e.inviteSecret!); }
    catch { throw new Error('KEY_STORE_UNAVAILABLE'); }
    if (token === undefined) throw new Error('INVITE_SECRET_MISSING');
    if (digestBytes(token) !== e.tokenDigest) throw new Error('INVITE_SECRET_MISMATCH');
    this.validateToken(e, token);
    return token;
  }
  private read(): StoredInvite[] {
    const entries = this.readMetadata();
    for (const entry of entries) this.token(entry);
    return entries;
  }
  private externalize(e: StoredInvite): StoredInvite {
    if (!this.secretStore) throw new Error('KEY_STORE_UNAVAILABLE');
    const token = this.token(e), id = 'invite:' + e.id;
    try {
      const existing = this.secretStore.get(id);
      if (existing !== undefined && existing !== token) throw new Error('INVITE_SECRET_CONFLICT');
      if (existing === undefined) this.secretStore.set(id, token);
      if (this.secretStore.get(id) !== token) throw new Error('INVITE_SECRET_MISMATCH');
    } catch (error) {
      if (error instanceof Error && /^INVITE_SECRET_/.test(error.message)) throw error;
      throw new Error('KEY_STORE_UNAVAILABLE');
    }
    const { inviteToken: _token, ...metadata } = e;
    return { ...metadata, inviteSecret: id, tokenDigest: digestBytes(token) };
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
    const token = this.token(e);
    const invite = this.verify(token, this.now());
    selectApplicationRelay({ ...this.options.relayPolicy, inviteRelay: invite.relayUrl });
    return { inviteToken: token, invite };
  }
  private find(entries: StoredInvite[], ref: string): StoredInvite | undefined {
    return entries.find(e => ref === 'saved:' + e.id || ref === e.alias);
  }
  private mutate<T>(change: (entries: StoredInvite[]) => { entries: StoredInvite[]; result: T; changed: boolean }, metadataOnly = false, afterPublish?: () => void): T {
    const lock = this.path + '.lock';
    const temporary = join(this.directory, '.' + randomUUID() + '.tmp');
    let locked = false, written = false;
    try {
      privateDirectory(this.root, this.io, this.options.platform);
      privateDirectory(this.directory, this.io, this.options.platform);
      try { writePrivateFile(lock, Buffer.from(String(process.pid) + '\n'), this.io, this.options.platform); locked = true; }
      catch (error) {
        if (code(error) === 'EEXIST') throw new Error('INVITE_STORE_BUSY');
        throw error;
      }
      const { entries, result, changed } = change(metadataOnly ? this.readMetadata() : this.read());
      if (!changed) return result;
      const bytes = Buffer.from(JSON.stringify(signPayload<StoredInvites>({
        type: 'StoredInvites', version: 1, localOwnerDid: this.owner.did, entries,
      }, this.owner, new Date(this.now()).toISOString())) + '\n');
      if (bytes.length > MAX_STORE_BYTES) throw new Error('INVITE_STORE_INVALID');
      writePrivateFile(temporary, bytes, this.io, this.options.platform); written = true;
      checkPath(this.path, this.io, this.options.platform);
      this.io.renameSync(temporary, this.path); written = false;
      afterPublish?.();
      return result;
    } catch (error) {
      if (error instanceof Error && /^(INVITE_|ALIAS_|INVALID_ALIAS|KEY_STORE_)/.test(error.message)) throw error;
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
      const stored = this.options.secretStore || this.selection() === 'keychain' ? this.externalize(entry) : entry;
      return { entries: [...entries, stored], result: this.publicEntry(entry), changed: true };
    });
  }
  /** Explicit migration publishes only after all external strings have been read back. */
  migrateToKeychain(dryRun = false): { count: number; dryRun: boolean } {
    if (!this.secretStore) throw new Error('KEY_STORE_UNAVAILABLE');
    if (dryRun) return { count: this.read().filter(e => e.inviteToken !== undefined).length, dryRun };
    return this.mutate(entries => {
      const count = entries.filter(e => e.inviteToken !== undefined).length;
      return { entries: entries.map(e => e.inviteToken === undefined ? e : this.externalize(e)),
        result: { count, dryRun }, changed: count > 0 };
    });
  }
  remove(workerRef: string): boolean {
    let secret: string | undefined;
    return this.mutate(entries => {
      const entry = this.find(entries, workerRef);
      secret = entry?.inviteSecret;
      return { entries: entries.filter(e => e !== entry), result: !!entry, changed: !!entry };
    }, true, () => {
      if (!secret) return;
      try {
        if (!this.secretStore) throw new Error();
        this.secretStore.delete(secret);
      } catch { throw new Error('INVITE_SECRET_DELETE_FAILED'); }
    });
  }
}
