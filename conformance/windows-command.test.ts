// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CommandAgentAdapter,
  ClaudeCodeAdapter,
  CodexCliAdapter,
  resolveCommand,
  runCommand,
} from '../packages/adapters/src/command.js';
import {
  quoteWindowsBatchArgument,
  windowsCommandCandidates,
} from '../packages/adapters/src/windows-command.js';
import { sanitizedCommandEnvironment } from '../packages/sandbox/src/command-environment.js';
import { generateKeyPair } from '../packages/core/src/index.js';
import { buildTaskManifest } from '../packages/runtime/src/index.js';
import type { AgentTaskContext } from '../packages/runtime/src/index.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'sealbridge command '));
  directories.push(dir);
  return dir;
}
function context(workspaceDir: string): AgentTaskContext {
  const manifest = buildTaskManifest({
    ownerDid: generateKeyPair().did,
    workerDid: generateKeyPair().did,
    title: 'Command fixture',
    description: 'Print arguments and environment',
  });
  return {
    manifest,
    taskId: manifest.taskId,
    workspaceDir,
    input: {},
    signal: new AbortController().signal,
    reportUsage: () => {},
    callTool: async () => {
      throw new Error('TOOL_DENIED');
    },
  };
}
const inspect = 'console.log(JSON.stringify({argv:process.argv.slice(2),env:process.env}));';
function assertWindowsEnvironment(env: NodeJS.ProcessEnv, home: string, commandDir: string) {
  expect(env.SystemRoot).toBeTruthy();
  expect(env.PATH!.toLowerCase()).toContain(join(env.SystemRoot!, 'System32').toLowerCase());
  expect(env.PATH!.split(';')).toContain(commandDir);
  expect(env.PATH!.split(';')).toContain(dirname(process.execPath));
  expect(env).toMatchObject({
    USERPROFILE: home,
    TEMP: home,
    TMP: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
  });
  expect(env.ComSpec!.toLowerCase()).toContain('system32\\cmd.exe');
}

describe('Windows command candidates and batch arguments', () => {
  it('uses PATHEXT and prefers executables to scripts', () => {
    expect(windowsCommandCandidates('codex', '.CMD;.EXE;.BAT;.COM')).toEqual([
      'codex.exe',
      'codex.com',
      'codex.cmd',
      'codex.bat',
    ]);
    expect(windowsCommandCandidates('codex')).toEqual([
      'codex.com',
      'codex.exe',
      'codex.bat',
      'codex.cmd',
    ]);
    expect(windowsCommandCandidates('codex.exe')).toEqual(['codex.exe']);
    expect(windowsCommandCandidates('codex', '.EXE;.EXE;invalid')).toEqual(['codex.exe']);
  });
  it('quotes spaces and command punctuation', () => {
    expect(quoteWindowsBatchArgument('a b & c | (d) <e>')).toBe('"a b & c | (d) <e>"');
    expect(quoteWindowsBatchArgument('')).toBe('""');
  });
  it.each(['a"b', '%PATH%', 'a\nb', 'a\rb', 'a\0b', '!PATH!', 'a^b'])(
    'rejects unsupported batch characters: %j',
    (value) => {
      expect(() => quoteWindowsBatchArgument(value)).toThrow('COMMAND_UNSUPPORTED_BATCH_ARGUMENT');
    },
  );
});

