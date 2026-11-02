// SPDX-License-Identifier: Apache-2.0
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync,
  ftruncateSync, openSync, readFileSync, writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { checkPath, readPrivateFile, writePrivateFile } from './local-identity.js';
import { signPayload, verifySigned } from '@acp/core';
import type { KeyPair, Signed } from '@acp/core';
import type { SessionResult } from './session.js';

export interface TaskOutcome {
  code: string;
  result?: SessionResult;
}
export interface TaskCheckpoint {
  version: 1;
  taskId: string;
  requesterDid: string;
  envelopeId: string;
  proposalDigest: string;
  phase: 'received' | 'accepted' | 'running' | 'delivered' | 'terminal';
  auditPath?: string;
  workspace?: string;
  invocations: Array<{ id: string; tool: string; argsDigest: string; completed: boolean }>;
  outcome?: TaskOutcome;
  notificationPending?: boolean;
}

/** Private, fsynced snapshots. A torn final append never erases the preceding checkpoint. */
export class TaskJournal {
  readonly tasks = new Map<string, TaskCheckpoint>();
  private loaded = false;
  private validBytes = 0;
  constructor(readonly path: string, private readonly owner: KeyPair, private readonly maxRecordBytes = Infinity) {}
  reload(): void { this.loaded = false; this.tasks.clear(); this.validBytes = 0; this.load(); }
  /** Used only by the gateway's default journal, under its signer lock. */
  compact(retainedTasks: ReadonlySet<string>): void {
    this.reload();
    if (!this.validBytes) return;
    const retained = [...this.tasks.values()].filter(r => r.phase !== 'terminal' || r.notificationPending || retainedTasks.has(r.taskId));
    const bytes = Buffer.from(retained.map(r => JSON.stringify(signPayload(r, this.owner)) + '\n').join(''));
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    let created = false;
    try {
      writePrivateFile(temporary, bytes, fs); created = true;
      checkPath(this.path, fs); readPrivateFile(this.path, fs, fs.statSync(this.path).size + 1);
      fs.renameSync(temporary, this.path); created = false;
      if (process.platform !== 'win32') { const fd = fs.openSync(dirname(this.path), 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
      this.reload();
    } finally { if (created) fs.unlinkSync(temporary); }
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
      for (const line of bytes.subarray(0, end).toString('utf8').split('\n').filter(Boolean)) {
        if (Buffer.byteLength(line) + 1 > this.maxRecordBytes) throw new Error('INVALID_TASK_JOURNAL');
        const signed = JSON.parse(line) as Signed<TaskCheckpoint>;
        const record = signed.payload;
        if (!verifySigned(signed, this.owner.did) || record.version !== 1 ||
            typeof record.taskId !== 'string' || typeof record.requesterDid !== 'string' ||
            typeof record.envelopeId !== 'string' || typeof record.proposalDigest !== 'string' ||
            !['received', 'accepted', 'running', 'delivered', 'terminal'].includes(record.phase) ||
            !Array.isArray(record.invocations) || (record.phase === 'terminal' && !record.outcome))
          throw new Error('INVALID_TASK_JOURNAL');
        this.tasks.set(record.taskId, record);
      }
      this.validBytes = end;
      this.loaded = true;
    } finally { closeSync(fd); }
  }
  save(record: TaskCheckpoint): void {
    this.load();
    const snapshot = JSON.parse(JSON.stringify(record)) as TaskCheckpoint;
    const line = Buffer.from(JSON.stringify(signPayload(snapshot, this.owner)) + '\n');
    if (line.length > this.maxRecordBytes) throw new Error('OUTBOX_FULL');
    const fd = this.open(constants.O_WRONLY | constants.O_CREAT);
    try {
      // Only one worker may own these persistence paths at a time.
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
      fsyncSync(fd);
      if (process.platform !== 'win32') {
        const directory = openSync(dirname(this.path), constants.O_RDONLY);
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      this.validBytes += line.length;
      this.tasks.set(record.taskId, snapshot);
    } finally { closeSync(fd); }
  }
}
