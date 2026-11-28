import { removeTestFixture } from './test-fixture-cleanup.mjs';
// SPDX-License-Identifier: Apache-2.0
import { ociTestExecutable } from './oci-test-transport.js';
import { execFileSync, spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  containerArguments,
  runContainerOrSubprocessSandbox,
} from '../packages/sandbox/src/container.js';
import { createOciWorkspace } from '../packages/sandbox/src/oci-workspace.js';

// Only the executable is resolved; native args/options/callback and ChildProcess stay intact.
vi.mock('node:child_process', async (original) => {
  const native = await original<typeof import('node:child_process')>();
  return {
    ...native,
    execFile: (binary: string, ...args: unknown[]) =>
      Reflect.apply(native.execFile, native, [ociTestExecutable(binary), ...args]),
  };
});

const observed = vi.hoisted(() => ({
  rm: new Map<string, string | undefined>(),
  cleanup: new Map<string, boolean>(),
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rm: async (...args: Parameters<typeof fs.rm>) => {
      try {
        await fs.rm(...args);
        observed.rm.set(String(args[0]), undefined);
      } catch (error) {
        observed.rm.set(String(args[0]), (error as NodeJS.ErrnoException).code ?? 'UNKNOWN');
        throw error;
      }
    },
  };
});
vi.mock('../packages/sandbox/src/oci-workspace.js', async (original) => {
  const module = await original<typeof import('../packages/sandbox/src/oci-workspace.js')>();
  return {
    ...module,
    createOciWorkspace: async () => {
      const w = await module.createOciWorkspace();
      return {
        ...w,
        cleanup: async (...args: Parameters<typeof w.cleanup>) => {
          const result = await w.cleanup(...args);
          observed.cleanup.set(w.directory, result);
          return result;
        },
      };
    },
  };
});
const removeFixture = (directory: string, prefix = 'acp-oci-') =>
  removeTestFixture(directory, prefix);