describe.skipIf(process.platform !== 'win32')('Windows command spawning', () => {
  it.each(['\\', '/'])('resolves absolute commands using %s separators', async (separator) => {
    const dir = join(await workspace(), 'tools.dir');
    await mkdir(dir);
    await writeFile(join(dir, 'tool.exe'), '');
    vi.stubEnv('PATHEXT', '.EXE');
    const command = join(dir, 'tool').replaceAll('\\', separator);
    expect(await resolveCommand(command + '.exe')).toBe(command + '.exe');
    expect(await resolveCommand(command)).toBe(command + '.exe');
    await expect(resolveCommand(command + '.')).rejects.toThrow('COMMAND_NOT_FOUND');
  });

  it('resolves an absolute command with a long basename promptly', async () => {
    const command = join(await workspace(), '.'.repeat(50000));
    const started = performance.now();
    expect(await resolveCommand(command)).toBe(command);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('selects and spawns a real .exe before a .cmd or extensionless shim', async () => {
    const dir = await workspace();
    const script = join(dir, 'inspect.cjs');
    const executable = join(dir, 'codex.exe');
    await copyFile(process.execPath, executable);
    await writeFile(script, inspect);
    await writeFile(join(dir, 'codex'), '#!/bin/sh\nexit 1\n');
    await writeFile(join(dir, 'codex.cmd'), '@exit /b 1\r\n');
    vi.stubEnv('PATH', dir);
    vi.stubEnv('PATHEXT', '.CMD;.EXE;.BAT;.COM');
    expect(await resolveCommand('codex')).toBe(executable);
    const args = ['value with spaces', 'value "with quotes"', 'trailing\\'];
    const output = await runCommand({
      command: 'codex',
      args: [script, ...args],
      cwd: dir,
      env: sanitizedCommandEnvironment(dir),
      input: '',
      signal: new AbortController().signal,
      timeoutMs: 10000,
    });
    const seen = JSON.parse(output.stdout);
    expect(seen.argv).toEqual(args);
    assertWindowsEnvironment(seen.env, dir, dir);
  });

  it('spawns a batch file through cmd.exe with spaces and quoted punctuation', async () => {
    const dir = await workspace();
    const script = join(dir, 'inspect.cjs');
    await writeFile(script, inspect);
    const shim = join(dir, 'claude.cmd');
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    await writeFile(join(dir, 'claude'), '#!/bin/sh\nexit 1\n');
    vi.stubEnv('PATH', dir);
    vi.stubEnv('PATHEXT', '.COM;.EXE;.BAT;.CMD');
    expect(await resolveCommand('claude')).toBe(shim);
    const args = ['value with spaces', 'a & b | (c) <d>', ''];
    const request = {
      command: 'claude',
      args,
      cwd: dir,
      env: sanitizedCommandEnvironment(dir),
      input: '',
      signal: new AbortController().signal,
      timeoutMs: 10000,
    };
    const seen = JSON.parse((await runCommand(request)).stdout);
    expect(seen.argv).toEqual(args);
    assertWindowsEnvironment(seen.env, dir, dir);
    await expect(runCommand({ ...request, args: ['a"b'] })).rejects.toThrow(
      'COMMAND_UNSUPPORTED_BATCH_ARGUMENT',
    );
  });

  it.each(['claude', 'codex'] as const)(
    'runs the %s npm shim entry with spaces and quotes',
    async (name) => {
      const dir = await workspace();
      const entry = join(dir, 'node_modules', 'fixture', 'cli.cjs');
      await mkdir(dirname(entry), { recursive: true });
      await writeFile(entry, inspect);
      await writeFile(
        join(dir, name + '.cmd'),
        '@ECHO off\r\nSET "dp0=%~dp0"\r\n"node" "%dp0%\\node_modules\\fixture\\cli.cjs" %*\r\n',
      );
      await writeFile(join(dir, name), '#!/bin/sh\nexit 1\n');
      vi.stubEnv('PATH', dir);
      vi.stubEnv('PATHEXT', '.COM;.EXE;.BAT;.CMD');
      const extraArgs = ['--model', 'value with "quotes" and spaces'];
      const options = {
        binaryPath: name,
        extraArgs,
        apiKeyEnv: 'SEALBRIDGE_TEST_UNSET_KEY',
        runner: runCommand,
      };
      const adapter =
        name === 'claude' ? new ClaudeCodeAdapter(options) : new CodexCliAdapter(options);
      const seen = (await adapter.executeTask(context(dir))) as {
        argv: string[];
        env: NodeJS.ProcessEnv;
      };
      expect(seen.argv).toEqual(adapter.resolvedInvocation().args);
      expect(seen.argv).toEqual(expect.arrayContaining(extraArgs));
      assertWindowsEnvironment(seen.env, dir, dir);
    },
  );

  it('runs owner-configured string commands with cmd.exe', async () => {
    const dir = await workspace();
    const script = join(dir, 'inspect.cjs');
    await writeFile(script, inspect);
    const adapter = new CommandAgentAdapter({
      command: `"${process.execPath}" "${script}"`,
      args: ['value with spaces'],
    });
    const seen = (await adapter.executeTask(context(dir))) as {
      argv: string[];
      env: NodeJS.ProcessEnv;
    };
    expect(seen.argv).toEqual(['value with spaces']);
    assertWindowsEnvironment(seen.env, dir, join(process.env.SystemRoot!, 'System32'));
  });
});
