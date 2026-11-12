// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, renameSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { autoAcceptPolicy, schemaRegistry, signPayload, verifySignedAgentCard, verifySigned } from '../packages/core/src/index.js';
import { workerIntakePath } from '../packages/runtime/src/index.js';
import { MonthlyCostCounter, tokenCost, monthlyResetAt } from '../packages/runtime/src/monthly-limit.js';
import { PeerRejectedError } from '../packages/runtime/src/session-audit.js';
import { configCommand } from '../cli/src/config.js';
import { formatCliError } from '../cli/src/error-messages.js';
import { readApplicationConfig } from '../packages/runtime/src/application-config.js';
import { consumeDailyTask } from '../packages/runtime/src/daily-limit.js';
import { admissionFixture } from './connections-fixture.js';
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, unlinkSync: vi.fn(fs.unlinkSync), renameSync: vi.fn(fs.renameSync), appendFileSync: vi.fn(fs.appendFileSync) };
});
const budget = { maxInputTokens: 100, maxOutputTokens: 100 };
beforeEach(async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(renameSync).mockImplementation(fs.renameSync);
  vi.mocked(unlinkSync).mockImplementation(fs.unlinkSync);
  vi.mocked(appendFileSync).mockImplementation(fs.appendFileSync);
});
const fixtures: ReturnType<typeof admissionFixture>[] = [];
afterEach(() => { vi.restoreAllMocks(); fixtures.splice(0).forEach(f => f.cleanup()); });
function fixture(limit = 0.000005) {
  const f = admissionFixture({ now: () => Date.now(), autoAccept: { ...autoAcceptPolicy(), from: 'anyone', limits: { maxMonthlyUsd: limit } } }, true);
  f.worker.options.identityOptions = f.identityOptions;
  Object.assign(f.worker.options.adapter, { taskAccess: 'read-only', billingModel: 'gpt-6-luna' });
  f.execute.mockImplementation(async (c: any) => { c.reportUsage({ inputTokens: 10, outputTokens: 8 }); return c.input as never; });
  fixtures.push(f); return f;
}
function path(f: ReturnType<typeof fixture>) { return join(dirname(workerIntakePath(f.owner.did, f.identityOptions)), 'auto-accept-monthly.jsonl'); }
it('finishes a task at the cap, retains a signed discoverable closed card, and refuses new work before approval', async () => {
  const f = fixture(); await f.worker.register();
  expect((await f.attempt())[0].status).toBe('fulfilled');
  expect(f.worker.agentCard.payload.description).toContain('Monthly intake closed');
  expect(verifySignedAgentCard(f.worker.agentCard)).toBe(true);
  expect((await f.attempt())[0]).toMatchObject({ status: 'rejected', reason: { code: 'MONTHLY_LIMIT_REACHED', message: expect.stringContaining('00:00 UTC') } });
  expect(f.execute).toHaveBeenCalledTimes(1); expect(f.human.approve).not.toHaveBeenCalled();
  const events = readFileSync(path(f), 'utf8').trim().split('\n').map(s => JSON.parse(s));
  expect(events.map(e => e.payload.event)).toEqual(['begin', 'usage', 'finish']);
  expect(events.every(e => verifySigned(e, f.owner.did))).toBe(true);
  expect(events[1].payload).toMatchObject({ model: 'gpt-6-luna', input: 10, output: 8, nanoUsd: 5000 });
});
it('resets exactly at the first 00:00 UTC including December and leap years, persists and rejects rollback', () => {
  const f = fixture(); let now = Date.parse('2026-12-31T23:59:59.999Z');
  const counter = new MonthlyCostCounter(path(f), f.owner, () => now);
  counter.begin(0.000005, 'one', 'gpt-6-luna', budget); counter.usage('one', 'gpt-6-luna', 10, 8); counter.finish('one');
  expect(() => new MonthlyCostCounter(path(f), f.owner, () => now).check(0.000005)).toThrow('MONTHLY_LIMIT_REACHED');
  expect(monthlyResetAt(now)).toBe('2027-01-01T00:00:00.000Z');
  now++; counter.begin(0.000005, 'two', 'gpt-6-luna', budget); counter.finish('two');
  now--; expect(() => counter.check(1)).toThrow('MONTHLY_STATE_UNAVAILABLE');
  expect(monthlyResetAt(Date.parse('2028-02-29T23:59:59Z'))).toBe('2028-03-01T00:00:00.000Z');
});
it('allows already running tasks to finish after another reaches the cap and counts their overshoot', () => {
  const f = fixture(); const c = new MonthlyCostCounter(path(f), f.owner);
  c.begin(0.000005, 'one', 'gpt-6-luna', budget); c.begin(0.000005, 'two', 'gpt-6-luna', budget);
  c.usage('one', 'gpt-6-luna', 10, 8); c.finish('one');
  expect(() => c.begin(0.000005, 'three', 'gpt-6-luna', budget)).toThrow('MONTHLY_LIMIT_REACHED');
  c.usage('two', 'gpt-6-luna', 10, 8); c.finish('two');
  expect(() => c.check(0.00001)).toThrow('MONTHLY_LIMIT_REACHED');
});
it.each(['corrupt', 'unreadable', 'locked', 'unwritable', 'deleted'] as const)('fails closed for %s state', async mode => {
  const f = fixture(); const file = path(f); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (mode === 'corrupt') writeFileSync(file, '{bad', { mode: 0o600 });
  if (mode === 'unreadable') mkdirSync(file, { mode: 0o700 });
  if (mode === 'locked') writeFileSync(file + '.lock', '', { mode: 0o600 });
  if (mode === 'deleted') { writeFileSync(file + '.initialized', '', { mode: 0o600 }); }
  if (mode === 'unwritable') {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (to === file) throw new Error('denied');
      return fs.renameSync(from, to);
    });
  }
  expect((await f.attempt())[0]).toMatchObject({ status: 'rejected' });
  expect(f.execute).not.toHaveBeenCalled();
});
it('uses the maximum budget after missing usage and continues accepting tasks', async () => {
  const f = fixture(1); f.execute.mockImplementation(async (c: any) => c.input as never);
  expect((await f.attempt())[0].status).toBe('fulfilled');
  expect((await f.attempt())[0].status).toBe('fulfilled');
  const events = readFileSync(path(f), 'utf8').trim().split('\n').map(line => JSON.parse(line).payload);
  const first = events.find(e => e.event === 'begin');
  expect(events.find(e => e.event === 'estimate').nanoUsd).toBe(tokenCost('gpt-6-luna', first.budget.maxInputTokens, first.budget.maxOutputTokens));
  expect(f.execute).toHaveBeenCalledTimes(2);
});
it('fails closed for a failed storage write, then recovers without uncertain-usage poisoning', async () => {
  const f = fixture(1); const file = path(f);
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(appendFileSync).mockImplementationOnce(() => { throw new Error('usage write denied'); });
  expect((await f.attempt())[0].status).toBe('rejected');
  vi.mocked(appendFileSync).mockImplementation(fs.appendFileSync);
  expect((await f.attempt())[0].status).toBe('fulfilled');
});
it('rejects an unsupported model before execution without leaving poisoned counting state', async () => {
  const f = fixture(); Object.assign(f.worker.options.adapter, { billingModel: 'unknown' });
  expect((await f.attempt())[0]).toMatchObject({ status: 'rejected', reason: { code: 'MONTHLY_MODEL_UNSUPPORTED', message: expect.stringContaining('The worker cannot accept this request right now.') } });
  expect(f.execute).not.toHaveBeenCalled(); expect(f.human.approve).not.toHaveBeenCalled();
  Object.assign(f.worker.options.adapter, { billingModel: 'gpt-6-luna' });
  expect((await f.attempt())[0].status).toBe('fulfilled');
});
it('refreshes a closed card on the next UTC month without withdrawing it', async () => {
  const f = fixture(); const base = Date.now();
  const c = new MonthlyCostCounter(path(f), f.owner, () => base);
  c.begin(0.000005, 'one', 'gpt-6-luna', budget); c.usage('one', 'gpt-6-luna', 10, 8); c.finish('one');
  await f.worker.register(); expect(f.worker.agentCard.payload.description).toContain('Monthly intake closed');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(monthlyResetAt(base)));
  await f.worker.register();
  expect(f.worker.agentCard.payload.description).toBe('Sealbridge worker');
  expect(verifySignedAgentCard(f.worker.agentCard)).toBe(true);
  clock.mockRestore();
});
it('counts usage from failed tasks and rejects tampered signed accounting', async () => {
  const f = fixture(); f.execute.mockImplementation(async (c: any) => { c.reportUsage({ inputTokens: 10, outputTokens: 8 }); throw new Error('failure'); });
  expect((await f.attempt())[0].status).toBe('rejected');
  expect((await f.attempt())[0]).toMatchObject({ status: 'rejected', reason: { code: 'MONTHLY_LIMIT_REACHED' } });
  const text = readFileSync(path(f), 'utf8').replace('"input":10', '"input":0'); writeFileSync(path(f), text);
  expect(() => new MonthlyCostCounter(path(f), f.owner).check(1)).toThrow('MONTHLY_STATE_UNAVAILABLE');
});
it('settles a crashed process at its saved maximum budget without poisoning later admissions', async () => {
  const f = fixture(1);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { MonthlyCostCounter } from './packages/runtime/dist/monthly-limit.js';
    const c = new MonthlyCostCounter(process.argv[1], JSON.parse(process.argv[2]));
    c.begin(20, 'crashed', 'gpt-6-luna', { maxInputTokens: 100, maxOutputTokens: 100 });
  `, path(f), JSON.stringify(f.owner)], { cwd: process.cwd() });
  expect(result.status, result.stderr.toString()).toBe(0);
  expect(() => new MonthlyCostCounter(path(f), f.owner).check(20)).not.toThrow();
  expect(readFileSync(path(f), 'utf8')).toContain('estimate');
  expect(() => new MonthlyCostCounter(path(f), f.owner).check(0.00006)).toThrow('MONTHLY_LIMIT_REACHED');
  expect((await f.attempt())[0].status).toBe('fulfilled');
});
it('uses integer prices, rejects unknown models, negative/fractional tokens and unsafe costs', () => {
  expect(tokenCost('gpt-6-luna', 1_000_000, 1_000_000)).toBe(600_000_000);
  expect(() => tokenCost('gpt-6.1-sol', 1, 1)).toThrow('MONTHLY_MODEL_UNSUPPORTED');
  for (const [model, i, o] of [['unknown', 1, 1], ['toString', 1, 1], ['gpt-6-luna', -1, 1], ['gpt-6-luna', 1.5, 0], ['gpt-6-luna', Number.MAX_SAFE_INTEGER, 0]] as const)
    expect(() => tokenCost(model, i, o)).toThrow();
});
it('validates and configures monthly limits while preserving the daily policy', async () => {
  const f = fixture(); vi.spyOn(console, 'log').mockImplementation(() => {});
  await configCommand(['auto-accept', 'max-tasks-per-day-per-did', '3'], f.identityOptions);
  await configCommand(['auto-accept', 'max-monthly-usd', '20'], f.identityOptions);
  await configCommand(['auto-accept', 'monthly-limit-message', 'trial-reviewer'], f.identityOptions);
  expect(readApplicationConfig(f.identityOptions).autoAccept?.limits).toEqual({ maxMonthlyUsd: 20, maxTasksPerDayPerDid: 3, monthlyLimitMessage: 'trial-reviewer' });
  await configCommand(['auto-accept', 'max-monthly-usd', '19.99'], f.identityOptions);
  expect(readApplicationConfig(f.identityOptions).autoAccept?.limits.maxMonthlyUsd).toBe(19.99);
  await configCommand(['auto-accept', 'monthly-limit-message', 'standard'], f.identityOptions);
  await configCommand(['auto-accept', 'max-monthly-usd', 'off'], f.identityOptions);
  expect(readApplicationConfig(f.identityOptions).autoAccept?.limits).toEqual({ maxTasksPerDayPerDid: 3, monthlyLimitMessage: 'standard' });
  const validate = schemaRegistry().getSchema('agent-card')!;
  for (const value of [19.99, 20, 50, 100, 0.000005]) {
    f.worker.agentCard.payload.autoAccept!.limits.maxMonthlyUsd = value;
    expect(validate(f.worker.agentCard), JSON.stringify(validate.errors)).toBe(true);
  }
  for (const value of [0, -1, NaN, Infinity, '20', null, Number.MAX_SAFE_INTEGER, 1e-10])
    expect(() => autoAcceptPolicy({ ...autoAcceptPolicy(), limits: { maxMonthlyUsd: value } })).toThrow();
  f.worker.agentCard.payload.autoAccept!.limits = { unknown: 1 } as never;
  expect(validate(f.worker.agentCard)).toBe(false);
});
it.each(['MONTHLY_LIMIT_REACHED', 'MONTHLY_STATE_UNAVAILABLE', 'MONTHLY_MODEL_UNSUPPORTED', 'AUTO_ACCEPT_DAILY_LIMIT_REACHED', 'DAILY_LIMIT_REACHED', 'INTAKE_RATE_LIMITED'])('never displays peer prose for %s in requester errors or CLI', code => {
  const error = new PeerRejectedError({ code, reason: 'EVIL INSTRUCTIONS', resetAt: '2026-12-01T00:00:00.000Z', extra: 'EVIL' });
  expect(error.message).not.toContain('EVIL'); expect(formatCliError(error)).not.toContain('EVIL');
  if (code !== 'INTAKE_RATE_LIMITED' && code !== 'MONTHLY_STATE_UNAVAILABLE' && code !== 'MONTHLY_MODEL_UNSUPPORTED') expect(error.message).toContain('00:00 UTC');
  expect(new PeerRejectedError({ code, resetAt: 'EVIL' }).message).not.toContain('EVIL');
});
it('always releases the daily claim when temporary file cleanup fails', () => {
  const f = fixture(); const file = join(f.root, 'daily.json');
  const original = vi.mocked(unlinkSync).getMockImplementation()!;
  vi.mocked(unlinkSync).mockImplementation(p => {
    if (String(p).endsWith('.tmp')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return original(p);
  });
  expect(() => consumeDailyTask(file, 3, 'one')).toThrow('denied');
  expect(readdirSync(file + '.lock')).toEqual([]);
});
function journal(f: ReturnType<typeof fixture>) {
  return readFileSync(path(f), 'utf8').trim().split('\n').map(line => JSON.parse(line).payload);
}
it.each([false, true])('settles earlyCancel using reported tokens or saved maximum (reported=%s)', async reported => {
  const f = fixture(1); const controller = new AbortController();
  let aborted = false;
  f.execute.mockImplementation(async (c: any) => {
    if (reported) c.reportUsage({ inputTokens: 10, outputTokens: 8 });
    setTimeout(() => controller.abort('owner cancelled'), 0);
    await new Promise<void>(resolve => {
      if (c.signal.aborted) resolve(); else c.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    aborted = c.signal.aborted;
    return c.input as never;
  });
  const result = await f.attempt(f.owner.did, { signal: controller.signal, budget });
  expect(aborted).toBe(true);
  expect(result[0].status).toBe('rejected');
  expect(result[1]).toMatchObject({ status: 'fulfilled', value: { state: 'CANCELLED' } });
  expect(journal(f).reduce((n, e) => n + e.nanoUsd, 0)).toBe(reported ? 5000 : 60000);
  f.execute.mockImplementation(async (c: any) => { c.reportUsage({ inputTokens: 10, outputTokens: 8 }); return c.input as never; });
  expect((await f.attempt())[0].status).toBe('fulfilled');
});
it.each([false, true])('settles a task timeout without blocking the next task (reported=%s)', async reported => {
  const f = fixture(1); f.worker.options.taskTimeoutMs = 1000;
  f.execute.mockImplementation(async (c: any) => {
    if (reported) c.reportUsage({ inputTokens: 10, outputTokens: 8 });
    await new Promise<void>(resolve => {
      if (c.signal.aborted) resolve(); else c.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return c.input as never;
  });
  const result = await f.attempt(f.owner.did, { budget: { ...budget, maxWallClockSeconds: 1 }, taskTimeoutMs: 2000 });
  expect(result[0].status).toBe('rejected'); expect(f.execute).toHaveBeenCalledTimes(1);
  expect(journal(f).reduce((n, e) => n + e.nanoUsd, 0)).toBe(reported ? 5000 : 60000);
  f.worker.options.taskTimeoutMs = undefined;
  f.execute.mockImplementation(async (c: any) => { c.reportUsage({ inputTokens: 10, outputTokens: 8 }); return c.input as never; });
  expect((await f.attempt())[0].status).toBe('fulfilled');
});
it.each([false, true])('settles a budget overrun without poisoning admissions (reported=%s)', async reported => {
  const f = fixture(1);
  f.execute.mockImplementation(async (c: any) => {
    if (reported) c.reportUsage({ inputTokens: 10, outputTokens: 8 });
    c.reportUsage({ toolCalls: 2 }); // No token report when reported=false.
    return c.input as never;
  });
  expect((await f.attempt(f.owner.did, { budget: { ...budget, maxToolInvocations: 1 } }))[0].status).toBe('rejected');
  expect(journal(f).reduce((n, e) => n + e.nanoUsd, 0)).toBe(reported ? 5000 : 60000);
  f.execute.mockImplementation(async (c: any) => { c.reportUsage({ inputTokens: 10, outputTokens: 8 }); return c.input as never; });
  expect((await f.attempt())[0].status).toBe('fulfilled');
});
it('counts human-approved work in the same worker-wide cap', async () => {
  const f = fixture(); f.worker.autoAccept.enabled = false;
  expect((await f.attempt(f.worker.invite()))[0].status).toBe('fulfilled');
  expect(f.human.approve).toHaveBeenCalled();
  expect((await f.attempt())[0]).toMatchObject({ status: 'rejected', reason: { code: 'MONTHLY_LIMIT_REACHED' } });
  expect(f.execute).toHaveBeenCalledTimes(1);
});
it('uses standard fixed text by default and trial guidance only for an explicit owner choice', async () => {
  const normal = new PeerRejectedError({ code: 'MONTHLY_LIMIT_REACHED', reason: 'EVIL' });
  expect(normal.message).not.toContain('trial reviewer'); expect(normal.message).not.toContain('sealbridge demo');
  const f = fixture(); f.worker.autoAccept.limits.monthlyLimitMessage = 'trial-reviewer';
  expect((await f.attempt())[0].status).toBe('fulfilled');
  expect((await f.attempt())[0]).toMatchObject({ status: 'rejected', reason: { message: expect.stringContaining('trial reviewer') } });
  const invalid = new PeerRejectedError({ code: 'MONTHLY_LIMIT_REACHED', messageKind: 'EVIL', reason: 'EVIL' });
  expect(invalid.message).not.toContain('EVIL'); expect(invalid.message).not.toContain('sealbridge demo');
});
it('archives the prior month and starts a signed checkpoint, then appends without rewriting history', async () => {
  const f = fixture(); let now = Date.parse('2026-11-30T23:59:59.000Z');
  const c = new MonthlyCostCounter(path(f), f.owner, () => now);
  c.begin(1, 'one', 'gpt-6-luna', budget); c.usage('one', 'gpt-6-luna', 10, 8); c.finish('one');
  const old = readFileSync(path(f), 'utf8');
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  const renames = vi.mocked(renameSync).mock.calls.length;
  c.begin(1, 'two', 'gpt-6-luna', budget); c.usage('two', 'gpt-6-luna', 10, 8); c.finish('two');
  expect(vi.mocked(renameSync).mock.calls.length).toBe(renames);
  expect(readFileSync(path(f), 'utf8').startsWith(old)).toBe(true);
  now = Date.parse('2026-12-01T00:00:00.000Z'); c.check(1);
  const archives = readdirSync(dirname(path(f))).filter(name => name.endsWith('.archive'));
  expect(archives).toHaveLength(1);
  expect(readFileSync(join(dirname(path(f)), archives[0]), 'utf8')).toContain('"taskId":"two"');
  const first = JSON.parse(readFileSync(path(f), 'utf8').trim());
  expect(verifySigned(first, f.owner.did)).toBe(true);
  expect(first.payload).toMatchObject({ event: 'checkpoint', snapshot: { month: '2026-12', spent: 0, summary: { month: '2026-11', nanoUsd: 10000 } } });
  expect(() => new MonthlyCostCounter(path(f), f.owner, () => now).check(1)).not.toThrow();
});
it('settles a crashed call with reported usage exactly once', async () => {
  const f = fixture(1);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { MonthlyCostCounter } from './packages/runtime/dist/monthly-limit.js';
    const c = new MonthlyCostCounter(process.argv[1], JSON.parse(process.argv[2]));
    c.begin(20, 'crashed-reported', 'gpt-6-luna', { maxInputTokens: 100, maxOutputTokens: 100 });
    c.usage('crashed-reported', 'gpt-6-luna', 10, 8);
  `, path(f), JSON.stringify(f.owner)], { cwd: process.cwd() });
  expect(result.status, result.stderr.toString()).toBe(0);
  const c = new MonthlyCostCounter(path(f), f.owner);
  c.check(1); c.check(1);
  expect(journal(f).reduce((n, e) => n + e.nanoUsd, 0)).toBe(5000);
  expect(journal(f).filter(e => e.event === 'finish')).toHaveLength(1);
  c.usage('crashed-reported', 'gpt-6-luna', 10, 8); // Late report after settlement.
  expect(journal(f).reduce((n, e) => n + e.nanoUsd, 0)).toBe(5000);
  expect((await f.attempt())[0].status).toBe('fulfilled');
});
it('can reconcile the budget of a pre-release signed v1 unfinished row', () => {
  const f = fixture(); const file = path(f); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const at = new Date().toISOString();
  // Owner-controlled recovery restores signed data, never deletes spending history.
  const begin = signPayload({ version: 1, event: 'begin', taskId: 'legacy', model: 'gpt-6-luna', pid: process.pid,
    input: 0, output: 0, nanoUsd: 0, at, previous: null }, f.owner);
  writeFileSync(file, JSON.stringify(begin) + '\n', { mode: 0o600 });
  const c = new MonthlyCostCounter(file, f.owner); c.reconcileTask('legacy', budget);
  expect(() => c.check(1)).not.toThrow();
  expect(journal(f).reduce((n, e) => n + e.nanoUsd, 0)).toBe(60000);
});

