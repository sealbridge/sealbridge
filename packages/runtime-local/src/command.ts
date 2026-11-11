// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { access, realpath, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { startCredentialProxy, type CredentialProxyHandle } from './credential-proxy.js';
import { sanitizedCommandEnvironment } from '@acp/sandbox';
import { npmShimEntry, quoteWindowsBatchArgument, windowsCommandCandidates } from './windows-command.js';
import { prepareCodexProxy } from './codex-config.js';
import type { Json, AgentSkill } from '@acp/core';
import type { AgentAdapter, AgentTaskContext } from './adapter-port.js';
export interface CommandRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  signal: AbortSignal;
  timeoutMs: number;
}
export interface CommandResult {
  stdout: string;
  stderr?: string;
  exitCode?: number;
}
export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;
export async function resolveCommand(command: string): Promise<string> {
  const windows = process.platform === 'win32';
  if (isAbsolute(command) && (!windows || /\.[^\\/]+$/.test(command))) return command;
  if (!isAbsolute(command) && /[\\/]/.test(command))
    throw new Error('COMMAND_MUST_BE_ABSOLUTE_OR_ON_PATH');
  const candidates = windows ? windowsCommandCandidates(command, process.env.PATHEXT) : [command];
  const directories = isAbsolute(command) ? [dirname(command)] :
    (process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(delimiter);
  for (const dir of directories) {
    if (!isAbsolute(dir)) continue;
    for (const candidate of candidates) {
      const path = isAbsolute(candidate) ? candidate : join(dir, candidate);
      try {
        await access(path, windows ? constants.F_OK : constants.X_OK);
        return path;
      } catch {
        /* next executable candidate */
      }
    }
  }
  throw new Error('COMMAND_NOT_FOUND: ' + command);
}
export const runCommand: CommandRunner = async (request) => {
  const command = await resolveCommand(request.command);
  const windows = process.platform === 'win32';
  const batch = windows && /\.(cmd|bat)$/i.test(command);
  const entry = batch ? await npmShimEntry(command) : undefined;
  // Windows refuses to spawn a .js/.cjs/.mjs path directly (EFTYPE). Run it with this Node.
  const target = await realpath(command);
  const script = entry ?? (/\.(?:cjs|mjs|js)$/i.test(target) ? target : undefined);
  const defaults = sanitizedCommandEnvironment(request.env.HOME ?? request.cwd, [dirname(command)]);
  const env = windows ? { ...defaults, ...request.env } : { ...request.env };
  if (windows) {
    // Node treats Windows environment names without case distinctions.
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env.PATH = defaults.PATH;
  }
  const binary = script ? process.execPath : batch ? defaults.ComSpec! : command;
  const args = script ? [script, ...request.args] : batch ?
    ['/d', '/s', '/v:off', '/c', '"' + [command, ...request.args].map(quoteWindowsBatchArgument).join(' ') + '"'] : request.args;
  const windowsVerbatimArguments = windows && (batch && !script ||
    basename(binary).toLowerCase() === 'cmd.exe' && args.includes('/c'));
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: request.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsVerbatimArguments,
      detached: process.platform !== 'win32',
    });
    let stdout = '',
      stderr = '',
      size = 0,
      settled = false;
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    };
    const finish = (error?: Error, code = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal.removeEventListener('abort', abort);
      kill();
      error ? reject(error) : resolve({ stdout, stderr, exitCode: code });
    };
    const abort = () => finish(new Error('ADAPTER_ABORTED'));
    const timer = setTimeout(() => finish(new Error('ADAPTER_TIMEOUT')), request.timeoutMs);
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    child.stdout.on('data', (b: Buffer) => {
      size += b.length;
      if (size > 4194304) finish(new Error('ADAPTER_OUTPUT_LIMIT'));
      else stdout += b.toString();
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-4096);
    });
    child.on('error', () => finish(new Error('ADAPTER_SPAWN_FAILED')));
    child.on('close', (code) =>
      finish(code === 0 ? undefined : new Error('ADAPTER_EXIT: ' + code), code ?? 1),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(request.input);
  });
};
export function parseJsonDeliverable(value: unknown): Json {
  if (typeof value !== 'string') return JSON.parse(JSON.stringify(value)) as Json;
  const text = value
    .trim()
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```$/, '');
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new Error('ADAPTER_INVALID_JSON');
  }
}
export interface CommandAdapterOptions {
  command: string | string[];
  args?: string[];
  runner?: CommandRunner;
  id?: string;
  name?: string;
  skills?: AgentSkill[];
}
export class CommandAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly skills: AgentSkill[];
  constructor(readonly options: CommandAdapterOptions) {
    this.id = options.id ?? 'command';
    this.name = options.name ?? 'Command Worker';
    this.skills = options.skills ?? [{ id: 'json-task', name: 'JSON task' }];
  }
  protected invocation(): { command: string; args: string[] } {
    if (Array.isArray(this.options.command)) {
      const [command, ...args] = this.options.command;
      if (!command) throw new Error('MISSING_COMMAND');
      return { command, args: [...args, ...(this.options.args ?? [])] };
    }
    // String commands are explicitly owner-configured shell scripts.
    if (process.platform === 'win32') {
      const shell = sanitizedCommandEnvironment('').ComSpec!;
      const extra = (this.options.args ?? []).map(quoteWindowsBatchArgument);
      return { command: shell, args: ['/d', '/s', '/v:off', '/c',
        '"' + [this.options.command, ...extra].join(' ') + '"'] };
    }
    return {
      command: '/bin/sh',
      args: ['-c', this.options.command, 'acp-task', ...(this.options.args ?? [])],
    };
  }
  /** Executable and arguments that `executeCommand` will spawn. */
  resolvedInvocation(): { command: string; args: string[] } {
    return this.invocation();
  }
  protected decode(stdout: string, _context: AgentTaskContext): Json {
    return parseJsonDeliverable(stdout);
  }
  protected encodeInput(context: AgentTaskContext): string {
    return JSON.stringify(context.input);
  }
  async executeTask(context: AgentTaskContext): Promise<Json> {
    return this.executeCommand(context);
  }
  protected async executeCommand(
    context: AgentTaskContext,
    environment: NodeJS.ProcessEnv = {},
    invocation = this.invocation(),
  ): Promise<Json> {
    context.signal.throwIfAborted();
    const started = Date.now();
    const input = JSON.stringify(context.input),
      inputFile = join(context.workspaceDir, 'input.json');
    await writeFile(inputFile, input, { mode: 0o600 });
    try {
      const result = await (this.options.runner ?? runCommand)({
        ...invocation,
        cwd: context.workspaceDir,
        env: {
          ...sanitizedCommandEnvironment(context.workspaceDir),
          TASK_INPUT_FILE: inputFile,
          ...environment,
        },
        input: this.encodeInput(context),
        signal: context.signal,
        timeoutMs: context.manifest.budget.maxWallClockSeconds * 1000,
      });
      context.signal.throwIfAborted();
      if (result.exitCode && result.exitCode !== 0)
        throw new Error('ADAPTER_EXIT: ' + result.exitCode);
      return this.decode(result.stdout, context);
    } finally {
      context.reportUsage({ wallTimeMs: Date.now() - started });
      context.reportIsolation?.('workspace_process');
    }
  }
}
export interface CliOptions {
  binaryPath?: string;
  extraArgs?: string[];
  command?: string | string[];
  runner?: CommandRunner;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /**
   * Maximum provider requests the credential proxy will forward for one task.
   * When omitted, the proxy uses the task budget's tool-invocation cap, or 16.
   */
  maxRequests?: number;
}
/** Default CLI invocations use a fresh HOME, so host CLI logins are unavailable. */
export function assertCliAuthentication(adapter: 'claude' | 'codex', options: CliOptions = {}): void {
  // Owner-supplied commands/runners manage their own authentication.
  if (options.command || options.runner) return;
  const variable = options.apiKeyEnv ?? (adapter === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');
  if (options.apiKey ?? process.env[variable]) return;
  throw new Error('AGENT_AUTH_REQUIRED: ' + adapter +
    ' runs with a fresh task HOME; local CLI logins (~/.claude or ~/.codex) are unavailable. ' +
    'Configure ' + variable + ' in the worker host environment before starting. ' +
    'Never put credentials in task input or invitations.');
}
const CLAUDE_PERMISSION_MODES = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];
const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];
export type CliToolList = string | readonly string[];
export interface ClaudeCodeAdapterOptions extends CliOptions {
  /** Value of `--tools`. Defaults to the read-only set `Read,Glob,Grep`. */
  tools?: CliToolList;
  /** Used when `tools` is omitted. Passed with the same `--tools` flag. */
  allowedTools?: CliToolList;
  /** Value of `--disallowedTools`. Defaults to shell, file-write, and web tools. */
  disallowedTools?: CliToolList;
  /** Value of `--permission-mode`. Defaults to `dontAsk`. */
  permissionMode?: ClaudePermissionMode;
  /**
   * Omit the read-only defaults. Explicit `tools`, `disallowedTools`, and
   * `permissionMode` are still passed, and `extraArgs` can still set the flags.
   */
  allowUnsafeTools?: boolean;
}
export interface CodexAdapterOptions extends CliOptions {
  /** Value of `--sandbox`. Defaults to `read-only`. */
  sandbox?: CodexSandboxMode;
}
export interface ResolvedCliCommand {
  command: string;
  args: string[];
}
const CLAUDE_READ_ONLY_TOOLS = 'Read,Glob,Grep';
const CLAUDE_DISALLOWED_TOOLS = 'Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch';
function joinTools(value: CliToolList): string {
  return typeof value === 'string' ? value : value.join(',');
}
function cliFlagPresent(args: readonly string[], names: readonly string[]): boolean {
  return args.some((arg) => names.some((name) => arg === name || arg.startsWith(name + '=')));
}
function assertOneOf<T extends string>(value: string, allowed: readonly T[], code: string): T {
  if (!(allowed as readonly string[]).includes(value)) throw new Error(code);
  return value as T;
}
function claudeRestrictionArgs(
  options: ClaudeCodeAdapterOptions,
  extra: readonly string[],
): string[] {
  const unsafe = options.allowUnsafeTools === true;
  const flags: string[] = [];
  const tools = options.tools !== undefined ? options.tools : options.allowedTools;
  if (!cliFlagPresent(extra, ['--tools'])) {
    if (tools !== undefined) flags.push('--tools', joinTools(tools));
    else if (!unsafe) flags.push('--tools', CLAUDE_READ_ONLY_TOOLS);
  }
  if (!cliFlagPresent(extra, ['--disallowedTools', '--disallowed-tools'])) {
    if (options.disallowedTools !== undefined)
      flags.push('--disallowedTools', joinTools(options.disallowedTools));
    else if (!unsafe) flags.push('--disallowedTools', CLAUDE_DISALLOWED_TOOLS);
  }
  if (!cliFlagPresent(extra, ['--permission-mode', '--permissionMode'])) {
    if (options.permissionMode !== undefined)
      flags.push(
        '--permission-mode',
        assertOneOf(options.permissionMode, CLAUDE_PERMISSION_MODES, 'INVALID_PERMISSION_MODE'),
      );
    else if (!unsafe) flags.push('--permission-mode', 'dontAsk');
  }
  return flags;
}
/** Argv for Claude Code. Read-only tool flags apply unless the owner relaxes that flag. */
export function resolveClaudeCodeCliCommand(
  options: ClaudeCodeAdapterOptions = {},
): ResolvedCliCommand {
  const extra = options.extraArgs ?? [];
  return {
    command: options.binaryPath ?? 'claude',
    args: ['-p', '--output-format', 'json', ...claudeRestrictionArgs(options, extra), ...extra],
  };
}
/** Argv for `codex exec`. `--sandbox read-only` applies unless the owner sets another sandbox. */
export function resolveCodexCliCommand(options: CodexAdapterOptions = {}): ResolvedCliCommand {
  const extra = options.extraArgs ?? [];
  const args = ['exec', '--json', '--skip-git-repo-check'];
  if (!cliFlagPresent(extra, ['--sandbox', '-s']))
    args.push(
      '--sandbox',
      assertOneOf(options.sandbox ?? 'read-only', CODEX_SANDBOX_MODES, 'INVALID_SANDBOX_MODE'),
    );
  args.push(...extra, '-');
  return { command: options.binaryPath ?? 'codex', args };
}
function commandList(resolved: ResolvedCliCommand): string[] {
  return [resolved.command, ...resolved.args];
}
function usage(
  context: AgentTaskContext,
  value: Record<string, unknown>,
  meteredByProxy = false,
) {
  // The proxy already charged this task from the provider response.
  // Stdout repeats those totals and must not be recorded again.
  if (meteredByProxy) return;
  const inputTokens = Number(value.input_tokens ?? value.prompt_tokens ?? 0),
    outputTokens = Number(value.output_tokens ?? value.completion_tokens ?? 0);
  context.reportUsage({
    inputTokens,
    outputTokens,
    totalTokens: Number(value.total_tokens ?? inputTokens + outputTokens),
  });
}
abstract class ProviderCliAdapter extends CommandAgentAdapter {
  protected cliOptions: CliOptions = {};
  /** Set while the task's provider traffic is going through the credential proxy. */
  protected activeProxy?: CredentialProxyHandle;
  protected abstract providerStyle: 'openai' | 'anthropic';
  /** Stdout usage repeats totals the proxy has already recorded. */
  protected proxyAlreadyMetered(): boolean {
    return (this.activeProxy?.responsesMetered ?? 0) > 0;
  }
  protected override encodeInput(context: AgentTaskContext): string {
    return JSON.stringify({
      title: context.manifest.task.title,
      description: context.manifest.task.description,
      input: context.input,
      outputSchema: context.manifest.io.outputSchema,
      instruction: 'Return only a JSON deliverable.',
    });
  }
  override async executeTask(context: AgentTaskContext): Promise<Json> {
    this.activeProxy = undefined;
    const anthropic = this.providerStyle === 'anthropic';
    const key =
      this.cliOptions.apiKey ??
      process.env[
        this.cliOptions.apiKeyEnv ?? (anthropic ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY')
      ];
    if (!key || this.cliOptions.command || anthropic && this.cliOptions.runner)
      return super.executeTask(context);
    const proxy = await startCredentialProxy({
      apiKey: key,
      baseUrl:
        this.cliOptions.baseUrl ??
        (anthropic ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'),
      style: this.providerStyle,
      signal: context.signal,
      fetch: this.cliOptions.fetch,
      budget: context.manifest.budget,
      reportUsage: (metrics) => context.reportUsage(metrics),
      maxRequests: this.cliOptions.maxRequests,
    });
    this.activeProxy = proxy;
    let codex: Awaited<ReturnType<typeof prepareCodexProxy>> | undefined;
    try {
      if (!anthropic) codex = await prepareCodexProxy({
        proxy,
        invocation: this.invocation(),
        extraArgs: this.cliOptions.extraArgs ?? [],
        request: { cwd: context.workspaceDir, signal: context.signal,
          timeoutMs: context.manifest.budget.maxWallClockSeconds * 1000 },
        runner: this.options.runner ?? runCommand,
      });
      return await this.executeCommand(
        context,
        anthropic
          ? {
              ANTHROPIC_BASE_URL: proxy.url,
              ANTHROPIC_API_KEY: proxy.token,
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            }
          : codex!.env,
        codex?.invocation,
      );
    } finally {
      this.activeProxy = undefined;
      try { await codex?.close(); }
      finally { await proxy.close(); }
    }
  }
}
export class ClaudeCodeAdapter extends ProviderCliAdapter {
  protected providerStyle = 'anthropic' as const;
  constructor(options: ClaudeCodeAdapterOptions = {}) {
    // `command` replaces the argv. Otherwise the CLI starts with read-only tool flags.
    super({
      ...options,
      command: options.command ?? commandList(resolveClaudeCodeCliCommand(options)),
      id: 'claude',
      name: 'Claude Code',
    });
    this.cliOptions = options;
  }
  protected override decode(stdout: string, context: AgentTaskContext): Json {
    const value = parseJsonDeliverable(stdout) as Record<string, Json>;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (value.usage && typeof value.usage === 'object')
        usage(context, value.usage as Record<string, unknown>, this.proxyAlreadyMetered());
      if (value.is_error === true) throw new Error('CLAUDE_TASK_FAILED');
      if ('structured_output' in value) return parseJsonDeliverable(value.structured_output);
      if ('result' in value) return parseJsonDeliverable(value.result);
    }
    return value;
  }
}
/** Claude Code CLI adapter. Same class as `ClaudeCodeAdapter`. */
export const ClaudeCodeCliAdapter = ClaudeCodeAdapter;
export type ClaudeCodeCliAdapter = ClaudeCodeAdapter;
export class CodexCliAdapter extends ProviderCliAdapter {
  protected providerStyle = 'openai' as const;
  constructor(options: CodexAdapterOptions = {}) {
    // `command` replaces the argv. Otherwise model shell commands stay in the read-only sandbox.
    super({
      ...options,
      command: options.command ?? commandList(resolveCodexCliCommand(options)),
      id: 'codex',
      name: 'Codex CLI',
    });
    this.cliOptions = options;
  }
  override async executeTask(context: AgentTaskContext): Promise<Json> {
    assertCliAuthentication('codex', this.cliOptions);
    return super.executeTask(context);
  }
  protected override decode(stdout: string, context: AgentTaskContext): Json {
    if (this.activeProxy && this.activeProxy.authenticatedRequests === 0)
      throw new Error('ADAPTER_PROXY_NOT_USED: Codex must use the task proxy before returning a deliverable');
    let direct: Json;
    try {
      direct = JSON.parse(stdout) as Json;
    } catch {
      direct = null;
    }
    if (direct && typeof direct === 'object' && !Array.isArray(direct) && !('type' in direct)) {
      if (direct.usage && typeof direct.usage === 'object')
        usage(context, direct.usage as Record<string, unknown>, this.proxyAlreadyMetered());
      return 'result' in direct ? parseJsonDeliverable(direct.result) : direct;
    }
    let result: Json | undefined;
    for (const line of stdout.trim().split('\n')) {
      const event = JSON.parse(line) as {
        type?: string;
        usage?: Record<string, unknown>;
        item?: { type?: string; text?: string };
        result?: Json;
      };
      if (event.type === 'turn.failed' || event.type === 'error')
        throw new Error('CODEX_TASK_FAILED');
      if (event.usage) usage(context, event.usage, this.proxyAlreadyMetered());
      if (event.item?.type === 'agent_message' && event.item.text)
        result = parseJsonDeliverable(event.item.text);
      if (event.result !== undefined) result = parseJsonDeliverable(event.result);
    }
    if (result === undefined) throw new Error('CODEX_MISSING_RESULT');
    return result;
  }
}
