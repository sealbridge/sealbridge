// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { Mock } from 'vitest';
import type { ApprovalProvider } from '../packages/runtime/src/approval-providers.js';
import { generateKeyPair, signEnvelope, signPayload, deliveryStatusRoutingId, signDeliveryStatus } from '../packages/core/src/index.js';
import type { DeliveryStatus, Json, SignedEnvelope } from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import type { RelayTransport } from '../packages/relay/src/index.js';
import { GatewayDeliveryService, WorkerNode, RequesterClient, HeldRequestReview, WorkerTrustStore, PolicyAutoApprovalProvider,
  buildTaskManifest, workerIntakePath } from '../packages/runtime/src/index.js';
import { completeInspection } from './connections-fixture.js';
export const statusRelayUrl = 'https://relay.example';
export function statusFixture(inspect = true) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'delivery-status-'));
  const identityOptions = { env: { SEALBRIDGE_DATA_DIR: join(root, 'data') } };
  const sender = generateKeyPair(), recipient = generateKeyPair();
  let now = Date.now(); const epoch = now;
  // Delivery lifecycle tests control their own clock, independently of release packaging.
  const protocolPolicy = { releasedAt: new Date(epoch).toISOString(),
    sendLegacyUntilDays: 90, receiveLegacyUntilDays: 180 } as const;
  const relay = new InMemoryRelay({ now: () => now, envelopeTtlMs: 86400_000 });
  const frames: SignedEnvelope[] = [];
  const transport: RelayTransport = {
    register: card => relay.register(card), discover: () => relay.discover(),
    send: e => { frames.push(structuredClone(e)); relay.send(e); },
    receive: (did, _wait, signal, filter) => relay.receive(did, undefined, signal, undefined, filter),
  };
  const errors: Mock<(error: Error) => void> = vi.fn();
  const options = { identityOptions, now: () => now, resolveTransport: () => transport, onError: errors };
  const outgoing = new GatewayDeliveryService(sender, options), incoming = new GatewayDeliveryService(recipient, options);
  const store = new WorkerTrustStore(recipient, { path: workerIntakePath(recipient.did, identityOptions), now: () => now });
  const review = new HeldRequestReview(recipient, { ...identityOptions, now: () => now, provider: inspect ? completeInspection : undefined });
  const approval = new PolicyAutoApprovalProvider(recipient);
  const human: { kind: 'human'; approve: Mock<ApprovalProvider['approve']> } = { kind: 'human', approve: vi.fn(approval.approve.bind(approval)) };
  const execute: Mock<(ctx: { input: Json }) => Promise<Json>> = vi.fn(async ctx => ctx.input);
  const worker = new WorkerNode({ protocolPolicy, owner: recipient, relay: transport, relayUrl: statusRelayUrl, identityOptions, now: () => now,
    deliveryService: incoming, connectionStore: store, intakeStore: store, heldReview: review, approvalProvider: approval, ownerApprovalProvider: human,
    taskTimeoutMs: 86400_000, adapter: { id: 'echo', name: 'Echo', skills: [], executeTask: execute } });
  const client = new RequesterClient({ protocolPolicy, owner: sender, relay: transport, pendingRelayUrl: statusRelayUrl, identityOptions,
    deliveryService: outgoing, taskTimeoutMs: 86400_000, now: () => now, approvalProvider: new PolicyAutoApprovalProvider(sender) });
  const task = { title: 'Delivery fixture', description: 'Lifecycle fixture', input: { text: 'fixture content' } };
  function proposal(version: '0.1.0' | '0.2.0' = '0.2.0') {
    const manifest = buildTaskManifest({ ...task, protocolVersion: version, ownerDid: sender.did, workerDid: recipient.did, now: () => now, taskTimeoutMs: 86400_000 });
    const envelope = signEnvelope({ taskId: manifest.taskId, recipientDid: recipient.did, seq: 0, eventType: 'PROPOSE',
      payload: { proposal: signPayload(manifest, sender), input: task.input, capabilityChains: [] } as unknown as Json }, sender, { encrypt: true });
    return { manifest, envelope, messageId: envelope.payload.envelopeId };
  }
  function enqueue(p = proposal()) {
    outgoing.enqueue([p.envelope], { messageId: p.messageId, peerOwnerDid: recipient.did, relayUrl: statusRelayUrl,
      deliveryDeadline: Date.parse(p.manifest.deadline), message: { taskId: p.manifest.taskId, peerAgentDid: recipient.did, protocolVersion: p.manifest.protocolVersion as '0.1.0' | '0.2.0' } });
    return p;
  }
  function status(p: ReturnType<typeof proposal>, changes: Partial<DeliveryStatus> = {}, outer: Partial<SignedEnvelope['payload']> = {}) {
    const signed = signDeliveryStatus({ type: 'DeliveryStatus', version: 1, messageId: p.messageId, taskId: p.manifest.taskId,
      senderDid: sender.did, recipientDid: recipient.did, state: 'received_held', revision: 1, occurredAt: now,
      retainUntil: outgoing.store.read('messages', p.messageId)?.retainUntil ?? Date.parse(p.manifest.deadline) + 7 * 86400_000, ...changes }, recipient);
    const envelope = signEnvelope({ taskId: deliveryStatusRoutingId(p.messageId), recipientDid: sender.did, seq: signed.payload.revision,
      eventType: 'DELIVERY_STATUS', payload: signed as unknown as Json, ...outer }, recipient, { encrypt: true, signedAt: new Date(now).toISOString() });
    return { signed, envelope };
  }
  async function attempt(invite = true, version?: '0.1.0' | '0.2.0') {
    const manifest = version ? proposal(version).manifest : undefined;
    return Promise.allSettled([client.delegate({ ...task, to: invite ? worker.invite() : recipient.did, manifest }), worker.start({ once: true })]);
  }
  return { root, identityOptions, sender, recipient, relay, transport, frames, errors, incoming, outgoing, store, review, human, execute, worker, client,
    epoch, protocolPolicy, now: () => now, setNow: (n: number) => { now = n; }, proposal, enqueue, status, attempt,
    cleanup: () => { client.stopDelivery(); worker.stop(); rmSync(root, { recursive: true, force: true }); } };
}
