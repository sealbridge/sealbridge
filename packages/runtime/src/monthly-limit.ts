// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync,
  openSync, closeSync, fstatSync, appendFileSync, fsyncSync, constants } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, signPayload, verifySigned, type KeyPair, type Signed } from '@acp/core';
import { acquireDailyLock } from './daily-limit.js';

/** Owner-supplied 2026-11-11 price snapshot: integer nano-dollars per token. */
export const MODEL_PRICES: Readonly<Record<string, { input: number; output: number }>> = Object.freeze({
  'gpt-6-luna': Object.freeze({ input: 100, output: 500 }),
});
export function tokenCost(model: string, input: number, output: number): number {
  const price = Object.hasOwn(MODEL_PRICES, model) ? MODEL_PRICES[model] : undefined;
  if (!price) throw new Error('MONTHLY_MODEL_UNSUPPORTED');
  if (![input, output].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('MONTHLY_STATE_UNAVAILABLE');
  const cost = input * price.input + output * price.output;
  if (!Number.isSafeInteger(cost)) throw new Error('MONTHLY_STATE_UNAVAILABLE');
  return cost;
}
/** Accept decimal USD limits without requiring an exactly representable binary product. */
export function usdNanoDollars(usd: number): number {
  const rounded = Math.round(usd * 1e9);
  if (!Number.isFinite(usd) || usd <= 0 || !Number.isSafeInteger(rounded) || rounded <= 0 ||
      Math.abs(usd * 1e9 - rounded) > Math.max(1e-6, Number.EPSILON * Math.abs(usd * 1e9)))
    throw new Error('INVALID_MONTHLY_LIMIT');
  return rounded;
}
export function monthlyResetAt(now: number): string {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
}
export interface MonthlyTokenBudget { maxInputTokens: number; maxOutputTokens: number }
interface ActiveTask {
  model: string; pid: number; budget?: MonthlyTokenBudget;
  input: number; output: number; reported: boolean;
}
interface Snapshot {
  month: string; spent: number; active: Record<string, ActiveTask>; seen: string[];
  summary?: { month: string; nanoUsd: number; head: string | null };
}
interface CostEvent {
  version: 1 | 2; event: 'begin' | 'usage' | 'finish' | 'uncertain' | 'estimate' | 'checkpoint' | 'budget';
  taskId: string; at: string; model: string; pid: number; input: number; output: number;
  nanoUsd: number; previous: string | null; budget?: MonthlyTokenBudget; snapshot?: Snapshot;
}
interface State extends Snapshot { head: string | null; lastAt: string }
const liveTasks = new Set<string>();
// The inode/size/nanosecond timestamps are rechecked under the same lock as writers.
// External changes invalidate the cache and force signature verification again.
const verified = new Map<string, { stamp: string; state: State }>();
function stamp(path: string): string {
  const s = lstatSync(path, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink()) throw new Error('invalid journal');
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
}
const safeCount = (n: number) => Number.isSafeInteger(n) && n >= 0;
function add(a: number, b: number): number {
  if (!safeCount(a) || !safeCount(b) || !Number.isSafeInteger(a + b)) throw new Error('invalid total');
  return a + b;
}
/** Current-month signed append journal, with signed checkpoints and immutable monthly archives.
 * No usage report means the saved maximum token budget; any valid report means reported usage.
 * Storage corruption still fails closed. Usage uncertainty alone never poisons admissions.
 */
export class MonthlyCostCounter {
  constructor(readonly path: string, readonly owner: KeyPair, readonly clock: () => number = Date.now) {}
  private key(taskId: string): string { return this.path + ':' + taskId; }
  private empty(): State {
    return { month: new Date(this.clock()).toISOString().slice(0, 7), spent: 0,
      active: {}, seen: [], head: null, lastAt: '' };
  }
  private validateBudget(model: string, budget: MonthlyTokenBudget): void {
    if (!budget || !safeCount(budget.maxInputTokens) || !safeCount(budget.maxOutputTokens)) throw new Error('invalid budget');
    tokenCost(model, budget.maxInputTokens, budget.maxOutputTokens);
  }
  private apply(state: State, entry: Signed<CostEvent>, first: boolean): void {
    const e = entry.payload;
    if (!verifySigned(entry, this.owner.did) || ![1, 2].includes(e.version) ||
        !['begin', 'usage', 'finish', 'uncertain', 'estimate', 'checkpoint', 'budget'].includes(e.event) ||
        new Date(e.at).toISOString() !== e.at || e.at < state.lastAt ||
        !safeCount(e.nanoUsd) || !safeCount(e.input) || !safeCount(e.output) ||
        (!first || e.event !== 'checkpoint') && e.previous !== state.head) throw new Error('invalid journal');
    if (e.event === 'checkpoint') {
      if (!first || !e.snapshot || !/^\d{4}-\d{2}$/.test(e.snapshot.month) || !safeCount(e.snapshot.spent) ||
          !e.snapshot.active || typeof e.snapshot.active !== 'object' || Array.isArray(e.snapshot.active) ||
          !Array.isArray(e.snapshot.seen) || e.snapshot.seen.some(id => typeof id !== 'string')) throw new Error('invalid checkpoint');
      Object.assign(state, structuredClone(e.snapshot));
      for (const task of Object.values(state.active)) {
        if (!task || !safeCount(task.input) || !safeCount(task.output) || typeof task.reported !== 'boolean' ||
            !Number.isSafeInteger(task.pid) || task.pid < 1) throw new Error('invalid checkpoint');
        if (task.budget) this.validateBudget(task.model, task.budget);
      }
    } else {
      if (!e.taskId || !Number.isSafeInteger(e.pid) || e.pid < 1) throw new Error('invalid journal');
      const month = e.at.slice(0, 7);
      // Legacy v1 histories can contain several months before their first checkpoint.
      if (month > state.month) { state.month = month; state.spent = 0; state.seen = Object.keys(state.active); }
      if (month < state.month) throw new Error('clock rollback');
      if (e.event === 'begin') {
        if (Object.hasOwn(state.active, e.taskId) || state.seen.includes(e.taskId) || e.nanoUsd !== 0) throw new Error('replay');
        if (e.version === 2) this.validateBudget(e.model, e.budget!);
        Object.defineProperty(state.active, e.taskId, { value: { model: e.model, pid: e.pid, budget: e.budget,
          input: 0, output: 0, reported: false }, enumerable: true, configurable: true, writable: true });
        state.seen.push(e.taskId);
      } else {
        const task = Object.hasOwn(state.active, e.taskId) ? state.active[e.taskId] : undefined;
        if (!task || task.model !== e.model) throw new Error('invalid task');
        if (e.event === 'usage') {
          if (tokenCost(e.model, e.input, e.output) !== e.nanoUsd) throw new Error('invalid cost');
          task.input = add(task.input, e.input); task.output = add(task.output, e.output); task.reported = true;
        } else if (e.event === 'budget') {
          this.validateBudget(e.model, e.budget!); task.budget = e.budget;
        } else if (e.event === 'estimate') {
          if (task.reported || !task.budget || e.input !== task.budget.maxInputTokens ||
              e.output !== task.budget.maxOutputTokens || tokenCost(e.model, e.input, e.output) !== e.nanoUsd) throw new Error('invalid estimate');
          delete state.active[e.taskId];
        } else if (e.event === 'finish') {
          if (e.nanoUsd !== 0) throw new Error('invalid finish');
          delete state.active[e.taskId];
        }
        // Legacy uncertain rows remain active, and are settled by recover().
      }
      state.spent = add(state.spent, e.nanoUsd);
    }
    state.head = digest(entry); state.lastAt = e.at;
  }
  private load(): State {
    let fileStamp: string;
    try { fileStamp = stamp(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { lstatSync(this.path + '.initialized'); throw new Error('missing journal'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      return this.empty();
    }
    const cached = verified.get(this.owner.did + ':' + this.path);
    if (cached?.stamp === fileStamp) return structuredClone(cached.state);
    const text = readFileSync(this.path, 'utf8');
    if (!text.endsWith('\n') || !text.trim()) throw new Error('invalid journal');
    const state = this.empty();
    const entries = text.trimEnd().split('\n').map(line => JSON.parse(line) as Signed<CostEvent>);
    // Replay from the actual journal month rather than today's month.
    state.month = entries[0].payload.at.slice(0, 7);
    entries.forEach((entry, i) => this.apply(state, entry, i === 0));
    verified.set(this.owner.did + ':' + this.path, { stamp: fileStamp, state: structuredClone(state) });
    return state;
  }
  private append(state: State, pending: Signed<CostEvent>[], event: CostEvent['event'], taskId: string,
    model: string, input = 0, output = 0, budget?: MonthlyTokenBudget): void {
    const at = new Date(this.clock()).toISOString();
    const entry = signPayload({ version: 2, event, taskId, model, input, output, pid: process.pid, at,
      nanoUsd: event === 'usage' || event === 'estimate' ? tokenCost(model, input, output) : 0,
      previous: state.head, ...(budget ? { budget } : {}) } as CostEvent, this.owner, at);
    // A rejected delta must not mutate the state behind an already queued recovery row.
    const next = structuredClone(state);
    this.apply(next, entry, state.head === null);
    Object.assign(state, next); pending.push(entry);
  }
  private settle(state: State, pending: Signed<CostEvent>[], taskId: string): void {
    const task = Object.hasOwn(state.active, taskId) ? state.active[taskId] : undefined;
    if (!task) return; // Already conservatively settled; late callbacks must not double charge.
    if (task.reported) this.append(state, pending, 'finish', taskId, task.model);
    else {
      this.validateBudget(task.model, task.budget!);
      this.append(state, pending, 'estimate', taskId, task.model, task.budget!.maxInputTokens, task.budget!.maxOutputTokens);
    }
  }
  private recover(state: State, pending: Signed<CostEvent>[]): void {
    for (const [id, task] of Object.entries(state.active)) {
      if (task.pid === process.pid && liveTasks.has(this.key(id))) continue;
      if (task.pid !== process.pid) {
        try { process.kill(task.pid, 0); continue; }
        catch { /* Unverifiable liveness is unknown usage: settle conservatively. */ }
      }
      this.settle(state, pending, id);
    }
  }
  private transaction<T>(operation: (state: State, pending: Signed<CostEvent>[]) => T): T {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = acquireDailyLock(this.path + '.lock');
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    try {
      let state = this.load();
      const at = new Date(this.clock()).toISOString();
      if (state.lastAt > at) throw new Error('clock rollback');
      const month = at.slice(0, 7);
      let replace = state.head === null;
      const pending: Signed<CostEvent>[] = [];
      if (month > state.month && state.head !== null) {
        const old = readFileSync(this.path, 'utf8');
        const archive = this.path + '.' + state.month + '.' + digest(old).slice(7) + '.archive';
        try { writeFileSync(archive, old, { flag: 'wx', mode: 0o600, flush: true }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || readFileSync(archive, 'utf8') !== old) throw error;
        }
        const snapshot: Snapshot = { month, spent: 0, active: state.active, seen: Object.keys(state.active),
          summary: { month: state.month, nanoUsd: state.spent, head: state.head } };
        const checkpoint = signPayload({ version: 2, event: 'checkpoint', taskId: '', model: '', pid: process.pid,
          at, input: 0, output: 0, nanoUsd: 0, previous: state.head, snapshot } as CostEvent, this.owner, at);
        state = this.empty(); this.apply(state, checkpoint, true); pending.push(checkpoint); replace = true;
      }
      let result!: T, failure: unknown;
      try { result = operation(state, pending); } catch (error) { failure = error; }
      // Recovery/settlement is persisted even when the resulting total rejects admission.
      if (pending.length) {
        const text = pending.map(e => JSON.stringify(e)).join('\n') + '\n';
        if (replace) {
          try { writeFileSync(this.path + '.initialized', '', { flag: 'wx', mode: 0o600, flush: true }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
          writeFileSync(temporary, text, { flag: 'wx', mode: 0o600, flush: true }); renameSync(temporary, this.path);
        } else {
          const fd = openSync(this.path, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
          try {
            if (!fstatSync(fd).isFile()) throw new Error('invalid journal');
            appendFileSync(fd, text); fsyncSync(fd);
          } finally { closeSync(fd); }
        }
        verified.set(this.owner.did + ':' + this.path, { stamp: stamp(this.path), state: structuredClone(state) });
      }
      if (failure) throw failure;
      return result;
    } catch (error) {
      verified.delete(this.owner.did + ':' + this.path);
      if (error instanceof Error && ['MONTHLY_LIMIT_REACHED', 'MONTHLY_MODEL_UNSUPPORTED'].includes(error.message)) throw error;
      throw new Error('MONTHLY_STATE_UNAVAILABLE');
    } finally {
      try { try { unlinkSync(temporary); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
      finally { release(); }
    }
  }
  check(limit: number): void {
    const maximum = usdNanoDollars(limit);
    this.transaction((state, pending) => { this.recover(state, pending); if (state.spent >= maximum) throw new Error('MONTHLY_LIMIT_REACHED'); });
  }
  begin(limit: number, taskId: string, model: string, budget: MonthlyTokenBudget): void {
    this.validateBudget(model, budget); // Unknown models never create an unfinished entry.
    const maximum = usdNanoDollars(limit);
    this.transaction((state, pending) => {
      this.recover(state, pending);
      if (state.spent >= maximum) throw new Error('MONTHLY_LIMIT_REACHED');
      this.append(state, pending, 'begin', taskId, model, 0, 0, budget);
    });
    liveTasks.add(this.key(taskId));
  }
  usage(taskId: string, model: string, input: number, output: number): void {
    this.transaction((state, pending) => {
      if (!Object.hasOwn(state.active, taskId)) return;
      this.append(state, pending, 'usage', taskId, model, input, output);
    });
  }
  finish(taskId: string, unused = false): void {
    liveTasks.delete(this.key(taskId));
    this.transaction((state, pending) => {
      const task = Object.hasOwn(state.active, taskId) ? state.active[taskId] : undefined;
      if (unused && task && !task.reported) this.append(state, pending, 'finish', taskId, task.model);
      else this.settle(state, pending, taskId);
    });
  }
  /** Owner-only recovery after restoring an authenticated backup, including
   * pre-release v1 begins without saved budgets. Reconstruct missing tasks from
   * their original manifests/provider usage; never bypass corrupt storage.
   */
  reconcileTask(taskId: string, budget: MonthlyTokenBudget,
    reported?: { inputTokens: number; outputTokens: number }): void {
    this.transaction((state, pending) => {
      if (Object.hasOwn(state.active, taskId)) {
        this.append(state, pending, 'budget', taskId, state.active[taskId].model, 0, 0, budget);
      } else {
        if (state.seen.includes(taskId)) return;
        this.append(state, pending, 'begin', taskId, 'gpt-6-luna', 0, 0, budget);
      }
      if (reported && !state.active[taskId].reported)
        this.append(state, pending, 'usage', taskId, state.active[taskId].model, reported.inputTokens, reported.outputTokens);
      this.settle(state, pending, taskId);
    });
    liveTasks.delete(this.key(taskId));
  }
}
