// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createSandboxWrapper } from '../packages/sandbox/src/index.js';

it.each([false, true])(
  'requires explicit OCI input with trusted ancestor alias=%s',
  async (alias) => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'oci-input-fixture-')));
    await mkdir(join(fixture, 'real'));
    if (alias) await symlink(join(fixture, 'real'), join(fixture, 'alias'), 'junction');
    // Node canonicalizes the runner filename. Canonicalize our trusted fixture
    // root before deriving both paths; never canonicalize arbitrary runner argv.
    const root = await realpath(join(fixture, alias ? 'alias' : 'real'));
    const input = join(root, 'input'),
      output = join(root, 'output');
    await mkdir(input);
    await mkdir(output);
    const runner = join(input, 'runner.cjs'),
      task = join(input, 'task.json');
    await writeFile(runner, createSandboxWrapper('jsonl'));
    const config = (value: string) =>
      JSON.stringify({ code: 'return input;', input: value, timeoutMs: 1000 });
    await writeFile(task, config('trusted'));
    await writeFile(join(output, 'task.json'), config('cwd-decoy'));
    const run = (args: string[]) =>
      spawnSync(process.execPath, [runner, ...args], {
        cwd: output,
        encoding: 'utf8',
        timeout: 3000,
      });
    try {
      const good = run([task]);
      expect(good.status).toBe(0);
      expect(JSON.parse(good.stdout)).toEqual({ type: 'done', value: 'trusted' });
      for (const args of [[], [join(output, 'task.json')], [join(input, 'missing.json')]]) {
        const bad = run(args);
        expect(bad.status).not.toBe(0);
        expect(bad.stdout).toBe('');
      }
      await unlink(task);
      const missing = run([task]);
      expect(missing.status).not.toBe(0);
      expect(missing.stdout).toBe('');
      await symlink(
        process.platform === 'win32' ? output : join(output, 'task.json'),
        task,
        process.platform === 'win32' ? 'junction' : 'file',
      );
      const replaced = run([task]);
      expect(replaced.status).not.toBe(0);
      expect(replaced.stdout).toBe('');
      expect(replaced.stderr).toContain('OCI_INPUT_FILE_INVALID');
      await unlink(task);
    } finally {
      // The only links here were created by this synthetic fixture.
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
