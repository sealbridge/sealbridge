import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createInviteToken, createSignedAgentCard, generateKeyPair } from '../packages/core/src/index.js';
import { acceptCommand } from '../cli/src/accept.js';
import { formatCliError, japaneseErrorReason } from '../cli/src/error-messages.js';
// @ts-expect-error Browser JavaScript entry is shared with the static site build.
import { verifyFragment } from '../sites/browser/verify.mjs';

let home: string;
let options: { home: string; env: { SEALBRIDGE_DATA_DIR: string } };
let token: string;
let stdinPipeAvailable: boolean;
beforeAll(async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'sealbridge-stdin-probe-'));
  const path = join(directory, 'received.txt');
  const child = spawn(process.execPath, ['-e', `const fs = require('node:fs');
let received = ''; process.stdin.on('data', chunk => { received += chunk; });
process.stdin.on('end', () => fs.writeFileSync(process.argv[1], received));`, path], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  });
  const watchdog = setTimeout(() => child.kill(), 5_000);
  try {
    child.stdin!.end('stdin-probe');
    expect(await closed).toBe(0);
    const received = readFileSync(path, 'utf8');
    expect(['stdin-probe', '']).toContain(received);
    stdinPipeAvailable = received === 'stdin-probe';
  } finally { clearTimeout(watchdog); child.kill(); rmSync(directory, { recursive: true, force: true }); }
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-11-01T00:00:00.000Z');
  home = mkdtempSync(join(realpathSync(tmpdir()), 'sealbridge-accept-'));
  options = { home, env: { SEALBRIDGE_DATA_DIR: join(home, 'data') } };
  const owner = generateKeyPair();
  const card = createSignedAgentCard({ name: 'Display "$() `text`', agentDid: owner.did, relayEndpoint: 'https://relay.example', skills: [] }, owner);
  token = createInviteToken({ agentCard: card, expiresInSeconds: 60 }, owner);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });
