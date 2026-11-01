// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chmodSync, closeSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync,
  realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { digest, generateKeyPair, parseAndVerifyInviteToken } from '../packages/core/src/index.js';
import { RelayAuthRecoveryExhaustedError } from '../packages/relay/src/index.js';
import type { WorkerNodeOptions } from '../packages/runtime/src/session.js';

const captured = vi.hoisted(() => ({ options: undefined as WorkerNodeOptions | undefined,
  token: '', starts: 0 }));
vi.mock('../packages/runtime/dist/index.js', async original => {
  const runtime = await original<typeof import('../packages/runtime/src/index.js')>();
  return { ...runtime, WorkerNode: class extends runtime.WorkerNode {
    constructor(options: WorkerNodeOptions) { super(options); captured.options = options; }
    override invite(ttl?: number) { return captured.token = super.invite(ttl); }
    override async start() { captured.starts++; return undefined; }
  } };
});
import { networkCommand } from '../cli/src/network.js';
import { deliverInvite, parseInviteOutput } from '../cli/src/invite-output.js';

let dir: string;
const owner = generateKeyPair();
beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'sealbridge-worker-output-'));
  writeFileSync(join(dir, 'worker.private.json'), JSON.stringify(owner), { mode: 0o600 });
  captured.options = undefined; captured.token = ''; captured.starts = 0;
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('OFFLINE_TEST'); }));
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});
function start(extra: string[] = []) {
  return networkCommand('worker', ['start', '--key', join(dir, 'worker.private.json'),
    '--relay', 'https://relay.example', '--contacts', join(dir, 'contacts.json'), ...extra], {
    identityOptions: { env: { SEALBRIDGE_DATA_DIR: join(dir, 'data') }, home: dir },
  });
}
function stdout() { return vi.mocked(console.log).mock.calls.map(args => args.join(' ') + '\n').join(''); }
function stderr() { return vi.mocked(console.error).mock.calls.map(args => args.join(' ') + '\n').join(''); }
function events() { return stderr().trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
function metadataOnly() {
  expect(stdout()).toBe('');
  expect(stderr().includes(captured.token)).toBe(false);
  expect(stderr()).not.toContain('https://sealbridge.app/i#');
  expect(stderr()).not.toContain('acp-invite:');
}

it.each([undefined, 'stdout'])('preserves both default stdout lines exactly (%j)', async route => {
  await start(route ? ['--invite-output', route] : []);
  expect(stdout() === captured.token + '\nhttps://sealbridge.app/i#' + captured.token + '\n').toBe(true);
  expect(vi.mocked(console.log).mock.calls).toHaveLength(2);
  expect(captured.starts).toBe(1);
});

it('suppresses invitation stdout and emits exact invitation metadata', async () => {
  await start(['--invite-output', 'none', '--invite-ttl', '120']);
  metadataOnly();
  const invite = parseAndVerifyInviteToken(captured.token);
  expect(events()).toEqual([{ event: 'invite_ready',
    inviteDigest: 'sha256:' + createHash('sha256').update(captured.token).digest('hex'),
    expiresAt: invite.expiresAt, workerDid: owner.did, relay: 'https://relay.example' }]);
  expect(invite.expiresAt).toBe('2026-01-01T00:02:00.000Z');
  expect(fetch).not.toHaveBeenCalled();
});

it('reuses the existing data root and role key bytes with invitation suppression', async () => {
  const args = () => ['start', '--relay', 'https://relay.example', '--contacts', join(dir, 'contacts.json'),
    '--invite-output', 'none'];
  const application = { identityOptions: { home: dir,
    env: { ACP_DATA_DIR: join(dir, 'legacy-data') }, keyStore: 'file' as const } };
  await networkCommand('worker', args(), application);
  const keyFile = join(dir, 'legacy-data', 'identities', 'worker.private.json');
  const bytes = readFileSync(keyFile);
  const workerDid = captured.options!.owner.did;
  await networkCommand('worker', args(), application);
  expect(readFileSync(keyFile).equals(bytes)).toBe(true);
  expect(captured.options!.owner.did).toBe(workerDid);
  expect(captured.starts).toBe(2);
  metadataOnly();
  expect(fetch).not.toHaveBeenCalled();
});

it('retains explicit keychain failure without creating a file identity', async () => {
  const root = join(dir, 'keychain-data');
  await expect(networkCommand('worker', ['start', '--relay', 'https://relay.example', '--invite-output', 'none'], {
    identityOptions: { home: dir, env: { SEALBRIDGE_DATA_DIR: root, SEALBRIDGE_KEY_STORE: 'keychain' },
      keyringLoader: async () => { throw new Error('backend fixture detail'); } },
  })).rejects.toThrow('KEY_STORE_UNAVAILABLE');
  expect(existsSync(root)).toBe(false);
  expect(captured.starts).toBe(0); expect(captured.options).toBeUndefined();
  expect(stdout()).toBe(''); expect(stderr()).toBe('');
});

it('writes only the token and newline to an exclusively created private file', async () => {
  const file = join(dir, 'invite.txt');
  await start(['--invite-output', 'file:' + file]);
  expect(readFileSync(file, 'utf8') === captured.token + '\n').toBe(true);
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  metadataOnly();
  await expect(start(['--invite-output', 'file:' + file])).rejects.toThrow('INVITE_OUTPUT_UNAVAILABLE');
  expect(readFileSync(file, 'utf8') === captured.token + '\n').toBe(true);
  expect(captured.starts).toBe(1);
  expect(events()).toHaveLength(1);
});

it.skipIf(process.platform === 'win32')('writes to a private descriptor without closing or changing its permissions', async () => {
  const file = join(dir, 'fd.txt'), fd = openSync(file, 'wx', 0o600);
  try {
    await start(['--invite-output', 'fd:' + fd]);
    expect(readFileSync(file, 'utf8') === captured.token + '\n').toBe(true);
    expect(fstatSync(fd).isFile()).toBe(true);
    if (process.platform !== 'win32') expect(fstatSync(fd).mode & 0o777).toBe(0o600);
    metadataOnly();
  } finally { closeSync(fd); }
});

it('rejects fd output on Windows before identity creation or worker startup', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const root = join(dir, 'unsupported-data');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    await expect(networkCommand('worker', ['start', '--invite-output', 'fd:3', '--publish'], {
      identityOptions: { home: dir, env: { SEALBRIDGE_DATA_DIR: root } },
    })).rejects.toThrow('INVITE_OUTPUT_FD_UNSUPPORTED_PLATFORM');
    // Direct callers must also get the platform error, without attempting I/O.
    expect(() => deliverInvite({ kind: 'fd', fd: 3 }, 'fixture'))
      .toThrow('INVITE_OUTPUT_FD_UNSUPPORTED_PLATFORM');
    expect(existsSync(root)).toBe(false);
    expect(captured.options).toBeUndefined(); expect(captured.starts).toBe(0);
    expect(stdout()).toBe(''); expect(stderr()).toBe('');
    expect(fetch).not.toHaveBeenCalled();
  } finally { Object.defineProperty(process, 'platform', platform); }
});

