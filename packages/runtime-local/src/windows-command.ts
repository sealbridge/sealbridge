// SPDX-License-Identifier: Apache-2.0
import { readFile, access } from 'node:fs/promises';
import { dirname, win32 } from 'node:path';

/** PATHEXT lookup prefers native executables to command scripts in each directory. */
export function windowsCommandCandidates(command: string, pathExt = '.COM;.EXE;.BAT;.CMD'): string[] {
  if (win32.extname(command)) return [command];
  const extensions = [...new Set(pathExt.toUpperCase().split(';')
    .filter((ext) => /^\.[A-Z0-9]+$/.test(ext)))];
  extensions.sort((a, b) => Number(!['.COM', '.EXE'].includes(a)) - Number(!['.COM', '.EXE'].includes(b)));
  return extensions.map((ext) => command + ext.toLowerCase());
}

/** Batch arguments use a deliberately restricted alphabet inside double quotes. */
export function quoteWindowsBatchArgument(value: string): string {
  if (/["%\r\n\0!^]/.test(value)) throw new Error('COMMAND_UNSUPPORTED_BATCH_ARGUMENT');
  return '"' + value + '"';
}

/** Recognize the relative JavaScript entry in npm's generated Windows shim. */
export async function npmShimEntry(command: string): Promise<string | undefined> {
  const text = await readFile(command, 'utf8');
  const match = text.match(/"%(?:dp0%|~dp0)[\\/]([^"\r\n]+\.(?:cjs|mjs|js))"\s+%\*/i);
  if (!match) return undefined;
  const relative = match[1];
  if (win32.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) return undefined;
  const entry = win32.join(dirname(command), relative);
  try {
    await access(entry);
    return entry;
  } catch {
    return undefined;
  }
}
