// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { generateKeyPair, signPayload, verifySignedAgentCard, OPEN_POLICY_FIELDS, digest,
  type OpenPolicy, type SignedAgentCard } from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { WorkerNode, RequesterClient, PolicyAutoApprovalProvider, buildTaskManifest } from '../packages/runtime/src/index.js';

const policy = { maxInputTokens: 1000, maxOutputTokens: 500, maxToolInvocations: 2, maxWallClockSeconds: 30 };
const task = { title: 'Policy test', description: 'Echo within limits', input: { ok: true } };
function setup(openPolicy?: OpenPolicy, accessMode: 'open' | 'invite-only' = 'open', maxInputTokens?: number) {
  const owner = generateKeyPair(), requester = generateKeyPair(), relay = new InMemoryRelay();
  const budgets: unknown[] = [];
  const worker = new WorkerNode({ owner, relay, accessMode, allowedRequesterDids: [requester.did], openPolicy, maxInputTokens, timeoutMs: 3000,
    approvalProvider: new PolicyAutoApprovalProvider(owner),
    adapter: { id: 'echo', name: 'Echo', skills: [{ id: 'echo', name: 'Echo', taskTypes: ['json'] }],
      executeTask: async (ctx) => { budgets.push(ctx.manifest.budget); return ctx.input; } } });
  const client = new RequesterClient({ owner: requester, relay, timeoutMs: 3000,
    approvalProvider: new PolicyAutoApprovalProvider(requester) });
  return { owner, requester, relay, worker, client, budgets };
}

describe('Signed open policy', () => {
  it('signs the policy, rejects tampering, and snapshots caller limits', () => {
    const limits = { ...policy };
    const { worker } = setup(limits);
    limits.maxInputTokens = 9999;
    expect(worker.agentCard.payload.openPolicy).toEqual(policy);
    expect(verifySignedAgentCard(worker.agentCard)).toBe(true);
    expect(verifySignedAgentCard({ ...worker.agentCard, payload: { ...worker.agentCard.payload,
      openPolicy: { ...policy, maxInputTokens: 9999 } } })).toBe(false);
  });
  it.each([null, [], 'policy', { unexpected: 5 }, ...OPEN_POLICY_FIELDS.flatMap((key) =>
    [0, -1, 1.5, '100', Number.MAX_SAFE_INTEGER + 1].map((value) => ({ [key]: value })))])
    ('rejects correctly signed malformed policy %#', (openPolicy) => {
      const { worker, owner } = setup();
      const card = signPayload({ ...worker.agentCard.payload, openPolicy }, owner);
      expect(verifySignedAgentCard(card as SignedAgentCard)).toBe(false);
      expect(() => setup(openPolicy as OpenPolicy)).toThrow('INVALID_AGENT_CARD');
    });
  it.each([undefined, {}, { maxInputTokens: 1 }])('accepts optional and partial policy %#', (limits) => {
    expect(verifySignedAgentCard(setup(limits).worker.agentCard)).toBe(true);
  });
});

describe('Open policy admission and requester defaults', () => {
  it.each(['did', 'discovery'] as const)('caps all default fields for %s targeting', async (target) => {
    const { worker, client, owner, budgets } = setup(policy);
    await worker.register();
    const done = worker.start({ once: true });
    try {
      const [result] = await Promise.all([client.delegate({ ...task,
        to: target === 'did' ? owner.did : '',
        ...(target === 'discovery' ? { discover: { skillId: 'echo' } } : {}) }), done]);
      expect(result.state).toBe('SETTLED');
      expect(budgets).toEqual([expect.objectContaining(policy)]);
    } finally { worker.stop(); }
  });
  it.each(OPEN_POLICY_FIELDS)('rejects explicit excess in %s before execution', async (field) => {
    const { worker, client, owner, budgets } = setup(policy);
    await worker.register();
    const done = worker.start({ once: true }).catch((error: Error) => error);
    try {
      await expect(client.delegate({ ...task, to: owner.did, budget: { [field]: policy[field] + 1 } }))
        .rejects.toMatchObject({ code: 'TASK_SCOPE_REJECTED', detail: {
          field: 'budget.' + field, expected: digest(policy[field]), actual: digest(policy[field] + 1),
          hint: 'Use a budget within the advertised policy.',
        } });
      expect(await done).toMatchObject({ message: 'TASK_SCOPE_REJECTED' });
      expect(budgets).toEqual([]);
    } finally { worker.stop(); }
  });
  it('rejects an oversized custom manifest, including invite-based admission', async () => {
    const { worker, client, owner, requester, budgets } = setup(policy);
    const manifest = buildTaskManifest({ ...task, ownerDid: requester.did, workerDid: owner.did,
      taskType: 'json', budget: { ...policy, maxInputTokens: 1001 } });
    const done = worker.start({ once: true }).catch((error: Error) => error);
    try {
      await expect(client.delegate({ ...task, to: worker.invite(), manifest })).rejects.toThrow('TASK_SCOPE_REJECTED');
      expect(await done).toMatchObject({ message: 'TASK_SCOPE_REJECTED' });
      expect(budgets).toEqual([]);
      expect(manifest.budget.maxInputTokens).toBe(1001);
    } finally { worker.stop(); }
  });
  it('preserves explicit lower values and never increases defaults', async () => {
    const { worker, client, owner, budgets } = setup({ maxInputTokens: 90000, maxOutputTokens: 500 });
    await worker.register();
    const done = worker.start({ once: true });
    try {
      await Promise.all([client.delegate({ ...task, to: owner.did, budget: { maxOutputTokens: 200 } }), done]);
      expect(budgets).toEqual([expect.objectContaining({ maxInputTokens: 50000, maxOutputTokens: 200,
        maxToolInvocations: 10, maxWallClockSeconds: 60 })]);
    } finally { worker.stop(); }
  });
  it('retains stricter existing acceptance limits', async () => {
    const { worker, client, owner, budgets } = setup(policy, 'open', 100);
    await worker.register();
    const done = worker.start({ once: true }).catch((error: Error) => error);
    try {
      await expect(client.delegate({ ...task, to: owner.did })).rejects.toThrow();
      expect(await done).toBeInstanceOf(Error);
      expect(budgets).toEqual([]);
    } finally { worker.stop(); }
  });
  it('does not apply open policy to invite-only workers', async () => {
    const { worker, client, owner, budgets, requester } = setup(policy, 'invite-only');
    const manifest = buildTaskManifest({ ...task, ownerDid: requester.did, workerDid: owner.did });
    const done = worker.start({ once: true });
    try {
      await Promise.all([client.delegate({ ...task, to: worker.invite(), manifest }), done]);
      expect(budgets).toEqual([expect.objectContaining({ maxInputTokens: 50000 })]);
    } finally { worker.stop(); }
  });
});
