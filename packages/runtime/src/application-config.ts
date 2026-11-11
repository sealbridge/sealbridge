// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { validateRelayEndpointUrl } from '@acp/core';
import {
  resolveDataRoot, checkPrivatePath, checkPrivateStat,
  inspectPrivateDirectory, ensurePrivateDirectory,
} from './local-identity.js';
import type { DataRootOptions } from './local-identity.js';
import { DEFAULT_PUBLIC_RELAY, normalizeRelayUrl } from './relay-selection.js';

export interface ApplicationConfig {
  version: 1;
  relays: readonly string[];
  keyStore?: 'file' | 'keychain';
  localPcExecution?: boolean;
  /** Retained for callers that later write additional application settings. */
  [field: string]: unknown;
}
export interface ApplicationConfigOptions extends DataRootOptions {
  fs?: typeof fs;
  allowPrivateRelay?: boolean;
}
const MAX_CONFIG_BYTES = 64 * 1024;
const failure = (code: string) => new Error(code);
const errno = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** Validate every candidate without DNS or network requests. */
export function validateApplicationConfig(value: unknown, options: ApplicationConfigOptions = {}): ApplicationConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('APP_CONFIG_INVALID');
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw failure('APP_CONFIG_UNSUPPORTED_VERSION');
  if (Object.hasOwn(record, 'keyStore') && record.keyStore !== 'file' && record.keyStore !== 'keychain')
    throw failure('APP_CONFIG_INVALID');
  if (Object.hasOwn(record, 'localPcExecution') && typeof record.localPcExecution !== 'boolean')
    throw failure('APP_CONFIG_INVALID');
  const candidate = (entry: unknown): string => {
    if (typeof entry !== 'string' || !entry || Buffer.byteLength(entry) > 2048)
      throw failure('APP_CONFIG_INVALID');
    let url: URL;
    try { url = new URL(entry); } catch { throw failure('APP_CONFIG_INVALID'); }
    if (url.username || url.password || entry.includes('?') || entry.includes('#'))
      throw failure('APP_CONFIG_INVALID');
    validateRelayEndpointUrl(entry, options);
    const normalized = normalizeRelayUrl(entry);
    if (Buffer.byteLength(normalized) > 2048) throw failure('APP_CONFIG_INVALID');
    return normalized;
  };
  const hasList = Object.hasOwn(record, 'relays');
  const hasScalar = Object.hasOwn(record, 'relay');
  const entries = hasList ? record.relays : hasScalar ? [record.relay] : undefined;
  if (!Array.isArray(entries) || !entries.length || entries.length > 8)
    throw failure('APP_CONFIG_INVALID');
  const relays = [...new Set(entries.map(candidate))];
  const scalar = hasScalar ? candidate(record.relay) : undefined;
  if (hasScalar && (relays.length !== 1 || scalar !== relays[0]))
    throw failure('APP_CONFIG_CONFLICT');
  const { relay: _legacy, ...fields } = record;
  return { ...fields, version: 1, relays };
}

function location(options: ApplicationConfigOptions) {
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? win32 : posix;
  const root = resolveDataRoot(options);
  return { root, path: paths.join(root, 'config.json'), paths, platform, io: options.fs ?? fs };
}

