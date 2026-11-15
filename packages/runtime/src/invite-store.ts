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
  /** In-memory intent or legacy migration input; never serialized in invite records. */
  aliasExplicit?: true;
  displayName: string;
  ownerDid: string;
  agentDid: string;
  relayUrl: string;
  inviteToken?: string;
  inviteSecret?: string;
  tokenDigest?: string;
  inviteDigest: string;
  importedAt: string;
  importState?: 'unconfirmed';
  effectiveExpiresAt: string;
}
interface StoredInvites {
  type: 'StoredInvites';
  version: 1;
  localOwnerDid: string;
  entries: StoredInvite[];
}
export interface SavedInvite {
  /** Role-neutral alias of workerRef; both contain the same saved reference. */
  peerRef?: string;
  workerRef: string;
  alias: string;
  /** Present only when an owner explicitly supplied the alias. */
  aliasExplicit?: true;
  displayName: string;
  ownerDid: string;
  agentDid: string;
  relayUrl: string;
  importedAt: string;
  importState?: 'unconfirmed';
  effectiveExpiresAt: string;
  status: 'current' | 'expired';
}
export interface InviteImportOptions {
  /** Only newly imported entries become eligible for explicit age-based cleanup. */
  pendingConfirmation?: boolean;
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
  private locked = false;
  private legacyInline = false;
  private legacyKeys = new Set<string>();
  private static readonly warnedAliasPaths = new Set<string>();
  /** Optional owner-signed intent metadata; older releases never read this file. */
  get aliasPath(): string { return this.path + '.aliases.json'; }
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
  private readMetadata(migrate = true): StoredInvite[] {
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
        if (!e || !exactKeys(e, fields + (external ? 'inviteSecret,tokenDigest' : 'inviteToken') +
            (e.importState !== undefined ? ',importState' : '') + (e.aliasExplicit !== undefined ? ',aliasExplicit' : '')) ||
            (e.importState !== undefined && e.importState !== 'unconfirmed') ||
            (e.aliasExplicit !== undefined && e.aliasExplicit !== true) ||
            Object.entries(e).some(([k, v]) => k !== 'aliasExplicit' && typeof v !== 'string') || !aliasPattern.test(e.alias) ||
            !Number.isFinite(Date.parse(e.importedAt)) || Date.parse(e.importedAt) > this.now() ||
            ids.has(e.id) || aliases.has(e.alias)) throw new Error();
        if (external && (e.inviteSecret !== 'invite:' + e.id || !/^[a-f0-9]{64}$/.test(e.id) ||
            !/^sha256:[a-f0-9]{64}$/.test(e.tokenDigest!))) throw new Error();
        if (!external) this.validateToken(e, e.inviteToken!);
        ids.add(e.id); aliases.add(e.alias);
      }
      const legacyInline = p.entries.some(e => e.aliasExplicit === true);
      if (this.locked) {
        this.legacyInline = legacyInline;
        this.legacyKeys = new Set(p.entries.filter(e => e.aliasExplicit === true).map(e => this.aliasKey(e)));
      }
      if (migrate && !this.locked && legacyInline) {
        // Re-read under the normal writer lock before migrating legacy inline marks.
        try {
          this.mutate(entries => ({ entries, result: undefined, changed: true }), true);
          return this.readMetadata(false);
        } catch {
          // Migration is maintenance, not validation. Keep this verified snapshot
          // usable when a writer holds the lock or publication is unavailable.
        }
      }
      const marks = this.readAliasMarks();
      return p.entries.map(e => ({ ...e, ...(marks.has(this.aliasKey(e)) ? { aliasExplicit: true as const } : {}) }));
    } catch { throw new Error('INVITE_STORE_INVALID'); }
  }
  private aliasKey(e: StoredInvite): string {
    return digest({ id: e.id, alias: e.alias, importedAt: e.importedAt });
  }
  private warnAliasMetadata(): void {
    if (InviteStore.warnedAliasPaths.has(this.aliasPath)) return;
    InviteStore.warnedAliasPaths.add(this.aliasPath);
    console.error('INVITE_ALIAS_METADATA_UNAVAILABLE: explicit invite alias metadata could not be read or saved; derived connection names may be used.\n招待別名の明示指定を読み取り・保存できませんでした。表示名から作った接続名を使用する場合があります。');
  }
  private readAliasMarks(): Set<string> {
    try {
      const contents = readPrivateFile(this.aliasPath, this.io, MAX_STORE_BYTES, this.options.platform);
      if (contents === undefined) return new Set();
      const signed = JSON.parse(contents), p = signed.payload;
      if (!exactKeys(signed, 'payload,signature') || !verifySigned(signed, this.owner.did) ||
          !exactKeys(p, 'type,version,localOwnerDid,marks' + (p.recordsDigest !== undefined ? ',recordsDigest' : '')) || p.type !== 'InviteAliasIntent' ||
          p.version !== 1 || p.localOwnerDid !== this.owner.did ||
          (p.recordsDigest !== undefined && (typeof p.recordsDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(p.recordsDigest))) ||
          !Array.isArray(p.marks) || p.marks.some((m: unknown) => typeof m !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(m))) throw new Error();
      return new Set(p.marks);
    } catch { this.warnAliasMetadata(); return new Set(); }
  }
  /** Called only under the invite-store lock. Intent loss must never prevent invitation use. */
  private writeAliasMarks(marks: Set<string>): boolean {
    const temporary = join(this.directory, '.' + randomUUID() + '.tmp');
    let written = false;
    try {
      // Validate an existing destination too: never replace an unsafe sidecar.
      const previous = readPrivateFile(this.aliasPath, this.io, MAX_STORE_BYTES, this.options.platform);
      if (marks.size === 0 && previous === undefined) return true;
      const bytes = Buffer.from(JSON.stringify(signPayload({ type: 'InviteAliasIntent', version: 1,
        localOwnerDid: this.owner.did, marks: [...marks] }, this.owner)) + '\n');
      if (bytes.length > MAX_STORE_BYTES) throw new Error();
      writePrivateFile(temporary, bytes, this.io, this.options.platform); written = true;
      checkPath(this.aliasPath, this.io, this.options.platform);
      this.io.renameSync(temporary, this.aliasPath); written = false;
      return true;
    } catch { this.warnAliasMetadata(); return false; }
    finally { if (written) { try { this.io.unlinkSync(temporary); } catch { /* best effort */ } } }
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
      if (e.importState !== undefined) expected.importState = e.importState;
      const { aliasExplicit: _intent, ...record } = e;
      if (token !== inviteTokenFromUri(token) || digest(record) !== digest(expected)) throw new Error();
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
    return { peerRef: 'saved:' + e.id, workerRef: 'saved:' + e.id, alias, displayName, ownerDid, agentDid, relayUrl,
      importedAt, effectiveExpiresAt, ...(e.aliasExplicit === true ? { aliasExplicit: true as const } : {}), ...(e.importState ? { importState: e.importState } : {}),
      status: Date.parse(effectiveExpiresAt) <= this.now() ? 'expired' : 'current' };
  }
  list(): SavedInvite[] { return this.read().map(e => this.publicEntry(e)); }
  /** Strict validation occurs on every resolution; an expired invite never becomes a DID target. */
  resolve(workerRef: string): { inviteToken: string; invite: Invite } {
    const e = this.find(this.read(), workerRef);
    if (!e) throw new Error('INVITE_NOT_FOUND');
    if (e.importState === 'unconfirmed') throw new Error('INVITE_CONFIRMATION_REQUIRED');
    const token = this.token(e);
    const invite = this.verify(token, this.now());
    selectApplicationRelay({ ...this.options.relayPolicy, inviteRelay: invite.relayUrl });
    return { inviteToken: token, invite };
  }
  private find(entries: StoredInvite[], ref: string): StoredInvite | undefined {
    return entries.find(e => ref === 'saved:' + e.id || ref === e.alias);
  }
  private mutate<T>(change: (entries: StoredInvite[]) => { entries: StoredInvite[]; result: T; changed: boolean }, metadataOnly = false): T {
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
      this.locked = true;
      this.legacyInline = false;
      this.legacyKeys = new Set();
      const previousMarks = this.readAliasMarks();
      const { entries, result, changed } = change(metadataOnly ? this.readMetadata() : this.read());
      if (!changed && !this.legacyInline) return result;
      const marks = new Set(entries.filter(e => e.aliasExplicit === true).map(e => this.aliasKey(e)));
      const prepared = new Set([...previousMarks, ...marks]);
      // Publish intent before removing inline legacy marks. Keep old marks until
      // the store commits, so a failed replacement cannot erase existing intent.
      const aliasWritten = this.writeAliasMarks(prepared);
      const bytes = Buffer.from(JSON.stringify(signPayload<StoredInvites>({
        type: 'StoredInvites', version: 1, localOwnerDid: this.owner.did,
        entries: entries.map(({ aliasExplicit: _intent, ...record }) => ({ ...record,
          ...(!aliasWritten && this.legacyKeys.has(this.aliasKey(record)) ? { aliasExplicit: true as const } : {}) })),
      }, this.owner, new Date(this.now()).toISOString())) + '\n');
      if (bytes.length > MAX_STORE_BYTES) throw new Error('INVITE_STORE_INVALID');
      writePrivateFile(temporary, bytes, this.io, this.options.platform); written = true;
      checkPath(this.path, this.io, this.options.platform);
      this.io.renameSync(temporary, this.path); written = false;
      if (aliasWritten && prepared.size !== marks.size) this.writeAliasMarks(marks);
      return result;
    } catch (error) {
      if (['EACCES', 'EPERM', 'EROFS'].includes(code(error) ?? '')) throw error;
      if (error instanceof Error && /^(INVITE_|ALIAS_|INVALID_ALIAS|KEY_STORE_)/.test(error.message)) throw error;
      throw new Error('INVITE_STORE_INVALID');
    } finally {
      if (written) this.io.unlinkSync(temporary);
      this.locked = false;
      if (locked) this.io.unlinkSync(lock);
    }
  }
  import(link: string, alias?: string, options: InviteImportOptions = {}): SavedInvite {
    const now = this.now();
    const invite = this.verify(link, now);
    selectApplicationRelay({ ...this.options.relayPolicy, inviteRelay: invite.relayUrl });
    if (alias !== undefined && !aliasPattern.test(alias)) throw new Error('INVALID_ALIAS');
    const suffix = digest(invite).slice(7, 19);
    const slug = invite.agentCard.payload.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'worker';
    const entry = this.entry(inviteTokenFromUri(link), alias ?? slug + '-' + suffix, new Date(now).toISOString(), invite);
    if (alias !== undefined) entry.aliasExplicit = true;
    if (options.pendingConfirmation) entry.importState = 'unconfirmed';
    return this.mutate(entries => {
      const duplicate = entries.find(e => e.inviteDigest === entry.inviteDigest);
      if (duplicate) {
        if (alias !== undefined && alias !== duplicate.alias) throw new Error('ALIAS_EXISTS');
        const retained = !options.pendingConfirmation && duplicate.importState === 'unconfirmed';
        const explicit = alias !== undefined && duplicate.aliasExplicit !== true;
        const changed = retained || explicit;
        if (retained) delete duplicate.importState;
        if (explicit) duplicate.aliasExplicit = true;
        return { entries, result: this.publicEntry(duplicate), changed };
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
  /** Keeps an import permanently outside unconfirmed cleanup; grants no connection or task consent. */
  retain(workerRef: string): SavedInvite {
    const current = this.find(this.read(), workerRef);
    if (!current) throw new Error('INVITE_NOT_FOUND');
    if (current.importState !== 'unconfirmed') return this.publicEntry(current);
    return this.mutate(entries => {
      const entry = this.find(entries, workerRef);
      if (!entry) throw new Error('INVITE_NOT_FOUND');
      const changed = entry.importState === 'unconfirmed';
      delete entry.importState;
      return { entries, result: this.publicEntry(entry), changed };
    });
  }
  /** Token-free metadata remains available even after interrupted secret deletion. */
  listUnconfirmed(): SavedInvite[] {
    return this.readMetadata().filter(e => e.importState === 'unconfirmed').map(e => this.publicEntry(e));
  }
  /** Deletes only explicitly pending imports strictly older than the supplied timestamp. */
  removeUnconfirmed(options: { olderThan: string }): { removed: number } {
    const cutoff = Date.parse(options.olderThan);
    if (!Number.isFinite(cutoff) || cutoff > this.now()) throw new Error('INVITE_CLEANUP_INVALID_CUTOFF');
    return this.mutate(entries => {
      const selected = entries.filter(e => e.importState === 'unconfirmed' && Date.parse(e.importedAt) < cutoff);
      for (const entry of selected) this.deleteSecret(entry);
      return { entries: entries.filter(e => !selected.includes(e)), result: { removed: selected.length },
        changed: selected.length > 0 };
    }, true);
  }
  private deleteSecret(entry: StoredInvite): void {
    if (!entry.inviteSecret) return;
    try {
      if (!this.secretStore) throw new Error();
      this.secretStore.delete(entry.inviteSecret);
      if (this.secretStore.get(entry.inviteSecret) !== undefined) throw new Error();
    } catch { throw new Error('INVITE_SECRET_DELETE_FAILED'); }
  }
  /** Secret deletion precedes metadata publication, so either step can be retried with the same reference. */
  remove(workerRef: string): boolean {
    return this.mutate(entries => {
      const entry = this.find(entries, workerRef);
      if (entry) this.deleteSecret(entry);
      return { entries: entries.filter(e => e !== entry), result: !!entry, changed: !!entry };
    }, true);
  }
}
