// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DataRootOptions } from '@acp/runtime/local-identity';

export type SetupHost = 'claude-desktop' | 'cursor' | 'claude-code';
export interface HostDestination { host: SetupHost; path: string; evidence: string }
export interface HostOptions extends DataRootOptions { fs?: typeof fs; project?: string }
export function hostDestination(host: string, options: HostOptions): HostDestination {
  const platform = options.platform ?? process.platform, paths = platform === 'win32' ? win32 : posix;
  const home = options.home ?? homedir(), env = options.env ?? process.env;
  if (!paths.isAbsolute(home)) throw new Error('SETUP_INVALID_ARGUMENT');
  let path: string;
  if (host === 'cursor') path = paths.join(home, '.cursor', 'mcp.json');
  else if (host === 'claude-desktop' && platform === 'darwin')
    path = paths.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  else if (host === 'claude-desktop' && platform === 'win32' && env.APPDATA && paths.isAbsolute(env.APPDATA))
    path = paths.join(env.APPDATA, 'Claude', 'claude_desktop_config.json');
  else if (host === 'claude-code') {
    if (!options.project || !paths.isAbsolute(options.project)) throw new Error('SETUP_INVALID_ARGUMENT');
    path = paths.join(options.project, '.mcp.json');
  } else throw new Error('SETUP_HOST_UNSUPPORTED');
  return { host: host as SetupHost, path, evidence: paths.dirname(path) };
}
export function detectedHosts(options: HostOptions): HostDestination[] {
  const result: HostDestination[] = [], io = options.fs ?? fs;
  for (const name of ['claude-desktop', 'cursor']) {
    let host: HostDestination;
    try { host = hostDestination(name, options); }
    catch (error) { if ((error as Error).message === 'SETUP_HOST_UNSUPPORTED') continue; throw error; }
    try { if (io.lstatSync(host.evidence).isDirectory()) result.push(host); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('SETUP_WRITE_FAILED'); }
  }
  return result;
}

export interface McpEntry { command: string; args: string[]; env: { SEALBRIDGE_DATA_DIR: string } }
/** Resolve module-relative installed JavaScript, never a PATH shim or cwd-relative script. */
export function runtimeEntry(root: string, options: {
  fs?: typeof fs; platform?: NodeJS.Platform; execPath?: string; entryPath?: string; requireApproval?: boolean;
} = {}): McpEntry {
  const io = options.fs ?? fs, platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? win32 : posix;
  const resolve = (path: string) => {
    if (!paths.isAbsolute(path)) throw new Error('SETUP_RUNTIME_UNSTABLE');
    const result = io.realpathSync(path);
    if (/(^|[\\/])(_npx|npx|dlx|_tmp|\.tmp)([\\/]|$)|[\\/]\.pnpm[\\/]tmp[\\/]/i.test(path + '/' + result) ||
        !io.statSync(result).isFile()) throw new Error('SETUP_RUNTIME_UNSTABLE');
    return result;
  };
  try {
    const command = resolve(options.execPath ?? process.execPath);
    const entry = resolve(options.entryPath ?? fileURLToPath(new URL('./index.js', import.meta.url)));
    if (!entry.endsWith('.js') || (platform === 'win32' && !/\.exe$/i.test(command))) throw new Error();
    return { command, args: [entry, 'mcp-server', ...(options.requireApproval === false ? [] : ['--require-approval'])],
      env: { SEALBRIDGE_DATA_DIR: root } };
  } catch { throw new Error('SETUP_RUNTIME_UNSTABLE'); }
}
