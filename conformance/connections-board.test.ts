// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSignedAgentCard, generateKeyPair, signPayload, parseAndVerifyInviteToken } from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { WorkerNode, RequesterClient, PolicyAutoApprovalProvider, WorkerTrustStore, HeldRequestReview,
  workerIntakePath, connectionIdFor, buildTaskManifest } from '../packages/runtime/src/index.js';
import { completeInspection } from './connections-fixture.js';
import { createPost, claimPost, consumeLease, boardCandidates, boardHost } from '../cli/src/board.js';
const roots: string[] = [];
afterEach(() => {for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});});
function fixture() {
  const root = mkdtempSync(join(tmpdir(),'connections-board-'));roots.push(root);
  const owner = generateKeyPair(), peer = generateKeyPair(), relay = 'https://relay.example';
  const card = createSignedAgentCard({name:'Peer',agentDid:peer.did,relayEndpoint:relay,skills:[{id:'echo',name:'Echo',taskTypes:['json']}]},peer);
  const input = {content:'private input'},post = createPost(owner,{relay,what:'JSON task',skillId:'echo',taskType:'json',budget:{maxInputTokens:10,maxOutputTokens:10,maxToolInvocations:1,maxWallClockSeconds:10},deadline:new Date(Date.now()+600000).toISOString()},input);
  return {root,path:join(root,'lease.json'),owner,peer,card,post,input};
}
it('requires a local connection before creating a claim lease', () => {
  const f = fixture();
  expect(boardCandidates(f.post,[f.card])[0].reasons).toContain('CONNECTION_REQUIRED');
  expect(() => claimPost(f.path,f.owner,f.post,f.card,f.peer.did,'claim')).toThrow('CONNECTION_REQUIRED');
  expect(existsSync(f.path)).toBe(false);
});
it.each(['human', 'policy'] as const)('applies owner opening to an inspected connected board claim with a shared %s provider', async kind => {
  const f = fixture(), relay = new InMemoryRelay();
  const identityOptions = { env: { SEALBRIDGE_DATA_DIR: f.root } };
  const store = new WorkerTrustStore(f.owner, { path: workerIntakePath(f.owner.did, identityOptions) });
  const policy = new PolicyAutoApprovalProvider(f.owner);
  const human = { kind, approve: vi.fn(policy.approve.bind(policy)) };
  const connected = (did: string) => store.connectionState(did) === 'connected';
  const host = boardHost(f.post, f.owner, f.path, human, connected);
  const worker = new WorkerNode({ owner: f.owner, relay, relayUrl: f.card.payload.relayEndpoint,
    ...host, ownerApprovalProvider: host.approvalProvider, intakeStore: store, requireConnection: true,
    heldReview: new HeldRequestReview(f.owner, { ...identityOptions, provider: completeInspection }), timeoutMs: 2000 });
  store.redeemTaskInvite(parseAndVerifyInviteToken(worker.invite()),
    { peerOwnerDid: f.peer.did, relayUrl: f.card.payload.relayEndpoint }, connectionIdFor(f.owner.did, f.peer.did));
  await worker.register();
  const client = new RequesterClient({ owner: f.peer, relay, timeoutMs: 2000,
    approvalProvider: new PolicyAutoApprovalProvider(f.peer) });
  try {
    const results = await Promise.allSettled([client.delegate({ to: f.owner.did, title: 'Claim',
      description: JSON.stringify({ postId: f.post.payload.id, card: f.card }), input: { postId: f.post.payload.id } }),
      worker.start({ once: true })]);
    if (kind === 'human') {
      expect(results[0]).toMatchObject({ status: 'fulfilled', value: { state: 'SETTLED', deliverable: { payload: { accepted: true } } } });
      expect(human.approve.mock.calls.some(([request]) => request.gate === 'contract_acceptance')).toBe(true);
      expect(JSON.parse(readFileSync(f.path, 'utf8')).payload).toMatchObject({ accepted: true, consumed: false });
    } else {
      expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'APPROVAL_CHANNEL_UNAVAILABLE' } });
      expect(human.approve).not.toHaveBeenCalled();
      expect(existsSync(f.path)).toBe(false);
    }
  } finally { worker.stop(); }
});
it('requires task approval after a connected claim and rechecks the connection before consumption', () => {
  const f = fixture();let connected = true;
  const lease = claimPost(f.path,f.owner,f.post,f.card,f.peer.did,'claim',Date.now(),()=>connected);
  expect(() => consumeLease(f.path,f.owner,f.post,f.input,Date.now(),()=>connected)).toThrow('CLAIM_LOST');
  writeFileSync(f.path,JSON.stringify(signPayload({...lease,accepted:true},f.owner)));
  connected = false;
  expect(() => consumeLease(f.path,f.owner,f.post,f.input,Date.now(),()=>connected)).toThrow('CONNECTION_REQUIRED');
  expect(JSON.parse(readFileSync(f.path,'utf8')).payload.consumed).toBe(false);
  connected = true;
  expect(consumeLease(f.path,f.owner,f.post,f.input,Date.now(),()=>connected).consumed).toBe(true);
  expect(() => consumeLease(f.path,f.owner,f.post,f.input,Date.now(),()=>connected)).toThrow('CLAIM_LOST');
});
it('rejects expired cards, altered input, and stale leases without a new lease', () => {
  const f = fixture();
  expect(() => claimPost(f.path,f.owner,f.post,{...f.card,payload:{...f.card.payload,name:'changed'}},f.peer.did,'claim',Date.now(),()=>true)).toThrow('INVALID_BOARD_CLAIM');
  const lease = claimPost(f.path,f.owner,f.post,f.card,f.peer.did,'claim',Date.now(),()=>true);
  writeFileSync(f.path,JSON.stringify(signPayload({...lease,accepted:true},f.owner)));
  expect(() => consumeLease(f.path,f.owner,f.post,{},Date.now(),()=>true)).toThrow('INVALID_BOARD_INPUT');
  expect(() => consumeLease(f.path,f.owner,f.post,f.input,Date.parse(lease.expiresAt),()=>true)).toThrow('CLAIM_LOST');
});
it('leaves a dispatch lease intact when negotiated protocol preflight refuses the task', async () => {
  const f = fixture(), relay = new InMemoryRelay();
  const lease = claimPost(f.path, f.owner, f.post, f.card, f.peer.did, 'claim', Date.now(), () => true);
  writeFileSync(f.path, JSON.stringify(signPayload({ ...lease, accepted: true }, f.owner)));
  const before = readFileSync(f.path);
  relay.register(f.card);
  const send = vi.spyOn(relay, 'send');
  const client = new RequesterClient({ owner: f.owner, relay, approvalProvider: new PolicyAutoApprovalProvider(f.owner) });
  const manifest = buildTaskManifest({ ownerDid: f.owner.did, workerDid: f.peer.did, title: 'Dispatch', description: 'Board input' });
  await expect(client.delegate({ to: f.peer.did, title: 'Dispatch', description: 'Board input', input: f.input, manifest,
    beforeTransmit: () => { consumeLease(f.path, f.owner, f.post, f.input, Date.now(), () => true); },
  })).rejects.toThrow('PROTOCOL_VERSION_UNSUPPORTED');
  expect(readFileSync(f.path)).toEqual(before);
  expect(send).not.toHaveBeenCalled();
});
