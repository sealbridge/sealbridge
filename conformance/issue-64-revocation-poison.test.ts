// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  CapabilityGuard,
  createCapability,
  createRevocationNotice,
  generateKeyPair,
  RevocationRegistry,
  signPayload,
} from '../packages/core/src/index.js';
import type { CapabilityToken, Json, KeyPair, TaskManifest } from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import {
  PolicyAutoApprovalProvider,
  RequesterClient,
  WorkerNode,
  buildTaskManifest,
  deliverRevocation,
} from '../packages/runtime/src/index.js';

function echoWorker(owner: KeyPair, relay: InMemoryRelay, calls: Json[], events: string[]) {
  return new WorkerNode({ checkPeer: () => 'trusted',
    owner,
    relay,
    adapter: {
      id: 'issue-64-echo',
      name: 'Issue 64 echo',
      skills: [],
      executeTask: async (context) => {
        calls.push(context.input);
        return context.input;
      },
    },
    approvalProvider: new PolicyAutoApprovalProvider(owner),
    timeoutMs: 10000,
    onEvent: (event) => events.push(event),
  });
}

function requester(owner: KeyPair, relay: InMemoryRelay) {
  return new RequesterClient({
    owner,
    relay,
    approvalProvider: new PolicyAutoApprovalProvider(owner),
    timeoutMs: 10000,
  });
}

function grant(expiresAt: string): TaskManifest['permissions']['grantedCapabilities'][number] {
  return {
    capabilityId: 'cap_docs',
    resource: 'mcp://docs/item',
    allowedTools: ['echo'],
    argConstraints: { type: 'object' },
    maxInvocations: 2,
    expiresAt,
  };
}

function capabilityChain(
  manifest: TaskManifest,
  issuer: KeyPair,
  audience: string,
): CapabilityToken[] {
  const issued = manifest.permissions.grantedCapabilities[0]!;
  const root = createCapability(
    {
      audience: issuer.did,
      taskId: manifest.taskId,
      resource: issued.resource,
      allowedTools: issued.allowedTools,
      argConstraints: Object.fromEntries(
        issued.allowedTools.map((tool) => [tool, issued.argConstraints ?? { type: 'object' }]),
      ),
      maxCalls: issued.maxInvocations,
      notBefore: manifest.createdAt,
      expiresAt: issued.expiresAt,
      maxDepth: 1,
    },
    issuer,
  );
  const leaf = createCapability({ ...root.payload, audience, maxDepth: 0 }, issuer, root);
  return [root, leaf];
}

/** Root is Alice, the intermediate and the leaf are Carol, audience is the worker. */
function delegatedChain(
  manifest: TaskManifest,
  alice: KeyPair,
  carol: KeyPair,
  audience: string,
): CapabilityToken[] {
  const issued = manifest.permissions.grantedCapabilities[0]!;
  const shared = {
    taskId: manifest.taskId,
    resource: issued.resource,
    allowedTools: issued.allowedTools,
    argConstraints: Object.fromEntries(
      issued.allowedTools.map((tool) => [tool, issued.argConstraints ?? { type: 'object' }]),
    ),
    maxCalls: issued.maxInvocations,
    notBefore: manifest.createdAt,
    expiresAt: issued.expiresAt,
  };
  const root = createCapability({ ...shared, audience: carol.did, maxDepth: 2 }, alice);
  const mid = createCapability({ ...root.payload, audience: carol.did, maxDepth: 1 }, carol, root);
  const leaf = createCapability({ ...mid.payload, audience, maxDepth: 0 }, carol, mid);
  return [root, mid, leaf];
}

function manifestFor(requesterDid: string, worker: WorkerNode, expiresAt: string) {
  return buildTaskManifest({
    ownerDid: requesterDid,
    workerDid: worker.options.owner.did,
    agentDid: worker.agentCard.payload.agentDid,
    title: 'Issue 64',
    description: 'Capability revocation must follow a verified chain',
    capabilities: [grant(expiresAt)],
  });
}

