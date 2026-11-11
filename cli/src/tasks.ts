// SPDX-License-Identifier: Apache-2.0
import { cliName } from './distribution.js';
import { attachHeldDeliveryStatus, HeldRequestReview, inspectStoredIdentity, WorkerTrustStore, workerIntakePath } from '@acp/runtime';
import type { IdentityStoreOptions } from '@acp/runtime/key-store';
import { confirmOwner } from './connections.js';
import { cliTaskInspection, literalText, taskContent } from './task-review.js';

const USAGE = 'Usage: ' + cliName + ' tasks list | show ID | approve ID | reject ID [--key FILE] [--role worker|requester]. ID is an individual held ID or task ID from tasks list (intake remains per peer). show displays validated manifest/input/capabilities as literal JSON and records display inspection only. approve/reject require interactive TTY owner confirmation and close this terminal held attempt locally; neither executes it, sends a reply, grants connection consent, nor approves a future task. Explicitly resubmit a fresh task to the running worker; inspect and approve it again at its live owner prompt. No automatic retry. requests approve retains its connection-consent meaning. / show は検証済みのタスク内容を文字列として表示します。approve/reject は対話式 TTY で確認し、終端の保留内容だけを閉じます。実行・接続同意・次のタスクの承認は行いません。新しいタスクを明示的に再送し、ワーカーの所有者プロンプトで再度内容を確認・承認してください。';

export async function tasksCommand(args: string[], options: {
  identityOptions?: IdentityStoreOptions; output?: (text: string) => void;
  review?: (summary: string) => Promise<boolean>;
} = {}): Promise<void> {
  const output = options.output ?? ((text: string) => new Promise<void>((resolve, reject) => {
    process.stdout.write(text + '\n', error => error ? reject(error) : resolve());
  }));
  if (args.includes('--help') || args.includes('-h')) { await output(USAGE); return; }
  const [action, ...rest] = args, ids: string[] = [], flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!flag.startsWith('--')) { ids.push(flag); continue; }
    if (!['--key', '--role'].includes(flag) || flags.has(flag) || !rest[i + 1] || rest[i + 1].startsWith('--'))
      throw new Error('INVALID_TASK_REVIEW_OPTION');
    flags.set(flag, rest[++i]);
  }
  const role = flags.get('--role') ?? 'worker';
  if (!['list', 'show', 'approve', 'reject'].includes(action) || ids.length !== (action === 'list' ? 0 : 1) ||
      !['worker', 'requester'].includes(role)) throw new Error(USAGE);
  const identityOptions = { ...options.identityOptions, explicitKeyPath: flags.get('--key') };
  const key = (await inspectStoredIdentity(role as 'worker' | 'requester', identityOptions)).key;
  if (!key) { if (action === 'list') { await output('{"tasks":[]}'); return; } throw new Error('REQUEST_REVIEW_UNAVAILABLE'); }
  const review = new HeldRequestReview(key, { ...identityOptions, provider: cliTaskInspection(output) });
  const store = new WorkerTrustStore(key, { path: workerIntakePath(key.did, identityOptions), fs: identityOptions.fs, platform: identityOptions.platform });
  attachHeldDeliveryStatus(key, review, identityOptions, store);
  const tasks = review.list().filter(r => r.kind === 'task');
  if (action === 'list') { await output(literalText({ localOwnerDid: key.did, role, tasks })); return; }
  const held = tasks.find(r => r.id === ids[0] || r.taskId === ids[0]);
  if (!held || held.state === 'expired') throw new Error('QUARANTINE_NOT_FOUND');
  // A cached receipt cannot stand in for display during this owner operation.
  if (held.inspectionStatus === 'complete') {
    const record = review.store.read(held.id)!;
    await output(literalText({ heldId: held.id, ...taskContent(record.envelope, key, held.contentDigest, record.envelopeDigest) }));
  } else if ((await review.inspect(held.id)).inspectionStatus !== 'complete') throw new Error('INSPECTION_INCOMPLETE');
  if (action === 'show') return;
  if (!await confirmOwner(literalText({ action, heldId: held.id, taskId: held.taskId,
    localOwnerDid: key.did, peerOwnerDid: held.senderOwnerDid,
    effect: 'Close this terminal held attempt locally. No execution or future approval. A fresh submission needs live owner approval.' }), options.review))
    throw new Error('APPROVAL_REJECTED');
  // Do not relabel intake as approval: that would also affect prior-approved peer metadata.
  review.discard(held.id);
  await output(literalText({ id: held.id, taskId: held.taskId, decision: action, executed: false,
    requiresFreshTask: action === 'approve', nextStep: 'A fresh task needs separate inspection and live worker owner approval. Do not retry automatically.' }));
}
