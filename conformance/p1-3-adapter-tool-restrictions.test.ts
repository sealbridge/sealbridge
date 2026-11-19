// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '../packages/core/src/index.js';
import { buildTaskManifest } from '../packages/runtime/src/index.js';
import {
  ClaudeCodeAdapter,
  ClaudeCodeCliAdapter,
  CodexCliAdapter,
  resolveClaudeCodeCliCommand,
  resolveCodexCliCommand,
  runCommand,
} from '../packages/adapters/src/index.js';
import type { AgentTaskContext } from '../packages/adapters/src/index.js';

const READ_ONLY_TOOLS = 'Read,Glob,Grep';
const DISALLOWED_TOOLS = 'Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch';
const CLAUDE_BASE = ['-p', '--output-format', 'json'] as const;
const CODEX_BASE = ['exec', '--json', '--skip-git-repo-check'] as const;

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function flagMatches(args: readonly string[], names: readonly string[]): string[] {
  return args.filter((arg) => names.some((name) => arg === name || arg.startsWith(name + '=')));
}

const ARGV_SCRIPT =
  'let input="";process.stdin.on("data",b=>input+=b);process.stdin.on("end",()=>{' +
  'process.stdout.write(JSON.stringify({result:JSON.stringify({argv:process.argv.slice(2)}),usage:{input_tokens:1,output_tokens:1}}));' +
  '});\n';

async function taskContext(workspaceDir: string): Promise<AgentTaskContext> {
  const owner = generateKeyPair();
  const worker = generateKeyPair();
  const manifest = buildTaskManifest({
    ownerDid: owner.did,
    workerDid: worker.did,
    title: 'P1-3 tool restrictions',
    description: 'fixture',
  });
  return {
    taskId: manifest.taskId,
    manifest,
    input: { probe: true },
    workspaceDir,
    signal: AbortSignal.timeout(15000),
    callTool: async () => {
      throw new Error('TOOL_DENIED');
    },
    reportUsage: () => {},
    reportIsolation: () => {},
  };
}

