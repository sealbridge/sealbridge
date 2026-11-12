// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { digest, openEnvelope, signEnvelope, signPayload } from '../packages/core/src/index.js';
import type { Json, SignedDeliveryStatus } from '../packages/core/src/index.js';
import { GatewayDeliveryService, RecipientDeliveryCoordinator, HeldRequestReview } from '../packages/runtime/src/index.js';
import { completeInspection } from './connections-fixture.js';
import { statusFixture, statusRelayUrl } from './delivery-status-fixture.js';
const cleanups: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => { vi.restoreAllMocks(); cleanups.splice(0).forEach(f => f()); vi.useRealTimers(); });
function fixture(inspect = true) { const f = statusFixture(inspect); cleanups.push(f.cleanup); return f; }
function states(f: ReturnType<typeof fixture>, id: string) { return f.incoming.store.read('observations', id)?.published.map(p => p.status.payload.state); }
it('records hold, human opening, real adapter handoff and verified reply without treating successful cleanup as closed', async () => {
  const f = fixture();
  f.human.approve.mockImplementationOnce(async request => {
    const r = f.incoming.store.snapshot('observations')[0];
    expect(r.facts.map(f => f.state)).toEqual(['received_held']); expect(f.review.list()[0].state).toBe('reviewable');
    return new (await import('../packages/runtime/src/approval-providers.js')).PolicyAutoApprovalProvider(f.recipient).approve(request);
  });
  f.execute.mockImplementationOnce(async ctx => {
    const r = f.incoming.store.snapshot('observations')[0];
    expect(r.facts.map(f => f.state)).toEqual(['received_held', 'opened', 'handed_to_agent']); return ctx.input;
  });
  expect((await f.attempt())[0]).toMatchObject({ status: 'fulfilled', value: { state: 'SETTLED' } });
  const record = f.incoming.store.snapshot('observations')[0];
  expect(record.disclosure).toBe('connected'); expect(states(f, record.messageId)).toEqual(['received_held', 'opened', 'handed_to_agent']);
  expect(f.review.list()).toEqual([]); expect(f.execute).toHaveBeenCalledOnce(); expect(f.human.approve).toHaveBeenCalledOnce();
  expect(f.outgoing.store.getMessage(record.messageId)).toMatchObject({ status: 'replied', replyEnvelopeId: expect.any(String) });
  await f.incoming.drainDue();
  const statusFrames = f.frames.filter(e => e.payload.eventType === 'DELIVERY_STATUS');
  expect(statusFrames.map(e => openEnvelope<SignedDeliveryStatus>(e, f.sender).payload.state)).toEqual(['received_held', 'opened', 'handed_to_agent']);
  const bundle = (await Promise.resolve(f.worker.lastResult))?.bundle;
  expect(bundle?.entries.some(e => e.body.eventType === 'DELIVERY_STATUS')).toBe(false);
});
it.each(['none', 'pending', 'former-open'] as const)('pins coarse disclosure for an initially %s task and does not release suppressed history on connection', async initial => {
  const f = fixture(), p = f.proposal();
  let connection: 'none' | 'pending' | 'connected' = initial === 'pending' ? 'pending' : 'none';
  f.incoming.recipientStatus = new RecipientDeliveryCoordinator(f.incoming, { relayUrl: statusRelayUrl, connectionState: () => connection });
  f.incoming.recipientStatus.admit(p.envelope, p.manifest, false, true);
  f.incoming.recipientStatus.observe(p.messageId, 'opened'); f.incoming.recipientStatus.observe(p.messageId, 'handed_to_agent');
  connection = 'connected'; f.incoming.recipientStatus.reconcile();
  f.incoming.recipientStatus.observe(p.messageId, 'closed');
  expect(states(f, p.messageId)).toEqual(['received_held', 'closed']);
  expect(f.incoming.store.read('observations', p.messageId)?.published.map(p => p.revision)).toEqual([1, 2]);
  await f.incoming.drainDue();
  const json = JSON.stringify(f.frames.filter(e => e.payload.eventType === 'DELIVERY_STATUS').map(e => openEnvelope(e, f.sender)));
  for (const excluded of ['opened','handed_to_agent','fixture content','inspection','report','reason','trusted']) expect(json).not.toContain(excluded);
});
it('holds an unknown 0.2.0 task and emits only coarse transitions with no owner or adapter calls', async () => {
  const f = fixture(); await f.worker.register(); expect((await f.attempt(false, '0.2.0'))[0]).toMatchObject({ status: 'rejected', reason: { code: 'PENDING_OWNER_APPROVAL' } });
  const r = f.incoming.store.snapshot('observations')[0]; expect(states(f,r.messageId)).toEqual(['received_held']);
  const held = f.review.list()[0]; f.review.showReviewedContent(held.id);
  expect(states(f,r.messageId)).toEqual(['received_held']); f.review.discard(held.id);
  expect(states(f,r.messageId)).toEqual(['received_held','closed']); expect(f.execute).not.toHaveBeenCalled(); expect(f.human.approve).not.toHaveBeenCalled();
});
it('keeps unavailable inspection held even when a first-use invitation establishes a connection', async () => {
  const f = fixture(false); expect((await f.attempt())[0]).toMatchObject({ status: 'rejected', reason: { code: 'PENDING_OWNER_APPROVAL' } });
  const r = f.incoming.store.snapshot('observations')[0]; expect(r.disclosure).toBe('connected'); expect(states(f,r.messageId)).toEqual(['received_held']);
  expect(f.execute).not.toHaveBeenCalled(); expect(f.human.approve).not.toHaveBeenCalled();
});
it.each(['disconnect', 'block'] as const)('suppresses queued detail after %s and never replays it after reconnection', async change => {
  const f = fixture(), p = f.proposal(); let connection: 'connected' | 'none' | 'blocked' = 'connected';
  f.incoming.recipientStatus = new RecipientDeliveryCoordinator(f.incoming, { relayUrl: statusRelayUrl, connectionState: () => connection });
  f.incoming.recipientStatus.admit(p.envelope, p.manifest, true, true); f.incoming.recipientStatus.observe(p.messageId, 'opened');
  connection = change === 'block' ? 'blocked' : 'none'; await f.incoming.drainDue();
  const frames = f.frames.filter(e => e.payload.eventType === 'DELIVERY_STATUS');
  expect(frames.map(e => openEnvelope<SignedDeliveryStatus>(e, f.sender).payload.state)).toEqual(change === 'block' ? [] : ['received_held']);
  connection = 'connected'; f.incoming.recipientStatus.reconcile(); await f.incoming.drainDue();
  expect(f.frames.filter(e => e.payload.eventType === 'DELIVERY_STATUS')).toEqual(frames);
});
it('checks the current connection again after asynchronous transport resolution', async () => {
  const f = fixture(), p = f.proposal(); let state: 'connected' | 'blocked' = 'connected';
  f.incoming.recipientStatus = new RecipientDeliveryCoordinator(f.incoming, { relayUrl: statusRelayUrl, connectionState: () => state });
  f.incoming.recipientStatus.admit(p.envelope,p.manifest,true,true);
  f.incoming.options.resolveTransport = async () => { state = 'blocked'; return f.transport; };
  await f.incoming.drainDue(); expect(f.frames).toEqual([]);
});
it.each(['absent', '0.1.0'] as const)('preserves old-peer admission for %s declarations without new frames', async mode => {
  const f = fixture(); const results = await f.attempt(false, mode === '0.1.0' ? '0.1.0' : undefined);
  expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'PENDING_OWNER_APPROVAL' } });
  expect(f.review.list()).toHaveLength(1); expect(f.incoming.store.snapshot('observations')).toEqual([]);
  await f.incoming.drainDue(); expect(f.frames.some(e => e.payload.eventType === 'DELIVERY_STATUS')).toBe(false);
});
it.each(['expire', 'discard', 'discardPeer', 'clear', 'internal-prune'] as const)('commits closed before ciphertext removal through %s', async operation => {
  const f = fixture(false); await f.attempt(); const held = f.review.list()[0], r = f.incoming.store.snapshot('observations')[0];
  if (operation === 'expire' || operation === 'internal-prune') f.setNow(held.expiresAt);
  if (operation === 'expire') f.review.expire();
  if (operation === 'discard') f.review.discard(held.id);
  if (operation === 'discardPeer') f.review.discardPeer(f.sender.did);
  if (operation === 'clear') f.review.store.clear();
  if (operation === 'internal-prune') { const p = f.proposal(); f.review.hold({ kind: 'task', taskId:p.manifest.taskId, senderOwnerDid:f.sender.did,
    contentDigest:digest({manifest:p.manifest,input:{text:'fixture content'}}),deadline:Date.parse(p.manifest.deadline),envelope:p.envelope }); }
  expect(states(f,r.messageId)).toEqual(['received_held','closed']); expect(f.review.store.read(held.id)).toBeUndefined();
  expect(f.incoming.store.snapshot('outbox').find(o => o.ordinal === 2)?.deliveryDeadline).toBe(Math.min(f.now()+86400_000,r.retainUntil));
});
it('preserves held ciphertext when a terminal intent cannot be published', async () => {
  const f = fixture(false); await f.attempt(); const held=f.review.list()[0];
  const write = f.incoming.store.write.bind(f.incoming.store);
  vi.spyOn(f.incoming.store,'write').mockImplementation((kind,id,value) => { if(kind==='outbox') throw new Error('OUTBOX_STORE_UNWRITABLE'); write(kind,id,value as never); });
  expect(()=>f.review.discard(held.id)).toThrow('QUARANTINE_UNWRITABLE'); expect(f.review.store.read(held.id)).toBeDefined();
});
it('reconciles missed held publication after restart and retains terminal facts after quarantine deletion', async () => {
  const f=fixture(),p=f.proposal();
  const local=new HeldRequestReview(f.recipient,{...f.identityOptions,now:f.now,provider:completeInspection});
  const held=local.hold({kind:'task',taskId:p.manifest.taskId,senderOwnerDid:f.sender.did,contentDigest:digest({manifest:p.manifest,input:{text:'fixture content'}}),
    deadline:Date.parse(p.manifest.deadline),envelope:p.envelope});
  const restarted=new GatewayDeliveryService(f.recipient,{identityOptions:f.identityOptions,now:f.now,resolveTransport:()=>f.transport});
  cleanups.push(()=>restarted.stop()); restarted.recipientStatus=new RecipientDeliveryCoordinator(restarted,{relayUrl:statusRelayUrl});
  local.store.setTransitionSink(restarted.recipientStatus.transition); restarted.recipientStatus.reconcile(local.store.records());
  expect(restarted.store.read('observations',p.messageId)?.published).toHaveLength(1);
  local.discard(held.id); expect(local.list()).toEqual([]); await restarted.start();
  expect(restarted.store.read('observations',p.messageId)?.published.map(p=>p.status.payload.state)).toEqual(['received_held','closed']);
});
it('records replied before final owner verification and preserves it when that verification is rejected', async () => {
  const f=fixture();
  const approval = f.client.approvalProvider.approve.bind(f.client.approvalProvider);
  vi.spyOn(f.client.approvalProvider,'approve').mockImplementation(async request => {
    if(request.gate==='final_verification') {
      expect(f.outgoing.store.snapshot('messages')[0].status).toBe('replied');
      const approved=await approval(request);
      return signPayload({...approved.payload,decision:'REJECTED'},f.sender);
    }
    return approval(request);
  });
  const result=await f.attempt(); expect(result[0].status).toBe('rejected');
  expect(f.outgoing.store.snapshot('messages')[0].status).toBe('replied');
});
it('keeps blocked proposals silent before quarantine or recipient observation', async () => {
  const f=fixture();f.store.block(f.sender.did);const p=f.proposal();
  f.relay.send(p.envelope);await expect(f.worker.runOnce()).rejects.toThrow('TASK_INTERRUPTED');
  expect(f.review.list()).toEqual([]);expect(f.incoming.store.snapshot('observations')).toEqual([]);
  expect(f.frames).toEqual([]);expect(f.execute).not.toHaveBeenCalled();
});
it('does not synthesize held or opened facts for an explicit legacy trusted path', async () => {
  const f=fixture();f.worker.options.checkPeer=()=> 'trusted';Object.assign(f.worker.autoAccept,{from:'anyone',work:'write'});
  expect((await f.attempt())[0]).toMatchObject({status:'fulfilled',value:{state:'SETTLED'}});
  const r=f.incoming.store.snapshot('observations')[0];expect(r.facts.map(f=>f.state)).toEqual(['handed_to_agent']);
  expect(f.review.list()).toEqual([]);expect(f.human.approve).not.toHaveBeenCalled();
});
it('never publishes an internal detail suppressed at its original transition after reconnection', () => {
  const f=fixture(),p=f.proposal();let connection:'connected'|'none'='connected';
  f.incoming.recipientStatus=new RecipientDeliveryCoordinator(f.incoming,{relayUrl:statusRelayUrl,connectionState:()=>connection});
  f.incoming.recipientStatus.admit(p.envelope,p.manifest,true,true);
  connection='none';f.incoming.recipientStatus.observe(p.messageId,'opened');
  connection='connected';f.incoming.recipientStatus.observe(p.messageId,'opened');f.incoming.recipientStatus.reconcile();
  expect(states(f,p.messageId)).toEqual(['received_held']);
  f.incoming.recipientStatus.observe(p.messageId,'handed_to_agent');
  expect(states(f,p.messageId)).toEqual(['received_held','handed_to_agent']);
  expect(f.incoming.store.read('observations',p.messageId)?.published.map(p=>p.revision)).toEqual([1,2]);
});
it('does not open a task after an inspection error', async () => {
  const f=fixture();vi.spyOn(f.review,'inspect').mockImplementation(async id=>{
    const record=f.review.store.read(id)!;
    return f.review.store.recordInspection(id,signPayload({type:'HeldContentInspection',v:1,recordId:id,ownerDid:f.recipient.did,
      kind:'task',contentDigest:record.contentDigest,envelopeDigest:record.envelopeDigest,status:'error',inspectedAt:f.now()},f.recipient));
  });
  expect((await f.attempt())[0]).toMatchObject({status:'rejected',reason:{code:'PENDING_OWNER_APPROVAL'}});
  const r=f.incoming.store.snapshot('observations')[0];expect(states(f,r.messageId)).toEqual(['received_held']);
  expect(f.execute).not.toHaveBeenCalled();expect(f.human.approve).not.toHaveBeenCalled();
});
it('keeps immutable admission and published status facts in the local record', () => {
  const f=fixture(),p=f.proposal();
  f.incoming.recipientStatus=new RecipientDeliveryCoordinator(f.incoming,{relayUrl:statusRelayUrl,connectionState:()=> 'none'});
  f.incoming.recipientStatus.admit(p.envelope,p.manifest,false,true);
  const record=f.incoming.store.read('observations',p.messageId)!;
  expect(()=>f.incoming.store.transaction(()=>f.incoming.store.write('observations',p.messageId,{...record,disclosure:'connected'}))).toThrow();
  expect(()=>f.incoming.store.transaction(()=>f.incoming.store.write('observations',p.messageId,{...record,published:[],nextRevision:1}))).toThrow();
  expect(f.incoming.store.read('observations',p.messageId)).toEqual(record);
});
it.each(['limited','trusted'] as const)('%s approval closes the original held task without opening it', async trust => {
  const f=fixture();await f.worker.register();await f.attempt(false,'0.2.0');const held=f.review.list()[0];
  const {requestsCommand}=await import('../cli/src/requests.js');
  const {writeFileSync}=await import('node:fs');const {join}=await import('node:path');
  const key=join(f.root,'owner.private.json');writeFileSync(key,JSON.stringify(f.recipient),{mode:0o600});
  await requestsCommand(['approve',f.store.list()[0].id,...(trust==='trusted'?['--trust','trusted']:[]),'--key',key],
    {identityOptions:f.identityOptions,inspectionProvider:completeInspection,transportFactory:()=>f.transport,review:async()=>true,output:()=>{}});
  const r=f.incoming.store.snapshot('observations')[0];
  expect(states(f,r.messageId)).toEqual(['received_held','closed']);expect(f.review.store.read(held.id)).toBeUndefined();
  expect(f.execute).not.toHaveBeenCalled();expect(f.human.approve).not.toHaveBeenCalled();
});
it('keeps former open metadata and old finite grants coarse on the live admission path', async () => {
  const f=fixture();
  const {createSignedAgentCard}=await import('../packages/core/src/index.js');
  const {workerIntakePath}=await import('../packages/runtime/src/index.js');
  const {mkdirSync,writeFileSync}=await import('node:fs');const {dirname}=await import('node:path');
  const path=workerIntakePath(f.recipient.did,f.identityOptions);mkdirSync(dirname(path),{recursive:true,mode:0o700});
  writeFileSync(path,JSON.stringify(signPayload({version:1,workerOwnerDid:f.recipient.did,requests:[],
    grants:[{did:f.sender.did,trust:'trusted',expiresAt:f.now()+86400_000}],denials:[]},f.recipient)),{mode:0o600});
  const card=createSignedAgentCard({name:'Peer',agentDid:f.sender.did,relayEndpoint:statusRelayUrl,skills:[],protocolVersions:['0.2.0']},f.sender);
  f.relay.register(signPayload({...card.payload,accessMode:'open',openPolicy:{retired:true}},f.sender));
  await f.worker.register();expect((await f.attempt(false,'0.2.0'))[0]).toMatchObject({status:'rejected',reason:{code:'PENDING_OWNER_APPROVAL'}});
  const r=f.incoming.store.snapshot('observations')[0];expect(r.disclosure).toBe('coarse');expect(states(f,r.messageId)).toEqual(['received_held']);
  f.review.discard(f.review.list()[0].id);expect(states(f,r.messageId)).toEqual(['received_held','closed']);
  expect(f.execute).not.toHaveBeenCalled();expect(f.human.approve).not.toHaveBeenCalled();
});