it('delivers to an inherited pipe independently of child stdout and stderr', async () => {
  await start(['--invite-output', 'none']);
  const fixture = join(dir, 'child-invite.txt');
  writeFileSync(fixture, captured.token, { mode: 0o600 });
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { deliverInvite, parseInviteOutput } from './cli/dist/invite-output.js';
    try {
      deliverInvite(parseInviteOutput('fd:3'), readFileSync(process.argv[1], 'utf8'));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  `, fixture], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000 });
  expect(child.error).toBeUndefined();
  if (process.platform === 'win32') {
    expect(child.status).toBe(1);
    expect(child.stdout).toBe('');
    expect(child.stderr).toBe('INVITE_OUTPUT_FD_UNSUPPORTED_PLATFORM\n');
    expect(child.output[3]).toBe('');
    return;
  }
  expect(child.status).toBe(0);
  expect(child.stdout).toBe(''); expect(child.stderr).toBe('');
  expect(child.output[3] === captured.token + '\n').toBe(true);
});

it.each(['', 'file:', 'file: ', 'fd:0', 'fd:1', 'fd:2', 'fd:03', 'fd:-1', 'fd:3.5',
  'fd:2147483648', 'fd:9007199254740992', 'other', true])('rejects an invalid invite route (%j)', async value => {
  await expect(start(['--invite-output', ...(typeof value === 'string' ? [value] : [])])).rejects.toThrow('INVALID_INVITE_OUTPUT');
  expect(captured.options).toBeUndefined(); expect(captured.starts).toBe(0);
  expect(stdout()).toBe(''); expect(stderr()).toBe('');
});

it('reports descriptor failure without a stdout fallback or ready event', async () => {
  await expect(start(['--invite-output', 'fd:2147483647'])).rejects.toThrow(
    process.platform === 'win32' ? 'INVITE_OUTPUT_FD_UNSUPPORTED_PLATFORM' : 'INVITE_OUTPUT_UNAVAILABLE');
  expect(captured.starts).toBe(0); expect(stdout()).toBe(''); expect(stderr()).toBe('');
});

it('requires an existing file destination directory', async () => {
  const file = join(dir, 'absent', 'invite.txt');
  await expect(start(['--invite-output', 'file:' + file])).rejects.toThrow('INVITE_OUTPUT_UNAVAILABLE');
  expect(existsSync(file)).toBe(false); expect(captured.starts).toBe(0);
  expect(stdout()).toBe(''); expect(stderr()).toBe('');
});

it.skipIf(process.platform === 'win32')('rejects linked destinations and non-private directories and descriptor files', async () => {
  const file = join(dir, 'original.txt'), link = join(dir, 'link.txt');
  writeFileSync(file, 'original', { mode: 0o600 }); symlinkSync(file, link);
  await expect(start(['--invite-output', 'file:' + link])).rejects.toThrow('INVITE_OUTPUT_UNAVAILABLE');
  expect(readFileSync(file, 'utf8')).toBe('original');
  chmodSync(file, 0o644);
  const fd = openSync(file, 'a');
  try { expect(() => deliverInvite(parseInviteOutput('fd:' + fd), 'fixture')).toThrow('INVITE_OUTPUT_UNAVAILABLE'); }
  finally { closeSync(fd); }
  chmodSync(dir, 0o755);
  await expect(start(['--invite-output', 'file:' + join(dir, 'unused.txt')])).rejects.toThrow('INVITE_OUTPUT_UNAVAILABLE');
  expect(existsSync(join(dir, 'unused.txt'))).toBe(false);
  expect(stdout()).toBe(''); expect(stderr()).toBe('');
});

it('retains event, reason and diagnostic keys while omitting extra object fields', async () => {
  await start(['--invite-output', 'none']);
  const detail = { field: 'task.scope', expected: digest('expected'), actual: digest('actual'),
    hint: 'Select an advertised skill and task type, or omit both for direct delegation.' };
  captured.options!.onEvent!('REJECTED', 'task_output', { code: 'TASK_SCOPE_REJECTED', detail,
    inviteToken: captured.token, privateKey: owner.privateKey, input: 'RAW_TASK_CONTENT',
    event: captured.token, taskId: captured.token, reasonJa: captured.token,
    authToken: 'relay-auth-fixture', jwk: { d: 'private-jwk-fixture' },
  } as Parameters<NonNullable<WorkerNodeOptions['onEvent']>>[2]);
  captured.options!.onEvent!('REJECTED', 'task_output', { code: 'PROPOSAL_REJECTED',
    reason: 'requester ' + owner.did + ' is not allowed' } as { code: string });
  expect(events()[1]).toMatchObject({ event: 'REJECTED', taskId: 'task_output', code: 'TASK_SCOPE_REJECTED', detail });
  expect(Object.keys(events()[1]).sort()).toEqual(['code', 'detail', 'event', 'taskId']);
  expect(events()[2]).toEqual({ event: 'REJECTED', taskId: 'task_output', code: 'PROPOSAL_REJECTED',
    reason: 'requester ' + owner.did + ' is not allowed' });
  metadataOnly();
  for (const value of [owner.privateKey, 'RAW_TASK_CONTENT', 'relay-auth-fixture', 'private-jwk-fixture'])
    expect(stderr().includes(value)).toBe(false);
});

it('replaces free-form event and status values while retaining diagnostic keys', async () => {
  await start(['--invite-output', 'none']);
  const values = [captured.token, 'https://sealbridge.app/i#' + captured.token,
    'Bearer relay-auth-fixture', JSON.stringify({ kty: 'OKP', d: 'private-jwk-fixture' }), 'raw task content'];
  for (const value of values) {
    captured.options!.onStatus!('unavailable', new Error(value));
    captured.options!.onEvent!('REJECTED', value, { code: value, reason: value,
      detail: { field: value, expected: value, actual: value, hint: value } } as { code: string });
  }
  metadataOnly();
  for (const value of values) expect(stderr().includes(value)).toBe(false);
  for (const event of events().filter(e => e.detail))
    expect(event.detail).toEqual({ field: '[redacted]', expected: '[redacted]', actual: '[redacted]', hint: '[redacted]' });
});

it('preserves existing status error messages and Japanese reasons', async () => {
  await start(['--invite-output', 'none']);
  captured.options!.onStatus!('connected');
  captured.options!.onStatus!('unavailable', new Error('RELAY_REJECTED: 403'));
  const error = new RelayAuthRecoveryExhaustedError('receive', 3, 1000);
  captured.options!.onStatus!('unavailable', error);
  expect(events()[1]).toEqual({ status: 'connected' });
  expect(events()[2]).toMatchObject({ status: 'unavailable', error: 'RELAY_REJECTED: 403', reasonJa: expect.any(String) });
  expect(events()[3]).toMatchObject({ status: 'unavailable', error: error.message, reasonJa: expect.any(String) });
  metadataOnly();
});
