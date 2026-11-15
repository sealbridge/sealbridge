// SPDX-License-Identifier: Apache-2.0
import type { SpawnSyncReturns } from 'node:child_process';

/** Include captured streams when a synchronous fixture times out or exits unsuccessfully. */
export function checkedChildOutput(result: SpawnSyncReturns<string>): string {
  if (result.error || result.status !== 0) {
    const redact = (text: string) => text.replace(/acp-invite:[\w-]+/g, '[invite]');
    throw new Error(`Child process failed: ${result.error?.message ?? `exit ${result.status}, signal ${result.signal}`}\nstdout:\n${redact(result.stdout ?? '')}\nstderr:\n${redact(result.stderr ?? '')}`, { cause: result.error });
  }
  return result.stdout;
}
