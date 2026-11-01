// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { resolveDataRoot,
  ensurePrivateDirectory, checkPrivatePath } from '@acp/runtime/local-identity';
import type { IdentityRole } from '@acp/runtime/local-identity';
import { inspectStoredIdentity, resolveStoredIdentity } from '@acp/runtime/key-store';
import type { IdentityStoreOptions } from '@acp/runtime/key-store';
import { readApplicationConfig, validateApplicationConfig, createApplicationConfig } from '@acp/runtime/application-config';
import { selectApplicationRelay } from '@acp/runtime/relay-selection';
import { detectedHosts, hostDestination, runtimeEntry } from './setup-hosts.js';
import type { SetupHost, HostDestination } from './setup-hosts.js';
import { snapshot, strictObject, hostChange, assertUnchanged, publish } from './setup-files.js';

export const SETUP_USAGE = 'Usage: sealbridge setup [--host NAME ... | --all-detected] [--project ABS] [--worker] [--relay URL] [--dry-run | --print]';
export interface SetupOptions extends IdentityStoreOptions {
  hosts?: string[]; allDetected?: boolean; project?: string; worker?: boolean;
  relay?: string; dryRun?: boolean; print?: boolean; execPath?: string; entryPath?: string;
  chooseHost?: (hosts: readonly SetupHost[]) => Promise<SetupHost | undefined>;
}
export function parseSetupArgs(args: string[]): SetupOptions {
  const result: SetupOptions = {}, seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== '--host' && seen.has(arg)) throw new Error('SETUP_INVALID_ARGUMENT');
    seen.add(arg);
    if (['--host', '--project', '--relay'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('SETUP_INVALID_ARGUMENT');
      if (arg === '--host') (result.hosts ??= []).push(value);
      else if (arg === '--project') result.project = value;
      else result.relay = value;
    } else if (arg === '--all-detected') result.allDetected = true;
    else if (arg === '--worker') result.worker = true;
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--print') result.print = true;
    else throw new Error('SETUP_INVALID_ARGUMENT');
  }
  validateOptions(result);
  return result;
}
function validateOptions(options: SetupOptions) {
  if ((options.hosts?.length && options.allDetected) || (options.dryRun && options.print) ||
      (options.project !== undefined && !options.hosts?.includes('claude-code')) ||
      options.hosts?.length === 0) throw new Error('SETUP_INVALID_ARGUMENT');
}
export async function selectSetupHosts(options: SetupOptions): Promise<HostDestination[]> {
  validateOptions(options);
  if (options.hosts) return [...new Set(options.hosts)].map(host => hostDestination(host, options));
  const detected = detectedHosts(options);
  if (detected.length === 1 || (options.allDetected && detected.length)) return detected;
  if (!options.allDetected && detected.length > 1 && options.chooseHost) {
    const selected = await options.chooseHost(detected.map(host => host.host));
    const host = detected.find(host => host.host === selected);
    if (host) return [host];
  }
  throw new Error('SETUP_HOST_REQUIRED');
}
export function setupExitCode(code: string): number {
  if (['SETUP_INVALID_ARGUMENT', 'SETUP_HOST_REQUIRED', 'SETUP_HOST_UNSUPPORTED'].includes(code)) return 2;
  if (['SETUP_ENTRY_CONFLICT', 'SETUP_CONFIG_CONFLICT', 'SETUP_CONFIG_INVALID', 'SETUP_RUNTIME_UNSTABLE'].includes(code)) return 3;
  return 1;
}
function errorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (/^(SETUP_|IDENTITY_|DATA_DIR_|KEY_STORE_)[A-Z_]+$/.test(code)) return code;
  if (code === 'APP_CONFIG_BUSY') return 'SETUP_CONFIG_CHANGED';
  if (/^APP_CONFIG_/.test(code)) return code === 'APP_CONFIG_UNWRITABLE' ? 'SETUP_WRITE_FAILED' : 'SETUP_CONFIG_INVALID';
  return 'SETUP_WRITE_FAILED';
}

