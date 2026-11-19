// SPDX-License-Identifier: Apache-2.0
import { HostBackend } from '../packages/runtime/src/execution-backend.js';
import type { ExecutionBackend } from '../packages/runtime/src/execution-backend.js';

/** Simulated isolated runner for protocol tests using in-process synthetic adapters.
 * This fixture is not isolation. Real runner and host rejection tests must use
 * the production backend. Preserve levels reported by real adapter fixtures.
 */
export const syntheticExecutionBackend: ExecutionBackend = {
  prepare: () => new HostBackend().prepare(),
  async execute(adapter, context) {
    const result = await new HostBackend().execute(adapter, context);
    if (result.effectiveIsolationLevel === 'host_adapter')
      result.effectiveIsolationLevel = 'subprocess_restricted';
    return result;
  },
  cleanup: (workspace) => new HostBackend().cleanup(workspace),
};
