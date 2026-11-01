// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runSetup, parseSetupArgs, selectSetupHosts, setupCommand, setupExitCode } from '../cli/src/setup.js';
import type { SetupOptions } from '../cli/src/setup.js';
import { hostDestination, runtimeEntry } from '../cli/src/setup-hosts.js';
import { hostChange, snapshot, publish } from '../cli/src/setup-files.js';
import { generateKeyPair } from '../packages/core/src/index.js';
import { parseMcpServerArgs, mcpServerOptionsFromArgs } from '../cli/src/mcp.js';
import { japaneseErrorReason } from '../cli/src/error-messages.js';

const roots: string[] = [];
const initialExit = process.exitCode;
afterEach(() => {
  process.exitCode = initialExit;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(): SetupOptions & { home: string; entryPath: string; env: { SEALBRIDGE_DATA_DIR: string } } {
  const home = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'sealbridge-setup-'));
  roots.push(home);
  const entryPath = join(home, 'Installed CLI & 日本語 !%.js');
  fs.writeFileSync(entryPath, "import('node:fs').then(fs => fs.writeFileSync(process.env.SEALBRIDGE_SETUP_ARGV_OUT, JSON.stringify(process.argv.slice(2))))");
  return { home, env: { SEALBRIDGE_DATA_DIR: join(home, 'data') }, hosts: ['cursor'], entryPath };
}
function write(path: string, raw: string | Buffer, mode = 0o600) {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path, raw, { mode });
}
const hostPath = (o: SetupOptions) => hostDestination('cursor', o).path;
function injected(overrides: Partial<typeof fs>): typeof fs { return { ...fs, ...overrides }; }
function applied(result: Awaited<ReturnType<typeof runSetup>>) {
  if (!('destinations' in result)) throw new Error('Expected summary');
  return result;
}

