// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { generateKeyPair, signPayload, verifySigned } from '@acp/core';
import type { KeyPair, Signed } from '@acp/core';
import { inspectStoredIdentity } from './key-store.js';
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
/** Owner gateway retains transport/signing authority; the execution agent gets no owner credentials. */
export async function delegatedWorkerIdentity(o: IdentityStoreOptions = {}, owner?: KeyPair) {
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
  const revoked = read<Signed<{ type: string; agentDid: string }>>(join(root(o), 'revoked.json'), o);
  if (revoked) {
    if (!verifySigned(revoked, owner.did) || revoked.payload.type !== 'LocalWorkerRevocation' ||
        revoked.payload.agentDid !== b.agentDid) throw new Error('WORKER_DELEGATION_INVALID');
    throw new Error('WORKER_DELEGATION_REVOKED');
  }
  let agentKey: KeyPair | undefined;
  try { agentKey = (await inspectStoredIdentity('worker', { ...o,
    explicitKeyPath: join(root(o), b.delegateFile) })).key; }
  catch { throw new Error('WORKER_DELEGATION_INVALID'); }
  if (!agentKey || agentKey.did !== b.agentDid) throw new Error('WORKER_DELEGATION_INVALID');
  const legacyKey = (await inspectStoredIdentity('worker', o)).key;
  if (!legacyKey || legacyKey.did !== b.legacyWorkerDid) throw new Error('WORKER_DELEGATION_INVALID');
  const assertActive = () => {
    if (read(join(root(o), 'revoked.json'), o) ||
        JSON.stringify(read(join(root(o), 'active.json'), o)) !== JSON.stringify(binding))
      throw new Error('WORKER_DELEGATION_REVOKED');
  };
  return { owner, agentKey, legacyKey, assertActive, legacyWorkerDid: b.legacyWorkerDid, backup: b.backup };
}

/** No in-place key or connection-store writes. Publish the signed activation last. */
export async function migrateWorkerIdentity(o: IdentityStoreOptions = {}, dryRun = true) {
  if (o.explicitKeyPath) throw new Error('WORKER_MIGRATION_EXPLICIT_KEY_UNSUPPORTED');
  const existing = await delegatedWorkerIdentity(o);
  if (existing) return { status: 'already-migrated', ownerDid: existing.owner.did,
    agentDid: existing.agentKey.did, backup: existing.backup, dryRun };
  const owner = await inspectStoredIdentity('requester', o), worker = await inspectStoredIdentity('worker', o);
  if (owner.backend !== 'file' || worker.backend !== 'file') throw new Error('WORKER_MIGRATION_REQUIRES_FILE_STORE');
  if (!owner.key || !worker.key) throw new Error('WORKER_MIGRATION_IDENTITIES_REQUIRED');
  const plan = { status: 'planned', dryRun, ownerDid: owner.key.did, legacyWorkerDid: worker.key.did,
    backupRoot: join(root(o), 'backups'), connectionStores: 'unchanged; legacy listener retained' };
  if (dryRun) return { ...plan, backup: undefined };
  const io = o.fs ?? fs, dir = root(o);
  ensurePrivateDirectory(dir, io, o.platform);
  // Exclusive lock prevents simultaneous migrations/revocation. Never steal a lock.
  const lock = join(dir, 'migration.lock');
  const fd = io.openSync(lock, 'wx', 0o600);
  try {
    if (read(join(dir, 'active.json'), o)) throw new Error('WORKER_MIGRATION_BUSY');
    const backup = join(dir, 'backups', randomUUID());
    ensurePrivateDirectory(backup, io, o.platform);
    for (const [role, identity] of [['requester', owner], ['worker', worker]] as const) {
      const bytes = readPrivateFile(identity.location, io, 16384, o.platform);
      if (bytes === undefined) throw new Error('IDENTITY_UNREADABLE');
      const key = JSON.parse(bytes) as KeyPair;
      if (!verifySigned(signPayload({ type: 'MigrationBackupCheck' }, key), identity.key!.did))
        throw new Error('WORKER_MIGRATION_IDENTITY_CHANGED');
      writePrivateFile(join(backup, role + '.private.json'), Buffer.from(bytes), io, o.platform);
    }
    writePrivateFile(join(backup, 'manifest.json'), encode({ ...plan,
      originalRequester: owner.location, originalWorker: worker.location }), io, o.platform);
    const agent = generateKeyPair(), delegateFile = randomUUID() + '.private.json';
    writePrivateFile(join(dir, delegateFile), encode(agent), io, o.platform);
    const binding: Binding = { type: 'LocalWorkerDelegation', version: 1, ownerDid: owner.key.did,
      agentDid: agent.did, legacyWorkerDid: worker.key.did, delegateFile, backup };
    // Atomic, exclusive hard-link publication: a crash never exposes a partial activation.
    const temporary = join(dir, randomUUID() + '.activation.json');
    writePrivateFile(temporary, encode(signPayload(binding, owner.key)), io, o.platform);
    try { io.linkSync(temporary, join(dir, 'active.json')); } finally { io.unlinkSync(temporary); }
    return { ...plan, status: 'migrated', agentDid: agent.did, backup };
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
    const backup = join(dir, 'backups', randomUUID());
    ensurePrivateDirectory(backup, io, o.platform);
    const activation = readPrivateFile(join(dir, 'active.json'), io, 32768, o.platform)!;
    writePrivateFile(join(backup, 'active.json'), Buffer.from(activation), io, o.platform);
    const temporary = join(dir, randomUUID() + '.revocation.json');
    writePrivateFile(temporary, encode(signPayload({ type: 'LocalWorkerRevocation', agentDid: identity.agentKey.did }, identity.owner)), io, o.platform);
    try { io.linkSync(temporary, join(dir, 'revoked.json')); } finally { io.unlinkSync(temporary); }
    return { status: 'revoked', dryRun, agentDid: identity.agentKey.did, backup };
  } finally { io.closeSync(fd); io.unlinkSync(lock); }
}
