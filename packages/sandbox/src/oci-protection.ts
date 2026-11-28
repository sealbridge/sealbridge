// SPDX-License-Identifier: Apache-2.0
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function failure(location?: string, principal = 'unknown', permission = 'inspection unavailable') {
  if (location) {
    try {
      process.stderr.write(
        'Warning: OCI workspace protection could not be established: ' +
          JSON.stringify({ location, principal, permission }) +
          '; prefer a dedicated non-root account and a protected temporary directory.\n',
      );
    } catch {
      /* Local diagnostics must not leak into the peer error. */
    }
  }
  return new Error('OCI_WORKSPACE_UNPROTECTED');
}

/**
 * Trust the launcher identity, root and OS administrators during setup.
 * Check both directory privacy and protection of each ancestor entry.
 * POSIX only. Windows inherits OS profile permissions without ACL inspection.
 */
export async function verifyWorkspaceParent(directory: string, privateDirectory = true) {
  // Windows relies on the OS profile ACL; this is not a Windows preflight.
  if (process.platform === 'win32') return;
  const uid = process.getuid?.();
  if (uid === undefined) throw failure(directory);
  for (let path = directory; ; path = dirname(path)) {
    const stat = await lstat(path).catch(() => {
      throw failure(path);
    });
    if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, uid].includes(stat.uid))
      throw failure(path, String(stat.uid), 'directory type or owner');
    if (path === directory && privateDirectory) {
      if (stat.uid !== uid || (stat.mode & 0o777) !== 0o700)
        throw failure(path, String(stat.uid), stat.mode.toString(8));
    } else if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
      // A sticky temp directory protects entries owned by the launcher; an
      // ordinary group/world-writable ancestor does not.
      throw failure(path, String(stat.uid), stat.mode.toString(8));
    }
    if (dirname(path) === path) break;
  }
}

export interface DirectoryAnchor {
  path: string;
  handle?: FileHandle;
  close(): Promise<void>;
}

/** Linux adds handle-relative setup; other platforms use path-based operations. */
export async function anchorDirectory(path: string): Promise<DirectoryAnchor> {
  if (process.platform !== 'linux') return { path, close: async () => {} };
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat({ bigint: true });
    const anchored = '/proc/self/fd/' + handle.fd;
    const throughFd = await lstat(await realpath(anchored), { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.ino === 0n ||
      stat.dev !== throughFd.dev ||
      stat.ino !== throughFd.ino
    )
      throw failure();
    // Opening the proc descriptor must resolve to the same directory handle.
    const check = await open(anchored, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const actual = await check.stat({ bigint: true });
      if (actual.dev !== stat.dev || actual.ino !== stat.ino) throw failure();
    } finally {
      await check.close();
    }
    return { path: anchored, handle, close: () => handle.close() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
