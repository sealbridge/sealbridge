import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPair } from '../packages/core/src/index.js';
import { AcpMcpServer } from '../packages/runtime/src/mcp-server.js';
import { inspectLocalIdentity, resolveDataRoot, resolveOrCreateIdentity } from '../packages/runtime/src/local-identity.js';
import type { LocalIdentityOptions } from '../packages/runtime/src/local-identity.js';
import { parseMcpServerArgs, mcpServerOptionsFromArgs } from '../cli/src/mcp.js';

const roots: string[] = [];
function fixture(): LocalIdentityOptions {
  const home = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'sealbridge-identity-'));
  roots.push(home);
  return { home, env: { SEALBRIDGE_DATA_DIR: join(home, 'data') } };
}
function put(path: string, content = JSON.stringify(generateKeyPair())) {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path, content, { mode: 0o600 });
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('application identity paths', () => {
  it.each([
    ['linux', '/home/名前 A', {}, '/home/名前 A/.local/share/sealbridge'],
    ['linux', '/home/a', { XDG_DATA_HOME: '/data space' }, '/data space/sealbridge'],
    ['darwin', '/Users/名前 A', {}, '/Users/名前 A/Library/Application Support/Sealbridge'],
    ['win32', 'C:\\Users\\名前 A', {}, 'C:\\Users\\名前 A\\AppData\\Local\\Sealbridge'],
    ['win32', 'C:\\Users\\a', { LOCALAPPDATA: 'D:\\Local A' }, 'D:\\Local A\\Sealbridge'],
  ] as const)('%s defaults', (platform, home, env, expected) => {
    expect(resolveDataRoot({ platform, home, env })).toBe(expected);
  });
  it.each(['linux', 'darwin', 'win32'] as const)('honors explicit overrides on %s', platform => {
    const a = platform === 'win32' ? 'C:\\chosen' : '/chosen';
    const b = platform === 'win32' ? 'D:\\old' : '/old';
    expect(resolveDataRoot({ platform, home: '', env: { SEALBRIDGE_DATA_DIR: a, ACP_DATA_DIR: b } })).toBe(a);
    expect(resolveDataRoot({ platform, home: '', env: { ACP_DATA_DIR: b } })).toBe(b);
    for (const env of [{ SEALBRIDGE_DATA_DIR: 'relative' }, { ACP_DATA_DIR: '' }])
      expect(() => resolveDataRoot({ platform, env, home: '' })).toThrow('DATA_DIR_UNAVAILABLE');
    expect(() => resolveDataRoot({ platform, env: {}, home: '' })).toThrow('DATA_DIR_UNAVAILABLE');
  });
});

