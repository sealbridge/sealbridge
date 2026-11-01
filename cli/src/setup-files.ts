// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseTree } from 'jsonc-parser';
import type { Node as JsonNode, ParseError } from 'jsonc-parser';
import { checkPrivatePath, ensurePrivateDirectory } from '@acp/runtime/local-identity';

export interface Snapshot { path: string; bytes?: Buffer; stat?: fs.Stats }
export interface FileChange extends Snapshot { next: Buffer; backup?: string }
function fail(code: string): never { throw new Error(code); }
const errno = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** Host directories are checked for links, without changing their permissions. */
export function snapshot(path: string, io = fs, platform = process.platform): Snapshot {
  let fd: number | undefined;
  try {
    checkPrivatePath(path, io, platform);
    let before: fs.Stats;
    try { before = io.lstatSync(path); }
    catch (error) { if (errno(error) === 'ENOENT') return { path }; throw error; }
    if (!before.isFile() || before.size > 1024 * 1024) fail('SETUP_CONFIG_INVALID');
    fd = io.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) |
      (fs.constants.O_NONBLOCK ?? 0));
    const stat = io.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) fail('SETUP_CONFIG_CHANGED');
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let length = 0, count: number;
    while (length < buffer.length && (count = io.readSync(fd, buffer, length, buffer.length - length, null))) length += count;
    if (length > 1024 * 1024) fail('SETUP_CONFIG_INVALID');
    return { path, bytes: buffer.subarray(0, length), stat };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SETUP_')) throw error;
    if (error instanceof Error && error.message === 'IDENTITY_INVALID') fail('SETUP_CONFIG_INVALID');
    return fail('SETUP_WRITE_FAILED');
  } finally { if (fd !== undefined) io.closeSync(fd); }
}

export function strictObject(bytes: Buffer): { text: string; tree: JsonNode } {
  const raw = bytes.toString('utf8');
  if (!Buffer.from(raw).equals(bytes)) fail('SETUP_CONFIG_INVALID');
  const text = raw.replace(/^\uFEFF/, '');
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (!tree || tree.type !== 'object' || errors.length) fail('SETUP_CONFIG_INVALID');
  function duplicates(node: JsonNode) {
    if (node.type === 'object') {
      const names = new Set<string>();
      for (const property of node.children ?? []) {
        const name = property.children![0].value as string;
        if (names.has(name)) fail('SETUP_CONFIG_INVALID');
        names.add(name);
      }
    }
    for (const child of node.children ?? []) duplicates(child);
  }
  duplicates(tree);
  return { text, tree };
}

export function hostChange(original: Snapshot, entry: unknown,
  options: { updateExisting?: boolean; alternateEntry?: unknown } = {}): FileChange {
  const { text, tree } = strictObject(original.bytes ?? Buffer.from('{}\n'));
  const value = JSON.parse(text) as Record<string, unknown>;
  const servers = tree.children?.find(p => p.children![0].value === 'mcpServers')?.children![1];
  if (servers && servers.type !== 'object') fail('SETUP_CONFIG_INVALID');
  if (servers && Object.hasOwn(value.mcpServers as object, 'sealbridge')) {
    const existing = (value.mcpServers as Record<string, unknown>).sealbridge;
    if (isDeepStrictEqual(existing, entry)) return { ...original, next: original.bytes! };
    if (!options.updateExisting) fail(options.alternateEntry !== undefined && isDeepStrictEqual(existing, options.alternateEntry)
      ? 'SETUP_APPROVAL_MODE_CONFLICT' : 'SETUP_ENTRY_CONFLICT');
    const node = servers.children!.find(p => p.children![0].value === 'sealbridge')!.children![1];
    const bom = original.bytes?.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? '\uFEFF' : '';
    const next = Buffer.from(bom + text.slice(0, node.offset) + JSON.stringify(entry) + text.slice(node.offset + node.length));
    strictObject(next);
    return { ...original, next };
  }
  // Insert only the property bytes. Existing keys, spacing, BOM and line endings stay intact.
  const object = servers ?? tree;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const unit = /(?:^|\n)([ \t]+)"/.exec(text)?.[1] ?? '  ';
  const base = servers ? unit : '';
  const property = JSON.stringify(servers ? { sealbridge: entry } : { mcpServers: { sealbridge: entry } }, null, unit)
    .slice(2, -2).split('\n').map(line => base + line).join(eol);
  const children = object.children ?? [];
  const last = children.at(-1);
  const offset = last ? last.offset + last.length : object.offset + 1;
  const tail = text.slice(offset, object.offset + object.length - 1);
  const suffix = tail.includes('\n') ? '' : eol + base;
  const next = text.slice(0, offset) + (last ? ',' : '') + eol + property + suffix + text.slice(offset);
  const bom = original.bytes?.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? '\uFEFF' : '';
  const bytes = Buffer.from(bom + next);
  strictObject(bytes);
  return { ...original, next: bytes };
}

