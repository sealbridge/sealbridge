// SPDX-License-Identifier: Apache-2.0
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { InviteStore, inspectStoredIdentity, resolveStoredIdentity } from '@acp/runtime';
import type { IdentityStoreOptions, InviteStoreOptions } from '@acp/runtime';

interface AcceptOptions extends InviteStoreOptions, IdentityStoreOptions {
  input?: Readable & { isTTY?: boolean };
  output?: Writable;
  readPaste?: () => Promise<string>;
}
const USAGE = 'Usage: sealbridge accept <link> [--alias <slug>] | accept --paste [--alias <slug>] | invites list | invites remove <alias-or-ref>';
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
  if (args.length === 1 && args[0] === '--help') { console.log(USAGE); return; }
  if (command === 'invites') {
    if (!(args.length === 1 && args[0] === 'list') &&
        !(args.length === 2 && args[0] === 'remove' && !args[1].startsWith('--'))) throw new Error(USAGE);
    const owner = (await inspectStoredIdentity('requester', options)).key;
    const store = owner ? new InviteStore(owner, options) : undefined;
    console.log(JSON.stringify(args[0] === 'list'
      ? { invites: store?.list() ?? [] } : { removed: store?.remove(args[1]) ?? false }));
    return;
  }
  let alias: string | undefined, link: string | undefined, usePaste = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--alias' && alias === undefined && args[i + 1] && !args[i + 1].startsWith('--')) alias = args[++i];
    else if (arg === '--paste' && !usePaste) usePaste = true;
    else if (!arg.startsWith('--') && link === undefined) link = arg;
    else throw new Error(USAGE);
  }
  if (usePaste === (link !== undefined)) throw new Error(USAGE);
  if (usePaste) link = (await paste(options)).trim();
  const owner = await resolveStoredIdentity('requester', options);
  console.log(JSON.stringify(new InviteStore(owner, options).import(link!, alias)));
}
