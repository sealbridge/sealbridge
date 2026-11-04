// SPDX-License-Identifier: Apache-2.0
import { attachHeldDeliveryStatus } from '@acp/runtime';
import { openEnvelope } from '@acp/core';
import type { SignedEnvelope } from '@acp/core';
import { inspectStoredIdentity } from '@acp/runtime/key-store';
import type { IdentityStoreOptions } from '@acp/runtime/key-store';
import { WorkerTrustStore, workerIntakePath, HeldRequestReview } from '@acp/runtime';
import type { HeldContentReviewProvider } from '@acp/runtime';
import { confirmOwner, connectionsCommand } from './connections.js';
import type { ConnectionsCommandOptions } from './connections.js';

export async function requestsCommand(args: string[], options: {
  identityOptions?: IdentityStoreOptions; review?: (summary: string) => Promise<boolean>;
  output?: (value: string) => void; inspectionProvider?: HeldContentReviewProvider;
  transportFactory?: ConnectionsCommandOptions['transportFactory'];
} = {}): Promise<void> {
  const usage = 'Usage: sealbridge requests list | show ID | approve ID [--trust trusted (legacy finite grant)] | discard ID | deny ID [--key FILE] [--role worker|requester]. Default approve offers limited connection consent. For show and default approve, use an embedding app configured with a task inspection provider; the standalone CLI cannot inspect tasks and returns INSPECTION_INCOMPLETE until inspection completes. You can list pending metadata with requests list. For signed connection offers, check connections review list or use the invitation/connect flow (connections confirm-invite); connection review does not inspect or open tasks. Human confirmation requires an interactive TTY; --auto-accept does not provide inspection or connection consent. / show と既定の approve にはタスク検査プロバイダーを設定した組み込みアプリが必要です。単体 CLI はタスクを検査できず、検査完了までは INSPECTION_INCOMPLETE を返します。requests list で保留情報を確認できます。署名付き接続申し込みは connections review list で確認するか、招待・接続フロー（connections confirm-invite）を使ってください。接続審査だけではタスクを検査・開封しません。所有者の確認には対話式 TTY が必要です。--auto-accept は検査や接続同意を代替しません。';
  const output = options.output ?? console.log;
  if (args.includes('--help')) { output(usage); return; }
  const [action, ...rest] = args, flags = new Map<string, string>(), ids: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!flag.startsWith('--')) { ids.push(flag); continue; }
    if (!['--key', '--trust', '--role'].includes(flag) || flags.has(flag) || !rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error('INVALID_REQUEST_OPTION');
    flags.set(flag, rest[++i]);
  }
  const trust = flags.get('--trust') ?? 'limited', role = flags.get('--role') ?? 'worker';
  if (!['list','show','approve','discard','deny'].includes(action) || ids.length !== (action === 'list' ? 0 : 1) ||
      !['limited','trusted'].includes(trust) || (flags.has('--trust') && action !== 'approve') || !['worker','requester'].includes(role)) throw new Error(usage);
  const identityOptions = { ...options.identityOptions, explicitKeyPath: flags.get('--key') };
  const key = (await inspectStoredIdentity(role as 'worker' | 'requester', identityOptions)).key;
  if (!key) { if (action === 'list') { output(JSON.stringify({ requests: [] })); return; } throw new Error('REQUEST_REVIEW_UNAVAILABLE'); }
  const store = new WorkerTrustStore(key, { path: workerIntakePath(key.did, identityOptions), fs: identityOptions.fs, platform: identityOptions.platform });
  const review = new HeldRequestReview(key, { ...identityOptions, provider: options.inspectionProvider });
  attachHeldDeliveryStatus(key, review, identityOptions, store);
  if (action === 'list') {
    // Legacy text previews are historical metadata, never reviewed content.
    output(JSON.stringify({ requests: store.list().map(({ title: _title, description: _description, ...r }) => ({ ...r,
      inspectionStatus: review.list().find(h => h.taskId === r.taskId)?.inspectionStatus ?? 'unavailable' })) })); return;
  }
  const request = store.list().find(r => r.id === ids[0]);
  if (!request) throw new Error('REQUEST_NOT_FOUND');
  const held = review.list().find(h => h.taskId === request.taskId);
  if (action === 'show' || action === 'approve' && trust === 'limited') {
    if (!held) throw new Error('INSPECTION_INCOMPLETE');
    const inspected = await review.inspect(held.id);
    if (inspected.inspectionStatus !== 'complete') throw new Error('INSPECTION_INCOMPLETE: ' + inspected.inspectionStatus);
    if (action === 'show') { output(JSON.stringify(review.showReviewedContent(held.id))); return; }
  }
  if (action === 'approve' && trust === 'limited') {
    // A task without separate signed sender consent initiates an offer; it cannot infer reciprocal consent.
    const connection = store.listConnections().find(c => c.peerOwnerDid === request.requesterOwnerDid);
    if (!connection || !('relayUrl' in connection) || !connection.relayUrl) throw new Error('CONNECTION_NOT_FOUND');
    const body = openEnvelope<{ connectionRequest?: SignedEnvelope }>(review.store.read(held!.id)!.envelope, key);
    const attached = body.connectionRequest;
    await connectionsCommand([...(attached ? ['approve', attached.payload.taskId.slice(5)] : ['request', '--to', request.requesterOwnerDid]), '--relay', connection.relayUrl, '--role', role,
      ...(flags.has('--key') ? ['--key', flags.get('--key')!] : [])], options);
    store.finishRequestReview(request.id); if (held) review.discard(held.id); return;
  }
  const summary = JSON.stringify({ id: request.id, localOwnerDid: key.did, peerOwnerDid: request.requesterOwnerDid, action,
    effect: action === 'deny' ? 'Block future admission; accepted tasks continue.' : action === 'discard' ? 'Discard held content only.' :
      'Legacy explicit trusted grant for 24 hours; automatic policy may execute tasks. This is separate from connections.' });
  if (!await confirmOwner(summary, options.review)) throw new Error('APPROVAL_REJECTED');
  if (action === 'discard') store.finishRequestReview(request.id, true);
  else store.decide(request.id, action as 'approve' | 'deny', 'trusted');
  if (held) review.discard(held.id);
  if (action === 'deny') review.discardPeer(request.requesterOwnerDid);
  output(JSON.stringify({ id: request.id, decision: action, ...(action === 'approve' ? { trust: 'trusted', legacy: true } : {}) }));
}
