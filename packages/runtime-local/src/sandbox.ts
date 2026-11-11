// SPDX-License-Identifier: Apache-2.0
import { runContainerOrSubprocessSandbox } from '@acp/sandbox';
import type { AgentAdapter, AgentTaskContext } from './adapter-port.js';
import type { Json } from '@acp/core';

/**
 * Runs task JavaScript and reports the isolation the host runner actually used.
 *
 * `subprocess_restricted` (the default, and the fallback when Podman or Docker
 * is absent) is a separate OS process. The child gets a sanitized environment
 * (no inherited credentials or `NODE_OPTIONS`), a temporary scratch directory,
 * a wall-clock timeout followed by SIGTERM then SIGKILL, and an output byte cap.
 * `detectNodePermissionFlag` / `resolveNodePermissionArgs` in `@acp/sandbox`
 * select `--permission` on Node.js >= 22.13 and on Node.js 23+, or
 * `--experimental-permission` on earlier Node.js 20 and 22 releases, and pair
 * that flag with `--allow-fs-read` and `--allow-fs-write` for the scratch
 * directory. Those flags restrict filesystem, child-process, worker-thread, and
 * native-addon access. They do not block `fetch`, `node:net`, `node:http`,
 * `node:https`, `node:dns`, or `node:dgram`, and they are not a kernel network
 * namespace. When this Node binary advertises neither flag, the child still
 * starts and `sandboxBoundary.permissionModelActive` is false.
 *
 * Task source is evaluated with `node:vm` in that same child. Node.js documents
 * that `node:vm` is not a security mechanism against untrusted code. A
 * null-prototype context that omits `process` and `require`, and deleting
 * `globalThis.fetch` and `WebSocket` in the wrapper, only shrinks the API the
 * guest script sees.
 *
 * Untrusted third-party code requires `oci_container`
 * (`isolationLevel: 'oci_container'`). That path runs Podman or Docker with
 * `--network none`, a read-only root filesystem, `--cap-drop ALL`,
 * `--security-opt no-new-privileges`, and PID and memory limits.
 * `ExecutionAttestation.effectiveIsolationLevel` is `subprocess_restricted` or
 * `oci_container` from the path that ran. `VerificationEngine` rejects a
 * `subprocess_restricted` attestation when the contract requires `oci_container`,
 * unless `sandboxPolicy.allowSubprocessFallback` is true.
 */
export class SandboxAgentAdapter implements AgentAdapter {
  readonly id = 'sandbox';
  readonly name = 'Restricted JavaScript Worker';
  readonly skills = [{ id: 'json-task', name: 'JSON task' }];
  constructor(readonly code = 'return input;') {}
  async executeTask(context: AgentTaskContext): Promise<Json> {
    const policy = context.manifest.sandboxPolicy;
    if (policy.networkAccess !== 'none' || policy.filesystemScope !== 'ephemeral_workspace_only')
      throw new Error('UNSUPPORTED_SANDBOX_POLICY');
    const result = await runContainerOrSubprocessSandbox({
      code: this.code,
      input: context.input,
      isolationLevel: policy.isolationLevel,
      timeoutMs: context.manifest.budget.maxWallClockSeconds * 1000,
      signal: context.signal,
      onTool: (name, args) => context.callTool(name, args as Json),
      onUsage: (inputTokens, outputTokens) => context.reportUsage({ inputTokens, outputTokens }),
    });
    context.reportIsolation?.(result.effectiveIsolationLevel, result.sandboxBoundary);
    return result.output;
  }
}
