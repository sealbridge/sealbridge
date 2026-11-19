// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { windowsTestShell } from './windows-test-shell.js';

it.each(['powershell.exe', 'pwsh'])(
  'stops after the first %s match without examining later slow PATH entries',
  (shell) => {
    const name = shell.endsWith('.exe') ? shell : shell + '.exe';
    const probe = vi.fn((path: string) => {
      if (path.startsWith('Z:')) throw new Error('later network PATH must not be scanned');
      return path === 'C:\\shells\\' + name;
    });
    expect(windowsTestShell(shell, { Path: 'C:\\missing;C:\\shells;Z:\\slow' }, probe)).toBe(
      'C:\\shells\\' + name,
    );
    expect(probe.mock.calls.map(([path]) => path)).toEqual([
      'C:\\missing\\' + name,
      'C:\\shells\\' + name,
    ]);
  },
);

it('handles quoted PATH directories and skips empty entries', () => {
  expect(
    windowsTestShell('pwsh', { PATH: ';"C:\\Program Files\\PowerShell\\7";' }, () => true),
  ).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
});

it('fails explicitly when the required shell is unavailable', () => {
  expect(() => windowsTestShell('pwsh', { PATH: 'C:\\missing' }, () => false)).toThrow(
    'Required Windows test shell not found on PATH: pwsh',
  );
});