export function assertUnchanged(original: Snapshot, io = fs, platform = process.platform) {
  const current = snapshot(original.path, io, platform);
  if (original.bytes === undefined ? current.bytes !== undefined :
      !current.bytes?.equals(original.bytes) || current.stat!.dev !== original.stat!.dev ||
      current.stat!.ino !== original.stat!.ino || current.stat!.mode !== original.stat!.mode ||
      current.stat!.uid !== original.stat!.uid || current.stat!.gid !== original.stat!.gid)
    fail('SETUP_CONFIG_CHANGED');
}

function flushed(path: string, bytes: Buffer, mode: number, io: typeof fs, owner?: fs.Stats, created?: () => void) {
  const fd = io.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0), mode);
  try {
    created?.();
    if (process.platform !== 'win32' && owner) {
      const stat = io.fstatSync(fd);
      if (stat.uid !== owner.uid || stat.gid !== owner.gid) io.fchownSync(fd, owner.uid, owner.gid);
      io.fchmodSync(fd, mode);
    }
    let offset = 0;
    while (offset < bytes.length) {
      const count = io.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!count) fail('SETUP_WRITE_FAILED');
      offset += count;
    }
    io.fsyncSync(fd);
  } finally { io.closeSync(fd); }
}

/** A backup remains available after a later write failure; never restore over owner edits. */
export function publish(change: FileChange, root: string, io = fs, platform = process.platform) {
  assertUnchanged(change, io, platform);
  if (change.bytes?.equals(change.next)) return;
  const temporary = join(dirname(change.path), '.sealbridge.' + randomUUID() + '.tmp');
  let madeTemporary = false;
  try {
    if (change.bytes) {
      const backups = join(root, 'setup', 'backups');
      ensurePrivateDirectory(join(root, 'setup'), io, platform);
      ensurePrivateDirectory(backups, io, platform);
      change.backup = join(backups, randomUUID());
      flushed(change.backup, change.bytes, 0o600, io);
    }
    checkPrivatePath(change.path, io, platform);
    io.mkdirSync(dirname(change.path), { recursive: true });
    checkPrivatePath(change.path, io, platform);
    flushed(temporary, change.next, change.stat ? change.stat.mode & 0o777 : 0o600, io, change.stat,
      () => { madeTemporary = true; });
    assertUnchanged(change, io, platform);
    if (change.bytes) io.renameSync(temporary, change.path);
    else io.linkSync(temporary, change.path);
    const current = snapshot(change.path, io, platform);
    if (!current.bytes?.equals(change.next)) fail('SETUP_CONFIG_CHANGED');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SETUP_')) throw error;
    fail(errno(error) === 'EEXIST' ? 'SETUP_CONFIG_CHANGED' : 'SETUP_WRITE_FAILED');
  } finally {
    if (madeTemporary) { try { io.unlinkSync(temporary); } catch (error) { if (errno(error) !== 'ENOENT') throw new Error('SETUP_WRITE_FAILED'); } }
  }
}
