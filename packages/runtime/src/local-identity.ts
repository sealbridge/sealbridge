// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { createPrivateKey, randomUUID } from 'node:crypto';
import { generateKeyPair, signPayload, verifySigned } from '@acp/core';
import type { KeyPair } from '@acp/core';

export type IdentityRole = 'requester' | 'worker';
export interface DataRootOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}
export interface LocalIdentityOptions extends DataRootOptions {
  explicitKeyPath?: string;
  /** Filesystem injection for deterministic I/O failure tests. */
  fs?: typeof fs;
}
export interface LocalIdentity {
  path: string;
  source: 'explicit' | 'default' | 'legacy';
  key?: KeyPair;
}
const MAX_KEY_BYTES = 16 * 1024;
function failure(code: string): Error { return new Error(code); }
function errno(error: unknown): string | undefined { return (error as NodeJS.ErrnoException).code; }
function context(options: DataRootOptions) {
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? win32 : posix;
  const env = options.env ?? process.env;
  let home = options.home;
  if (home === undefined) { try { home = homedir(); } catch { home = ''; } }
  return { platform, paths, env, home };
}
export function resolveDataRoot(options: DataRootOptions = {}): string {
  const { platform, paths, env, home } = context(options);
  const override = env.SEALBRIDGE_DATA_DIR ?? env.ACP_DATA_DIR;
  if (override !== undefined) {
    if (!paths.isAbsolute(override)) throw failure('DATA_DIR_UNAVAILABLE');
    return paths.normalize(override);
  }
  const base = platform === 'win32' ? env.LOCALAPPDATA
    : platform === 'linux' ? env.XDG_DATA_HOME : undefined;
  if (base) {
    if (!paths.isAbsolute(base)) throw failure('DATA_DIR_UNAVAILABLE');
    return paths.join(base, platform === 'win32' ? 'Sealbridge' : 'sealbridge');
  }
  if (!home || !paths.isAbsolute(home)) throw failure('DATA_DIR_UNAVAILABLE');
  return platform === 'win32' ? paths.join(home, 'AppData', 'Local', 'Sealbridge')
    : platform === 'darwin' ? paths.join(home, 'Library', 'Application Support', 'Sealbridge')
    : paths.join(home, '.local', 'share', 'sealbridge');
}
function legacyPaths(role: IdentityRole, options: DataRootOptions): string[] {
  const { paths, platform, env, home } = context(options);
  if (!home || !paths.isAbsolute(home)) return [];
  if (env.ACP_DATA_DIR !== undefined && !paths.isAbsolute(env.ACP_DATA_DIR))
    throw failure('DATA_DIR_UNAVAILABLE');
  const result = [paths.join(home, '.acp', role + '.private.json')];
  if (role === 'requester') {
    const oldRoot = env.ACP_DATA_DIR ?? (platform === 'win32'
      ? paths.join(env.LOCALAPPDATA || home, 'AgentCollaborationPlatform')
      : platform === 'darwin' ? paths.join(home, 'Library', 'Application Support', 'AgentCollaborationPlatform')
      : paths.join(env.XDG_DATA_HOME || paths.join(home, '.local', 'share'), 'agent-collab-platform'));
    if (!paths.isAbsolute(oldRoot)) throw failure('DATA_DIR_UNAVAILABLE');
    result.push(paths.join(oldRoot, 'owner.private.json'));
  }
  return result;
}
/** Reject links, except macOS's root-owned /var and /tmp system aliases. */
export function checkPath(path: string, io: typeof fs, platform: NodeJS.Platform): void {
  const paths = platform === 'win32' ? win32 : posix;
  const parent = paths.dirname(path);
  if (parent !== path) checkPath(parent, io, platform);
  try {
    const stat = io.lstatSync(path);
    if (stat.isSymbolicLink()) {
      if (platform !== 'darwin' || !['/var', '/tmp'].includes(path) || stat.uid !== 0)
        throw failure('IDENTITY_INVALID');
      const target = posix.resolve(parent, io.readlinkSync(path));
      if (target !== '/private' + path) throw failure('IDENTITY_INVALID');
      checkPath(target, io, platform);
    }
  } catch (error) { if (errno(error) !== 'ENOENT') throw error; }
}
export function checkStat(stat: fs.Stats, directory = false): void {
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw failure('IDENTITY_INVALID');
  if (process.platform !== 'win32' &&
      (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0))
    throw failure('IDENTITY_INVALID');
}
export function inspectDirectory(path: string, io: typeof fs, platform: NodeJS.Platform): void {
  checkPath(path, io, platform);
  const before = io.lstatSync(path);
  checkStat(before, true);
  if (process.platform === 'win32') return;
  const fd = io.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) |
    (fs.constants.O_DIRECTORY ?? 0));
  try {
    const stat = io.fstatSync(fd);
    checkStat(stat, true);
    if (stat.dev !== before.dev || stat.ino !== before.ino) throw failure('IDENTITY_INVALID');
  } finally { io.closeSync(fd); }
}
function readKey(path: string, io: typeof fs, platform: NodeJS.Platform): KeyPair | undefined {
  let fd: number | undefined;
  let observed = false;
  try {
    checkPath(path, io, platform);
    // Check type before opening so special files cannot block the reader.
    const before = io.lstatSync(path);
    observed = true;
    checkStat(before);
    fd = io.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) |
      (fs.constants.O_NONBLOCK ?? 0));
    const stat = io.fstatSync(fd);
    checkStat(stat);
    if (stat.dev !== before.dev || stat.ino !== before.ino) throw failure('IDENTITY_INVALID');
    const bytes = Buffer.alloc(MAX_KEY_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = io.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_KEY_BYTES) throw failure('IDENTITY_INVALID');
    try {
      const value = JSON.parse(bytes.subarray(0, length).toString('utf8')) as KeyPair;
      if (!value || typeof value.did !== 'string' || typeof value.privateKey !== 'string' ||
          Object.keys(value).sort().join(',') !== 'did,privateKey' ||
          createPrivateKey(value.privateKey).asymmetricKeyType !== 'ed25519' ||
          !verifySigned(signPayload({ type: 'LocalIdentityCheck' }, value,
            '2026-01-01T00:00:00.000Z'), value.did)) throw failure('IDENTITY_INVALID');
      return value;
    } catch { throw failure('IDENTITY_INVALID'); }
  } catch (error) {
    if (errno(error) === 'ENOENT' && !observed) return undefined;
    if (error instanceof Error && error.message === 'IDENTITY_INVALID') throw error;
    throw failure('IDENTITY_UNREADABLE');
  } finally { if (fd !== undefined) io.closeSync(fd); }
}
/** Inspect without creating directories or identities. Canonical files take precedence. */
export function inspectLocalIdentity(role: IdentityRole, options: LocalIdentityOptions = {}): LocalIdentity {
  const io = options.fs ?? fs;
  const platform = options.platform ?? process.platform;
  if (options.explicitKeyPath !== undefined) {
    const path = context(options).paths.resolve(options.explicitKeyPath);
    const key = readKey(path, io, platform);
    if (!key) throw failure('IDENTITY_UNREADABLE');
    return { path, source: 'explicit', key };
  }
  const root = resolveDataRoot(options);
  for (const directory of [root, join(root, 'identities')]) {
    try {
      inspectDirectory(directory, io, platform);
    } catch (error) {
      if (errno(error) !== 'ENOENT') {
        if (error instanceof Error && error.message === 'IDENTITY_INVALID') throw error;
        throw failure('IDENTITY_UNREADABLE');
      }
    }
  }
  const path = join(root, 'identities', role + '.private.json');
  const key = readKey(path, io, platform);
  if (key) return { path, source: 'default', key };
  let legacy: LocalIdentity | undefined;
  for (const candidate of legacyPaths(role, options)) {
    const key = readKey(candidate, io, platform);
    if (!key) continue;
    if (legacy && legacy.key!.did !== key.did) throw failure('IDENTITY_SELECTION_REQUIRED');
    legacy ??= { path: candidate, source: 'legacy', key };
  }
  return legacy ?? { path, source: 'default' };
}
export function privateDirectory(path: string, io: typeof fs, platform: NodeJS.Platform): void {
  checkPath(path, io, platform);
  io.mkdirSync(path, { recursive: true, mode: 0o700 });
  inspectDirectory(path, io, platform);
}
/** Publish a flushed temporary key without replacing a concurrently committed identity. */
export function resolveOrCreateIdentity(role: IdentityRole, options: LocalIdentityOptions = {}): KeyPair {
  const io = options.fs ?? fs;
  const platform = options.platform ?? process.platform;
  const selected = inspectLocalIdentity(role, options);
  if (selected.key) return selected.key;
  const root = resolveDataRoot(options);
  const temporary = join(dirname(selected.path), '.' + role + '.' + randomUUID() + '.tmp');
  let fd: number | undefined;
  let temporaryCreated = false;
  try {
    privateDirectory(root, io, platform);
    privateDirectory(dirname(selected.path), io, platform);
    fd = io.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    temporaryCreated = true;
    checkStat(io.fstatSync(fd));
    const bytes = Buffer.from(JSON.stringify(generateKeyPair()) + '\n');
    let offset = 0;
    while (offset < bytes.length) {
      const count = io.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!count) throw failure('IDENTITY_STORE_UNWRITABLE');
      offset += count;
    }
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = undefined;
    checkPath(selected.path, io, platform);
    try { io.linkSync(temporary, selected.path); }
    catch (error) {
      if (errno(error) === 'EEXIST') { /* The committed winner is loaded below. */ }
      else if (['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EPERM'].includes(errno(error) ?? ''))
        throw failure('IDENTITY_CREATION_UNSUPPORTED');
      else throw error;
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('IDENTITY_')) throw error;
    throw failure('IDENTITY_STORE_UNWRITABLE');
  } finally {
    if (fd !== undefined) io.closeSync(fd);
    if (temporaryCreated) io.unlinkSync(temporary);
  }
  const winner = readKey(selected.path, io, platform);
  if (!winner) throw failure('IDENTITY_UNREADABLE');
  return winner;
}

// Shared checks for application files under the same data root.
export {
  checkPath as checkPrivatePath,
  checkStat as checkPrivateStat,
  inspectDirectory as inspectPrivateDirectory,
  privateDirectory as ensurePrivateDirectory,
};
