// SPDX-License-Identifier: Apache-2.0 AND MIT
// Adapted from newtro/delegateos src/core/verification.ts (MIT), Scott Smith.
import {
  digest,
  isEncryptedEnvelopePayload,
  openEnvelope,
  signPayload,
  verifySigned,
  verifyEnvelope,
  validateOutput,
  verifyContract,
} from '@acp/core';
import type {
  DelegationAttachment,
  Json,
  KeyPair,
  Signed,
  SignedEnvelope,
  TaskContract,
  ApprovalReceipt,
  UsageReceipt,
} from '@acp/core';
import { runSandbox } from '@acp/sandbox';
import type { SandboxBoundaryMetadata } from '@acp/sandbox';
import { verifyDelegationAttachment } from './delegation.js';
import { ApprovalGate } from './policy.js';
import { verifyUsage } from './quota.js';
import { satisfiesIsolation } from './isolation.js';
export interface ContentArtifact {
  type: 'Artifact';
  taskId: string;
  name: string;
  digest: string;
  data: Json;
}
export interface Attestation {
  type: 'ExecutionAttestation';
  taskId: string;
  contractDigest: string;
  artifactDigest: string;
  /** Path the host runner used. Task output cannot set this field. */
  effectiveIsolationLevel?: string;
  /**
   * Node permission-flag choice and whether the kernel network namespace was
   * closed. Absent on older attestations. `permissionModelActive` is false when
   * neither `--permission` nor `--experimental-permission` exists, and also for
   * `oci_container` (that path uses the container runtime). `kernelNetworkIsolated`
   * is true only for `oci_container`.
   */
  sandboxBoundary?: SandboxBoundaryMetadata;
}
export interface Delivery {
  delegation?: DelegationAttachment;
  artifact: Signed<ContentArtifact>;
  usage: UsageReceipt;
  attestation: Signed<Attestation>;
}
export function createDelivery(
  taskId: string,
  contractDigest: string,
  data: Json,
  usage: UsageReceipt,
  worker: KeyPair,
  execution?: { effectiveIsolationLevel: string; sandboxBoundary?: SandboxBoundaryMetadata },
  delegation?: DelegationAttachment,
): Delivery {
  const artifact = signPayload(
    { type: 'Artifact' as const, taskId, name: 'report.json', digest: digest(data), data },
    worker,
  );
  return {
    ...(delegation !== undefined ? { delegation: structuredClone(delegation) } : {}),
    artifact,
    usage,
    attestation: signPayload(
      {
        type: 'ExecutionAttestation',
        taskId,
        contractDigest,
        artifactDigest: artifact.payload.digest,
        ...(execution?.effectiveIsolationLevel
          ? { effectiveIsolationLevel: execution.effectiveIsolationLevel }
          : {}),
        ...(execution?.sandboxBoundary ? { sandboxBoundary: execution.sandboxBoundary } : {}),
      },
      worker,
    ),
  };
}
export interface VerificationResult {
  accepted: boolean;
  event: 'VERIFY_ACCEPT' | 'VERIFY_REJECT';
  stages: string[];
  reason?: string;
}
export interface VerificationEngineOptions {
  /** Accept a cleartext DELIVER envelope. Default false. */
  allowUnencryptedEnvelopes?: boolean;
}
/** Direct delivery check. `allowUnencryptedEnvelopes` defaults to false. */
export interface VerifyDeliverableInput {
  contract: TaskContract;
  envelope: SignedEnvelope;
  gate: ApprovalGate;
  approval?: ApprovalReceipt | (() => Promise<ApprovalReceipt>);
  recipient?: KeyPair;
  allowUnencryptedEnvelopes?: boolean;
  ownerDecision?: true;
}
export class VerificationEngine {
  private checks = new Map<string, string>();
  constructor(private readonly options: VerificationEngineOptions = {}) {}
  registerIsolatedCheck(target: string, code: string): void {
    this.checks.set(target, code);
  }
  verifyDeliverable(input: VerifyDeliverableInput): Promise<VerificationResult> {
    return this.verify(
      input.contract,
      input.envelope,
      input.gate,
      input.approval,
      input.recipient,
      input.ownerDecision === undefined
        ? input.allowUnencryptedEnvelopes === undefined ? undefined : { allowUnencryptedEnvelopes: input.allowUnencryptedEnvelopes }
        : { allowUnencryptedEnvelopes: input.allowUnencryptedEnvelopes, ownerDecision: input.ownerDecision },
    );
  }
  async verify(
    contract: TaskContract,
    envelope: SignedEnvelope,
    gate: ApprovalGate,
    approval?: ApprovalReceipt | (() => Promise<ApprovalReceipt>),
    recipient?: KeyPair,
    verifyOptions?: { allowUnencryptedEnvelopes?: boolean; onVerifiedDelivery?: () => void; ownerDecision?: true },
  ): Promise<VerificationResult> {
    const stages: string[] = [];
    try {
      if (!verifyContract(contract)) throw new Error('INVALID_CONTRACT');
      const m = contract.manifest,
        worker = m.worker!.ownerDid;
      if (
        !verifyEnvelope(envelope, m.requester.ownerDid) ||
        envelope.payload.senderDid !== worker ||
        envelope.payload.taskId !== m.taskId ||
        envelope.payload.eventType !== 'DELIVER' ||
        Date.now() > Date.parse(m.deadline)
      )
        throw new Error('CRYPTO_ENVELOPE_OR_DEADLINE');
      const allowUnencrypted =
        verifyOptions?.allowUnencryptedEnvelopes ?? this.options.allowUnencryptedEnvelopes === true;
      if (isEncryptedEnvelopePayload(envelope.payload.payload) && !recipient)
        throw new Error('CRYPTO_ENVELOPE_OR_DEADLINE');
      if (!isEncryptedEnvelopePayload(envelope.payload.payload) && !allowUnencrypted)
        throw new Error('UNENCRYPTED_ENVELOPE_REJECTED');
      const d = (isEncryptedEnvelopePayload(envelope.payload.payload)
        ? openEnvelope(envelope, recipient!, { requireEncrypted: true })
        : envelope.payload.payload) as unknown as Delivery;
      if (
        !verifySigned(d.artifact, worker) ||
        d.artifact.payload.type !== 'Artifact' ||
        d.artifact.payload.taskId !== m.taskId ||
        digest(d.artifact.payload.data) !== d.artifact.payload.digest ||
        !verifySigned(d.attestation, worker) ||
        d.attestation.payload.type !== 'ExecutionAttestation' ||
        d.attestation.payload.taskId !== m.taskId ||
        d.attestation.payload.contractDigest !== contract.contractDigest ||
        d.attestation.payload.artifactDigest !== d.artifact.payload.digest ||
        !verifyUsage(d.usage, worker, m.taskId, m.budget)
      )
        throw new Error('CRYPTO_ARTIFACT_OR_BUDGET');
      if (m.contextGrant) {
        verifyDelegationAttachment(d.delegation, contract);
        if (m.permissions.maxDelegationDepth === 1) {
          stages.push('delegation_chain');
          if (verifyOptions?.ownerDecision !== true) throw new Error('DELEGATION_APPROVAL_REQUIRED');
        }
      }
      // Only the signed runner level counts; sandboxBoundary cannot upgrade it.
      if (!satisfiesIsolation(
        m.sandboxPolicy.isolationLevel,
        d.attestation.payload.effectiveIsolationLevel,
        m.verification.requireExecutionAttestation,
        m.sandboxPolicy.allowSubprocessFallback === true,
      ))
        throw new Error('ISOLATION_LEVEL_MISMATCH');
      stages.push('crypto_budget');
      if (!validateOutput(m.io.outputSchema, d.artifact.payload.data))
        throw new Error('OUTPUT_SCHEMA');
      for (const check of m.verification.checks ?? []) {
        if (['json_schema', 'sha256_match', 'human_review'].includes(check.kind)) continue;
        const code = this.checks.get(check.target);
        if (check.kind !== 'deterministic_command' || !code)
          throw new Error('UNREGISTERED_DETERMINISTIC_CHECK');
        // Same subprocess driver as task code: `node:vm` is not a security
        // mechanism, and `--permission` does not block network syscalls.
        // Tool access is denied. Kernel isolation is `oci_container`, not this check.
        const result = await runSandbox({
          code,
          input: { artifact: d.artifact.payload.data },
          timeoutMs: Math.min(5000, m.budget.maxWallClockSeconds * 1000),
          onTool: async () => {
            throw new Error('VERIFICATION_TOOL_ACCESS_DENIED');
          },
        });
        if (result !== (check.expectedExitCode ?? 0)) throw new Error('DETERMINISTIC_CHECK_FAILED');
      }
      stages.push('schema_isolated_check');
      verifyOptions?.onVerifiedDelivery?.();
      gate.require(
        m.taskId,
        'final_verification',
        d,
        typeof approval === 'function' ? await approval() : approval,
      );
      stages.push('owner_approval');
      return { accepted: true, event: 'VERIFY_ACCEPT', stages };
    } catch (e) {
      return { accepted: false, event: 'VERIFY_REJECT', stages, reason: String(e) };
    }
  }
}
