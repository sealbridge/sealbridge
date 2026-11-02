// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { generateKeyPair, signPayload, signEnvelope, openEnvelope, createCapability,
  verifySignedAgentCard, discoverAgentCards } from '../packages/core/src/index.js';
import type { Json, SignedEnvelope } from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { WorkerNode, PolicyAutoApprovalProvider, buildTaskManifest } from '../packages/runtime/src/index.js';
import type { WorkerNodeOptions } from '../packages/runtime/src/session.js';
import { SessionWire } from '../packages/runtime/src/session-audit.js';

function fixture(options: Partial<WorkerNodeOptions> = {}) {
  const owner = generateKeyPair(), attacker = generateKeyPair(), relay = new InMemoryRelay();
  let calls = 0;
  const worker = new WorkerNode({ owner, relay, timeoutMs: 1000,
    approvalProvider: new PolicyAutoApprovalProvider(owner),
    adapter: { id: 'summary', name: 'Summary', skills: [{ id: 'summary', name: 'Summary', taskTypes: ['summarize'] }],
      executeTask: async () => { calls++; return {}; } }, ...options });
  const manifest = buildTaskManifest({ ownerDid: attacker.did, workerDid: owner.did,
    title: 'Adversarial proposal', description: 'Boundary test', skillId: 'summary', taskType: 'summarize' });
  return { owner, attacker, relay, worker, manifest, calls: () => calls };
}
type Fixture = ReturnType<typeof fixture>;
async function rejected(f: Fixture, mutate: (body: any) => void, expected: RegExp,
  options: { plaintext?: boolean; envelope?: (e: SignedEnvelope) => SignedEnvelope } = {}) {
  const body = { proposal: signPayload(f.manifest, f.attacker), input: {}, capabilityChains: [] };
  mutate(body);
  let envelope = signEnvelope({ taskId: f.manifest.taskId, recipientDid: f.owner.did,
    seq: 0, eventType: 'PROPOSE', payload: body as unknown as Json }, f.attacker,
    { encrypt: !options.plaintext });
  if (options.envelope) envelope = options.envelope(envelope);
  const responses: SignedEnvelope[] = [];
  const send = f.relay.send.bind(f.relay);
  f.relay.send = (e) => { if (e.payload.senderDid === f.owner.did) responses.push(e); return send(e); };
  const controller = new AbortController();
  const wire = new SessionWire(f.relay, f.attacker, f.owner.did, f.manifest.taskId,
    [f.attacker.did, f.owner.did], controller.signal);
  // Inject malformed frames at receive so relay validation cannot mask worker validation.
  const receive = f.relay.receive.bind(f.relay);
  let injected = false;
  if (options.plaintext || options.envelope) {
    f.relay.receive = (...args) => {
      if (!injected) { injected = true; return envelope; }
      return receive(...args);
    };
  }
  const sent = options.plaintext || options.envelope ? Promise.resolve() :
    wire.sendEvent('PROPOSE', body).catch(() => {});
  try {
    await expect(f.worker.start({ once: true })).rejects.toThrow(expected);
    expect(f.calls()).toBe(0);
    expect(responses.some((e) => e.payload.eventType === 'ACCEPT')).toBe(false);
    if (!options.envelope) {
      const error = responses.find((e) => e.payload.eventType === 'ERROR');
      expect(error).toBeDefined();
      expect(error!.payload.payload).toMatchObject({ __acpEncrypted: 'X25519-HKDF-AES256GCM' });
      expect(openEnvelope(error!, f.attacker)).toHaveProperty('code');
      if (options.plaintext)
        expect(openEnvelope(error!, f.attacker)).toEqual({ code: 'UNENCRYPTED_ENVELOPE_REJECTED' });
    }
  } finally { f.worker.stop(); controller.abort(); await sent; }
}

