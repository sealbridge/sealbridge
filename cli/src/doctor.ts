import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { inspectStoredIdentity } from '@acp/runtime/key-store';
import { DEFAULT_PUBLIC_RELAY } from '@acp/runtime/relay-selection';
import type { IdentityStoreOptions } from '@acp/runtime/key-store';
export interface DoctorOptions {
  version?: string;
  execPath?: string;
  path?: string;
  home?: string;
  exists?: (path: string) => boolean;
  fetch?: typeof fetch;
  offline?: boolean;
  keyFile?: string;
  identityOptions?: IdentityStoreOptions;
}
export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
  remediation?: string;
}
export async function diagnose(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const exists = options.exists ?? existsSync;
  const version = options.version ?? process.versions.node;
  const paths = (options.path ?? process.env.PATH ?? '').split(delimiter);
  let keys: DoctorCheck;
  try {
    const identities = await Promise.all((options.keyFile ? ['requester'] as const : ['requester', 'worker'] as const).map(async role => {
      const selected = await inspectStoredIdentity(role, { ...options.identityOptions,
        ...(options.home !== undefined ? { home: options.home } : {}),
        explicitKeyPath: options.keyFile });
      return `${role}: ${selected.location} (${selected.present ? selected.source ?? 'present' : 'created on first use'}) [${selected.backend}]`;
    }));
    keys = { name: 'Keys', ok: true, message: identities.join('; ') };
  } catch (error) {
    const setting = options.keyFile ? 'file' : options.identityOptions?.keyStore ??
      (options.identityOptions?.env ?? process.env).SEALBRIDGE_KEY_STORE;
    const backend = setting === 'keychain' ? 'keychain' : typeof setting === 'object' ? 'custom' : 'file';
    keys = { name: 'Keys', ok: false, message: (error as Error).message + (backend === 'file' ? '' : ` [${backend}]`),
      remediation: 'Check the configured backend and its availability. Install @napi-rs/keyring for keychain use; select SEALBRIDGE_KEY_STORE=file|keychain or --key for an existing file.' };
  }
  const nodeOk = Number(version.split('.')[0]) >= 22;
  const pathOk = paths.some(p => exists(join(p, process.platform === 'win32' ? 'sealbridge.cmd' : 'sealbridge')));
  const checks: DoctorCheck[] = [
    { name: 'Node.js', ok: nodeOk, message: `${version} (${options.execPath ?? process.execPath})`,
      ...(!nodeOk && { remediation: 'Node 22 or newer is required; rerun the installer to update.' }) },
    { name: 'PATH', ok: pathOk, message: pathOk ? 'sealbridge found' : 'sealbridge not found',
      ...(!pathOk && { remediation: 'Reopen your terminal or add the installer bin directory to PATH.' }) },
    keys,
  ];
  if (options.offline) {
    checks.push({ name: 'Relay', ok: true, message: 'Skipped (offline)' });
    return checks;
  }
  try {
    const response = await (options.fetch ?? fetch)(DEFAULT_PUBLIC_RELAY + '/health', { signal: AbortSignal.timeout(8000), redirect: 'error' });
    checks.push({ name: 'Relay', ok: response.ok, message: response.ok ? 'Reachable' : `HTTP ${response.status}`,
      ...(!response.ok && { remediation: 'Check your connection and try again.' }) });
  } catch {
    checks.push({ name: 'Relay', ok: false, message: 'Unreachable', remediation: 'Check internet, proxy or firewall settings, then run sealbridge doctor again.' });
  }
  return checks;
}
export async function doctorCommand(options: DoctorOptions = {}) {
  const checks = await diagnose(options);
  for (const check of checks) console.log(`${check.name}: ${check.message} (${check.ok ? 'OK' : 'WARN'})${!check.ok && check.remediation ? ` ${check.remediation}` : ''}`);
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
    else if (arg === '--key' && args[i + 1] && !args[i + 1].startsWith('--')) result.keyFile = args[++i];
    else throw new Error('Usage: sealbridge doctor [--offline] [--key <file>]');
  }
  return result;
}
