import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { mkdtempSync, realpathSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnose, doctorCommand, parseDoctorArgs } from '../cli/src/doctor.js';
import { generateKeyPair } from '../packages/core/src/index.js';

const roots: string[] = [];
function options() {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'sealbridge-doctor-'));
  roots.push(home);
  return { home, identityOptions: { home, env: { SEALBRIDGE_DATA_DIR: join(home, 'data') } } };
}
const healthy = (async () => new Response('{}', { status: 200 })) as typeof fetch;
const initialExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = initialExitCode;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('doctor', () => {
  describe.each([false, true])('fresh environment (offline: %s)', offline => {
    it.each([
      ['default', 'absent'], ['file', 'absent'],
      ['default', 'empty'], ['file', 'empty'],
      ['default', 'installer'], ['file', 'installer'],
    ])('reports optional keys with %s selection and %s data root', async (selection, layout) => {
      const config = options();
      const root = config.identityOptions.env.SEALBRIDGE_DATA_DIR;
      if (layout !== 'absent') {
        mkdirSync(root, { mode: 0o755 });
        chmodSync(root, 0o755);
        if (layout === 'installer') {
          mkdirSync(join(root, 'node'));
          mkdirSync(join(root, 'npm'));
        }
      }
      const before = layout === 'absent' ? undefined : readdirSync(root);
      const fetch = vi.fn(healthy);
      const keyringLoader = vi.fn(async () => { throw new Error('No keychain'); });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      process.exitCode = 0;
      await doctorCommand({ ...config, offline, version: '22.22.0', path: '/bin', exists: () => true, fetch,
        identityOptions: { ...config.identityOptions, keyringLoader,
          env: { ...config.identityOptions.env, ...(selection === 'file' && { SEALBRIDGE_KEY_STORE: 'file' }) } } });
      const lines = log.mock.calls.map(([line]) => line as string);
      expect(lines.every(line => line.endsWith('(OK)'))).toBe(true);
      expect(process.exitCode).toBe(0);
      expect(lines[2]).toMatch(/worker: .*optional; created on first use/);
      expect(lines[2]).toContain(`selection: file (${selection === 'file' ? 'env' : 'default'})`);
      expect(fetch).toHaveBeenCalledTimes(offline ? 0 : 1);
      if (before === undefined) expect(existsSync(root)).toBe(false);
      else {
        expect(readdirSync(root)).toEqual(before);
        if (process.platform !== 'win32') expect(statSync(root).mode & 0o777).toBe(0o755);
      }
      expect(existsSync(join(config.home, '.acp'))).toBe(false);
    });
  });
  it.each(['invalid', 'unreadable', 'directory-mode'])('warns for %s config and exits 1', async issue => {
    if (issue === 'directory-mode' && process.platform === 'win32') return;
    const config = options();
    const root = config.identityOptions.env.SEALBRIDGE_DATA_DIR;
    mkdirSync(root, { mode: 0o700 });
    const path = join(root, 'config.json');
    const raw = issue === 'invalid' ? '{' : JSON.stringify({ version: 1, relays: ['https://relay.sealbridge.dev'] });
    writeFileSync(path, raw, { mode: 0o600 });
    if (issue === 'directory-mode') chmodSync(root, 0o755);
    const io = { ...fs, openSync: ((file, ...args) => {
      if (issue === 'unreadable' && file === path) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return fs.openSync(file, ...args);
    }) as typeof fs.openSync };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.exitCode = 0;
    await doctorCommand({ ...config, offline: true, version: '22.22.0', path: '/bin', exists: () => true,
      identityOptions: { ...config.identityOptions, fs: io } });
    expect(log.mock.calls[2][0]).toContain(`Keys: APP_CONFIG_${issue === 'unreadable' ? 'UNREADABLE' : 'INVALID'} (WARN)`);
    expect(process.exitCode).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(raw);
  });
  it.each(['invalid', 'directory-mode'])('warns for a key with %s and exits 1', async issue => {
    if (issue === 'directory-mode' && process.platform === 'win32') return;
    const config = options();
    const root = config.identityOptions.env.SEALBRIDGE_DATA_DIR;
    mkdirSync(join(root, 'identities'), { recursive: true, mode: 0o700 });
    const path = join(root, 'identities', 'worker.private.json');
    const raw = issue === 'invalid' ? '{' : JSON.stringify(generateKeyPair());
    writeFileSync(path, raw, { mode: 0o600 });
    if (issue === 'directory-mode') chmodSync(root, 0o755);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.exitCode = 0;
    await doctorCommand({ ...config, offline: true, version: '22.22.0', path: '/bin', exists: () => true,
      identityOptions: { ...config.identityOptions, env: { ...config.identityOptions.env, SEALBRIDGE_KEY_STORE: 'file' } } });
    expect(log.mock.calls[2][0]).toContain('Keys: IDENTITY_INVALID; selection: file (env) (WARN)');
    expect(process.exitCode).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(raw);
  });
  it.each(['22.22.0', '24.21.0'])('accepts Node %s without a fix hint', async version => {
    const checks = await diagnose({ ...options(), version, execPath: '/node/bin/node', path: '/bin', exists: () => true, fetch: healthy });
    expect(checks.map(c => c.name)).toEqual(['Node.js', 'PATH', 'Keys', 'Local PC execution', 'Relay']);
    expect(checks.every(c => c.ok)).toBe(true);
    expect(checks.every(c => c.remediation === undefined)).toBe(true);
    expect(checks[0].message).toBe(`${version} (/node/bin/node)`);
    expect(checks[2].message).toContain('created on first use');
  });
  it('offline inspection never fetches or creates a key', async () => {
    const config = options();
    const fetch = vi.fn(healthy);
    const checks = await diagnose({ ...config, offline: true, fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(checks[2].message).toContain('requester:');
    expect(checks[2].message).toContain('worker:');
    expect(checks[4].message).toBe('Skipped (offline)');
    expect(existsSync(config.identityOptions.env.SEALBRIDGE_DATA_DIR)).toBe(false);
  });
  it('inspects a legacy or explicit key without modifying it and reports invalid choices', async () => {
    const config = options();
    const path = join(config.home, '.acp', 'worker.private.json');
    mkdirSync(join(config.home, '.acp'), { mode: 0o700 });
    const raw = JSON.stringify(generateKeyPair());
    writeFileSync(path, raw, { mode: 0o600 });
    const legacy = await diagnose({ ...config, offline: true });
    expect(legacy[2].message).toContain(path + ' (legacy)');
    const explicit = await diagnose({ ...config, offline: true, keyFile: path });
    expect(explicit[2].message).toContain(path + ' (explicit)');
    expect(readFileSync(path, 'utf8')).toBe(raw);
    const missing = await diagnose({ ...config, offline: true, keyFile: path + '.missing' });
    expect(missing[2]).toMatchObject({ ok: false, message: 'IDENTITY_UNREADABLE' });
  });
  it('provides fixes for old Node, missing PATH and offline relay', async () => {
    const checks = await diagnose({ ...options(), version: '20.0.0', path: '', exists: () => false,
      fetch: (async () => { throw new Error('offline'); }) as typeof fetch });
    expect(checks.filter(c => !c.ok).map(c => c.name)).toEqual(['Node.js', 'PATH', 'Relay']);
    expect(checks.filter(c => !c.ok).every(c => !!c.remediation)).toBe(true);
    expect(checks[0].remediation).toContain('Node 22 or newer is required');
    expect(checks[1].remediation).toContain('Reopen your terminal');
    expect(checks.at(-1)?.remediation).toContain('run sealbridge doctor again');
  });
  it('reports HTTP failures and uses only the fixed health endpoint', async () => {
    const checks = await diagnose({ ...options(), fetch: (async (url, init) => {
      expect(url).toBe('https://relay.sealbridge.dev/health');
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeDefined();
      return new Response('', { status: 503 });
    }) as typeof fetch });
    expect(checks.at(-1)).toMatchObject({ name: 'Relay', ok: false, message: 'HTTP 503' });
  });
  it('prints short success lines including paths and only adds hints for warnings', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await doctorCommand({ ...options(), path: '/bin', exists: () => true, fetch: healthy });
    const lines = log.mock.calls.map(([line]) => line as string);
    expect(lines[0]).toBe(`Node.js: ${process.versions.node} (${process.execPath}) (OK)`);
    expect(lines[1]).toBe('PATH: sealbridge found (OK)');
    expect(lines[2]).toContain('created on first use');
    expect(lines[4]).toBe('Relay: Reachable (OK)');
    expect(process.exitCode).toBe(initialExitCode);
    await doctorCommand({ ...options(), version: '20.0.0', offline: true });
    expect(process.exitCode).toBe(1);
  });
  it('parses offline and explicit key flags, rejecting unknown or missing values', () => {
    expect(parseDoctorArgs(['--relay', 'http://127.0.0.1:8787', '--allow-private-relay'])).toEqual({ relay: 'http://127.0.0.1:8787', allowPrivateRelay: true });
    expect(parseDoctorArgs(['--offline', '--key', 'key.json'])).toEqual({ offline: true, keyFile: 'key.json' });
    for (const args of [['--key'], ['--offline', '--offline'], ['--relay']])
      expect(() => parseDoctorArgs(args)).toThrow();
  });
});
