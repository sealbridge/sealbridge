import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { windowsTestShell } from './windows-test-shell.js';

const windows = process.platform === 'win32';
const sh = readFileSync('sites/install.sh', 'utf8');
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const psQuote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const markerName = 'accepted.json';
// A malicious/failing CLI can echo the secret: the installer must suppress it.
const fakeCli = `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const fs = require('node:fs');
  const ok = ['synthetic-private-invite-249\\n', 'https://sealbridge.app/j#synthetic-private-invite-249\\n', 'sealbridge://join#synthetic-private-invite-249\\n'].includes(input);
  fs.writeFileSync(${JSON.stringify(markerName)}, JSON.stringify({ok, args: process.argv.slice(2)}));
  process.stdout.write(input); process.stderr.write(input);
  process.exit(process.env.SEALBRIDGE_TEST_ACCEPT_FAIL ? 17 : ok ? 0 : 18);
});
`;

describe.skipIf(windows)('Unix optional invitation with a real controlling terminal', () => {
  for (const mode of [
    'success',
    'failure',
    'empty',
    'eof',
    'interrupt',
    'decline',
    'default',
    'confirm-eof',
    'other',
    'skip',
    'ci',
    'stdin',
    'stdout',
    'stderr',
    'no-tty',
    'trace',
    'verbose',
    'export',
  ]) {
    it(mode, () => {
      const dir = mkdtempSync(join(tmpdir(), 'installer-invite-'));
      try {
        const cli = join(dir, 'fake-cli');
        writeFileSync(join(dir, 'fake.cjs'), fakeCli);
        writeFileSync(
          cli,
          `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(dir, 'fake.cjs'))} "$@"\n`,
          { mode: 0o700 },
        );
        const script = join(dir, 'prompt.sh');
        writeFileSync(
          script,
          `#!/bin/sh\nset -eu\nCLI=${quote(cli)}\nNO_ACCEPT=${mode === 'skip'}\n${sh.slice(sh.indexOf('accept_invite() ('))}\n`,
        );
        const result = spawnSync(
          'python3',
          [resolve('conformance/fixtures/installer-invite-pty.py'), script, mode],
          {
            cwd: dir,
            encoding: 'utf8',
            timeout: 15000,
            env: {
              ...process.env,
              ...(mode === 'failure' ? { SEALBRIDGE_TEST_ACCEPT_FAIL: '1' } : {}),
            },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        const data = JSON.parse(result.stdout);
        expect(data.restored).toBe(true);
        const interactive = [
          'success',
          'failure',
          'empty',
          'eof',
          'interrupt',
          'decline',
          'default',
          'confirm-eof',
          'other',
        ].includes(mode);
        expect(data.prompted).toBe(interactive);
        if (mode !== 'interrupt') expect(data.status).toBe(0);
        const imported = ['success', 'failure'].includes(mode);
        expect(existsSync(join(dir, markerName))).toBe(imported);
        if (imported) {
          expect(JSON.parse(readFileSync(join(dir, markerName), 'utf8'))).toEqual({
            ok: true,
            args: ['accept', '--stdin'],
          });
          expect(data.output).toContain('A short link contacts the relay');
          expect(data.output).toContain('sends a connection request');
        }
        if (mode === 'failure' || mode === 'eof') expect(data.output).toContain('accept --paste');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe.skipIf(!windows)('Windows optional invitation secure pipe', () => {
  for (const shell of ['powershell.exe', 'pwsh']) {
    for (const rawMode of [
      'success',
      'failure',
      'empty',
      'read-error',
      'decline',
      'default',
      'other',
      'confirm-error',
      'redirected',
      'skip',
      'ci',
      'pipeline',
      'console-success',
      'console-failure',
      'console-empty',
      'console-decline',
      'console-skip',
      'console-ci',
      'console-trace',
    ]) {
      const nativeConsole = rawMode.startsWith('console-');
      const mode = rawMode === 'console-trace' ? 'success' : rawMode.replace(/^console-/, '');
      it(`${shell}: ${rawMode}`, () => {
        const dir = mkdtempSync(join(tmpdir(), 'installer-invite-'));
        try {
          // The real terminal gate is exercised for skip cases. For input cases,
          // emulate only the terminal/read-host boundary, keeping SecureString,
          // the actual .NET pipe, and a real Node subprocess. Console cases use
          // real Read-Host via ConPTY and do not replace the terminal gate.
          const entryDir = join(dir, 'node_modules/sealbridge/dist/cli/dist');
          const setup = spawnSync(process.execPath, [
            '-e',
            'require("fs").mkdirSync(process.argv[1],{recursive:true})',
            entryDir,
          ]);
          expect(setup.status).toBe(0);
          writeFileSync(join(entryDir, 'index.js'), fakeCli);
          const driver = join(dir, 'test.ps1');
          const interactive = [
            'success',
            'failure',
            'empty',
            'read-error',
            'decline',
            'default',
            'other',
            'confirm-error',
          ].includes(mode);
          writeFileSync(
            driver,
            `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${psQuote(resolve('sites/install.ps1'))}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Parse failure' }
foreach ($name in @('Test-SealbridgeAcceptTerminal', 'Invoke-SealbridgeOptionalAccept')) {
  $definition = $ast.Find({param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq $name}, $true)
  Invoke-Expression $definition.Extent.Text
}
$NoAccept = $${mode === 'skip'}
$acceptFromFile = $${mode !== 'pipeline'}
$PackageName = 'sealbridge'
$npmDir = ${psQuote(dir)}
$runtime = @{Path = ${psQuote(process.execPath)}}
${
  interactive && !nativeConsole
    ? `function Test-SealbridgeAcceptTerminal { return $true }
function Read-Host {
  param($Prompt, [switch]$AsSecureString)
  if (!$AsSecureString) { throw 'Secret read must be secure' }
  ${
    mode === 'read-error'
      ? "throw 'synthetic-private-invite-249'"
      : `$value = New-Object Security.SecureString
  if ($Prompt -like 'Continue?*') {
    ${mode === 'confirm-error' ? "throw 'synthetic-private-invite-249'" : `foreach ($c in '${mode === 'decline' ? 'n' : mode === 'default' ? '' : mode === 'other' ? 'yes' : 'y'}'.ToCharArray()) { $value.AppendChar($c) }`}
  } else {
    ${mode === 'empty' ? '' : "foreach ($c in 'synthetic-private-invite-249'.ToCharArray()) { $value.AppendChar($c) }"}
  }
  return $value`
  }
}`
    : nativeConsole
      ? ''
      : 'function Read-Host { throw "Prompt must be skipped" }'
}
$global:LASTEXITCODE = 37
${rawMode === 'console-trace' ? "Start-Transcript -Path './transcript.txt' | Out-Null\nSet-PSDebug -Trace 2" : ''}
Invoke-SealbridgeOptionalAccept
${rawMode === 'console-trace' ? 'Set-PSDebug -Off\nStop-Transcript | Out-Null' : ''}
if ($global:LASTEXITCODE -ne 37) { throw 'Exit status changed' }
Write-Host 'preserved-status'
`,
          );
          const env = { ...process.env };
          for (const key of [
            'CI',
            'CONTINUOUS_INTEGRATION',
            'GITHUB_ACTIONS',
            'TF_BUILD',
            'BUILD_ID',
            'JENKINS_URL',
          ])
            delete env[key];
          for (const key of Object.keys(env))
            if (key.toLowerCase() === 'psmodulepath') delete env[key];
          if (mode === 'ci') env.CI = 'true';
          if (mode === 'failure') env.SEALBRIDGE_TEST_ACCEPT_FAIL = '1';
          const result = spawnSync(
            nativeConsole ? 'python' : windowsTestShell(shell),
            nativeConsole
              ? [
                  resolve('conformance/fixtures/installer-invite-conpty.py'),
                  windowsTestShell(shell),
                  driver,
                  mode,
                ]
              : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver],
            { cwd: dir, env, encoding: 'utf8', timeout: 30000 },
          );
          expect(result.status, result.stdout + result.stderr).toBe(0);
          const data = nativeConsole ? JSON.parse(result.stdout) : undefined;
          if (data) {
            expect(data.status).toBe(0);
            expect(data.prompted).toBe(!['skip', 'ci'].includes(mode));
          }
          const output = data ? data.output : result.stdout + result.stderr;
          expect(output).not.toContain('synthetic-private-invite-249');
          if (rawMode === 'console-trace')
            expect(readFileSync(join(dir, 'transcript.txt'), 'utf8')).not.toContain(
              'synthetic-private-invite-249',
            );
          expect(output).toContain('preserved-status');
          const imported = ['success', 'failure'].includes(mode);
          expect(existsSync(join(dir, markerName)), output).toBe(imported);
          if (imported)
            expect(JSON.parse(readFileSync(join(dir, markerName), 'utf8'))).toEqual({
              ok: true,
              args: ['accept', '--stdin'],
            });
          if (mode === 'failure' || mode === 'read-error' || mode === 'confirm-error')
            expect(output).toContain('accept --paste');
        } finally {
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
      }, 35000);
    }
  }
});
