// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { signPayload, verifySigned, validateManifest } from '@acp/core';
import type { Json, KeyPair, Signed, TaskManifest } from '@acp/core';
import { resolveDataRoot, privateDirectory, inspectDirectory, checkPath, checkStat } from './local-identity.js';
import type { LocalIdentityOptions } from './local-identity.js';
import type { DelegateOptions } from './session.js';
import { validateSessionTimeouts } from './session-timeouts.js';
import type { SessionTimeoutOptions } from './session-timeouts.js';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_RECORDS = 100;
const TTL_MS = 24 * 60 * 60_000;
export const PENDING_NEXT_STEP = 'Use sealbridge pending list or acp_list_pending_requests; after worker owner approval, explicitly use sealbridge pending resubmit ID or acp_resubmit_pending_request. Listing shows local observations only; do not retry automatically.';
export interface PendingSummary {
  id: string; workerDid: string; originalTaskId: string; lastTaskId: string;
  state: 'pending' | 'resolved' | 'failed' | 'expired';
  createdAt: number; expiresAt: number; lastChecked: number; attempts: number;
  lastError?: string;
}
export interface PendingRequest extends PendingSummary {
  // Invitation material and task content remain local and are omitted from summaries.
  request: { to: string; relayUrl?: string; manifest: TaskManifest; input: Json; timeouts: SessionTimeoutOptions };
}
interface State { version: 1; requesterDid: string; records: PendingRequest[] }
export function requesterPendingPath(did: string, options: LocalIdentityOptions = {}): string {
  return join(resolveDataRoot(options), 'requesters', createHash('sha256').update(did).digest('hex'), 'pending.private.json');
}
function summary(record: PendingRequest, now: number): PendingSummary {
  return { id: record.id, workerDid: record.workerDid, originalTaskId: record.originalTaskId,
    lastTaskId: record.lastTaskId, state: record.expiresAt <= now ? 'expired' : record.state,
    createdAt: record.createdAt, expiresAt: record.expiresAt, lastChecked: record.lastChecked,
    attempts: record.attempts, ...(record.lastError ? { lastError: record.lastError } : {}) };
}
export function pendingErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const value = typeof code === 'string' ? code : error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'DELEGATION_FAILED';
}
export class RequesterPendingStore {
  readonly path: string;
  private readonly io: typeof fs;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  constructor(private readonly owner: KeyPair, options: LocalIdentityOptions & { now?: () => number } = {}) {
    this.path = requesterPendingPath(owner.did, options);
    this.io = options.fs ?? fs; this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
  }
  private directories(): string[] {
    return [dirname(dirname(dirname(this.path))), dirname(dirname(this.path)), dirname(this.path)];
  }
  private read(): State {
    const io = this.io;
    let fd: number | undefined;
    try {
      for (const directory of this.directories()) {
        try { inspectDirectory(directory, io, this.platform); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      }
      checkPath(this.path, io, this.platform);
      const before = io.lstatSync(this.path); checkStat(before);
      if (before.size > MAX_BYTES) throw new Error();
      fd = io.openSync(this.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      const stat = io.fstatSync(fd); checkStat(stat);
      if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size > MAX_BYTES) throw new Error();
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = io.readSync(fd, bytes, size, bytes.length - size, null);
        if (!count) break;
        size += count;
      }
      if (size > MAX_BYTES) throw new Error();
      const signed = JSON.parse(bytes.subarray(0, size).toString('utf8')) as Signed<State>, state = signed.payload;
      if (!verifySigned(signed, this.owner.did) || state.version !== 1 || state.requesterDid !== this.owner.did ||
          !Array.isArray(state.records) || state.records.length > MAX_RECORDS) throw new Error();
      const ids = new Set<string>();
      for (const r of state.records) {
        if (!r || typeof r.id !== 'string' || !/^[a-f0-9-]{36}$/.test(r.id) || ids.has(r.id) ||
            !['pending', 'resolved', 'failed', 'expired'].includes(r.state) ||
            ![r.createdAt, r.expiresAt, r.lastChecked, r.attempts].every(Number.isSafeInteger) || r.attempts < 1 ||
            typeof r.workerDid !== 'string' || typeof r.originalTaskId !== 'string' || typeof r.lastTaskId !== 'string' ||
            (r.lastError !== undefined && !/^[A-Z][A-Z0-9_]{0,79}$/.test(r.lastError)) ||
            !r.request || typeof r.request.to !== 'string' ||
            (r.request.relayUrl !== undefined && typeof r.request.relayUrl !== 'string') ||
            !Object.hasOwn(r.request, 'input') || !r.request.timeouts || typeof r.request.timeouts !== 'object' || Array.isArray(r.request.timeouts) ||
            Buffer.byteLength(JSON.stringify(r)) > MAX_RECORD_BYTES) throw new Error();
        validateManifest(r.request.manifest);
        validateSessionTimeouts(r.request.timeouts);
        if (r.request.manifest.requester.ownerDid !== this.owner.did || r.request.manifest.worker?.ownerDid !== r.workerDid)
          throw new Error();
        ids.add(r.id);
      }
      return state;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, requesterDid: this.owner.did, records: [] };
      throw new Error('PENDING_STORE_INVALID');
    } finally { if (fd !== undefined) io.closeSync(fd); }
  }
  private mutate(change: (state: State) => void): void {
    const io = this.io;
    let locked = false, temporary: string | undefined;
    try {
      for (const directory of this.directories()) privateDirectory(directory, io, this.platform);
      try { io.writeFileSync(this.path + '.lock', '', { flag: 'wx', mode: 0o600 }); locked = true; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('PENDING_STORE_BUSY'); throw e; }
      const state = this.read();
      state.records = state.records.filter(r => r.expiresAt > this.now());
      change(state);
      if (state.records.length > MAX_RECORDS || state.records.some(r => Buffer.byteLength(JSON.stringify(r)) > MAX_RECORD_BYTES))
        throw new Error('PENDING_STORE_FULL');
      const bytes = JSON.stringify(signPayload(state, this.owner)) + '\n';
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('PENDING_STORE_FULL');
      temporary = this.path + '.' + randomUUID() + '.tmp';
      const fd = io.openSync(temporary, 'wx', 0o600);
      try { io.writeFileSync(fd, bytes); io.fsyncSync(fd); } finally { io.closeSync(fd); }
      checkPath(this.path, io, this.platform);
      io.renameSync(temporary, this.path);
    } catch (e) {
      if (e instanceof Error && /^(PENDING_|REQUEST_)/.test(e.message)) throw e;
      throw new Error('PENDING_STORE_UNWRITABLE');
    } finally {
      if (temporary) try { io.unlinkSync(temporary); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (locked) io.unlinkSync(this.path + '.lock');
    }
  }
  list(): PendingSummary[] { return this.read().records.map(r => summary(r, this.now())); }
  save(request: PendingRequest['request']): string {
    const now = this.now(), id = randomUUID();
    this.mutate(state => state.records.push({ id, workerDid: request.manifest.worker!.ownerDid,
      originalTaskId: request.manifest.taskId, lastTaskId: request.manifest.taskId,
      state: 'pending', createdAt: now, expiresAt: now + TTL_MS, lastChecked: now, attempts: 1,
      lastError: 'PENDING_OWNER_APPROVAL', request: JSON.parse(JSON.stringify(request)) as PendingRequest['request'] }));
    return id;
  }
  remove(id: string): void {
    this.mutate(state => {
      if (state.records.some(r => r.id === id) && this.io.existsSync(this.path + '.' + id + '.attempt.lock'))
        throw new Error('PENDING_STORE_BUSY');
      state.records = state.records.filter(r => r.id !== id);
    });
  }
  resolve(id: string): void {
    this.mutate(s => { const r = s.records.find(r => r.id === id);
      if (r) { r.state = 'resolved'; r.lastChecked = this.now(); delete r.lastError; } });
  }
  private get(id: string): PendingRequest {
    const record = this.read().records.find(r => r.id === id);
    if (!record) throw new Error('PENDING_NOT_FOUND');
    if (record.expiresAt <= this.now()) throw new Error('PENDING_EXPIRED');
    if (record.state === 'resolved') throw new Error('PENDING_ALREADY_RESOLVED');
    return record;
  }
  /** The callback must use the current host's normal delegation and approval path. */
  async resubmit<T>(id: string, run: (request: DelegateOptions, relayUrl?: string) => Promise<T>): Promise<T> {
    this.get(id);
    const io = this.io, lock = this.path + '.' + id + '.attempt.lock';
    try { io.writeFileSync(lock, '', { flag: 'wx', mode: 0o600 }); }
    catch (e) { throw new Error((e as NodeJS.ErrnoException).code === 'EEXIST' ? 'PENDING_STORE_BUSY' : 'PENDING_STORE_UNWRITABLE'); }
    try {
      const record = this.get(id), now = this.now();
      const manifest = structuredClone(record.request.manifest);
      const duration = Date.parse(manifest.deadline) - Date.parse(manifest.createdAt);
      manifest.taskId = 'task_' + randomUUID().replaceAll('-', '');
      manifest.createdAt = new Date(now).toISOString(); manifest.deadline = new Date(now + duration).toISOString();
      this.mutate(s => { const r = s.records.find(r => r.id === id);
        if (!r) throw new Error('PENDING_EXPIRED');
        r.attempts++; r.lastChecked = now; r.lastTaskId = manifest.taskId; });
      try {
        const result = await run({ ...record.request.timeouts, to: record.request.to, manifest,
          title: manifest.task.title, description: manifest.task.description, input: record.request.input, pendingId: id }, record.request.relayUrl);
        this.resolve(id);
        return result;
      } catch (e) {
        const code = pendingErrorCode(e);
        try { this.mutate(s => { const r = s.records.find(r => r.id === id);
          if (r && r.state !== 'resolved') { r.state = code === 'PENDING_OWNER_APPROVAL' ? 'pending' : 'failed'; r.lastError = code; r.lastChecked = this.now(); } }); }
        catch (storeError) { if (e && typeof e === 'object') Object.assign(e, { pendingStoreError: pendingErrorCode(storeError) }); }
        if (e && typeof e === 'object') Object.assign(e, { pendingId: id, originalTaskId: record.originalTaskId, nextStep: PENDING_NEXT_STEP });
        throw e;
      }
    } finally { io.unlinkSync(lock); }
  }
}
