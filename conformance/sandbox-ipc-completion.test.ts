// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { runSandbox } from '../packages/sandbox/src/index.js';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

function child(events: (process: EventEmitter & { stderr: PassThrough }) => void) {
  vi.mocked(spawn).mockImplementationOnce(() => {
    const process = Object.assign(new EventEmitter(), {
      stderr: new PassThrough(), exitCode: 0, connected: false,
      kill: vi.fn(() => true), send: vi.fn(),
    });
    setImmediate(() => events(process));
    return process as unknown as ReturnType<typeof spawn>;
  });
}

it('drains a successful IPC result arriving after process exit but before close', async () => {
  child(process => {
    process.emit('exit', 0);
    setImmediate(() => {
      process.emit('message', { type: 'done', value: { ok: true } });
      process.emit('close', 0);
    });
  });
  await expect(runSandbox({ code: 'return input;', timeoutMs: 2000,
    onTool: async () => null })).resolves.toEqual({ ok: true });
});

it('drains queued IPC handlers before treating a clean close as failure', async () => {
  child(process => {
    process.emit('message', { type: 'tool', id: 1, name: 'slow', args: {} });
    process.emit('message', { type: 'done', value: { ok: true } });
    process.emit('exit', 0);
    process.emit('close', 0);
  });
  await expect(runSandbox({ code: "callTool('slow', {}); return input;", timeoutMs: 2000,
    onTool: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return null; },
  })).resolves.toEqual({ ok: true });
});

it('still rejects a child that closes without a result', async () => {
  child(process => {
    process.emit('exit', 1);
    process.stderr.emit('data', Buffer.from('worker failed'));
    process.emit('close', 1);
  });
  await expect(runSandbox({ code: 'return input;', timeoutMs: 2000,
    onTool: async () => null })).rejects.toThrow('SANDBOX_EXIT: 1 worker failed');
});
