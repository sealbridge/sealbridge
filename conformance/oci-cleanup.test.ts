import { removeTestFixture } from './test-fixture-cleanup.mjs';
// SPDX-License-Identifier: Apache-2.0
import { spawn, execFile } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter, getEventListeners, once } from 'node:events';
import { existsSync, readFileSync, rmdirSync } from 'node:fs';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import {
  detectDockerRuntime,
  runContainerOrSubprocessSandbox,
} from '../packages/sandbox/src/container.js';

function assertCliEnvironment(options: { cwd: string; env: NodeJS.ProcessEnv }) {
  const cli = options.cwd;
  expect(cli.endsWith('cli')).toBe(true);
  for (const name of [
    'HOME',
    'TMPDIR',
    'DOCKER_CONFIG',
    ...(process.platform === 'win32'
      ? ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']
      : []),
  ])
    expect(options.env[name]).toBe(cli);
  expect(options.env.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
  expect(options.env).not.toHaveProperty('SEALBRIDGE_ALLOW_ROOT_LOCAL_EXECUTION');
}

function processFixture() {
  return Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null as number | null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => false),
    unref: vi.fn(),
  });
}

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  rmdir: vi.fn((await original<typeof import('node:fs/promises')>()).rmdir),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

it('uses protected CLI state even for standalone runtime detection', async () => {
  let cli = '';
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    expect(args[1]).toEqual(['info']);
    const options = args[2] as { cwd: string; env: Record<string, string> };
    cli = options.cwd;
    assertCliEnvironment(options);
    expect(options.env).toMatchObject({ DOCKER_CONFIG: cli, HOME: cli, TMPDIR: cli });
    expect(readFileSync(join(cli, 'config.json'), 'utf8')).toBe('{}');
    (args.at(-1) as () => void)();
    return new EventEmitter() as ReturnType<typeof execFile>;
  });
  expect(await detectDockerRuntime()).toBe('podman');
  expect(existsSync(join(cli, '..'))).toBe(false);
});

it.each([
  'success',
  'task error',
  'ASCII result over limit',
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
    pid: scenario === 'spawn error' ? undefined : 123,
    signalCode: null,
    unref: vi.fn(),
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
    assertCliEnvironment(args[2] as { cwd: string; env: NodeJS.ProcessEnv });
    events.push('runtime removed');
    const callback = args.at(-1) as () => void;
    callback();
    const remover = Object.assign(new EventEmitter(), {
      pid: 124,
      exitCode: 0,
      signalCode: null,
      unref: vi.fn(),
    });
    if (scenario === 'early close' || scenario === 'spawn error')
      return remover as unknown as ReturnType<typeof execFile>;
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
    return remover as unknown as ReturnType<typeof execFile>;
  });
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(rmdir).mockImplementationOnce(async (path, options) => {
    events.push('remove directory');
    await actual.rmdir(path, options);
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
      assertCliEnvironment(options);
      directory = join(options.cwd, '..');
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
                  value: scenario === 'ASCII result over limit' ? 'a'.repeat(1048577) : 7,
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
      'ASCII result over limit': 'SANDBOX_MESSAGE_LIMIT',
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
  if (scenario === 'spawn error') {
    expect(execFile).not.toHaveBeenCalled();
    expect(events).not.toContain('close');
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.stdout.closed).toBe(true);
  } else {
    expect(events.indexOf('remove directory'), events.join(' -> ')).toBeGreaterThan(
      events.indexOf('close'),
    );
    expect(events).toContain('close');
  }
  expect(existsSync(directory)).toBe(false);
  expect(child.listenerCount('error')).toBe(0);
  expect(child.listenerCount('close')).toBe(0);
  expect(child.stdout.listenerCount('data')).toBe(0);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});

it('cleans known partial writes before launch without requiring a container command', async () => {
  const local = vi.fn();
  const launch = vi.fn();
  await expect(
    runContainerOrSubprocessSandbox({
      isolationLevel: 'oci_container',
      runtime: 'docker',
      timeoutMs: 2000,
      code: 'return 7;',
      input: {
        toJSON() {
          throw new Error('SERIALIZE_FAILED');
        },
      } as never,
      onTool: async () => null,
      onCleanupWarning: local,
      containerSpawn: launch,
    }),
  ).rejects.toThrow('SERIALIZE_FAILED');
  expect(launch).not.toHaveBeenCalled();
  expect(execFile).not.toHaveBeenCalled();
  expect(local).not.toHaveBeenCalled();
  expect(rmdir).toHaveBeenCalledTimes(3);
});

