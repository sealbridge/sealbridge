// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLOCK_SKEW_MS,
  createCapability,
  createInviteToken,
  createSignedAgentCard,
  generateKeyPair,
  parseAndVerifyInviteToken,
  verifyCapabilityChain,
} from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import {
  PolicyAutoApprovalProvider,
  RequesterClient,
  WorkerNode,
  buildTaskManifest,
} from '../packages/runtime/src/index.js';

describe('clock skew tolerance and pre-wire PROPOSE error return', () => {
  it('tolerates up to DEFAULT_CLOCK_SKEW_MS on invite issuedAt and rejects beyond it', () => {
    const owner = generateKeyPair();
    const baseNow = Date.now();
    const issuedAt = new Date(baseNow + 30_000).toISOString();
    const card = createSignedAgentCard(
      {
        name: 'Skewed Worker',
        agentDid: owner.did,
        relayEndpoint: 'https://relay.example.com',
        skills: [{ id: 'json-task', name: 'JSON task' }],
        expiresAt: new Date(baseNow + 3_600_000).toISOString(),
      },
      owner,
    );
    const invite = createInviteToken({ agentCard: card, issuedAt, expiresInSeconds: 600 }, owner);

    // Within 60s clock skew tolerance (30s ahead of verifier clock)
    expect(parseAndVerifyInviteToken(invite, baseNow).ownerDid).toBe(owner.did);

    // Beyond 60s clock skew tolerance (61s ahead of verifier clock)
    expect(() =>
      parseAndVerifyInviteToken(invite, Date.parse(issuedAt) - DEFAULT_CLOCK_SKEW_MS - 1_000),
    ).toThrow('INVALID_OR_EXPIRED_INVITE');
  });

  it('tolerates up to DEFAULT_CLOCK_SKEW_MS on capability notBefore and rejects beyond it', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const baseNow = Date.now();
    const notBefore = new Date(baseNow + 30_000).toISOString();
    const expiresAt = new Date(baseNow + 600_000).toISOString();
    const token = createCapability(
      {
        audience: bob.did,
        taskId: 'task_clockskew01',
        resource: 'mcp://alice/docs/*',
        allowedTools: ['docs/read'],
        argConstraints: { 'docs/read': { type: 'object' } },
        maxCalls: 2,
        notBefore,
        expiresAt,
        maxDepth: 0,
      },
      alice,
    );

    expect(
      verifyCapabilityChain([token], {
        rootDid: alice.did,
        audience: bob.did,
        taskId: 'task_clockskew01',
        now: baseNow,
      }).payload.id,
    ).toBe(token.payload.id);

    expect(() =>
      verifyCapabilityChain([token], {
        rootDid: alice.did,
        audience: bob.did,
        taskId: 'task_clockskew01',
        now: Date.parse(notBefore) - DEFAULT_CLOCK_SKEW_MS - 1_000,
      }),
    ).toThrow(/CAPABILITY_VIOLATION/);
  });

  it('settles a session when requester createdAt and capability notBefore are slightly ahead of worker clock', async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const relay = new InMemoryRelay();
    const worker = new WorkerNode({ checkPeer: () => 'trusted',
      owner: bob,
      relay,
      adapter: {
        id: 'echo',
        name: 'Echo',
        skills: [{ id: 'json-task', name: 'JSON task' }],
        executeTask: async (ctx) => ({ echoed: ctx.input }),
      },
      approvalProvider: new PolicyAutoApprovalProvider(bob),

      timeoutMs: 10_000,
    });
    const requester = new RequesterClient({
      owner: alice,
      relay,
      approvalProvider: new PolicyAutoApprovalProvider(alice),
      timeoutMs: 10_000,
    });
    const futureCreatedAt = new Date(Date.now() + 15_000).toISOString();
    const futureDeadline = new Date(Date.now() + 600_000).toISOString();
    const manifest = buildTaskManifest({
      ownerDid: alice.did,
      workerDid: bob.did,
      agentDid: bob.did,
      title: 'Clock skew tolerance test',
      description: 'Requester clock is 15s ahead of worker clock',
      capabilities: [
        {
          capabilityId: 'cap_clockskew01',
          resource: 'mcp://alice/docs/*',
          allowedTools: ['docs/read'],
          maxInvocations: 1,
          expiresAt: futureDeadline,
        },
      ],
    });
    manifest.createdAt = futureCreatedAt;
    manifest.deadline = futureDeadline;

    const pending = worker.start({ once: true });
    try {
      const result = await requester.delegate({
        to: worker.invite(),
        manifest,
        title: manifest.task.title,
        description: manifest.task.description,
        input: { ping: 'skew-ok' },
      });
      await pending;
      expect(result.state).toBe('SETTLED');
      expect(result.deliverable).toEqual({ echoed: { ping: 'skew-ok' } });
    } finally {
      worker.stop();
    }
  });

  it('returns an encrypted ERROR frame immediately when pre-wire PROPOSE validation fails', async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const relay = new InMemoryRelay();
    const worker = new WorkerNode({ checkPeer: () => 'trusted',
      owner: bob,
      relay,
      adapter: {
        id: 'echo',
        name: 'Echo',
        skills: [{ id: 'json-task', name: 'JSON task' }],
        executeTask: async (ctx) => ({ echoed: ctx.input }),
      },
      approvalProvider: new PolicyAutoApprovalProvider(bob),

      timeoutMs: 30_000,
    });
    const requester = new RequesterClient({
      owner: alice,
      relay,
      approvalProvider: new PolicyAutoApprovalProvider(alice),
      timeoutMs: 30_000,
    });

    // createdAt is 5 minutes in the future (exceeds DEFAULT_CLOCK_SKEW_MS)
    const farFutureManifest = buildTaskManifest({
      ownerDid: alice.did,
      workerDid: bob.did,
      agentDid: bob.did,
      title: 'Far future proposal',
      description: 'Should be rejected before SessionWire with an immediate ERROR frame',
    });
    farFutureManifest.createdAt = new Date(Date.now() + DEFAULT_CLOCK_SKEW_MS + 300_000).toISOString();

    void worker.start();
    const startedAt = Date.now();
    try {
      await expect(
        requester.delegate({
          to: worker.invite(),
          manifest: farFutureManifest,
          title: farFutureManifest.task.title,
          description: farFutureManifest.task.description,
          input: { test: 'pre-wire-reject' },
        }),
      ).rejects.toThrow(/PEER_REJECTED.*"code":"INVALID"/);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      worker.stop();
    }
  });
});
