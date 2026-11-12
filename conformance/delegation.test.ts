// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertDelegationAttenuation, createContract, createDelegationLink, digest, generateKeyPair,
  loadSchema, openEnvelope, signApproval, signEnvelope, signPayload, validateSchema, verifyDelegationChain,
} from '../packages/core/src/index.js';
import type { DelegationAttachment, DelegationLinkPayload, Json, KeyPair, TaskContract, TaskManifest } from '../packages/core/src/index.js';
import {
  ApprovalGate, buildTaskManifest, createDelivery, OwnerGateway, PolicyAutoApprovalProvider,
  QuotaMeter, RequesterClient, VerificationEngine, verifyDelegationAttachment, WorkerNode,
} from '../packages/runtime/src/index.js';
import type { AgentTaskContext, ApprovalProvider, ApprovalRequest, Delivery } from '../packages/runtime/src/index.js';
import { assembleDelegation, redelegationTarget, validateTaskDelegation, verifyRecoveredDelegation } from '../packages/runtime/src/delegation.js';
import type { TaskDelegationState } from '../packages/runtime/src/delegation.js';
import { TaskJournal } from '../packages/runtime/src/task-journal.js';
import { contextSessionAuditPayload } from '../packages/runtime/src/context-grant-audit.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { BilateralLedger, parseJsonl, verifyAudit } from '../packages/ledger/src/index.js';
import * as sdk from '../cli/src/sdk.js';

const directories: string[] = [];
function directory() { const d = mkdtempSync(join(tmpdir(), 'cp5a-')); directories.push(d); return d; }
afterEach(() => { vi.useRealTimers(); for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });
function declarations(a: KeyPair, b: KeyPair, c: KeyPair) {
  const now = Date.now() - 1000;
  const parent = buildTaskManifest({ ownerDid: a.did, workerDid: b.did, title: 'Root', description: 'Review selected context',
    now: () => now, contextGrant: { deliveryMode: 'approval_redelegation', selectors: ['one','two'],
      fieldsAllowed: ['x','y'], fieldsDenied: ['private'], angle: 'Assess feasibility' } });
  const child = buildTaskManifest({ ownerDid: b.did, workerDid: c.did, title: 'Partial', description: 'Review one selection',
    now: () => now + 1, taskTimeoutMs: 500000, contextGrant: { selectors: ['one'], fieldsAllowed: ['x'], fieldsDenied: ['private'],
      angle: 'Assess one dimension', expiresAt: parent.contextGrant!.expiresAt } });
  return { parent, child };
}
function fixture() {
  const a = generateKeyPair(), b = generateKeyPair(), c = generateKeyPair();
  const { parent, child } = declarations(a,b,c);
  const parentContract = createContract(parent, signPayload(parent,a),b);
  const childContract = createContract(child, signPayload(child,b),c);
  const link = createDelegationLink({ parentContract, childContract },b);
  const proof = { link, childContract }, attachment = { parentContract, children: [proof] };
  return { a,b,c,parent,child,parentContract,childContract,link,proof,attachment };
}
function signChild(f: ReturnType<typeof fixture>) { return createContract(f.child, signPayload(f.child,f.b),f.c); }
function decision(owner: KeyPair, review?: (r: ApprovalRequest) => void | Promise<void>): ApprovalProvider {
  return { ownerDecision: true, kind: 'human', approve: async r => {
    await review?.(r); return signApproval(r.taskId,r.gate,r.target,owner);
  } };
}

