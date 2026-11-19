// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.each([
  { args: ['--help'], label: '--help' },
  { args: ['-h'], label: '-h' },
  { args: ['help'], label: 'help' },
])('prints top-level help to stdout: $label', ({ args }) => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../cli/dist/index.js', import.meta.url)), ...args],
    { encoding: 'utf8', timeout: 10000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/^Usage: sealbridge /);
  expect(result.stdout).toContain('worker|delegate|discover');
  expect(result.stderr).toBe('');
});

it('treats no arguments as a usage error without a relay connection failure', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../cli/dist/index.js', import.meta.url))],
    { encoding: 'utf8', timeout: 10000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(/^Usage: sealbridge /);
  expect(result.stderr).toContain('worker|delegate|discover');
  expect(result.stderr).not.toContain('中継器に接続できません');
});
