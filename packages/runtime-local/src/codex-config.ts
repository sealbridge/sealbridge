// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizedCommandEnvironment } from '@acp/sandbox';
import type { CommandRequest, CommandRunner, ResolvedCliCommand } from './command.js';
import type { CredentialProxyHandle } from './credential-proxy.js';

const VERIFIED_VERSION = '0.163.0';
const TOKEN_ENV = 'SEALBRIDGE_CODEX_PROXY_TOKEN';

function checkVersion(stdout: string, exitCode = 0): void {
  const match = /^(?:codex(?:-cli)?\s+)?v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(stdout.trim());
  const parts = match?.slice(1, 4).map((part) => BigInt(part));
  const verified = [0n, 163n, 0n];
  const different = parts?.findIndex((part, i) => part !== verified[i]) ?? -1;
  const comparison = parts && different >= 0 ? (parts[different] > verified[different] ? 1 : -1) : 0;
  if (exitCode !== 0 || !match || comparison < 0 || comparison === 0 && match[4])
    throw new Error('CODEX_PROXY_UNSUPPORTED_VERSION: install @openai/codex ' + VERIFIED_VERSION + ' or newer');
  if (comparison > 0)
    console.warn('CODEX_PROXY_NEWER_VERSION: Codex CLI ' + match[0].replace(/^codex(?:-cli)?\s+/, '') +
      ' is newer than verified version ' + VERIFIED_VERSION + '; continuing with proxy routing checks.');
}

/** Only inference and sandbox options may accompany the generated provider configuration. */
function validateExtraArgs(args: readonly string[]): void {
  for (let i = 0; i < args.length; i++) {
    if (/^(--model|-m|--sandbox|-s|--color)$/.test(args[i])) {
      if (!args[++i] || args[i].startsWith('-')) throw new Error('CODEX_PROXY_INVALID_ARGUMENT');
    } else if (!/^(--model|--sandbox|--color)=.+$/.test(args[i])) {
      throw new Error('CODEX_PROXY_UNSUPPORTED_ARGUMENT: use model, sandbox or color options');
    }
  }
}

function validateInvocation(args: readonly string[]): void {
  if (args[0] !== 'exec' || args[1] !== '--json' || args[2] !== '--skip-git-repo-check' || args.at(-1) !== '-')
    throw new Error('CODEX_PROXY_UNSUPPORTED_ARGUMENT: expected the task exec invocation');
  validateExtraArgs(args.slice(3, -1));
}

/** Verify the routing fields in the file and in the actual CLI overrides. */
function verifyRouting(config: string, args: readonly string[], proxyUrl: string): void {
  const expected: Record<string, unknown> = {
    model_provider: 'sealbridge-proxy',
    'model_providers.sealbridge-proxy.base_url': proxyUrl + '/v1',
    'model_providers.sealbridge-proxy.wire_api': 'responses',
    'model_providers.sealbridge-proxy.env_key': TOKEN_ENV,
    'model_providers.sealbridge-proxy.requires_openai_auth': false,
    'model_providers.sealbridge-proxy.supports_websockets': false,
  };
  let table = '';
  const fileSettings: string[] = [];
  for (const line of config.split('\n')) {
    if (line.startsWith('[')) table = line.slice(1, -1) + '.';
    else if (line) fileSettings.push(table + line);
  }
  const overrides = args.flatMap((arg, i) => arg === '-c' ? [args[i + 1]] : []);
  for (const settings of [fileSettings, overrides]) {
    for (const [key, value] of Object.entries(expected)) {
      const matches = settings.filter((setting) => setting.slice(0, setting.indexOf('=')).trim() === key);
      if (matches.length !== 1 || matches[0].slice(matches[0].indexOf('=') + 1).trim() !== JSON.stringify(value))
        throw new Error('CODEX_PROXY_INVALID_CONFIG: expected the task loopback provider and matching overrides');
    }
  }
}