describe('CP5a signed contracts and literal attenuation', () => {
  it('round-trips signed evidence and SDK exports without changing manifest requirements or defaults', () => {
    const f = fixture();
    validateSchema('delegation-link', f.link); validateSchema('delegation-attachment', JSON.parse(JSON.stringify(f.attachment)));
    expect(verifyDelegationChain({ rootContract: f.parentContract, chain: [f.proof] }))
      .toEqual({ depthRemaining: 0, delegateeOwnerDids: [f.c.did] });
    expect(f.link.signature.signedAt).toBe(f.link.payload.issuedAt);
    expect(f.link.payload.limits).toEqual({ deadline: f.child.deadline, expiresAt: f.child.contextGrant!.expiresAt,
      budget: f.child.budget, sandboxPolicy: f.child.sandboxPolicy, verification: f.child.verification, depthRemaining: 0 });
    for (const name of ['assertDelegationAttenuation','createDelegationLink','verifyDelegationChain','verifyDelegationAttachment'] as const)
      expect(sdk[name]).toBeTypeOf('function');
    expect(loadSchema('task-manifest.0.2.0').required).not.toContain('contextGrant');
    expect(buildTaskManifest({ ownerDid: f.a.did, workerDid: f.b.did, title: 'Old', description: 'Old' }).permissions.maxDelegationDepth).toBe(0);
  });
  it.each(['type','parentTaskId','parentContractDigest','childTaskId','childContractDigest','delegatorOwnerDid','delegateeOwnerDid',
    'depthRemaining','limits','issuedAt','prevLinkDigest'])('requires link field %s', name => {
    const f = fixture(), link = structuredClone(f.link); delete (link.payload as unknown as Record<string, unknown>)[name];
    expect(() => validateSchema('delegation-link', link)).toThrow();
  });
  it.each(['deadline','expiresAt','budget','sandboxPolicy','verification','depthRemaining'])('requires actual limit %s', name => {
    const f = fixture(), link = structuredClone(f.link); delete (link.payload.limits as unknown as Record<string,unknown>)[name];
    expect(() => validateSchema('delegation-link', link)).toThrow();
  });
  it.each(['wrapper','payload','limits','contract','proof','attachment','signature','encoding'])('closes new %s shapes', where => {
    const f = fixture(), x = structuredClone(f.attachment) as any;
    const targets: Record<string,any> = { wrapper: x.children[0].link, payload: x.children[0].link.payload,
      limits: x.children[0].link.payload.limits, contract: x.parentContract, proof: x.children[0], attachment: x,
      signature: x.children[0].link.signature };
    if (where === 'encoding') x.children[0].link.signature.signature += '=';
    else targets[where].extra = true;
    expect(() => validateSchema('delegation-attachment', x)).toThrow();
  });
  const patches: Array<[string,(p: DelegationLinkPayload,f: ReturnType<typeof fixture>) => void]> = [
    ['parent ID', p => { p.parentTaskId = 'task_other'; }], ['child ID', p => { p.childTaskId = 'task_other'; }],
    ['parent digest', p => { p.parentContractDigest = digest({}); }], ['child digest', p => { p.childContractDigest = digest({}); }],
    ['B DID', (p,f) => { p.delegatorOwnerDid = f.a.did; }], ['C DID', (p,f) => { p.delegateeOwnerDid = f.a.did; }],
    ['predecessor', p => { p.prevLinkDigest = digest({}); }], ['negative depth', p => { p.depthRemaining = -1; }],
    ['fractional depth', p => { p.depthRemaining = 0.5; }], ['reset depth', p => { p.depthRemaining = 1; }],
    ['duplicate depth', p => { p.limits.depthRemaining = 1; }], ['actual limits', p => { p.limits.budget.maxInputTokens--; }],
    ['actual expiry', p => { p.limits.expiresAt = new Date(Date.now()+10000).toISOString(); }],
    ['invalid date', p => { p.issuedAt = 'bad'; }], ['before acceptance', p => { p.issuedAt = new Date(Date.now()-2000).toISOString(); }],
    ['endpoint', (p,f) => { p.issuedAt = f.child.deadline; }],
  ];
  it.each(patches)('refuses B-signed changed %s', (_name,patch) => {
    const f = fixture(), payload = structuredClone(f.link.payload); patch(payload,f);
    const link = signPayload(payload,f.b,payload.issuedAt === 'bad' ? undefined : payload.issuedAt);
    expect(() => verifyDelegationChain({ rootContract: f.parentContract, chain: [{ link, childContract: f.childContract }] })).toThrow('DELEGATION_');
  });
  it.each(['signature','signer','signature time','acceptance','proposal','digest','cycle','same owner','agent owner'])('refuses changed %s', which => {
    const f = fixture(), proof = structuredClone(f.proof);
    if (which === 'signature') proof.link.signature.signature = f.parentContract.acceptance.signature.signature;
    if (which === 'signer') proof.link = signPayload(proof.link.payload,f.a,proof.link.payload.issuedAt);
    if (which === 'signature time') proof.link.signature.signedAt = new Date(Date.now()+1).toISOString();
    if (which === 'acceptance') proof.childContract.acceptance = signPayload(proof.childContract.acceptance.payload,f.b);
    if (which === 'proposal') proof.childContract.proposal.payload.task.description = 'Other';
    if (which === 'digest') proof.childContract.contractDigest = digest({});
    if (which === 'cycle') { f.child.taskId = f.parent.taskId; proof.childContract = signChild(f); }
    if (which === 'same owner') { f.child.worker!.ownerDid = f.a.did; proof.childContract = createContract(f.child,signPayload(f.child,f.b),f.a); }
    if (which === 'agent owner') { proof.link.payload.delegateeOwnerDid = generateKeyPair().did; proof.link = signPayload(proof.link.payload,f.b); }
    expect(() => verifyDelegationChain({ rootContract: f.parentContract, chain: [proof] })).toThrow('DELEGATION_');
  });
  it('rejects empty and two-edge chains, and root depth zero or legacy context', () => {
    const f = fixture();
    for (const chain of [[],[f.proof,f.proof]]) expect(() => verifyDelegationChain({ rootContract: f.parentContract, chain })).toThrow();
    for (const depth of [0,2,5]) {
      const m = structuredClone(f.parent); delete m.contextGrant; m.permissions.maxDelegationDepth = depth;
      const rootContract = createContract(m,signPayload(m,f.a),f.b);
      expect(() => verifyDelegationChain({ rootContract, chain: [f.proof] })).toThrow('DELEGATION_');
    }
  });
  const widenings: Array<[string,(m: TaskManifest) => void]> = [
    ['deadline', m => { m.deadline = new Date(Date.parse(m.deadline)+200000).toISOString(); }],
    ['expiry', m => { m.contextGrant!.expiresAt = new Date(Date.parse(m.contextGrant!.expiresAt)+1).toISOString(); }],
    ['lifetime', m => { m.contextGrant!.expiresAt = new Date(Date.parse(m.createdAt)+8*86400000).toISOString(); }],
    ['bytes', m => { m.contextGrant!.maxBytes = 65537; }], ['mode', m => { m.contextGrant!.deliveryMode = 'hand_over'; }],
    ['retention', m => { m.contextGrant!.retention = 'keep_deliverable'; }], ['input retention', m => { m.contextGrant!.inputRetentionAllowed = true; }],
    ['depth', m => { m.permissions.maxDelegationDepth = 1; }], ['cost bearer', m => { m.budget.costBearer = 'bilateral_quota'; }],
    ['overrun', m => { m.budget.onOverrun = 'request_hitl_amendment'; }], ['sandbox', m => { m.sandboxPolicy.allowedHosts = []; }],
    ['verification mode', m => { m.verification.mode = 'human'; }], ['usage', m => { m.verification.requireUsageReceipt = false; }],
    ['attestation', m => { m.verification.requireExecutionAttestation = false; }], ['retries', m => { m.verification.maxRetries = 1; }],
    ['selectors', m => { m.contextGrant!.selectors = ['one rewritten']; }], ['allowlist', m => { m.contextGrant!.fieldsAllowed = ['new']; }],
    ['missing allowlist', m => { delete m.contextGrant!.fieldsAllowed; }], ['empty allowlist', m => { m.contextGrant!.fieldsAllowed = []; }],
    ['denied', m => { delete m.contextGrant!.fieldsDenied; }], ['conflict', m => { m.contextGrant!.fieldsDenied!.push('x'); }],
    ['capabilities', m => { m.permissions.grantedCapabilities = [{ capabilityId: 'cap_x', resource:'data',allowedTools:['read'],maxInvocations:1,expiresAt:m.deadline }]; }],
  ];
  it.each(widenings)('refuses widened %s', (_name,change) => {
    const f = fixture(); change(f.child); expect(() => assertDelegationAttenuation(f.parent,f.child)).toThrow('DELEGATION_');
  });
  it.each(['maxInputTokens','maxOutputTokens','maxToolInvocations','maxWallClockSeconds'] as const)('bounds %s per task', name => {
    const f = fixture(); f.child.budget[name] = f.parent.budget[name];
    expect(() => assertDelegationAttenuation(f.parent,f.child)).not.toThrow();
    f.child.budget[name]++; expect(() => assertDelegationAttenuation(f.parent,f.child)).toThrow('DELEGATION_INVALID');
  });
  it('requires strictly narrower context, and preserves optional declarations exactly where required', () => {
    const f = fixture(); f.child.contextGrant!.selectors = [...f.parent.contextGrant!.selectors];
    f.child.contextGrant!.fieldsAllowed = [...f.parent.contextGrant!.fieldsAllowed!]; f.child.contextGrant!.maxBytes--;
    f.child.budget.maxInputTokens--; expect(() => assertDelegationAttenuation(f.parent,f.child)).toThrow('DELEGATION_INVALID');
    delete f.parent.contextGrant!.fieldsAllowed;
    expect(() => assertDelegationAttenuation(f.parent,f.child)).not.toThrow();
    f.parent.contextGrant!.outputSchema = { type: 'object' };
    expect(() => assertDelegationAttenuation(f.parent,f.child)).toThrow('DELEGATION_INVALID');
    f.child.contextGrant!.outputSchema = { type:'object' }; f.child.io.outputSchema = { type: 'string' };
    expect(() => assertDelegationAttenuation(f.parent,f.child)).not.toThrow();
    f.parent.verification.checks = [{ checkId: 'chk_one',kind:'human_review',target:'review' }];
    expect(() => assertDelegationAttenuation(f.parent,f.child)).toThrow('DELEGATION_INVALID');
  });
  it('verifies expired historical evidence without a live clock', () => {
    const f = fixture(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now()+30*86400000);
    expect(verifyDelegationAttachment(f.attachment,f.parentContract).delegateeOwnerDids).toEqual([f.c.did]);
  });
  it('supports siblings independently without asserting an aggregate budget', () => {
    const f = fixture(); f.child.taskId += 'sibling'; const childContract = signChild(f);
    const link = createDelegationLink({ parentContract: f.parentContract,childContract },f.b);
    const attachment = { parentContract: f.parentContract, children: [f.proof,{ link,childContract }] };
    expect(verifyDelegationAttachment(attachment,f.parentContract).delegateeOwnerDids).toEqual([f.c.did,f.c.did]);
    expect(link.payload.prevLinkDigest).toBeNull();
    expect(() => verifyDelegationAttachment({ ...attachment,children:[f.proof,f.proof] },f.parentContract)).toThrow('DELEGATION_INVALID');
  });
});

