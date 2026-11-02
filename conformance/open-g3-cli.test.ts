// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '../packages/core/src/index.js';

const captured = vi.hoisted(() => ({ options: undefined as any }));
vi.mock('../packages/runtime/dist/index.js', async (original) => {
  const runtime = await original<typeof import('../packages/runtime/src/index.js')>();
  return { ...runtime, WorkerNode: class extends runtime.WorkerNode {
    constructor(options: any) { super(options); captured.options = options; }
    override async start() { return undefined; }
  } };
});
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

it('maps general host rate without access mode', async () => {
  expect((await run(['--max-requests-per-minute', '3'])).maxTasksPerRequesterPerMinute).toBe(3);
});
it.each(['0', '-1', '1.5', 'Infinity', '9007199254740992'])('rejects invalid general rate %s', async rate => {
  await expect(run(['--max-requests-per-minute', rate])).rejects.toThrow('INVALID_MAX_REQUESTS_PER_MINUTE');
});
it('normalizes repeatable task types independently of publication', async () => {
  const options = await run(['--allow-task-type', 'json, text', '--allow-task-type', 'json']);
  expect(options.adapter.skills.every((skill: any) => JSON.stringify(skill.taskTypes) === '["json","text"]')).toBe(true);
});
it.each(['json,', ',json', ' , '])('rejects empty task type entries (%s)', async types => {
  await expect(run(['--allow-task-type', types])).rejects.toThrow('INVALID_ALLOW_TASK_TYPE');
});
it('rejects conflicting task type flags', async () => {
  await expect(run(['--allow-task-type', 'json', '--task-type', 'text'])).rejects.toThrow('CONFLICTING_TASK_TYPE');
});
