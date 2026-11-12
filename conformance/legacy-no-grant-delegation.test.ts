// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContract, createInviteToken, digest, generateKeyPair, signApproval, signEnvelope, signPayload } from '../packages/core/src/index.js';
import type { Json } from '../packages/core/src/index.js';
import { ApprovalGate, buildTaskManifest, createDelivery, QuotaMeter, RequesterClient, VerificationEngine, WorkerNode } from '../packages/runtime/src/index.js';
import { BilateralLedger } from '../packages/ledger/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';

function legacyFixture(depth = 1) {
  const owner = generateKeyPair(), worker = generateKeyPair();
  const manifest = buildTaskManifest({ ownerDid: owner.did, workerDid: worker.did, title: 'Legacy', description: 'No grant' });
  manifest.permissions.maxDelegationDepth = depth;
  const contract = createContract(manifest, signPayload(manifest, owner), worker);
  const quota = new QuotaMeter(manifest.taskId, manifest.budget, worker.did);
  const delivery = createDelivery(manifest.taskId, contract.contractDigest, { ok: true }, quota.receipt(worker), worker);
  quota.close();
  return { owner, worker, manifest, contract, delivery };
}
function settled(f: ReturnType<typeof legacyFixture>) {
  const ledger = new BilateralLedger(f.manifest.taskId, [f.owner.did, f.worker.did]);
  ledger.append('PROPOSE', { proposal: f.contract.proposal, input: {} } as unknown as Json, f.owner, f.worker);
  ledger.append('ACCEPT', { contract: f.contract } as unknown as Json, f.worker, f.owner);
  ledger.append('DELIVER', f.delivery as unknown as Json, f.worker, f.owner);
  ledger.append('SETTLED', {}, f.owner, f.worker);
  return { taskId: f.manifest.taskId, state: 'SETTLED' as const, deliverable: { ok: true }, bundle: ledger.bundle(f.owner, f.worker) };
}

// Uses only origin/main APIs and exact origin/main verification results; also run against c6fdc28.
it('legacy no-grant contract: depth-1 delivery without proof behaves as before', async () => {
  const f = legacyFixture();
  expect(f.manifest).not.toHaveProperty('contextGrant');
  expect(Object.keys(f.delivery).sort()).toEqual(['artifact', 'attestation', 'usage']);
  const envelope = signEnvelope({ taskId: f.manifest.taskId, recipientDid: f.owner.did, seq: 2,
    eventType: 'DELIVER', payload: f.delivery as unknown as Json }, f.worker, { encrypt: true });
  const approve = vi.fn(async () => signApproval(f.manifest.taskId, 'final_verification', f.delivery, f.owner));
  const gate = () => new ApprovalGate(f.owner.did, { requiredGates: [], autoApprove: [] });
  const expected = { accepted: true, event: 'VERIFY_ACCEPT', stages: ['crypto_budget', 'schema_isolated_check', 'owner_approval'] };
  const engine = new VerificationEngine();
  expect(await engine.verifyDeliverable({ contract: f.contract, envelope, gate: gate(), approval: approve, recipient: f.owner })).toEqual(expected);
  const verified = vi.fn();
  expect(await engine.verify(f.contract, envelope, gate(), approve, f.owner, { onVerifiedDelivery: verified })).toEqual(expected);
  expect(approve).toHaveBeenCalledTimes(2);
  expect(verified).toHaveBeenCalledOnce();
});

it.each([0, 1, 2, 5])('legacy no-grant contract: depth %s keeps opaque delivery extensions and existing output diagnostics', async depth => {
  const f = legacyFixture(depth);
  const delivery = { ...f.delivery, delegation: { opaque: 'legacy extension' } };
  const envelope = signEnvelope({ taskId: f.manifest.taskId, recipientDid: f.owner.did, seq: 2,
    eventType: 'DELIVER', payload: delivery as unknown as Json }, f.worker, { encrypt: true });
  const engine = new VerificationEngine();
  const verify = (contract = f.contract) => engine.verifyDeliverable({ contract, envelope,
    gate: new ApprovalGate(f.owner.did, { requiredGates: [], autoApprove: [] }),
    approval: signApproval(f.manifest.taskId, 'final_verification', delivery, f.owner), recipient: f.owner });
  expect(await verify()).toEqual({ accepted: true, event: 'VERIFY_ACCEPT', stages: ['crypto_budget', 'schema_isolated_check', 'owner_approval'] });
  // A signed contract with a different output declaration still fails at the original output check.
  f.manifest.io.outputSchema = { type: 'string' };
  const contract = createContract(f.manifest, signPayload(f.manifest, f.owner), f.worker);
  // The old attestation is bound to the old contract, so its existing diagnostic must win.
  expect(await verify(contract)).toEqual({ accepted: false, event: 'VERIFY_REJECT', stages: [], reason: 'Error: CRYPTO_ARTIFACT_OR_BUDGET' });
});

