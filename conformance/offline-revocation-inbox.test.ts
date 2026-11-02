// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  createCapability,
  createRevocationNotice,
  generateKeyPair,
  inviteRevocationId,
  isEncryptedEnvelopePayload,
  RevocationRegistry,
  signEnvelope,
} from '../packages/core/src/index.js';
import type {
  CapabilityToken,
  Json,
  KeyPair,
  SignedEnvelope,
  TaskManifest,
} from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import {
  PolicyAutoApprovalProvider,
  RequesterClient,
  WorkerNode,
  buildTaskManifest,
  deliverRevocation,
} from '../packages/runtime/src/index.js';
import type { RevocationList } from '../packages/core/src/index.js';

const canary = 'offline-revoke-canary-91c4';

function echoWorker(
  owner: KeyPair,
  relay: InMemoryRelay,
  calls: Json[],
  events: string[],
  revocation?: RevocationList,
) {
  return new WorkerNode({ checkPeer: () => 'trusted',
    owner,
    relay,
    adapter: {
      id: 'offline-echo',
      name: 'Offline echo',
      skills: [],
      executeTask: async (context) => {
        calls.push(context.input);
        return context.input;
      },
    },
    approvalProvider: new PolicyAutoApprovalProvider(owner),
    timeoutMs: 10000,
    onEvent: (event) => events.push(event),
    revocation,
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
  const issued = manifest.permissions.grantedCapabilities[0];
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

function manifestFor(requesterDid: string, worker: WorkerNode, expiresAt: string) {
  return buildTaskManifest({
    ownerDid: requesterDid,
    workerDid: worker.options.owner.did,
    agentDid: worker.agentCard.payload.agentDid,
    title: 'Offline revocation',
    description: 'Inbox delivery before accept',
    capabilities: [grant(expiresAt)],
  });
}

async function runWorker(worker: WorkerNode, mode: 'runOnce' | 'start') {
  if (mode === 'runOnce') return worker.runOnce();
  return worker.start({ once: true });
}

function forgedInviteRevoke(from: KeyPair, recipientDid: string, targetId: string): SignedEnvelope {
  const notice = createRevocationNotice(
    { targetType: 'invite', targetId, reason: 'forged-issuer' },
    from,
  );
  notice.payload.issuerDid = recipientDid;
  return signEnvelope(
    {
      taskId: 'revoke_forged_' + notice.payload.revocationId,
      recipientDid,
      seq: 0,
      eventType: 'REVOKE',
      payload: notice as unknown as Json,
    },
    from,
    { encrypt: true },
  );
}

describe('offline revocation inbox', () => {
  it.each(['runOnce', 'start'] as const)(
    'ingests queued invite REVOKEs before PROPOSE via %s and rejects with TOKEN_REVOKED',
    async (mode) => {
      const alice = generateKeyPair();
      const bob = generateKeyPair();
      const relay = new InMemoryRelay();
      const registry = new RevocationRegistry();
      const calls: Json[] = [];
      const events: string[] = [];
      const worker = echoWorker(bob, relay, calls, events, registry);
      const token = worker.invite();
      const owner = requester(bob, relay);
      const sent: SignedEnvelope[] = [];
      const original = relay.send.bind(relay);
      relay.send = (envelope) => {
        sent.push(structuredClone(envelope));
        original(envelope);
      };
      await owner.sendRevocation({
        to: bob.did,
        targetType: 'invite',
        targetId: token,
        reason: canary,
      });
      await deliverRevocation({
        relay,
        from: bob,
        recipientDid: bob.did,
        notice: createRevocationNotice(
          {
            targetType: 'invite',
            targetId: inviteRevocationId(token),
            reason: canary + '-digest',
          },
          bob,
        ),
      });
      relay.send = original;
      const revoke = sent.find((envelope) => envelope.payload.eventType === 'REVOKE');
      expect(revoke).toBeDefined();
      expect(isEncryptedEnvelopePayload(revoke!.payload.payload)).toBe(true);
      expect(JSON.stringify(sent)).not.toContain(canary);
      const client = requester(alice, relay);
      const pending = runWorker(worker, mode);
      const delegation = client.delegate({
        to: token,
        title: 'Revoked invite',
        description: 'Must not run',
        input: { ok: true },
      });
      const [settled, rejected] = await Promise.allSettled([pending, delegation]);
      worker.stop();
      expect(calls).toEqual([]);
      expect(events).not.toContain('ACCEPT');
      expect(registry.isRevoked('invite', token)).toBe(true);
      expect(worker.revocation.isRevoked('invite', inviteRevocationId(token))).toBe(true);
      expect(rejected.status).toBe('rejected');
      if (rejected.status === 'rejected') expect(String(rejected.reason)).toContain('TOKEN_REVOKED');
      expect(settled.status).toBe('rejected');
      if (settled.status === 'rejected') expect(String(settled.reason)).toContain('TOKEN_REVOKED');
    },
  );

  it.each(['runOnce', 'start'] as const)(
    'ingests a queued capability REVOKE before PROPOSE via %s and does not accept',
    async (mode) => {
      const alice = generateKeyPair();
      const bob = generateKeyPair();
      const mallory = generateKeyPair();
      const relay = new InMemoryRelay();
      const calls: Json[] = [];
      const events: string[] = [];
      const worker = echoWorker(bob, relay, calls, events);
      const expiresAt = new Date(Date.now() + 60000).toISOString();
      const manifest = manifestFor(alice.did, worker, expiresAt);
      const chain = capabilityChain(manifest, alice, bob.did);
      const leafId = chain[1].payload.id;
      relay.send(forgedInviteRevoke(mallory, bob.did, worker.invite()));
      await deliverRevocation({
        relay,
        from: alice,
        recipientDid: bob.did,
        notice: createRevocationNotice(
          { targetType: 'capability', targetId: leafId, reason: canary },
          alice,
        ),
      });
      const client = requester(alice, relay);
      const pending = runWorker(worker, mode);
      const delegation = client.delegate({
        to: worker.invite(),
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
      expect(worker.revocation.isRevoked('capability', leafId)).toBe(true);
      expect(rejected.status).toBe('rejected');
      if (rejected.status === 'rejected') expect(String(rejected.reason)).toContain('TOKEN_REVOKED');
      expect(settled.status).toBe('rejected');
      if (settled.status === 'rejected') expect(String(settled.reason)).toContain('TOKEN_REVOKED');
    },
  );

  it.each(['runOnce', 'start'] as const)(
    'ignores a third-party REVOKE and still accepts legitimate work via %s',
    async (mode) => {
      const alice = generateKeyPair();
      const bob = generateKeyPair();
      const mallory = generateKeyPair();
      const relay = new InMemoryRelay();
      const calls: Json[] = [];
      const events: string[] = [];
      const worker = echoWorker(bob, relay, calls, events);
      const token = worker.invite();
      const expiresAt = new Date(Date.now() + 60000).toISOString();
      const manifest = manifestFor(alice.did, worker, expiresAt);
      const chain = capabilityChain(manifest, alice, bob.did);
      const leafId = chain[1].payload.id;
      relay.send(forgedInviteRevoke(mallory, bob.did, token));
      const attacker = requester(mallory, relay);
      await attacker.sendRevocation({
        to: bob.did,
        targetType: 'invite',
        targetId: token,
        reason: 'spoof-invite',
      });
      await attacker.sendRevocation({
        to: bob.did,
        targetType: 'invite',
        targetId: inviteRevocationId(token),
        reason: 'spoof-invite-digest',
      });
      await attacker.sendRevocation({
        to: bob.did,
        targetType: 'capability',
        targetId: leafId,
        reason: 'spoof-capability',
      });
      const client = requester(alice, relay);
      const pending = runWorker(worker, mode);
      const delegation = client.delegate({
        to: token,
        title: manifest.task.title,
        description: manifest.task.description,
        input: { ok: true },
        manifest,
        capabilityChains: [chain],
      });
      const [settled, result] = await Promise.all([pending, delegation]);
      worker.stop();
      expect(calls).toEqual([{ ok: true }]);
      expect(events).toContain('ACCEPT');
      expect(settled?.state).toBe('SETTLED');
      expect(result.state).toBe('SETTLED');
      expect(worker.revocation.isRevoked('invite', token)).toBe(false);
      expect(worker.revocation.isRevoked('invite', inviteRevocationId(token))).toBe(false);
      expect(worker.revocation.isRevoked('capability', leafId)).toBe(false);
    },
  );
});
