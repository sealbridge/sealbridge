// SPDX-License-Identifier: Apache-2.0
import { dirname, win32 } from 'node:path';

/** Minimal environment for command adapters; application state belongs to the task home. */
export function sanitizedCommandEnvironment(
  directory: string,
  commandDirectories: readonly string[] = [],
): NodeJS.ProcessEnv {
  const base = { LANG: 'C.UTF-8', TZ: 'UTC', HOME: directory, TMPDIR: directory };
  if (process.platform !== 'win32') return { ...base, PATH: '/usr/local/bin:/usr/bin:/bin' };
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  return {
    ...base,
    SystemRoot: root,
    ComSpec: win32.join(root, 'System32', 'cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PATH: [
      ...new Set([
        ...commandDirectories,
        dirname(process.execPath),
        win32.join(root, 'System32'),
        root,
        win32.join(root, 'System32', 'Wbem'),
        win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0'),
      ]),
    ].join(';'),
    TEMP: directory,
    TMP: directory,
    USERPROFILE: directory,
    APPDATA: win32.join(directory, 'AppData', 'Roaming'),
    LOCALAPPDATA: win32.join(directory, 'AppData', 'Local'),
  };
}
