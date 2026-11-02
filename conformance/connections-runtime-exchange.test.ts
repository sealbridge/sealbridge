// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSignedAgentCard, generateKeyPair, digest } from '../packages/core/src/index.js';
import type { SignedEnvelope } from '../packages/core/src/index.js';
import { ConnectionRouter, HeldRequestReview, WorkerTrustStore, workerIntakePath } from '../packages/runtime/src/index.js';
import { completeInspection } from './connections-fixture.js';
const cleanups: Array<() => void> = [];
afterEach(() => {vi.restoreAllMocks();for (const fn of cleanups.splice(0)) fn();});
function fixture(inspection = true) {
  const root = mkdtempSync(join(tmpdir(),'connections-live-control-'));cleanups.push(()=>rmSync(root,{recursive:true,force:true}));
  const keys = [generateKeyPair(),generateKeyPair()], relayUrl = 'https://relay.example', frames: SignedEnvelope[] = [];
  let now = Date.now(); const clock = () => now;
  const options = keys.map(owner => {
    const identityOptions = {env:{SEALBRIDGE_DATA_DIR:root}};
    return {owner,relayUrl,now:clock,store:new WorkerTrustStore(owner,{path:workerIntakePath(owner.did,identityOptions),now:clock}),
      review:new HeldRequestReview(owner,{...identityOptions,now:clock,provider:inspection?completeInspection:undefined}),
      agentCard:createSignedAgentCard({name:'Peer',agentDid:owner.did,relayEndpoint:relayUrl,skills:[],protocolVersions:['0.2.0']},owner),
      humanReview:{kind:'human' as const,review:vi.fn(async()=>true)},
      relay:{send:vi.fn(async (envelope: SignedEnvelope)=>{frames.push(envelope);}),receive:vi.fn(),acknowledgeDelivery:vi.fn(async()=>{})},
      onConnectionEvent:vi.fn()};
  });
  const routers = options.map(o=>new ConnectionRouter(o));
  const take = (i: number,type: string) => {
    const index = frames.findIndex(f=>f.payload.recipientDid===keys[i].did && f.payload.eventType===type);
    if(index<0) throw new Error('FRAME_NOT_FOUND');return frames.splice(index,1)[0];
  };
  return {root,keys,options,routers,frames,take,advance:(ms:number)=>{now+=ms;}};
}
it('commits late acceptance and ACK after restart without an active task', async () => {
  const f = fixture();
  const requested = await f.routers[0].service.request({toOwnerDid:f.keys[1].did});
  const offer = f.take(1,'CONNECTION_REQUEST'); await f.routers[1].consume(offer);
  expect(f.options[1].store.connectionState(f.keys[0].did)).toBe('pending');
  await f.routers[1].approve(offer);
  expect(f.options[1].store.connectionLevel(f.keys[0].did)).toBe('limited');
  const accepted = f.take(0,'CONNECTION_ACCEPTED');
  const restarted = new ConnectionRouter({...f.options[0],store:new WorkerTrustStore(f.keys[0],{path:workerIntakePath(f.keys[0].did,{env:{SEALBRIDGE_DATA_DIR:f.root}}),now:f.options[0].now})});
  await restarted.consume(accepted);
  expect(restarted.options.store.connectionState(f.keys[1].did)).toBe('connected');
  const ack = f.take(1,'CONNECTION_ACK'); await f.routers[1].consume(ack);
  expect(await f.routers[1].service.flushOutbox()).toBe(true);
  expect(f.options[0].onConnectionEvent).toHaveBeenCalledOnce();
  await restarted.consume(accepted);
  expect(f.take(1,'CONNECTION_ACK').payload.taskId).toBe('conn_'+requested.requestId);
  expect(f.options[0].onConnectionEvent).toHaveBeenCalledOnce();
  expect(readFileSync(workerIntakePath(f.keys[0].did,{env:{SEALBRIDGE_DATA_DIR:f.root}}),'utf8')).not.toContain('acp-invite:');
});
it.each(['withdraw','block'] as const)('does not restore %s consent from a late acceptance',async action=>{
  const f=fixture(),request=await f.routers[0].service.request({toOwnerDid:f.keys[1].did});
  const offer=f.take(1,'CONNECTION_REQUEST');await f.routers[1].consume(offer);await f.routers[1].approve(offer);
  if(action==='withdraw')f.options[0].store.withdrawConnection(f.keys[1].did,request.requestId);else f.options[0].store.block(f.keys[1].did);
  const accepted=f.take(0,'CONNECTION_ACCEPTED');
  if(action==='withdraw')await expect(f.routers[0].consume(accepted)).rejects.toThrow('CONNECTION_NOT_PENDING');
  else await f.routers[0].consume(accepted);
  expect(f.options[0].store.connectionState(f.keys[1].did)).toBe(action==='block'?'blocked':'none');
  expect(f.frames.filter(e=>e.payload.eventType==='CONNECTION_ACK')).toEqual([]);
});
it('keeps a 14-day outgoing offer independently of the 24-hour held content',async()=>{
  const f=fixture(false);await f.routers[0].service.request({toOwnerDid:f.keys[1].did});
  await f.routers[1].consume(f.take(1,'CONNECTION_REQUEST'));
  f.advance(2*86400000);expect(f.options[0].store.connectionState(f.keys[1].did)).toBe('pending');
  expect(f.options[1].review.expire()).toBe(1);
  f.advance(12*86400000);expect(f.options[0].store.connectionState(f.keys[1].did)).toBe('none');
});
it('derives one connection ID for simultaneous mutual requests',async()=>{
  const f=fixture();
  await Promise.all(f.routers.map((r,i)=>r.service.request({toOwnerDid:f.keys[1-i].did})));
  const incoming=f.routers.map((_r,i)=>f.take(i,'CONNECTION_REQUEST'));
  await Promise.all(f.routers.map((r,i)=>r.consume(incoming[i])));
  await Promise.all(f.routers.map((r,i)=>r.approve(incoming[i])));
  const ids=f.options.map(o=>o.store.listConnections().find(c=>'connectionId' in c));
  expect(ids[0]).toHaveProperty('connectionId',(ids[1] as any).connectionId);
  const [smaller, larger] = f.keys.map(key => key.did).sort();
  expect(ids[0]).toHaveProperty('connectionId', 'connection_' + digest([smaller, larger]).slice(7));
});
it('leaves delivery unacknowledged when durable exchange publication fails',async()=>{
  const f=fixture();await f.routers[0].service.request({toOwnerDid:f.keys[1].did});
  const write=vi.spyOn(f.options[1].store,'updateControls').mockImplementation(()=>{throw new Error('INTAKE_STORE_UNWRITABLE');});
  await expect(f.routers[1].consume(f.take(1,'CONNECTION_REQUEST'))).rejects.toThrow('INTAKE_STORE_UNWRITABLE');
  expect(f.options[1].relay.acknowledgeDelivery).not.toHaveBeenCalled();
  expect(f.options[1].store.connectionState(f.keys[0].did)).toBe('none');
  expect(f.options[1].review.list()).toHaveLength(1);write.mockRestore();
});
it('never asks a human to open an uninspected connection request',async()=>{
  const f=fixture(false);await f.routers[0].service.request({toOwnerDid:f.keys[1].did});
  const offer=f.take(1,'CONNECTION_REQUEST');await f.routers[1].consume(offer);
  await expect(f.routers[1].approve(offer)).rejects.toThrow('INSPECTION_INCOMPLETE');
  expect(f.options[1].humanReview.review).not.toHaveBeenCalled();
});
it('syncs a late acceptance behind a queued task without consuming or replaying the task',async()=>{
  const {InMemoryRelay}=await import('../packages/relay/src/index.js');
  const {signEnvelope}=await import('../packages/core/src/index.js');
  const {syncConnections}=await import('../packages/runtime/src/index.js');
  const f=fixture();await f.routers[0].service.request({toOwnerDid:f.keys[1].did});
  const offer=f.take(1,'CONNECTION_REQUEST');await f.routers[1].consume(offer);await f.routers[1].approve(offer);
  const relay=new InMemoryRelay();
  const task=signEnvelope({taskId:'task_queued',recipientDid:f.keys[0].did,seq:0,eventType:'PROPOSE',payload:{metadata:'retained'}},f.keys[1],{encrypt:true});
  relay.send(task);relay.send(f.take(0,'CONNECTION_ACCEPTED'));
  const restarted=new ConnectionRouter({...f.options[0],relay});
  await syncConnections(restarted,{once:true});
  expect(f.options[0].store.connectionState(f.keys[1].did)).toBe('connected');
  expect(relay.receive(f.keys[0].did,0,undefined,{peek:true,role:'worker'})?.payload.envelopeId).toBe(task.payload.envelopeId);
});
