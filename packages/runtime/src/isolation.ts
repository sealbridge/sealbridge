// SPDX-License-Identifier: Apache-2.0
/** Protocol verification policy, weakest first. This does not implement runners. */
const isolationOrder: readonly string[] = ['subprocess_restricted', 'wasm', 'oci_container', 'microvm'];
const legacyHostLevels: readonly string[] = ['host_adapter', 'workspace_process', 'host_http_adapter', 'mcp_proxy'];

export function requiresStrongIsolation(level: string): boolean {
  const rank = isolationOrder.indexOf(level);
  if (rank < 0) throw new Error('ISOLATION_LEVEL_MISMATCH');
  return rank > 0;
}

export function satisfiesIsolation(
  required: string,
  effective: string | undefined,
  requireExecutionAttestation: boolean,
  allowSubprocessFallback: boolean,
): boolean {
  const minimum = isolationOrder.indexOf(required);
  // Host adapter labels and absent levels are legacy default deliveries, not new
  // contract levels. Preserve that compatibility only at the default floor.
  const actual = effective === undefined || legacyHostLevels.includes(effective)
    ? 0 : isolationOrder.indexOf(effective);
  if (minimum < 0 || actual < 0) return false;
  // Keep the existing explicit OCI opt-outs; never apply them to other levels.
  if (required === 'oci_container' && (!requireExecutionAttestation || allowSubprocessFallback)) return true;
  return actual >= minimum;
}
