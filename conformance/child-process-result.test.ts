// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';
import { checkedChildOutput } from './child-process-result.js';

it('includes both captured streams and the timeout reason for a stalled child', () => {
  const result: SpawnSyncReturns<string> = {
    pid: 123, status: null, signal: 'SIGKILL', output: [],
    error: Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    stdout: 'startup complete\nacp-invite:fixture-secret\n', stderr: 'waiting for fixture lock\n',
  };
  expect(() => checkedChildOutput(result)).toThrow(/ETIMEDOUT[\s\S]*stdout:[\s\S]*startup complete[\s\S]*stderr:[\s\S]*waiting for fixture lock/);
  try { checkedChildOutput(result); } catch (error) {
    expect((error as Error).message).not.toContain('fixture-secret');
  }
});

it('returns successful output and includes both streams for nonzero exits', () => {
  const result: SpawnSyncReturns<string> = { pid: 123, status: 0, signal: null, output: [], stdout: '{}', stderr: '' };
  expect(checkedChildOutput(result)).toBe('{}');
  expect(() => checkedChildOutput({ ...result, status: 1, stderr: 'failed to start' }))
    .toThrow(/exit 1[\s\S]*stdout:[\s\S]*\{\}[\s\S]*stderr:[\s\S]*failed to start/);
});
