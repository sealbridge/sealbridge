// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSignedAgentCard, generateKeyPair, signPayload, discoverAgentCards } from '../packages/core/src/index.js';
import { LiveProtocol, PROTOCOL_020_RELEASED_AT, assertProtocolReleaseConfigured, ProtocolPeerStore,
  WorkerTrustStore, workerIntakePath } from '../packages/runtime/src/index.js';
import { admissionFixture } from './connections-fixture.js';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
function root() { const p = mkdtempSync(join(tmpdir(), 'connections-migration-')); cleanups.push(() => rmSync(p, { recursive: true, force: true })); return p; }
it.each(['limited','trusted'] as const)('reads old finite %s grants without admission authority or byte changes', async trust => {
  const f = admissionFixture(); cleanups.push(f.cleanup);
  const path = workerIntakePath(f.owner.did, f.identityOptions);
  const { mkdirSync } = await import('node:fs'); mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(signPayload({ version: 1, workerOwnerDid: f.owner.did, requests: [],
    grants: [{ did: f.requester.did, trust, expiresAt: Date.now() + 86400000 }], denials: [] }, f.owner)), { mode: 0o600 });
  const before = readFileSync(path);
  expect(f.store.connectionState(f.requester.did)).toBe('none');
  expect(f.store.listPriorApprovedPeers()).toHaveLength(1); expect(f.store.listConnections()).toEqual([]);
  expect(readFileSync(path)).toEqual(before);
  expect((await f.attempt())[0]).toMatchObject({ status: 'rejected', reason: { code: 'PENDING_OWNER_APPROVAL' } });
  expect(f.execute).not.toHaveBeenCalled();
});
it('retains legacy denials as blocks without rewriting on read', () => {
  const owner = generateKeyPair(), peer = generateKeyPair(), dir = root(), path = workerIntakePath(owner.did, { env: { SEALBRIDGE_DATA_DIR: dir } });
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(signPayload({ version: 1, workerOwnerDid: owner.did, requests: [], grants: [], denials: [peer.did] }, owner)), { mode: 0o600 });
  const store = new WorkerTrustStore(owner, { path }), before = readFileSync(path);
  expect(store.connectionState(peer.did)).toBe('blocked'); expect(store.listConnections()[0].state).toBe('blocked');
  expect(readFileSync(path)).toEqual(before);
});
it.each([0,89,90,179,180,365])('applies release-relative policy at day %s', day => {
  const epoch = Date.now(), releasedAt = new Date(epoch).toISOString(), now = epoch + day * 86400000;
  const protocol = new LiveProtocol({ protocolPolicy: { releasedAt, sendLegacyUntilDays: 90, receiveLegacyUntilDays: 180 }, now: () => now });
  if (day < 90) expect(protocol.outbound()).toBe('0.1.0'); else expect(() => protocol.outbound()).toThrow('PROTOCOL_VERSION_UNSUPPORTED');
  if (day < 180) expect(() => protocol.inbound('0.1.0', 'owner', 'agent')).not.toThrow();
  else expect(() => protocol.inbound('0.1.0', 'owner', 'agent')).toThrow('PROTOCOL_VERSION_UNSUPPORTED');
  expect(protocol.receiveVersions()).toEqual(day < 180 ? ['0.2.0','0.1.0'] : ['0.2.0']);
});
it('uses a documented pre-release state and rejects an unset public-release check', () => {
  expect(() => assertProtocolReleaseConfigured(null)).toThrow('PROTOCOL_RELEASE_UNSET');
  if (PROTOCOL_020_RELEASED_AT === null) {
    expect(() => assertProtocolReleaseConfigured()).toThrow('PROTOCOL_RELEASE_UNSET');
    const peer = generateKeyPair();
    // An unset clock has the same compatibility behavior at startup and years later.
    for (const now of [0, 3650 * 86400000]) {
      const protocol = new LiveProtocol({ now: () => now });
      const card = createSignedAgentCard({ name: 'Peer', agentDid: peer.did,
        relayEndpoint: 'https://relay.example', skills: [], protocolVersions: ['0.2.0', '0.1.0'], now }, peer);
      expect(protocol.receiveVersions()).toEqual(['0.2.0','0.1.0']);
      expect(protocol.outbound()).toBe('0.1.0');
      expect(protocol.outbound(card)).toBe('0.2.0');
      for (const version of ['0.1.0', '0.2.0'])
        expect(() => protocol.inbound(version, 'unobserved-owner', 'unobserved-agent')).not.toThrow();
      expect(() => protocol.inbound('0.3.0', 'owner', 'agent')).toThrow('PROTOCOL_VERSION_UNSUPPORTED');
    }
  } else expect(() => assertProtocolReleaseConfigured()).not.toThrow();
  expect(() => assertProtocolReleaseConfigured(new Date(0).toISOString())).not.toThrow();
  expect(() => assertProtocolReleaseConfigured('not-a-date')).toThrow('PROTOCOL_POLICY_INVALID');
});
it('selects newest common signed capabilities, refuses supplied versions and persists phase across rollback', () => {
  const owner = generateKeyPair(), peer = generateKeyPair(), dir = root(), epoch = Date.now(); let now = epoch;
  const options = { env: { SEALBRIDGE_DATA_DIR: dir }, now: () => now };
  const policy = { releasedAt: new Date(epoch).toISOString(), sendLegacyUntilDays: 90 as const, receiveLegacyUntilDays: 180 as const };
  const card = createSignedAgentCard({ name: 'Peer', agentDid: peer.did, relayEndpoint: 'https://relay.example', skills: [], protocolVersions: ['0.2.0','0.1.0'] }, peer);
  let protocol = new LiveProtocol({ protocolPolicy: policy, now: () => now, protocolPeers: new ProtocolPeerStore(owner, options) });
  expect(protocol.outbound(card)).toBe('0.2.0'); expect(() => protocol.outbound(card,'0.1.0')).toThrow('PROTOCOL_VERSION_UNSUPPORTED');
  expect(() => protocol.outbound(undefined, undefined, peer.did, peer.did)).toThrow('PROTOCOL_DOWNGRADE_REFUSED');
  now += 90 * 86400000; expect(() => protocol.outbound()).toThrow('PROTOCOL_VERSION_UNSUPPORTED');
  now = epoch + 86400000;
  protocol = new LiveProtocol({ protocolPolicy: policy, now: () => now, protocolPeers: new ProtocolPeerStore(owner, options) });
  expect(() => protocol.outbound()).toThrow('PROTOCOL_VERSION_UNSUPPORTED');
});
it('verifies legacy cards before ignoring retired fields', () => {
  const owner = generateKeyPair(), card = createSignedAgentCard({ name: 'Peer', agentDid: owner.did, relayEndpoint: 'https://relay.example', skills: [] }, owner);
  const old = signPayload({ ...card.payload, accessMode: 'open', openPolicy: { retired: -1 } }, owner);
  expect(discoverAgentCards([old])).toEqual([old]);
  expect(discoverAgentCards([{ ...old, payload: { ...old.payload, accessMode: 'changed' } }])).toEqual([]);
});
it.each([0,90,180])('enforces the live inbound release window before holding at day %s',async day=>{
  const now=Date.now(),releasedAt=new Date(now-day*86400000).toISOString();
  const f=admissionFixture({now:()=>now,protocolPolicy:{releasedAt,sendLegacyUntilDays:90,receiveLegacyUntilDays:180}});cleanups.push(f.cleanup);
  await expect(f.raw(f.manifest('0.1.0'))).rejects.toThrow(day<180?'PENDING_OWNER_APPROVAL':'PROTOCOL_VERSION_UNSUPPORTED');
  expect(f.review.list()).toHaveLength(day<180?1:0);expect(f.execute).not.toHaveBeenCalled();
});
it.each([0,90,180])('checks outbound compatibility before transmitting input at day %s',async day=>{
  const {InMemoryRelay}=await import('../packages/relay/src/index.js');
  const {RequesterClient,PolicyAutoApprovalProvider}=await import('../packages/runtime/src/index.js');
  const relay=new InMemoryRelay(),owner=generateKeyPair(),peer=generateKeyPair(),now=Date.now();
  relay.register(createSignedAgentCard({name:'Legacy peer',agentDid:peer.did,relayEndpoint:'https://relay.example',skills:[]},peer));
  const send=relay.send.bind(relay);let proposed=false;
  relay.send=envelope=>{if(envelope.payload.eventType==='PROPOSE'){proposed=true;throw new Error('CAPTURED_PROPOSE');}return send(envelope);};
  const client=new RequesterClient({owner,relay,now:()=>now,protocolPolicy:{releasedAt:new Date(now-day*86400000).toISOString(),sendLegacyUntilDays:90,receiveLegacyUntilDays:180},approvalProvider:new PolicyAutoApprovalProvider(owner)});
  await expect(client.delegate({to:peer.did,title:'Version',description:'Compatibility',input:{held:'input'}})).rejects.toThrow(day<90?'CAPTURED_PROPOSE':'PROTOCOL_VERSION_UNSUPPORTED');
  expect(proposed).toBe(day<90);
});
it('renegotiates a retained legacy manifest on an explicitly requested resubmission',async()=>{
  const {RequesterPendingStore}=await import('../packages/runtime/src/index.js');
  const {openEnvelope}=await import('../packages/core/src/index.js');
  const f=admissionFixture();cleanups.push(f.cleanup);
  const pending=new RequesterPendingStore(f.requester,f.identityOptions);f.client.options.pendingStore=pending;f.client.options.pendingRelayUrl='https://relay.example';
  await f.attempt();const id=pending.list()[0].id;
  await f.worker.register();
  const versions:string[]=[];const send=f.relay.send.bind(f.relay);
  f.relay.send=envelope=>{if(envelope.payload.eventType==='PROPOSE')versions.push((openEnvelope(envelope,f.owner) as any).proposal.payload.protocolVersion);return send(envelope);};
  await Promise.allSettled([pending.resubmit(id,request=>f.client.delegate(request)),f.worker.start({once:true})]);
  expect(versions).toEqual(['0.2.0']);expect(pending.list()[0].lastTaskId).not.toBe(pending.list()[0].originalTaskId);
});