/** Local preflight and apply; never starts a host, MCP server, or relay connection. */
export async function runSetup(options: SetupOptions = {}) {
  const io = options.fs ?? fs, platform = options.platform ?? process.platform;
  const hosts = await selectSetupHosts(options), root = resolveDataRoot(options);
  const entry = runtimeEntry(root, options);
  const roles: IdentityRole[] = options.worker ? ['requester', 'worker'] : ['requester'];
  const identities = await Promise.all(roles.map(async role => {
    const selected = await inspectStoredIdentity(role, options);
    return { role, path: selected.location, source: selected.source,
      status: selected.key ? 'reused' : 'created on apply', did: selected.key?.did };
  }));
  const configOriginal = snapshot(join(root, 'config.json'), io, platform);
  if (configOriginal.bytes) strictObject(configOriginal.bytes);
  let config;
  try {
    config = readApplicationConfig(options);
    if (options.relay !== undefined) {
      const proposed = validateApplicationConfig({ version: 1, relays: [options.relay] }, options);
      if (configOriginal.bytes && proposed.relays[0] !== config.relays[0]) throw new Error('SETUP_CONFIG_CONFLICT');
      if (!configOriginal.bytes) config = proposed;
    }
  } catch (error) { throw new Error(errorCode(error) === 'SETUP_WRITE_FAILED' ? 'SETUP_CONFIG_INVALID' : errorCode(error)); }
  const selected = selectApplicationRelay({ fallbackCandidates: config.relays });
  const changes = hosts.map(host => ({ host, change: hostChange(snapshot(host.path, io, platform), entry) }));
  if (options.print) return { snippets: hosts.map(({ host, path }) => ({ host, path, mcpServers: { sealbridge: entry } })) };
  const summary = {
    mode: options.dryRun ? 'dry-run' : 'apply', identities,
    config: { path: configOriginal.path, previous: configOriginal.bytes ? 'existing' : 'previously absent',
      status: configOriginal.bytes ? 'reused' : 'created on apply',
      relay: selected.relay, source: configOriginal.bytes ? 'local-default' : options.relay ? 'setup --relay' : 'built-in default' },
    destinations: changes.map(({ host, change }) => ({ host: host.host, path: host.path,
      previous: change.bytes ? 'existing' : 'previously absent',
      status: change.bytes?.equals(change.next) ? 'unchanged' : 'planned', backup: undefined as string | undefined })),
    next: 'Reload the selected host, then check its MCP tools. Setup does not check host readiness or grant task approval.',
    error: undefined as string | undefined,
  };
  if (options.dryRun) return summary;
  let lock: number | undefined;
  const lockPath = join(root, '.setup.lock');
  try {
    ensurePrivateDirectory(root, io, platform);
    checkPrivatePath(lockPath, io, platform);
    try { lock = io.openSync(lockPath, 'wx', 0o600); }
    catch (error) { throw new Error((error as NodeJS.ErrnoException).code === 'EEXIST' ? 'SETUP_CONFIG_BUSY' : 'SETUP_WRITE_FAILED'); }
    // One exclusive lock attempt is bounded. Revalidate every destination after acquiring it.
    assertUnchanged(configOriginal, io, platform);
    for (const { change } of changes) assertUnchanged(change, io, platform);
    for (const role of roles) await inspectStoredIdentity(role, options);
    for (const identity of identities) {
      identity.did = (await resolveStoredIdentity(identity.role, options)).did;
      identity.status = identity.status === 'reused' ? 'reused' : 'created';
    }
    if (!configOriginal.bytes) {
      createApplicationConfig(config, options);
      summary.config.status = 'created';
    }
    for (let i = 0; i < changes.length; i++) {
      const { change } = changes[i], destination = summary.destinations[i];
      try {
        publish(change, root, io, platform);
        destination.status = destination.status === 'unchanged' ? 'unchanged' : 'configured';
      } catch (error) { destination.status = 'failed'; throw error; }
      finally { destination.backup = change.backup; }
    }
  } catch (error) { summary.error = errorCode(error); }
  finally {
    if (lock !== undefined) {
      try {
        const owned = io.fstatSync(lock), current = io.lstatSync(lockPath);
        if (current.dev === owned.dev && current.ino === owned.ino && !current.isSymbolicLink()) io.unlinkSync(lockPath);
        else summary.error = 'SETUP_CONFIG_CHANGED';
      } catch { summary.error ??= 'SETUP_WRITE_FAILED'; }
      finally { try { io.closeSync(lock); } catch { summary.error ??= 'SETUP_WRITE_FAILED'; } }
    }
  }
  return summary;
}

export async function setupCommand(args: string[]) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(SETUP_USAGE + '\nHosts: claude-desktop (macOS/Windows), cursor, claude-code (explicit --project only).\nLocal only. Close host settings before applying; reload the host afterward.\n--dry-run reads and validates; --print outputs proposed entries. Neither writes files.\nUse a persistent installation or a built checkout; setup does not install dependencies.');
    return;
  }
  try {
    const options = parseSetupArgs(args);
    if (process.stdin.isTTY && process.stderr.isTTY) options.chooseHost = async hosts => {
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await prompt.question('Choose host (' + hosts.map((host, i) => `${i + 1}: ${host}`).join(', ') + '), or Enter to cancel: ');
        return /^\d+$/.test(answer.trim()) ? hosts[Number(answer.trim()) - 1] : undefined;
      } catch { return undefined; } finally { prompt.close(); }
    };
    const result = await runSetup(options);
    console.log(JSON.stringify(result, null, 2));
    if ('error' in result && result.error) {
      console.error(result.error);
      process.exitCode = setupExitCode(result.error);
    }
  } catch (error) {
    const code = errorCode(error);
    console.error(code);
    process.exitCode = setupExitCode(code);
  }
}
