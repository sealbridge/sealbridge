// SPDX-License-Identifier: Apache-2.0
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { anchorDirectory, verifyWorkspaceParent } from './oci-protection.js';
import type { DirectoryAnchor } from './oci-protection.js';

export interface OciCleanupWarning {
  code: 'OCI_WORKSPACE_REMAINS';
  directory: string;
}

const same = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino && a.ino !== 0n && a.birthtimeNs === b.birthtimeNs;

/** Fixed host-created entries only. This is not a race-proof recursive deleter. */
export async function createOciWorkspace() {
  // Windows uses the OS profile permissions; POSIX verifies private ancestry.
  const temp = await realpath(
    process.platform === 'win32'
      ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
      : tmpdir(),
  );
  await verifyWorkspaceParent(temp, false);
  const tempAnchor = await anchorDirectory(temp);
  let directory: string;
  let parentAnchor: DirectoryAnchor;
  try {
    const created = await mkdtemp(join(tempAnchor.path, 'acp-oci-'));
    directory = join(temp, basename(created));
    parentAnchor = await anchorDirectory(created);
  } finally {
    await tempAnchor.close();
  }
  const parents: [string, BigIntStats][] = [];
  const files = new Map<string, BigIntStats>();
  const children = new Map<string, BigIntStats>();
  const anchors = new Map<string, DirectoryAnchor>();
  let sealed = false;
  let anchorsClosed = false;
  const closeAnchors = async () => {
    if (anchorsClosed) return;
    anchorsClosed = true;
    await Promise.all([...anchors.values(), parentAnchor].map((anchor) => anchor.close()));
  };
  const cliDirectory = join(directory, 'cli');
  const inputDirectory = join(directory, 'input');
  const outputDirectory = join(directory, 'output');
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
  const workspace = {
    directory,
    cliDirectory,
    inputDirectory,
    outputDirectory,
    async write(name: 'runner.cjs' | 'task.json' | 'config.json', content: string) {
      if (sealed || anchorsClosed || !['runner.cjs', 'task.json', 'config.json'].includes(name))
        throw new Error('OCI_WORKSPACE_SEALED');
      const parent = name === 'config.json' ? cliDirectory : inputDirectory;
      const path = join(parent, name);
      const mode = name === 'config.json' ? 0o600 : 0o644;
      const anchor = anchors.get(parent)!;
      const file = await open(
        join(anchor.path, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        mode,
      );
      try {
        files.set(path, await file.stat({ bigint: true }));
        await file.writeFile(content);
        // Readable inside the input mount even under umask 0077. The launcher-
        // owned 0700 parent protects host path access; input is never writable
        // in the container. Files always retain the launcher's ownership.
        if (process.platform !== 'win32') await file.chmod(mode);
      } finally {
        await file.close();
      }
    },
    async seal() {
      if (sealed || anchorsClosed) throw new Error('OCI_WORKSPACE_SEALED');
      await verifyWorkspaceParent(directory);
      for (const name of ['config.json', 'runner.cjs', 'task.json']) {
        const parent = name === 'config.json' ? cliDirectory : inputDirectory;
        if (!files.has(join(parent, name))) throw new Error('OCI_WORKSPACE_INCOMPLETE');
      }
      sealed = true;
      // Ownership handoff is the final setup write. No host writes into output,
      // and no trusted input/config writes, are allowed after this point.
      if (process.getuid?.() === 0) {
        const output = anchors.get(outputDirectory)!;
        if (output.handle) await output.handle.chown(65534, 65534);
        else await chown(output.path, 65534, 65534);
      }
      await closeAnchors();
    },
    async cleanup(released: boolean, deadline: number, cliReleased = released): Promise<boolean> {
      await closeAnchors();
      // Fixed read-only inputs can be unlinked at task termination even when
      // container absence is unknown. This does not revoke already-open handles.
      // CLI state requires host process closure; output requires container release.
      const withinBudget = () => Date.now() < deadline;
      const childMatches = async (path: string) => {
        const saved = children.get(path);
        if (!saved) return false;
        const current = await lstat(path, { bigint: true });
        return current.isDirectory() && !current.isSymbolicLink() && same(saved, current);
      };
      for (const [path, saved] of files) {
        if (dirname(path) === cliDirectory && !cliReleased) continue;
        if (!withinBudget()) return false;
        try {
          if (!(await parentsMatch(deadline)) || !withinBudget()) return false;
          if (!(await childMatches(dirname(path)))) continue;
          if (Date.now() >= deadline) return false;
          const current = await lstat(path, { bigint: true });
          if (!current.isFile() || current.isSymbolicLink() || !same(saved, current)) continue;
          if (!withinBudget() || !(await parentsMatch(deadline)) || !withinBudget()) return false;
          if (!(await childMatches(dirname(path))) || !withinBudget()) return false;
          await unlink(path);
        } catch {
          /* One attempt per owned entry; continue to other known files. */
        }
      }
      // Only recorded output may be removed recursively, after container release
      // and identity/private-parent checks. Windows relies on the documented OS
      // profile-permission assumption for this LocalAppData run parent; no ACL
      // inspection is performed. POSIX rechecks current ownership and 0700.
      // The caller deadline does not cancel an issued rm: it can continue and
      // partially delete output after the caller stops waiting. No retries.
      for (const path of children.keys()) {
        if (path === outputDirectory && !released) continue;
        if (path === cliDirectory && !cliReleased) continue;
        try {
          if (!withinBudget() || !(await parentsMatch(deadline)) || !withinBudget()) return false;
          if (!(await childMatches(path)) || !withinBudget()) continue;
          if (path === outputDirectory) {
            const parent = await lstat(directory, { bigint: true });
            if (
              process.platform !== 'win32' &&
              (parent.uid !== BigInt(process.getuid!()) || (parent.mode & 0o7777n) !== 0o700n)
            )
              continue;
            if (!withinBudget() || !(await parentsMatch(deadline)) || !withinBudget()) return false;
            if (!(await childMatches(path)) || !withinBudget()) continue;
            await rm(path, { recursive: true, maxRetries: 0 });
          } else await rmdir(path);
        } catch {
          /* Changed entries/failures are retained; output rm can be partial. */
        }
      }
      if (!released || !cliReleased) return false;
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
  try {
    if (process.platform !== 'win32') {
      if (parentAnchor.handle) await parentAnchor.handle.chmod(0o700);
      else await chmod(directory, 0o700);
    }
    await verifyWorkspaceParent(directory, true);
    for (const [path, mode] of [
      [cliDirectory, 0o700],
      [inputDirectory, 0o755],
      [outputDirectory, 0o700],
    ] as const) {
      const anchoredPath = join(parentAnchor.path, basename(path));
      await mkdir(anchoredPath, { mode });
      const anchor = await anchorDirectory(anchoredPath);
      anchors.set(path, anchor);
      children.set(path, await lstat(path, { bigint: true }));
      if (process.platform !== 'win32') {
        if (anchor.handle) await anchor.handle.chmod(mode);
        else await chmod(path, mode);
      }
    }
    // Only scratch output is shared with the guest identity. In rootless/user-
    // namespace runtimes the operator must ensure the selected UID maps here.
    return workspace;
  } catch (error) {
    if (!(await workspace.cleanup(true, Date.now() + 3000))) warnOciWorkspace(directory);
    throw error;
  }
}

let rootWarningEmitted = false;
/** Host stderr only: never put this warning in task results, progress or audit. */
export function warnRootOciLauncher() {
  if (process.getuid?.() !== 0 || rootWarningEmitted) return;
  rootWarningEmitted = true;
  try {
    process.stderr.write(
      'Warning: OCI launcher is running as root; prefer a dedicated non-root identity and rootless runtime.\n',
    );
  } catch {
    /* Local logging must not change execution. */
  }
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