function delegation(
  client: RequesterClient,
  invite: string,
  manifest: TaskManifest,
  chain: CapabilityToken[][],
  input: Json,
) {
  return client.delegate({
    to: invite,
    title: manifest.task.title,
    description: manifest.task.description,
    input,
    manifest,
    capabilityChains: chain,
  });
}

describe('issue 64: unverified capability revocation', () => {
  it.each([false, true])(
    'does not commit a third-party REVOKE when the presented chain is unverified (poison=%s)',
    async (poison) => {
      const alice = generateKeyPair();
      const bob = generateKeyPair();
      const mallory = generateKeyPair();
      const relay = new InMemoryRelay();
      const calls: Json[] = [];
      const events: string[] = [];
      const worker = echoWorker(bob, relay, calls, events);
      const invite = worker.invite();
      const expiresAt = new Date(Date.now() + 60000).toISOString();
      const manifest = manifestFor(alice.did, worker, expiresAt);
      const chain = capabilityChain(manifest, alice, bob.did);
      const target = chain[1]!.payload.id;
      const fake = structuredClone(chain);
      if (poison) fake[1]!.payload.issuer = mallory.did;
      const running = worker.start();
      try {
        await requester(mallory, relay).sendRevocation({
          to: bob.did,
          targetType: 'capability',
          targetId: target,
          reason: poison ? 'mutated-issuer' : 'cloned-chain',
        });
        const spoofed = await delegation(
          requester(mallory, relay),
          invite,
          manifestFor(mallory.did, worker, expiresAt),
          [fake],
          { poisoned: true },
        ).then(
          () => 'settled' as const,
          (error: unknown) => error,
        );
        expect(spoofed).not.toBe('settled');
        expect(calls).toEqual([]);
        expect(worker.revocation.isRevoked('capability', target)).toBe(false);
        const result = await delegation(requester(alice, relay), invite, manifest, [chain], {
          ok: true,
        });
        expect(calls).toEqual([{ ok: true }]);
        expect(events).toContain('ACCEPT');
        expect(result.state).toBe('SETTLED');
        expect(worker.revocation.isRevoked('capability', target)).toBe(false);
      } finally {
        worker.stop();
        await running.catch(() => undefined);
      }
    },
  );

  it('consumes a third-party REVOKE and still settles Alice on the same worker and relay', async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const mallory = generateKeyPair();
    const relay = new InMemoryRelay();
    const calls: Json[] = [];
    const events: string[] = [];
    const worker = echoWorker(bob, relay, calls, events);
    const invite = worker.invite();
    const expiresAt = new Date(Date.now() + 60000).toISOString();
    const manifest = manifestFor(alice.did, worker, expiresAt);
    const chain = capabilityChain(manifest, alice, bob.did);
    const target = chain[1]!.payload.id;
    const running = worker.start();
    try {
      await requester(mallory, relay).sendRevocation({
        to: bob.did,
        targetType: 'capability',
        targetId: target,
        reason: 'direct-spoof',
      });
      const aliceClient = requester(alice, relay);
      const first = await delegation(aliceClient, invite, manifest, [chain], { ok: true });
      expect(first.state).toBe('SETTLED');
      expect(worker.revocation.isRevoked('capability', target)).toBe(false);
      const again = manifestFor(alice.did, worker, expiresAt);
      const secondChain = capabilityChain(again, alice, bob.did);
      const second = await delegation(aliceClient, invite, again, [secondChain], { again: true });
      expect(second.state).toBe('SETTLED');
      expect(calls).toEqual([{ ok: true }, { again: true }]);
      expect(worker.revocation.isRevoked('capability', secondChain[1]!.payload.id)).toBe(false);
    } finally {
      worker.stop();
      await running.catch(() => undefined);
    }
  });

  it('does not let Mallory revoke Alice by signing a token that reuses the target id', async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const mallory = generateKeyPair();
    const relay = new InMemoryRelay();
    const registry = new RevocationRegistry();
    const calls: Json[] = [];
    const events: string[] = [];
    const worker = new WorkerNode({ checkPeer: () => 'trusted',
      owner: bob,
      relay,
      adapter: {
        id: 'issue-64-echo',
        name: 'Issue 64 echo',
        skills: [],
        executeTask: async (context) => {
          calls.push(context.input);
          return context.input;
        },
      },
      approvalProvider: new PolicyAutoApprovalProvider(bob),
      timeoutMs: 10000,
      onEvent: (event) => events.push(event),
      revocation: registry,
    });
    const invite = worker.invite();
    const expiresAt = new Date(Date.now() + 60000).toISOString();
    const manifest = manifestFor(alice.did, worker, expiresAt);
    const chain = capabilityChain(manifest, alice, bob.did);
    const target = chain[1]!.payload.id;
    const running = worker.start();
    try {
      await requester(mallory, relay).sendRevocation({
        to: bob.did,
        targetType: 'capability',
        targetId: target,
        reason: 'colliding-id',
      });
      const malloryManifest = manifestFor(mallory.did, worker, expiresAt);
      const forged = signPayload(
        {
          ...chain[1]!.payload,
          id: target,
          issuer: mallory.did,
          audience: bob.did,
          taskId: malloryManifest.taskId,
          parentHash: null,
          maxDepth: 0,
          notBefore: malloryManifest.createdAt,
          expiresAt,
        },
        mallory,
      );
      const spoofed = await delegation(
        requester(mallory, relay),
        invite,
        malloryManifest,
        [[forged]],
        { forged: true },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(spoofed).toBeInstanceOf(Error);
      expect(String(spoofed)).toContain('TOKEN_REVOKED');
      expect(calls).toEqual([]);
      expect(events).not.toContain('ACCEPT');
      const context = { rootDid: alice.did, audience: bob.did, taskId: manifest.taskId };
      const guard = new CapabilityGuard(worker.revocation);
      expect(() => guard.authorize(chain, context, 'echo', {}, 'mcp://docs/item')).not.toThrow();
      expect(() =>
        new CapabilityGuard(registry).authorize(chain, context, 'echo', {}, 'mcp://docs/item'),
      ).not.toThrow();
      const result = await delegation(requester(alice, relay), invite, manifest, [chain], {
        ok: true,
      });
      expect(calls).toEqual([{ ok: true }]);
      expect(result.state).toBe('SETTLED');
      expect(events).toContain('ACCEPT');
    } finally {
      worker.stop();
      await running.catch(() => undefined);
    }
  });

  it.each(['inbox', 'deliver'] as const)(
    'still rejects a capability revoked by its issuer via %s before PROPOSE',
    async (channel) => {
      const alice = generateKeyPair();
      const bob = generateKeyPair();
      const relay = new InMemoryRelay();
      const calls: Json[] = [];
      const events: string[] = [];
      const worker = echoWorker(bob, relay, calls, events);
      const invite = worker.invite();
      const expiresAt = new Date(Date.now() + 60000).toISOString();
      const manifest = manifestFor(alice.did, worker, expiresAt);
      const chain = capabilityChain(manifest, alice, bob.did);
      const target = chain[1]!.payload.id;
      if (channel === 'inbox') {
        await requester(alice, relay).sendRevocation({
          to: bob.did,
          targetType: 'capability',
          targetId: target,
          reason: 'issuer-inbox',
        });
      } else {
        await deliverRevocation({
          relay,
          from: alice,
          recipientDid: bob.did,
          notice: createRevocationNotice(
            { targetType: 'capability', targetId: target, reason: 'issuer-deliver' },
            alice,
          ),
        });
      }
      const pending = worker.runOnce();
      const delegation = requester(alice, relay).delegate({
        to: invite,
        title: manifest.task.title,
        description: manifest.task.description,
        input: { ok: true },
        manifest,
        capabilityChains: [chain],
      });
      const [settled, rejected] = await Promise.allSettled([pending, delegation]);
      worker.stop();
      expect(calls).toEqual([]);
      expect(events).not.toContain('ACCEPT');
      expect(worker.revocation.isRevoked('capability', target)).toBe(true);
      expect(rejected.status).toBe('rejected');
      expect(settled.status).toBe('rejected');
      if (rejected.status === 'rejected')
        expect(String(rejected.reason)).toContain('TOKEN_REVOKED');
      if (settled.status === 'rejected') expect(String(settled.reason)).toContain('TOKEN_REVOKED');
    },
  );

  it.each(['root', 'intermediate'] as const)(
    'rejects a delegated capability revoked by its %s issuer',
    async (who) => {
      const alice = generateKeyPair();
      const carol = generateKeyPair();
      const bob = generateKeyPair();
      const relay = new InMemoryRelay();
      const calls: Json[] = [];
      const events: string[] = [];
      const worker = echoWorker(bob, relay, calls, events);
      const invite = worker.invite();
      const expiresAt = new Date(Date.now() + 60000).toISOString();
      const manifest = manifestFor(alice.did, worker, expiresAt);
      const chain = delegatedChain(manifest, alice, carol, bob.did);
      const target = chain[2]!.payload.id;
      const revoker = who === 'root' ? alice : carol;
      await deliverRevocation({
        relay,
        from: revoker,
        recipientDid: bob.did,
        notice: createRevocationNotice(
          { targetType: 'capability', targetId: target, reason: who },
          revoker,
        ),
      });
      const pending = worker.runOnce();
      const delegation = requester(alice, relay).delegate({
        to: invite,
        title: manifest.task.title,
        description: manifest.task.description,
        input: { ok: true },
        manifest,
        capabilityChains: [chain],
      });
      const [settled, rejected] = await Promise.allSettled([pending, delegation]);
      worker.stop();
      expect(calls).toEqual([]);
      expect(events).not.toContain('ACCEPT');
      expect(worker.revocation.isRevoked('capability', target)).toBe(true);
      expect(rejected.status).toBe('rejected');
      expect(settled.status).toBe('rejected');
      if (rejected.status === 'rejected')
        expect(String(rejected.reason)).toContain('TOKEN_REVOKED');
      if (settled.status === 'rejected') expect(String(settled.reason)).toContain('TOKEN_REVOKED');
    },
  );
});

