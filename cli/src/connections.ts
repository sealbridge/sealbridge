// SPDX-License-Identifier: Apache-2.0
import { attachHeldDeliveryStatus } from '@acp/runtime';
import { createInterface } from 'node:readline/promises';
import { createSignedAgentCard } from '@acp/core';
import type { KeyPair } from '@acp/core';
import { HttpRelayClient } from '@acp/relay';
import type { RelayTransport } from '@acp/relay';
import { ConnectionAdmissionReview, ConnectionRouter, HeldRequestReview, InviteStore, LiveProtocol, WorkerTrustStore,
  workerIntakePath, inspectStoredIdentity, resolveStoredIdentity, syncConnections } from '@acp/runtime';
import type { ConnectionHumanReviewProvider, HeldContentReviewProvider, InviteStoreOptions } from '@acp/runtime';

export async function confirmOwner(summary: string, review?: (summary: string) => Promise<boolean>): Promise<boolean> {
  if (review) return review(summary);
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('APPROVAL_CHANNEL_UNAVAILABLE');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return (await rl.question(summary + '\nConfirm owner decision [y/N]? ')).trim().toLowerCase() === 'y'; }
  finally { rl.close(); }
}
/** This prompt is independent of task approval, including when task auto-approval is enabled. */
export function connectionHumanReview(review?: (summary: string) => Promise<boolean>, role: 'worker' | 'requester' = 'requester'): ConnectionHumanReviewProvider | undefined {
  if (!review && (!process.stdin.isTTY || !process.stderr.isTTY)) return undefined;
  return { kind: 'human', review: context => confirmOwner(JSON.stringify({ reason: context.reason,
    localRole: role, localOwnerDid: context.localOwnerDid, peerOwnerDid: context.peerOwnerDid, requestDigest: context.requestDigest,
    effect: 'Connect these identities with limited consent and no expiry. Each task requires inspection and owner opening.' }), review) };
}
export interface ConnectionsCommandOptions {
  identityOptions?: InviteStoreOptions; review?: (summary: string) => Promise<boolean>;
  inspectionProvider?: HeldContentReviewProvider; now?: () => number;
  transportFactory?: (url: string, owner: KeyPair) => RelayTransport;
  output?: (value: string) => void;
}
const USAGE = 'Usage: sealbridge connections list | status workerRef-or-DID | review list|approve ID|reject ID | request --to DID --relay URL [--message TEXT] | approve ID | reject ID | withdraw ID | disconnect DID | block DID | unblock DID | confirm-invite workerRef | prior-approved | connect-prior DID --relay URL | sync [--once] [--role worker|requester] [--key FILE]. Review uses built-in inspection of signed connection offer metadata only. A plain task creates only a pending task-derived item, not a reviewable connection offer. On CONNECTION_NOT_PENDING, check connections review list with the same role/key and use a listed ID; if empty, use the invitation/connect flow (connections confirm-invite) to exchange a signed offer. Use tasks list/show/approve/reject for individual held-task review and an interactive worker for live task approval. Connection review does not inspect or open tasks. Human confirmation requires an interactive TTY; --auto-accept does not provide inspection or connection consent. / review の組み込み検査は署名付き接続申し込みの情報だけが対象です。通常のタスクが作るのはタスク由来の保留項目だけで、審査可能な接続申し込みではありません。CONNECTION_NOT_PENDING なら同じ役割・鍵で connections review list を確認し、一覧の ID を使ってください。空なら招待・接続フロー（connections confirm-invite）で署名付き申し込みを交換してください。単体 CLI の tasks list/show/approve/reject で個別タスクを確認し、対話式ワーカーで実行を承認します。接続審査だけではタスクを検査・開封しません。所有者の確認には対話式 TTY が必要です。--auto-accept は検査や接続同意を代替しません。';
export async function connectionsCommand(args: string[], options: ConnectionsCommandOptions = {}): Promise<void> {
  const output = options.output ?? console.log;
  if (args.includes('--help') || args.includes('-h')) { output(USAGE); return; }
  const reviewAction = args[0] === 'review';
  const [action, ...rest] = reviewAction ? ['review-' + args[1], ...args.slice(2)] : args;
  if (!reviewAction && action?.startsWith('review-')) throw new Error(USAGE);
  const ids: string[] = [], flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!flag.startsWith('--')) { ids.push(flag); continue; }
    if (flag === '--once' || flag === '--allow-private-relay') { flags.set(flag, 'true'); continue; }
    if (!['--role', '--key', '--relay', '--to', '--message'].includes(flag) || flags.has(flag) || !rest[i + 1] || rest[i + 1].startsWith('--'))
      throw new Error('INVALID_CONNECTION_OPTION');
    flags.set(flag, rest[++i]);
  }
  const readOnly = ['list', 'prior-approved', 'status', 'review-list'].includes(action);
  if (!['list','prior-approved','status','review-list','review-approve','review-reject','request','approve','reject','withdraw','disconnect','block','unblock','confirm-invite','connect-prior','sync'].includes(action) ||
      ids.length !== (['list','prior-approved','review-list','request','sync'].includes(action) ? 0 : 1)) throw new Error(USAGE);
  const role = flags.get('--role') ?? (['confirm-invite', 'status'].includes(action) ? 'requester' : 'worker');
  if (role !== 'worker' && role !== 'requester') throw new Error('INVALID_IDENTITY_ROLE');
  if (action === 'request' && (!flags.has('--to') || !flags.has('--relay'))) throw new Error('RELAY_REQUIRED');
  const identityOptions = { ...options.identityOptions, explicitKeyPath: flags.get('--key') };
  const needsSavedRelay = ['approve', 'connect-prior', 'sync'].includes(action) && !flags.has('--relay');
  const key = readOnly || needsSavedRelay ? (await inspectStoredIdentity(role, identityOptions)).key : await resolveStoredIdentity(role, identityOptions);
  if (!key && needsSavedRelay) throw new Error('RELAY_REQUIRED');
  if (!key) { output(JSON.stringify(action === 'status' ? { role, status: 'none', state: 'none' } : reviewAction ? { requests: [] } : { connections: [], priorApprovedPeers: [] })); return; }
  const store = new WorkerTrustStore(key, { path: workerIntakePath(key.did, identityOptions),
    fs: identityOptions.fs, platform: identityOptions.platform, now: options.now });
  if (action === 'status') {
    const saved = ids[0].startsWith('did:') ? undefined :
      (await InviteStore.open(key, { ...identityOptions, now: options.now })).list()
        .find(i => i.workerRef === ids[0] || i.alias === ids[0]);
    if (!ids[0].startsWith('did:') && !saved) throw new Error('INVITE_NOT_FOUND');
    output(JSON.stringify({ localOwnerDid: key.did, role,
      ...(saved ? { workerRef: saved.workerRef, alias: saved.alias } : {}),
      ...store.connectionStatus(saved?.ownerDid ?? ids[0]) }));
    return;
  }
  const review = new HeldRequestReview(key, { ...identityOptions, provider: options.inspectionProvider, now: options.now });
  const delivery = attachHeldDeliveryStatus(key, review, identityOptions, store, options.now);
  if (action === 'list') { output(JSON.stringify({ localOwnerDid: key.did, role, connections: store.listConnections() })); return; }
  if (action === 'prior-approved') { output(JSON.stringify({ localOwnerDid: key.did, role, priorApprovedPeers: store.listPriorApprovedPeers() })); return; }
  if (reviewAction) {
    // Listing and rejection use no transport. Approval selects the retained offer's relay.
    const controls = store.controlSnapshot().filter(c => c.direction === 'incoming' && c.active);
    const requestId = review.list().find(r => r.kind === 'connection' && r.id === ids[0])?.requestId ?? ids[0];
    const relayUrl = flags.get('--relay') ?? controls.find(c => c.offer.requestId === requestId)?.offer.relayUrl;
    const urls = action === 'review-list' ? [...new Set(controls.map(c => c.offer.relayUrl))] : [relayUrl];
    const queues = urls.filter((url): url is string => url !== undefined).map(url => new ConnectionAdmissionReview({
      owner: key, store, heldOptions: { ...identityOptions, transitionSink: delivery.recipientStatus?.transition }, now: options.now, relayUrl: url,
      agentCard: createSignedAgentCard({ name: 'Sealbridge ' + role, agentDid: key.did, relayEndpoint: url,
        skills: [], protocolVersions: new LiveProtocol({ now: options.now }).receiveVersions(), now: options.now?.() }, key),
      relay: { send: async envelope => {
        const relay: RelayTransport = options.transportFactory?.(url, key) ?? new HttpRelayClient(url, key, { allowPrivateRelay: flags.has('--allow-private-relay') });
        relay.setRecipientKey?.(key); await (relay.withRecipient?.(key) ?? relay).send(envelope);
      }, receive: async () => undefined }, allowPrivateRelay: flags.has('--allow-private-relay'),
    }));
    const requests = queues.flatMap(queue => queue.list());
    if (action === 'review-list') { output(JSON.stringify({ localOwnerDid: key.did, role, requests })); return; }
    const selected = requests.find(r => r.id === ids[0] || r.requestId === ids[0]);
    if (!selected) throw new Error('CONNECTION_NOT_PENDING');
    if (!await confirmOwner(JSON.stringify({ action, role, ...selected, effect: action === 'review-approve'
      ? 'Connect with limited consent. Each task requires inspection and owner opening.'
      : 'Reject the connection request and apply the existing peer cooldown.' }), options.review)) throw new Error('APPROVAL_REJECTED');
    if (action === 'review-approve') output(JSON.stringify(await queues[0].approve(selected.id)));
    else { queues[0].reject(selected.id); output(JSON.stringify({ peerOwnerDid: selected.peerOwnerDid, state: store.connectionState(selected.peerOwnerDid) })); }
    return;
  }
  const connection = store.listConnections().find(c => 'incoming' in c && c.incoming?.requestId === ids[0] || 'outgoing' in c && c.outgoing?.requestId === ids[0]);
  const peer = connection?.peerOwnerDid ?? ids[0];
  if (['reject','withdraw','disconnect','block','unblock'].includes(action)) {
    if (!await confirmOwner(JSON.stringify({ action, role, localOwnerDid: key.did, peerOwnerDid: peer,
      effect: 'Changes future admission; accepted tasks continue.' }), options.review)) throw new Error('APPROVAL_REJECTED');
    if (action === 'reject') store.rejectConnection(peer);
    else if (action === 'withdraw') store.withdrawConnection(peer, ids[0]);
    else store[action as 'disconnect' | 'block' | 'unblock'](peer);
    if (action === 'block' || action === 'reject') review.discardPeer(peer);
    output(JSON.stringify({ peerOwnerDid: peer, state: store.connectionState(peer) })); return;
  }
  let token: string | undefined, to = flags.get('--to') ?? peer, relayUrl = flags.get('--relay') ?? (connection && 'relayUrl' in connection ? connection.relayUrl : undefined);
  if (action === 'confirm-invite') {
    const invites = await InviteStore.open(key, { ...identityOptions, now: options.now,
      relayPolicy: { allowPrivateRelay: flags.has('--allow-private-relay') } });
    invites.retain(ids[0]);
    const saved = invites.resolve(ids[0]);
    token = saved.inviteToken; to = saved.invite.ownerDid; relayUrl = saved.invite.relayUrl;
    const existing = store.listConnections().find(c => c.peerOwnerDid === to);
    if (existing?.state === 'connected' || existing && 'outgoing' in existing && existing.outgoing) {
      output(JSON.stringify({ peerOwnerDid: to, state: existing.state })); return;
    }
  }
  if (action === 'connect-prior' && !store.listPriorApprovedPeers().some(p => p.peerOwnerDid === to)) throw new Error('CONNECTION_NOT_FOUND');
  if (!relayUrl || !to && action !== 'sync') throw new Error('RELAY_REQUIRED');
  const relay: RelayTransport = options.transportFactory?.(relayUrl, key) ?? new HttpRelayClient(relayUrl, key, { allowPrivateRelay: flags.has('--allow-private-relay') });
  relay.setRecipientKey?.(key);
  const router = new ConnectionRouter({ owner: key, relay: relay.withRecipient?.(key) ?? relay, relayUrl, store, review,
    agentCard: createSignedAgentCard({ name: 'Sealbridge ' + role, agentDid: key.did,
      relayEndpoint: relayUrl, skills: [], protocolVersions: new LiveProtocol({ now: options.now }).receiveVersions() }, key),
    humanReview: connectionHumanReview(options.review, role), now: options.now, allowPrivateRelay: flags.has('--allow-private-relay'),
    onConnectionEvent: event => output(JSON.stringify(event)) });
  if (action === 'sync') {
    const controller = new AbortController(), stop = () => controller.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try { await syncConnections(router, { once: flags.has('--once'), signal: controller.signal }); }
    finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    return;
  }
  if (action === 'approve') {
    const held = review.list().find(r => r.kind === 'connection' && (r.requestId === ids[0] || r.id === ids[0]));
    if (!held) throw new Error('INSPECTION_INCOMPLETE');
    output(JSON.stringify(await router.approve(review.store.read(held.id)!.envelope))); return;
  }
  output(JSON.stringify(await router.service.request({ toOwnerDid: to, message: flags.get('--message'), inviteToken: token })));
}
