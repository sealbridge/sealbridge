import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApplicationConfig, readApplicationConfig, validateApplicationConfig } from '../packages/runtime/src/application-config.js';
import type { ApplicationConfigOptions } from '../packages/runtime/src/application-config.js';
import { resolveDataRoot } from '../packages/runtime/src/local-identity.js';
import { DEFAULT_PUBLIC_RELAY, selectApplicationRelay } from '../packages/runtime/src/relay-selection.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';

const roots: string[] = [];
function fixture(): ApplicationConfigOptions {
  const home = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'sealbridge-config-'));
  roots.push(home);
  return { home, env: { SEALBRIDGE_DATA_DIR: join(home, 'data') } };
}
function put(options: ApplicationConfigOptions, raw: string) {
  fs.mkdirSync(resolveDataRoot(options), { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(resolveDataRoot(options), 'config.json'), raw, { mode: 0o600 });
}
const first = 'https://one.example/relay';
const second = 'https://two.example';
const config = { version: 1, relays: [first, second] };
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('application config validation', () => {
  it('accepts scalar and list forms, normalizes and deduplicates in order, and retains future fields', () => {
    expect(validateApplicationConfig({ version: 1, relay: first + '/' })).toEqual({ version: 1, relays: [first] });
    expect(validateApplicationConfig({ version: 1, relay: first, relays: [first + '/'] })).toEqual({ version: 1, relays: [first] });
    expect(validateApplicationConfig({ version: 1, relays: [first + '///', second, first], setup: { host: 'example' } }))
      .toEqual({ ...config, setup: { host: 'example' } });
    expect(validateApplicationConfig({ version: 1, relays: ['HTTPS://ONE.EXAMPLE:443/relay/', second] })).toEqual(config);
  });
  it.each([
    null, [], 'value', {}, { version: 1 }, { version: 1, relays: [] }, { version: 1, relays: first },
    { version: 1, relay: 1 }, { version: 1, relays: [first, null] }, { version: 1, relays: [''] },
    { version: 1, relays: [first, 'not a URL'] }, { version: 1, relays: Array(9).fill(first) },
    ...['https://user:pass@one.example', first + '?x=1', first + '#fragment', first + '?', first + '#']
      .map(url => ({ version: 1, relays: [first, url] })),
  ])('rejects malformed config %#', value => {
    expect(() => validateApplicationConfig(value)).toThrow(value && typeof value === 'object' && !Array.isArray(value) && !('version' in value)
      ? 'APP_CONFIG_UNSUPPORTED_VERSION' : 'APP_CONFIG_INVALID');
  });
  it.each([undefined, 0, 2, '1'])('rejects unsupported version %s', version => {
    expect(() => validateApplicationConfig({ version, relays: [first] })).toThrow('APP_CONFIG_UNSUPPORTED_VERSION');
  });
  it.each([{ relays: [second] }, { relays: [first, second] }])('rejects contradictory scalar/list forms %j', ({ relays }) => {
    expect(() => validateApplicationConfig({ version: 1, relay: first, relays })).toThrow('APP_CONFIG_CONFLICT');
  });
  it('bounds entries before deduplication and counts URL bytes', () => {
    expect(validateApplicationConfig({ version: 1, relays: Array(8).fill(first) }).relays).toEqual([first]);
    const exact = 'https://one.example/' + 'x'.repeat(2048 - 'https://one.example/'.length);
    expect(validateApplicationConfig({ version: 1, relays: [exact] }).relays).toEqual([exact]);
    for (const url of [exact + 'x', 'https://one.example/' + 'あ'.repeat(677), 'https://one.example/' + 'あ'.repeat(300)])
      expect(() => validateApplicationConfig({ version: 1, relays: [url] })).toThrow('APP_CONFIG_INVALID');
  });
  it('validates every endpoint using the existing policy without fetch or DNS', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('network accessed'); });
    for (const url of ['ftp://one.example', 'http://127.0.0.1:8787', 'http://169.254.169.254', 'http://0.0.0.0'])
      expect(() => validateApplicationConfig({ version: 1, relays: [first, url] })).toThrow('SSRF_BLOCKED_RELAY_URL');
    expect(validateApplicationConfig({ version: 1, relays: ['http://127.0.0.1:8787'] }, { allowPrivateRelay: true }).relays)
      .toEqual(['http://127.0.0.1:8787']);
    expect(() => validateApplicationConfig({ version: 1, relays: [first, 'http://169.254.169.254'] }, { allowPrivateRelay: true }))
      .toThrow('SSRF_BLOCKED_RELAY_URL');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('application config storage', () => {
  it('returns a fresh default without creating a data root or identity', () => {
    const options = fixture();
    expect(readApplicationConfig(options)).toEqual({ version: 1, relays: [DEFAULT_PUBLIC_RELAY] });
    expect(fs.existsSync(resolveDataRoot(options))).toBe(false);
  });
  it.each([
    ['win32', 'C:\\data space', 'C:\\data space\\config.json'],
    ['darwin', '/data space', '/data space/config.json'],
    ['linux', '/data space', '/data space/config.json'],
  ] as const)('uses platform paths with injected I/O on %s', (platform, root, path) => {
    const missing = vi.fn(() => { throw Object.assign(new Error(), { code: 'ENOENT' }); });
    expect(readApplicationConfig({ platform, home: '', env: { SEALBRIDGE_DATA_DIR: root }, fs: { ...fs, lstatSync: missing } }))
      .toEqual({ version: 1, relays: [DEFAULT_PUBLIC_RELAY] });
    expect(missing).toHaveBeenCalledWith(path);
  });
  it.each(['scalar', 'list'])('reads %s config with CRLF without rewriting bytes', form => {
    const options = fixture();
    const raw = JSON.stringify(form === 'scalar' ? { version: 1, relay: first + '/' } : config, null, 2).replace(/\n/g, '\r\n') + '\r\n';
    put(options, raw);
    expect(readApplicationConfig(options).relays).toEqual(form === 'scalar' ? [first] : [first, second]);
    expect(fs.readFileSync(join(resolveDataRoot(options), 'config.json'), 'utf8')).toBe(raw);
    expect(fs.readdirSync(resolveDataRoot(options))).toEqual(['config.json']);
  });
  it('creates once with future fields and preserves an existing file on a second attempt', () => {
    const options = fixture();
    const expected = { ...config, setup: { hosts: ['editor'] } };
    expect(createApplicationConfig(expected, options)).toEqual(expected);
    expect(readApplicationConfig(options)).toEqual(expected);
    expect(() => createApplicationConfig({ version: 1, relays: [second] }, options)).toThrow('APP_CONFIG_BUSY');
    expect(readApplicationConfig(options)).toEqual(expected);
    expect(fs.readdirSync(resolveDataRoot(options))).toEqual(['config.json']);
    if (process.platform !== 'win32') {
      expect(fs.statSync(resolveDataRoot(options)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(join(resolveDataRoot(options), 'config.json')).mode & 0o777).toBe(0o600);
    }
  });
  it('publishes one complete winner from concurrent initial creators', async () => {
    const options = fixture();
    const moduleUrl = pathToFileURL(resolve('packages/runtime/dist/application-config.js')).href;
    const outputs = Array.from({ length: 4 }, (_, index) => join(options.home!, `result-${index}.txt`));
    await Promise.all(outputs.map((output, index) => {
      const script = `import {createApplicationConfig} from ${JSON.stringify(moduleUrl)}; import {writeFileSync} from 'node:fs';
        try { createApplicationConfig({version:1,relays:['https://relay-${index}.example']}, ${JSON.stringify(options)}); writeFileSync(${JSON.stringify(output)}, 'CREATED'); }
        catch (error) { if(error.message !== 'APP_CONFIG_BUSY') throw error; writeFileSync(${JSON.stringify(output)}, error.message); }`;
      return promisify(execFile)(process.execPath, ['--input-type=module', '-e', script]);
    }));
    const results = outputs.map(output => fs.readFileSync(output, 'utf8'));
    expect(results.filter(result => result === 'CREATED')).toHaveLength(1);
    expect(results.filter(result => result === 'APP_CONFIG_BUSY')).toHaveLength(3);
    expect(readApplicationConfig(options).relays[0]).toMatch(/^https:\/\/relay-[0-3]\.example$/);
    expect(fs.readdirSync(resolveDataRoot(options))).toEqual(['config.json']);
  });
  it.each(['{', '{}', 'x'.repeat(65537)])('rejects invalid file content %# without mutation', raw => {
    const options = fixture();
    put(options, raw);
    expect(() => readApplicationConfig(options)).toThrow(raw === '{}' ? 'APP_CONFIG_UNSUPPORTED_VERSION' : 'APP_CONFIG_INVALID');
    expect(fs.readFileSync(join(resolveDataRoot(options), 'config.json'), 'utf8')).toBe(raw);
  });
  it('rejects unreadable files, directories, and linked parents', () => {
    const options = fixture();
    const denied = () => { throw Object.assign(new Error('detail'), { code: 'EACCES' }); };
    expect(() => readApplicationConfig({ ...options, fs: { ...fs, lstatSync: denied } })).toThrow('APP_CONFIG_UNREADABLE');
    const path = join(resolveDataRoot(options), 'config.json');
    fs.mkdirSync(path, { recursive: true, mode: 0o700 });
    expect(() => readApplicationConfig(options)).toThrow('APP_CONFIG_INVALID');
    fs.rmSync(resolveDataRoot(options), { recursive: true });
    const target = join(options.home!, 'target');
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, resolveDataRoot(options), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => readApplicationConfig(options)).toThrow('APP_CONFIG_INVALID');
    expect(() => createApplicationConfig(config, options)).toThrow('APP_CONFIG_UNWRITABLE');
  });
  it('checks POSIX modes without modifying the file', () => {
    const options = fixture();
    put(options, JSON.stringify(config));
    if (process.platform === 'win32') return;
    const path = join(resolveDataRoot(options), 'config.json');
    fs.chmodSync(path, 0o644);
    expect(() => readApplicationConfig(options)).toThrow('APP_CONFIG_INVALID');
    expect(fs.statSync(path).mode & 0o777).toBe(0o644);
  });
  it.each([0, 2 ** 60])('rejects a file that disappears or changes between inspection and opening (ino %s)', ino => {
    const options = fixture();
    put(options, JSON.stringify(config));
    const io = { ...fs, openSync: ((path, ...args) => {
      if (String(path).endsWith('config.json')) throw Object.assign(new Error(), { code: 'ENOENT' });
      return fs.openSync(path, ...args);
    }) as typeof fs.openSync };
    expect(() => readApplicationConfig({ ...options, fs: io })).toThrow('APP_CONFIG_UNREADABLE');
    const changed = { ...fs, lstatSync: ((path: fs.PathLike) => {
      const stat = fs.lstatSync(path);
      if (stat.isFile()) stat.ino = ino;
      return stat;
    }) as typeof fs.lstatSync, fstatSync: ((fd: number) => {
      const stat = fs.fstatSync(fd);
      // Incrementing large Windows file IDs can round back to the same number.
      if (stat.isFile()) stat.ino = ino === 0 ? 1 : 0;
      return stat;
    }) as typeof fs.fstatSync };
    expect(() => readApplicationConfig({ ...options, fs: changed })).toThrow('APP_CONFIG_INVALID');
  });
  it.each(['open', 'write', 'flush', 'publish'])('cleans temporary files on %s failure', stage => {
    const options = fixture();
    const io = { ...fs };
    const denied = () => { throw Object.assign(new Error('detail'), { code: 'EACCES' }); };
    if (stage === 'open') io.openSync = ((path, ...args) => String(path).endsWith('.tmp') ? denied() : fs.openSync(path, ...args)) as typeof fs.openSync;
    if (stage === 'write') io.writeSync = denied;
    if (stage === 'flush') io.fsyncSync = denied;
    if (stage === 'publish') io.linkSync = denied;
    expect(() => createApplicationConfig(config, { ...options, fs: io })).toThrow('APP_CONFIG_UNWRITABLE');
    expect(fs.readdirSync(resolveDataRoot(options))).toEqual([]);
  });
  it('handles short reads and writes', () => {
    const options = fixture();
    const io = { ...fs,
      writeSync: ((fd: number, bytes: Buffer, offset: number, length: number) => fs.writeSync(fd, bytes, offset, Math.min(7, length))) as typeof fs.writeSync,
      readSync: ((fd: number, bytes: Buffer, offset: number, length: number, position: null) => fs.readSync(fd, bytes, offset, Math.min(7, length), position)) as typeof fs.readSync,
    };
    createApplicationConfig(config, { ...options, fs: io });
    expect(readApplicationConfig({ ...options, fs: io })).toEqual(config);
  });
});

describe('fallback candidate selection', () => {
  it('preserves precedence with fallback candidates at each level', () => {
    const fallbackCandidates = [first, second];
    expect(selectApplicationRelay({ fallbackCandidates })).toEqual({ relay: first, source: 'local-default' });
    expect(selectApplicationRelay({ fallbackCandidates: [] })).toEqual({ relay: DEFAULT_PUBLIC_RELAY, source: 'default' });
    expect(selectApplicationRelay({ fallbackCandidates, inviteRelay: 'https://invite.example' })).toEqual({ relay: 'https://invite.example', source: 'invite' });
    expect(selectApplicationRelay({ fallbackCandidates, configured: second })).toEqual({ relay: second, source: 'configured' });
    expect(selectApplicationRelay({ fallbackCandidates, explicit: second })).toEqual({ relay: second, source: 'explicit' });
    const transport = new InMemoryRelay();
    expect(selectApplicationRelay({ fallbackCandidates, configured: transport, inviteRelay: second })).toEqual({ relay: transport, source: 'transport' });
    expect(selectApplicationRelay({ fallbackCandidates, configured: first, explicit: second, inviteRelay: first, allowAnyRelay: true }))
      .toEqual({ relay: second, source: 'explicit' });
    expect(() => selectApplicationRelay({ fallbackCandidates, configured: first, inviteRelay: second })).toThrow('CONFLICTING_RELAY');
    expect(() => selectApplicationRelay({ fallbackCandidates, explicit: first, inviteRelay: second })).toThrow('CONFLICTING_RELAY');
    expect(() => selectApplicationRelay({ fallbackCandidates, configured: transport, explicit: second })).toThrow('CONFLICTING_RELAY');
  });
  it('checks the selected route against policy without authorizing other candidates', () => {
    expect(selectApplicationRelay({ fallbackCandidates: [first, second], allowedRelayUrls: [first] }).relay).toBe(first);
    expect(() => selectApplicationRelay({ fallbackCandidates: [first, second], allowedRelayUrls: [second] })).toThrow('CONFLICTING_RELAY');
    expect(() => selectApplicationRelay({ fallbackCandidates: [first], allowedRelayUrls: [], allowAnyRelay: true })).toThrow('CONFLICTING_RELAY');
    expect(selectApplicationRelay({ fallbackCandidates: [first], inviteRelay: second, allowedRelayUrls: [second] }).relay).toBe(second);
    expect(() => selectApplicationRelay({ fallbackCandidates: ['http://127.0.0.1:8787'] })).toThrow('SSRF_BLOCKED_RELAY_URL');
    expect(selectApplicationRelay({ fallbackCandidates: ['http://127.0.0.1:8787'], allowPrivateRelay: true }).relay).toBe('http://127.0.0.1:8787');
  });
});
