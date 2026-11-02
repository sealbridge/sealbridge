// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  createContract,
  decryptEnvelopePayload,
  generateKeyPair,
  isEncryptedEnvelopePayload,
  openEnvelope,
  signApproval,
  signEnvelope,
  signPayload,
  signUsage,
} from '../packages/core/src/index.js';
import type { Json, KeyPair, SignedEnvelope } from '../packages/core/src/index.js';
import { verifyAudit } from '../packages/ledger/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import {
  ApprovalGate,
  PolicyAutoApprovalProvider,
  RequesterClient,
  VerificationEngine,
  WorkerNode,
  buildTaskManifest,
  createDelivery,
} from '../packages/runtime/src/index.js';

function header(envelope: SignedEnvelope) {
  return {
    taskId: envelope.payload.taskId,
    seq: envelope.payload.seq,
    eventType: envelope.payload.eventType,
    senderDid: envelope.payload.senderDid,
    recipientDid: envelope.payload.recipientDid,
  };
}

function clearEnvelope(
  sender: KeyPair,
  recipientDid: string,
  eventType: string,
  taskId: string,
  seq = 0,
  payload: Json = { cleartext: true },
): SignedEnvelope {
  return signEnvelope({ taskId, recipientDid, seq, eventType, payload }, sender);
}

async function nextEnvelope(relay: InMemoryRelay, did: string): Promise<SignedEnvelope> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const envelope = relay.receive(did);
    if (envelope) return envelope;
    if (Date.now() > deadline) throw new Error('TIMED_OUT_WAITING_FOR_ENVELOPE');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function clearDelivery(owner: KeyPair, worker: KeyPair) {
  const manifest = buildTaskManifest({
    ownerDid: owner.did,
    workerDid: worker.did,
    title: 'Cleartext delivery',
    description: 'Unit fixture with an unencrypted DELIVER envelope',
    outputSchema: { type: 'object' },
  });
  const contract = createContract(manifest, signPayload(manifest, owner), worker);
  const usage = signUsage(
    {
      type: 'UsageReceipt',
      taskId: manifest.taskId,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCalls: 0,
      wallTimeMs: 0,
      halted: false,
    },
    worker,
  );
  const delivery = createDelivery(
    manifest.taskId,
    contract.contractDigest,
    { ok: true },
    usage,
    worker,
    { effectiveIsolationLevel: 'subprocess_restricted' },
  );
  return {
    contract,
    envelope: clearEnvelope(
      worker,
      owner.did,
      'DELIVER',
      manifest.taskId,
      1,
      delivery as unknown as Json,
    ),
    gate: new ApprovalGate(owner.did, { requiredGates: [], autoApprove: [] }),
    approval: signApproval(manifest.taskId, 'final_verification', delivery, owner),
  };
}

