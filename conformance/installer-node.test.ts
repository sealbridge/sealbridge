import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, symlinkSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const windows = process.platform === 'win32';
const installerPs = resolve('sites/install.ps1');
const installerSh = resolve('sites/install.sh');
const quoteSh = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

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
  let prefix: string;
  let first: string;
  let second: string;
  let driver: string;
  let preload: string;
  const shells = new Map<string, string>();

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'sealbridge-node-')));
    prefix = join(dir, 'npm prefix');
    first = join(dir, 'first Node');
    second = join(dir, 'second Node');
    for (const folder of [prefix, first, second]) {
      mkdirSync(folder);
      copyFileSync(process.execPath, join(folder, 'node.exe'));
    }
    for (const shell of ['powershell.exe', 'pwsh']) {
      const found = spawnSync('where.exe', [shell], { encoding: 'utf8' });
      expect(found.status, found.stderr).toBe(0);
      shells.set(shell, found.stdout.trim().split(/\r?\n/)[0]);
    }
    preload = join(dir, 'version.cjs');
    writeFileSync(preload, `
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
    // Load the exact installer function without running installation or downloads.
    writeFileSync(driver, `
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:SEALBRIDGE_TEST_INSTALLER, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$definition = $ast.Find({ param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq 'Get-SealbridgeNode' }, $true)
if (!$definition) { throw 'Installer Node check function is missing.' }
Invoke-Expression $definition.Extent.Text
$runtime = Get-SealbridgeNode -Prefix $env:SEALBRIDGE_TEST_PREFIX
@{ ShellMajor = $PSVersionTable.PSVersion.Major; Runtime = $runtime } | ConvertTo-Json -Compress
`);
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  function check(shell: string, paths: string[], useFakeVersion = true, usePrefix = false) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
    // Exclude any other Node installations while retaining Windows utilities.
    env.Path = [...paths, join(process.env.SystemRoot!, 'System32'), process.env.SystemRoot!].join(';');
    env.SEALBRIDGE_TEST_INSTALLER = installerPs;
    env.SEALBRIDGE_TEST_PREFIX = usePrefix ? prefix : join(dir, 'empty prefix');
    delete env.NODE_OPTIONS;
    if (useFakeVersion) env.NODE_OPTIONS = `--require "${preload.replaceAll('\\', '/')}"`;
    const result = spawnSync(shells.get(shell)!, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver], {
      env: environmentForShell(shell, env), encoding: 'utf8', timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.ShellMajor).toBe(shell === 'powershell.exe' ? 5 : 7);
    return output.Runtime as { Path: string; Version: string; Supported: boolean } | null;
  }

  describe.each(['powershell.exe', 'pwsh'])('%s', shell => {
    it('checks a real Node on PATH and reports its resolved executable and version', () => {
      expect(check(shell, [dirname(process.execPath)], false)).toEqual({
        Path: process.execPath, Version: process.versions.node, Supported: true,
      });
    });

    it.each([
      ['20.0.0', false], ['21.7.3', false], ['22.0.0', true], ['22.22.0', true], ['24.21.0', true],
    ])('parses %s without nested JavaScript quotes (supported: %s)', (version, supported) => {
      writeFileSync(join(first, 'version.txt'), version);
      expect(check(shell, [first])).toEqual({ Path: join(first, 'node.exe'), Version: version, Supported: supported });
    });

    it.each(['invalid', 'nonzero'])('rejects an unusable Node (%s)', version => {
      writeFileSync(join(first, 'version.txt'), version);
      expect(check(shell, [first])).toBeNull();
    });

    it('reports no runtime when Node is absent', () => {
      expect(check(shell, [])).toBeNull();
    });

    it('follows PATH order when the prefix has no Node', () => {
      writeFileSync(join(first, 'version.txt'), '24.21.0');
      writeFileSync(join(second, 'version.txt'), '22.22.0');
      expect(check(shell, [second, first])).toEqual({ Path: join(second, 'node.exe'), Version: '22.22.0', Supported: true });
    });

    it.each([['22.22.0', true], ['20.0.0', false]])('prefers prefix-local Node %s over PATH', (version, supported) => {
      writeFileSync(join(first, 'version.txt'), '24.21.0');
      writeFileSync(join(prefix, 'version.txt'), version);
      expect(check(shell, [first], true, true)).toEqual({ Path: join(prefix, 'node.exe'), Version: version, Supported: supported });
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

  function stageRuntime(folder: string, version: string, npmMode?: string) {
    const bin = windows ? folder : join(folder, 'bin');
    mkdirSync(bin, { recursive: true });
    copyFileSync(process.execPath, join(bin, windows ? 'node.exe' : 'node'));
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

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'sealbridge-runtime-')));
    const arch = process.env.PROCESSOR_ARCHITECTURE === 'ARM64' ? 'arm64' : 'x64';
    fixture = join(dir, windows ? `node-v22.22.0-win-${arch}` : 'archive fixture');
    stageRuntime(fixture, '22.22.0', 'valid');
    preload = join(dir, 'version.cjs');
    writeFileSync(preload, `
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(path.dirname(process.execPath), 'version.txt');
if (fs.existsSync(file)) Object.defineProperty(process.versions, 'node', { value: fs.readFileSync(file, 'utf8') });
`);
    for (const shell of shells) {
      const found = windows ? spawnSync('where.exe', [shell], { encoding: 'utf8' }) : null;
      if (found) expect(found.status, found.stderr).toBe(0);
      shellPaths.set(shell, found ? found.stdout.trim().split(/\r?\n/)[0] : shell);
    }
    if (windows) {
      fixtureArchive = join(dir, 'node fixture.zip');
      const result = spawnSync(shellPaths.get('pwsh')!, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
[void][Reflection.Assembly]::Load('System.IO.Compression.FileSystem')
[IO.Compression.ZipFile]::CreateFromDirectory($env:SEALBRIDGE_TEST_FIXTURE, $env:SEALBRIDGE_TEST_ARCHIVE, [IO.Compression.CompressionLevel]::Fastest, $true)
`], {
        env: { ...process.env, SEALBRIDGE_TEST_FIXTURE: fixture, SEALBRIDGE_TEST_ARCHIVE: fixtureArchive },
        encoding: 'utf8', timeout: 30000,
      });
      expect(result.status, result.stderr).toBe(0);
      // Node's lowercase digest also exercises comparison with the uppercase .NET digest.
      fixtureHash = createHash('sha256').update(readFileSync(fixtureArchive)).digest('hex');
    }
  }, 40000);
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  function install(shell: string, scenario: string, npmMode?: string, failure?: string) {
    const home = mkdtempSync(join(dir, 'user with spaces-'));
    const initial = join(home, 'original runtime');
    const first = stageRuntime(initial, scenario === 'old' ? '20.19.0' : '24.21.0', npmMode);
    const tools = join(home, 'tools');
    mkdirSync(tools);
    // An unrelated npm on PATH must not make a copied, npm-less Node usable.
    if (scenario === 'mismatched') stageRuntime(join(home, 'other runtime'), '22.22.0', 'valid');
    const root = windows ? join(home, 'Sealbridge') : join(home, '.local/share/sealbridge');
    const node = windows ? join(root, 'node/node.exe') : join(root, 'node/bin/node');
    const prefix = join(root, 'npm');
    if (scenario === 'prefix-old') {
      stageRuntime(prefix, '20.19.0');
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
    const run = () => spawnSync(shellPaths.get(shell)!, windows
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver] : [driver],
    { env: environmentForShell(shell, env), encoding: 'utf8', timeout: 30000 });
    return { run, node, prefix, initial, first, home, root, tarball };
  }

  describe.each(shells)('%s', shell => {
    const fallbackCases: [string, string | undefined][] = [
      ['npm-less Node', undefined], ['nonzero npm', 'nonzero'], ['garbage npm', 'garbage'],
      ['broken PATH npm', undefined], ['mismatched', undefined], ['old', 'valid'],
    ];
    if (windows) fallbackCases.push(['prefix-old', undefined]);
    it.each(fallbackCases)('installs pinned Node for %s and uses its bundled npm', (scenario, mode) => {
      const fixture = install(shell, scenario, mode);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = fixture.run();
        expect(result.status, result.stderr + result.stdout).toBe(0);
        expect(result.stdout).toContain(`Node.js: 22.22.0 (${fixture.node})`);
        expect(result.stdout).toContain(`CLI Node: ${fixture.node} (22.22.0)`);
        if (attempt === 0) expect(result.stdout).toContain('Installing user-local Node 22.22.0');
        else expect(result.stdout).not.toContain('Installing user-local Node');
        const selection = JSON.parse(readFileSync(join(fixture.prefix, 'npm-selection.json'), 'utf8'));
        expect(selection.node).toBe(fixture.node);
        expect(selection.npm).toBe(join(fixture.root, windows ? 'node/node_modules/npm/bin/npm-cli.js' : 'node/lib/node_modules/npm/bin/npm-cli.js'));
        expect(selection.args).toContain(fixture.tarball);
      }
      if (scenario === 'prefix-old') expect(readFileSync(join(fixture.prefix, 'version.txt'), 'utf8')).toBe('20.19.0');
      expect(readFileSync(join(fixture.first, 'version.txt'), 'utf8')).toBe(scenario === 'old' ? '20.19.0' : '24.21.0');
      expect(existsSync(join(fixture.root, '.installer-owned'))).toBe(true);
    });

    it('reuses a co-installed working npm with the selected Node', () => {
      const fixture = install(shell, 'working', 'valid');
      const result = fixture.run();
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).not.toContain('Installing user-local Node');
      const selection = JSON.parse(readFileSync(join(fixture.prefix, 'npm-selection.json'), 'utf8'));
      expect(selection.node).toBe(join(fixture.first, windows ? 'node.exe' : 'node'));
      expect(selection.npm.startsWith(fixture.initial)).toBe(true);
      expect(result.stdout).toContain(`CLI Node: ${selection.node} (24.21.0)`);
    });

    it.each(['download', 'checksum', 'installed-npm', 'architecture'])('explains the runtime and remediation after %s failure', failure => {
      const fixture = install(shell, 'npm-less Node', undefined, failure);
      const result = fixture.run();
      expect(result.status).not.toBe(0);
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
