// SPDX-License-Identifier: Apache-2.0
import type { AgentSkill, Json, TaskManifest } from '@acp/core';
import type { AuditBundle } from '@acp/ledger';
import type { RelayTransport } from '@acp/relay';
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
/** Structural host port; runtime retains the canonical session/context interfaces. */
export interface AgentTaskContext {
  redelegate?: (request: {
    to: string;
    relay?: RelayTransport | string;
    manifest: TaskManifest;
    input: Json;
    auditPath?: string;
  }) => Promise<{
    taskId: string;
    state: 'SETTLED' | 'CANCELLED';
    deliverable: Json | null;
    bundle: AuditBundle;
    verification?: { accepted: boolean; event: 'VERIFY_ACCEPT' | 'VERIFY_REJECT'; stages: string[]; reason?: string };
  }>;
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
  readonly taskAccess?: 'read-only' | 'write';
  id: string;
  name: string;
  skills: AgentSkill[];
  executeTask(context: AgentTaskContext): Promise<Json>;
}
