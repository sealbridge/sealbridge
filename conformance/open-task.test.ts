// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { generateKeyPair, discoverAgentCards, signPayload, verifySignedAgentCard, createCapability, verifyCapabilityChain } from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { WorkerNode, RequesterClient, PolicyAutoApprovalProvider, buildTaskManifest } from '../packages/runtime/src/index.js';

function setup(allowed = false) {
  const owner = generateKeyPair(), requester = generateKeyPair(), relay = new InMemoryRelay();
  let calls = 0;
  const worker = new WorkerNode({ owner, relay, timeoutMs: 3000,
    ...(allowed ? { checkPeer: () => 'trusted' as const } : {}),
    approvalProvider: new PolicyAutoApprovalProvider(owner),
    adapter: { id: 'echo', name: 'echo', skills: [{ id: 'echo', name: 'Echo', taskTypes: ['json'] }],
      executeTask: async (ctx) => { calls++; return ctx.input; } } });
  const client = new RequesterClient({ owner: requester, relay, timeoutMs: 3000,
    approvalProvider: new PolicyAutoApprovalProvider(requester) });
  return { owner, requester, relay, worker, client, calls: () => calls };
}
const task = { title: 'Published task', description: 'single encrypted task', input: { hello: 'world' } };
describe('Published task collaboration', () => {
  it.each(['did', 'skill', 'taskType'] as const)('settles encrypted invite-less delegation by %s with explicit contact permission', async (kind) => {
    const { owner, worker, client, relay, calls } = setup(true);
    await worker.register();
    const send = relay.send.bind(relay);
    let encrypted = 0;
    relay.send = (envelope) => {
      expect(envelope.payload.payload).toMatchObject({ __acpEncrypted: 'X25519-HKDF-AES256GCM' });
      encrypted++;
      return send(envelope);
    };
    const done = worker.start({ once: true });
    try {
      const [result] = await Promise.all([client.delegate({ ...task,
        to: kind === 'did' ? owner.did : '',
        ...(kind === 'skill' ? { discover: { skillId: 'echo' } } : {}),
        ...(kind === 'taskType' ? { discover: { taskType: 'json' } } : {}),
      }), done]);
      expect(result.state).toBe('SETTLED');
      expect(result.deliverable).toEqual(task.input);
      expect(calls()).toBe(1);
      expect(encrypted).toBeGreaterThan(5);
    } finally { worker.stop(); }
  });
  it('holds unconnected direct delegation', async () => {
    const { owner, worker, client, calls } = setup();
    await worker.register();
    const done = worker.start({ once: true }).catch((error: Error) => error);
    try {
      await expect(client.delegate({ ...task, to: owner.did })).rejects.toThrow('PEER_REJECTED');
      expect(await done).toMatchObject({ message: 'PENDING_OWNER_APPROVAL' });
      expect(calls()).toBe(0);
    } finally { worker.stop(); }
  });
  it.each(['invite', 'allowlist'] as const)('holds %s admission until inspection and owner opening', async kind => {
    const { owner, worker, client } = setup();
    if (kind === 'allowlist') worker.acceptance.allowedRequesterDids = [client.options.owner.did];
    const results = await Promise.allSettled([client.delegate({ ...task, to: kind === 'invite' ? worker.invite() : owner.did }), worker.start({ once: true })]);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'PENDING_OWNER_APPROVAL' } });
    worker.stop();
  });
  it('allows skill discovery on every published verified card', async () => {
    const { worker, client, owner } = setup();
    await worker.register();
    const results = await Promise.allSettled([client.delegate({ ...task, to: '', discover: { skillId: 'echo' } }), worker.start({ once: true })]);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'PENDING_OWNER_APPROVAL' } });
    worker.stop();
  });
  it('authenticates original card fields and task types and ignores expired cards', () => {
    const { worker, owner } = setup();
    const card = worker.agentCard;
    expect(discoverAgentCards([card], { taskType: 'json' })).toEqual([card]);
    expect(verifySignedAgentCard({ ...card, payload: { ...card.payload, name: 'changed' } })).toBe(false);
    expect(verifySignedAgentCard({ ...card, payload: { ...card.payload, skills: [{ id: 'other', name: 'other' }] } })).toBe(false);
    expect(discoverAgentCards([card], {}, Date.parse(card.payload.expiresAt))).toEqual([]);
    const newer = signPayload({ ...card.payload, accessMode: 'invite-only' as const }, owner,
      new Date(Date.parse(card.signature.signedAt) + 1).toISOString());
    expect(discoverAgentCards([card, newer], {}, Date.now() + 2)).toEqual([newer]);
  });
  it.each(['scope', 'expiry', 'task'] as const)('keeps cryptographic capability %s enforcement', (kind) => {
    const { owner, requester } = setup();
    const token = createCapability({ audience: owner.did, taskId: 'task_open', resource: 'data://allowed',
      allowedTools: ['read'], argConstraints: { read: {} }, maxCalls: 1, maxDepth: 0,
      notBefore: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 10000).toISOString() }, requester);
    const context = { rootDid: requester.did, audience: owner.did, taskId: 'task_open' };
    expect(() => verifyCapabilityChain([token], context)).not.toThrow();
    if (kind === 'scope') token.payload.resource = 'data://forbidden';
    expect(() => verifyCapabilityChain([token], { ...context,
      ...(kind === 'expiry' ? { now: Date.now() + 20000 } : {}),
      ...(kind === 'task' ? { taskId: 'task_other' } : {}),
    })).toThrow('CAPABILITY_VIOLATION');
  });
});

describe('Worker capability admission', () => {
  it.each(['scope', 'expiry', 'task'] as const)('rejects a %s violation before executing', async (kind) => {
    const { owner, requester, worker, client, calls } = setup();
    await worker.register();
    const expiresAt = new Date(Date.now() + 60000).toISOString();
    const manifest = buildTaskManifest({ ownerDid: requester.did, workerDid: owner.did,
      taskType: 'json',
      title: task.title, description: task.description,
      capabilities: [{ capabilityId: 'cap_read', resource: 'data://allowed', allowedTools: ['read'],
        argConstraints: {}, maxInvocations: 1, expiresAt }] });
    const token = createCapability({ audience: owner.did, taskId: manifest.taskId, resource: 'data://allowed',
      allowedTools: ['read'], argConstraints: { read: {} }, maxCalls: 1, maxDepth: 0,
      notBefore: new Date(Date.now() - 10000).toISOString(), expiresAt }, requester);
    const bad = kind === 'scope'
      ? { ...token, payload: { ...token.payload, resource: 'data://forbidden' } }
      : signPayload({ ...token.payload,
          ...(kind === 'task' ? { taskId: 'task_other' } : { expiresAt: new Date(Date.now() - 1000).toISOString() }),
        }, requester);
    const done = worker.start({ once: true }).catch((error: Error) => error);
    try {
      await expect(client.delegate({ ...task, to: owner.did, manifest, capabilityChains: [[bad]] }))
        .rejects.toThrow('CAPABILITY');
      expect(await done).toBeInstanceOf(Error);
      expect(calls()).toBe(0);
    } finally { worker.stop(); }
  });
});