/** Absent configuration is an in-memory default; reading never creates files. */
function readConfig(options: ApplicationConfigOptions): { config: ApplicationConfig; raw?: string } {
  const { root, path, platform, io } = location(options);
  let fd: number | undefined;
  let observed = false;
  let raw: string;
  try {
    checkPrivatePath(path, io, platform);
    const before = io.lstatSync(path);
    observed = true;
    // An installer-only data root need not have private-file permissions yet.
    // Apply the directory policy only when a config file is actually present.
    inspectPrivateDirectory(root, io, platform);
    checkPrivateStat(before);
    fd = io.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) |
      (fs.constants.O_NONBLOCK ?? 0));
    const stat = io.fstatSync(fd);
    checkPrivateStat(stat);
    if (stat.dev !== before.dev || stat.ino !== before.ino) throw failure('APP_CONFIG_INVALID');
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = io.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_CONFIG_BYTES) throw failure('APP_CONFIG_INVALID');
    raw = bytes.subarray(0, length).toString('utf8');
  } catch (error) {
    if (!observed && errno(error) === 'ENOENT') return { config: { version: 1, relays: [DEFAULT_PUBLIC_RELAY] } };
    if (error instanceof Error && ['IDENTITY_INVALID', 'APP_CONFIG_INVALID'].includes(error.message))
      throw failure('APP_CONFIG_INVALID');
    throw failure('APP_CONFIG_UNREADABLE');
  } finally { if (fd !== undefined) io.closeSync(fd); }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw failure('APP_CONFIG_INVALID'); }
  return { config: validateApplicationConfig(value, options), raw };
}

export function readApplicationConfig(options: ApplicationConfigOptions = {}): ApplicationConfig {
  return readConfig(options).config;
}

// Long enough for a peer to publish the same backend, short enough that a stale lock still fails.
const KEY_STORE_LOCK_ATTEMPTS = 80;
const KEY_STORE_LOCK_POLL_MS = 15;
const pause = (milliseconds: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

function lockPresent(io: typeof fs, lock: string): boolean {
  try { io.lstatSync(lock); return true; }
  catch (error) { if (errno(error) === 'ENOENT') return false; throw failure('APP_CONFIG_UNREADABLE'); }
}

function peekConfig(options: ApplicationConfigOptions): ApplicationConfig | undefined {
  try { return readConfig(options).config; }
  catch (error) {
    if (error instanceof Error && error.message === 'APP_CONFIG_UNREADABLE') return undefined;
    throw error;
  }
}

/**
 * A matching read while the lock is still held can be the pre-image of a different update.
 * Accept it once that holder releases, and on the last poll if the bytes are already requested.
 */
function publishedKeyStore(keyStore: 'file' | 'keychain', options: ApplicationConfigOptions, lock: string, last: boolean): ApplicationConfig | undefined {
  if (peekConfig(options)?.keyStore !== keyStore) return undefined;
  if (lockPresent(location(options).io, lock) && !last) return undefined;
  const config = peekConfig(options);
  return config?.keyStore === keyStore ? config : undefined;
}

function commitApplicationSetting(field: 'keyStore' | 'localPcExecution', value: 'file' | 'keychain' | boolean, options: ApplicationConfigOptions): ApplicationConfig | 'locked' {
  const { root, path, paths, platform, io } = location(options);
  const lock = paths.join(root, '.config.lock');
  const temporary = paths.join(root, '.config.' + randomUUID() + '.tmp');
  let lockFd: number | undefined, fd: number | undefined;
  let created = false;
  try {
    ensurePrivateDirectory(root, io, platform);
    checkPrivatePath(lock, io, platform);
    try {
      lockFd = io.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    } catch (error) {
      if (errno(error) === 'EEXIST') return 'locked';
      throw error;
    }
    checkPrivateStat(io.fstatSync(lockFd));
    const before = readConfig(options);
    if (before.config[field] === value) return before.config;
    const updated = { ...(before.raw === undefined ? before.config : JSON.parse(before.raw)), [field]: value };
    const config = validateApplicationConfig(updated, options);
    if (before.raw === undefined) return createApplicationConfig(updated, options);
    const bytes = Buffer.from(JSON.stringify(updated, null, 2) + '\n');
    if (bytes.length > MAX_CONFIG_BYTES) throw failure('APP_CONFIG_INVALID');
    fd = io.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    created = true;
    checkPrivateStat(io.fstatSync(fd));
    let offset = 0;
    while (offset < bytes.length) {
      const count = io.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!count) throw failure('APP_CONFIG_UNWRITABLE');
      offset += count;
    }
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = undefined;
    if (readConfig(options).raw !== before.raw) throw failure('APP_CONFIG_BUSY');
    io.renameSync(temporary, path);
    created = false;
    return config;
  } catch (error) {
    if (error instanceof Error && /^(APP_CONFIG_|KEY_STORE_)/.test(error.message)) throw error;
    throw failure(errno(error) === 'EEXIST' ? 'APP_CONFIG_BUSY' : 'APP_CONFIG_UNWRITABLE');
  } finally {
    if (fd !== undefined) io.closeSync(fd);
    if (created) io.unlinkSync(temporary);
    if (lockFd !== undefined) { io.closeSync(lockFd); io.unlinkSync(lock); }
  }
}