function delivered(f = fixture(), attachment: DelegationAttachment | null = f.attachment) {
  const quota = new QuotaMeter(f.parent.taskId,f.parent.budget,f.b.did);
  const delivery = createDelivery(f.parent.taskId,f.parentContract.contractDigest,{ ok:true },quota.receipt(f.b),f.b,undefined,attachment ?? undefined);
  quota.close();
  const envelope = signEnvelope({ taskId:f.parent.taskId,recipientDid:f.a.did,seq:2,eventType:'DELIVER',payload:delivery as unknown as Json },f.b,{ encrypt:true });
  return { ...f,delivery,envelope };
}
describe('CP5a delivery gate and historical bindings', () => {
  it.each(['missing','empty','wrong root','duplicate','invalid proof','depth zero'])('refuses %s before owner review', async variant => {
    const f = fixture(); let attachment: DelegationAttachment | null = structuredClone(f.attachment);
    if (variant === 'missing') attachment = null;
    if (variant === 'empty') attachment!.children = [];
    if (variant === 'wrong root') attachment!.parentContract = fixture().parentContract;
    if (variant === 'duplicate') attachment!.children.push(f.proof);
    if (variant === 'invalid proof') attachment!.children[0].link.payload.childContractDigest = digest({});
    if (variant === 'depth zero') {
      f.parent.contextGrant!.deliveryMode = 'view_only'; f.parent.permissions.maxDelegationDepth = 0;
      f.parentContract = createContract(f.parent,signPayload(f.parent,f.a),f.b);
    }
    const d = delivered(f,attachment), approve = vi.fn(async () => signApproval(f.parent.taskId,'final_verification',d.delivery,f.a));
    const result = await new VerificationEngine().verifyDeliverable({ contract:f.parentContract,envelope:d.envelope,
      gate:new ApprovalGate(f.a.did,{ requiredGates:[],autoApprove:[] }),approval:approve,recipient:f.a,ownerDecision:true });
    expect(result.accepted).toBe(false); expect(result.reason).toContain('DELEGATION_'); expect(approve).not.toHaveBeenCalled();
  });
  it('allows valid proof through normal output and owner review and requires the owner channel assertion', async () => {
    const f = delivered(), engine = new VerificationEngine();
    const gate = () => new ApprovalGate(f.a.did,{ requiredGates:[],autoApprove:[] });
    const approve = vi.fn(async () => signApproval(f.parent.taskId,'final_verification',f.delivery,f.a));
    const input = { contract:f.parentContract,envelope:f.envelope,gate:gate(),approval:approve,recipient:f.a };
    expect((await engine.verifyDeliverable(input)).reason).toContain('DELEGATION_APPROVAL_REQUIRED');
    expect(approve).not.toHaveBeenCalled();
    expect(await engine.verifyDeliverable({ ...input,gate:gate(),ownerDecision:true })).toMatchObject({ accepted:true,stages:['delegation_chain','crypto_budget','schema_isolated_check','owner_approval'] });
  });
  it('enforces identical lineage rules through verifyAndSettle', async () => {
    const f = delivered(); delete f.delivery.delegation;
    const gateway = new OwnerGateway(f.a,f.parentContract,{ requiredGates:[],autoApprove:[] });
    for (const [event,key] of [['ACCEPT',f.b],['START',f.b],['DELIVER',f.b]] as const) gateway.machine.apply(gateway.machine.event(event,key));
    const envelope = signEnvelope({ taskId:f.parent.taskId,recipientDid:f.a.did,seq:2,eventType:'DELIVER',payload:f.delivery as unknown as Json },f.b,{ encrypt:true });
    const result = await gateway.verifyAndSettle(envelope,new VerificationEngine(),undefined,{ ownerDecision:true });
    expect(result.result.reason).toContain('DELEGATION_PROOF_REQUIRED'); expect(result.settlement).toBeUndefined(); gateway.close();
  });
  it('keeps ordinary depth-zero delivery shape and rejects lineage on it', () => {
    const f = delivered(); const old = createDelivery(f.parent.taskId,f.parentContract.contractDigest,{},f.delivery.usage,f.b);
    expect(Object.keys(old).sort()).toEqual(['artifact','attestation','usage']);
    const parent = structuredClone(f.parent); parent.contextGrant!.deliveryMode = 'view_only'; parent.permissions.maxDelegationDepth = 0;
    const contract = createContract(parent,signPayload(parent,f.a),f.b);
    expect(() => verifyDelegationAttachment(undefined,contract)).not.toThrow();
    expect(() => verifyDelegationAttachment(f.attachment,contract)).toThrow('DELEGATION_INVALID');
  });
  it('binds disclosed contracts to compact audit evidence and retains them through JSON serialization', () => {
    const f = delivered();
    const proposal = contextSessionAuditPayload('PROPOSE',{ proposal:f.parentContract.proposal,input:{} } as unknown as Json,f.parent.contextGrant!);
    const accepted = contextSessionAuditPayload('ACCEPT',{ contract:f.parentContract } as unknown as Json,f.parent.contextGrant!);
    expect(() => verifyRecoveredDelegation(JSON.parse(JSON.stringify(f.delivery)),proposal,accepted)).not.toThrow();
    expect(() => verifyRecoveredDelegation({ ...f.delivery,delegation:undefined },proposal,accepted)).toThrow('DELEGATION_PROOF_REQUIRED');
    expect(() => verifyRecoveredDelegation(delivered().delivery,proposal,accepted)).toThrow('DELEGATION_INVALID');
    for (const field of ['manifestDigest','contractDigest','grantDigest','deliveryMode','acceptance']) {
      const changed = { ...(accepted as object),[field]:'different' };
      expect(() => verifyRecoveredDelegation(f.delivery,proposal,changed)).toThrow('DELEGATION_INVALID');
    }
  });
});

