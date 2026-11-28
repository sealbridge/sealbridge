// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  detectDockerRuntime,
  runContainerOrSubprocessSandbox,
} from '../packages/sandbox/src/container.js';
afterEach(() => vi.unstubAllEnvs());

it.runIf(process.platform === 'win32')(
  'preserves native missing-runtime detection and subprocess fallback',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oci-absence-fixture-'));
    vi.stubEnv('PATH', directory);
    try {
      expect(await detectDockerRuntime()).toBeUndefined();
      const result = await runContainerOrSubprocessSandbox({
        isolationLevel: 'oci_container',
        code: 'return input;',
        input: 'synthetic',
        timeoutMs: 2000,
        onTool: async () => null,
      });
      expect(result.output).toBe('synthetic');
      expect(result.effectiveIsolationLevel).toBe('subprocess_restricted');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
