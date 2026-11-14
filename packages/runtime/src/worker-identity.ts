// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { generateKeyPair, signPayload, verifySigned } from '@acp/core';
import type { KeyPair, Signed } from '@acp/core';
import { inspectStoredIdentity, resolveStoredIdentity } from './key-store.js';
import type { IdentityStoreOptions } from './key-store.js';
import { resolveDataRoot, ensurePrivateDirectory, readPrivateFile, writePrivateFile } from './local-identity.js';

interface Binding {
  type: 'LocalWorkerDelegation'; version: 1; ownerDid: string; agentDid: string;
  legacyWorkerDid: string; delegateFile: string; backup: string;
}
const root = (o: IdentityStoreOptions) => join(resolveDataRoot(o), 'worker-delegation');
const encode = (v: unknown) => Buffer.from(JSON.stringify(v) + '\n');
function read<T>(path: string, o: IdentityStoreOptions): T | undefined {
  const text = readPrivateFile(path, o.fs ?? fs, 32768, o.platform);
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as T;
  }
  catch { throw new Error('WORKER_DELEGATION_INVALID'); }
}
function revocationPath(o: IdentityStoreOptions, did: string) {
  return join(root(o), 'revocations', createHash('sha256').update(did).digest('hex') + '.json');
}
function isRevoked(o: IdentityStoreOptions, owner: KeyPair, agentDid: string) {
  let revoked = false;
  for (const path of [join(root(o), 'revoked.json'), revocationPath(o, agentDid)]) {
    const record = read<Signed<{ type: string; agentDid: string }>>(path, o);
    if (!record) continue;
    if (!verifySigned(record, owner.did) || record.payload.type !== 'LocalWorkerRevocation' ||
        typeof record.payload.agentDid !== 'string') throw new Error('WORKER_DELEGATION_INVALID');
    if (record.payload.agentDid === agentDid) revoked = true;
    else if (path !== join(root(o), 'revoked.json')) throw new Error('WORKER_DELEGATION_INVALID');
  }
  return revoked;
}
/** Owner gateway retains transport/signing authority; the execution agent gets no owner credentials. */
export async function delegatedWorkerIdentity(o: IdentityStoreOptions = {}, owner?: KeyPair) {
  return loadDelegatedIdentity(o, owner);
}
async function loadDelegatedIdentity(o: IdentityStoreOptions, owner?: KeyPair, allowRevoked = false) {
  // Explicit identities must never be silently retargeted by machine defaults.
  if (o.explicitKeyPath) return undefined;
  const binding = read<Signed<Binding>>(join(root(o), 'active.json'), o);
  if (binding === undefined) return undefined;
  owner ??= (await inspectStoredIdentity('requester', o)).key;
  if (!owner) throw new Error('WORKER_DELEGATION_INVALID');
  const b = binding.payload;
  if (!verifySigned(binding, owner.did) || b.type !== 'LocalWorkerDelegation' || b.version !== 1 ||
      b.ownerDid !== owner.did || !/^[a-f0-9-]{36}\.private\.json$/.test(b.delegateFile) ||
      b.agentDid === owner.did) throw new Error('WORKER_DELEGATION_INVALID');
  const revoked = isRevoked(o, owner, b.agentDid);
  if (revoked && !allowRevoked) throw new Error('WORKER_DELEGATION_REVOKED');
  let agentKey: KeyPair | undefined;
  try { agentKey = (await inspectStoredIdentity('worker', { ...o,
    explicitKeyPath: join(root(o), b.delegateFile) })).key; }
  catch { throw new Error('WORKER_DELEGATION_INVALID'); }
  if (!agentKey || agentKey.did !== b.agentDid) throw new Error('WORKER_DELEGATION_INVALID');
  const legacyKey = (await inspectStoredIdentity('worker', o)).key;
  if (!legacyKey || legacyKey.did !== b.legacyWorkerDid) throw new Error('WORKER_DELEGATION_INVALID');
  const assertActive = () => {
    if (isRevoked(o, owner!, b.agentDid) ||
        JSON.stringify(read(join(root(o), 'active.json'), o)) !== JSON.stringify(binding))
      throw new Error('WORKER_DELEGATION_REVOKED');
  };
  return { owner, agentKey, legacyKey, assertActive, legacyWorkerDid: b.legacyWorkerDid, backup: b.backup, revoked };
}

