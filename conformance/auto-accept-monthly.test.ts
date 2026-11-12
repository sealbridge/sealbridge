// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { autoAcceptPolicy, schemaRegistry, verifySignedAgentCard, verifySigned } from '../packages/core/src/index.js';
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
  return { ...fs, unlinkSync: vi.fn(fs.unlinkSync), renameSync: vi.fn(fs.renameSync) };
});
const fixtures: ReturnType<typeof admissionFixture>[] = [];
afterEach(() => { vi.restoreAllMocks(); fixtures.splice(0).forEach(f => f.cleanup()); });
function fixture(limit = 0.000005) {
  const f = admissionFixture({ now: () => Date.now(), autoAccept: { ...autoAcceptPolicy(), from: 'anyone', limits: { maxMonthlyUsd: limit } } });
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
  counter.begin(0.000005, 'one', 'gpt-6-luna'); counter.usage('one', 'gpt-6-luna', 10, 8); counter.finish('one', 'gpt-6-luna', true);
  expect(() => new MonthlyCostCounter(path(f), f.owner, () => now).check(0.000005)).toThrow('MONTHLY_LIMIT_REACHED');
  expect(monthlyResetAt(now)).toBe('2027-01-01T00:00:00.000Z');
  now++; counter.begin(0.000005, 'two', 'gpt-6-luna'); counter.finish('two', 'gpt-6-luna', true);
  now--; expect(() => counter.check(1)).toThrow('MONTHLY_STATE_UNAVAILABLE');
  expect(monthlyResetAt(Date.parse('2028-02-29T23:59:59Z'))).toBe('2028-03-01T00:00:00.000Z');
});
it('allows already running tasks to finish after another reaches the cap and counts their overshoot', () => {
  const f = fixture(); const c = new MonthlyCostCounter(path(f), f.owner);
  c.begin(0.000005, 'one', 'gpt-6-luna'); c.begin(0.000005, 'two', 'gpt-6-luna');
  c.usage('one', 'gpt-6-luna', 10, 8); c.finish('one', 'gpt-6-luna', true);
  expect(() => c.begin(0.000005, 'three', 'gpt-6-luna')).toThrow('MONTHLY_LIMIT_REACHED');
  c.usage('two', 'gpt-6-luna', 10, 8); c.finish('two', 'gpt-6-luna', true);
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
it('fails closed after missing usage', async () => {
  const f = fixture(1); f.execute.mockImplementation(async (c: any) => c.input as never);
  expect((await f.attempt())[0].status).toBe('rejected');
  expect((await f.attempt())[0]).toMatchObject({ status: 'rejected', reason: { code: 'MONTHLY_STATE_UNAVAILABLE' } });
  expect(f.execute).toHaveBeenCalledTimes(1);
});
it('fails closed when reporting cannot persist, even if the adapter returns successfully', async () => {
  const f = fixture(1); const file = path(f);
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  let writes = 0;
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (to === file && ++writes === 2) throw new Error('usage write denied');
    return fs.renameSync(from, to);
  });
  expect((await f.attempt())[0].status).toBe('rejected');
  expect((await f.attempt())[0]).toMatchObject({ status: 'rejected', reason: { code: 'MONTHLY_STATE_UNAVAILABLE' } });
  expect(f.execute).toHaveBeenCalledTimes(1);
});
it('rejects unknown model prices before approval or execution', async () => {
  const f = fixture(); Object.assign(f.worker.options.adapter, { billingModel: 'unknown' });
  expect((await f.attempt())[0]).toMatchObject({ status: 'rejected', reason: { code: 'MONTHLY_STATE_UNAVAILABLE' } });
  expect(f.execute).not.toHaveBeenCalled(); expect(f.human.approve).not.toHaveBeenCalled();
});
it('refreshes a closed card on the next UTC month without withdrawing it', async () => {
  const f = fixture(); const base = Date.now();
  const c = new MonthlyCostCounter(path(f), f.owner, () => base);
  c.begin(0.000005, 'one', 'gpt-6-luna'); c.usage('one', 'gpt-6-luna', 10, 8); c.finish('one', 'gpt-6-luna', true);
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
it('fails closed across a crashed process with unreported usage', () => {
  const f = fixture();
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { MonthlyCostCounter } from './packages/runtime/dist/monthly-limit.js';
    const c = new MonthlyCostCounter(process.argv[1], JSON.parse(process.argv[2]));
    c.begin(20, 'crashed', 'gpt-6-luna');
  `, path(f), JSON.stringify(f.owner)], { cwd: process.cwd() });
  expect(result.status, result.stderr.toString()).toBe(0);
  expect(() => new MonthlyCostCounter(path(f), f.owner).check(20)).toThrow('MONTHLY_STATE_UNAVAILABLE');
});
it('uses integer prices, rejects unknown models, negative/fractional tokens and unsafe costs', () => {
  expect(tokenCost('gpt-6-luna', 1_000_000, 1_000_000)).toBe(600_000_000);
  expect(tokenCost('gpt-6.1-sol', 1_000_000, 1_000_000)).toBe(12_000_000_000);
  for (const [model, i, o] of [['unknown', 1, 1], ['toString', 1, 1], ['gpt-6-luna', -1, 1], ['gpt-6-luna', 1.5, 0], ['gpt-6-luna', Number.MAX_SAFE_INTEGER, 0]] as const)
    expect(() => tokenCost(model, i, o)).toThrow();
});
it('validates and configures monthly limits while preserving the daily policy', async () => {
  const f = fixture(); vi.spyOn(console, 'log').mockImplementation(() => {});
  await configCommand(['auto-accept', 'max-tasks-per-day-per-did', '3'], f.identityOptions);
  await configCommand(['auto-accept', 'max-monthly-usd', '20'], f.identityOptions);
  expect(readApplicationConfig(f.identityOptions).autoAccept?.limits).toEqual({ maxMonthlyUsd: 20, maxTasksPerDayPerDid: 3 });
  await configCommand(['auto-accept', 'max-monthly-usd', 'off'], f.identityOptions);
  expect(readApplicationConfig(f.identityOptions).autoAccept?.limits).toEqual({ maxTasksPerDayPerDid: 3 });
  const validate = schemaRegistry().getSchema('agent-card')!;
  for (const value of [20, 50, 100, 0.000005]) {
    f.worker.agentCard.payload.autoAccept!.limits.maxMonthlyUsd = value;
    expect(validate(f.worker.agentCard), JSON.stringify(validate.errors)).toBe(true);
  }
  for (const value of [0, -1, NaN, Infinity, '20', null, Number.MAX_SAFE_INTEGER, 1e-10])
    expect(() => autoAcceptPolicy({ ...autoAcceptPolicy(), limits: { maxMonthlyUsd: value } })).toThrow();
  f.worker.agentCard.payload.autoAccept!.limits = { unknown: 1 } as never;
  expect(validate(f.worker.agentCard)).toBe(false);
});
it.each(['MONTHLY_LIMIT_REACHED', 'MONTHLY_STATE_UNAVAILABLE', 'AUTO_ACCEPT_DAILY_LIMIT_REACHED', 'DAILY_LIMIT_REACHED', 'INTAKE_RATE_LIMITED'])('never displays peer prose for %s in requester errors or CLI', code => {
  const error = new PeerRejectedError({ code, reason: 'EVIL INSTRUCTIONS', resetAt: '2026-12-01T00:00:00.000Z', extra: 'EVIL' });
  expect(error.message).not.toContain('EVIL'); expect(formatCliError(error)).not.toContain('EVIL');
  if (code !== 'INTAKE_RATE_LIMITED' && code !== 'MONTHLY_STATE_UNAVAILABLE') expect(error.message).toContain('00:00 UTC');
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
