// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
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
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
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
  expect(rmdir).toHaveBeenCalledTimes(1);
});

it('deletes individual payloads but retains arbitrary nested guest artifacts and warns without their names/content', async () => {
  const workspace = await fixture();
  const nested = join(workspace.directory, 'synthetic-sensitive-name');
  await mkdir(nested);
  await writeFile(join(nested, 'private-log'), 'synthetic-private-output');
  const local = vi.fn();
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect(await workspace.cleanup(true, Date.now() + 3000)).toBe(false);
  expect(existsSync(join(workspace.directory, 'task.json'))).toBe(false);
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

it('makes no deletion attempt without confirmed process release or after budget expiry', async () => {
  const workspace = await fixture();
  expect(await workspace.cleanup(false, Date.now() + 3000)).toBe(false);
  expect(await workspace.cleanup(true, Date.now() - 1)).toBe(false);
  expect(unlink).not.toHaveBeenCalled();
  expect(rmdir).not.toHaveBeenCalled();
});

it('does not delete a guest replacement of a fixed-name host file', async () => {
  const workspace = await fixture();
  await rename(join(workspace.directory, 'task.json'), join(workspace.directory, 'original-held'));
  await writeFile(join(workspace.directory, 'task.json'), 'synthetic-guest-replacement');
  expect(await workspace.cleanup(true, Date.now() + 3000)).toBe(false);
  expect(await readFile(join(workspace.directory, 'task.json'), 'utf8')).toBe(
    'synthetic-guest-replacement',
  );
  expect(unlink).toHaveBeenCalledTimes(2);
});

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
  expect(await readFile(join(outside.directory, 'task.json'), 'utf8')).toContain(
    'synthetic-private-input',
  );
  expect(unlink).not.toHaveBeenCalled();
  // Remove only the test-created link, never recurse through it in fixture teardown.
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  await fs.unlink(workspace.directory);
});

it('attempts each owned entry once when unlink fails and reports remaining content', async () => {
  const workspace = await fixture();
  vi.mocked(unlink).mockRejectedValueOnce(new Error('synthetic EBUSY'));
  expect(await workspace.cleanup(true, Date.now() + 3000)).toBe(false);
  expect(unlink).toHaveBeenCalledTimes(3);
  expect(existsSync(join(workspace.directory, 'task.json'))).toBe(true);
  expect(existsSync(join(workspace.directory, 'runner.cjs'))).toBe(false);
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
