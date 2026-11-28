import { canRemoveTestFixture, removeTestFixture } from './test-fixture-cleanup.mjs';
// SPDX-License-Identifier: Apache-2.0
import { chmod, chown, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createOciWorkspace } from '../packages/sandbox/src/oci-workspace.js';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, rm: vi.fn(fs.rm) };
});
const fixtures: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  for (const path of fixtures.splice(0)) await removeTestFixture(path, 'acp-oci-', fs.rm);
});
async function fixture() {
  const w = await createOciWorkspace();
  fixtures.push(w.directory);
  await w.write('runner.cjs', 'synthetic');
  await w.write('task.json', '{}');
  await w.write('config.json', '{}');
  await mkdir(join(w.outputDirectory, 'nested'));
  await writeFile(join(w.outputDirectory, 'nested', 'result'), 'synthetic');
  return w;
}
it('requires reliable container absence independently of a private unchanged parent', async () => {
  const w = await fixture();
  expect(await w.cleanup(false, Date.now() + 3000, true)).toBe(false);
  expect(rm).not.toHaveBeenCalled();
  expect(existsSync(join(w.outputDirectory, 'nested', 'result'))).toBe(true);
});
it.runIf(process.platform !== 'win32')(
  'rechecks POSIX private mode independently of absence and identity',
  async () => {
    const w = await fixture();
    await chmod(w.directory, 0o755);
    expect(await w.cleanup(true, Date.now() + 3000)).toBe(false);
    expect(rm).not.toHaveBeenCalled();
    expect(existsSync(w.outputDirectory)).toBe(true);
  },
);
it.runIf(process.getuid?.() === 0)(
  'rechecks current launcher ownership before recursive output deletion',
  async () => {
    const w = await fixture();
    await chown(w.directory, 65534, 65534);
    try {
      expect(await w.cleanup(true, Date.now() + 3000)).toBe(false);
      expect(rm).not.toHaveBeenCalled();
      expect(existsSync(w.outputDirectory)).toBe(true);
    } finally {
      await chown(w.directory, 0, 0);
    }
  },
);
it.each(['EBUSY', 'EPERM'])(
  'retains and reports failure after one recursive attempt: %s',
  async (code) => {
    const w = await fixture();
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error(code), { code }));
    expect(await w.cleanup(true, Date.now() + 3000)).toBe(false);
    expect(rm).toHaveBeenCalledExactlyOnceWith(w.outputDirectory, {
      recursive: true,
      maxRetries: 0,
    });
    expect(existsSync(w.outputDirectory)).toBe(true);
  },
);
it('allows issued asynchronous removal to finish after caller deadline without further deletion', async () => {
  const w = await fixture();
  const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  let finish!: () => void, started!: () => void;
  const begin = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.mocked(rm).mockImplementationOnce(async () => {
    started();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    if (
      w.outputDirectory === join(w.directory, 'output') &&
      canRemoveTestFixture(w.directory, 'acp-oci-')
    )
      await removeTestFixture(w.outputDirectory, 'output', (path) =>
        native.rm(path, { recursive: true }),
      );
  });
  const deadline = Date.now() + 3000;
  let completed = false;
  const cleanup = w.cleanup(true, deadline).then((value) => {
    completed = true;
    return value;
  });
  await begin;
  const bounded = Promise.race([
    cleanup,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
  ]);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await bounded).toBe(false);
  expect(completed).toBe(false);
  expect(existsSync(w.outputDirectory)).toBe(true);
  finish();
  expect(await cleanup).toBe(false);
  expect(existsSync(w.outputDirectory)).toBe(false);
  expect(existsSync(w.directory)).toBe(true);
  expect(rm).toHaveBeenCalledTimes(1);
});
