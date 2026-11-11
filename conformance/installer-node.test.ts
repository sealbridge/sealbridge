import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, symlinkSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { copyFile, link, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const windows = process.platform === 'win32';
const installerPs = resolve('sites/install.ps1');
const installerSh = resolve('sites/install.sh');
const quoteSh = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

let stagedDir: string;
let stagedNode: string;
beforeAll(async () => {
  stagedDir = await realpath(await mkdtemp(join(tmpdir(), 'sealbridge-executable-')));
  stagedNode = join(stagedDir, windows ? 'node.exe' : 'node');
  // Cross-volume source paths need at most one copy. All fixture links below
  // are on this temporary volume; only the executable bytes are shared.
  try { await link(process.execPath, stagedNode); }
  catch { await copyFile(process.execPath, stagedNode); }
});
afterAll(async () => {
  await Promise.all(runningProcesses);
  if (stagedDir) await rm(stagedDir, { recursive: true, force: true });
});

async function linkNode(destination: string) {
  // Unlike symlinks, hard links preserve each fixture's process.execPath and
  // adjacent version/npm lookup. They need no Windows symlink privilege.
  await link(stagedNode, destination);
}

const runningProcesses = new Set<Promise<ProcessResult>>();
function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal) {
  const done = new Promise<ProcessResult>(resolve => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: !windows });
    let stdout = '';
    let stderr = '';
    let error: Error | undefined;
    let timedOut = false;
    let stopping = false;
    let termination = Promise.resolve();
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (windows && child.pid) {
        // Terminate Node queries as well as their PowerShell parent so their
        // inherited pipes close before fixtures are removed.
        termination = new Promise<void>(finish => {
          const killer = spawn(join(process.env.SystemRoot!, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore', timeout: 1000, killSignal: 'SIGKILL',
          });
          killer.on('error', () => child.kill('SIGKILL'));
          killer.on('close', () => { child.kill('SIGKILL'); finish(); });
        });
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', cause => { error = cause; });
    child.on('close', async (status, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      await termination;
      resolve({ status, signal: exitSignal, stdout, stderr, error, timedOut });
    });
  });
  runningProcesses.add(done);
  const forget = () => { runningProcesses.delete(done); };
  void done.then(forget, forget);
  return done;
}

