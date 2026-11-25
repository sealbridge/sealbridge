// SPDX-License-Identifier: Apache-2.0
import { lstat, mkdtemp, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export interface OciCleanupWarning {
  code: 'OCI_WORKSPACE_REMAINS';
  directory: string;
}

const same = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino && a.ino !== 0n && a.birthtimeNs === b.birthtimeNs;

/** Fixed host-created entries only. This is not a race-proof recursive deleter. */
export async function createOciWorkspace() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'acp-oci-'));
  const parents: [string, BigIntStats][] = [];
  const files = new Map<string, BigIntStats>();
  for (let path = directory; ; path = dirname(path)) {
    let stat: BigIntStats;
    try {
      stat = await lstat(path, { bigint: true });
    } catch {
      break;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.ino === 0n) break;
    parents.push([path, stat]);
    if (dirname(path) === path) break;
  }
  const parentsMatch = async (deadline: number) => {
    if (parents.length === 0 || dirname(parents.at(-1)![0]) !== parents.at(-1)![0]) return false;
    for (const [path, saved] of parents.slice().reverse()) {
      if (Date.now() >= deadline) return false;
      const current = await lstat(path, { bigint: true });
      if (current.isSymbolicLink() || !current.isDirectory() || !same(saved, current)) return false;
    }
    return true;
  };
  return {
    directory,
    async write(name: 'runner.cjs' | 'task.json' | 'config.json', content: string) {
      const file = await open(join(directory, name), 'wx', 0o600);
      try {
        files.set(name, await file.stat({ bigint: true }));
        await file.writeFile(content);
        if (process.getuid?.() === 0) await file.chown(65534, 65534);
      } finally {
        await file.close();
      }
    },
    async cleanup(released: boolean, deadline: number): Promise<boolean> {
      // Path rechecks cannot close TOCTOU races. Never attempt deletion while an
      // owned process/container may still mutate /work; same-user host races are
      // outside this portable guarantee and require handle-relative OS APIs.
      if (!released) return false;
      const withinBudget = () => Date.now() < deadline;
      for (const [name, saved] of files) {
        if (!withinBudget()) return false;
        try {
          if (!(await parentsMatch(deadline)) || !withinBudget()) return false;
          const path = join(directory, name);
          if (Date.now() >= deadline) return false;
          const current = await lstat(path, { bigint: true });
          if (!current.isFile() || current.isSymbolicLink() || !same(saved, current)) continue;
          if (!withinBudget() || !(await parentsMatch(deadline)) || !withinBudget()) return false;
          await unlink(path);
        } catch {
          /* One attempt per owned entry; continue to other known files. */
        }
      }
      try {
        if (!withinBudget() || !(await parentsMatch(deadline)) || !withinBudget()) return false;
        if ((await readdir(directory)).length !== 0) return false;
        if (!withinBudget() || !(await parentsMatch(deadline)) || !withinBudget()) return false;
        await rmdir(directory);
        if (!withinBudget()) return false;
        // A concurrently recreated root is residual content, not our property.
        try {
          await lstat(directory);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ENOENT';
        }
      } catch {
        return false;
      }
    },
  };
}

export function warnOciWorkspace(
  directory: string,
  localLog?: (warning: OciCleanupWarning) => void | Promise<void>,
) {
  const warning: OciCleanupWarning = { code: 'OCI_WORKSPACE_REMAINS', directory };
  try {
    void Promise.resolve(localLog?.(warning)).catch(() => {});
  } catch {}
  try {
    process.stderr.write(
      'Warning: OCI cleanup could not verify removal; stop workspace users and manually remove when safe: ' +
        JSON.stringify(directory) +
        '\n',
    );
  } catch {
    /* Logging must not replace the task result. */
  }
}