describe('Task admission boundaries', () => {
  it('rejects capability admission without a matching manifest grant', async () => {
    const f = fixture();
    await rejected(f, (body) => {
      body.capabilityChains = [[createCapability({ audience: f.owner.did, taskId: f.manifest.taskId,
        resource: 'data://summary', allowedTools: ['read'], argConstraints: { read: {} }, maxCalls: 1,
        maxDepth: 0, notBefore: new Date(Date.now() - 1000).toISOString(),
        expiresAt: f.manifest.deadline }, f.attacker)]];
    }, /CAPABILITY/);
  });
  it('retains the requester allowlist', async () => {
    const f = fixture({ allowedRequesterDids: [generateKeyPair().did] });
    await rejected(f, () => {}, /not allowed|allowlist/);
  });
  it.each(['ownerDid', 'agentDid'] as const)('rejects Worker A identity replay to Worker B: %s', async (field) => {
    const f = fixture(), a = fixture();
    f.manifest.worker![field] = a.worker.agentCard.payload[field];
    await rejected(f, () => {}, /INVALID_PROPOSAL/);
  });
  it.each(['ownerDid', 'agentDid', 'accessMode'] as const)('rejects a forged signed card field: %s', (field) => {
    const f = fixture();
    const card = structuredClone(f.worker.agentCard);
    Object.assign(card.payload, { [field]: field === 'accessMode' ? 'invite-only' : generateKeyPair().did });
    expect(verifySignedAgentCard(card)).toBe(false);
    expect(discoverAgentCards([card])).toEqual([]);
  });
  it.each(['skill', 'type', 'omitted'] as const)('rejects task scope escalation: %s', async (kind) => {
    const f = fixture();
    if (kind === 'skill') f.manifest.task.skillId = 'shell-exec';
    if (kind === 'type') f.manifest.task.taskType = 'shell-exec';
    if (kind === 'omitted') delete f.manifest.task.taskType;
    await rejected(f, () => {}, /TASK_SCOPE_REJECTED/);
  });
  it.each(['maxInputTokens', 'maxOutputTokens', 'maxToolInvocations', 'maxWallClockSeconds'] as const)
    ('rejects budget escalation: %s', async (field) => {
      const f = fixture({ [field]: 1 });
      f.manifest.budget[field] = 2;
      await rejected(f, () => {}, /exceeds worker limit/);
    });
  it('rejects an expired deadline', async () => {
    const f = fixture(); f.manifest.deadline = new Date(Date.now() - 1).toISOString();
    await rejected(f, () => {}, /INVALID_PROPOSAL/);
  });
  it('rejects an oversized manifest description', async () => {
    const f = fixture(); f.manifest.task.description = 'x'.repeat(32769);
    await rejected(f, () => {}, /VALIDATION|SCHEMA|invalid|schema/i);
  });
  it('rejects a proposal rebound to another envelope task', async () => {
    const f = fixture();
    await rejected(f, (body) => { body.proposal = signPayload({ ...f.manifest, taskId: 'task_other123' }, f.attacker); }, /INVALID_PROPOSAL/);
  });
  it('rejects a capability captured from another task', async () => {
    const f = fixture();
    f.manifest.permissions.grantedCapabilities = [{ capabilityId: 'cap_read', resource: 'data://summary',
      allowedTools: ['read'], maxInvocations: 1, expiresAt: f.manifest.deadline }];
    await rejected(f, (body) => { body.capabilityChains = [[createCapability({ audience: f.owner.did,
      taskId: 'task_other123', resource: 'data://summary', allowedTools: ['read'], argConstraints: { read: {} },
      maxCalls: 1, maxDepth: 0, notBefore: new Date(Date.now() - 1000).toISOString(), expiresAt: f.manifest.deadline }, f.attacker)]]; }, /CAPABILITY/);
  });
  it('rejects plaintext with an encrypted error', async () => {
    await rejected(fixture(), () => {}, /UNENCRYPTED_ENVELOPE_REJECTED/, { plaintext: true });
  });
  it('rejects a tampered inner signature with an encrypted error', async () => {
    await rejected(fixture(), (body) => { body.proposal.payload.task.title = 'tampered'; }, /INVALID_PROPOSAL/);
  });
  it('rejects a tampered envelope signature without execution', async () => {
    await rejected(fixture(), () => {}, /INVALID_PROPOSAL_ENVELOPE/, {
      envelope: (e) => ({ ...e, signature: { ...e.signature, signature: 'ed25519:invalid' } }),
    });
  });
});