function journalState(f = fixture()): TaskDelegationState {
  const values = { childManifestDigest:digest(f.child),childInputDigest:digest({x:1}),delegateeOwnerDid:f.c.did };
  return { parentContract:f.parentContract,attempts:[{ childTaskId:f.child.taskId,...values,
    approval:signApproval(f.parent.taskId,'redelegation',redelegationTarget(f.parentContract,values),f.b),status:'completed',proof:f.proof }] };
}
describe('CP5a journal and assembly', () => {
  it('round-trips and compacts version-one state, and loads older records without it', () => {
    const f = fixture(), path = join(directory(),'tasks.jsonl'), journal = new TaskJournal(path,f.b);
    const base = { version:1 as const,taskId:f.parent.taskId,requesterDid:f.a.did,envelopeId:'test',proposalDigest:digest({}),phase:'running' as const,invocations:[] };
    journal.save(base); journal.close();
    let loaded = new TaskJournal(path,f.b); loaded.load(); expect(loaded.tasks.get(base.taskId)).not.toHaveProperty('delegation');
    loaded.save({ ...base,delegation:journalState(f) }); loaded.compact(new Set([base.taskId])); loaded.close();
    loaded = new TaskJournal(path,f.b); loaded.load(); expect(loaded.tasks.get(base.taskId)?.delegation).toEqual(journalStateFromFile(path)); loaded.close();
    function journalStateFromFile(file: string) { return JSON.parse(readFileSync(file,'utf8').trim()).payload.delegation; }
    expect(readFileSync(path,'utf8')).not.toContain('"input":');
  });
  it.each(['approved','dispatching','unresolved','accepted'] as const)('refuses unresolved %s attempt without inferring no children', status => {
    const f = fixture(), state = journalState(f); state.attempts[0].status = status;
    expect(() => assembleDelegation(state)).toThrow('DELEGATION_INVALID');
  });
  it('includes accepted failures and all siblings and rejects malformed journal writes and reads', () => {
    const f = fixture(), state = journalState(f); state.attempts[0].status = 'failed';
    expect(assembleDelegation(state).children).toEqual([f.proof]);
    delete state.attempts[0].proof;
    expect(() => assembleDelegation(state)).toThrow();
    state.attempts[0].status = 'completed';
    expect(() => validateTaskDelegation(state,f.parent.taskId,f.a.did,f.b.did)).toThrow('INVALID_TASK_JOURNAL');
    const path = join(directory(),'bad.jsonl'), journal = new TaskJournal(path,f.b);
    const record = { version:1 as const,taskId:f.parent.taskId,requesterDid:f.a.did,envelopeId:'test',proposalDigest:digest({}),phase:'running' as const,invocations:[],delegation:state };
    expect(() => journal.save(record)).toThrow('INVALID_TASK_JOURNAL'); journal.close();
    writeFileSync(path,JSON.stringify(signPayload(record,f.b))+'\n',{mode:0o600});
    const loaded = new TaskJournal(path,f.b); expect(() => loaded.load()).toThrow('INVALID_TASK_JOURNAL'); loaded.close();
  });
});

