// SPDX-License-Identifier: Apache-2.0
/** Host startup policy, before registration or accepting locally executed work. */
export function requireNonRootLocalExecution(warn = true): void {
  if (process.platform === 'win32' || process.geteuid?.() !== 0) return;
  // Host launch environment only: never configuration, task/peer data or persistence.
  if (process.env.SEALBRIDGE_ALLOW_ROOT_LOCAL_EXECUTION === '1') {
    if (warn) {
      try {
        process.stderr.write(
          'Warning: local execution is starting as root under SEALBRIDGE_ALLOW_ROOT_LOCAL_EXECUTION=1; use a dedicated non-root user instead.\n',
        );
      } catch {
        /* A local diagnostic failure must not change the operator's startup decision. */
      }
    }
    return;
  }
  throw Object.assign(
    new Error(
      'LOCAL_EXECUTION_ROOT_FORBIDDEN: Start the worker or gateway as a dedicated non-root user. In CI, containers and WSL, select a non-root user and make its data directory writable by that user; do not run Claude/Codex development workers with sudo. The official image uses USER node. Only an operator-controlled launch environment SEALBRIDGE_ALLOW_ROOT_LOCAL_EXECUTION=1 permits root local execution; it is not saved and does not approve tasks.',
    ),
    { code: 'LOCAL_EXECUTION_ROOT_FORBIDDEN' },
  );
}
