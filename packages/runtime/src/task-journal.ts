// SPDX-License-Identifier: Apache-2.0
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync,
  ftruncateSync, openSync, readFileSync, writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { checkPath, checkStat, readPrivateFile, writePrivateFile } from './local-identity.js';
import { signPayload, verifySigned, validateSchema } from '@acp/core';
import type { KeyPair, Signed } from '@acp/core';
import type { AuditInterruption } from '@acp/ledger';
import { validateTaskDelegation } from './delegation.js';
import type { TaskDelegationState } from './delegation.js';
import type { SessionResult } from './session.js';

export interface TaskOutcome {
  code: string;
  result?: SessionResult;
}
export interface TaskCheckpoint {
  delegation?: TaskDelegationState;
  version: 1;
  taskId: string;
  requesterDid: string;
  envelopeId: string;
  proposalDigest: string;
  phase: 'received' | 'accepted' | 'running' | 'delivered' | 'terminal';
  auditPath?: string;
  /** Present only for new-format attempts; never inferred for legacy journal records. */
  auditStage?: AuditInterruption['phase'] | 'OUT_OF_SCOPE';
  auditClosure?: { state: 'pending' | 'written'; interruption: Signed<AuditInterruption> };
  workspace?: string;
  invocations: Array<{ id: string; tool: string; argsDigest: string; completed: boolean }>;
  outcome?: TaskOutcome;
  notificationPending?: boolean;
}

/** Private signed checkpoints. Shared callers hold the signer lock for load/reload/save/compact.
 * A torn final append retains the preceding checkpoint, but is never a reusable cache. */
