// SPDX-License-Identifier: Apache-2.0
import type { AgentSkill, Json, TaskManifest } from '@acp/core';
import type { SandboxBoundaryMetadata } from '@acp/sandbox';
export interface UsageMetrics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
  wallTimeMs: number;
}
export interface ProgressMetrics {
  inputTokens?: number;
  outputTokens?: number;
  toolInvocations?: number;
  elapsedMs?: number;
}
export interface ProgressPayload {
  percent?: number;
  step: string;
  message?: string;
  metrics?: ProgressMetrics;
}
export interface ProtocolEnvelope<T> {
  taskId: string;
  seq: number;
  eventType: string;
  senderDid: string;
  recipientDid: string;
  payload: T;
}
export interface AgentTaskContext {
  redelegate?: (request: import('./session.js').ChildDelegationRequest) => Promise<import('./session.js').SessionResult>;
  taskId: string;
  manifest: TaskManifest;
  input: Json;
  callTool: (tool: string, args: Json) => Promise<Json>;
  reportUsage: (delta: Partial<UsageMetrics>) => void;
  reportProgress?: (progress: ProgressPayload) => void | Promise<void>;
  signal: AbortSignal;
  workspaceDir: string;
  /**
   * Host-reported isolation. `level` is the path that ran (`subprocess_restricted`
   * or `oci_container`), not a label chosen by task code. `boundary` is set by
   * the sandbox runner: Node's permission model does not set `kernelNetworkIsolated`.
   */
  reportIsolation?: (level: string, boundary?: SandboxBoundaryMetadata) => void;
}
export interface AgentAdapter {
  /** Host guarantee; omit for arbitrary code, command execution or unknown access. */
  /** Host-selected model for token cost accounting; never inferred from peer input. */
  readonly billingModel?: string;
  readonly taskAccess?: 'read-only' | 'write';
  id: string;
  name: string;
  skills: AgentSkill[];
  executeTask(context: AgentTaskContext): Promise<Json>;
}
