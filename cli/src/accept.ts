// SPDX-License-Identifier: Apache-2.0
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { InviteStore, inspectStoredIdentity, resolveStoredIdentity } from '@acp/runtime';
import type { IdentityStoreOptions, InviteStoreOptions } from '@acp/runtime';

interface AcceptOptions extends InviteStoreOptions, IdentityStoreOptions {
  input?: Readable & { isTTY?: boolean; unref?: () => unknown };
  output?: Writable;
  readPaste?: () => Promise<string>;
}
const USAGE = 'Usage: sealbridge accept <link> [--alias <slug>] | accept --paste [--alias <slug>] | accept --stdin [--alias <slug>] | invites list | invites remove <alias-or-ref>';
// Allow the existing 64 KiB token bound plus link framing and whitespace.
const MAX_STDIN_BYTES = 68 * 1024;
const STDIN_TIMEOUT_MS = 10_000;
async function readStdin(options: AcceptOptions): Promise<string> {
  const input: NonNullable<AcceptOptions['input']> = options.input ?? process.stdin;
  if (input.isTTY) throw new Error('INVITE_STDIN_REQUIRES_PIPE: use a pipe or file with --stdin, or --paste at a terminal');
  if (input.destroyed || input.readableEnded) throw new Error('INVITE_INPUT_UNAVAILABLE');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      clearTimeout(timer);
      input.pause();
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      input.off('close', onError);
    };
    const fail = (code: string) => {
      cleanup();
      chunks.length = 0;
      // Pausing alone leaves an open pipe alive and can block its writer.
      // Destroy without the original error so invitation material stays private.
      input.destroy();
      input.unref?.();
      reject(new Error(code));
    };
    const onData = (chunk: Buffer | string) => {
      const size = Buffer.byteLength(chunk);
      if (size > MAX_STDIN_BYTES - bytes) { fail('INVITE_INPUT_TOO_LARGE'); return; }
      bytes += size;
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    };
    const onEnd = () => {
      cleanup();
      const lines = Buffer.concat(chunks, bytes).toString('utf8').split(/\r\n|[\r\n]/).map(line => line.trim()).filter(Boolean);
      if (lines.length === 0) reject(new Error('INVITE_INPUT_EMPTY'));
      else if (lines.length !== 1) reject(new Error('INVITE_INPUT_MULTIPLE_LINES'));
      else resolve(lines[0]);
    };
    const onError = () => fail('INVITE_INPUT_UNAVAILABLE');
    const timer = setTimeout(() => fail('INVITE_INPUT_TIMEOUT'), STDIN_TIMEOUT_MS);
    input.once('end', onEnd);
    input.once('error', onError);
    input.once('close', onError);
    input.on('data', onData);
  });
}
async function paste(options: AcceptOptions): Promise<string> {
  const input = options.input ?? process.stdin;
  if (!input.isTTY) throw new Error('INVITE_INPUT_UNAVAILABLE');
  (options.output ?? process.stderr).write('Paste the complete invitation, then press Enter: ');
  if (options.readPaste) return options.readPaste();
  return new Promise((resolve, reject) => {
    const reader = createInterface({ input, terminal: false });
    reader.once('line', line => { resolve(line); reader.close(); });
    reader.once('close', () => reject(new Error('INVITE_INPUT_UNAVAILABLE')));
    reader.once('error', () => { reject(new Error('INVITE_INPUT_UNAVAILABLE')); reader.close(); });
  });
}
/** User-operated import; no relay, DNS, or contact operations. */
export async function acceptCommand(command: 'accept' | 'invites', args: string[], options: AcceptOptions = {}): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    console.log(USAGE + (command === 'accept'
      ? '\n--stdin reads one link from a pipe or file until EOF (68 KiB, 10 seconds); TTY input is rejected. Use --paste at a terminal. Output is token-free JSON.' : ''));
    return;
  }
  if (command === 'invites') {
    if (!(args.length === 1 && args[0] === 'list') &&
        !(args.length === 2 && args[0] === 'remove' && !args[1].startsWith('--'))) throw new Error(USAGE);
    const owner = (await inspectStoredIdentity('requester', options)).key;
    const store = owner ? await InviteStore.open(owner, options) : undefined;
    console.log(JSON.stringify(args[0] === 'list'
      ? { invites: store?.list() ?? [] } : { removed: store?.remove(args[1]) ?? false }));
    return;
  }
  let alias: string | undefined, link: string | undefined, usePaste = false, useStdin = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--alias' && alias === undefined && args[i + 1] && !args[i + 1].startsWith('--')) alias = args[++i];
    else if (arg === '--paste' && !usePaste) usePaste = true;
    else if (arg === '--stdin' && !useStdin) useStdin = true;
    else if (!arg.startsWith('--') && link === undefined) link = arg;
    else throw new Error(USAGE);
  }
  if (Number(usePaste) + Number(useStdin) + Number(link !== undefined) !== 1) throw new Error(USAGE);
  if (usePaste) link = (await paste(options)).trim();
  if (useStdin) link = await readStdin(options);
  const owner = await resolveStoredIdentity('requester', options);
  console.log(JSON.stringify((await InviteStore.open(owner, options)).import(link!, alias)));
}