async function liveFixture(execute?: (ctx: AgentTaskContext, child: TaskManifest, c: WorkerNode) => Promise<Json>,
  review?: (request: ApprovalRequest) => void | Promise<void>) {
  const a = generateKeyPair(),b = generateKeyPair(),c = generateKeyPair(), relay = new InMemoryRelay(), d = directory();
  const clock = { offset: 0 };
  const { parent,child } = declarations(a,b,c), reviews: ApprovalRequest[] = [], childInputs: Json[] = [];
  const cNode = new WorkerNode({ owner:c,relay,timeoutMs:5000,autoAccept: { version: 1, enabled: true, from: 'anyone', work: 'write', limits: {} }, checkPeer: () => 'trusted',approvalProvider:decision(c,r => { reviews.push(r); }),
    adapter:{ id:'partial',name:'Partial',skills:[],executeTask:async ctx => { expect(ctx.redelegate).toBeUndefined(); childInputs.push(ctx.input); return {partial:true}; } } });
  const childRequester = new RequesterClient({ owner:b,relay,timeoutMs:5000,approvalProvider:decision(b,r => { reviews.push(r); }) });
  const bNode = new WorkerNode({ owner:b,relay,now:() => Date.now()+clock.offset,timeoutMs:5000,autoAccept: { version: 1, enabled: true, from: 'anyone', work: 'write', limits: {} }, checkPeer: () => 'trusted',approvalProvider:decision(b,r => { reviews.push(r); }),
    auditPath:join(d,'worker.jsonl'), redelegation:{ requester:childRequester,ownerApprovalProvider:decision(b,async r => { reviews.push(r); await review?.(r); }) },
    adapter:{ id:'root',name:'Root',skills:[],executeTask:async ctx => execute ? execute(ctx,child,cNode) :
      { result:(await ctx.redelegate!({to:cNode.invite(),manifest:child,input:{x:1}})).deliverable } } });
  const client = new RequesterClient({ owner:a,relay,timeoutMs:5000,approvalProvider:decision(a,r => { reviews.push(r); }) });
  const run = () => client.delegate({to:bNode.invite(),manifest:parent,title:parent.task.title,description:parent.task.description,input:{x:1,y:2}});
  const close = () => { bNode.stop(); cNode.stop(); };
  return {a,b,c,relay,clock,parent,child,bNode,cNode,client,childRequester,reviews,childInputs,run,close,d};
}
describe('CP5a explicit owner dispatch', () => {
  it('runs A → B → C, discloses C to A, and sends only the child task to C', async () => {
    const f = await liveFixture(), sentToC: Json[] = [];
    const send = f.relay.send.bind(f.relay);
    vi.spyOn(f.relay,'send').mockImplementation(async e => {
      if (e.payload.recipientDid === f.c.did) sentToC.push(openEnvelope(e,f.c));
      return send(e);
    });
    const jobs = [f.bNode.start({once:true}).catch(error => error),f.cNode.start({once:true}).catch(error => error)];
    try {
      const result = await f.run(); await Promise.all(jobs);
      expect(result.state).toBe('SETTLED'); expect(f.childInputs).toEqual([{x:1}]);
      const delivery = result.bundle.entries.find(e => e.body.eventType === 'DELIVER')!.body.payload as unknown as Delivery;
      expect(verifyDelegationAttachment(delivery.delegation,delivery.delegation!.parentContract).delegateeOwnerDids).toEqual([f.c.did]);
      expect(verifyAudit(result.bundle).valid).toBe(true);
      expect(parseJsonl(readFileSync(join(f.d,'worker.jsonl'),'utf8'))).toEqual(result.bundle);
      const toC = JSON.stringify(sentToC);
      for (const value of [f.a.did,f.parent.taskId,'DelegationLink','parentContract']) expect(toC).not.toContain(value);
      const rootSend = f.reviews.find(r => r.gate === 'contract_acceptance' && (r.target as any).type === 'ContextGrantProposal')!;
      expect(rootSend.target).toMatchObject({manifestDigest:digest(f.parent),inputDigest:digest({x:1,y:2}),workerOwnerDid:f.b.did});
      expect(f.reviews.filter(r => r.gate === 'redelegation')).toHaveLength(1);
      expect(f.reviews.filter(r => r.gate === 'final_verification')).toHaveLength(2);
      expect(f.reviews.at(-1)!.details).toMatchObject({delegateeOwnerDids:[f.c.did]});
      const checkpoint = JSON.parse(readFileSync(join(f.d,'worker.jsonl.tasks.jsonl'),'utf8').trim().split('\n').at(-1)!);
      expect(checkpoint.payload.delegation.attempts[0]).toMatchObject({status:'completed',childTaskId:f.child.taskId});
    } finally { f.close(); await Promise.allSettled(jobs); }
  });
  it('does not send a child before B decides, and snapshots the selected input', async () => {
    let entered!: () => void, release!: () => void;
    const reviewing = new Promise<void>(r => {entered=r;}), wait = new Promise<void>(r => {release=r;});
    const f = await liveFixture(async (ctx,child,c) => {
      const input = {x:1}; const result = ctx.redelegate!({to:c.invite(),manifest:child,input}); input.x = 99;
      return (await result).deliverable!;
    },async () => {entered(); await wait;});
    const jobs = [f.bNode.start({once:true}).catch(error => error),f.cNode.start({once:true}).catch(error => error)], send = vi.spyOn(f.relay,'send');
    const run = f.run();
    try {
      await reviewing;
      expect(send.mock.calls.filter(([e]) => e.payload.recipientDid === f.c.did && e.payload.eventType === 'PROPOSE')).toHaveLength(0);
      release(); expect((await run).state).toBe('SETTLED'); expect(f.childInputs).toEqual([{x:1}]);
    } finally { release(); f.close(); await Promise.allSettled([...jobs,run]); }
  });
  it('refuses child overrides, equal context, extra capabilities and default-identity mismatch before any child send', async () => {
    let f!: Awaited<ReturnType<typeof liveFixture>>;
    f = await liveFixture(async (ctx,child,c) => {
      for (const patch of [{capabilityChains:[]},{autoApprove:true},{retry:true},{proof:{}},{manifest:{...child,contextGrant:{...child.contextGrant,selectors:['one','two'],fieldsAllowed:['x','y']}}}])
        await expect(ctx.redelegate!({to:c.invite(),manifest:child,input:{x:1},...patch} as any)).rejects.toThrow('DELEGATION_');
      const original = f.childRequester.options.owner;
      f.childRequester.options.owner = generateKeyPair();
      await expect(ctx.redelegate!({to:c.invite(),manifest:child,input:{x:1}})).rejects.toThrow('DELEGATION_INVALID');
      f.childRequester.options.owner = original;
      return (await ctx.redelegate!({to:c.invite(),manifest:child,input:{x:1}})).deliverable!;
    });
    const jobs = [f.bNode.start({once:true}).catch(error => error),f.cNode.start({once:true}).catch(error => error)];
    try { expect((await f.run()).state).toBe('SETTLED'); expect(f.childInputs).toHaveLength(1); }
    finally { f.close(); await Promise.allSettled(jobs); }
  });
  it.each(['policy','unmarked','wrong receipt','changed target','rejected','cancelled','expired'] as const)('refuses %s child decisions without transmission', async kind => {
    const controller = new AbortController();
    let f!: Awaited<ReturnType<typeof liveFixture>>;
    f = await liveFixture(async (ctx,child,c) => {
      if (kind === 'policy') f.bNode.options.redelegation!.ownerApprovalProvider = new PolicyAutoApprovalProvider(f.b,undefined,{yes:true,confirmedGates:['redelegation']});
      if (kind === 'unmarked') f.bNode.options.redelegation!.ownerApprovalProvider = {approve:decision(f.b).approve};
      if (['wrong receipt','changed target','rejected'].includes(kind)) f.bNode.options.redelegation!.ownerApprovalProvider = {
        ownerDecision:true,approve:async r => signApproval(r.taskId,r.gate,kind === 'changed target' ? {...r.target as object,childInputDigest:digest({other:1})} : r.target,
          kind === 'wrong receipt' ? f.a : f.b,kind === 'rejected' ? 'REJECTED' : 'APPROVED') };
      if (kind === 'cancelled') f.bNode.options.redelegation!.ownerApprovalProvider = decision(f.b,() => { f.bNode.stop(); controller.abort(); });
      if (kind === 'expired') f.bNode.options.redelegation!.ownerApprovalProvider = decision(f.b,() => { f.clock.offset = Date.parse(f.parent.contextGrant!.expiresAt)-Date.now(); });
      await expect(ctx.redelegate!({to:c.invite(),manifest:child,input:{x:1}})).rejects.toThrow();
      return {};
    });
    const send = vi.spyOn(f.relay,'send'), jobs = [f.bNode.start({once:true}).catch(error => error)];
    const run = f.client.delegate({to:f.bNode.invite(),manifest:f.parent,title:'Root',description:'Root',input:{x:1},signal:controller.signal});
    try { await expect(run).rejects.toThrow();
      expect(send.mock.calls.filter(([e]) => e.payload.recipientDid === f.c.did && e.payload.eventType === 'PROPOSE')).toHaveLength(0);
    } finally { f.close(); await Promise.allSettled([...jobs,run]); }
  });
  it.each(['facility','audit','opening','requester identity'] as const)('requires %s at admission before root opening', async kind => {
    const f = await liveFixture();
    if (kind === 'facility') f.bNode.options.redelegation = undefined;
    if (kind === 'audit') f.bNode.options.auditPath = undefined;
    if (kind === 'opening') Object.defineProperty(f.bNode.approvalProvider,'ownerDecision',{value:undefined});
    if (kind === 'requester identity') f.childRequester.options.owner = generateKeyPair();
    const job = f.bNode.start({once:true}).catch(error => error);
    try { await expect(f.run()).rejects.toThrow('DELEGATION_'); expect(f.reviews.filter(r => r.taskId === f.parent.taskId)).toHaveLength(1); }
    finally { f.close(); await Promise.allSettled([job]); }
  });
  it.each(['policy','unmarked','wrong target'] as const)('requires a fresh explicit A proposal decision: %s', async kind => {
    const f = await liveFixture(); const send = vi.spyOn(f.relay,'send');
    const provider = kind === 'policy' ? new PolicyAutoApprovalProvider(f.a) : kind === 'unmarked' ? {approve:decision(f.a).approve} :
      {ownerDecision:true as const,approve:async (r: ApprovalRequest) => signApproval(r.taskId,r.gate,{},f.a)};
    const client = new RequesterClient({...f.client.options,approvalProvider:provider});
    try {
      await expect(client.delegate({to:f.bNode.invite(),manifest:f.parent,title:'Root',description:'Root',input:{}})).rejects.toThrow();
      expect(send.mock.calls.filter(([e]) => e.payload.eventType === 'PROPOSE')).toHaveLength(0);
    } finally { f.close(); }
  });
  it('keeps a terminal held child terminal, without automatic retry or parent proof', async () => {
    const f = await liveFixture(); f.cNode.options.checkPeer = undefined; f.cNode.autoAccept.enabled = false;
    const send = vi.spyOn(f.relay,'send'), jobs = [f.bNode.start({once:true}).catch(error => error),f.cNode.start({once:true}).catch(error => error)];
    try { await expect(f.run()).rejects.toThrow();
      expect(send.mock.calls.filter(([e]) => e.payload.eventType === 'PROPOSE' && e.payload.recipientDid === f.c.did)).toHaveLength(1);
      expect(f.childInputs).toHaveLength(0);
    } finally { f.close(); await Promise.allSettled(jobs); }
  });
});

