// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, signPayload, verifySigned, type KeyPair, type Signed } from '@acp/core';
import { acquireDailyLock } from './daily-limit.js';

/** USD per million tokens, snapshot supplied by the owner, 2026-11-11.
 * Integer nano-dollars per token avoid cumulative floating-point rounding.
 * Unknown models never fall back to a cheaper price.
 */
export const MODEL_PRICES: Readonly<Record<string, { input: number; output: number }>> = Object.freeze({
  'gpt-6-luna': Object.freeze({ input: 100, output: 500 }),
  'gpt-6.1-terra': Object.freeze({ input: 1000, output: 5000 }),
  'gpt-6.1-sol': Object.freeze({ input: 2000, output: 10000 }),
  'claude-haiku-5-5': Object.freeze({ input: 100, output: 500 }),
  'claude-sonnet-5-5': Object.freeze({ input: 2000, output: 10000 }),
});
export function tokenCost(model: string, input: number, output: number): number {
  const price = Object.hasOwn(MODEL_PRICES, model) ? MODEL_PRICES[model] : undefined;
  if (!price || ![input, output].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('MONTHLY_STATE_UNAVAILABLE');
  const cost = input * price.input + output * price.output;
  if (!Number.isSafeInteger(cost)) throw new Error('MONTHLY_STATE_UNAVAILABLE');
  return cost;
}
export function monthlyResetAt(now: number): string {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
}
interface CostEvent {
  version: 1; event: 'begin' | 'usage' | 'finish' | 'uncertain'; taskId: string;
  at: string; model: string; pid: number; input: number; output: number;
  nanoUsd: number; previous: string | null;
}
// Only this process can attest that a pending adapter is still being metered.
// A restarted process (even with a recycled PID) must not assume usage is known.
const liveTasks = new Map<string, boolean>();
/** Signed hash-linked accounting journal is also the source of counting state.
 * Each atomic replacement includes the complete verified prefix. A missing journal
 * is first-use only; a persistent marker prevents deletion from resetting spending.
 */
export class MonthlyCostCounter {
  constructor(readonly path: string, readonly owner: KeyPair, readonly clock: () => number = Date.now) {}
  private transaction<T>(operation: (events: Signed<CostEvent>[]) => T): T {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = acquireDailyLock(this.path + '.lock');
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    try {
      let events: Signed<CostEvent>[] = [];
      try {
        const stat = lstatSync(this.path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid journal');
        const text = readFileSync(this.path, 'utf8');
        if (!text.endsWith('\n') || !text.trim()) throw new Error('invalid journal');
        events = text.trimEnd().split('\n').map(line => JSON.parse(line));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try { readFileSync(this.path + '.initialized'); throw new Error('missing journal'); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      }
      let previous: string | null = null, lastAt = '';
      const active = new Set<string>();
      for (const entry of events) {
        const e = entry.payload;
        if (!verifySigned(entry, this.owner.did) || e.version !== 1 || e.previous !== previous ||
            !['begin', 'usage', 'finish', 'uncertain'].includes(e.event) || !e.taskId ||
            !Number.isSafeInteger(e.pid) || e.pid < 1 || new Date(e.at).toISOString() !== e.at || e.at < lastAt ||
            tokenCost(e.model, e.input, e.output) !== e.nanoUsd ||
            (e.event !== 'usage' && (e.input !== 0 || e.output !== 0))) throw new Error('invalid journal');
        if (e.event === 'begin') { if (active.has(e.taskId)) throw new Error('invalid journal'); active.add(e.taskId); }
        else if (!active.has(e.taskId)) throw new Error('invalid journal');
        if (e.event === 'finish') active.delete(e.taskId);
        previous = digest(entry); lastAt = e.at;
      }
      if (lastAt > new Date(this.clock()).toISOString()) throw new Error('clock rollback');
      const length = events.length;
      const result = operation(events);
      if (events.length !== length) {
        // Marker first: an interrupted first write must fail closed on restart.
        try { writeFileSync(this.path + '.initialized', '', { flag: 'wx', mode: 0o600, flush: true }); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
        writeFileSync(temporary, events.map(e => JSON.stringify(e)).join('\n') + '\n', { flag: 'wx', mode: 0o600, flush: true });
        renameSync(temporary, this.path);
      }
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === 'MONTHLY_LIMIT_REACHED') throw error;
      throw new Error('MONTHLY_STATE_UNAVAILABLE');
    } finally {
      try { try { unlinkSync(temporary); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
      finally { release(); }
    }
  }
  private append(events: Signed<CostEvent>[], event: CostEvent['event'], taskId: string, model: string, input = 0, output = 0) {
    events.push(signPayload({ version: 1, event, taskId, model, input, output, pid: process.pid,
      at: new Date(this.clock()).toISOString(), nanoUsd: tokenCost(model, input, output),
      previous: events.length ? digest(events.at(-1)!) : null } as CostEvent, this.owner));
  }
  private checkState(events: Signed<CostEvent>[], limit: number): void {
    if (!Number.isSafeInteger(limit * 1e9) || limit <= 0) throw new Error('invalid limit');
    const month = new Date(this.clock()).toISOString().slice(0, 7);
    let spent = 0;
    const active = new Map<string, CostEvent>();
    for (const { payload: e } of events) {
      if (e.at.startsWith(month)) spent += e.nanoUsd;
      if (!Number.isSafeInteger(spent)) throw new Error('invalid total');
      if (e.event === 'begin' || e.event === 'uncertain') active.set(e.taskId, e);
      if (e.event === 'finish') active.delete(e.taskId);
    }
    for (const e of active.values()) {
      if (e.event === 'uncertain') throw new Error('uncertain usage');
      if (e.pid !== process.pid || liveTasks.get(this.path + ':' + e.taskId) !== true)
        throw new Error('uncertain usage');
    }
    if (spent >= limit * 1e9) throw new Error('MONTHLY_LIMIT_REACHED');
  }
  check(limit: number): void { this.transaction(events => this.checkState(events, limit)); }
  begin(limit: number, taskId: string, model: string): void {
    this.transaction(events => {
      this.checkState(events, limit); tokenCost(model, 0, 0);
      if (events.some(e => e.payload.taskId === taskId)) throw new Error('replay');
      this.append(events, 'begin', taskId, model);
    });
    liveTasks.set(this.path + ':' + taskId, true);
  }
  usage(taskId: string, model: string, input: number, output: number): void {
    try { this.transaction(events => { this.append(events, 'usage', taskId, model, input, output); }); }
    catch (error) { liveTasks.set(this.path + ':' + taskId, false); throw error; }
  }
  finish(taskId: string, model: string, certain: boolean): void {
    liveTasks.set(this.path + ':' + taskId, false);
    this.transaction(events => { this.append(events, certain ? 'finish' : 'uncertain', taskId, model); });
    liveTasks.delete(this.path + ':' + taskId);
  }
}