describe('capability revocation issuer scope', () => {
  it('does not let one issuer replace or apply another issuer notice for the same id', () => {
    const alice = generateKeyPair();
    const mallory = generateKeyPair();
    const bob = generateKeyPair();
    const expiresAt = new Date(Date.now() + 60000).toISOString();
    const manifest = buildTaskManifest({
      ownerDid: alice.did,
      workerDid: bob.did,
      agentDid: bob.did,
      title: 'scope',
      description: 'issuer scoped revocation',
      capabilities: [grant(expiresAt)],
    });
    const chain = capabilityChain(manifest, alice, bob.did);
    const target = chain[1]!.payload.id;
    const registry = new RevocationRegistry();
    registry.revoke(
      createRevocationNotice(
        { targetType: 'capability', targetId: target, reason: 'mallory' },
        mallory,
      ),
    );
    registry.revoke(
      createRevocationNotice(
        { targetType: 'capability', targetId: target, reason: 'alice' },
        alice,
      ),
    );
    const issuers = registry
      .noticesFor('capability', target)
      .map((notice) => notice.payload.issuerDid);
    expect(issuers).toEqual(expect.arrayContaining([alice.did, mallory.did]));
    expect(issuers).toHaveLength(2);
    const context = { rootDid: alice.did, audience: bob.did, taskId: chain[0]!.payload.taskId };
    expect(() =>
      new CapabilityGuard(registry).authorize(chain, context, 'echo', {}, 'mcp://docs/item'),
    ).toThrow('TOKEN_REVOKED');
    const onlyMallory = new RevocationRegistry();
    onlyMallory.revoke(
      createRevocationNotice(
        { targetType: 'capability', targetId: target, reason: 'mallory' },
        mallory,
      ),
    );
    expect(onlyMallory.isRevoked('capability', target)).toBe(true);
    expect(() =>
      new CapabilityGuard(onlyMallory).authorize(chain, context, 'echo', {}, 'mcp://docs/item'),
    ).not.toThrow();
  });
});