type ProcessResult = { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: Error; timedOut: boolean };
function processDetails(result: ProcessResult) {
  const phases = [...result.stderr.matchAll(/^\[installer phase\] (.*)$/gm)];
  return `Last phase: ${phases.at(-1)?.[1].trim() ?? 'process launch (no shell marker)'}\n` +
    `timedOut=${result.timedOut}; exit=${result.status}; signal=${result.signal}; error=${result.error?.message ?? 'none'}\n` +
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

function expectSuccess(result: ProcessResult) {
  const details = processDetails(result);
  expect(result.timedOut, details).toBe(false);
  expect(result.error, details).toBeUndefined();
  expect(result.status, details).toBe(0);
}

function environmentForShell(shell: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  if (shell === 'powershell.exe') {
    // Let Windows PowerShell rebuild its own module paths instead of inheriting
    // PowerShell 7's paths through the Node process running these tests.
    for (const key of Object.keys(childEnv)) if (key.toLowerCase() === 'psmodulepath') delete childEnv[key];
  }
  return childEnv;
}

describe.skipIf(!windows)('Windows installer Node check', () => {
  let dir: string;
  let caseDir: string;
  let prefix: string;
  let first: string;
  let second: string;
  let driver: string;
  let preload: string;
  const shells = new Map<string, string>();

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'sealbridge-node-')));
    for (const shell of ['powershell.exe', 'pwsh']) {
      const found = await runProcess('where.exe', [shell], process.env, 5000);
      expectSuccess(found);
      shells.set(shell, found.stdout.trim().split(/\r?\n/)[0]);
    }
    preload = join(dir, 'version.cjs');
    await writeFile(preload, `
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(path.dirname(process.execPath), 'version.txt');
if (fs.existsSync(file)) {
  const version = fs.readFileSync(file, 'utf8');
  if (version === 'nonzero') process.exit(7);
  Object.defineProperty(process.versions, 'node', { value: version });
}
`);
    driver = join(dir, 'check.ps1');
    // Load the installer's function statements, inserting only stderr markers
    // around AST-selected assignments. No installation or download runs here.
    await writeFile(driver, `
[Console]::Error.WriteLine('[installer phase] shell started')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:SEALBRIDGE_TEST_INSTALLER, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$definition = $ast.Find({ param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq 'Get-SealbridgeNode' }, $true)
if (!$definition) { throw 'Installer Node check function is missing.' }
# Require exactly one assignment for each probe so installer edits cannot
# silently remove diagnostics. Insert from the end to retain AST offsets.
$probes = @(
    @{ Variable = 'command'; Pattern = '^Get-Command node[.]exe'; Phase = 'PATH lookup' },
    @{ Variable = 'version'; Pattern = '^& \\$node -p process[.]versions[.]node$'; Phase = 'Node version query' },
    @{ Variable = 'resolvedPath'; Pattern = '^& \\$node -p process[.]execPath$'; Phase = 'Node executable query' }
)
$insertions = @()
foreach ($probe in $probes) {
    $assignments = @($definition.FindAll({ param($item)
        $item -is [System.Management.Automation.Language.AssignmentStatementAst] -and
        $item.Left.Extent.Text -eq ('$' + $probe.Variable) -and $item.Right.Extent.Text -match $probe.Pattern
    }, $true))
    if ($assignments.Count -ne 1) { throw "Expected one assignment for phase: $($probe.Phase)" }
    $statement = $assignments[0]
    $insertions += @{ Offset = $statement.Extent.StartOffset; Text = "[Console]::Error.WriteLine('[installer phase] $($probe.Phase) started'); " }
    $insertions += @{ Offset = $statement.Extent.EndOffset; Text = "; [Console]::Error.WriteLine('[installer phase] $($probe.Phase) completed')" }
}
$functionText = $definition.Extent.Text
foreach ($insertion in ($insertions | Sort-Object { $_.Offset } -Descending)) {
    $functionText = $functionText.Insert($insertion.Offset - $definition.Extent.StartOffset, $insertion.Text)
}
Invoke-Expression $functionText
[Console]::Error.WriteLine('[installer phase] function loaded')
[Console]::Error.WriteLine('[installer phase] runtime check started')
$runtime = Get-SealbridgeNode -Prefix $env:SEALBRIDGE_TEST_PREFIX
[Console]::Error.WriteLine('[installer phase] runtime check completed')
@{ ShellMajor = $PSVersionTable.PSVersion.Major; Runtime = $runtime } | ConvertTo-Json -Compress
`);
  });
  beforeEach(async () => {
    caseDir = await mkdtemp(join(dir, 'case-'));
    prefix = join(caseDir, 'npm prefix');
    first = join(caseDir, 'first Node');
    second = join(caseDir, 'second Node');
    for (const folder of [prefix, first, second]) {
      await mkdir(folder);
      await linkNode(join(folder, 'node.exe'));
    }
  });
  afterEach(async () => {
    await Promise.all(runningProcesses);
    if (caseDir) await rm(caseDir, { recursive: true, force: true });
  });
  afterAll(async () => {
    await Promise.all(runningProcesses);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function check(shell: string, paths: string[], signal: AbortSignal, useFakeVersion = true, usePrefix = false) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
    // Exclude any other Node installations while retaining Windows utilities.
    env.Path = [...paths, join(process.env.SystemRoot!, 'System32'), process.env.SystemRoot!].join(';');
    env.SEALBRIDGE_TEST_INSTALLER = installerPs;
    env.SEALBRIDGE_TEST_PREFIX = usePrefix ? prefix : join(caseDir, 'empty prefix');
    delete env.NODE_OPTIONS;
    if (useFakeVersion) env.NODE_OPTIONS = `--require "${preload.replaceAll('\\', '/')}"`;
    const result = await runProcess(shells.get(shell)!, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver],
      environmentForShell(shell, env), 15000, signal);
    expectSuccess(result);
    expect(() => JSON.parse(result.stdout.trim()), processDetails(result)).not.toThrow();
    const output = JSON.parse(result.stdout.trim());
    expect(output.ShellMajor, processDetails(result)).toBe(shell === 'powershell.exe' ? 5 : 7);
    return output.Runtime as { Path: string; Version: string; Supported: boolean } | null;
  }

  describe.each(['powershell.exe', 'pwsh'])('%s', shell => {
    it('checks a real Node on PATH and reports its resolved executable and version', async ({ signal }) => {
      expect(await check(shell, [dirname(process.execPath)], signal, false)).toEqual({
        Path: process.execPath, Version: process.versions.node, Supported: true,
      });
    });

    it.for([
      ['20.0.0', false], ['21.7.3', false], ['22.0.0', true], ['22.22.0', true], ['24.21.0', true],
    ] as const)('parses %s without nested JavaScript quotes (supported: %s)', async ([version, supported], { signal }) => {
      writeFileSync(join(first, 'version.txt'), version);
      expect(await check(shell, [first], signal)).toEqual({ Path: join(first, 'node.exe'), Version: version, Supported: supported });
    });

    it.for(['invalid', 'nonzero'])('rejects an unusable Node (%s)', async (version, { signal }) => {
      writeFileSync(join(first, 'version.txt'), version);
      expect(await check(shell, [first], signal)).toBeNull();
    });

    it('reports no runtime when Node is absent', async ({ signal }) => {
      expect(await check(shell, [], signal)).toBeNull();
    });

    it('follows PATH order when the prefix has no Node', async ({ signal }) => {
      writeFileSync(join(first, 'version.txt'), '24.21.0');
      writeFileSync(join(second, 'version.txt'), '22.22.0');
      expect(await check(shell, [second, first], signal)).toEqual({ Path: join(second, 'node.exe'), Version: '22.22.0', Supported: true });
    });

    it.for([['22.22.0', true], ['20.0.0', false]] as const)('prefers prefix-local Node %s over PATH', async ([version, supported], { signal }) => {
      writeFileSync(join(first, 'version.txt'), '24.21.0');
      writeFileSync(join(prefix, 'version.txt'), version);
      expect(await check(shell, [first], signal, true, true)).toEqual({ Path: join(prefix, 'node.exe'), Version: version, Supported: supported });
    });
  });
});

