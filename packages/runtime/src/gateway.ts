// SPDX-License-Identifier: Apache-2.0
import {
  ContractMachine,
  createCapability,
  verifyCapabilityChain,
  digest,
  CapabilityGuard,
} from '@acp/core';
import type {
  TaskContract,
  KeyPair,
  ApprovalReceipt,
  CapabilityToken,
  Capability,
  Signed,
  Transition,
  ContractEvent,
  Json,
  SignedEnvelope,
  RevocationList,
} from '@acp/core';
import { runContainerOrSubprocessSandbox } from '@acp/sandbox';
import type { SandboxBoundaryMetadata } from '@acp/sandbox';
import { ApprovalGate } from './policy.js';
import type { OwnerPolicy } from './policy.js';
import { QuotaMeter } from './quota.js';
import type { MCPProxy } from './mcp.js';
import { EnvelopeInbox } from './inbox.js';
import { VerificationEngine } from './verifier.js';
export class OwnerGateway {
  effectiveIsolationLevel = 'subprocess_restricted';
  /** Set by `execute` from the runner. Undefined until a sandbox task has run. */
  sandboxBoundary?: SandboxBoundaryMetadata;
  readonly capabilities: CapabilityGuard;
  readonly inbox: EnvelopeInbox;
  readonly machine: ContractMachine;
  readonly approvals: ApprovalGate;
  readonly quota: QuotaMeter;
  constructor(
    readonly owner: KeyPair,
    readonly contract: TaskContract,
    policy: OwnerPolicy,
    revocation?: RevocationList,
  ) {
    if (
      ![contract.manifest.requester.ownerDid, contract.manifest.worker?.ownerDid].includes(
        owner.did,
      )
    )
      throw new Error('GATEWAY_OWNER_MISMATCH');
    this.inbox = new EnvelopeInbox(
      owner.did,
      owner.did === contract.manifest.requester.ownerDid
        ? contract.manifest.worker!.ownerDid
        : contract.manifest.requester.ownerDid,
      contract.manifest.taskId,
    );
    this.machine = new ContractMachine(contract);
    this.capabilities = new CapabilityGuard(revocation);
    this.approvals = new ApprovalGate(owner.did, policy);
    this.quota = new QuotaMeter(contract.manifest.taskId, contract.manifest.budget, owner.did);
  }
  accept(receipt: ApprovalReceipt): Signed<Transition> {
    this.approvals.require(
      this.contract.manifest.taskId,
      'contract_acceptance',
      this.contract.contractDigest,
      receipt,
    );
    return this.applyOwn('ACCEPT');
  }
  private applyOwn(event: ContractEvent): Signed<Transition> {
    const signed = this.machine.event(event, this.owner);
    this.machine.apply(signed);
    if (['SETTLED', 'CANCELLED'].includes(this.machine.state))
      this.capabilities.revokeTask(this.contract.manifest.taskId);
    return signed;
  }
  transition(event: ContractEvent): Signed<Transition> {
    if (['ACCEPT', 'VERIFY_ACCEPT', 'VERIFY_REJECT', 'SETTLE'].includes(event))
      throw new Error('GATED_TRANSITION_REQUIRED');
    return this.applyOwn(event);
  }
  async verifyAndSettle(
    envelope: SignedEnvelope,
    engine: VerificationEngine,
    approval?: ApprovalReceipt | (() => Promise<ApprovalReceipt>),
    options?: { allowUnencryptedEnvelopes?: boolean; onVerifiedDelivery?: () => void },
  ) {
    if (
      this.owner.did !== this.contract.manifest.requester.ownerDid ||
      this.machine.state !== 'DELIVERED'
    )
      throw new Error('INVALID_VERIFICATION_STATE');
    const result = await engine.verify(
      this.contract,
      envelope,
      this.approvals,
      approval,
      this.owner,
      options,
    );
    const verification = this.applyOwn(result.event);
    const settlement = result.accepted ? this.applyOwn('SETTLE') : undefined;
    return { result, verification, settlement };
  }
  redelegate(
    chain: CapabilityToken[],
    params: Omit<Capability, 'id' | 'type' | 'issuer' | 'parentHash'>,
    receipt: ApprovalReceipt,
  ): CapabilityToken {
    if (this.machine.state !== 'IN_PROGRESS')
      throw new Error('CAPABILITY_VIOLATION: inactive task');
    verifyCapabilityChain(chain, {
      rootDid: this.contract.manifest.requester.ownerDid,
      audience: this.owner.did,
      taskId: this.contract.manifest.taskId,
    });
    this.approvals.require(
      this.contract.manifest.taskId,
      'redelegation',
      { parentDigest: digest(chain.at(-1)), params },
      receipt,
    );
    return createCapability(params, this.owner, chain.at(-1));
  }
  async execute(code: string, proxy: MCPProxy, input?: Json): Promise<Json> {
    if (this.machine.state !== 'IN_PROGRESS') throw new Error('CONTRACT_NOT_RUNNING');
    const policy = this.contract.manifest.sandboxPolicy;
    if (
      !['subprocess_restricted', 'oci_container'].includes(policy.isolationLevel) ||
      policy.networkAccess !== 'none' ||
      policy.filesystemScope !== 'ephemeral_workspace_only'
    )
      throw new Error('UNSUPPORTED_SANDBOX_POLICY');
    const result = await runContainerOrSubprocessSandbox({
      isolationLevel: policy.isolationLevel,
      code,
      input,
      timeoutMs: this.quota.budget.maxWallClockSeconds * 1000,
      signal: this.quota.controller.signal,
      onTool: (name, args) => proxy.callTool(name, args),
      onUsage: (i, o) => this.quota.record(i, o),
    });
    this.effectiveIsolationLevel = result.effectiveIsolationLevel;
    this.sandboxBoundary = result.sandboxBoundary;
    return result.output;
  }
  close(): void {
    this.quota.close();
  }
}
