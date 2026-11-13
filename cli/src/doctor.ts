import { existsSync } from 'node:fs';
import { LOCAL_DISTRIBUTION, cliName } from './distribution.js';
import { delimiter, join } from 'node:path';
import { inspectStoredIdentity, keyStoreSelection } from '@acp/runtime/key-store';
import { DEFAULT_PUBLIC_RELAY } from '@acp/runtime/relay-selection';
import { HttpRelayClient, relayProxyFor, relayRetryCode } from '@acp/relay';
import type { IdentityStoreOptions } from '@acp/runtime/key-store';
export interface DoctorOptions {
  version?: string;
  execPath?: string;
  path?: string;
  home?: string;
  exists?: (path: string) => boolean;
  fetch?: typeof fetch;
  offline?: boolean;
  relay?: string;
  allowPrivateRelay?: boolean;
  keyFile?: string;
  identityOptions?: IdentityStoreOptions;
}
export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
  remediation?: string;
  selection?: { backend: string; source: 'option' | 'env' | 'config' | 'default' };
}
export async function diagnose(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const exists = options.exists ?? existsSync;
  const version = options.version ?? process.versions.node;
  const paths = (options.path ?? process.env.PATH ?? '').split(delimiter);
  let keys: DoctorCheck;
  let selection: ReturnType<typeof keyStoreSelection> | undefined;
  try {
    selection = keyStoreSelection({ ...options.identityOptions,
      ...(options.home !== undefined ? { home: options.home } : {}), explicitKeyPath: options.keyFile });
    const identities = await Promise.all((options.keyFile ? ['requester'] as const : ['requester', 'worker'] as const).map(async role => {
      const selected = await inspectStoredIdentity(role, { ...options.identityOptions,
        ...(options.home !== undefined ? { home: options.home } : {}),
        explicitKeyPath: options.keyFile });
      return `${role}: ${selected.location} (${selected.present ? selected.source ?? 'present' : 'optional; created on first use'}) [${selected.backend}]`;
    }));
    keys = { name: 'Keys', ok: true, message: identities.join('; ') + `; selection: ${typeof selection.keyStore === 'object' ? 'custom' : selection.keyStore} (${selection.source})` };
  } catch (error) {
    const setting = selection?.keyStore;
    const backend = setting === 'keychain' ? 'keychain' : typeof setting === 'object' ? 'custom' : 'file';
    keys = { name: 'Keys', ok: false, message: (error as Error).message + (backend === 'file' ? '' : ` [${backend}]`),
      ...(selection && { selection: { backend, source: selection.source } }),
      remediation: 'Check the configured backend and its availability. Install @napi-rs/keyring for keychain use; select SEALBRIDGE_KEY_STORE=file|keychain or --key for an existing file.' };
  }
  const nodeOk = Number(version.split('.')[0]) >= 22;
  const pathOk = paths.some(p => exists(join(p, process.platform === 'win32' ? cliName + '.cmd' : cliName)));
  const checks: DoctorCheck[] = [
    { name: 'Node.js', ok: nodeOk, message: `${version} (${options.execPath ?? process.execPath})`,
      ...(!nodeOk && { remediation: 'Node 22 or newer is required; rerun the installer to update.' }) },
    { name: 'PATH', ok: pathOk, message: pathOk ? cliName + ' found' : cliName + ' not found',
      ...(!pathOk && { remediation: 'Reopen your terminal or add the installer bin directory to PATH.' }) },
    keys,
    { name: 'Local PC execution', ok: true, message: 'From 0.7.0, local workers (including sandbox) and command hooks require --allow-local-pc, with no warning-only period. Isolated runtime is in preparation. sealbridge-local 0.7.0 was published on npm on 2026-11-11 UTC; run npm i -g sealbridge-local and replace sealbridge worker start with sealbridge-local worker start (keys and data directory are reused). The local distribution asks once in a terminal (stdin and stderr must be TTY), or run sealbridge-local config local-pc on there. The on command also requires stdin/stderr TTY; non-interactive local execution must pass --allow-local-pc on every invocation. View status with sealbridge-local config local-pc status; revoke with sealbridge-local config local-pc off. Mainline ignores this saved permission and always requires --allow-local-pc. Owner approval and content inspection stay on.' },
  ];
  if (options.offline) {
    checks.push({ name: 'Relay', ok: true, message: 'Skipped (offline)' });
    return checks;
  }
  const relay = options.relay ?? DEFAULT_PUBLIC_RELAY;
  let relayRoute = '';
  try {
    const proxy = relayProxyFor(new URL(relay));
    relayRoute = proxy ? '; via proxy' : '';
    const client = new HttpRelayClient(relay, options.fetch ?? fetch, { requestTimeoutMs: 8000, allowPrivateRelay: options.allowPrivateRelay });
    const response = await client.fetcher(relay.replace(/\/$/, '') + '/health', { signal: AbortSignal.timeout(8000), redirect: 'error' });
    await response.body?.cancel();
    checks.push({ name: 'Relay', ok: response.ok, message: (response.ok ? 'Reachable' : `HTTP ${response.status}`) + relayRoute,
      ...(!response.ok && { remediation: 'Check your connection and try again.' }) });
  } catch (error) {
    const code = relayRetryCode(error);
    checks.push({ name: 'Relay', ok: false, message: 'Unreachable' + relayRoute + (code === 'RELAY_UNAVAILABLE' ? '' : ` (${code})`), remediation: 'Check internet, proxy or firewall settings, then run sealbridge doctor again.' });
  }
  return checks;
}
export async function doctorCommand(options: DoctorOptions = {}) {
  const checks = await diagnose(options);
  for (const check of checks) console.log(`${check.name}: ${check.message}${check.selection ? `; selection: ${check.selection.backend} (${check.selection.source})` : ''} (${check.ok ? 'OK' : 'WARN'})${!check.ok && check.remediation ? ` ${check.remediation}` : ''}`);
  if (checks.some(check => !check.ok)) process.exitCode = 1;
}

export function parseDoctorArgs(args: string[]): DoctorOptions {
  const result: DoctorOptions = {};
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error('Duplicate option: ' + arg);
    seen.add(arg);
    if (arg === '--offline') result.offline = true;
    else if (arg === '--allow-private-relay') result.allowPrivateRelay = true;
    else if (arg === '--relay' && args[i + 1] && !args[i + 1].startsWith('--')) result.relay = args[++i];
    else if (arg === '--key' && args[i + 1] && !args[i + 1].startsWith('--')) result.keyFile = args[++i];
    else throw new Error('Usage: ' + cliName + ' doctor [--offline] [--key <file>] [--relay <url>] [--allow-private-relay]');
  }
  return result;
}