/** No in-place key or connection-store writes. Publish the signed activation last. */
export async function migrateWorkerIdentity(o: IdentityStoreOptions = {}, dryRun = true, createOwner = false) {
  if (o.explicitKeyPath) throw new Error('WORKER_MIGRATION_EXPLICIT_KEY_UNSUPPORTED');
  const existing = await loadDelegatedIdentity(o, undefined, true);
  if (existing && !existing.revoked) return { status: 'already-migrated', ownerDid: existing.owner.did,
    agentDid: existing.agentKey.did, backup: existing.backup, dryRun };
  let owner = await inspectStoredIdentity('requester', o);
  const worker = await inspectStoredIdentity('worker', o);
  if (owner.backend !== 'file' || worker.backend !== 'file') throw new Error('WORKER_MIGRATION_REQUIRES_FILE_STORE');
  if (!worker.key) throw new Error('WORKER_MIGRATION_IDENTITIES_REQUIRED: run sealbridge worker start with your usual options first; migration is optional.');
  if (!owner.key && !createOwner) throw new Error('WORKER_MIGRATION_IDENTITIES_REQUIRED: run sealbridge worker migrate --create-owner to preview, then sealbridge worker migrate --create-owner --apply. Or keep using sealbridge worker start without migration.');
  const plan = { status: 'planned', dryRun, ownerDid: owner.key?.did, createOwner: !owner.key, recovery: existing?.revoked ?? false, legacyWorkerDid: worker.key.did,
    backupRoot: join(root(o), 'backups'), connectionStores: 'unchanged; legacy listener retained' };
  if (dryRun) return { ...plan, backup: undefined };
  const io = o.fs ?? fs, dir = root(o);
  ensurePrivateDirectory(dir, io, o.platform);
  // Exclusive lock prevents simultaneous migrations/revocation. Never steal a lock.
  const lock = join(dir, 'migration.lock');
  const fd = io.openSync(lock, 'wx', 0o600);
  try {
    const locked = await loadDelegatedIdentity(o, undefined, true);
    if (existing ? !locked?.revoked || locked.agentKey.did !== existing.agentKey.did ||
        locked.owner.did !== existing.owner.did : locked !== undefined)
      throw new Error('WORKER_MIGRATION_BUSY');
    const activation = read<Signed<Binding>>(join(dir, 'active.json'), o);
    const backup = join(dir, 'backups', randomUUID());
    ensurePrivateDirectory(backup, io, o.platform);
    for (const [role, identity] of [['requester', owner], ['worker', worker]] as const) {
      if (!identity.key) continue;
      const bytes = readPrivateFile(identity.location, io, 16384, o.platform);
      if (bytes === undefined) throw new Error('IDENTITY_UNREADABLE');
      const key = JSON.parse(bytes) as KeyPair;
      if (!verifySigned(signPayload({ type: 'MigrationBackupCheck' }, key), identity.key!.did))
        throw new Error('WORKER_MIGRATION_IDENTITY_CHANGED');
      writePrivateFile(join(backup, role + '.private.json'), Buffer.from(bytes), io, o.platform);
    }
    writePrivateFile(join(backup, 'manifest.json'), encode({ ...plan,
      originalRequester: owner.location, originalWorker: worker.location }), io, o.platform);
    if (existing) {
      for (const [name, path] of [['active.json', join(dir, 'active.json')],
        ['delegate.private.json', join(dir, activation!.payload.delegateFile)],
        ['revocation.json', read(revocationPath(o, existing.agentKey.did), o)
          ? revocationPath(o, existing.agentKey.did) : join(dir, 'revoked.json')]] as const) {
        const bytes = readPrivateFile(path, io, 32768, o.platform);
        if (bytes === undefined) throw new Error('WORKER_DELEGATION_INVALID');
        writePrivateFile(join(backup, name), Buffer.from(bytes), io, o.platform);
      }
      // Retain revocation permanently, including bindings made by older releases.
      ensurePrivateDirectory(join(dir, 'revocations'), io, o.platform);
      if (!read(revocationPath(o, existing.agentKey.did), o))
        writePrivateFile(revocationPath(o, existing.agentKey.did), encode(signPayload({
          type: 'LocalWorkerRevocation', agentDid: existing.agentKey.did }, existing.owner)), io, o.platform);
    }
    if (!owner.key) {
      await resolveStoredIdentity('requester', o);
      owner = await inspectStoredIdentity('requester', o);
    }
    const agent = generateKeyPair(), delegateFile = randomUUID() + '.private.json';
    writePrivateFile(join(dir, delegateFile), encode(agent), io, o.platform);
    const binding: Binding = { type: 'LocalWorkerDelegation', version: 1, ownerDid: owner.key!.did,
      agentDid: agent.did, legacyWorkerDid: worker.key.did, delegateFile, backup };
    // Publish activation last: a crash never exposes a partial binding.
    const temporary = join(dir, randomUUID() + '.activation.json');
    writePrivateFile(temporary, encode(signPayload(binding, owner.key!)), io, o.platform);
    if (existing) {
      // Atomic replacement of metadata only; original and delegated keys remain intact.
      try { io.renameSync(temporary, join(dir, 'active.json')); }
      finally { if (io.existsSync(temporary)) io.unlinkSync(temporary); }
    } else {
      try { io.linkSync(temporary, join(dir, 'active.json')); } finally { io.unlinkSync(temporary); }
    }
    return { ...plan, status: 'migrated', ownerDid: owner.key!.did, agentDid: agent.did, backup };
  } finally { io.closeSync(fd); io.unlinkSync(lock); }
}