function proxyConfig(proxy: Pick<CredentialProxyHandle, 'url' | 'token'>): string {
  let url: URL;
  try { url = new URL(proxy.url); }
  catch { throw new Error('CODEX_PROXY_INVALID_URL: expected the task loopback proxy'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.pathname !== '/' || url.search || url.hash || url.username || url.password ||
      url.origin !== proxy.url || !proxy.token)
    throw new Error('CODEX_PROXY_INVALID_URL: expected the task loopback proxy');
  return `model_provider = "sealbridge-proxy"
forced_login_method = "api"
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
web_search = "disabled"

[model_providers.sealbridge-proxy]
name = "Sealbridge proxy"
base_url = ${JSON.stringify(url.origin + '/v1')}
wire_api = "responses"
env_key = "${TOKEN_ENV}"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0

[analytics]
enabled = false
[feedback]
enabled = false
[otel]
exporter = "none"
trace_exporter = "none"

[features]
api_key_model_discovery = false
apps = false
plugins = false
remote_plugin = false
skill_search = false
daemon_auto_start = false
shell_snapshot = false
enable_request_compression = false
system_proxy_fallback = false
unbounded_connection_retries = false
`;
}

export interface CodexProxyInvocation {
  invocation: ResolvedCliCommand;
  env: NodeJS.ProcessEnv;
  close(): Promise<void>;
}

/** Create a fresh CLI home and check the CLI release before starting an inference run. */
export async function prepareCodexProxy(options: {
  proxy: Pick<CredentialProxyHandle, 'url' | 'token'>;
  invocation: ResolvedCliCommand;
  extraArgs: readonly string[];
  request: Pick<CommandRequest, 'cwd' | 'signal' | 'timeoutMs'>;
  runner: CommandRunner;
}): Promise<CodexProxyInvocation> {
  validateExtraArgs(options.extraArgs);
  validateInvocation(options.invocation.args);
  const config = proxyConfig(options.proxy);
  const home = await mkdtemp(join(tmpdir(), 'sealbridge-codex-'));
  const close = () => rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  try {
    const configPath = join(home, 'config.toml');
    await writeFile(configPath, config, { mode: 0o600, flag: 'wx' });
    const env = {
      ...sanitizedCommandEnvironment(home),
      CODEX_HOME: home,
      [TOKEN_ENV]: options.proxy.token,
      // Keep HTTP proxy settings scoped to this CLI process.
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      ALL_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '127.0.0.1,localhost',
    };
    const version = await options.runner({
      ...options.request,
      timeoutMs: Math.min(10000, options.request.timeoutMs),
      command: options.invocation.command,
      args: ['--version'],
      env,
      input: '',
    });
    checkVersion(version.stdout, version.exitCode);
    if (await readFile(configPath, 'utf8') !== config ||
        (await readdir(home)).some((name) => /^auth\./i.test(name)))
      throw new Error('CODEX_PROXY_INVALID_CONFIG: use a fresh CLI home');
    // Codex 0.163.0 help (exec, debug, features, doctor) exposes no documented
    // offline resolved-provider dump. Verify our file and exact argv instead;
    // strict-config checks the schema and ignore-user-config omits user layers.
    // The environment is generated from an allowlist, without owner provider,
    // profile or config environment variables such as OPENAI_BASE_URL.
    const args = [...options.invocation.args];
    // CLI overrides also take precedence over any project configuration in the workspace.
    let table = '';
    const overrides: string[] = [];
    for (const line of config.split('\n')) {
      if (!line) continue;
      if (line.startsWith('[')) table = line.slice(1, -1) + '.';
      else overrides.push('-c', table + line);
    }
    args.splice(1, 0, '--strict-config', '--ignore-user-config', '--ephemeral', '--ignore-rules', ...overrides);
    verifyRouting(await readFile(configPath, 'utf8'), args, options.proxy.url);
    return { invocation: { command: options.invocation.command, args }, env, close };
  } catch (error) {
    await close();
    throw error;
  }
}
