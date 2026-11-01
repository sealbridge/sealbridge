// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '../packages/core/src/index.js';

const captured = vi.hoisted(() => ({ options: undefined as any }));
vi.mock('../packages/runtime/dist/index.js', async (original) => ({
  ...await original<typeof import('../packages/runtime/src/index.js')>(),
  WorkerNode: class {
    constructor(options: any) { captured.options = options; }
    invite() { return 'test invite'; }
    async start() {}
    stop() {}
  },
}));
import { networkCommand } from '../cli/src/network.js';

async function run(args: string[]) {
  const dir = await mkdtemp(join(realpathSync(tmpdir()), 'acp-g3-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const key = join(dir, 'worker.private.json');
    await writeFile(key, JSON.stringify(generateKeyPair()), { mode: 0o600 });
    await networkCommand('worker', ['start', '--key', key, '--relay', 'https://relay.example', ...args]);
    return captured.options;
  } finally { log.mockRestore(); await rm(dir, { recursive: true, force: true }); }
}

it.each(['3', '3/m', '3/min', '3/60s'])('maps rate %s to the per-DID minute limiter', async (rate) => {
  expect((await run(['--open', '--open-rate-limit-per-did', rate])).maxTasksPerRequesterPerMinute).toBe(3);
});
it.each(['0', '-1', '1.5', '01', 'Infinity', '9007199254740992', '2/s', '2/120s', '2/minute', '2/', ''])
  ('rejects invalid rate %s', async (rate) => {
    await expect(run(['--open', '--open-rate-limit-per-did', rate])).rejects.toThrow('INVALID_OPEN_RATE_LIMIT_PER_DID');
  });
it('rejects a missing rate', async () => {
  await expect(run(['--open', '--open-rate-limit-per-did'])).rejects.toThrow('INVALID_OPEN_RATE_LIMIT_PER_DID');
});
it.each([1, 5])('retains the stricter existing rate (%s)', async (limit) => {
  expect((await run(['--open', '--open-rate-limit-per-did', '3', '--max-requests-per-minute', String(limit)]))
    .maxTasksPerRequesterPerMinute).toBe(Math.min(3, limit));
});
it('normalizes repeated task types on advertised skills', async () => {
  const options = await run(['--access-mode', 'open', '--open-allow-task-type', 'json, text',
    '--open-allow-task-type', 'json']);
  expect(options.adapter.skills.every((skill: any) => JSON.stringify(skill.taskTypes) === '["json","text"]')).toBe(true);
});
it.each(['json,', ',json', ' , '])('rejects empty task type entries (%s)', async (types) => {
  await expect(run(['--open', '--open-allow-task-type', types])).rejects.toThrow('INVALID_OPEN_ALLOW_TASK_TYPE');
});
it('rejects conflicting task type flags', async () => {
  await expect(run(['--open', '--open-allow-task-type', 'json', '--task-type', 'text']))
    .rejects.toThrow('CONFLICTING_OPEN_TASK_TYPE');
});
it.each([['--open-allow-task-type', 'json'], ['--open-rate-limit-per-did', '1']])
  ('requires open mode for %s', async (flag, value) => {
    await expect(run([flag, value])).rejects.toThrow('OPEN_POLICY_REQUIRES_OPEN_MODE');
  });