describe('P1-8 require encrypted envelopes', () => {
  it('rejects a cleartext payload unless requireEncrypted is explicitly false', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const plain = clearEnvelope(alice, bob.did, 'PING', 'task_plain_payload');
    const context = header(plain);
    expect(() => decryptEnvelopePayload(plain.payload.payload, bob, context)).toThrow(
      'UNENCRYPTED_ENVELOPE_REJECTED',
    );
    expect(() => openEnvelope(plain, bob)).toThrow('UNENCRYPTED_ENVELOPE_REJECTED');
    expect(
      decryptEnvelopePayload(plain.payload.payload, bob, context, { requireEncrypted: false }),
    ).toEqual({ cleartext: true });
    expect(openEnvelope(plain, bob, { requireEncrypted: false })).toEqual({ cleartext: true });
    const encrypted = signEnvelope(
      {
        taskId: 'task_encrypted_payload',
        recipientDid: bob.did,
        seq: 0,
        eventType: 'PING',
        payload: { secret: 'still-sealed' },
      },
      alice,
      { encrypt: true },
    );
    expect(decryptEnvelopePayload(encrypted.payload.payload, bob, header(encrypted))).toEqual({
      secret: 'still-sealed',
    });
  });

  it('rejects a cleartext PROPOSE and does not execute the task', async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const relay = new InMemoryRelay();
    let executed = 0;
    const worker = new WorkerNode({ checkPeer: () => 'trusted',
      owner: bob,
      relay,
      adapter: {
        id: 'must-not-run',
        name: 'Must not run',
        skills: [],
        executeTask: async () => {
          executed += 1;
          return { ok: true };
        },
      },
      approvalProvider: new PolicyAutoApprovalProvider(bob),
      timeoutMs: 5000,
    });
    relay.send(clearEnvelope(alice, bob.did, 'PROPOSE', 'task_clear_propose'));
    try {
      await expect(worker.start({ once: true })).rejects.toThrow('UNENCRYPTED_ENVELOPE_REJECTED');
      expect(executed).toBe(0);
      expect(worker.lastResult).toBeUndefined();
    } finally {
      worker.stop();
    }
  });

  for (const eventType of ['ACCEPT', 'PROGRESS', 'DELIVER'] as const)
    it('rejects a cleartext ' + eventType + ' and does not settle', async () => {
      const alice = generateKeyPair();
      const bob = generateKeyPair();
      const relay = new InMemoryRelay();
      const worker = new WorkerNode({ checkPeer: () => 'trusted',
        owner: bob,
        relay,
        adapter: {
          id: 'malicious-cleartext',
          name: 'Malicious cleartext',
          skills: [],
          executeTask: async () => ({ ok: true }),
        },
        approvalProvider: new PolicyAutoApprovalProvider(bob),
        timeoutMs: 5000,
      });
      const requester = new RequesterClient({
        owner: alice,
        relay,
        approvalProvider: new PolicyAutoApprovalProvider(alice),
        timeoutMs: 5000,
      });
      const pending = requester.delegate({
        to: worker.invite(),
        title: 'Cleartext ' + eventType,
        description: 'A peer answers with an unencrypted session envelope',
        input: { ok: true },
      });
      const assertion = expect(pending).rejects.toThrow('UNENCRYPTED_ENVELOPE_REJECTED');
      const propose = await nextEnvelope(relay, bob.did);
      expect(propose.payload.eventType).toBe('PROPOSE');
      expect(isEncryptedEnvelopePayload(propose.payload.payload)).toBe(true);
      relay.send(
        clearEnvelope(bob, alice.did, eventType, propose.payload.taskId, 0, {
          cleartext: eventType,
        }),
      );
      await assertion;
    });

  it('rejects a cleartext DELIVER transcript unless allowUnencryptedEnvelopes is set', async () => {
    const owner = generateKeyPair();
    const worker = generateKeyPair();
    const fixture = clearDelivery(owner, worker);
    const engine = new VerificationEngine();
    const rejected = await engine.verifyDeliverable(fixture);
    expect(rejected.accepted).toBe(false);
    expect(rejected.event).toBe('VERIFY_REJECT');
    expect(rejected.reason).toContain('UNENCRYPTED_ENVELOPE_REJECTED');
    expect(rejected.stages).toEqual([]);
    const accepted = await engine.verifyDeliverable({
      ...fixture,
      allowUnencryptedEnvelopes: true,
    });
    expect(accepted.accepted).toBe(true);
    expect(accepted.event).toBe('VERIFY_ACCEPT');
  });

  it('settles an encrypted session with a valid audit bundle', async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const relay = new InMemoryRelay();
    const traffic: SignedEnvelope[] = [];
    const send = relay.send.bind(relay);
    relay.send = (envelope) => {
      traffic.push(structuredClone(envelope));
      send(envelope);
    };
    const input = { marker: 'p1-8-session-secret' };
    const worker = new WorkerNode({ checkPeer: () => 'trusted',
      owner: bob,
      relay,
      adapter: {
        id: 'echo',
        name: 'Echo',
        skills: [],
        executeTask: async (context) => ({ echoed: context.input }),
      },
      approvalProvider: new PolicyAutoApprovalProvider(bob),
      timeoutMs: 10000,
    });
    const requester = new RequesterClient({
      owner: alice,
      relay,
      approvalProvider: new PolicyAutoApprovalProvider(alice),
      timeoutMs: 10000,
    });
    const pending = worker.start({ once: true });
    const result = await requester.delegate({
      to: worker.invite(),
      title: 'Encrypted session',
      description: 'Echo the input through an encrypted session',
      input,
    });
    const settled = await pending;
    worker.stop();
    expect(result.state).toBe('SETTLED');
    expect(settled?.state).toBe('SETTLED');
    expect(result.deliverable).toEqual({ echoed: input });
    expect(verifyAudit(result.bundle).valid).toBe(true);
    expect(verifyAudit(settled!.bundle).valid).toBe(true);
    expect(traffic.length).toBeGreaterThan(0);
    for (const envelope of traffic)
      expect(isEncryptedEnvelopePayload(envelope.payload.payload)).toBe(true);
    expect(JSON.stringify(traffic)).not.toContain('p1-8-session-secret');
  });
});