/** Update only the backend setting; retain unknown fields and leave matching bytes untouched. */
export function setApplicationKeyStore(keyStore: 'file' | 'keychain', options: ApplicationConfigOptions = {}): ApplicationConfig {
  if (keyStore !== 'file' && keyStore !== 'keychain') throw failure('KEY_STORE_INVALID');
  const { root, paths, io } = location(options);
  const lock = paths.join(root, '.config.lock');
  for (let attempt = 0; attempt < KEY_STORE_LOCK_ATTEMPTS; attempt += 1) {
    const committed = commitApplicationSetting('keyStore', keyStore, options);
    if (committed !== 'locked') return committed;
    const last = attempt + 1 === KEY_STORE_LOCK_ATTEMPTS;
    const published = publishedKeyStore(keyStore, options, lock, last);
    if (published) return published;
    if (!lockPresent(io, lock)) continue;
    if (last) break;
    pause(KEY_STORE_LOCK_POLL_MS);
  }
  throw failure('APP_CONFIG_BUSY');
}

/** Publish an initial config exclusively. Existing files are never replaced. */
export function createApplicationConfig(value: unknown, options: ApplicationConfigOptions = {}): ApplicationConfig {
  const config = validateApplicationConfig(value, options);
  let bytes: Buffer;
  try { bytes = Buffer.from(JSON.stringify(config, null, 2) + '\n'); }
  catch { throw failure('APP_CONFIG_INVALID'); }
  if (bytes.length > MAX_CONFIG_BYTES) throw failure('APP_CONFIG_INVALID');
  const { root, path, paths, platform, io } = location(options);
  const temporary = paths.join(root, '.config.' + randomUUID() + '.tmp');
  let fd: number | undefined;
  let created = false;
  try {
    ensurePrivateDirectory(root, io, platform);
    fd = io.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    created = true;
    checkPrivateStat(io.fstatSync(fd));
    let offset = 0;
    while (offset < bytes.length) {
      const count = io.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!count) throw failure('APP_CONFIG_UNWRITABLE');
      offset += count;
    }
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = undefined;
    checkPrivatePath(path, io, platform);
    io.linkSync(temporary, path);
  } catch (error) {
    throw failure(errno(error) === 'EEXIST' ? 'APP_CONFIG_BUSY' : 'APP_CONFIG_UNWRITABLE');
  } finally {
    if (fd !== undefined) io.closeSync(fd);
    if (created) io.unlinkSync(temporary);
  }
  return config;
}

/** Persist local-distribution consent using the same locked, atomic settings path. */
export function setApplicationLocalPcExecution(enabled: boolean, options: ApplicationConfigOptions = {}): ApplicationConfig {
  if (typeof enabled !== 'boolean') throw failure('APP_CONFIG_INVALID');
  for (let attempt = 0; attempt < KEY_STORE_LOCK_ATTEMPTS; attempt++) {
    const committed = commitApplicationSetting('localPcExecution', enabled, options);
    if (committed !== 'locked') return committed;
    pause(KEY_STORE_LOCK_POLL_MS);
  }
  throw failure('APP_CONFIG_BUSY');
}
