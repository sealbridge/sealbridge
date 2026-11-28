import { removeTestFixture } from './test-fixture-cleanup.mjs';
// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createOciWorkspace, warnOciWorkspace } from '../packages/sandbox/src/oci-workspace.js';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, unlink: vi.fn(fs.unlink), rmdir: vi.fn(fs.rmdir) };
});
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
  // Only synthetic fixtures registered by these tests, after all writes settled.
  for (const directory of directories.splice(0)) await removeTestFixture(directory, 'acp-oci-');
});
async function fixture() {
  const workspace = await createOciWorkspace();
  directories.push(workspace.directory);
  await workspace.write('task.json', '{"input":"synthetic-private-input","code":"synthetic-code"}');
  await workspace.write('runner.cjs', 'synthetic-wrapper');
  await workspace.write('config.json', '{}');
  return workspace;
}

it('removes only original host-created files and the verified empty directory', async () => {
  const workspace = await fixture();
  expect(await workspace.cleanup(true, Date.now() + 3000)).toBe(true);
  expect(existsSync(workspace.directory)).toBe(false);
  expect(unlink).toHaveBeenCalledTimes(3);
  expect(rmdir).toHaveBeenCalledTimes(3);
});

it('retains unreleased output and warns without artifact names/content', async () => {
  const workspace = await fixture();
  const nested = join(workspace.outputDirectory, 'synthetic-sensitive-name');
  await mkdir(nested);
  await writeFile(join(nested, 'private-log'), 'synthetic-private-output');
  const local = vi.fn();
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect(await workspace.cleanup(false, Date.now() + 3000, true)).toBe(false);
  expect(existsSync(join(workspace.inputDirectory, 'task.json'))).toBe(false);
  expect(await readFile(join(nested, 'private-log'), 'utf8')).toBe('synthetic-private-output');
  warnOciWorkspace(workspace.directory, local);
  expect(local).toHaveBeenCalledWith({
    code: 'OCI_WORKSPACE_REMAINS',
    directory: workspace.directory,
  });
  const diagnostics = JSON.stringify([local.mock.calls, stderr.mock.calls]);
  expect(diagnostics).not.toMatch(/synthetic-private|synthetic-sensitive-name|private-log/);
  expect(String(stderr.mock.calls[0][0])).toContain('manually remove when safe');
});

it('removes only fixed inputs while host CLI and container release are unconfirmed', async () => {
  const workspace = await fixture();
  expect(await workspace.cleanup(false, Date.now() + 3000)).toBe(false);
  expect(existsSync(join(workspace.inputDirectory, 'task.json'))).toBe(false);
  expect(existsSync(join(workspace.inputDirectory, 'runner.cjs'))).toBe(false);
  expect(existsSync(join(workspace.cliDirectory, 'config.json'))).toBe(true);
  expect(existsSync(workspace.outputDirectory)).toBe(true);
  expect(unlink).toHaveBeenCalledTimes(2);
});

it('makes no deletion attempt after budget expiry', async () => {
  const workspace = await fixture();
  expect(await workspace.cleanup(true, Date.now() - 1)).toBe(false);
  expect(unlink).not.toHaveBeenCalled();
  expect(rmdir).not.toHaveBeenCalled();
});

it.each([true, false])(
  'retains a fixed-name replacement with container release=%s',
  async (released) => {
    const workspace = await fixture();
    await rename(
      join(workspace.inputDirectory, 'task.json'),
      join(workspace.inputDirectory, 'original-held'),
    );
    await writeFile(join(workspace.inputDirectory, 'task.json'), 'synthetic-guest-replacement');
    expect(await workspace.cleanup(released, Date.now() + 3000, true)).toBe(false);
    expect(await readFile(join(workspace.inputDirectory, 'task.json'), 'utf8')).toBe(
      'synthetic-guest-replacement',
    );
    expect(unlink).toHaveBeenCalledTimes(2);
  },
);

it('does not follow a junction replacing the workspace or delete its outside target', async () => {
  const workspace = await fixture();
  const outside = await fixture();
  const moved = workspace.directory + '-moved';
  await rename(workspace.directory, moved);
  directories.push(moved);
  await symlink(
    outside.directory,
    workspace.directory,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  expect(await workspace.cleanup(true, Date.now() + 3000)).toBe(false);
  expect(await readFile(join(outside.inputDirectory, 'task.json'), 'utf8')).toContain(
    'synthetic-private-input',
  );
  expect(unlink).not.toHaveBeenCalled();
  // Remove only the test-created link, never recurse through it in fixture teardown.
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  await fs.unlink(workspace.directory);
});

it.each([true, false])(
  'attempts each entry once on unlink failure with container release=%s',
  async (released) => {
    const workspace = await fixture();
    vi.mocked(unlink).mockRejectedValueOnce(new Error('synthetic EBUSY'));
    expect(await workspace.cleanup(released, Date.now() + 3000, true)).toBe(false);
    expect(unlink).toHaveBeenCalledTimes(3);
    expect(existsSync(join(workspace.inputDirectory, 'task.json'))).toBe(true);
    expect(existsSync(join(workspace.inputDirectory, 'runner.cjs'))).toBe(false);
  },
);

it('retains unknown CLI storage after removing fixed config and inputs with closed clients', async () => {
  const workspace = await fixture();
  await mkdir(join(workspace.cliDirectory, 'synthetic-runtime-storage'));
  expect(await workspace.cleanup(false, Date.now() + 3000, true)).toBe(false);
  for (const path of ['input/task.json', 'input/runner.cjs', 'cli/config.json'])
    expect(existsSync(join(workspace.directory, path))).toBe(false);
  expect(existsSync(join(workspace.cliDirectory, 'synthetic-runtime-storage'))).toBe(true);
  expect(existsSync(workspace.outputDirectory)).toBe(true);
});

it('stops scheduling deletion after unfinished I/O consumes the deadline; I/O itself is not cancelled', async () => {
  const workspace = await fixture();
  vi.useFakeTimers({ toFake: ['Date'] });
  const deadline = Date.now() + 3000;
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(unlink).mockImplementationOnce(async (path) => {
    vi.setSystemTime(deadline + 1);
    await actual.unlink(path);
  });
  expect(await workspace.cleanup(true, deadline)).toBe(false);
  expect(unlink).toHaveBeenCalledTimes(1);
  expect(rmdir).not.toHaveBeenCalled();
});