it('the host assembles all managed siblings, including an accepted child whose result was refused', async () => {
  let f!: Awaited<ReturnType<typeof liveFixture>>;
  f = await liveFixture(async (ctx,child,c) => {
    const first = await ctx.redelegate!({to:c.invite(),manifest:child,input:{x:1}});
    const invalid = structuredClone(child); invalid.taskId += 'second'; invalid.io.outputSchema = {type:'object',required:['missing']};
    await expect(ctx.redelegate!({to:c.invite(),manifest:invalid,input:{x:1}})).rejects.toThrow('VERIFICATION_REJECTED');
    await expect(ctx.redelegate!({to:c.invite(),manifest:child,input:{x:1}})).rejects.toThrow('DELEGATION_INVALID');
    return first.deliverable!;
  });
  const jobs = [f.bNode.start({once:true}).catch(e => e),f.cNode.start().catch(e => e)];
  try {
    const result = await f.run();
    const delivery = result.bundle.entries.find(e => e.body.eventType === 'DELIVER')!.body.payload as unknown as Delivery;
    expect(delivery.delegation!.children.map(p => p.childContract.manifest.taskId)).toEqual([f.child.taskId,f.child.taskId+'second']);
    expect(f.reviews.filter(r => r.gate === 'redelegation')).toHaveLength(2);
    // Only the first child reaches B's final review; the second fails its ordinary output check.
    expect(f.reviews.filter(r => r.gate === 'final_verification')).toHaveLength(2);
  } finally { f.close(); await Promise.allSettled(jobs); }
});
it('task-produced proof data cannot substitute for the host registry', async () => {
  const f = await liveFixture(async () => JSON.parse(JSON.stringify(fixture().attachment)) as Json);
  const job = f.bNode.start({once:true}).catch(e => e);
  try { await expect(f.run()).rejects.toThrow('DELEGATION_'); expect(f.childInputs).toHaveLength(0); }
  finally { f.close(); await job; }
});
it('waits for child operations that the adapter has not awaited, and closes dispatch before delivery', async () => {
  let completed = false, late!: AgentTaskContext['redelegate'];
  const f = await liveFixture(async (ctx,child,c) => {
    late = ctx.redelegate;
    void ctx.redelegate!({to:c.invite(),manifest:child,input:{x:1}}).then(() => {completed=true;});
    return {ok:true};
  });
  const jobs = [f.bNode.start({once:true}).catch(e => e),f.cNode.start({once:true}).catch(e => e)];
  try {
    expect((await f.run()).state).toBe('SETTLED'); expect(completed).toBe(true);
    await expect(late!({to:f.cNode.invite(),manifest:f.child,input:{x:1}})).rejects.toThrow('DELEGATION_INVALID');
  } finally { f.close(); await Promise.allSettled(jobs); }
});
it('records an unresolved dispatch when child acceptance is uncertain and never delivers a partial proof set', async () => {
  const f = await liveFixture(async (ctx,child,c) => {
    await expect(ctx.redelegate!({to:c.invite(),manifest:child,input:{x:1}})).rejects.toThrow(); return {};
  });
  const send = f.relay.send.bind(f.relay);
  vi.spyOn(f.relay,'send').mockImplementation(async e => {
    if (e.payload.senderDid === f.c.did && e.payload.eventType === 'ACCEPT') throw new Error('TEST_INTERRUPTED_ACCEPT');
    return send(e);
  });
  const jobs = [f.bNode.start({once:true}).catch(e => e),f.cNode.start({once:true}).catch(e => e)];
  try {
    await expect(f.run()).rejects.toThrow();
    const records = readFileSync(join(f.d,'worker.jsonl.tasks.jsonl'),'utf8').trim().split('\n').map(x => JSON.parse(x).payload);
    expect(records.at(-1).delegation.attempts[0]).toMatchObject({status:'unresolved'});
    expect(records.at(-1).delegation.attempts[0]).not.toHaveProperty('proof');
    expect(records.some(r => r.phase === 'delivered')).toBe(false);
    const resumed = new WorkerNode({...f.bNode.options});
    try { await resumed.start({signal:AbortSignal.abort()}); } finally { resumed.stop(); }
    expect(f.childInputs).toHaveLength(0);
  } finally { f.close(); await Promise.allSettled(jobs); }
});
it('refuses reuse of a consumed target-bound redelegation receipt', () => {
  const f = fixture(), gate = new ApprovalGate(f.b.did,{requiredGates:[],autoApprove:[]});
  const values = {childManifestDigest:digest(f.child),childInputDigest:digest({x:1}),delegateeOwnerDid:f.c.did};
  const target = redelegationTarget(f.parentContract,values), receipt = signApproval(f.parent.taskId,'redelegation',target,f.b);
  gate.require(f.parent.taskId,'redelegation',target,receipt);
  expect(() => gate.require(f.parent.taskId,'redelegation',target,receipt)).toThrow('APPROVAL_REQUIRED');
});
it('declaration narrowing does not establish semantic provenance of the selected JSON', () => {
  const f = fixture(); expect(() => assertDelegationAttenuation(f.parent,f.child)).not.toThrow();
  // Selectors are opaque. Bytes under the limit may originate elsewhere; the owner must review them.
  const supplied = {x:'unrelated content'};
  expect(supplied.x).not.toBe('one');
  expect(() => assertDelegationAttenuation(f.parent,f.child)).not.toThrow();
});
it('keeps link verification bound to owner DIDs when the agent DIDs differ', () => {
  const f = fixture(); f.parent.requester.agentDid = generateKeyPair().did; f.parent.worker!.agentDid = generateKeyPair().did;
  f.child.requester.agentDid = generateKeyPair().did; f.child.worker!.agentDid = generateKeyPair().did;
  const parentContract = createContract(f.parent,signPayload(f.parent,f.a),f.b), childContract = signChild(f);
  const link = createDelegationLink({parentContract,childContract},f.b);
  expect(verifyDelegationChain({rootContract:parentContract,chain:[{link,childContract}]}).delegateeOwnerDids).toEqual([f.c.did]);
});