describe('P1-3 adapter tool restrictions', () => {
  it('starts Claude Code with read-only tools, a write/shell/web deny list, and dontAsk', () => {
    const resolved = new ClaudeCodeCliAdapter().resolvedInvocation();
    expect(resolved).toEqual(resolveClaudeCodeCliCommand());
    expect(resolved.command).toBe('claude');
    expect(resolved.args).toEqual([
      ...CLAUDE_BASE,
      '--tools',
      READ_ONLY_TOOLS,
      '--disallowedTools',
      DISALLOWED_TOOLS,
      '--permission-mode',
      'dontAsk',
    ]);
    expect(new ClaudeCodeCliAdapter()).toBeInstanceOf(ClaudeCodeAdapter);
  });

  it('starts Codex in the read-only sandbox', () => {
    const resolved = new CodexCliAdapter().resolvedInvocation();
    expect(resolved).toEqual(resolveCodexCliCommand());
    expect(resolved.command).toBe('codex');
    expect(resolved.args).toEqual([...CODEX_BASE, '--sandbox', 'read-only', '-']);
  });

  it('replaces Claude defaults from adapter options without duplicating flags', () => {
    const custom = new ClaudeCodeAdapter({
      tools: ['Read', 'Edit'],
      allowedTools: 'Grep',
      disallowedTools: ['Bash', 'WebFetch', 'WebSearch'],
      permissionMode: 'plan',
    }).resolvedInvocation().args;
    expect(flagValue(custom, '--tools')).toBe('Read,Edit');
    expect(flagValue(custom, '--disallowedTools')).toBe('Bash,WebFetch,WebSearch');
    expect(flagValue(custom, '--permission-mode')).toBe('plan');
    expect(flagMatches(custom, ['--tools'])).toHaveLength(1);
    expect(flagMatches(custom, ['--disallowedTools', '--disallowed-tools'])).toHaveLength(1);
    expect(flagMatches(custom, ['--permission-mode', '--permissionMode'])).toHaveLength(1);

    const allowed = new ClaudeCodeAdapter({ allowedTools: 'Read,Grep' }).resolvedInvocation().args;
    expect(flagValue(allowed, '--tools')).toBe('Read,Grep');
    expect(flagValue(allowed, '--disallowedTools')).toBe(DISALLOWED_TOOLS);
    expect(flagValue(allowed, '--permission-mode')).toBe('dontAsk');
  });

  it('lets extraArgs relax Claude flags without a second copy of the same flag', () => {
    const args = new ClaudeCodeCliAdapter({
      tools: READ_ONLY_TOOLS,
      permissionMode: 'dontAsk',
      extraArgs: [
        '--tools',
        'default',
        '--permission-mode',
        'bypassPermissions',
        '--disallowed-tools',
        'Bash',
      ],
    }).resolvedInvocation().args;
    expect(flagMatches(args, ['--tools'])).toEqual(['--tools']);
    expect(flagValue(args, '--tools')).toBe('default');
    expect(args).not.toContain(READ_ONLY_TOOLS);
    expect(flagMatches(args, ['--permission-mode', '--permissionMode'])).toEqual([
      '--permission-mode',
    ]);
    expect(flagValue(args, '--permission-mode')).toBe('bypassPermissions');
    expect(args).not.toContain('dontAsk');
    expect(flagMatches(args, ['--disallowedTools', '--disallowed-tools'])).toEqual([
      '--disallowed-tools',
    ]);
    expect(flagValue(args, '--disallowed-tools')).toBe('Bash');
    expect(args).not.toContain(DISALLOWED_TOOLS);

    const equalsForm = new ClaudeCodeAdapter({
      extraArgs: ['--tools=default', '--permission-mode=acceptEdits'],
    }).resolvedInvocation().args;
    expect(flagMatches(equalsForm, ['--tools'])).toEqual(['--tools=default']);
    expect(equalsForm).not.toContain(READ_ONLY_TOOLS);
    expect(flagMatches(equalsForm, ['--permission-mode', '--permissionMode'])).toEqual([
      '--permission-mode=acceptEdits',
    ]);
    expect(equalsForm).not.toContain('dontAsk');
    expect(flagValue(equalsForm, '--disallowedTools')).toBe(DISALLOWED_TOOLS);
  });

  it('drops the Claude read-only defaults when allowUnsafeTools is set', () => {
    const unsafe = new ClaudeCodeAdapter({ allowUnsafeTools: true }).resolvedInvocation().args;
    expect(unsafe).toEqual([...CLAUDE_BASE]);
    const kept = new ClaudeCodeAdapter({
      allowUnsafeTools: true,
      tools: 'default',
      permissionMode: 'acceptEdits',
    }).resolvedInvocation().args;
    expect(flagValue(kept, '--tools')).toBe('default');
    expect(flagValue(kept, '--permission-mode')).toBe('acceptEdits');
    expect(kept).not.toContain('--disallowedTools');
    expect(() => new ClaudeCodeAdapter({ permissionMode: 'yolo' as 'plan' })).toThrow(
      'INVALID_PERMISSION_MODE',
    );
  });

  it('replaces the Codex sandbox from options or extraArgs without a duplicate flag', () => {
    expect(
      flagValue(
        new CodexCliAdapter({ sandbox: 'workspace-write' }).resolvedInvocation().args,
        '--sandbox',
      ),
    ).toBe('workspace-write');

    const short = new CodexCliAdapter({
      sandbox: 'read-only',
      extraArgs: ['-s', 'danger-full-access'],
    }).resolvedInvocation().args;
    expect(short).toEqual([...CODEX_BASE, '-s', 'danger-full-access', '-']);
    expect(short).not.toContain('--sandbox');
    expect(short).not.toContain('read-only');

    const long = new CodexCliAdapter({
      extraArgs: ['--sandbox', 'workspace-write', '--color', 'never'],
    }).resolvedInvocation().args;
    expect(flagMatches(long, ['--sandbox', '-s'])).toEqual(['--sandbox']);
    expect(flagValue(long, '--sandbox')).toBe('workspace-write');
    expect(long.at(-1)).toBe('-');

    const equalsForm = new CodexCliAdapter({
      extraArgs: ['--sandbox=danger-full-access'],
    }).resolvedInvocation().args;
    expect(flagMatches(equalsForm, ['--sandbox', '-s'])).toEqual(['--sandbox=danger-full-access']);
    expect(equalsForm).not.toContain('read-only');
    expect(equalsForm.at(-1)).toBe('-');
    expect(() => new CodexCliAdapter({ sandbox: 'off' as 'read-only' })).toThrow(
      'INVALID_SANDBOX_MODE',
    );
  });

  it('keeps an explicit command override free of the default restriction flags', () => {
    expect(new ClaudeCodeAdapter({ command: ['/bin/true'] }).resolvedInvocation()).toEqual({
      command: '/bin/true',
      args: [],
    });
    expect(
      new CodexCliAdapter({ command: ['/bin/true', '--version'] }).resolvedInvocation(),
    ).toEqual({ command: '/bin/true', args: ['--version'] });
  });

  it('spawns mock claude and codex executables with the restricted flags', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-p1-3-'));
    try {
      const script = join(dir, 'mock-cli.cjs');
      await writeFile(script, ARGV_SCRIPT, { mode: 0o700 });
      const context = await taskContext(dir);
      const quiet = { binaryPath: script, apiKeyEnv: 'ACP_P1_3_UNSET_PROVIDER_KEY' } as const;

      const claude = new ClaudeCodeCliAdapter(quiet);
      const claudeOut = (await claude.executeTask(context)) as { argv: string[] };
      expect(claudeOut.argv).toEqual(claude.resolvedInvocation().args);
      expect(claudeOut.argv).toEqual([
        ...CLAUDE_BASE,
        '--tools',
        READ_ONLY_TOOLS,
        '--disallowedTools',
        DISALLOWED_TOOLS,
        '--permission-mode',
        'dontAsk',
      ]);

      const codex = new CodexCliAdapter({ ...quiet, runner: runCommand });
      const codexOut = (await codex.executeTask(context)) as { argv: string[] };
      expect(codexOut.argv).toEqual(codex.resolvedInvocation().args);
      expect(codexOut.argv).toContain('--sandbox');
      expect(codexOut.argv).toContain('read-only');
      expect(codexOut.argv.at(-1)).toBe('-');

      const relaxedClaude = new ClaudeCodeCliAdapter({
        ...quiet,
        extraArgs: ['--tools', 'default', '--permission-mode', 'bypassPermissions'],
      });
      const relaxedClaudeOut = (await relaxedClaude.executeTask(context)) as { argv: string[] };
      expect(relaxedClaudeOut.argv).toEqual(relaxedClaude.resolvedInvocation().args);
      expect(flagValue(relaxedClaudeOut.argv, '--tools')).toBe('default');
      expect(relaxedClaudeOut.argv).not.toContain(READ_ONLY_TOOLS);
      expect(flagMatches(relaxedClaudeOut.argv, ['--tools'])).toHaveLength(1);
      expect(flagValue(relaxedClaudeOut.argv, '--permission-mode')).toBe('bypassPermissions');
      expect(flagMatches(relaxedClaudeOut.argv, ['--permission-mode'])).toHaveLength(1);
      expect(flagValue(relaxedClaudeOut.argv, '--disallowedTools')).toBe(DISALLOWED_TOOLS);

      const relaxedCodex = new CodexCliAdapter({
        ...quiet,
        runner: runCommand,
        extraArgs: ['-s', 'workspace-write'],
      });
      const relaxedCodexOut = (await relaxedCodex.executeTask(context)) as { argv: string[] };
      expect(relaxedCodexOut.argv).toEqual(relaxedCodex.resolvedInvocation().args);
      expect(relaxedCodexOut.argv).toContain('-s');
      expect(relaxedCodexOut.argv).toContain('workspace-write');
      expect(relaxedCodexOut.argv).not.toContain('--sandbox');
      expect(relaxedCodexOut.argv).not.toContain('read-only');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