it.each(['success', 'exit 125'])(
  'clears fixed inputs and closed CLI state with daemon down: %s',
  async (outcome) => {
    const child = processFixture();
    const local = vi.fn();
    let closed = false;
    let directory = '';
    const completion = once(child, 'close');
    child.kill.mockImplementation(() => {
      child.exitCode = 0;
      child.emit('exit', 0);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      setImmediate(() => {
        closed = true;
        child.emit('close', 0);
      });
      return true;
    });
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (error: Error) => void)(new Error('DAEMON_UNAVAILABLE'));
      return Object.assign(new EventEmitter(), {
        exitCode: 0,
        unref: vi.fn(),
      }) as unknown as ReturnType<typeof execFile>;
    });
    const result = runContainerOrSubprocessSandbox({
      isolationLevel: 'oci_container',
      runtime: 'docker',
      timeoutMs: 2000,
      code: 'return 7;',
      onTool: async () => null,
      onCleanupWarning: local,
      containerSpawn: (_runtime, _args, options) => {
        directory = join(options.cwd, '..');
        setImmediate(() => {
          if (outcome === 'success') child.stdout.write('{"type":"done","value":7}\n');
          else {
            child.exitCode = 125;
            closed = true;
            child.emit('close', 125);
          }
        });
        return child as unknown as ChildProcessWithoutNullStreams;
      },
    });
    try {
      if (outcome === 'success') expect((await result).output).toBe(7);
      else await expect(result).rejects.toThrow('CONTAINER_EXIT: 125');
      expect(closed).toBe(true);
      expect(local).toHaveBeenCalledWith({ code: 'OCI_WORKSPACE_REMAINS', directory });
      for (const path of ['input/task.json', 'input/runner.cjs', 'cli'])
        expect(existsSync(join(directory, path))).toBe(false);
      expect(existsSync(join(directory, 'output'))).toBe(true);
    } finally {
      if (directory) {
        await completion;
        await removeTestFixture(directory, 'acp-oci-');
      }
    }
    expect(existsSync(directory)).toBe(false);
  },
);

it.each(['absent', 'present', 'query error', 'malformed query'])(
  'requires reliable absence evidence after removal callback error: %s',
  async (scenario) => {
    const child = processFixture();
    const local = vi.fn();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let directory = '',
      containerName = '';
    child.kill.mockImplementation(() => {
      child.exitCode = 0;
      child.emit('close', 0);
      return true;
    });
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      assertCliEnvironment(args[2] as { cwd: string; env: NodeJS.ProcessEnv });
      const argv = args[1] as string[];
      const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
      if (argv[0] === 'rm') callback(new Error('REMOVAL_FAILED'), '');
      else {
        expect(argv).toEqual(['container', 'ls', '--all', '--format', '{{json .Names}}']);
        callback(
          scenario === 'query error' ? new Error('DAEMON_UNAVAILABLE') : null,
          scenario === 'present'
            ? JSON.stringify(containerName)
            : scenario === 'malformed query'
              ? 'invalid'
              : '',
        );
      }
      const settings = args[2] as { cwd: string; env: Record<string, string> };
      expect(settings.cwd).toBe(join(directory, 'cli'));
      expect(settings.env.DOCKER_CONFIG).toBe(join(directory, 'cli'));
      expect(settings.env.HOME).toBe(join(directory, 'cli'));
      expect(settings.env.TMPDIR).toBe(join(directory, 'cli'));
      return Object.assign(new EventEmitter(), {
        exitCode: 0,
        unref: vi.fn(),
      }) as unknown as ReturnType<typeof execFile>;
    });
    const result = await runContainerOrSubprocessSandbox({
      isolationLevel: 'oci_container',
      runtime: 'docker',
      timeoutMs: 2000,
      code: 'return 7;',
      onTool: async () => null,
      onCleanupWarning: local,
      containerSpawn: (_runtime, args, options) => {
        directory = join(options.cwd, '..');
        expect(options.env.DOCKER_CONFIG).toBe(options.cwd);
        expect(args).not.toContain('type=bind,src=' + options.cwd + ',dst=/work');
        containerName = args[args.indexOf('--name') + 1];
        expect(args).toContain('--rm');
        setImmediate(() => child.stdout.write('{"type":"done","value":7}\n'));
        return child as unknown as ChildProcessWithoutNullStreams;
      },
    });
    expect(result.output).toBe(7);
    if (scenario === 'present') {
      expect(vi.mocked(execFile).mock.calls.length).toBeGreaterThan(2);
      expect(vi.mocked(execFile).mock.calls.length).toBeLessThanOrEqual(11);
    } else expect(execFile).toHaveBeenCalledTimes(2);
    expect(existsSync(directory)).toBe(scenario !== 'absent');
    if (scenario === 'absent') expect(local).not.toHaveBeenCalled();
    else {
      expect(local).toHaveBeenCalledWith({ code: 'OCI_WORKSPACE_REMAINS', directory });
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      await removeTestFixture(directory, 'acp-oci-', actual.rm);
    }
  },
);

