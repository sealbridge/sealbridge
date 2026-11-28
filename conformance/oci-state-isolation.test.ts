import { removeTestFixture } from './test-fixture-cleanup.mjs';
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { containerArguments } from '../packages/sandbox/src/container.js';
import { createOciWorkspace, warnRootOciLauncher } from '../packages/sandbox/src/oci-workspace.js';
import { anchorDirectory, verifyWorkspaceParent } from '../packages/sandbox/src/oci-protection.js';

const paths: string[] = [];
const workspacePaths = new Set<string>();
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of paths.splice(0)) {
    if (workspacePaths.has(path)) await removeTestFixture(path, 'acp-oci-');
    else await rm(path, { recursive: true, force: true });
  }
  workspacePaths.clear();
});

async function prepared() {
  const workspace = await createOciWorkspace();
  paths.push(workspace.directory);
  workspacePaths.add(workspace.directory);
  await workspace.write('config.json', '{}');
  await workspace.write('runner.cjs', 'synthetic runner');
  await workspace.write('task.json', '{"input":"synthetic"}');
  return workspace;
}

it('mounts only read-only input and writable output, never parent or CLI state', async () => {
  const w = await prepared();
  try {
    const args = containerArguments(w.directory);
    const mounts = args.flatMap((arg, i) => (arg === '--mount' ? [args[i + 1]] : []));
    expect(mounts).toEqual([
      'type=bind,src=' + w.inputDirectory + ',dst=/input,readonly',
      'type=bind,src=' + w.outputDirectory + ',dst=/work',
    ]);
    expect(args.slice(-2)).toEqual(['/input/runner.cjs', '/input/task.json']);
    expect(args[args.indexOf('--workdir') + 1]).toBe('/work');
    expect(mounts.join(' ')).not.toContain(w.cliDirectory);
    await w.seal();
    await expect(w.write('task.json', 'late')).rejects.toThrow('OCI_WORKSPACE_SEALED');
    expect(await readFile(join(w.inputDirectory, 'task.json'), 'utf8')).toContain('synthetic');
  } finally {
    await w.cleanup(true, Date.now() + 3000);
  }
});

it('requires complete trusted inputs before sealing and makes no early ownership handoff', async () => {
  const w = await createOciWorkspace();
  paths.push(w.directory);
  workspacePaths.add(w.directory);
  try {
    await expect(w.seal()).rejects.toThrow('OCI_WORKSPACE_INCOMPLETE');
    if (process.getuid) expect((await lstat(w.outputDirectory)).uid).toBe(process.getuid());
    await w.write('config.json', '{}');
    await w.write('runner.cjs', 'synthetic');
    await w.write('task.json', '{}');
    await w.seal();
    const owner = process.getuid?.();
    if (owner !== undefined) {
      expect((await lstat(w.outputDirectory)).uid).toBe(owner === 0 ? 65534 : owner);
      for (const path of [
        w.directory,
        w.cliDirectory,
        w.inputDirectory,
        join(w.cliDirectory, 'config.json'),
        join(w.inputDirectory, 'runner.cjs'),
        join(w.inputDirectory, 'task.json'),
      ])
        expect((await lstat(path)).uid).toBe(owner);
    }
  } finally {
    await w.cleanup(true, Date.now() + 3000);
  }
});

it.skipIf(process.platform === 'win32')(
  'preserves guest-readable inputs under restrictive umask',
  async () => {
    const before = process.umask(0o077);
    const w = await prepared().finally(() => process.umask(before));
    try {
      await w.seal();
      for (const [path, mode] of [
        [w.directory, 0o700],
        [w.cliDirectory, 0o700],
        [w.inputDirectory, 0o755],
        [w.outputDirectory, 0o700],
        [join(w.cliDirectory, 'config.json'), 0o600],
        [join(w.inputDirectory, 'task.json'), 0o644],
        [join(w.inputDirectory, 'runner.cjs'), 0o644],
      ] as const)
        expect((await lstat(path)).mode & 0o777).toBe(mode);
      if (process.getuid?.() === 0) {
        // Benign post-fix host-path privacy check, not a replacement/access trial
        // against a vulnerable release. No sensitive data is involved.
        const read = spawnSync(
          process.execPath,
          ['-e', 'require("node:fs").readdirSync(process.argv[1])', w.outputDirectory],
          { uid: 65534, gid: 65534, encoding: 'utf8' },
        );
        expect(read.status).not.toBe(0);
        expect(read.stderr).toContain('EACCES');
      }
    } finally {
      await w.cleanup(true, Date.now() + 3000);
    }
  },
);

it('removes released output without following its directory links or writing through them', async () => {
  const w = await prepared();
  const outside = await mkdtemp(join(tmpdir(), 'oci-synthetic-output-'));
  paths.push(outside);
  await writeFile(join(outside, 'sentinel'), 'synthetic unchanged');
  await w.seal();
  // Test fixture setup as launcher, not a guest escape or substitution attempt.
  await symlink(
    outside,
    join(w.outputDirectory, 'artifact'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  expect(await w.cleanup(true, Date.now() + 3000)).toBe(true);
  expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('synthetic unchanged');
  await expect(lstat(w.outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await lstat(join(w.inputDirectory, 'task.json')).catch(() => null)).toBeNull();
});

it.runIf(process.platform === 'linux')(
  'anchors Linux directory operations to the verified inode',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oci-anchor-'));
    paths.push(directory);
    const anchor = await anchorDirectory(directory);
    try {
      expect(anchor.path).toMatch(/^\/proc\/self\/fd\/\d+$/);
      const stat = await lstat(directory, { bigint: true });
      const actual = await anchor.handle!.stat({ bigint: true });
      expect([actual.dev, actual.ino]).toEqual([stat.dev, stat.ino]);
      const f = await open(join(anchor.path, 'synthetic'), 'wx', 0o600);
      await f.close();
      expect((await lstat(join(directory, 'synthetic'))).isFile()).toBe(true);
    } finally {
      await anchor.close();
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'rejects an unsafe synthetic containing directory with a generic peer error',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oci-unprotected-'));
    paths.push(directory);
    await chmod(directory, 0o777);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const error = await verifyWorkspaceParent(directory, false).catch((e: unknown) => e);
    expect(error).toEqual(new Error('OCI_WORKSPACE_UNPROTECTED'));
    expect(String(error)).not.toContain(directory);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(directory));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('protected temporary directory'));
  },
);

it('emits the root recommendation only once and only on local stderr', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'getuid');
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    Object.defineProperty(process, 'getuid', { configurable: true, value: () => 1000 });
    warnRootOciLauncher();
    expect(stderr).not.toHaveBeenCalled();
    Object.defineProperty(process, 'getuid', { configurable: true, value: () => 0 });
    warnRootOciLauncher();
    warnRootOciLauncher();
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('dedicated non-root identity'));
  } finally {
    if (original) Object.defineProperty(process, 'getuid', original);
    else Reflect.deleteProperty(process, 'getuid');
  }
});
