// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { autoAcceptPolicy, digest, generateKeyPair, verifySignedAgentCard, schemaRegistry } from '../packages/core/src/index.js';
import { RequesterClient, PolicyAutoApprovalProvider, workerIntakePath } from '../packages/runtime/src/index.js';
import { consumeDailyTask } from '../packages/runtime/src/daily-limit.js';
import { configCommand } from '../cli/src/config.js';
import { readApplicationConfig } from '../packages/runtime/src/application-config.js';
import { admissionFixture } from './connections-fixture.js';
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});

const fixtures: ReturnType<typeof admissionFixture>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) f.cleanup(); });
function fixture(limit = 3) {
  const f = admissionFixture({ autoAccept: { ...autoAcceptPolicy(), from: 'anyone', limits: { maxTasksPerDayPerDid: limit } } });
  f.worker.options.identityOptions = f.identityOptions;
  Object.assign(f.worker.options.adapter, { taskAccess: 'read-only' });
  fixtures.push(f);
  return f;
}
function path(f: ReturnType<typeof fixture>, did = f.requester.did) {
  return join(dirname(workerIntakePath(f.owner.did, f.identityOptions)), 'auto-accept-daily', digest(did).slice(7) + '.json');
}
it('accepts exactly three tasks, then rejects with fixed bilingual reset guidance before approval or execution', async () => {
  const f = fixture();
  expect(verifySignedAgentCard(f.worker.agentCard)).toBe(true);
  for (let i = 0; i < 3; i++) expect((await f.attempt())[0].status).toBe('fulfilled');
  expect((await f.attempt())[0]).toMatchObject({ status: 'rejected', reason: {
    code: 'AUTO_ACCEPT_DAILY_LIMIT_REACHED', message: expect.stringContaining('00:00 UTC'),
  } });
  expect(f.execute).toHaveBeenCalledTimes(3);
  expect(f.human.approve).not.toHaveBeenCalled();
});
it('counts different owner DIDs independently', async () => {
  const f = fixture(1);
  expect((await f.attempt())[0].status).toBe('fulfilled');
  const other = generateKeyPair();
  const client = new RequesterClient({ owner: other, relay: f.relay, approvalProvider: new PolicyAutoApprovalProvider(other) });
  const results = await Promise.allSettled([client.delegate({ ...f.task, to: f.owner.did }), f.worker.start({ once: true })]);
  expect(results[0].status).toBe('fulfilled');
  expect((await f.attempt())[0]).toMatchObject({ status: 'rejected', reason: { code: 'AUTO_ACCEPT_DAILY_LIMIT_REACHED' } });
  expect(f.execute).toHaveBeenCalledTimes(2);
});
it('explains a repeated task ID without treating it as unavailable state or consuming another slot', async () => {
  const f = fixture();
  const result = await f.attempt(f.owner.did, { beforePropose: async ({ manifest }: { manifest: { taskId: string } }) => {
    consumeDailyTask(path(f), 3, manifest.taskId);
  } });
  expect(result[0]).toMatchObject({ status: 'rejected', reason: {
    code: 'AUTO_ACCEPT_DAILY_TASK_REPLAY', message: expect.stringContaining('already reserved'),
  } });
  expect(JSON.parse(readFileSync(path(f), 'utf8')).tasks).toHaveLength(1);
  expect(f.execute).not.toHaveBeenCalled();
});
it.each(['corrupt', 'unreadable', 'locked', 'unwritable'] as const)('fails closed for %s counting state', async failure => {
  const f = fixture(); const file = path(f);
  // Match the production private-directory modes, including newly created ancestors.
  // Otherwise POSIX startup rejects the fixture before it can receive a proposal.
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (failure === 'corrupt') writeFileSync(file, '{bad', { mode: 0o600 });
  if (failure === 'unreadable') mkdirSync(file, { mode: 0o700 });
  if (failure === 'locked') writeFileSync(file + '.lock', '', { mode: 0o600 });
  if (failure === 'unwritable') {
    const original = (await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync;
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (to === file) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return original(from, to);
    });
  }
  expect((await f.attempt())[0]).toMatchObject({ status: 'rejected', reason: { code: 'AUTO_ACCEPT_DAILY_STATE_UNAVAILABLE' } });
  expect(f.execute).not.toHaveBeenCalled(); expect(f.human.approve).not.toHaveBeenCalled();
});
it('persists reservations, resets exactly at midnight UTC, and rejects clock rollback and replay', () => {
  const f = fixture(1); const file = path(f);
  const before = Date.parse('2026-11-12T23:59:59.999Z');
  consumeDailyTask(file, 1, 'first', before);
  expect(() => consumeDailyTask(file, 1, 'second', before)).toThrow('DAILY_LIMIT_REACHED');
  consumeDailyTask(file, 1, 'second', before + 1);
  expect(() => consumeDailyTask(file, 1, 'second', before + 1)).toThrow('DAILY_TASK_REPLAY');
  expect(() => consumeDailyTask(file, 1, 'third', before)).toThrow('DAILY_LIMIT_CLOCK_ROLLBACK');
});
it('configures the official three-task limit and removes it without changing audience or work', async () => {
  const f = fixture(); vi.spyOn(console, 'log').mockImplementation(() => {});
  await configCommand(['auto-accept', 'max-tasks-per-day-per-did', '3'], f.identityOptions);
  expect(readApplicationConfig(f.identityOptions).autoAccept).toEqual({ ...autoAcceptPolicy(), limits: { maxTasksPerDayPerDid: 3 } });
  await configCommand(['auto-accept', 'max-tasks-per-day-per-did', 'off'], f.identityOptions);
  expect(readApplicationConfig(f.identityOptions).autoAccept?.limits).toEqual({});
});
it('validates advertised daily limits against the public AgentCard schema', () => {
  const f = fixture();
  const validate = schemaRegistry().getSchema('agent-card')!;
  expect(validate(f.worker.agentCard), JSON.stringify(validate.errors)).toBe(true);
  for (const limits of [{}, { maxTasksPerDayPerDid: 1 }, { maxTasksPerDayPerDid: Number.MAX_SAFE_INTEGER }]) {
    const card = structuredClone(f.worker.agentCard); card.payload.autoAccept!.limits = limits;
    expect(validate(card), JSON.stringify(validate.errors)).toBe(true);
  }
  for (const limits of [{ maxTasksPerDayPerDid: 0 }, { maxTasksPerDayPerDid: 1.5 },
    { maxTasksPerDayPerDid: '3' }, { maxTasksPerDayPerDid: Number.MAX_SAFE_INTEGER + 1 }, { monthlyUsd: 3 }]) {
    const card = structuredClone(f.worker.agentCard); card.payload.autoAccept!.limits = limits as never;
    expect(validate(card)).toBe(false);
  }
});
it('recovers a crashed process claim without losing reservations or resetting the cap', () => {
  const f = fixture(2); const file = path(f);
  consumeDailyTask(file, 2, 'first');
  // Publish the real child PID, then terminate without releasing its claim.
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs'), crypto = require('node:crypto'), path = require('node:path');
    fs.writeFileSync(path.join(process.argv[1], process.pid + '-' + crypto.randomUUID()), '', {mode: 0o600});
    process.kill(process.pid, 'SIGKILL');
  `, file + '.lock']);
  expect(child.error).toBeUndefined();
  expect(readdirSync(file + '.lock')).toHaveLength(1);
  consumeDailyTask(file, 2, 'second');
  expect(readdirSync(file + '.lock')).toEqual([]);
  expect(JSON.parse(readFileSync(file, 'utf8')).tasks).toEqual(['first', 'second']);
  expect(() => consumeDailyTask(file, 2, 'third')).toThrow('DAILY_LIMIT_REACHED');
});
it.each(['live', 'unknown', 'malformed'] as const)('never reclaims a %s owner claim', mode => {
  const f = fixture(); const file = path(f), lock = file + '.lock';
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  const name = mode === 'malformed' ? 'invalid' : `${process.pid}-${randomUUID()}`;
  writeFileSync(join(lock, name), '', { mode: 0o600 });
  if (mode === 'unknown') vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  expect(() => consumeDailyTask(file, 3, 'first')).toThrow('DAILY_LIMIT_BUSY');
  expect(readdirSync(lock)).toEqual([name]);
});
it.each([0, -1, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 1])('rejects invalid configured limits: %s', value => {
  expect(() => autoAcceptPolicy({ ...autoAcceptPolicy(), limits: { maxTasksPerDayPerDid: value } })).toThrow('AUTO_ACCEPT_POLICY_INVALID');
});