it.each(['disappears', 'present', 'expired'])(
  'bounds serial name rechecks after a valid present response: %s',
  async (scenario) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const child = processFixture();
    let directory = '',
      name = '',
      queries = 0,
      started!: () => void;
    const firstQuery = new Promise<void>((resolve) => {
      started = resolve;
    });
    child.kill.mockImplementation(() => {
      child.exitCode = 0;
      child.emit('close', 0);
      return true;
    });
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      assertCliEnvironment(args[2] as { cwd: string; env: NodeJS.ProcessEnv });
      const argv = args[1] as string[];
      const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
      if (argv[0] === 'rm') callback(new Error('ALREADY_REMOVING'), '');
      else {
        queries++;
        expect((args[2] as { timeout: number }).timeout).toBeLessThanOrEqual(2000);
        callback(null, scenario === 'disappears' && queries === 2 ? '' : JSON.stringify(name));
        started();
      }
      return Object.assign(new EventEmitter(), {
        exitCode: 0,
        unref: vi.fn(),
      }) as unknown as ReturnType<typeof execFile>;
    });
    const warning = vi.fn();
    const result = runContainerOrSubprocessSandbox({
      runtime: 'docker',
      isolationLevel: 'oci_container',
      timeoutMs: 1000,
      code: 'return 7;',
      onTool: async () => null,
      onCleanupWarning: warning,
      containerSpawn: (_binary, args, options) => {
        directory = join(options.cwd, '..');
        name = args[args.indexOf('--name') + 1];
        setImmediate(() => child.stdout.write('{"type":"done","value":7}\n'));
        return child as unknown as ChildProcessWithoutNullStreams;
      },
    });
    try {
      await firstQuery;
      await vi.advanceTimersByTimeAsync(249);
      expect(queries).toBe(1);
      if (scenario === 'expired') vi.setSystemTime(Date.now() + 2000);
      await vi.advanceTimersByTimeAsync(scenario === 'present' ? 1501 : 1);
      expect((await result).output).toBe(7);
      expect(queries).toBe(scenario === 'disappears' ? 2 : scenario === 'present' ? 8 : 1);
      expect(existsSync(directory)).toBe(scenario !== 'disappears');
      if (scenario === 'disappears') expect(warning).not.toHaveBeenCalled();
      else expect(warning).toHaveBeenCalledWith({ code: 'OCI_WORKSPACE_REMAINS', directory });
      const before = queries;
      await vi.advanceTimersByTimeAsync(10000);
      expect(queries).toBe(before);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      if (directory) await removeTestFixture(directory, 'acp-oci-', native.rm);
    }
  },
);

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

it.each(['kill false', 'kill throws', 'inherited pipes', 'remover hangs', 'removal close pending'])(
  'retains uncertain workspace and disposes resources within existing cleanup budget: %s',
  async (scenario) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const child = processFixture();
    const remover = processFixture();
    if (scenario === 'kill throws')
      child.kill.mockImplementation(() => {
        throw new Error('KILL_FAILED');
      });
    if (scenario === 'inherited pipes') child.exitCode = 0;
    let directory = '';
    let removalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      removalStarted = resolve;
    });
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      if (scenario === 'removal close pending') {
        child.exitCode = 0;
        child.emit('close', 0);
        (args.at(-1) as (error: Error) => void)(new Error('REMOVAL_FAILED'));
        removalStarted();
      } else if (scenario !== 'remover hangs') {
        remover.exitCode = 0;
        remover.stdin.destroy();
        remover.stdout.destroy();
        remover.stderr.destroy();
        setImmediate(() => {
          remover.emit('close', 0);
          (args.at(-1) as () => void)();
          removalStarted();
        });
      } else {
        child.exitCode = 0;
        child.emit('close', 0);
        removalStarted();
      }
      return remover as unknown as ReturnType<typeof execFile>;
    });
    let settled = false;
    const result = runContainerOrSubprocessSandbox({
      isolationLevel: 'oci_container',
      runtime: 'docker',
      timeoutMs: 2000,
      code: 'return 7;',
      onTool: async () => null,
      containerSpawn: (_runtime, _args, options) => {
        directory = join(options.cwd, '..');
        setImmediate(() => child.stdout.write('{"type":"done","value":7}\n'));
        return child as unknown as ChildProcessWithoutNullStreams;
      },
    }).then((value) => {
      settled = true;
      return value;
    });
    await started;
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    expect(rmdir).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).output).toBe(7);
    expect(existsSync(directory)).toBe(true);
    expect(vi.mocked(rmdir).mock.calls.map(([path]) => path)).toEqual([join(directory, 'input')]);
    for (const path of ['input/task.json', 'input/runner.cjs'])
      expect(existsSync(join(directory, path))).toBe(false);
    for (const path of ['cli/config.json', 'output'])
      expect(existsSync(join(directory, path))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(execFile).toHaveBeenCalledTimes(1);
    for (const process of [child, remover]) {
      expect(process.listenerCount('close')).toBe(0);
      expect(process.listenerCount('error')).toBe(0);
      expect(process.stdout.listenerCount('data')).toBe(0);
      expect(process.stdout.destroyed).toBe(true);
      expect(process.unref).toHaveBeenCalled();
    }
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    await removeTestFixture(directory, 'acp-oci-', actual.rm);
  },
);

