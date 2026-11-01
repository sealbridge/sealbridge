// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { realpathSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '../packages/core/src/index.js';
import type { DelegateOptions, RequesterClientOptions, WorkerNodeOptions } from '../packages/runtime/src/session.js';

const captured = vi.hoisted(() => ({ worker: undefined as WorkerNodeOptions | undefined,
  requester: undefined as RequesterClientOptions | undefined, task: undefined as DelegateOptions | undefined }));
vi.mock('../packages/runtime/dist/index.js', async original => {
  const runtime = await original<typeof import('../packages/runtime/src/index.js')>();
  return { ...runtime,
    WorkerNode: class extends runtime.WorkerNode {
      constructor(options: WorkerNodeOptions) { super(options); captured.worker = options; }
      override async start() { return undefined; }
    },
    RequesterClient: class {
      constructor(options: RequesterClientOptions) { captured.requester = options; }
      async delegate(options: DelegateOptions) {
        captured.task = options;
        return { taskId: 'task_local', state: 'SETTLED', deliverable: null };
      }
    },
  };
});
import { networkCommand } from '../cli/src/network.js';
afterEach(() => vi.restoreAllMocks());

it('forwards delegate execution, overall, wait, connect, idle and heartbeat flags', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'acp-timeout-cli-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const key = join(dir, 'owner.private.json');
    writeFileSync(key, JSON.stringify(generateKeyPair()), { mode: 0o600 });
    await networkCommand('delegate', ['--key', key, '--to', generateKeyPair().did,
      '--relay', 'https://relay.example', '--title', 'local', '--description', 'local task', '--input', '{}',
      '--execution-timeout-ms', '240000', '--task-timeout-ms', '600000', '--wait-timeout-ms', '300000',
      '--connect-timeout-ms', '20000', '--transport-idle-timeout-ms', '45000', '--heartbeat-interval-ms', '10000']);
    const expected = { executionTimeoutMs: 240000, taskTimeoutMs: 600000, waitTimeoutMs: 300000,
      connectTimeoutMs: 20000, transportIdleTimeoutMs: 45000, heartbeatIntervalMs: 10000 };
    expect(captured.task).toMatchObject(expected);
    expect(captured.requester).toMatchObject(expected);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('forwards matching worker timeout flags and installs status reporting', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'acp-worker-timeout-cli-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const key = join(dir, 'owner.private.json');
    writeFileSync(key, JSON.stringify(generateKeyPair()), { mode: 0o600 });
    await networkCommand('worker', ['start', '--key', key, '--relay', 'https://relay.example',
      '--contacts', join(dir, 'contacts.json'), '--execution-timeout-ms', '240000',
      '--task-timeout-ms', '600000', '--wait-timeout-ms', '300000', '--connect-timeout-ms', '20000',
      '--transport-idle-timeout-ms', '45000', '--heartbeat-interval-ms', '10000']);
    expect(captured.worker).toMatchObject({ executionTimeoutMs: 240000, taskTimeoutMs: 600000,
      waitTimeoutMs: 300000, connectTimeoutMs: 20000, transportIdleTimeoutMs: 45000, heartbeatIntervalMs: 10000 });
    expect(captured.worker?.onStatus).toBeTypeOf('function');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each(['delegate', 'worker'])('documents timeout defaults in %s help without loading an identity', async command => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await networkCommand(command, command === 'worker' ? ['start', '--help'] : ['--help']);
  const help = String(log.mock.calls[0][0]);
  for (const flag of ['execution', 'task', 'wait', 'connect', 'transport-idle'])
    expect(help).toContain('--' + flag + '-timeout-ms');
  expect(help).toContain('--heartbeat-interval-ms');
  for (const value of ['60000', '600000', '45000', '90000', '15000']) expect(help).toContain(value);
});
