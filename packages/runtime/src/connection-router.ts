// SPDX-License-Identifier: Apache-2.0
import { digest, isConnectionEvent, openEnvelope } from '@acp/core';
import type { KeyPair, SignedAgentCard, SignedEnvelope, RevocationList } from '@acp/core';
import { waitForRelayRetry } from '@acp/relay';
import type { RelayTransport } from '@acp/relay';
import { acknowledgeRelay } from './session-audit.js';
import { ConnectionService } from './connection-service.js';
import type { ConnectionHumanReviewProvider, ConnectionInspectionPort } from './connection-service.js';
import { StoredConnectionExchange } from './connection-persistence.js';
import { openConnectionFrame } from './connection-transport.js';
import { HeldRequestReview, heldContentDigest } from './held-request-review.js';
import type { WorkerTrustStore } from './worker-trust-store.js';
import type { ConnectionRecord } from './connection-records.js';

export interface ConnectedEvent {
  event: 'connected'; peerOwnerDid: string; peerAgentDid?: string;
  connectionId: string; source: ConnectionRecord['source']; connectedAt: number;
}
export interface ConnectionRouterOptions {
  owner: KeyPair; agentCard: SignedAgentCard; relayUrl: string; relay: RelayTransport;
  store: WorkerTrustStore; review: HeldRequestReview; now?: () => number;
  humanReview?: ConnectionHumanReviewProvider; revocations?: RevocationList; allowPrivateRelay?: boolean;
  assertPeer?: (did: string) => void;
  onConnectionEvent?: (event: ConnectedEvent) => void;
}
/** Control events are consumed by the existing role reader before task mailbox routing. */
export class ConnectionRouter {
  readonly service: ConnectionService;
  constructor(readonly options: ConnectionRouterOptions) {
    const { review, owner } = options;
    const find = (contentDigest: string) => review.list().find(r => r.kind === 'connection' &&
      digest(openConnectionFrame(review.store.read(r.id)!.envelope, owner).event) === contentDigest);
    const inspection: ConnectionInspectionPort = {
      async hold(envelope, context) {
        const frame = openConnectionFrame(envelope, owner);
        options.store.consumeAdmission(frame.event.payload.fromOwnerDid, frame.requestId);
        const previous = find(context.contentDigest);
        if (previous) return;
        review.hold({ kind: 'connection', senderOwnerDid: frame.event.payload.fromOwnerDid,
          requestId: frame.requestId, contentDigest: heldContentDigest('connection', openEnvelope(envelope, owner)),
          deadline: Date.parse(context.expiresAt), envelope });
      },
      async inspect(contentDigest) {
        const held = find(contentDigest);
        if (!held) return { contentDigest, status: 'unavailable' };
        const result = await review.inspect(held.id);
        return { contentDigest, status: result.inspectionStatus === 'complete' ? 'complete' :
          result.inspectionStatus === 'error' ? 'error' : 'unavailable' };
      },
      async discard(contentDigest) { const held = find(contentDigest); if (held) review.discard(held.id); },
    };
    this.service = new ConnectionService({ ...options, persistence: new StoredConnectionExchange(options.store),
      inspection, transport: { send: async (url, envelope) => {
        if (url !== options.relayUrl) throw new Error('CONNECTION_RELAY_MISMATCH');
        options.assertPeer?.(envelope.payload.recipientDid); await options.relay.send(envelope);
      } } });
  }
  private notify(before: ReturnType<WorkerTrustStore['listConnections']>): void {
    for (const c of this.options.store.listConnections()) if ('connectionId' in c && c.state === 'connected' &&
      !before.some(b => 'connectionId' in b && b.connectionId === c.connectionId && b.state === 'connected'))
      this.options.onConnectionEvent?.({ event: 'connected', peerOwnerDid: c.peerOwnerDid,
        ...(c.peerAgentDid ? { peerAgentDid: c.peerAgentDid } : {}), connectionId: c.connectionId!,
        source: c.source, connectedAt: c.connectedAt! });
  }
  async consume(envelope: SignedEnvelope): Promise<boolean> {
    if (!isConnectionEvent(envelope.payload.eventType)) return false;
    // Block is silent and creates no held-content entry.
    try { this.options.assertPeer?.(envelope.payload.senderDid); }
    catch { await acknowledgeRelay(this.options.relay, envelope); return true; }
    if (this.options.store.connectionState(envelope.payload.senderDid) === 'blocked') {
      await acknowledgeRelay(this.options.relay, envelope); return true;
    }
    const before = this.options.store.listConnections();
    await this.service.receive(envelope);
    this.notify(before);
    await acknowledgeRelay(this.options.relay, envelope);
    return true;
  }
  /** Hosts discard terminal control decisions locally and keep their task reader running. */
  async route(envelope: SignedEnvelope): Promise<boolean> {
    try { return await this.consume(envelope); }
    catch (error) {
      const code = error instanceof Error ? error.message.split(':')[0] : '';
      if (!/^(?:INVALID_CONNECTION_|INVALID_AGENT_CARD$|CONNECTION_NOT_PENDING$|CONNECTION_REQUEST_EXPIRED$|CONNECTION_ALREADY_DECIDED$|CONNECTION_REQUEST_COOLDOWN$|INVITE_EXPIRED$|INVITE_WORKER_MISMATCH$|TOKEN_REVOKED$|INTAKE_RATE_LIMITED$)/.test(code)) throw error;
      await acknowledgeRelay(this.options.relay, envelope); return true;
    }
  }
  async approve(envelope: SignedEnvelope) {
    const before = this.options.store.listConnections();
    const result = await this.service.approve(envelope); this.notify(before); return result;
  }
}

/** Explicit control-only sync. A task at the queue head is left for the task listener. */
export async function syncConnections(router: ConnectionRouter, options: { once?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  await router.service.flushOutbox();
  try {
    do {
      if (options.signal?.aborted) return;
      const relay = router.options.relay, ownerDid = router.options.owner.did;
      // Known offers can receive late acceptance even when a task is at the queue head.
      const taskIds = router.options.store.controlSnapshot().filter(r => r.active &&
        Date.parse(r.offer.expiresAt) > (router.options.now ?? Date.now)()).map(r => 'conn_' + r.offer.requestId);
      const known = taskIds.length ? await relay.receive(ownerDid, 0, options.signal, { taskId: taskIds, lease: true }) : undefined;
      if (known) { await router.route(known); if (options.once) return; continue; }
      const next = await relay.receive(ownerDid, options.once ? 0 : 1000, options.signal, { role: 'worker', peek: true });
      if (next && isConnectionEvent(next.payload.eventType)) {
        const envelope = await relay.receive(ownerDid, 0, options.signal, { taskId: next.payload.taskId, lease: true });
        if (envelope) await router.route(envelope);
      } else if (!options.once) await waitForRelayRetry(100, options.signal);
    } while (!options.once);
  } catch (error) { if (!options.signal?.aborted) throw error; }
}