it('legacy no-grant contract: retained depth-1 idempotency result keeps origin/main unwrap behavior', async () => {
  const f = legacyFixture(), result = settled(f), relay = new InMemoryRelay();
  const client = new RequesterClient({ owner: f.owner, relay }), send = vi.spyOn(relay, 'send');
  // origin/main returns retained results as stored, without a new audit/lineage validation pass.
  result.bundle.checkpoint.actor.signature.signature = 'previously-retained-opaque-value';
  let retained: unknown = result;
  vi.spyOn(client as any, 'keyedStore').mockReturnValue({ run: async () => ({ isError: false, value: retained }) });
  for (const value of [result, null, { opaque: 'retained data' }]) {
    retained = value;
    expect(await client.delegate({ to: f.worker.did, manifest: f.manifest, title: 'Legacy', description: 'No grant',
      input: {}, idempotencyKey: 'legacy-result' })).toBe(value);
  }
  expect(send).not.toHaveBeenCalled();
});

it('legacy no-grant contract: sealed depth-1 recovery and outcome notification keep the original result', async () => {
  const f = legacyFixture(), result = settled(f), root = mkdtempSync(join(tmpdir(), 'legacy-delegation-'));
  const auditPath = join(root, 'audit.jsonl'), relay = new InMemoryRelay();
  writeFileSync(auditPath, result.bundle.entries.map(entry => JSON.stringify({ entry }) + '\n').join('') +
    JSON.stringify({ checkpoint: result.bundle.checkpoint }) + '\n', { mode: 0o600 });
  const node = new WorkerNode({ owner: f.worker, relay, adapter: { id: 'unused', name: 'Unused', skills: [],
    executeTask: async () => { throw new Error('NO_REPLAY'); } } });
  const record = { version: 1, taskId: f.manifest.taskId, requesterDid: f.owner.did, envelopeId: 'test',
    proposalDigest: digest({ manifest: f.manifest, input: {} }), phase: 'delivered', auditPath, invocations: [] };
  try {
    expect((node as any).sealedTaskResult(record)).toEqual(result);
    const send = vi.spyOn(relay, 'send');
    await (node as any).notifyOutcome(record, { code: 'TASK_SETTLED', result });
    expect(send).toHaveBeenCalledOnce();
  } finally { node.stop(); rmSync(root, { recursive: true, force: true }); }
});

it('legacy no-grant contract: task errors keep origin/main diagnostics', () => {
  const f = legacyFixture(), onEvent = vi.fn();
  const node = new WorkerNode({ owner: f.worker, relay: new InMemoryRelay(), onEvent,
    adapter: { id: 'unused', name: 'Unused', skills: [], executeTask: async () => null } });
  try {
    for (const [error, code] of [['DELEGATION_INVALID', 'INVALID'], ['DELEGATION_APPROVAL_REQUIRED', 'APPROVAL'],
      ['DELEGATION_PROOF_REQUIRED', 'EXECUTION_FAILED']]) {
      (node as any).reportRejection(f.manifest.taskId, new Error(error));
      expect(onEvent).toHaveBeenLastCalledWith('REJECTED', f.manifest.taskId, { code });
    }
  } finally { node.stop(); }
});

it.each(['0.1.0', '0.2.0'])('legacy no-grant contract: depth-1 live session keeps ordinary approval and results on %s', async protocolVersion => {
  const f = legacyFixture(), relay = new InMemoryRelay(), reviews: unknown[] = [];
  f.manifest.protocolVersion = protocolVersion;
  const node = new WorkerNode({ owner: f.worker, relay, timeoutMs: 5000, autoAccept: { version: 1, enabled: true, from: 'anyone', work: 'write', limits: {} }, checkPeer: () => 'trusted',
    approvalProvider: { approve: async request => signApproval(request.taskId, request.gate, request.target, f.worker) },
    adapter: { id: 'legacy', name: 'Legacy', skills: [], executeTask: async context => {
      expect(context).not.toHaveProperty('redelegate');
      return { ok: true };
    } } });
  const client = new RequesterClient({ owner: f.owner, relay, timeoutMs: 5000,
    approvalProvider: { approve: async request => {
      reviews.push(request);
      return signApproval(request.taskId, request.gate, request.target, f.owner);
    } } });
  const job = node.start({ once: true });
  try {
    const invitation = createInviteToken({ agentCard: signPayload({ ...node.agentCard.payload,
      protocolVersions: [protocolVersion] }, f.worker) }, f.worker);
    const result = await client.delegate({ to: invitation, manifest: f.manifest, title: 'Legacy', description: 'No grant', input: {} });
    expect(result.state).toBe('SETTLED');
    expect(result.deliverable).toEqual({ ok: true });
    expect(result.bundle.entries.find(e => e.body.eventType === 'DELIVER')?.body.payload).not.toHaveProperty('delegation');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ gate: 'final_verification', details: { manifest: f.manifest } });
    expect(Object.keys((reviews[0] as { details: object }).details).sort()).toEqual(['deliverableDigest', 'manifest', 'workerAutomation']);
  } finally { node.stop(); await job; }
});
