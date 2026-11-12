// SPDX-License-Identifier: Apache-2.0
import { contextGrantAuditPayload, digest, verifySigned } from '@acp/core';
import type { ContextGrant, ContextGrantAuditEventType, Json, TaskContract, TaskManifest } from '@acp/core';

export const CONTEXT_GRANT_AUDIT_EVENTS: readonly ContextGrantAuditEventType[] = [
  'CONTEXT_GRANT', 'CONTEXT_OPENED', 'CONTEXT_DISCARDED', 'CONTEXT_DELETION_ATTEMPTED', 'CONTEXT_MODE',
];

/** Works with a session sender or an application's audit append port. */
export async function appendContextGrantAuditEvent(
  append: (eventType: ContextGrantAuditEventType, payload: Json) => void | Promise<void>,
  eventType: ContextGrantAuditEventType,
  grant: ContextGrant,
): Promise<void> {
  if (!CONTEXT_GRANT_AUDIT_EVENTS.includes(eventType)) throw new Error('CONTEXT_GRANT_AUDIT_EVENT_INVALID');
  await append(eventType, { ...contextGrantAuditPayload(grant) });
}

/** Wire frames keep the signed contract; audit entries keep its digests and acceptance proof. */
export function contextSessionAuditPayload(eventType: string, payload: Json, grant: ContextGrant): Json {
  const summary = contextGrantAuditPayload(grant);
  if (eventType === 'PROPOSE') {
    const p = payload as unknown as { proposal: { payload: TaskManifest }; input: Json };
    return { ...summary, payloadDigest: digest(payload), manifestDigest: digest(p.proposal.payload),
      proposalDigest: digest({ manifest: p.proposal.payload, input: p.input }) };
  }
  if (eventType === 'ACCEPT') {
    const { contract, approval } = payload as unknown as { contract: TaskContract; approval?: import('@acp/core').ApprovalReceipt };
    return JSON.parse(JSON.stringify({ ...summary, payloadDigest: digest(payload),
      manifestDigest: digest(contract.manifest), contractDigest: contract.contractDigest,
      ...(approval?.payload.authorization ? { approval } : {}),
      worker: contract.manifest.worker && { ownerDid: contract.manifest.worker.ownerDid,
        agentDid: contract.manifest.worker.agentDid }, acceptance: contract.acceptance })) as Json;
  }
  return payload;
}

export function proposalAuditDigest(payload: unknown): string | undefined {
  const p = payload as { proposalDigest?: string; proposal?: { payload: TaskManifest }; input?: Json } | undefined;
  return p?.proposalDigest ?? (p?.proposal && digest({ manifest: p.proposal.payload, input: p.input }));
}

export function verifyContextAcceptanceAudit(payload: unknown, manifest: TaskManifest): boolean {
  if (!manifest.contextGrant || !manifest.worker) return false;
  const p = payload as { manifestDigest: string; acceptance: TaskContract['acceptance'];
    grantDigest: string; deliveryMode: string } | undefined;
  return !!p && p.deliveryMode === manifest.contextGrant.deliveryMode && p.manifestDigest === digest(manifest) && p.grantDigest === digest(manifest.contextGrant) &&
    verifySigned(p.acceptance, manifest.worker.ownerDid) && p.acceptance.payload.type === 'ACCEPT' &&
    p.acceptance.payload.manifestDigest === digest(manifest) && p.acceptance.payload.taskId === manifest.taskId;
}