it.each(['linux', 'darwin', 'win32'] as const)('maps only the supported %s paths', platform => {
  const windows = platform === 'win32', paths = windows ? win32 : posix;
  const home = windows ? 'C:\\Users\\Example' : '/users/example';
  const env = { APPDATA: 'C:\\Users\\Example\\AppData\\Roaming' };
  const options = { home, env, platform };
  expect(hostDestination('cursor', options).path).toBe(paths.join(home, '.cursor', 'mcp.json'));
  if (platform === 'linux') expect(() => hostDestination('claude-desktop', options)).toThrow('SETUP_HOST_UNSUPPORTED');
  else expect(hostDestination('claude-desktop', options).path).toBe(windows
    ? win32.join(env.APPDATA, 'Claude', 'claude_desktop_config.json')
    : posix.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  const project = paths.join(home, 'project');
  expect(hostDestination('claude-code', { ...options, project }).path).toBe(paths.join(project, '.mcp.json'));
  expect(() => hostDestination('claude-code', options)).toThrow('SETUP_INVALID_ARGUMENT');
  expect(() => hostDestination('codex', options)).toThrow('SETUP_HOST_UNSUPPORTED');
});

it('requires an explicit absolute project and rejects ambiguous/unsupported arguments', async () => {
  const o = fixture();
  for (const args of [['--host'], ['--relay'], ['--worker', '--worker'], ['--yes'],
    ['--dry-run', '--print'], ['--host', 'cursor', '--all-detected'], ['--project', '/project']])
    expect(() => parseSetupArgs(args)).toThrow('SETUP_INVALID_ARGUMENT');
  expect(parseSetupArgs(['--host', 'cursor', '--host', 'claude-desktop', '--worker', '--print']))
    .toMatchObject({ hosts: ['cursor', 'claude-desktop'], worker: true, print: true });
  expect(parseSetupArgs(['--no-require-approval', '--update-existing']))
    .toEqual({ requireApproval: false, updateExisting: true });
  for (const flag of ['--no-require-approval', '--update-existing'])
    expect(() => parseSetupArgs([flag, flag])).toThrow('SETUP_INVALID_ARGUMENT');
  await expect(runSetup({ ...o, hosts: ['claude-code'], project: 'relative' })).rejects.toThrow('SETUP_INVALID_ARGUMENT');
  await expect(runSetup({ ...o, hosts: ['vscode'] })).rejects.toThrow('SETUP_HOST_UNSUPPORTED');
  expect(fs.existsSync(o.env.SEALBRIDGE_DATA_DIR)).toBe(false);
});

it('selects detected user hosts and leaves ambiguity/cancellation without writes', async () => {
  const o = fixture();
  await expect(runSetup({ ...o, hosts: undefined })).rejects.toThrow('SETUP_HOST_REQUIRED');
  fs.mkdirSync(join(o.home, '.cursor'));
  expect((await selectSetupHosts({ ...o, hosts: undefined })).map(h => h.host)).toEqual(['cursor']);
  // Simulate known macOS host directories without accessing the machine's user directories.
  const options: SetupOptions = { home: '/users/example', platform: 'darwin',
    fs: injected({ lstatSync: vi.fn(() => ({ isDirectory: () => true })) as unknown as typeof fs.lstatSync }) };
  await expect(selectSetupHosts(options)).rejects.toThrow('SETUP_HOST_REQUIRED');
  expect((await selectSetupHosts({ ...options, allDetected: true })).map(h => h.host)).toEqual(['claude-desktop', 'cursor']);
  expect((await selectSetupHosts({ ...options, chooseHost: async () => 'cursor' }))[0].host).toBe('cursor');
  await expect(selectSetupHosts({ ...options, chooseHost: async () => undefined })).rejects.toThrow('SETUP_HOST_REQUIRED');
  expect(fs.existsSync(o.env.SEALBRIDGE_DATA_DIR)).toBe(false);
});

it.each([
  ['dryRun', true], ['dryRun', false], ['print', true], ['print', false],
] as const)('%s with requireApproval=%s validates but makes zero writes or requests', async (mode, requireApproval) => {
  const o = fixture(), fetch = vi.fn(() => { throw new Error('unexpected fetch'); });
  vi.stubGlobal('fetch', fetch);
  const deny = vi.fn(() => { throw new Error('unexpected mutation'); });
  const io = injected({ mkdirSync: deny, writeFileSync: deny, writeSync: deny, linkSync: deny,
    renameSync: deny, unlinkSync: deny, chmodSync: deny, openSync: ((path, flags, ...rest) => {
      if (typeof flags === 'string' ? flags !== 'r' : (flags & (fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_RDWR))) deny();
      return fs.openSync(path, flags, ...rest);
    }) as typeof fs.openSync });
  const result = await runSetup({ ...o, fs: io, worker: true, requireApproval, [mode]: true });
  expect(deny).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  expect(fs.existsSync(o.env.SEALBRIDGE_DATA_DIR)).toBe(false);
  expect(fs.existsSync(join(o.home, '.cursor'))).toBe(false);
  const text = JSON.stringify(result);
  expect(text).toContain(requireApproval ? 'host-mediated' : 'automatic');
  expect(text).toContain(requireApproval ? 'APPROVAL_CHANNEL_UNAVAILABLE' : 'The host can send without per-request confirmation');
  if (mode === 'print' && 'snippets' in result)
    expect(result.snippets[0].mcpServers.sealbridge.args).toEqual([o.entryPath, 'mcp-server', ...(requireApproval ? ['--require-approval'] : [])]);
  expect(text).not.toContain('privateKey'); expect(text).not.toContain('did:key:');
  if (mode === 'print') expect(Object.keys(result)).toEqual(['snippets']);
  else expect(text).toContain('created on apply');
});

it('creates separate default identities, records M config, and stays byte-idempotent offline', async () => {
  const o = fixture(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const first = applied(await runSetup({ ...o, worker: true }));
  expect(first.error).toBeUndefined();
  expect(first.identities.map(i => i.status)).toEqual(['created', 'created']);
  expect(new Set(first.identities.map(i => i.did)).size).toBe(2);
  const config = join(o.env.SEALBRIDGE_DATA_DIR, 'config.json');
  expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toEqual({ version: 1, relays: ['https://relay.sealbridge.dev'] });
  const bytes = fs.readFileSync(hostPath(o));
  const entry = JSON.parse(bytes.toString()).mcpServers.sealbridge;
  expect(entry).toEqual({ command: fs.realpathSync(process.execPath), args: [fs.realpathSync(o.entryPath), 'mcp-server', '--require-approval'],
    env: { SEALBRIDGE_DATA_DIR: o.env.SEALBRIDGE_DATA_DIR } });
  const second = applied(await runSetup({ ...o, worker: true }));
  expect(second.error).toBeUndefined(); expect(second.destinations[0].status).toBe('unchanged');
  expect(second.identities.map(i => i.did)).toEqual(first.identities.map(i => i.did));
  expect(second.identities.map(i => i.status)).toEqual(['reused', 'reused']);
  expect(fs.readFileSync(hostPath(o))).toEqual(bytes);
  expect(fs.existsSync(join(o.env.SEALBRIDGE_DATA_DIR, 'setup'))).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([true, false])('registers every host with requireApproval=%s and preserves identities on rerun', async requireApproval => {
  const o = fixture(), project = join(o.home, 'project');
  // Keep real filesystem paths native; use macOS on POSIX to include Claude Desktop.
  const platform = process.platform === 'win32' ? 'win32' as const : 'darwin' as const;
  const options = { ...o, platform, env: { ...o.env, APPDATA: join(o.home, 'AppData', 'Roaming') },
    hosts: ['claude-desktop', 'cursor', 'claude-code'], project,
    ...(requireApproval ? {} : { requireApproval: false }) };
  const fetch = vi.fn(() => { throw new Error('unexpected fetch'); }); vi.stubGlobal('fetch', fetch);
  const first = applied(await runSetup(options));
  expect(first.error).toBeUndefined(); expect(first.destinations).toHaveLength(3);
  const before = first.destinations.map(destination => fs.readFileSync(destination.path));
  for (const destination of first.destinations) {
    const entry = JSON.parse(fs.readFileSync(destination.path, 'utf8')).mcpServers.sealbridge;
    expect(entry.args).toEqual([o.entryPath, 'mcp-server', ...(requireApproval ? ['--require-approval'] : [])]);
    expect(destination.approvalMode).toBe(requireApproval ? 'host-mediated' : 'automatic');
    expect(mcpServerOptionsFromArgs(parseMcpServerArgs(entry.args.slice(2))).requireInteractiveApproval).toBe(requireApproval);
  }
  const keyPath = first.identities[0].path, key = fs.readFileSync(keyPath);
  const second = applied(await runSetup(options));
  expect(second.error).toBeUndefined(); expect(second.destinations.every(d => d.status === 'unchanged')).toBe(true);
  expect(second.destinations.map(d => fs.readFileSync(d.path))).toEqual(before);
  expect(fs.readFileSync(keyPath)).toEqual(key);
  expect(fs.existsSync(join(o.env.SEALBRIDGE_DATA_DIR, 'setup'))).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['apply', 'dryRun', 'print'] as const)('reports a legacy approval mode without modifying files in %s', async mode => {
  const o = fixture(), entry = runtimeEntry(o.env.SEALBRIDGE_DATA_DIR, { ...o, requireApproval: false });
  const raw = JSON.stringify({ mcpServers: { sealbridge: entry } }); write(hostPath(o), raw);
  await expect(runSetup({ ...o, ...(mode === 'apply' ? {} : { [mode]: true }) }))
    .rejects.toThrow('SETUP_APPROVAL_MODE_CONFLICT');
  expect(fs.readFileSync(hostPath(o), 'utf8')).toBe(raw);
  expect(fs.existsSync(o.env.SEALBRIDGE_DATA_DIR)).toBe(false);
  expect(setupExitCode('SETUP_APPROVAL_MODE_CONFLICT')).toBe(3);
  expect(japaneseErrorReason('SETUP_APPROVAL_MODE_CONFLICT')).toContain('--update-existing');
  expect(japaneseErrorReason('SETUP_ENTRY_CONFLICT')).toContain('--update-existing');
  const unchanged = applied(await runSetup({ ...o, requireApproval: false }));
  expect(unchanged.error).toBeUndefined(); expect(unchanged.destinations[0].status).toBe('unchanged');
  expect(fs.readFileSync(hostPath(o), 'utf8')).toBe(raw);
});

it.each([true, false])('replaces only the Sealbridge value with a backup when requireApproval=%s is requested explicitly', async requireApproval => {
  const o = fixture(), oldEntry = runtimeEntry(o.env.SEALBRIDGE_DATA_DIR, { ...o, requireApproval: !requireApproval });
  const prefix = '\uFEFF{\r\n\t"mcpServers": {"other": { "command": "other" }, "sealbridge": ', suffix = '},\r\n\t"tail": [ 1,2 ]\r\n}\r\n';
  const raw = prefix + JSON.stringify(oldEntry, null, '\t').replaceAll('\n', '\r\n') + suffix;
  write(hostPath(o), raw, 0o640);
  await expect(runSetup({ ...o, requireApproval })).rejects.toThrow('SETUP_APPROVAL_MODE_CONFLICT');
  for (const mode of ['dryRun', 'print'] as const) {
    const preview = await runSetup({ ...o, requireApproval, updateExisting: true, [mode]: true });
    expect(JSON.stringify(preview)).toContain(requireApproval ? 'host-mediated' : 'automatic');
    expect(fs.readFileSync(hostPath(o), 'utf8')).toBe(raw);
    expect(fs.existsSync(o.env.SEALBRIDGE_DATA_DIR)).toBe(false);
  }
  const options = { ...o, requireApproval, updateExisting: true };
  const result = applied(await runSetup(options)); expect(result.error).toBeUndefined();
  expect(result.destinations[0].status).toBe('configured');
  const backup = result.destinations[0].backup!;
  expect(fs.readFileSync(backup, 'utf8')).toBe(raw);
  expect(fs.readFileSync(hostPath(o), 'utf8')).toBe(prefix + JSON.stringify(runtimeEntry(o.env.SEALBRIDGE_DATA_DIR, options)) + suffix);
  if (process.platform !== 'win32') expect(fs.statSync(hostPath(o)).mode & 0o777).toBe(0o640);
  const rerun = applied(await runSetup(options)); expect(rerun.error).toBeUndefined();
  expect(rerun.destinations[0].status).toBe('unchanged'); expect(rerun.destinations[0].backup).toBeUndefined();
  expect(fs.readdirSync(dirname(backup))).toHaveLength(1);
});

it('requires explicit replacement for a differing runtime entry and retains the original on publication failure', async () => {
  const o = fixture(), raw = '{"mcpServers":{"sealbridge":{"command":"previous"},"other":{}},"owner":true}';
  write(hostPath(o), raw);
  await expect(runSetup(o)).rejects.toThrow('SETUP_ENTRY_CONFLICT');
  const result = applied(await runSetup({ ...o, updateExisting: true,
    fs: injected({ renameSync: () => { throw new Error('rename failed'); } }) }));
  expect(result.error).toBe('SETUP_WRITE_FAILED');
  expect(fs.readFileSync(hostPath(o), 'utf8')).toBe(raw);
  expect(fs.readFileSync(result.destinations[0].backup!, 'utf8')).toBe(raw);
  const rerun = applied(await runSetup({ ...o, updateExisting: true })); expect(rerun.error).toBeUndefined();
  expect(JSON.parse(fs.readFileSync(hostPath(o), 'utf8'))).toEqual({
    mcpServers: { sealbridge: runtimeEntry(o.env.SEALBRIDGE_DATA_DIR, o), other: {} }, owner: true,
  });
});

it('prints CLI approval modes and explicit instructions for replacing a legacy entry', async () => {
  const o = fixture();
  vi.stubEnv('HOME', o.home); vi.stubEnv('USERPROFILE', o.home);
  vi.stubEnv('SEALBRIDGE_DATA_DIR', o.env.SEALBRIDGE_DATA_DIR);
  const fetch = vi.fn(() => { throw new Error('unexpected fetch'); }); vi.stubGlobal('fetch', fetch);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  // Use the built entry so module-relative runtime resolution has its installed JavaScript path.
  const { setupCommand: installedSetupCommand } = await import('../cli/dist/setup.js');
  const run = (...args: string[]) => installedSetupCommand(['--host', 'cursor', ...args]);
  for (const flag of ['--print', '--dry-run']) {
    await run(flag); expect(log.mock.lastCall![0]).toContain('host-mediated');
    await run(flag, '--no-require-approval');
    expect(log.mock.lastCall![0]).toContain('automatic');
    expect(log.mock.lastCall![0]).toContain('without per-request confirmation');
    expect(fs.existsSync(o.env.SEALBRIDGE_DATA_DIR)).toBe(false);
  }
  await run('--no-require-approval');
  expect(JSON.parse(log.mock.lastCall![0]).destinations[0].approvalMode).toBe('automatic');
  const before = fs.readFileSync(hostPath(o));
  await run(); expect(process.exitCode).toBe(3);
  expect(error).toHaveBeenCalledWith('Existing Sealbridge entry uses a different approval mode.');
  expect(error).toHaveBeenCalledWith(expect.stringContaining('--update-existing --dry-run'));
  expect(error).toHaveBeenLastCalledWith('SETUP_APPROVAL_MODE_CONFLICT');
  expect(fs.readFileSync(hostPath(o))).toEqual(before);
  expect(fs.existsSync(join(o.env.SEALBRIDGE_DATA_DIR, 'setup'))).toBe(false);
  await run('--update-existing');
  const updated = JSON.parse(log.mock.lastCall![0]);
  expect(updated.destinations[0].approvalMode).toBe('host-mediated');
  expect(fs.readFileSync(updated.destinations[0].backup)).toEqual(before);
  expect(fetch).not.toHaveBeenCalled();
});

it('reuses a legacy identity in place and creates only requester by default', async () => {
  const o = fixture(), legacy = join(o.home, '.acp', 'requester.private.json');
  const raw = JSON.stringify(generateKeyPair()); write(legacy, raw);
  const result = applied(await runSetup(o));
  expect(result.error).toBeUndefined();
  expect(result.identities).toMatchObject([{ source: 'legacy', path: legacy, status: 'reused' }]);
  expect(fs.readFileSync(legacy, 'utf8')).toBe(raw);
  expect(fs.existsSync(join(o.env.SEALBRIDGE_DATA_DIR, 'identities'))).toBe(false);
});

it('retains corrupt and conflicting legacy keys without writes', async () => {
  const o = fixture(), legacy = join(o.home, '.acp', 'requester.private.json');
  write(legacy, 'invalid');
  await expect(runSetup(o)).rejects.toThrow('IDENTITY_INVALID');
  expect(fs.readFileSync(legacy, 'utf8')).toBe('invalid');
  write(legacy, JSON.stringify(generateKeyPair()));
  const oldRoot = process.platform === 'win32' ? join(o.home, 'AgentCollaborationPlatform')
    : process.platform === 'darwin' ? join(o.home, 'Library', 'Application Support', 'AgentCollaborationPlatform')
    : join(o.home, '.local', 'share', 'agent-collab-platform');
  write(join(oldRoot, 'owner.private.json'), JSON.stringify(generateKeyPair()));
  await expect(runSetup(o)).rejects.toThrow('IDENTITY_SELECTION_REQUIRED');
  expect(fs.existsSync(o.env.SEALBRIDGE_DATA_DIR)).toBe(false);
});

it('preserves existing config fields/order and treats --relay as a fallback only', async () => {
  const o = fixture(), path = join(o.env.SEALBRIDGE_DATA_DIR, 'config.json');
  const raw = '{"future":{"flag":true},"version":1,"relays":["https://one.example", "https://two.example"]}\n';
  write(path, raw);
  await expect(runSetup({ ...o, relay: 'https://other.example' })).rejects.toThrow('SETUP_CONFIG_CONFLICT');
  expect(fs.existsSync(hostPath(o))).toBe(false);
  const result = applied(await runSetup({ ...o, relay: 'https://one.example/' }));
  expect(result.error).toBeUndefined(); expect(fs.readFileSync(path, 'utf8')).toBe(raw);
  expect(fs.readFileSync(hostPath(o), 'utf8')).not.toContain('--relay');
  const fresh = fixture();
  expect(applied(await runSetup({ ...fresh, relay: 'https://custom.example/path/' })).config.relay).toBe('https://custom.example/path');
  for (const relay of ['http://127.0.0.1:8787', 'https://user:password@example.com', 'https://relay.example/?secret=yes'])
    await expect(runSetup({ ...fixture(), relay })).rejects.toThrow();
});

it('reuses M compatibility config without rewriting it or changing host directory modes', async () => {
  const o = fixture(), config = join(o.env.SEALBRIDGE_DATA_DIR, 'config.json');
  const raw = '{"version":1,"relay":"https://relay.example","future":true}\n'; write(config, raw);
  fs.mkdirSync(dirname(hostPath(o)), { mode: 0o755 });
  const before = fs.statSync(dirname(hostPath(o))).mode;
  const result = applied(await runSetup(o)); expect(result.error).toBeUndefined();
  expect(fs.readFileSync(config, 'utf8')).toBe(raw);
  if (process.platform !== 'win32') expect(fs.statSync(dirname(hostPath(o))).mode).toBe(before);
});

it.each(['{', '[]', '{"mcpServers":null}', '{"x":1,"x":2}', '{"x":{"a":1,"\\u0061":2}}',
  '{/* comment */"x":1}', '{"x":1,}', '{"mcpServers":{"sealbridge":{"command":"other","env":{"secret":"REDACT"}}}}'])
  ('refuses invalid/duplicate/conflicting config before identity writes: %s', async raw => {
    const o = fixture(); write(hostPath(o), raw);
    await expect(runSetup(o)).rejects.toThrow(raw.includes('REDACT') ? 'SETUP_ENTRY_CONFLICT' : 'SETUP_CONFIG_INVALID');
    expect(fs.readFileSync(hostPath(o), 'utf8')).toBe(raw);
    expect(fs.existsSync(o.env.SEALBRIDGE_DATA_DIR)).toBe(false);
  });

it('preflights all hosts, including a later conflict, before any writes', async () => {
  const o = fixture(), project = join(o.home, 'project');
  write(join(project, '.mcp.json'), '{"mcpServers":{"sealbridge":{}}}');
  await expect(runSetup({ ...o, hosts: ['cursor', 'claude-code'], project })).rejects.toThrow('SETUP_ENTRY_CONFLICT');
  expect(fs.existsSync(hostPath(o))).toBe(false); expect(fs.existsSync(o.env.SEALBRIDGE_DATA_DIR)).toBe(false);
});

it('preserves unrelated bytes, BOM, CRLF, modes and exact backups, with no backup on rerun', async () => {
  const o = fixture(), raw = '\uFEFF{\r\n\t"mcpServers": {"other": { "env": {"SECRET": "REDACT"} }},\r\n\t"tail": [ 1,2 ]\r\n}\r\n';
  write(hostPath(o), raw, 0o640);
  const result = applied(await runSetup(o));
  expect(result.error).toBeUndefined(); expect(JSON.stringify(result)).not.toContain('REDACT');
  const next = fs.readFileSync(hostPath(o), 'utf8');
  expect(next.startsWith('\uFEFF')).toBe(true); expect(next.replaceAll('\r\n', '')).not.toContain('\n');
  expect(next).toContain('"other": { "env": {"SECRET": "REDACT"} }'); expect(next).toContain('"tail": [ 1,2 ]');
  const backup = result.destinations[0].backup!;
  expect(fs.readFileSync(backup, 'utf8')).toBe(raw);
  if (process.platform !== 'win32') {
    expect(fs.statSync(hostPath(o)).mode & 0o777).toBe(0o640);
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dirname(backup)).mode & 0o777).toBe(0o700);
  }
  const rerun = applied(await runSetup(o)); expect(rerun.error).toBeUndefined();
  expect(rerun.destinations[0].status).toBe('unchanged');
  expect(fs.readdirSync(dirname(backup))).toHaveLength(1);
});

it('rejects extra fields in a preexisting Sealbridge entry', async () => {
  const o = fixture(), entry = runtimeEntry(o.env.SEALBRIDGE_DATA_DIR, o);
  write(hostPath(o), JSON.stringify({ mcpServers: { sealbridge: { ...entry, disabled: false } } }));
  await expect(runSetup(o)).rejects.toThrow('SETUP_ENTRY_CONFLICT');
});

it('refuses app duplicate keys and oversized/nonregular host files', async () => {
  const o = fixture(), config = join(o.env.SEALBRIDGE_DATA_DIR, 'config.json');
  write(config, '{"version":1,"version":1,"relays":["https://relay.example"]}');
  await expect(runSetup(o)).rejects.toThrow('SETUP_CONFIG_INVALID');
  const large = fixture(); write(hostPath(large), ' '.repeat(1024 * 1024 + 1));
  await expect(runSetup(large)).rejects.toThrow('SETUP_CONFIG_INVALID');
  const dir = fixture(); fs.mkdirSync(hostPath(dir), { recursive: true });
  await expect(runSetup(dir)).rejects.toThrow('SETUP_CONFIG_INVALID');
});

it('detects a changed original and no-replace creation races', () => {
  const o = fixture(), path = hostPath(o), entry = runtimeEntry(o.env.SEALBRIDGE_DATA_DIR, o);
  const absent = hostChange(snapshot(path), entry);
  write(path, '{"owner":"new"}');
  expect(() => publish(absent, o.env.SEALBRIDGE_DATA_DIR)).toThrow('SETUP_CONFIG_CHANGED');
  const change = hostChange(snapshot(path), entry);
  write(path, '{"owner":"newer"}');
  expect(() => publish(change, o.env.SEALBRIDGE_DATA_DIR)).toThrow('SETUP_CONFIG_CHANGED');
  expect(fs.readFileSync(path, 'utf8')).toBe('{"owner":"newer"}');
});

it('serializes setup writers with a bounded lock and leaves the existing lock intact', async () => {
  const o = fixture(), lock = join(o.env.SEALBRIDGE_DATA_DIR, '.setup.lock'); write(lock, 'owner');
  const result = applied(await runSetup(o)); expect(result.error).toBe('SETUP_CONFIG_BUSY');
  expect(fs.readFileSync(lock, 'utf8')).toBe('owner'); expect(fs.existsSync(hostPath(o))).toBe(false);
  expect(fs.existsSync(join(o.env.SEALBRIDGE_DATA_DIR, 'identities'))).toBe(false);
});

it.each(['before-publication', 'after-publication'] as const)('detects external edits %s without restoring over them', async when => {
  const o = fixture(), path = hostPath(o); write(path, '{"owner":"original"}');
  const current = '{"owner":"newer"}', fdPaths = new Map<number, string>();
  const io = injected({ openSync: ((path, ...rest) => {
    const fd = fs.openSync(path, ...rest); fdPaths.set(fd, String(path)); return fd;
  }) as typeof fs.openSync, fsyncSync: fd => {
    fs.fsyncSync(fd);
    if (when === 'before-publication' && fdPaths.get(fd)?.includes('.sealbridge.')) write(path, current);
  }, renameSync: (from, to) => {
    fs.renameSync(from, to);
    if (when === 'after-publication') write(path, current);
  } });
  const result = applied(await runSetup({ ...o, fs: io }));
  expect(result.error).toBe('SETUP_CONFIG_CHANGED');
  expect(fs.readFileSync(path, 'utf8')).toBe(current);
  expect(fs.readFileSync(result.destinations[0].backup!, 'utf8')).toBe('{"owner":"original"}');
});

it('does not replace a newly created config or remove an unowned temporary on collision', () => {
  const o = fixture(), path = hostPath(o), entry = runtimeEntry(o.env.SEALBRIDGE_DATA_DIR, o);
  const change = hostChange(snapshot(path), entry);
  const ownerText = '{"owner":"raced"}';
  const io = injected({ linkSync: (from, to) => { write(String(to), ownerText); fs.linkSync(from, to); } });
  expect(() => publish(change, o.env.SEALBRIDGE_DATA_DIR, io)).toThrow('SETUP_CONFIG_CHANGED');
  expect(fs.readFileSync(path, 'utf8')).toBe(ownerText);
  const collided: string[] = [];
  const collisionIo = injected({ openSync: ((path, ...rest) => {
    if (String(path).includes('.sealbridge.')) {
      collided.push(String(path)); write(String(path), 'other writer');
    }
    return fs.openSync(path, ...rest);
  }) as typeof fs.openSync });
  const existing = hostChange(snapshot(path), entry);
  expect(() => publish(existing, o.env.SEALBRIDGE_DATA_DIR, collisionIo)).toThrow('SETUP_CONFIG_CHANGED');
  expect(collided).toHaveLength(1); expect(fs.readFileSync(collided[0], 'utf8')).toBe('other writer');
});

it.each(['backup', 'rename', 'flush'] as const)('retains the original after %s failure and reports no secret error text', async failure => {
  const o = fixture(), path = hostPath(o), raw = '{"owner":"REDACT"}'; write(path, raw);
  const deny = () => { throw new Error('REDACT'); };
  const hostTemps = new Set<number>();
  const io = injected(failure === 'rename' ? { renameSync: deny } : failure === 'flush'
    ? { openSync: ((path, ...rest) => {
      const fd = fs.openSync(path, ...rest);
      if (String(path).includes('.sealbridge.')) hostTemps.add(fd);
      return fd;
    }) as typeof fs.openSync, fsyncSync: (fd => hostTemps.has(fd) ? deny() : fs.fsyncSync(fd)) }
    : { openSync: ((path, flags, ...rest) => String(path).includes(join('setup', 'backups')) ? deny() : fs.openSync(path, flags, ...rest)) as typeof fs.openSync });
  const result = applied(await runSetup({ ...o, fs: io }));
  expect(result.error).toBe('SETUP_WRITE_FAILED'); expect(JSON.stringify(result)).not.toContain('REDACT');
  expect(fs.readFileSync(path, 'utf8')).toBe(raw);
  expect(fs.readdirSync(dirname(path)).some(p => p.endsWith('.tmp'))).toBe(false);
  expect(applied(await runSetup(o)).error).toBeUndefined();
});

it('reports partial host results and retains identities/backups for a rerun', async () => {
  const o = fixture(), project = join(o.home, 'project'), path = join(project, '.mcp.json'); write(path, '{}');
  const io = injected({ renameSync: () => { throw new Error('sharing violation'); } });
  const result = applied(await runSetup({ ...o, hosts: ['cursor', 'claude-code'], project, fs: io }));
  expect(result.error).toBe('SETUP_WRITE_FAILED');
  expect(result.destinations.map(d => d.status)).toEqual(['configured', 'failed']);
  expect(fs.readFileSync(result.destinations[1].backup!, 'utf8')).toBe('{}');
  const rerun = applied(await runSetup({ ...o, hosts: ['cursor', 'claude-code'], project }));
  expect(rerun.error).toBeUndefined(); expect(rerun.identities[0].did).toBe(result.identities[0].did);
});

it('rejects detectable links without touching their targets', async () => {
  const o = fixture(), target = join(o.home, 'target'); fs.mkdirSync(target);
  fs.symlinkSync(target, join(o.home, '.cursor'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(runSetup(o)).rejects.toThrow('SETUP_CONFIG_INVALID');
  expect(fs.readdirSync(target)).toEqual([]); expect(fs.existsSync(o.env.SEALBRIDGE_DATA_DIR)).toBe(false);
});

it('reports permission failures without printing filesystem error details', async () => {
  const o = fixture();
  const io = injected({ openSync: ((path, ...rest) => {
    if (String(path) === hostPath(o)) throw Object.assign(new Error('REDACT'), { code: 'EACCES' });
    return fs.openSync(path, ...rest);
  }) as typeof fs.openSync });
  write(hostPath(o), '{}');
  await expect(runSetup({ ...o, fs: io })).rejects.toThrow('SETUP_WRITE_FAILED');
});

it('refuses source-only and recognizable temporary runtime paths', () => {
  const o = fixture();
  for (const entryPath of [join(o.home, '_npx', 'cli.js'), join(o.home, 'dlx', 'cli.js'), join(o.home, 'cli.ts')]) {
    write(entryPath, ''); expect(() => runtimeEntry(o.env.SEALBRIDGE_DATA_DIR, { ...o, entryPath })).toThrow('SETUP_RUNTIME_UNSTABLE');
  }
});

it('keeps Windows argv literal and uses native Node with a JavaScript entry', async () => {
  const command = 'C:\\Node & 日本語 !%\\node.exe', entryPath = 'C:\\Sealbridge space & 日本語 !%\\index.js';
  const io = injected({ realpathSync: ((p: string) => p) as typeof fs.realpathSync,
    statSync: (() => ({ isFile: () => true })) as unknown as typeof fs.statSync });
  const entry = runtimeEntry('C:\\User data', { fs: io, platform: 'win32', execPath: command, entryPath });
  expect(entry).toEqual({ command, args: [entryPath, 'mcp-server', '--require-approval'], env: { SEALBRIDGE_DATA_DIR: 'C:\\User data' } });
  const o = fixture();
  const output = join(o.home, 'argv.json');
  await promisify(execFile)(process.execPath, [o.entryPath, ...entry.args], { shell: false, timeout: 10000,
    env: { ...process.env, SEALBRIDGE_SETUP_ARGV_OUT: output } });
  expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toEqual(entry.args);
  expect(() => runtimeEntry('C:\\data', { fs: io, platform: 'win32', execPath: 'C:\\bin\\sealbridge.cmd', entryPath })).toThrow('SETUP_RUNTIME_UNSTABLE');
});

it('prints help and stable exit codes without creating local state', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {}), error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await setupCommand(['--help']); expect(log.mock.calls[0][0]).toContain('sealbridge setup');
  for (const text of ['--require-approval', '--no-require-approval', '--update-existing', 'APPROVAL_CHANNEL_UNAVAILABLE', 'without per-request confirmation'])
    expect(log.mock.calls[0][0]).toContain(text);
  await setupCommand(['--yes']); expect(process.exitCode).toBe(2); expect(error).toHaveBeenLastCalledWith('SETUP_INVALID_ARGUMENT');
  expect(setupExitCode('SETUP_ENTRY_CONFLICT')).toBe(3); expect(setupExitCode('IDENTITY_INVALID')).toBe(1);
});
