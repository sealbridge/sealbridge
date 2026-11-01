// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { inspectPrivateDirectory, writePrivateFile } from '@acp/runtime/local-identity';

export type InviteOutput = { kind: 'stdout' } | { kind: 'none' } | { kind: 'file'; path: string } |
  { kind: 'fd'; fd: number };

function requireFdOutputSupport(): void {
  // Windows extra stdio pipes are not plain fds usable by fstatSync/writeSync.
  if (process.platform === 'win32') throw new Error('INVITE_OUTPUT_FD_UNSUPPORTED_PLATFORM');
}

export function parseInviteOutput(value: string | true | undefined): InviteOutput {
  if (value === undefined || value === 'stdout') return { kind: 'stdout' };
  if (value === 'none') return { kind: 'none' };
  if (typeof value === 'string') {
    if (value.startsWith('file:') && value.slice(5).trim())
      return { kind: 'file', path: resolve(value.slice(5)) };
    if (/^fd:[1-9]\d*$/.test(value)) {
      const fd = Number(value.slice(3));
      if (Number.isSafeInteger(fd) && fd > 2 && fd <= 2_147_483_647) {
        requireFdOutputSupport();
        return { kind: 'fd', fd };
      }
    }
  }
  throw new Error('INVALID_INVITE_OUTPUT');
}

/** The caller owns inherited descriptors and the existing destination directory. */
export function deliverInvite(output: InviteOutput, token: string): void {
  if (output.kind === 'fd') requireFdOutputSupport();
  if (output.kind === 'none') return;
  if (output.kind === 'stdout') {
    console.log(token);
    console.log('https://sealbridge.app/i#' + token);
    return;
  }
  try {
    const bytes = Buffer.from(token + '\n');
    if (output.kind === 'file') {
      inspectPrivateDirectory(dirname(output.path), fs);
      writePrivateFile(output.path, bytes, fs);
    } else {
      const stat = fs.fstatSync(output.fd);
      if (!stat.isFile() && !stat.isFIFO() && !stat.isSocket()) throw new Error();
      if (stat.isFile() &&
          (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0)) throw new Error();
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.writeSync(output.fd, bytes, offset, bytes.length - offset);
        if (!count) throw new Error();
        offset += count;
      }
    }
  } catch {
    // Destination names and operating-system error text are not output fields.
    throw new Error('INVITE_OUTPUT_UNAVAILABLE');
  }
}
