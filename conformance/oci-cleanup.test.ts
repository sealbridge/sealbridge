// SPDX-License-Identifier: Apache-2.0
import { spawn, execFile } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync, rmdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { runContainerOrSubprocessSandbox } from '../packages/sandbox/src/container.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  rm: vi.fn((await original<typeof import('node:fs/promises')>()).rm),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

it.each([
  'success',
  'task error',
  'protocol error',
  'tool error',
  'abort',
  'pre-aborted',
  'timeout',
  'spawn error',
  'early close',
])('releases the OCI process and streams before directory removal: %s', async (scenario) => {
  const events: string[] = [];
  const controller = new AbortController();
  if (scenario === 'pre-aborted') controller.abort();
  if (scenario === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let directory = '';
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    kill: vi.fn(() => {
      events.push('terminate');
      return true;
    }),
  });
  // The runtime removal completes before the run process closes. In particular,
  // exit is not enough: stdio is still owned until the following close event.
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    events.push('runtime removed');
    const callback = args.at(-1) as () => void;
    callback();
    if (scenario === 'early close') return child as unknown as ReturnType<typeof execFile>;
    setImmediate(() => {
      child.exitCode = 0;
      child.emit('exit', 0);
      events.push('exit');
      setImmediate(() => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        events.push('close');
        child.emit('close', 0);
      });
    });
    return child as unknown as ReturnType<typeof execFile>;
  });
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(rm).mockImplementationOnce(async (path, options) => {
    events.push('remove directory');
    await actual.rm(path, options);
  });
  const result = await runContainerOrSubprocessSandbox({
    isolationLevel: 'oci_container',
    runtime: 'docker',
    timeoutMs: 2000,
    code: 'return 7;',
    onTool: async () => {
      throw new Error('TOOL_FAILED');
    },
    signal: controller.signal,
    containerSpawn: (_runtime, _args, options) => {
      directory = options.cwd;
      setImmediate(() => {
        if (scenario === 'abort') controller.abort();
        else if (scenario === 'pre-aborted') return;
        else if (scenario === 'timeout') vi.advanceTimersByTime(2000);
        else if (scenario === 'spawn error') child.emit('error', new Error('SPAWN_FAILED'));
        else if (scenario === 'early close') {
          child.exitCode = 1;
          events.push('close');
          child.emit('close', 1);
        } else if (scenario === 'tool error') {
          child.stdout.write(
            JSON.stringify({ type: 'tool', name: 'read', id: 1, args: {} }) + '\n',
          );
        } else
          child.stdout.write(
            scenario === 'protocol error'
              ? 'invalid\n'
              : JSON.stringify({
                  type: 'done',
                  value: 7,
                  ...(scenario === 'task error' ? { error: 'TASK_FAILED' } : {}),
                }) + '\n',
          );
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  if (scenario === 'success') expect(result).toHaveProperty('value.output', 7);
  else {
    const messages: Record<string, string> = {
      'task error': 'TASK_FAILED',
      'tool error': 'TOOL_FAILED',
      abort: 'SANDBOX_HALTED',
      'pre-aborted': 'SANDBOX_HALTED',
      timeout: 'SANDBOX_TIMEOUT',
      'spawn error': 'SPAWN_FAILED',
      'early close': 'CONTAINER_EXIT: 1',
    };
    expect(result).toHaveProperty('error');
    if (scenario !== 'protocol error')
      expect(result).toHaveProperty('error.message', messages[scenario]);
    else expect(result).toHaveProperty('error.name', 'SyntaxError');
  }
  expect(events.indexOf('remove directory'), events.join(' -> ')).toBeGreaterThan(
    events.indexOf('close'),
  );
  expect(events).toContain('close');
  expect(existsSync(directory)).toBe(false);
});

it.runIf(process.platform === 'win32')(
  'a live child cwd is an EBUSY holder until close',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'acp-oci-holder-'));
    const child = spawn(
      process.execPath,
      ['-e', "process.stdin.resume();process.stdout.write('ready');"],
      {
        cwd: directory,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const closed = once(child, 'close');
    try {
      await once(child.stdout, 'data');
      expect(() => rmdirSync(directory)).toThrow(expect.objectContaining({ code: 'EBUSY' }));
    } finally {
      child.kill('SIGKILL');
      await closed;
      await rm(directory, { recursive: true, force: true });
    }
    expect(existsSync(directory)).toBe(false);
  },
);
