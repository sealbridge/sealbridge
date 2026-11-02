// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSignedAgentCard, digest, generateKeyPair, signPayload, RevocationRegistry, createRevocationNotice } from '../packages/core/src/index.js';
import { connectionIdFor } from '../packages/runtime/src/connection-service.js';
import { admissionFixture } from './connections-fixture.js';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture(...args: Parameters<typeof admissionFixture>) { const f = admissionFixture(...args); cleanups.push(f.cleanup); return f; }
it.each([false, true])('holds unknown tasks on published=%s workers without owner or adapter calls', async published => {
  const f = fixture({ publishToRegistry: published });
  if (published) await f.worker.register();
  const results = await f.attempt();
  expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'PENDING_OWNER_APPROVAL' } });
  expect(f.execute).not.toHaveBeenCalled(); expect(f.approve).not.toHaveBeenCalled(); expect(f.human.approve).not.toHaveBeenCalled();
  expect(f.review.list()).toHaveLength(1); expect(f.review.list()[0].inspectionStatus).toBe('unavailable');
  expect(f.store.list()[0]).not.toHaveProperty('title'); expect(f.store.connectionState(f.requester.did)).toBe('pending');
});
it.each(['llm','non-llm'] as const)('requires inspection and owner opening for connected %s tasks', async adapterKind => {
  const f = fixture({ adapterKind, automaticApproval: true }, true);
  await f.worker.register();
  const results = await f.attempt(f.worker.invite());
  expect(results[0]).toMatchObject({ status: 'fulfilled', value: { state: 'SETTLED' } });
  expect(f.store.connectionLevel(f.requester.did)).toBe('limited');
  expect(f.human.approve).toHaveBeenCalledOnce(); expect(f.approve).toHaveBeenCalledOnce();
  expect(f.review.list()).toEqual([]);
});
it('keeps connected input held when inspection is unavailable and emits no plaintext inbox record', async () => {
  const f = fixture(); const inbox = join(f.root, 'inbox.jsonl'); f.worker.options.inboxPath = inbox;
  expect((await f.attempt(f.worker.invite()))[0]).toMatchObject({ status: 'rejected', reason: { code: 'PENDING_OWNER_APPROVAL' } });
  expect(f.store.connectionState(f.requester.did)).toBe('connected');
  expect(f.execute).not.toHaveBeenCalled(); expect(f.human.approve).not.toHaveBeenCalled(); expect(existsSync(inbox)).toBe(false);
});
it.each([false, true])('keeps 0.1.0 tasks held even from a connected peer with token=%s', async withToken => {
  const f = fixture({}, true);
  const token = f.worker.invite();
  await f.attempt(token);
  await expect(f.raw(f.manifest('0.1.0'), withToken ? token : undefined)).rejects.toThrow('PENDING_OWNER_APPROVAL');
  expect(f.execute).toHaveBeenCalledOnce();
});
it('silently excludes blocked peers before holding content', async () => {
  const f = fixture(); f.store.block(f.requester.did);
  await expect(f.raw()).rejects.toThrow('REQUEST_DENIED');
  expect(f.review.list()).toEqual([]); expect(f.store.list()).toEqual([]); expect(f.relay.snapshot().queues).toEqual([]);
});
it.each(['budget','scope','capability'] as const)('checks %s before hold or invite redemption', async kind => {
  const f = fixture({ maxInputTokens: 100 }); const m = f.manifest();
  if (kind === 'budget') m.budget.maxInputTokens = 101;
  else { m.budget.maxInputTokens = 100; if (kind === 'scope') m.task.skillId = 'missing'; else m.permissions.maxDelegationDepth = -1; }
  await expect(f.raw(m, f.worker.invite())).rejects.toThrow();
  expect(f.review.list()).toEqual([]); expect(f.store.connectionState(f.requester.did)).toBe('none');
});
it('binds a first-use invite to one owner and retains binding after disconnect', async () => {
  const f = fixture(), token = f.worker.invite();
  await expect(f.raw(f.manifest(), token)).rejects.toThrow('PENDING_OWNER_APPROVAL');
  f.store.disconnect(f.requester.did);
  await expect(f.raw(f.manifest(), token)).rejects.toThrow('PENDING_OWNER_APPROVAL');
  expect(f.store.connectionState(f.requester.did)).toBe('pending');
  const other = generateKeyPair();
  expect(connectionIdFor(f.owner.did, other.did)).toBe(connectionIdFor(other.did, f.owner.did));
});
it('connection state survives invitation retirement and has no expiry', async () => {
  let now = Date.now(); const f = fixture({ now: () => now });
  await expect(f.raw(f.manifest(), f.worker.invite())).rejects.toThrow('PENDING_OWNER_APPROVAL');
  now += 365 * 86400000;
  expect(f.store.connectionState(f.requester.did)).toBe('connected');
  expect(f.store.connectionLevel(f.requester.did)).toBe('limited');
});
it.each(['expiry', 'revocation'] as const)('retains live connection admission after invitation %s', async retirement => {
  let now = Date.now(); const revocation = new RevocationRegistry();
  const f = fixture({ now: () => now, revocation }), token = f.worker.invite(1);
  await expect(f.raw(f.manifest(), token)).rejects.toThrow('PENDING_OWNER_APPROVAL');
  const connection = f.store.listConnections()[0];
  if (retirement === 'expiry') now += 2000;
  else revocation.revoke(createRevocationNotice({ targetType: 'invite', targetId: token, reason: 'owner decision' }, f.owner));
  await expect(f.raw(f.manifest(), token)).rejects.toThrow(retirement === 'expiry' ? 'INVITE_EXPIRED' : 'TOKEN_REVOKED');
  expect(f.store.listConnections()[0]).toEqual(connection);
  await expect(f.raw()).rejects.toThrow('PENDING_OWNER_APPROVAL');
  expect(f.store.connectionState(f.requester.did)).toBe('connected');
  expect(f.store.connectionLevel(f.requester.did)).toBe('limited');
  expect(f.human.approve).not.toHaveBeenCalled();
});
it('keeps original legacy card fields signed and gives them no admission authority', () => {
  const owner = generateKeyPair();
  const card = createSignedAgentCard({ agentDid: owner.did, relayEndpoint: 'https://relay.example', name: 'Legacy', skills: [] }, owner);
  const legacy = signPayload({ ...card.payload, accessMode: 'open', openPolicy: { obsolete: 1 } }, owner);
  expect(digest(legacy)).not.toBe(digest(card));
});
it.each([false,true])('attaches connection consent only after a separate owner decision (%s)', async consent => {
  const f=fixture({},true);await f.worker.register();
  const {WorkerTrustStore,workerIntakePath}=await import('../packages/runtime/src/index.js');
  const {openEnvelope}=await import('../packages/core/src/index.js');
  let asked=0;f.client.options.identityOptions=f.identityOptions;
  f.client.options.connectionReview={kind:'human',review:async context=>{asked++;expect(context.localOwnerDid).toBe(f.requester.did);return consent;}};
  const sent: any[]=[];const send=f.relay.send.bind(f.relay);
  f.relay.send=envelope=>{if(envelope.payload.eventType==='PROPOSE')sent.push(openEnvelope(envelope,f.owner));return send(envelope);};
  const result=await f.attempt(f.worker.invite());
  expect(result[0]).toMatchObject({status:'fulfilled',value:{state:'SETTLED'}});
  expect(asked).toBe(1);expect(Boolean(sent[0].connectionRequest)).toBe(consent);
  const local=new WorkerTrustStore(f.requester,{path:workerIntakePath(f.requester.did,f.identityOptions)});
  expect(local.connectionState(f.owner.did)).toBe(consent?'connected':'none');
});
it('binds one owner when two identities concurrently use the same invitation',async()=>{
  const f=fixture();const token=f.worker.invite();
  const {RequesterClient,PolicyAutoApprovalProvider}=await import('../packages/runtime/src/index.js');
  const {readFileSync}=await import('node:fs');const {workerIntakePath}=await import('../packages/runtime/src/index.js');
  const other=generateKeyPair(),second=new RequesterClient({owner:other,relay:f.relay,timeoutMs:2000,approvalProvider:new PolicyAutoApprovalProvider(other)});
  const running=f.worker.start();
  const results=await Promise.allSettled([f.client.delegate({...f.task,to:token}),second.delegate({...f.task,to:token})]);
  f.worker.stop();await running;
  for(const result of results)expect(result).toMatchObject({status:'rejected',reason:{code:'PENDING_OWNER_APPROVAL'}});
  expect(f.store.listConnections().filter(c=>c.state==='connected')).toHaveLength(1);
  expect(f.store.listConnections().filter(c=>c.state==='pending')).toHaveLength(1);
  expect(JSON.parse(readFileSync(workerIntakePath(f.owner.did,f.identityOptions),'utf8')).payload.inviteBindings).toHaveLength(1);
});
it('leaves invitation authority unchanged when ciphertext publication fails',async()=>{
  const f=fixture();const {vi}=await import('vitest');
  vi.spyOn(f.review,'hold').mockImplementation(()=>{throw new Error('QUARANTINE_UNWRITABLE');});
  await expect(f.raw(f.manifest(),f.worker.invite())).rejects.toThrow('QUARANTINE_UNWRITABLE');
  expect(f.store.connectionState(f.requester.did)).toBe('none');expect(f.execute).not.toHaveBeenCalled();
});
it('rejects a mismatched attached consent before invitation binding and preserves its exact error code',async()=>{
  const f=fixture();const m=f.manifest(),token=f.worker.invite();
  const {signConnectionRequest,signEnvelope,openEnvelope}=await import('../packages/core/src/index.js');
  const {sealConnectionFrame}=await import('../packages/runtime/src/connection-transport.js');
  const card=createSignedAgentCard({name:'Requester',agentDid:f.requester.did,relayEndpoint:'https://relay.example',skills:[],protocolVersions:['0.2.0']},f.requester);
  const request=signConnectionRequest({type:'ConnectionRequest',v:1,protocolVersion:'0.2.0',requestId:'attached',fromOwnerDid:f.requester.did,toOwnerDid:f.owner.did,agentCard:card,message:'',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),originProposalDigest:digest('different proposal')},f.requester);
  const connectionRequest=sealConnectionFrame({requestId:'attached',event:request},f.requester,Date.now());
  f.relay.send(signEnvelope({taskId:m.taskId,recipientDid:f.owner.did,seq:0,eventType:'PROPOSE',payload:{proposal:signPayload(m,f.requester),input:f.task.input,capabilityChains:[],inviteToken:token,connectionRequest} as never},f.requester,{encrypt:true}));
  await expect(f.worker.runOnce()).rejects.toThrow('INVALID_CONNECTION_REQUEST');
  expect(f.store.connectionState(f.requester.did)).toBe('none');expect(f.review.list()).toEqual([]);
  expect(openEnvelope(f.relay.receive(f.requester.did)!,f.requester)).toMatchObject({code:'INVALID_CONNECTION_REQUEST'});
});