it.runIf(process.env.SEALBRIDGE_OCI_INTEGRATION === '1')(
  'runs benign input/output with a real OCI runtime and separates mount permissions',
  async () => {
    const runtime = process.env.SEALBRIDGE_OCI_RUNTIME === 'docker' ? 'docker' : 'podman';
    const image = 'docker.io/library/node:22-bookworm-slim';
    let firstWorkspace = '';
    const result = await runContainerOrSubprocessSandbox({
      isolationLevel: 'oci_container',
      runtime,
      image,
      timeoutMs: 10000,
      code: 'return {echo: input};',
      input: 'synthetic',
      onTool: async () => null,
      containerSpawn: (binary, args, options) => {
        firstWorkspace = dirname(options.cwd);
        return spawn(ociTestExecutable(binary), args, {
          ...options,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      },
    });
    expect(result.output).toEqual({ echo: 'synthetic' });
    expect(result.effectiveIsolationLevel).toBe('oci_container');
    expect(firstWorkspace).not.toBe('');
    for (const path of ['input/runner.cjs', 'input/task.json', 'cli', '.'])
      await expect(
        lstat(join(firstWorkspace, path)),
        join(firstWorkspace, path),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    const w = await createOciWorkspace();
    try {
      await w.write('config.json', '{}');
      await w.write('runner.cjs', 'synthetic');
      await w.write('task.json', '{"input":"synthetic"}');
      await w.seal();
      const args = containerArguments(w.directory, image);
      const start = args.indexOf(image) + 1;
      const script = [
        'const fs=require("node:fs");',
        'const input=JSON.parse(fs.readFileSync("/input/task.json","utf8"));',
        'let readonly=false;try{fs.writeFileSync("/input/new","synthetic")}catch(e){readonly=e.code==="EROFS"}',
        'fs.writeFileSync("/work/result","synthetic");',
        'console.log(JSON.stringify({input,readonly,output:fs.readFileSync("/work/result","utf8")}));',
      ].join('');
      args.splice(start, args.length - start, 'node', '-e', script);
      const output = execFileSync(ociTestExecutable(runtime), args, {
        encoding: 'utf8',
        timeout: 15000,
        env: {
          PATH: process.platform === 'win32' ? process.env.PATH : '/usr/local/bin:/usr/bin:/bin',
          ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
          HOME: w.cliDirectory,
          TMPDIR: w.cliDirectory,
          DOCKER_CONFIG: w.cliDirectory,
        },
        cwd: w.cliDirectory,
      });
      expect(JSON.parse(output)).toEqual({
        input: { input: 'synthetic' },
        readonly: true,
        output: 'synthetic',
      });
      if (process.platform !== 'win32') expect((await lstat(w.directory)).mode & 0o777).toBe(0o700);
      expect(await w.cleanup(true, Date.now() + 3000)).toBe(true);
      await expect(lstat(w.outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      // This test created the complete benign fixture and the synchronous
      // container command has returned; only this registered fixture is removed.
      await removeFixture(w.directory);
    }
  },
  30000,
);

it.runIf(
  process.platform === 'win32' &&
    process.env.SEALBRIDGE_OCI_INTEGRATION === '1' &&
    process.env.SEALBRIDGE_OCI_RUNTIME === 'docker',
)(
  'real Docker WSL link preserves the target and verifies the observed cleanup outcome',
  async () => {
    let directory = '',
      outside = '',
      tag = '',
      primary: unknown,
      teardown: string | undefined;
    const warning = vi.fn();
    try {
      const result = await runContainerOrSubprocessSandbox({
        runtime: 'docker',
        isolationLevel: 'oci_container',
        timeoutMs: 10000,
        code: 'return input;',
        input: 'synthetic',
        onTool: async () => null,
        onCleanupWarning: warning,
        containerSpawn: (binary, args, options) => {
          directory = dirname(options.cwd);
          outside = mkdtempSync(join(dirname(directory), 'oci-synthetic-target-'));
          writeFileSync(join(outside, 'sentinel'), 'synthetic unchanged');
          const script = `require('node:fs').symlinkSync(${JSON.stringify('../../' + basename(outside))},'/work/link','dir');console.log(JSON.stringify({type:'done',value:'synthetic'}));`;
          args.splice(args.indexOf('node'), args.length, 'node', '-e', script);
          const child = spawn(ociTestExecutable(binary), args, {
            ...options,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          child.stdout.once('data', () => {
            tag = execFileSync(
              'fsutil.exe',
              ['reparsepoint', 'query', join(directory, 'output', 'link')],
              { encoding: 'utf8' },
            ).toLowerCase();
          });
          return child;
        },
      });
      expect(result.output).toBe('synthetic');
      expect(tag).toContain('0xa000001d');
      expect(observed.rm.has(join(directory, 'output'))).toBe(true);
      const failed = observed.rm.get(join(directory, 'output')) !== undefined;
      expect(observed.cleanup.get(directory)).toBe(!failed);
      expect(existsSync(join(directory, 'output'))).toBe(failed);
      expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('synthetic unchanged');
      if (failed)
        expect(warning).toHaveBeenCalledWith({ code: 'OCI_WORKSPACE_REMAINS', directory });
      else expect(warning).not.toHaveBeenCalled();
    } catch (error) {
      primary = error;
    } finally {
      try {
        if (directory) await removeFixture(directory);
      } catch (error) {
        teardown = (error as NodeJS.ErrnoException).code;
      }
      if (outside && !existsSync(directory)) await removeFixture(outside, 'oci-synthetic-target-');
      process.stdout.write(
        JSON.stringify({
          event: 'wsl_link_cleanup',
          node: process.versions.node,
          branch: observed.rm.has(join(directory, 'output'))
            ? observed.rm.get(join(directory, 'output')) === undefined
              ? 'success'
              : 'failure'
            : 'unobserved',
          tag: tag.includes('0xa000001d') ? '0xa000001d' : 'unknown',
          productErrno: observed.rm.get(join(directory, 'output')),
          cleanup: observed.cleanup.get(directory),
          teardown,
        }) + '\n',
      );
    }
    if (primary) throw primary;
    expect(teardown).toBe(observed.rm.get(join(directory, 'output')));
  },
  30000,
);