function settledEvidence(f: ReturnType<typeof fixture>, includeProof: boolean) {
  const d = delivered(f,includeProof ? f.attachment : null);
  const proposal = contextSessionAuditPayload('PROPOSE',{proposal:f.parentContract.proposal,input:{x:1}} as unknown as Json,f.parent.contextGrant!);
  const acceptance = contextSessionAuditPayload('ACCEPT',{contract:f.parentContract} as unknown as Json,f.parent.contextGrant!);
  const ledger = new BilateralLedger(f.parent.taskId,[f.a.did,f.b.did]);
  ledger.append('PROPOSE',proposal,f.a,f.b); ledger.append('ACCEPT',acceptance,f.b,f.a);
  ledger.append('DELIVER',d.delivery as unknown as Json,f.b,f.a); ledger.append('SETTLED',{},f.a,f.b);
  const bundle = ledger.bundle(f.a,f.b);
  expect(verifyAudit(bundle).valid).toBe(true);
  return {taskId:f.parent.taskId,state:'SETTLED' as const,deliverable:d.delivery.artifact.payload.data,bundle};
}
it.each([true,false])('worker sealed-result recovery enforces proof presence = %s', includeProof => {
  const f = fixture(), result = settledEvidence(f,includeProof), path = join(directory(),'audit.jsonl');
  writeFileSync(path,result.bundle.entries.map(entry => JSON.stringify({entry})+'\n').join('')+JSON.stringify({checkpoint:result.bundle.checkpoint})+'\n',{mode:0o600});
  const node = new WorkerNode({owner:f.b,relay:new InMemoryRelay(),adapter:{id:'offline',name:'Offline',skills:[],executeTask:async () => {throw new Error('NO_REPLAY');}}});
  const record = {version:1,taskId:f.parent.taskId,requesterDid:f.a.did,envelopeId:'test',proposalDigest:digest({manifest:f.parent,input:{x:1}}),phase:'delivered',auditPath:path,invocations:[]};
  try { expect((node as any).sealedTaskResult(record)?.state).toBe(includeProof ? 'SETTLED' : undefined); }
  finally {node.stop();}
});
it.each([true,false])('requester cached-result recovery enforces proof presence = %s', async includeProof => {
  const f = fixture(), result = settledEvidence(f,includeProof), relay = new InMemoryRelay();
  const send = relay.send.bind(relay);
  vi.spyOn(relay,'send').mockImplementation(async envelope => {
    if (envelope.payload.senderDid === f.a.did && envelope.payload.eventType === 'PROPOSE') {
      await send(signEnvelope({taskId:f.parent.taskId,recipientDid:f.a.did,seq:0,eventType:'ERROR',payload:{code:'TASK_SETTLED',
        recovery:{proposalDigest:digest({manifest:f.parent,input:{x:1}}),result}} as unknown as Json},f.b,{encrypt:true}));
      return;
    }
    return send(envelope);
  });
  const node = new WorkerNode({owner:f.b,relay,adapter:{id:'offline',name:'Offline',skills:[],executeTask:async () => {throw new Error('NO_REPLAY');}}});
  const client = new RequesterClient({owner:f.a,relay,timeoutMs:3000,approvalProvider:decision(f.a)});
  try {
    const run = client.delegate({to:node.invite(),manifest:f.parent,title:'Root',description:'Root',input:{x:1}});
    if (includeProof) expect((await run).bundle).toEqual(result.bundle);
    else await expect(run).rejects.toThrow('DELEGATION_PROOF_REQUIRED');
  } finally {node.stop();}
});
it('replays a depth-one settled checkpoint without sending another child or losing its attachment', async () => {
  const f = await liveFixture(), jobs = [f.bNode.start({once:true}).catch(e => e),f.cNode.start({once:true}).catch(e => e)];
  const sent = vi.spyOn(f.relay,'send');
  try {
    const first = await f.run(); await Promise.all(jobs);
    const path = join(f.d,'worker.jsonl.tasks.jsonl'), lines = readFileSync(path,'utf8').trim().split('\n');
    const index = lines.findIndex(line => JSON.parse(line).payload.phase === 'delivered');
    writeFileSync(path,lines.slice(0,index+1).join('\n')+'\n',{mode:0o600});
    const resumed = new WorkerNode({...f.bNode.options}), job = resumed.start({once:true}).catch(e => e);
    try {
      const replayed = await f.client.delegate({to:resumed.invite(),manifest:f.parent,title:'Root',description:'Root',input:{x:1,y:2}});
      expect(replayed.bundle).toEqual(first.bundle);
      expect(sent.mock.calls.filter(([e]) => e.payload.recipientDid === f.c.did && e.payload.eventType === 'PROPOSE')).toHaveLength(1);
    } finally {resumed.stop(); await job;}
  } finally {f.close(); await Promise.allSettled(jobs);}
});

