// SPDX-License-Identifier: Apache-2.0
import { statSync } from 'node:fs';
import { win32 } from 'node:path';

/** Test fixtures need the first shell, not where.exe's exhaustive PATH scan. */
export function windowsTestShell(
  shell: string,
  env: NodeJS.ProcessEnv = process.env,
  isFile: (path: string) => boolean = (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
): string {
  const path = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const executable = /\.exe$/i.test(shell) ? shell : shell + '.exe';
  for (const item of path.split(';')) {
    const directory = item.replace(/^"(.*)"$/, '$1');
    if (!directory) continue;
    const candidate = win32.join(directory, executable);
    if (isFile(candidate)) return candidate;
  }
  throw new Error(`Required Windows test shell not found on PATH: ${shell}`);
}
