// SPDX-License-Identifier: Apache-2.0
import { digest, schemaRegistry, validateSchema, verifyApproval, verifyContract, verifyDelegationChain } from '@acp/core';
import type { ApprovalReceipt, DelegationAttachment, DelegationProof, TaskContract } from '@acp/core';
import type { ApprovalProvider } from './approval-providers.js';

export function requireOwnerDecision(provider: ApprovalProvider | undefined): asserts provider is ApprovalProvider {
  if (provider?.ownerDecision !== true || provider.kind === 'policy') throw new Error('DELEGATION_APPROVAL_REQUIRED');
  (provider as ApprovalProvider & { assertAvailable?: () => void }).assertAvailable?.();
}
/** Same rule for live delivery and historical recovery; never expires historical evidence. */
export function verifyDelegationAttachment(attachment: unknown, expectedParentContract: TaskContract):
  { depthRemaining: number; delegateeOwnerDids: string[] } {
  const depth = expectedParentContract.manifest.permissions.maxDelegationDepth;
  // CP5a is opt-in through ContextGrant. Preserve legacy delivery semantics at every depth.
  if (!expectedParentContract.manifest.contextGrant) return { depthRemaining: depth, delegateeOwnerDids: [] };
  if (depth === 0) {
    if (attachment !== undefined) throw new Error('DELEGATION_INVALID');
    return { depthRemaining: 0, delegateeOwnerDids: [] };
  }
  if (depth !== 1) throw new Error('DELEGATION_INVALID');
  if (attachment === undefined) throw new Error('DELEGATION_PROOF_REQUIRED');
  if (expectedParentContract.manifest.contextGrant?.deliveryMode !== 'approval_redelegation')
    throw new Error('DELEGATION_INVALID');
  try { validateSchema('delegation-attachment', attachment); } catch { throw new Error('DELEGATION_INVALID'); }
  const a = attachment as DelegationAttachment;
  if (digest(a.parentContract) !== digest(expectedParentContract)) throw new Error('DELEGATION_INVALID');
  const ids = new Set<string>(), owners: string[] = [];
  for (const proof of a.children) {
    const id = proof.childContract.manifest.taskId;
    if (ids.has(id)) throw new Error('DELEGATION_INVALID');
    ids.add(id);
    owners.push(...verifyDelegationChain({ rootContract: expectedParentContract, chain: [proof] }).delegateeOwnerDids);
  }
  return { depthRemaining: 0, delegateeOwnerDids: owners };
}
export interface ChildDelegationAttempt {
  childTaskId: string;
  delegateeOwnerDid: string;
  childManifestDigest: string;
  childInputDigest: string;
  approval: ApprovalReceipt;
  status: 'approved' | 'dispatching' | 'unresolved' | 'accepted' | 'completed' | 'failed';
  proof?: DelegationProof;
}
export interface TaskDelegationState {
  parentContract: TaskContract;
  attempts: ChildDelegationAttempt[];
}
export function redelegationTarget(parent: TaskContract, attempt: Pick<ChildDelegationAttempt,
  'childManifestDigest' | 'childInputDigest' | 'delegateeOwnerDid'>) {
  return { type: 'Redelegation', parentTaskId: parent.manifest.taskId, parentContractDigest: parent.contractDigest,
    childManifestDigest: attempt.childManifestDigest, childInputDigest: attempt.childInputDigest,
    delegateeOwnerDid: attempt.delegateeOwnerDid, depthRemaining: 0 };
}
/** Validate optional version-1 checkpoint state on both writes and reads. No input bodies are stored here. */
export function validateTaskDelegation(state: TaskDelegationState, taskId: string, requesterDid: string, ownerDid: string): void {
  try {
    const contractSchema = schemaRegistry().getSchema('delegation-attachment#/$defs/contract')!;
    if (!state || !contractSchema(state.parentContract) || Object.keys(state).sort().join() !== 'attempts,parentContract' || !verifyContract(state.parentContract) ||
        state.parentContract.manifest.taskId !== taskId || state.parentContract.manifest.requester.ownerDid !== requesterDid ||
        state.parentContract.manifest.worker?.ownerDid !== ownerDid ||
        state.parentContract.manifest.contextGrant?.deliveryMode !== 'approval_redelegation' || !Array.isArray(state.attempts)) throw new Error();
    const ids = new Set<string>(), receipts = new Set<string>();
    for (const a of state.attempts) {
      if (Object.keys(a).some(k => !['childTaskId','delegateeOwnerDid','childManifestDigest','childInputDigest','approval','status','proof'].includes(k)) ||
          typeof a.childTaskId !== 'string' || !a.childTaskId || ids.has(a.childTaskId) ||
          !/^sha256:[a-f0-9]{64}$/.test(a.childManifestDigest) || !/^sha256:[a-f0-9]{64}$/.test(a.childInputDigest) ||
          !/^did:key:z[1-9A-HJ-NP-Za-km-z]{32,128}$/.test(a.delegateeOwnerDid) ||
          !['approved','dispatching','unresolved','accepted','completed','failed'].includes(a.status) ||
          !verifyApproval(a.approval, ownerDid, taskId, 'redelegation', redelegationTarget(state.parentContract, a)) ||
          receipts.has(a.approval.payload.receiptId)) throw new Error();
      ids.add(a.childTaskId); receipts.add(a.approval.payload.receiptId);
      if (['accepted','completed'].includes(a.status) && !a.proof) throw new Error();
      if (a.proof) {
        verifyDelegationChain({ rootContract: state.parentContract, chain: [a.proof] });
        if (a.proof.childContract.manifest.taskId !== a.childTaskId ||
            digest(a.proof.childContract.manifest) !== a.childManifestDigest ||
            a.proof.link.payload.delegateeOwnerDid !== a.delegateeOwnerDid) throw new Error();
      }
    }
  } catch { throw new Error('INVALID_TASK_JOURNAL'); }
}
export function assembleDelegation(state: TaskDelegationState): DelegationAttachment {
  if (state.attempts.some(a => ['approved','dispatching','unresolved','accepted'].includes(a.status) ||
      a.status === 'completed' && !a.proof)) throw new Error('DELEGATION_INVALID');
  const attachment = { parentContract: state.parentContract, children: state.attempts.flatMap(a => a.proof ? [a.proof] : []) };
  verifyDelegationAttachment(attachment, state.parentContract);
  return structuredClone(attachment);
}