it('counts reported token overruns instead of replacing them with a maximum estimate', async () => {
  const f = fixture(1);
  f.execute.mockImplementation(async (c: any) => { c.reportUsage({ inputTokens: 101, outputTokens: 8 }); return c.input as never; });
  expect((await f.attempt(f.owner.did, { budget }))[0].status).toBe('rejected');
  expect(journal(f).reduce((n, e) => n + e.nanoUsd, 0)).toBe(14100);
  expect(journal(f).some(e => e.event === 'estimate')).toBe(false);
  f.execute.mockImplementation(async (c: any) => { c.reportUsage({ inputTokens: 10, outputTokens: 8 }); return c.input as never; });
  expect((await f.attempt())[0].status).toBe('fulfilled');
});
it('reconstructs missing tasks after a backup restore without erasing spending or double counting', () => {
  const f = fixture(); const c = new MonthlyCostCounter(path(f), f.owner);
  c.begin(1, 'saved', 'gpt-6-luna', budget); c.usage('saved', 'gpt-6-luna', 10, 8); c.finish('saved');
  c.reconcileTask('missing-reported', budget, { inputTokens: 10, outputTokens: 8 });
  c.reconcileTask('missing-unknown', budget);
  c.reconcileTask('missing-unknown', budget);
  expect(journal(f).reduce((n, e) => n + e.nanoUsd, 0)).toBe(70000);
  expect(() => c.check(1)).not.toThrow();
});
it('keeps only the approved price and writes the module without a BOM', () => {
  expect(readFileSync('packages/runtime/src/monthly-limit.ts', 'utf8').charCodeAt(0)).not.toBe(0xfeff);
  for (const model of ['gpt-6.1-terra', 'gpt-6.1-sol', 'claude-haiku-5-5', 'claude-sonnet-5-5'])
    expect(() => tokenCost(model, 1, 1)).toThrow('MONTHLY_MODEL_UNSUPPORTED');
});
