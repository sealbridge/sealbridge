// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '@acp/core';
import type { SandboxBoundaryMetadata } from '@acp/sandbox';
import type { AgentAdapter, AgentTaskContext } from './adapter.js';

export interface ExecutionResult {
  output: Json;
  effectiveIsolationLevel: string;
  sandboxBoundary?: SandboxBoundaryMetadata;
}

/** Worker execution lifecycle. Implementations must support concurrent tasks. */
export interface ExecutionBackend {
  prepare(): Promise<string>;
  execute(adapter: AgentAdapter, context: AgentTaskContext): Promise<ExecutionResult>;
  cleanup(workspaceDir: string): Promise<void>;
}

/** Existing host adapter execution, including its ephemeral workspace. */
export class HostBackend implements ExecutionBackend {
  prepare(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'acp-adapter-'));
  }

  async execute(adapter: AgentAdapter, context: AgentTaskContext): Promise<ExecutionResult> {
    const result: ExecutionResult = { output: null, effectiveIsolationLevel: 'host_adapter' };
    result.output = await adapter.executeTask({
      ...context,
      reportIsolation: (level, boundary) => {
        result.effectiveIsolationLevel = level;
        if (boundary) result.sandboxBoundary = boundary;
        else delete result.sandboxBoundary;
        context.reportIsolation?.(level, boundary);
      },
    });
    return result;
  }

  cleanup(workspaceDir: string): Promise<void> {
    return rm(workspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
