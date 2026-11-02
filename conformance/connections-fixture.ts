// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { digest, generateKeyPair, signEnvelope, signPayload } from '../packages/core/src/index.js';
import type { TaskManifest } from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { WorkerNode, RequesterClient, PolicyAutoApprovalProvider, WorkerTrustStore, HeldRequestReview,
  buildTaskManifest, workerIntakePath } from '../packages/runtime/src/index.js';
import type { WorkerNodeOptions, HeldContentReviewProvider } from '../packages/runtime/src/index.js';
export const completeInspection: HeldContentReviewProvider = { async inspect(_envelope, context) {
  return { ownerDid: context.owner.did, contentDigest: context.contentDigest, envelopeDigest: context.envelopeDigest,
    kind: context.kind, status: 'complete', reportDigest: digest({ report: context.contentDigest }) };
} };
export function admissionFixture(options: Partial<WorkerNodeOptions> = {}, inspect = false) {
  const root = mkdtempSync(join(tmpdir(), 'connections-admission-'));
  const identityOptions = { env: { SEALBRIDGE_DATA_DIR: root } };
  const owner = generateKeyPair(), requester = generateKeyPair(), relay = new InMemoryRelay();
  const store = new WorkerTrustStore(owner, { path: workerIntakePath(owner.did, identityOptions), now: options.now });
  const review = new HeldRequestReview(owner, { ...identityOptions, now: options.now, provider: inspect ? completeInspection : undefined });
  const execute = vi.fn(async (c: { input: unknown }) => c.input as never);
  const automatic = new PolicyAutoApprovalProvider(owner), approve = vi.spyOn(automatic, 'approve');
  const human = { approve: vi.fn(automatic.approve.bind(automatic)) };
  const worker = new WorkerNode({ owner, relay, relayUrl: 'https://relay.example', intakeStore: store, heldReview: review,
    timeoutMs: 1000, approvalProvider: automatic, ownerApprovalProvider: human,
    adapter: { id: 'echo', name: 'Echo', skills: [{ id: 'echo', name: 'Echo', taskTypes: ['json'] }], executeTask: execute }, ...options });
  const client = new RequesterClient({ owner: requester, relay, timeoutMs: 1000,
    approvalProvider: new PolicyAutoApprovalProvider(requester) });
  const task = { title: 'Review task', description: 'Review description', input: { content: 'held content' } };
  async function attempt(to = owner.did, extra = {}) {
    const results = await Promise.allSettled([client.delegate({ ...task, to, ...extra }), worker.start({ once: true })]);
    return results;
  }
  function manifest(version: '0.1.0' | '0.2.0' = '0.2.0'): TaskManifest {
    return buildTaskManifest({ ...task, ownerDid: requester.did, workerDid: owner.did, protocolVersion: version, now: options.now });
  }
  async function raw(m = manifest(), token?: string) {
    relay.send(signEnvelope({ taskId: m.taskId, recipientDid: owner.did, seq: 0, eventType: 'PROPOSE',
      payload: { proposal: signPayload(m, requester), input: task.input, capabilityChains: [], ...(token ? { inviteToken: token } : {}) } as never }, requester, { encrypt: true }));
    return worker.runOnce();
  }
  return { root, identityOptions, owner, requester, relay, store, review, worker, client, execute, approve, human, task,
    attempt, manifest, raw, cleanup: () => { worker.stop(); rmSync(root, { recursive: true, force: true }); } };
}