export class TaskJournal {
  readonly tasks = new Map<string, TaskCheckpoint>();
  private loaded = false;
  private validBytes = 0;
  private stamp?: string;
  private writer?: number;
  // On POSIX, pin a loaded inode so replacement cannot recycle its identity into the cache.
  private reader?: number;
  private readonly retainDescriptors: boolean;
  close(): void {
    if (this.writer !== undefined) { closeSync(this.writer); this.writer = undefined; }
    if (this.reader !== undefined) { closeSync(this.reader); this.reader = undefined; }
  }
  constructor(readonly path: string, private readonly owner: KeyPair, private readonly maxRecordBytes = Infinity,
    private readonly durability: 'file-sync' | 'process' = 'file-sync') {
    // Windows replacement can fail while another process retains a journal handle.
    // Close both readers and writers between operations there; reload fully under the signer lock.
    this.retainDescriptors = durability === 'process' && process.platform !== 'win32';
  }
  private fingerprint(stat: fs.BigIntStats): string {
    return [stat.dev, stat.ino, stat.size, stat.mode, stat.uid, stat.mtimeNs, stat.ctimeNs].join(':');
  }
  reload(): void {
    // Under the signer lock, complete journals only grow by append or are replaced by rename.
    // A retained descriptor pins the inode against reuse after replacement.
    // A torn tail can instead be repaired to the same size in the same timestamp tick.
    if (this.retainDescriptors && this.loaded && this.stamp &&
        (this.reader !== undefined || this.writer !== undefined)) {
      try {
        const stat = fs.lstatSync(this.path, { bigint: true });
        if (BigInt(this.validBytes) === stat.size && this.fingerprint(stat) === this.stamp) return;
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    this.close();
    this.loaded = false; this.stamp = undefined; this.tasks.clear(); this.validBytes = 0; this.load();
  }
  /** Used only by the gateway's default journal, under its signer lock. */
  compact(retainedTasks: ReadonlySet<string>): void {
    this.reload();
    if (!this.validBytes) return;
    const retained = [...this.tasks.values()].filter(r => r.phase !== 'terminal' || r.notificationPending || retainedTasks.has(r.taskId));
    const bytes = Buffer.from(retained.map(r => JSON.stringify(signPayload(r, this.owner)) + '\n').join(''));
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    let created = false;
    try {
      if (this.durability === 'file-sync') { writePrivateFile(temporary, bytes, fs); created = true; }
      else {
        checkPath(temporary, fs);
        const fd = fs.openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0), 0o600);
        created = true;
        try { checkStat(fs.fstatSync(fd)); fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
      }
      checkPath(this.path, fs); readPrivateFile(this.path, fs, fs.statSync(this.path).size + 1);
      this.close();
      fs.renameSync(temporary, this.path); created = false;
      if (this.durability === 'file-sync' && process.platform !== 'win32') { const fd = fs.openSync(dirname(this.path), 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
      this.loaded = false; this.reload();
    } finally { if (created) fs.unlinkSync(temporary); }
  }

  /** Default gateway maintenance prepares snapshots without blocking relay polling. */
  async compactInBackground(retainedTasks: ReadonlySet<string>, commit: (change: () => void) => void, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const stamp = (s: fs.BigIntStats) => [s.dev, s.ino, s.size, s.mode, s.uid, s.mtimeNs, s.ctimeNs].join(':');
    checkPath(this.path, fs);
    const before = await fs.promises.lstat(this.path, { bigint: true });
    if (!before.isFile()) throw new Error('INVALID_TASK_JOURNAL');
    const handle = await fs.promises.open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const tasks = new Map<string, TaskCheckpoint>();
    const sourceChunks: Buffer[] = [];
    let validBytes = 0;
    try {
      checkStat(await handle.stat());
      if (stamp(await handle.stat({ bigint: true })) !== stamp(before)) return;
      const chunk = Buffer.alloc(64 * 1024);
      let tail = Buffer.alloc(0);
      for (;;) {
        signal.throwIfAborted();
        const { bytesRead } = await handle.read(chunk);
        if (!bytesRead) break;
        sourceChunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
        const block = Buffer.concat([tail, chunk.subarray(0, bytesRead)]);
        let start = 0, end: number;
        while ((end = block.indexOf(10, start)) !== -1) {
          await new Promise<void>(resolve => setImmediate(resolve));
          signal.throwIfAborted();
          const line = block.subarray(start, end).toString('utf8');
          if (line) { const record = this.decode(line); tasks.set(record.taskId, record); }
          validBytes += end - start + 1;
          start = end + 1;
        }
        tail = Buffer.from(block.subarray(start));
        if (tail.length > this.maxRecordBytes) throw new Error('INVALID_TASK_JOURNAL');
      }
      if (stamp(await handle.stat({ bigint: true })) !== stamp(before)) return;
    } finally { await handle.close(); }
    if (!validBytes) return;
    const source = Buffer.concat(sourceChunks);
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    let created = false;
    try {
      checkPath(temporary, fs);
      const target = await fs.promises.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0), 0o600);
      created = true;
      let compactedBytes = 0;
      try {
        checkStat(await target.stat());
        for (const [id, record] of tasks) {
          await new Promise<void>(resolve => setImmediate(resolve));
          signal.throwIfAborted();
          if (record.phase === 'terminal' && !record.notificationPending && !retainedTasks.has(id)) { tasks.delete(id); continue; }
          const line = JSON.stringify(signPayload(record, this.owner)) + '\n';
          await target.writeFile(line);
          compactedBytes += Buffer.byteLength(line);
        }
        if (this.durability === 'file-sync') await target.sync();
      } finally { await target.close(); }
      signal.throwIfAborted();
      commit(() => {
        checkPath(this.path, fs);
        // Stat is only an early rejection: same-size tail repair can preserve the fingerprint.
        if (stamp(fs.lstatSync(this.path, { bigint: true })) !== stamp(before)) return;
        const fd = fs.openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
          checkStat(fs.fstatSync(fd));
          // Include the incomplete tail. Compare under the signer lock before publishing the cache.
          if (!readFileSync(fd).equals(source)) return;
        } finally { fs.closeSync(fd); }
        this.close();
        fs.renameSync(temporary, this.path); created = false;
        this.tasks.clear(); for (const [id, record] of tasks) this.tasks.set(id, record);
        this.validBytes = compactedBytes; this.loaded = true;
        this.stamp = this.fingerprint(fs.lstatSync(this.path, { bigint: true }));
      });
      if (!created && this.durability === 'file-sync' && process.platform !== 'win32') {
        const directory = await fs.promises.open(dirname(this.path), constants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { if (created) await fs.promises.unlink(temporary); }
  }
  private decode(line: string): TaskCheckpoint {
    if (Buffer.byteLength(line) + 1 > this.maxRecordBytes) throw new Error('INVALID_TASK_JOURNAL');
    const signed = JSON.parse(line) as Signed<TaskCheckpoint>, record = signed.payload;
    if (!verifySigned(signed, this.owner.did) || record.version !== 1 ||
        typeof record.taskId !== 'string' || typeof record.requesterDid !== 'string' ||
        typeof record.envelopeId !== 'string' || typeof record.proposalDigest !== 'string' ||
        !['received', 'accepted', 'running', 'delivered', 'terminal'].includes(record.phase) ||
        !Array.isArray(record.invocations) || (record.phase === 'terminal' && !record.outcome))
      throw new Error('INVALID_TASK_JOURNAL');
    if (record.auditStage !== undefined && !['OWNER_APPROVAL', 'ACCEPT_ACK_WAIT', 'OUT_OF_SCOPE'].includes(record.auditStage))
      throw new Error('INVALID_TASK_JOURNAL');
    if (record.auditClosure !== undefined) {
      const closure = record.auditClosure;
      try {
        if (!closure || !['pending', 'written'].includes(closure.state) || Object.keys(closure).length !== 2 || !record.auditPath ||
            record.auditStage === undefined || record.auditStage === 'OUT_OF_SCOPE') throw new Error();
        validateSchema('audit-interruption', closure.interruption);
        const p = closure.interruption.payload;
        if (!verifySigned(closure.interruption, this.owner.did) || p.taskId !== record.taskId ||
            p.actors[0] !== record.requesterDid || p.actors[1] !== this.owner.did || p.phase !== record.auditStage ||
            p.seq !== 1 || p.acknowledgedPrefix.count !== 1 || p.acknowledgedPrefix.lastSeq !== 0 ||
            p.prevEntryHash !== p.acknowledgedPrefix.head || p.observedAt !== closure.interruption.signature.signedAt)
          throw new Error();
      } catch { throw new Error('INVALID_TASK_JOURNAL'); }
    }
    if (record.delegation !== undefined) validateTaskDelegation(record.delegation, record.taskId, record.requesterDid, this.owner.did);
    return record;
  }

  private open(flags: number): number {
    const platformFlags = process.platform === 'win32' ? 0
      : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    const fd = openSync(this.path, flags | platformFlags, 0o600);
    try {
      if (!fstatSync(fd).isFile()) throw new Error('INVALID_TASK_JOURNAL');
      if (process.platform !== 'win32') fchmodSync(fd, 0o600);
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  }
  load(): void {
    if (this.loaded) return;
    let fd: number;
    try { fd = this.open(constants.O_RDONLY); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.loaded = true;
      return;
    }
    try {
      const bytes = readFileSync(fd);
      const end = bytes.lastIndexOf(10) + 1;
      const tasks = new Map<string, TaskCheckpoint>();
      for (const line of bytes.subarray(0, end).toString('utf8').split('\n').filter(Boolean)) {
        const record = this.decode(line);
        tasks.set(record.taskId, record);
      }
      this.stamp = end === bytes.length ? this.fingerprint(fs.fstatSync(fd, { bigint: true })) : undefined;
      this.tasks.clear(); for (const [id, record] of tasks) this.tasks.set(id, record);
      this.validBytes = end;
      this.loaded = end === bytes.length;
      if (this.loaded && this.retainDescriptors) this.reader = fd;
    } finally { if (this.reader !== fd) closeSync(fd); }
  }
  save(record: TaskCheckpoint): void {
    this.load();
    const snapshot = JSON.parse(JSON.stringify(record)) as TaskCheckpoint;
    if (snapshot.delegation !== undefined) validateTaskDelegation(snapshot.delegation, snapshot.taskId, snapshot.requesterDid, this.owner.did);
    const line = Buffer.from(JSON.stringify(signPayload(snapshot, this.owner)) + '\n');
    if (line.length > this.maxRecordBytes) throw new Error('OUTBOX_FULL');
    const fd = this.writer ?? this.open(constants.O_WRONLY | constants.O_CREAT);
    if (this.retainDescriptors) {
      this.writer = fd;
      if (this.reader !== undefined) { closeSync(this.reader); this.reader = undefined; }
    }
    try {
      // Explicit paths have one writer; gateway journals use the signer lock.
      const size = fstatSync(fd).size;
      if (size < this.validBytes) throw new Error('INVALID_TASK_JOURNAL');
      // Windows cannot truncate append-mode handles. Write explicitly after the valid prefix.
      if (size > this.validBytes) ftruncateSync(fd, this.validBytes);
      let offset = 0;
      while (offset < line.length) {
        const written = writeSync(fd, line, offset, line.length - offset, this.validBytes + offset);
        if (written === 0) throw new Error('TASK_JOURNAL_WRITE_FAILED');
        offset += written;
      }
      if (this.durability === 'file-sync') fsyncSync(fd);
      if (this.durability === 'file-sync' && process.platform !== 'win32') {
        const directory = openSync(dirname(this.path), constants.O_RDONLY);
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      this.stamp = this.fingerprint(fs.fstatSync(fd, { bigint: true }));
      this.validBytes += line.length;
      this.tasks.set(record.taskId, snapshot);
      this.loaded = true;
    } catch (error) {
      this.close();
      this.loaded = false; this.stamp = undefined; this.validBytes = 0; this.tasks.clear();
      throw error;
    }
    finally { if (!this.retainDescriptors) closeSync(fd); }
  }
}
