// SPDX-License-Identifier: Apache-2.0
import { autoAcceptPolicy, digest, signApproval, signPayload } from '@acp/core';
import type { AutoAcceptPolicy, KeyPair, TaskManifest } from '@acp/core';
import type { AgentAdapter } from './adapter.js';
import type { ToolDefinition } from './mcp.js';
import type { ApprovalProvider, ApprovalRequest } from './approval-providers.js';
// Leave room for the signed/encrypted wire overhead under the 256 KiB relay envelope cap.
export const DEFAULT_PASSKEY_INPUT_BYTES = 128 * 1024;
/** Host declarations and exact input bytes determine the passkey review reasons. */
export function passkeyTaskReasons(context: AutoAcceptContext, input: unknown): string[] {
  return [
    ...(!readOnlyTask(context) ? ['write'] : []),
    ...(context.adapter.id === 'openai' || context.manifest.budget.costBearer !== 'worker_byok'
      ? ['money']
      : []),
    ...(Buffer.byteLength(JSON.stringify(input)) > DEFAULT_PASSKEY_INPUT_BYTES ? ['size'] : []),
  ];
}

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
  return (
    adapter.taskAccess === 'read-only' &&
    !manifest.contextGrant?.deliveryMode.includes('redelegation') &&
    manifest.permissions.maxDelegationDepth === 0 &&
    !manifest.verification.checks?.length &&
    manifest.permissions.grantedCapabilities.every((g) =>
      g.allowedTools.every((name) => tools[name]?.readOnly === true),
    )
  );
}
/** Content-free explanation suitable for background worker diagnostics. */
export function autoAcceptReason(
  value: AutoAcceptPolicy,
  context: AutoAcceptContext,
): string | undefined {
  const p = autoAcceptPolicy(value);
  if (!p.enabled) return 'automatic acceptance is off';
  if (context.manifest.budget.costBearer !== 'worker_byok')
    return 'paid or quota work requires owner approval';
  if (context.manifest.contextGrant?.deliveryMode === 'approval_redelegation')
    return 'redelegation requires owner approval';
  if (p.from === 'connected' && !context.connected) return 'requester is not connected';
  if (p.from === 'invited' && !context.invited)
    return 'requester has no eligible invitation connection';
  if (p.work === 'read-only' && !readOnlyTask(context))
    return 'adapter, tools or verification require write/command approval';
  return undefined;
}
/** A future limit provider must atomically check/reserve counting state before returning true. */
export type AutoAcceptStateGuard = (
  context: AutoAcceptContext,
  policy: Readonly<AutoAcceptPolicy>,
) => Promise<boolean>;
export async function matchesAutoAccept(
  value: AutoAcceptPolicy,
  context: AutoAcceptContext,
  guard?: AutoAcceptStateGuard,
): Promise<boolean> {
  const p = autoAcceptPolicy(value);
  if (autoAcceptReason(p, context)) return false;
  try {
    return guard ? (await guard(context, p)) === true : true;
  } catch {
    return false;
  }
}
export class WorkerAutoApprovalProvider implements ApprovalProvider {
  readonly kind = 'policy' as const;
  private policy: AutoAcceptPolicy;
  constructor(
    private owner: KeyPair,
    policy: AutoAcceptPolicy,
  ) {
    this.policy = autoAcceptPolicy(policy);
  }
  async approve(r: ApprovalRequest) {
    if (
      r.gate !== 'contract_acceptance' &&
      !(r.gate === 'external_side_effect' && this.policy.work === 'write')
    )
      throw new Error('HITL_REQUIRED: ' + r.gate);
    const receipt = signApproval(r.taskId, r.gate, r.target, this.owner);
    return signPayload(
      {
        ...receipt.payload,
        authorization: {
          kind: 'auto-policy' as const,
          ruleVersion: this.policy.version,
          ruleDigest: digest(this.policy),
        },
      },
      this.owner,
    );
  }
}

/** Peer opt-in replaces the audience/work defaults, retaining every folder limit. */
export function connectionAutoAccept(
  policy: AutoAcceptPolicy,
  acceptance?: 'off' | 'read-only' | 'write',
): AutoAcceptPolicy {
  return acceptance === undefined
    ? policy
    : {
        ...policy,
        enabled: acceptance !== 'off',
        from: 'connected',
        work: acceptance === 'off' ? 'read-only' : acceptance,
      };
}
