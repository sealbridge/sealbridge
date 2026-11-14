// SPDX-License-Identifier: Apache-2.0
import { autoAcceptPolicy, digest, signApproval, signPayload } from '@acp/core';
import type { AutoAcceptPolicy, KeyPair, TaskManifest } from '@acp/core';
import type { AgentAdapter } from './adapter.js';
import type { ToolDefinition } from './mcp.js';
import type { ApprovalProvider, ApprovalRequest } from './approval-providers.js';

export interface AutoAcceptContext {
  signal?: AbortSignal;
  manifest: TaskManifest;
  connected: boolean;
  invited: boolean;
  adapter: AgentAdapter;
  tools: Record<string, ToolDefinition>;
}
/** Host-owned declarations only: descriptions and tool names are never authority. */
export function readOnlyTask({ manifest, adapter, tools }: AutoAcceptContext): boolean {
  return adapter.taskAccess === 'read-only' && !manifest.contextGrant?.deliveryMode.includes('redelegation') &&
    manifest.permissions.maxDelegationDepth === 0 &&
    !(manifest.verification.checks?.length) &&
    manifest.permissions.grantedCapabilities.every(g =>
      g.allowedTools.every(name => tools[name]?.readOnly === true));
}
/** A future limit provider must atomically check/reserve counting state before returning true. */
export type AutoAcceptStateGuard = (context: AutoAcceptContext, policy: Readonly<AutoAcceptPolicy>) => Promise<boolean>;
export async function matchesAutoAccept(value: AutoAcceptPolicy, context: AutoAcceptContext,
  guard?: AutoAcceptStateGuard): Promise<boolean> {
  const p = autoAcceptPolicy(value);
  if (!p.enabled || context.manifest.contextGrant?.deliveryMode === 'approval_redelegation' ||
      p.from === 'connected' && !context.connected || p.from === 'invited' && !context.invited ||
      p.work === 'read-only' && !readOnlyTask(context)) return false;
  try { return guard ? await guard(context, p) === true : true; }
  catch { return false; }
}
export class WorkerAutoApprovalProvider implements ApprovalProvider {
  readonly kind = 'policy' as const;
  private policy: AutoAcceptPolicy;
  constructor(private owner: KeyPair, policy: AutoAcceptPolicy) { this.policy = autoAcceptPolicy(policy); }
  async approve(r: ApprovalRequest) {
    if (r.gate !== 'contract_acceptance' && !(r.gate === 'external_side_effect' && this.policy.work === 'write'))
      throw new Error('HITL_REQUIRED: ' + r.gate);
    const receipt = signApproval(r.taskId, r.gate, r.target, this.owner);
    return signPayload({ ...receipt.payload, authorization: {
      kind: 'auto-policy' as const, ruleVersion: this.policy.version, ruleDigest: digest(this.policy),
    } }, this.owner);
  }
}

/** Peer opt-in replaces the audience/work defaults, retaining every folder limit. */
export function connectionAutoAccept(policy: AutoAcceptPolicy, acceptance?: 'off' | 'read-only' | 'write'): AutoAcceptPolicy {
  return acceptance === undefined ? policy : { ...policy, enabled: acceptance !== 'off',
    from: 'connected', work: acceptance === 'off' ? 'read-only' : acceptance };
}