/** Bind a disclosed root to retained compact proposal/acceptance evidence before lineage checks. */
export function verifyRecoveredDelegation(delivery: { delegation?: DelegationAttachment }, proposal: unknown,
  acceptance: unknown, expected?: TaskContract): void {
  const p = proposal as { manifestDigest?: string; grantDigest?: string; deliveryMode?: string; proposal?: { payload: TaskContract['manifest'] } };
  const a = acceptance as { contract?: TaskContract; contractDigest?: string; manifestDigest?: string;
    grantDigest?: string; deliveryMode?: string; acceptance?: TaskContract['acceptance'] };
  // Prefer retained contract/proposal evidence over anything disclosed by a delivery.
  const manifest = expected?.manifest ?? a?.contract?.manifest ?? p?.proposal?.payload;
  if (manifest && !manifest.contextGrant) return;
  const embedded = delivery.delegation?.parentContract;
  const trusted = expected ?? a?.contract ?? embedded;
  if (!trusted) {
    if (p?.deliveryMode === 'approval_redelegation' || a?.deliveryMode === 'approval_redelegation')
      throw new Error('DELEGATION_PROOF_REQUIRED');
    return; // Legacy compact depth-0 audit; CP1 representation is unchanged.
  }
  if (trusted.manifest.permissions.maxDelegationDepth !== 0 || delivery.delegation !== undefined) {
    if (!verifyContract(trusted)) throw new Error('DELEGATION_INVALID');
    if (p?.proposal) {
      if (digest(p.proposal.payload) !== digest(trusted.manifest) || !a?.contract || digest(a.contract) !== digest(trusted))
        throw new Error('DELEGATION_INVALID');
    } else {
      const g = trusted.manifest.contextGrant;
      if (!g || p?.manifestDigest !== digest(trusted.manifest) || p.grantDigest !== digest(g) || p.deliveryMode !== g.deliveryMode ||
          a?.manifestDigest !== digest(trusted.manifest) || a.grantDigest !== digest(g) || a.deliveryMode !== g.deliveryMode ||
          a.contractDigest !== trusted.contractDigest || digest(a.acceptance) !== digest(trusted.acceptance))
        throw new Error('DELEGATION_INVALID');
    }
  }
  verifyDelegationAttachment(delivery.delegation, trusted);
}