it('imports and lists/removes locally without printing invitation material', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await acceptCommand('invites', ['list'], options);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({ invites: [] });
  expect(existsSync(join(home, 'data'))).toBe(false);
  await acceptCommand('accept', ['https://sealbridge.app/i#' + token, '--alias', 'reviewer'], options);
  const first = JSON.parse(log.mock.calls.at(-1)![0]);
  await acceptCommand('invites', ['list'], options);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({ invites: [first] });
  await acceptCommand('invites', ['remove', first.workerRef], options);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({ removed: true });
  await acceptCommand('invites', ['remove', 'reviewer'], options);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({ removed: false });
  expect(JSON.stringify(log.mock.calls)).not.toContain(token);
});
it('requires a human TTY for paste, prompts on stderr adapter, and accepts CRLF input', async () => {
  const readPaste = vi.fn(async () => token + '\r\n');
  const input = Object.assign(new PassThrough(), { isTTY: false }), output = new PassThrough();
  let prompt = ''; output.on('data', chunk => { prompt += chunk; });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await expect(acceptCommand('accept', ['--paste'], { ...options, input, output, readPaste })).rejects.toThrow('INVITE_INPUT_UNAVAILABLE');
  expect(readPaste).not.toHaveBeenCalled(); expect(prompt).toBe('');
  expect(existsSync(join(home, 'data'))).toBe(false);
  input.isTTY = true;
  await acceptCommand('accept', ['--paste', '--alias', 'reviewer'], { ...options, input, output, readPaste });
  expect(prompt).toContain('Paste the complete invitation');
  expect(JSON.parse(log.mock.calls.at(-1)![0]).alias).toBe('reviewer');
  expect(JSON.stringify(log.mock.calls)).not.toContain(token);
});
it('reads a pasted line through the terminal adapter and rejects EOF without waiting', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const input = Object.assign(new PassThrough(), { isTTY: true }), output = new PassThrough();
  const accepted = acceptCommand('accept', ['--paste'], { ...options, input, output });
  input.end(token + '\r\n'); await accepted;
  expect(JSON.parse(log.mock.calls.at(-1)![0]).workerRef).toMatch(/^saved:/);
  const empty = Object.assign(new PassThrough(), { isTTY: true });
  const rejected = acceptCommand('accept', ['--paste'], { ...options, input: empty, output });
  empty.end(); await expect(rejected).rejects.toThrow('INVITE_INPUT_UNAVAILABLE');
});
it('the CLI dispatcher returns immediately for non-TTY paste without creating an identity', async () => {
  const stderrPath = join(home, 'stderr.txt'), fd = openSync(stderrPath, 'w');
  try {
    const result = spawnSync(process.execPath, [resolve('cli/dist/index.js'), 'accept', '--paste'], {
      env: { ...process.env, SEALBRIDGE_DATA_DIR: options.env.SEALBRIDGE_DATA_DIR },
      stdio: ['ignore', 'ignore', fd], timeout: 5000,
    });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
  } finally { closeSync(fd); }
  expect(readFileSync(stderrPath, 'utf8')).toContain('INVITE_INPUT_UNAVAILABLE');
  expect(existsSync(join(home, 'data'))).toBe(false);
});
it.each([[], ['--paste', 'link'], ['--alias'], ['link', '--alias', 'a', '--alias', 'b'], ['--unknown']].map(args => ({ args })))('rejects ambiguous accept arguments $args without echoing an input', async ({ args }) => {
  await expect(acceptCommand('accept', args, options)).rejects.toThrow('Usage:');
  expect(existsSync(join(home, 'data'))).toBe(false);
});
it('reads stdin through EOF, trims CRLF and whitespace, and reuses the positional import', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const input = new PassThrough(), output = new PassThrough();
  let prompt = ''; output.on('data', chunk => { prompt += chunk; });
  const pending = acceptCommand('accept', ['--stdin', '--alias', 'reviewer'], { ...options, input, output });
  input.write(' \r\n\t https://sealbridge.app/i#' + token + ' \t\r\n');
  expect(log).not.toHaveBeenCalled();
  expect(existsSync(join(home, 'data'))).toBe(false);
  input.end('\r\n'); await pending;
  const first = JSON.parse(log.mock.calls.at(-1)![0]);
  expect(first).toMatchObject({ alias: 'reviewer', workerRef: expect.stringMatching(/^saved:/),
    agentDid: expect.stringMatching(/^did:key:/), displayName: 'Display "$() `text`',
    effectiveExpiresAt: '2026-11-01T00:01:00.000Z' });
  await acceptCommand('accept', [token, '--alias', 'reviewer'], options);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual(first);
  expect(prompt).toBe(''); expect(JSON.stringify(log.mock.calls)).not.toContain(token);
  expect(input.listenerCount('data')).toBe(0);
  expect(input.listenerCount('end')).toBe(0);
  expect(input.listenerCount('error')).toBe(0);
  expect(input.listenerCount('close')).toBe(0);
});
it.each(['', ' \t\r\n', 'link\r\nsecond', 'link\n\n second', 'link\rsecond'])('rejects empty or multiple stdin lines (%j)', async value => {
  const input = new PassThrough();
  const pending = acceptCommand('accept', ['--stdin'], { ...options, input });
  const code = value.trim() ? 'INVITE_INPUT_MULTIPLE_LINES' : 'INVITE_INPUT_EMPTY';
  input.end(value); await expect(pending).rejects.toThrow(code);
  expect(existsSync(join(home, 'data'))).toBe(false);
});
it('accepts the stdin byte boundary and counts bytes across chunks', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const input = new PassThrough();
  const pending = acceptCommand('accept', ['--stdin'], { ...options, input });
  // U+3000 is whitespace encoded as three UTF-8 bytes; split one encoding across chunks.
  const value = Buffer.from(token + '\u3000' + ' '.repeat(68 * 1024 - Buffer.byteLength(token) - 3));
  input.write(value.subarray(0, token.length + 1));
  input.end(value.subarray(token.length + 1)); await pending;
  expect(JSON.parse(log.mock.calls.at(-1)![0]).workerRef).toMatch(/^saved:/);
  const oversized = new PassThrough();
  const rejected = acceptCommand('accept', ['--stdin'], { ...options, input: oversized });
  oversized.write(token);
  oversized.write(' '.repeat(68 * 1024 - token.length - 2));
  oversized.write('\u3000');
  await expect(rejected).rejects.toThrow('INVITE_INPUT_TOO_LARGE');
  expect(oversized.isPaused()).toBe(true);
  expect(oversized.destroyed).toBe(true);
});
it('rejects an oversized first chunk before EOF without creating an identity', async () => {
  const input = Object.assign(new PassThrough(), { unref: vi.fn() });
  const pending = acceptCommand('accept', ['--stdin'], { ...options, input });
  input.write(' '.repeat(68 * 1024 + 1));
  await expect(pending).rejects.toThrow('INVITE_INPUT_TOO_LARGE');
  expect(existsSync(join(home, 'data'))).toBe(false);
  expect(input.destroyed).toBe(true);
  expect(input.unref).toHaveBeenCalledOnce();
  for (const event of ['data', 'end', 'error', 'close']) expect(input.listenerCount(event)).toBe(0);
});
it('applies a total stdin deadline even while input arrives', async () => {
  vi.useFakeTimers(); vi.setSystemTime('2026-11-01T00:00:00.000Z');
  const input = Object.assign(new PassThrough(), { unref: vi.fn() });
  const pending = acceptCommand('accept', ['--stdin'], { ...options, input });
  const rejected = expect(pending).rejects.toThrow('INVITE_INPUT_TIMEOUT');
  await vi.advanceTimersByTimeAsync(9_999);
  input.write(token);
  await vi.advanceTimersByTimeAsync(1); await rejected;
  expect(vi.getTimerCount()).toBe(0);
  expect(input.isPaused()).toBe(true);
  expect(input.listenerCount('data')).toBe(0);
  expect(existsSync(join(home, 'data'))).toBe(false);
  expect(input.destroyed).toBe(true);
  expect(input.unref).toHaveBeenCalledOnce();
  for (const event of ['end', 'error', 'close']) expect(input.listenerCount(event)).toBe(0);
});
it.each(['error', 'close', 'destroyed'] as const)('reports unavailable stdin for %s without including stream error text', async event => {
  const input = Object.assign(new PassThrough(), { unref: vi.fn() });
  if (event === 'destroyed') input.destroy();
  const pending = acceptCommand('accept', ['--stdin'], { ...options, input });
  if (event === 'error') input.emit('error', new Error(token));
  if (event === 'close') input.emit('close');
  await expect(pending).rejects.toThrow(/^INVITE_INPUT_UNAVAILABLE$/);
  expect(existsSync(join(home, 'data'))).toBe(false);
  expect(input.destroyed).toBe(true);
  if (event !== 'destroyed') expect(input.unref).toHaveBeenCalledOnce();
  for (const name of ['data', 'end', 'error', 'close']) expect(input.listenerCount(name)).toBe(0);
});
it('rejects TTY stdin immediately and directs the user to paste mode', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  await expect(acceptCommand('accept', ['--stdin'], { ...options, input })).rejects.toThrow('INVITE_STDIN_REQUIRES_PIPE: use a pipe or file with --stdin, or --paste at a terminal');
  expect(input.listenerCount('data')).toBe(0);
  expect(existsSync(join(home, 'data'))).toBe(false);
});
it.each([
  ['--stdin', '--paste'], ['--paste', '--stdin'], ['--stdin', 'link'], ['link', '--stdin'],
  ['--stdin', '--stdin'], ['--stdin', '--paste', 'link'],
].map(args => ({ args })))('rejects mixed stdin arguments $args before reading input', async ({ args }) => {
  const input = new PassThrough();
  await expect(acceptCommand('accept', args.map(arg => arg === 'link' ? token : arg), { ...options, input })).rejects.toThrow('Usage:');
  expect(input.listenerCount('data')).toBe(0);
  expect(existsSync(join(home, 'data'))).toBe(false);
});
it.each(['INVITE_STDIN_REQUIRES_PIPE', 'INVITE_INPUT_TOO_LARGE', 'INVITE_INPUT_EMPTY',
  'INVITE_INPUT_MULTIPLE_LINES', 'INVITE_INPUT_TIMEOUT'])('adds a stdin-specific Japanese explanation for %s', code => {
  expect(japaneseErrorReason(code)).toContain('ください');
  expect(formatCliError(new Error(code))).toContain(code);
});
it.for((['pipe', 'file'] as const).flatMap(source =>
  (['valid', 'empty', 'multiple', 'oversized', 'invalid', 'mixed'] as const).map(mode => ({ source, mode }))))
