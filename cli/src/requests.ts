// SPDX-License-Identifier: Apache-2.0
import { createInterface } from 'node:readline/promises';
import { inspectStoredIdentity } from '@acp/runtime/key-store';
import type { IdentityStoreOptions } from '@acp/runtime/key-store';
import { WorkerTrustStore, workerIntakePath } from '@acp/runtime/worker-trust-store';

export async function requestsCommand(args: string[], options: {
  identityOptions?: IdentityStoreOptions;
  /** Test/host seam representing a human review channel, never an automatic policy. */
  review?: (summary: string) => Promise<boolean>;
  output?: (value: string) => void;
} = {}): Promise<void> {
  const usage = 'Usage: sealbridge requests list | approve ID [--trust limited|trusted] | deny ID [--key FILE]';
  if (args.length === 1 && args[0] === '--help') { (options.output ?? console.log)(usage); return; }
  const [action, ...rest] = args;
  const flags = new Map<string, string>(), ids: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!flag.startsWith('--')) { ids.push(flag); continue; }
    if (!['--key', '--trust'].includes(flag) || flags.has(flag) || !rest[i + 1] || rest[i + 1].startsWith('--'))
      throw new Error('INVALID_REQUEST_OPTION');
    flags.set(flag, rest[++i]);
  }
  const trust = flags.get('--trust') ?? 'limited';
  if (!['list', 'approve', 'deny'].includes(action) || ids.length !== (action === 'list' ? 0 : 1) ||
      !['limited', 'trusted'].includes(trust) || (flags.has('--trust') && action !== 'approve')) throw new Error(usage);
  const identityOptions = { ...options.identityOptions, explicitKeyPath: flags.get('--key') };
  const key = (await inspectStoredIdentity('worker', identityOptions)).key;
  if (!key) throw new Error('REQUEST_REVIEW_UNAVAILABLE');
  const store = new WorkerTrustStore(key, { path: workerIntakePath(key.did, identityOptions),
    fs: identityOptions.fs, platform: identityOptions.platform });
  const output = options.output ?? console.log;
  if (action === 'list') { output(JSON.stringify({ requests: store.list() })); return; }
  const request = store.list().find(r => r.id === ids[0]);
  if (!request) throw new Error('REQUEST_NOT_FOUND');
  const summary = JSON.stringify({ ...request, decision: action, trust: action === 'approve' ? trust : undefined,
    effect: action === 'deny' ? 'Deny this peer and remove its grant.' : trust === 'trusted'
      ? 'Admit this peer for 24 hours, including automatic execution when automatic policy is enabled.'
      : 'Admit this peer for 24 hours; LLM execution still requires owner contract approval.' });
  let approved: boolean;
  if (options.review) approved = await options.review(summary);
  else {
    if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('REQUEST_REVIEW_UNAVAILABLE');
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try { approved = (await rl.question(summary + '\nConfirm peer decision [y/N]? ')).trim().toLowerCase() === 'y'; }
    finally { rl.close(); }
  }
  if (!approved) throw new Error('APPROVAL_REJECTED');
  store.decide(ids[0], action as 'approve' | 'deny', trust as 'limited' | 'trusted');
  output(JSON.stringify({ id: ids[0], decision: action, ...(action === 'approve' ? { trust } : {}) }));
}
