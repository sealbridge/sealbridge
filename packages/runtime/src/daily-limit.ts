// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** A persistent lock directory also blocks older clients using an exclusive file.
 * Publish a unique PID claim BEFORE scanning: simultaneous contenders either see
 * each other and reject, or the later contender sees the earlier live owner.
 * Only ESRCH proves death. Unique claim names make concurrent dead-owner cleanup
 * safe: no cleaner can unlink a replacement owner's claim (no shared-file ABA).
 * Never remove the directory, including on release.
 */
export function acquireDailyLock(lock: string): () => void {
  const busy = () => new Error('DAILY_LIMIT_BUSY: live, legacy or unverifiable lock');
  try {
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = lstatSync(lock);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw busy();
  } catch { throw busy(); }
  const claim = `${process.pid}-${randomUUID()}`;
  const ownPath = join(lock, claim);
  try { writeFileSync(ownPath, '', { flag: 'wx', mode: 0o600 }); }
  catch { throw busy(); }
  try {
    for (const name of readdirSync(lock)) {
      if (name === claim) continue;
      const match = /^([1-9][0-9]*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(name);
      const pid = match ? Number(match[1]) : NaN;
      if (!Number.isSafeInteger(pid) || pid > 2147483647) throw busy();
      try { process.kill(pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw busy();
        // Names are unique and never reused, even when a PID is recycled.
        try { unlinkSync(join(lock, name)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw busy(); }
        continue;
      }
      throw busy();
    }
  } catch (error) { unlinkSync(ownPath); throw error; }
  return () => unlinkSync(ownPath);
}

/** UTC admission counter. Lock contention and corrupt state fail closed. */
export function consumeDailyTask(path: string, limit: number, taskId: string, now = Date.now()): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isFinite(now) || !taskId)
    throw new Error('INVALID_DAILY_LIMIT');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = path + '.lock', temporary = path + '.' + randomUUID() + '.tmp';
  const release = acquireDailyLock(lock);
  try {
    const day = new Date(now).toISOString().slice(0, 10);
    let state: { version: number; day: string; tasks: string[] } = { version: 1, day, tasks: [] };
    try { state = JSON.parse(readFileSync(path, 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('DAILY_LIMIT_INVALID'); }
    if (state.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(state.day) ||
        !Array.isArray(state.tasks) || state.tasks.some(t => typeof t !== 'string') ||
        new Set(state.tasks).size !== state.tasks.length) throw new Error('DAILY_LIMIT_INVALID');
    if (day < state.day) throw new Error('DAILY_LIMIT_CLOCK_ROLLBACK');
    if (day > state.day) state = { version: 1, day, tasks: [] };
    if (state.tasks.includes(taskId)) throw new Error('DAILY_TASK_REPLAY');
    if (state.tasks.length >= limit) throw new Error('DAILY_LIMIT_REACHED');
    state.tasks.push(taskId);
    writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600, flush: true });
    renameSync(temporary, path);
  } finally {
    try {
      try { unlinkSync(temporary); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    } finally { release(); }
  }
}
