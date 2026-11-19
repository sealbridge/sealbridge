// SPDX-License-Identifier: Apache-2.0
import { beforeEach, onTestFailed } from 'vitest';
import { performance } from 'node:perf_hooks';

export const SLOW_TEST_TIMEOUT = 60_000;

/** No retry: retain fixture state and resource usage when a test fails or times out. */
export function slowTestDiagnostics(details: () => unknown): void {
  beforeEach(() => {
    const started = performance.now(),
      cpu = process.cpuUsage();
    onTestFailed(() => {
      console.error('Slow-test diagnostics', {
        elapsedMs: Math.round(performance.now() - started),
        pid: process.pid,
        cpuMicros: process.cpuUsage(cpu),
        rssBytes: process.memoryUsage().rss,
        fixture: details(),
      });
    });
  });
}

export function childFailure(error: unknown, started: number): Error {
  const child = error as { message?: string; stdout?: string; stderr?: string };
  const redact = (text: string) => text.replace(/acp-invite:[\w-]+/g, '[invite]');
  return new Error(
    `Child failed after ${Math.round(performance.now() - started)}ms: ${child.message}\nstdout:\n${redact(child.stdout ?? '')}\nstderr:\n${redact(child.stderr ?? '')}`,
    { cause: error },
  );
}