export async function revokeWorkerIdentity(o: IdentityStoreOptions = {}, dryRun = true) {
  let identity;
  try { identity = await delegatedWorkerIdentity(o); }
  catch (error) { if ((error as Error).message === 'WORKER_DELEGATION_REVOKED') return { status: 'already-revoked', dryRun }; throw error; }
  if (!identity) throw new Error('WORKER_DELEGATION_NOT_CONFIGURED');
  if (dryRun) return { status: 'would-revoke', dryRun, agentDid: identity.agentKey.did };
  const io = o.fs ?? fs, dir = root(o), lock = join(dir, 'migration.lock');
  const fd = io.openSync(lock, 'wx', 0o600);
  try {
    identity.assertActive();
    const backup = join(dir, 'backups', randomUUID());
    ensurePrivateDirectory(backup, io, o.platform);
    const activation = readPrivateFile(join(dir, 'active.json'), io, 32768, o.platform)!;
    writePrivateFile(join(backup, 'active.json'), Buffer.from(activation), io, o.platform);
    ensurePrivateDirectory(join(dir, 'revocations'), io, o.platform);
    const temporary = join(dir, randomUUID() + '.revocation.json');
    writePrivateFile(temporary, encode(signPayload({ type: 'LocalWorkerRevocation', agentDid: identity.agentKey.did }, identity.owner)), io, o.platform);
    try { io.linkSync(temporary, revocationPath(o, identity.agentKey.did)); } finally { io.unlinkSync(temporary); }
    return { status: 'revoked', dryRun, agentDid: identity.agentKey.did, backup };
  } finally { io.closeSync(fd); io.unlinkSync(lock); }
}
