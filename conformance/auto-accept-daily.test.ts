// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { autoAcceptPolicy, digest, generateKeyPair, verifySignedAgentCard } from '../packages/core/src/index.js';
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
it.each(['corrupt', 'unreadable', 'locked', 'unwritable'] as const)('fails closed for %s counting state', async failure => {
  const f = fixture(); const file = path(f);
  mkdirSync(dirname(file), { recursive: true });
  if (failure === 'corrupt') writeFileSync(file, '{bad');
  if (failure === 'unreadable') mkdirSync(file);
  if (failure === 'locked') writeFileSync(file + '.lock', '');
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
it.each([0, -1, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 1])('rejects invalid configured limits: %s', value => {
  expect(() => autoAcceptPolicy({ ...autoAcceptPolicy(), limits: { maxTasksPerDayPerDid: value } })).toThrow('AUTO_ACCEPT_POLICY_INVALID');
});