describe('persistent role identities', () => {
  it('creates once, reuses across instances, and keeps roles distinct', () => {
    const options = fixture();
    const requester = resolveOrCreateIdentity('requester', options);
    expect(resolveOrCreateIdentity('requester', { ...options })).toEqual(requester);
    expect(resolveOrCreateIdentity('worker', options).did).not.toBe(requester.did);
    const selected = inspectLocalIdentity('requester', options);
    expect(selected.source).toBe('default');
    expect(selected.key).toEqual(requester);
    if (process.platform !== 'win32') {
      expect(fs.statSync(selected.path).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dirname(selected.path)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(resolveDataRoot(options)).mode & 0o777).toBe(0o700);
    }
  });
  it('publishes exactly one winner from concurrent processes', async () => {
    const options = fixture();
    const moduleUrl = pathToFileURL(resolve('packages/runtime/dist/local-identity.js')).href;
    const outputs = Array.from({ length: 4 }, (_, i) => join(options.home!, `result-${i}.txt`));
    await Promise.all(outputs.map(output => {
      const script = `import {resolveOrCreateIdentity} from ${JSON.stringify(moduleUrl)}; import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(output)}, resolveOrCreateIdentity('requester', ${JSON.stringify(options)}).did);`;
      return promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd() });
    }));
    const results = outputs.map(path => fs.readFileSync(path, 'utf8'));
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe(resolveOrCreateIdentity('requester', options).did);
    expect(fs.readdirSync(join(resolveDataRoot(options), 'identities'))).toEqual(['requester.private.json']);
  });
  it.each(['write', 'flush', 'publish'] as const)('cleans partial temporary files after a %s failure', stage => {
    const options = fixture();
    const io = { ...fs };
    if (stage === 'write') io.writeSync = (() => { throw new Error('injected'); }) as typeof fs.writeSync;
    if (stage === 'flush') io.fsyncSync = () => { throw new Error('injected'); };
    if (stage === 'publish') io.linkSync = () => { throw Object.assign(new Error('injected'), { code: 'ENOTSUP' }); };
    expect(() => resolveOrCreateIdentity('requester', { ...options, fs: io })).toThrow(
      stage === 'publish' ? 'IDENTITY_CREATION_UNSUPPORTED' : 'IDENTITY_STORE_UNWRITABLE');
    expect(fs.readdirSync(join(resolveDataRoot(options), 'identities'))).toEqual([]);
    expect(resolveOrCreateIdentity('requester', options).did).toMatch(/^did:key:/);
  });
  it('handles short writes and ignores an abandoned temporary name', () => {
    const options = fixture();
    const path = inspectLocalIdentity('worker', options).path;
    put(join(dirname(path), '.worker.abandoned.tmp'), '{');
    const io = { ...fs, writeSync: ((fd: number, bytes: Buffer, offset: number, length: number) =>
      fs.writeSync(fd, bytes, offset, Math.min(length, 7))) as typeof fs.writeSync };
    expect(resolveOrCreateIdentity('worker', { ...options, fs: io })).toEqual(inspectLocalIdentity('worker', options).key);
    expect(fs.readFileSync(join(dirname(path), '.worker.abandoned.tmp'), 'utf8')).toBe('{');
  });
  it('loads the committed winner when publication loses a race', () => {
    const options = fixture();
    const winner = generateKeyPair();
    const io = { ...fs, linkSync: (_from: fs.PathLike, to: fs.PathLike) => {
      fs.writeFileSync(to, JSON.stringify(winner), { flag: 'wx', mode: 0o600 });
      throw Object.assign(new Error(), { code: 'EEXIST' });
    } };
    expect(resolveOrCreateIdentity('worker', { ...options, fs: io })).toEqual(winner);
  });
  it.each(['{', '{}', 'x'.repeat(16385)])('never replaces invalid existing content', content => {
    const options = fixture();
    const path = inspectLocalIdentity('requester', options).path;
    put(path, content);
    expect(() => resolveOrCreateIdentity('requester', options)).toThrow('IDENTITY_INVALID');
    expect(fs.readFileSync(path, 'utf8')).toBe(content);
  });
  it('rejects a mismatched key/DID and redacts errors', () => {
    const options = fixture();
    const key = { ...generateKeyPair(), did: generateKeyPair().did };
    const path = inspectLocalIdentity('worker', options).path;
    put(path, JSON.stringify(key));
    let message = '';
    try { resolveOrCreateIdentity('worker', options); } catch (e) { message = (e as Error).message; }
    expect(message).toBe('IDENTITY_INVALID');
    expect(message).not.toContain(key.privateKey);
    expect(message).not.toContain('BEGIN PRIVATE');
  });
  it('rejects directories and links, including linked parents', () => {
    const options = fixture();
    const path = inspectLocalIdentity('worker', options).path;
    fs.mkdirSync(path, { recursive: true, mode: 0o700 });
    expect(() => resolveOrCreateIdentity('worker', options)).toThrow('IDENTITY_INVALID');
    fs.rmSync(path, { recursive: true });
    const target = join(options.home!, 'target');
    fs.mkdirSync(target, { mode: 0o700 });
    // Directory junctions are available to unprivileged Windows CI users.
    fs.symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => resolveOrCreateIdentity('worker', options)).toThrow('IDENTITY_INVALID');
    fs.unlinkSync(path);
    fs.rmSync(dirname(path), { recursive: true });
    fs.symlinkSync(target, dirname(path), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => resolveOrCreateIdentity('worker', options)).toThrow('IDENTITY_INVALID');
  });
  it.each(['/var', '/tmp'])('accepts the Darwin system alias %s for an explicit key', alias => {
    const options = fixture();
    const actual = join(options.home!, 'owner identity.private.json');
    put(actual);
    const virtual = alias + '/folders/test/owner identity.private.json';
    const directory = fs.lstatSync(options.home!);
    const makeFs = (uid = 0, target = '/private' + alias) => ({ ...fs,
      lstatSync: ((path: fs.PathLike) => String(path) === alias
        ? { ...directory, uid, isSymbolicLink: () => true }
        : String(path) === virtual ? fs.lstatSync(actual) : directory) as typeof fs.lstatSync,
      readlinkSync: (() => target) as unknown as typeof fs.readlinkSync,
      openSync: (() => fs.openSync(actual, 'r')) as typeof fs.openSync,
    });
    const selected = { ...options, platform: 'darwin' as const, explicitKeyPath: virtual };
    const expectedDid = resolveOrCreateIdentity('requester', { ...options, explicitKeyPath: actual }).did;
    for (const target of ['/private' + alias, 'private' + alias])
      expect(resolveOrCreateIdentity('requester', { ...selected, fs: makeFs(0, target) }).did).toBe(expectedDid);
    expect(inspectLocalIdentity('requester', { ...selected, fs: makeFs() }).path).toBe(virtual);
    for (const io of [makeFs(123), makeFs(0, '/elsewhere')])
      expect(() => resolveOrCreateIdentity('requester', { ...selected, fs: io })).toThrow('IDENTITY_INVALID');
    expect(() => resolveOrCreateIdentity('requester', { ...selected, platform: 'linux', fs: makeFs() })).toThrow('IDENTITY_INVALID');
    const linkedKey = { ...makeFs(), lstatSync: ((path: fs.PathLike) => String(path) === virtual
      ? { ...directory, uid: 0, isSymbolicLink: () => true } : makeFs().lstatSync(path)) as typeof fs.lstatSync };
    expect(() => resolveOrCreateIdentity('requester', { ...selected, fs: linkedKey })).toThrow('IDENTITY_INVALID');
  });
  it('reports denied reads/writes without transient fallback', () => {
    const options = fixture();
    const deny = () => { throw Object.assign(new Error('private detail'), { code: 'EACCES' }); };
    expect(() => resolveOrCreateIdentity('worker', { ...options, fs: { ...fs, lstatSync: deny } })).toThrow('IDENTITY_UNREADABLE');
    expect(() => resolveOrCreateIdentity('worker', { ...options, fs: { ...fs, mkdirSync: deny } })).toThrow('IDENTITY_STORE_UNWRITABLE');
    expect(fs.existsSync(resolveDataRoot(options))).toBe(false);
  });
  it('checks POSIX ownership/modes without changing an explicit file', () => {
    const options = fixture();
    const path = join(options.home!, 'chosen.json');
    put(path, JSON.stringify(generateKeyPair(), null, 2).replace(/\n/g, '\r\n') + '\r\n');
    if (process.platform !== 'win32') {
      fs.chmodSync(path, 0o644);
      expect(() => resolveOrCreateIdentity('requester', { ...options, explicitKeyPath: path })).toThrow('IDENTITY_INVALID');
      expect(fs.statSync(path).mode & 0o777).toBe(0o644);
      fs.chmodSync(path, 0o600);
      const actual = fs.statSync(path);
      const io = { ...fs, fstatSync: (() => ({ ...actual, uid: actual.uid + 1,
        isFile: () => true })) as unknown as typeof fs.fstatSync };
      expect(() => resolveOrCreateIdentity('requester', { ...options, explicitKeyPath: path, fs: io })).toThrow('IDENTITY_INVALID');
    }
    expect(resolveOrCreateIdentity('requester', { ...options, explicitKeyPath: path })).toBeDefined();
    expect(() => resolveOrCreateIdentity('requester', { ...options, explicitKeyPath: path + '.missing' })).toThrow('IDENTITY_UNREADABLE');
    expect(fs.existsSync(path + '.missing')).toBe(false);
  });
  it('reuses matching legacy roles in place, detects conflicts, and prefers canonical keys', () => {
    const options = fixture();
    const worker = join(options.home!, '.acp', 'worker.private.json');
    put(worker);
    expect(inspectLocalIdentity('worker', options).path).toBe(worker);
    expect(inspectLocalIdentity('requester', options).key).toBeUndefined();
    const canonical = resolveOrCreateIdentity('requester', options);
    const path = inspectLocalIdentity('requester', options).path;
    fs.unlinkSync(path);
    const legacy = join(options.home!, '.acp', 'requester.private.json');
    const oldOwner = process.platform === 'win32' ? join(options.home!, 'AgentCollaborationPlatform', 'owner.private.json')
      : process.platform === 'darwin' ? join(options.home!, 'Library', 'Application Support', 'AgentCollaborationPlatform', 'owner.private.json')
      : join(options.home!, '.local', 'share', 'agent-collab-platform', 'owner.private.json');
    const withOldRoot = { ...options, env: { ...options.env, ACP_DATA_DIR: join(options.home!, 'old') } };
    const oldOverride = join(options.home!, 'old', 'owner.private.json');
    put(legacy, JSON.stringify(canonical));
    put(oldOwner, JSON.stringify(canonical));
    put(oldOverride, JSON.stringify(canonical));
    expect(resolveOrCreateIdentity('requester', options)).toEqual(canonical);
    expect(inspectLocalIdentity('requester', withOldRoot).path).toBe(legacy);
    put(oldOverride);
    expect(() => resolveOrCreateIdentity('requester', withOldRoot)).toThrow('IDENTITY_SELECTION_REQUIRED');
    put(path, JSON.stringify(canonical));
    expect(resolveOrCreateIdentity('requester', withOldRoot)).toEqual(canonical);
    expect(inspectLocalIdentity('requester', withOldRoot).source).toBe('default');
  });
  it('keeps keygen exclusive and an explicit missing MCP key an error', async () => {
    const options = fixture();
    const path = join(options.home!, 'explicit.private.json');
    const cli = resolve('cli/dist/index.js');
    const run = promisify(execFile);
    await run(process.execPath, [cli, 'keygen', path]);
    const original = fs.readFileSync(path, 'utf8');
    await expect(run(process.execPath, [cli, 'keygen', path])).rejects.toMatchObject({ code: 1 });
    expect(fs.readFileSync(path, 'utf8')).toBe(original);
    await expect(run(process.execPath, [cli, 'mcp-server', '--key', path + '.missing'])).rejects.toMatchObject({ code: 1 });
    expect(fs.existsSync(path + '.missing')).toBe(false);
    expect(fs.existsSync(resolveDataRoot(options))).toBe(false);
  });
  it('keeps MCP scanning and discovery independent of identity storage', async () => {
    const options = fixture();
    const deny = ((path: fs.PathLike) => {
      if (String(path).includes('identities')) throw new Error('identity accessed');
      return fs.lstatSync(path);
    }) as typeof fs.lstatSync;
    const mapped = mcpServerOptionsFromArgs(parseMcpServerArgs([]));
    const transportFactory = vi.fn(() => ({ discover: async () => [] } as never));
    const server = new AcpMcpServer({ ...mapped, identityOptions: { ...options, fs: { ...fs, lstatSync: deny } }, transportFactory });
    for (const method of ['initialize', 'tools/list', 'ping'])
      expect(await server.handle({ jsonrpc: '2.0', id: 1, method })).not.toHaveProperty('error');
    const response = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'acp_discover_workers', arguments: {} } });
    expect(JSON.stringify(response)).toContain('"count":0');
    expect(fs.existsSync(resolveDataRoot(options))).toBe(false);
    const failed = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'acp_create_invite', arguments: {} } });
    expect(JSON.stringify(failed)).toContain('IDENTITY_UNREADABLE');
    expect(transportFactory).toHaveBeenCalledTimes(1);
  });
});