it.each([true,false])('validates lineage in a retained idempotency result: proof = %s', async includeProof => {
  const f = fixture(), result = settledEvidence(f,includeProof), relay = new InMemoryRelay();
  const client = new RequesterClient({owner:f.a,relay,approvalProvider:decision(f.a)}), send = vi.spyOn(relay,'send');
  // Represents a previously retained, signed store result; the session boundary must still check lineage.
  vi.spyOn(client as any,'keyedStore').mockReturnValue({run:async () => ({isError:false,value:result})});
  const run = client.delegate({to:f.b.did,manifest:f.parent,title:'Root',description:'Root',input:{x:1},idempotencyKey:'retained-result'});
  if (includeProof) expect((await run).bundle).toEqual(result.bundle);
  else await expect(run).rejects.toThrow('DELEGATION_PROOF_REQUIRED');
  expect(send).not.toHaveBeenCalled();
});
it('uses stable delegation diagnostics for an invalid issuance declaration', () => {
  const f = fixture();
  expect(() => createDelegationLink({parentContract:f.parentContract,childContract:f.childContract,issuedAt:'bad'},f.b)).toThrow('DELEGATION_INVALID');
});
it('requires a new A proposal decision and no send after cancellation or a stale receipt', async () => {
  const f = await liveFixture(), send = vi.spyOn(f.relay,'send');
  try {
    for (const kind of ['stale','cancelled'] as const) {
      const controller = new AbortController();
      const provider: ApprovalProvider = {ownerDecision:true,approve:async r => {
        const receipt = signApproval(r.taskId,r.gate,r.target,f.a);
        if (kind === 'cancelled') controller.abort();
        else {receipt.payload.approvedAt = new Date(Date.now()-10000).toISOString(); return signPayload(receipt.payload,f.a);}
        return receipt;
      }};
      const client = new RequesterClient({...f.client.options,approvalProvider:provider});
      await expect(client.delegate({to:f.bNode.invite(),manifest:f.parent,title:'Root',description:'Root',input:{},signal:controller.signal})).rejects.toThrow();
    }
    expect(send.mock.calls.filter(([e]) => e.payload.eventType === 'PROPOSE')).toHaveLength(0);
  } finally {f.close();}
});
it('validates the complete root contract schema even in a journal with no child attempts', () => {
  const f = fixture(), state = {parentContract:{...f.parentContract,unknown:true},attempts:[]};
  expect(() => validateTaskDelegation(state,f.parent.taskId,f.a.did,f.b.did)).toThrow('INVALID_TASK_JOURNAL');
});
it('does not expose new child dispatch authority after a parent adapter has failed', async () => {
  let late!: AgentTaskContext['redelegate'];
  const f = await liveFixture(async ctx => {late=ctx.redelegate; throw new Error('TEST_PARENT_ENDED');});
  const job = f.bNode.start({once:true}).catch(e => e), send = vi.spyOn(f.relay,'send');
  try {
    await expect(f.run()).rejects.toThrow(); await job;
    await expect(late!({to:f.cNode.invite(),manifest:f.child,input:{x:1}})).rejects.toThrow('DELEGATION_INVALID');
    expect(send.mock.calls.filter(([e]) => e.payload.recipientDid === f.c.did && e.payload.eventType === 'PROPOSE')).toHaveLength(0);
  } finally {f.close(); await job;}
});