describe.skipIf(windows)('POSIX installer Node check', () => {
  let dir: string;
  let bin: string;
  let checkNode: string;
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'sealbridge-node-')));
    bin = join(dir, 'Node bin');
    mkdirSync(bin);
    const source = readFileSync(installerSh, 'utf8');
    checkNode = source.match(/^check_node\(\) \{\n[\s\S]*?^\}/m)?.[0] ?? '';
    expect(checkNode).not.toBe('');
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  function fakeNode(version: string) {
    writeFileSync(join(bin, 'node'), `#!/bin/sh
case "$1:$2" in
  -p:process.versions.node) printf '%s\\n' ${quoteSh(version)};;
  -p:process.execPath) printf '%s\\n' ${quoteSh(join(bin, 'node'))};;
  *) exit 9;;
esac
`, { mode: 0o755 });
  }

  it.each([['20.0.0', 1], ['22.22.0', 0], ['24.21.0', 0], ['invalid', 1]])('checks %s using stdout and shell parsing', (version, status) => {
    fakeNode(version);
    const result = spawnSync('sh', ['-c', `${checkNode}\ncheck_node`], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(status);
    expect(result.stderr).toBe('');
  });

  it('reports the resolved executable and version of a real Node on PATH', () => {
    const result = spawnSync('sh', ['-c', `${checkNode}\ncheck_node || exit 1\nprintf '%s\\n%s\\n' "$NODE_EXECUTABLE" "$NODE_ACTUAL_VERSION"`], {
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` }, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([process.execPath, process.versions.node]);
  });

});

// Exercise the complete installer with local replacements for downloads. Windows
// extracts a real ZIP; POSIX uses a local extraction stub. Node itself is real,
// while the package and archive payloads are fixtures. No test opens a connection.
describe('installer runtime selection', () => {
  let dir: string;
  let fixture: string;
  let fixtureArchive: string;
  let fixtureHash: string;
  let preload: string;
  const shells = windows ? ['powershell.exe', 'pwsh'] : ['/bin/sh'];
  const shellPaths = new Map<string, string>();
  const npmFixture = `
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] === '--version') {
  const mode = process.env.SEALBRIDGE_TEST_FAILURE === 'installed-npm' ? 'garbage' : fs.readFileSync(path.join(__dirname, 'mode.txt'), 'utf8');
  if (mode === 'nonzero') process.exit(7);
  console.log(mode === 'garbage' ? 'not npm' : '10.9.4');
} else {
  const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
  const entry = path.join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', 'sealbridge/dist/cli/dist/index.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '#!/usr/bin/env node\\nrequire("node:fs").writeSync(1, "CLI Node: " + process.execPath + " (" + process.versions.node + ")");\\n');
  fs.writeFileSync(path.join(prefix, 'npm-selection.json'), JSON.stringify({ node: process.execPath, npm: process.argv[1], args: process.argv.slice(2) }));
  if (process.platform !== 'win32') {
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    fs.chmodSync(entry, 0o755);
    try { fs.unlinkSync(path.join(prefix, 'bin/sealbridge')); } catch {}
    fs.symlinkSync(entry, path.join(prefix, 'bin/sealbridge'));
  }
}
`;

  async function stageRuntime(folder: string, version: string, npmMode?: string) {
    const bin = windows ? folder : join(folder, 'bin');
    await mkdir(bin, { recursive: true });
    await linkNode(join(bin, windows ? 'node.exe' : 'node'));
    writeFileSync(join(bin, 'version.txt'), version);
    if (npmMode) {
      const cli = join(folder, windows ? 'node_modules' : 'lib/node_modules', 'npm/bin/npm-cli.js');
      mkdirSync(dirname(cli), { recursive: true });
      writeFileSync(cli, npmFixture);
      writeFileSync(join(dirname(cli), 'mode.txt'), npmMode);
      if (windows) writeFileSync(join(bin, 'npm.cmd'), '@echo off\r\nexit /b 91\r\n');
      else symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', join(bin, 'npm'));
    }
    return bin;
  }

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'sealbridge-runtime-')));
    const arch = process.env.PROCESSOR_ARCHITECTURE === 'ARM64' ? 'arm64' : 'x64';
    fixture = join(dir, windows ? `node-v22.22.0-win-${arch}` : 'archive fixture');
    await stageRuntime(fixture, '22.22.0', 'valid');
    preload = join(dir, 'version.cjs');
    await writeFile(preload, `
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(path.dirname(process.execPath), 'version.txt');
if (fs.existsSync(file)) Object.defineProperty(process.versions, 'node', { value: fs.readFileSync(file, 'utf8') });
`);
    for (const shell of shells) {
      const found = windows ? await runProcess('where.exe', [shell], process.env, 5000) : null;
      if (found) expectSuccess(found);
      shellPaths.set(shell, found ? found.stdout.trim().split(/\r?\n/)[0] : shell);
    }
    if (windows) {
      fixtureArchive = join(dir, 'node fixture.zip');
      const result = await runProcess(shellPaths.get('pwsh')!, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
[void][Reflection.Assembly]::Load('System.IO.Compression.FileSystem')
[IO.Compression.ZipFile]::CreateFromDirectory($env:SEALBRIDGE_TEST_FIXTURE, $env:SEALBRIDGE_TEST_ARCHIVE, [IO.Compression.CompressionLevel]::Fastest, $true)
`], { ...process.env, SEALBRIDGE_TEST_FIXTURE: fixture, SEALBRIDGE_TEST_ARCHIVE: fixtureArchive }, 30000);
      expectSuccess(result);
      // Node's lowercase digest also exercises comparison with the uppercase .NET digest.
      fixtureHash = createHash('sha256').update(readFileSync(fixtureArchive)).digest('hex');
    }
  }, 40000);
  afterEach(async () => { await Promise.all(runningProcesses); });
  afterAll(async () => {
    await Promise.all(runningProcesses);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function install(shell: string, scenario: string, npmMode?: string, failure?: string) {
    const home = await mkdtemp(join(dir, 'user with spaces-'));
    const initial = join(home, 'original runtime');
    const first = await stageRuntime(initial, scenario === 'old' ? '20.19.0' : '24.21.0', npmMode);
    const tools = join(home, 'tools');
    mkdirSync(tools);
    // An unrelated npm on PATH must not make an npm-less Node usable.
    if (scenario === 'mismatched') await stageRuntime(join(home, 'other runtime'), '22.22.0', 'valid');
    const root = windows ? join(home, 'Sealbridge') : join(home, '.local/share/sealbridge');
    const node = windows ? join(root, 'node/node.exe') : join(root, 'node/bin/node');
    const prefix = join(root, 'npm');
    if (scenario === 'prefix-old') {
      await stageRuntime(prefix, '20.19.0');
      writeFileSync(join(root, '.installer-owned'), 'Sealbridge installer');
    }
    if (scenario === 'broken PATH npm') {
      writeFileSync(join(tools, windows ? 'npm.cmd' : 'npm'), windows ? '@echo off\r\nexit /b 7\r\n' : '#!/bin/sh\nexit 7\n', { mode: 0o755 });
    }
    const tarball = join(home, 'local package.tgz');
    writeFileSync(tarball, 'local package fixture');
    const env = { ...process.env, NODE_OPTIONS: `--require "${preload.replaceAll('\\', '/')}"`,
      SEALBRIDGE_INSTALL_TARBALL: tarball, SEALBRIDGE_TEST_FIXTURE: fixture,
      SEALBRIDGE_TEST_FAILURE: failure ?? '', HOME: home, LOCALAPPDATA: home };
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key as keyof typeof env];
    const otherBin = windows ? join(home, 'other runtime') : join(home, 'other runtime/bin');
    if (failure === 'architecture') Object.assign(env, { PROCESSOR_ARCHITECTURE: 'unsupported' });
    if (!windows && failure === 'architecture') {
      writeFileSync(join(tools, 'uname'), '#!/bin/sh\ncase "$1" in -s) printf Linux;; *) printf unsupported;; esac\n', { mode: 0o755 });
    }
    const driver = join(home, windows ? 'driver.ps1' : 'driver.sh');
    if (windows) {
      Object.assign(env, { Path: [first, tools, otherBin, join(process.env.SystemRoot!, 'System32'), process.env.SystemRoot!].join(';') });
      writeFileSync(driver, `
$ErrorActionPreference = 'Stop'
function Invoke-WebRequest {
    param($Uri, $OutFile, [switch]$UseBasicParsing)
    if ($env:SEALBRIDGE_TEST_FAILURE -eq 'download') { throw 'fixture download failed' }
    if ($OutFile) { Copy-Item -LiteralPath '${fixtureArchive.replaceAll("'", "''")}' -Destination $OutFile; return }
    $hash = '${fixtureHash}'
    if ($env:SEALBRIDGE_TEST_FAILURE -eq 'checksum') { $hash = '0' * 64 }
    return @{ Content = "$hash  ${basename(fixture)}.zip" }
}
& '${installerPs.replaceAll("'", "''")}' -NoProfile
& '${prefix.replaceAll("'", "''")}/sealbridge.ps1' --version
if ($LASTEXITCODE -ne 0) { throw 'PowerShell shim failed' }
`);
    } else {
      Object.assign(env, { PATH: `${first}:${tools}:${otherBin}:/usr/bin:/bin:/usr/sbin:/sbin` });
      writeFileSync(join(tools, 'curl'), `#!/bin/sh
[ "$SEALBRIDGE_TEST_FAILURE" != download ] || exit 90
case "$2" in
  */SHASUMS256.txt)
    archive=$(find ${quoteSh(root)} -name '*.tar.gz')
    if command -v sha256sum >/dev/null; then sum=$(sha256sum "$archive"); else sum=$(shasum -a 256 "$archive"); fi
    sum=\${sum%% *}
    [ "$SEALBRIDGE_TEST_FAILURE" != checksum ] || sum=$(printf '%064d' 0)
    printf '%s  %s\\n' "$sum" "\${archive##*/}" > "$4";;
  *) printf 'archive fixture' > "$4";;
esac
`, { mode: 0o755 });
      writeFileSync(join(tools, 'tar'), `#!/bin/sh
cp -R "$SEALBRIDGE_TEST_FIXTURE/." "$4/"
if [ "$SEALBRIDGE_TEST_FAILURE" = installed-npm ]; then printf garbage > "$4/lib/node_modules/npm/bin/mode.txt"; fi
`, { mode: 0o755 });
      writeFileSync(driver, `#!/bin/sh\nexec /bin/sh ${quoteSh(installerSh)}\n`);
    }
    const run = (signal: AbortSignal) => runProcess(shellPaths.get(shell)!, windows
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver] : [driver],
    environmentForShell(shell, env), 30000, signal);
    return { run, node, prefix, initial, first, home, root, tarball };
  }

  describe.each(shells)('%s', shell => {
    const fallbackCases: [string, string | undefined][] = [
      ['npm-less Node', undefined], ['nonzero npm', 'nonzero'], ['garbage npm', 'garbage'],
      ['broken PATH npm', undefined], ['mismatched', undefined], ['old', 'valid'],
    ];
    if (windows) fallbackCases.push(['prefix-old', undefined]);
    for (const [scenario, mode] of fallbackCases) {
      // Each scenario owns its home. Only these two explicitly ordered tests
      // share mutable state, and the reuse test requires the first to succeed.
      describe(`pinned Node for ${scenario}`, { concurrent: false, shuffle: false }, () => {
        let fixture: Awaited<ReturnType<typeof install>>;
        let installed = false;
        beforeAll(async () => { fixture = await install(shell, scenario, mode); });

        function assertPinnedRuntime(result: ProcessResult) {
          expectSuccess(result);
          if (!windows) expect(statSync(fixture.root).mode & 0o777).toBe(0o700);
          expect(result.stdout).toContain(`Node.js: 22.22.0 (${fixture.node})`);
          expect(result.stdout).toContain(`CLI Node: ${fixture.node} (22.22.0)`);
          const selection = JSON.parse(readFileSync(join(fixture.prefix, 'npm-selection.json'), 'utf8'));
          expect(selection.node).toBe(fixture.node);
          expect(selection.npm).toBe(join(fixture.root, windows ? 'node/node_modules/npm/bin/npm-cli.js' : 'node/lib/node_modules/npm/bin/npm-cli.js'));
          expect(selection.args).toContain(fixture.tarball);
        }

        it('first installs pinned Node and uses its bundled npm', async ({ signal }) => {
          const result = await fixture.run(signal);
          assertPinnedRuntime(result);
          expect(result.stdout).toContain('Installing user-local Node 22.22.0');
          installed = true;
        });

        it('reuses that installation and its bundled npm', async ({ signal }) => {
          expect(installed, 'The first-install case must complete successfully before reuse').toBe(true);
          const result = await fixture.run(signal);
          assertPinnedRuntime(result);
          expect(result.stdout).not.toContain('Installing user-local Node');
          if (scenario === 'prefix-old') expect(readFileSync(join(fixture.prefix, 'version.txt'), 'utf8')).toBe('20.19.0');
          expect(readFileSync(join(fixture.first, 'version.txt'), 'utf8')).toBe(scenario === 'old' ? '20.19.0' : '24.21.0');
          expect(existsSync(join(fixture.root, '.installer-owned'))).toBe(true);
        });
      });
    }

    it('reuses a co-installed working npm with the selected Node', async ({ signal }) => {
      const fixture = await install(shell, 'working', 'valid');
      const result = await fixture.run(signal);
      expectSuccess(result);
      expect(result.stdout).not.toContain('Installing user-local Node');
      const selection = JSON.parse(readFileSync(join(fixture.prefix, 'npm-selection.json'), 'utf8'));
      expect(selection.node).toBe(join(fixture.first, windows ? 'node.exe' : 'node'));
      expect(selection.npm.startsWith(fixture.initial)).toBe(true);
      expect(result.stdout).toContain(`CLI Node: ${selection.node} (24.21.0)`);
    });

    it.for(['download', 'checksum', 'installed-npm', 'architecture'])('explains the runtime and remediation after %s failure', async (failure, { signal }) => {
      const fixture = await install(shell, 'npm-less Node', undefined, failure);
      const result = await fixture.run(signal);
      expect(result.timedOut, processDetails(result)).toBe(false);
      expect(result.error, processDetails(result)).toBeUndefined();
      expect(result.status, processDetails(result)).not.toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain(fixture.first);
      expect(output).toContain('24.21.0');
      expect(output).toContain('npm');
      const instructions = output.replace(/\s+/g, ' ');
      expect(instructions).toContain('Install Node 22 or newer with its bundled npm');
      expect(instructions).toContain('put that installation first on PATH, and rerun.');
      expect(instructions).toContain('nodejs.org');
      if (windows) {
        expect(result.stderr).toContain('Initial runtime:');
        expect(result.stderr).toContain('Current runtime:');
        expect(result.stderr).toContain('Install Node 22 or newer with its bundled npm');
        const reasons: Record<string, string> = {
          download: 'fixture download failed', checksum: 'Node checksum mismatch',
          'installed-npm': 'Downloaded Node or its bundled npm is not usable', architecture: 'Windows x64 or arm64 is required',
        };
        expect(result.stderr).toContain(reasons[failure]);
      }
      expect(existsSync(join(fixture.prefix, 'npm-selection.json'))).toBe(false);
    });
  });
});