('the CLI reads $source stdin with $mode input without echoing the link', async ({ source, mode }, context) => {
  if (source === 'pipe' && !stdinPipeAvailable) context.skip('Child-process stdin pipes deliver EOF without data in this environment.');
  // Match the parent fixture clock in the dispatcher subprocess.
  const clock = join(home, 'clock.mjs');
  writeFileSync(clock, `const OriginalDate = Date;
globalThis.Date = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : ['2026-11-01T00:00:00.000Z'])); }
  static now() { return ${Date.now()}; }
};\n`);
  const args = [resolve('cli/dist/index.js'), 'accept', '--stdin', '--alias', 'reviewer'];
  if (mode === 'mixed') args.push('--paste');
  const stdoutPath = join(home, 'stdout.txt'), stderrPath = join(home, 'stderr.txt');
  const stdoutFd = openSync(stdoutPath, 'w'), stderrFd = openSync(stderrPath, 'w');
  const link = 'https://sealbridge.app/i#' + token;
  const value = mode === 'empty' ? '\r\n' : mode === 'multiple' ? link + '\n' + link
    : mode === 'oversized' ? link + ' '.repeat(1024 * 1024)
    : mode === 'invalid' ? link + '_invalid' : ' \r\n' + link + '\r\n';
  let inputFd: number | undefined;
  if (source === 'file') {
    const inputPath = join(home, 'invitation.txt');
    writeFileSync(inputPath, value); inputFd = openSync(inputPath, 'r');
  }
  const child = spawn(process.execPath, ['--import', pathToFileURL(clock).href, ...args], {
    env: { ...process.env, SEALBRIDGE_DATA_DIR: options.env.SEALBRIDGE_DATA_DIR },
    stdio: [inputFd ?? 'pipe', stdoutFd, stderrFd],
  });
  const stdinErrors: NodeJS.ErrnoException[] = [];
  // Early rejection may close the pipe while the parent still has buffered writes.
  child.stdin?.on('error', error => { stdinErrors.push(error); });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const watchdog = setTimeout(() => child.kill(), 15_000);
  try {
    if (source === 'pipe') {
      // Leave the producer open: overflow must fail without waiting for EOF.
      if (mode === 'oversized') child.stdin!.write(value);
      else child.stdin!.end(value);
    }
    expect(await closed).toBe(mode === 'valid' ? 0 : 1);
    // Closed pipes surface OS-level errors (including Windows EOF) or stream errors.
    for (const error of stdinErrors) expect([
      'EPIPE', 'ECONNRESET', 'EOF', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END',
    ]).toContain(error.code);
    const stdout = readFileSync(stdoutPath, 'utf8'), stderr = readFileSync(stderrPath, 'utf8');
    expect(stdout + stderr).not.toContain(token);
    if (mode === 'valid') {
      expect(stderr).toBe('');
      expect(JSON.parse(stdout)).toMatchObject({ alias: 'reviewer', workerRef: expect.stringMatching(/^saved:/),
        agentDid: expect.stringMatching(/^did:key:/), displayName: 'Display "$() `text`',
        effectiveExpiresAt: '2026-11-01T00:01:00.000Z' });
    } else {
      expect(stdout).toBe('');
      expect(stderr).toContain({ empty: 'INVITE_INPUT_EMPTY', multiple: 'INVITE_INPUT_MULTIPLE_LINES',
        oversized: 'INVITE_INPUT_TOO_LARGE', invalid: 'INVALID_OR_EXPIRED_INVITE', mixed: 'Usage:' }[mode]);
      if (mode !== 'invalid') expect(existsSync(join(home, 'data'))).toBe(false);
    }
  } finally {
    clearTimeout(watchdog); child.stdin?.destroy(); child.kill();
    closeSync(stdoutFd); closeSync(stderrFd);
    if (inputFd !== undefined) closeSync(inputFd);
  }
});
it('generates a quoted accept command only after fragment verification, with no required key path', () => {
  const result = verifyFragment('#' + token);
  expect(result.command).toBe(`sealbridge accept "https://sealbridge.app/i#${token}"`);
  expect(result.command).not.toMatch(/keygen|--key|delegate|\$\(|`text`/);
  for (const hash of ['', '#', '#bad', '#acp-invite:____', '#acp-invite:a%20b'])
    expect(() => verifyFragment(hash)).toThrow();
  expect(() => verifyFragment('#' + token, Date.now() + 60000)).toThrow('INVITE_EXPIRED');
});
