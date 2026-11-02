// SPDX-License-Identifier: Apache-2.0
import { createInterface } from 'node:readline/promises';
import { createSignedAgentCard } from '@acp/core';
import type { KeyPair } from '@acp/core';
import { HttpRelayClient } from '@acp/relay';
import type { RelayTransport } from '@acp/relay';
import { ConnectionRouter, HeldRequestReview, InviteStore, LiveProtocol, WorkerTrustStore,
  workerIntakePath, inspectStoredIdentity, resolveStoredIdentity, syncConnections } from '@acp/runtime';
import type { ConnectionHumanReviewProvider, HeldContentReviewProvider, IdentityStoreOptions } from '@acp/runtime';

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
  identityOptions?: IdentityStoreOptions; review?: (summary: string) => Promise<boolean>;
  inspectionProvider?: HeldContentReviewProvider; now?: () => number;
  transportFactory?: (url: string, owner: KeyPair) => RelayTransport;
  output?: (value: string) => void;
}
const USAGE = 'Usage: sealbridge connections list | request --to DID --relay URL [--message TEXT] | approve ID | reject ID | withdraw ID | disconnect DID | block DID | unblock DID | confirm-invite workerRef | prior-approved | connect-prior DID --relay URL | sync [--once] [--role worker|requester] [--key FILE]. Human confirmation is required for decisions. Inspection is unavailable by default. / 接続の判断には所有者の確認が必要です。既定の検査は利用不可です。';
export async function connectionsCommand(args: string[], options: ConnectionsCommandOptions = {}): Promise<void> {
  const output = options.output ?? console.log;
  if (args.includes('--help')) { output(USAGE); return; }
  const [action, ...rest] = args, ids: string[] = [], flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!flag.startsWith('--')) { ids.push(flag); continue; }
    if (flag === '--once' || flag === '--allow-private-relay') { flags.set(flag, 'true'); continue; }
    if (!['--role', '--key', '--relay', '--to', '--message'].includes(flag) || flags.has(flag) || !rest[i + 1] || rest[i + 1].startsWith('--'))
      throw new Error('INVALID_CONNECTION_OPTION');
    flags.set(flag, rest[++i]);
  }
  const readOnly = ['list', 'prior-approved'].includes(action);
  if (!['list','prior-approved','request','approve','reject','withdraw','disconnect','block','unblock','confirm-invite','connect-prior','sync'].includes(action) ||
      ids.length !== (['list','prior-approved','request','sync'].includes(action) ? 0 : 1)) throw new Error(USAGE);
  const role = flags.get('--role') ?? (action === 'confirm-invite' ? 'requester' : 'worker');
  if (role !== 'worker' && role !== 'requester') throw new Error('INVALID_IDENTITY_ROLE');
  const identityOptions = { ...options.identityOptions, explicitKeyPath: flags.get('--key') };
  const key = readOnly ? (await inspectStoredIdentity(role, identityOptions)).key : await resolveStoredIdentity(role, identityOptions);
  if (!key) { output(JSON.stringify({ connections: [], priorApprovedPeers: [] })); return; }
  const store = new WorkerTrustStore(key, { path: workerIntakePath(key.did, identityOptions),
    fs: identityOptions.fs, platform: identityOptions.platform, now: options.now });
  const review = new HeldRequestReview(key, { ...identityOptions, provider: options.inspectionProvider, now: options.now });
  if (action === 'list') { output(JSON.stringify({ localOwnerDid: key.did, role, connections: store.listConnections() })); return; }
  if (action === 'prior-approved') { output(JSON.stringify({ localOwnerDid: key.did, role, priorApprovedPeers: store.listPriorApprovedPeers() })); return; }
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
    const saved = (await InviteStore.open(key, { ...identityOptions, relayPolicy: { allowPrivateRelay: flags.has('--allow-private-relay') } })).resolve(ids[0]);
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