it.each(['spawn throws', 'setup throws', 'removal throws', 'rm rejects', 'already closed'])(
  'preserves outcome and releases owned resources on %s',
  async (scenario) => {
    const local = vi.fn();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const child = processFixture();
    let directory = '';
    if (scenario === 'setup throws')
      vi.spyOn(child.stderr, 'resume').mockImplementation(() => {
        throw new Error('SETUP_FAILED');
      });
    if (scenario === 'already closed') {
      child.exitCode = 1;
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      await Promise.all([
        once(child.stdin, 'close'),
        once(child.stdout, 'close'),
        once(child.stderr, 'close'),
      ]);
    }
    child.kill.mockImplementation(() => {
      child.exitCode = 0;
      child.emit('close', 0);
      return true;
    });
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      if (scenario === 'removal throws') throw new Error('REMOVAL_FAILED');
      (args.at(-1) as () => void)();
      return Object.assign(new EventEmitter(), {
        exitCode: 0,
        unref: vi.fn(),
      }) as unknown as ReturnType<typeof execFile>;
    });
    if (scenario === 'rm rejects') vi.mocked(rmdir).mockRejectedValueOnce(new Error('EBUSY'));
    const result = await runContainerOrSubprocessSandbox({
      isolationLevel: 'oci_container',
      runtime: 'docker',
      timeoutMs: 2000,
      onCleanupWarning: local,
      code: 'return 7;',
      onTool: async () => null,
      containerSpawn: (_runtime, _args, options) => {
        directory = join(options.cwd, '..');
        if (scenario === 'spawn throws') throw new Error('SPAWN_FAILED');
        if (!['setup throws', 'already closed'].includes(scenario))
          setImmediate(() => child.stdout.write('{"type":"done","value":7}\n'));
        return child as unknown as ChildProcessWithoutNullStreams;
      },
    }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    if (scenario === 'spawn throws') expect(result).toHaveProperty('error.message', 'SPAWN_FAILED');
    else if (scenario === 'setup throws')
      expect(result).toHaveProperty('error.message', 'SETUP_FAILED');
    else if (scenario === 'already closed')
      expect(result).toHaveProperty('error.message', 'CONTAINER_EXIT: 1');
    else expect(result).toHaveProperty('value.output', 7);
    expect(child.listenerCount('close')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
    const retained = ['removal throws', 'rm rejects'].includes(scenario);
    expect(existsSync(directory)).toBe(retained);
    if (retained) {
      expect(local).toHaveBeenCalledWith({ code: 'OCI_WORKSPACE_REMAINS', directory });
      expect(String(stderr.mock.calls[0][0])).toContain(JSON.stringify(directory));
      expect(JSON.stringify(result)).not.toContain(directory);
    } else {
      expect(local).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    }
    if (retained) {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      await removeTestFixture(directory, 'acp-oci-', actual.rm);
    }
  },
);

it('bounds caller wait and warns on unfinished filesystem I/O without pretending to cancel it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const child = processFixture();
  const local = vi.fn();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  let directory = '';
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const issued = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.mocked(rmdir).mockImplementationOnce(async () => {
    started();
    await pending;
  });
  child.kill.mockImplementation(() => {
    child.exitCode = 0;
    child.emit('close', 0);
    return true;
  });
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    (args.at(-1) as () => void)();
    return Object.assign(new EventEmitter(), {
      exitCode: 0,
      unref: vi.fn(),
    }) as unknown as ReturnType<typeof execFile>;
  });
  const result = runContainerOrSubprocessSandbox({
    isolationLevel: 'oci_container',
    runtime: 'docker',
    timeoutMs: 2000,
    code: 'return 7;',
    onTool: async () => null,
    onCleanupWarning: local,
    containerSpawn: (_runtime, _args, options) => {
      directory = join(options.cwd, '..');
      setImmediate(() => child.stdout.write('{"type":"done","value":7}\n'));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });
  await issued;
  await vi.advanceTimersByTimeAsync(3000);
  expect((await result).output).toBe(7);
  expect(local).toHaveBeenCalledWith({ code: 'OCI_WORKSPACE_REMAINS', directory });
  expect(existsSync(directory)).toBe(true);
  expect(rmdir).toHaveBeenCalledTimes(1);
  release();
  await pending;
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  await removeTestFixture(directory, 'acp-oci-', actual.rm);
});
