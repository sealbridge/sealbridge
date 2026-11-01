import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { createInviteToken, createSignedAgentCard, generateKeyPair } from '../packages/core/src/index.js';
import { acceptCommand } from '../cli/src/accept.js';
// @ts-expect-error Browser JavaScript entry is shared with the static site build.
import { verifyFragment } from '../sites/browser/verify.mjs';

let home: string;
let options: { home: string; env: { SEALBRIDGE_DATA_DIR: string } };
let token: string;
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
it('generates a quoted accept command only after fragment verification, with no required key path', () => {
  const result = verifyFragment('#' + token);
  expect(result.command).toBe(`sealbridge accept "https://sealbridge.app/i#${token}"`);
  expect(result.command).not.toMatch(/keygen|--key|delegate|\$\(|`text`/);
  for (const hash of ['', '#', '#bad', '#acp-invite:____', '#acp-invite:a%20b'])
    expect(() => verifyFragment(hash)).toThrow();
  expect(() => verifyFragment('#' + token, Date.now() + 60000)).toThrow('INVITE_EXPIRED');
});
