// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInviteToken, createSignedAgentCard, generateKeyPair } from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import type { DelegateOptions } from '../packages/runtime/src/index.js';

const captured = vi.hoisted(() => ({ delegate: vi.fn() }));
vi.mock('../packages/runtime/dist/index.js', async original => {
  const runtime = await original<typeof import('../packages/runtime/src/index.js')>();
  return { ...runtime, RequesterClient: class {
    async startDelivery() {}
    stopDelivery() {}
    async delegate(options: DelegateOptions) {
      captured.delegate(options);
      return { taskId: 'task_usage', state: 'SETTLED', deliverable: {} };
    }
  } };
});
import { networkCommand } from '../cli/src/network.js';

let dir: string, key: string;
const relayUrl = 'https://relay.example';
const transportFactory = vi.fn((_url: string) => new InMemoryRelay());
beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'sealbridge-delegate-usage-'));
  key = join(dir, 'requester.private.json');
  writeFileSync(key, JSON.stringify(generateKeyPair()), { mode: 0o600 });
  captured.delegate.mockClear();
  transportFactory.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
const taskArgs = () => ['--key', key, '--title', 'Echo', '--description', 'Echo JSON', '--input', '{}'];
function target(form: string): string {
  const owner = generateKeyPair();
  if (form === 'did') return owner.did;
  const agentCard = createSignedAgentCard({ name: 'Echo', agentDid: owner.did,
    relayEndpoint: relayUrl, skills: [] }, owner);
  const token = createInviteToken({ agentCard }, owner);
  return form === 'link' ? 'https://sealbridge.app/i#' + token : token;
}

it('prints the same delegate synopsis for --help and an empty invocation', async () => {
  await networkCommand('delegate', ['--help']);
  const help = String(vi.mocked(console.log).mock.calls[0][0]);
  const usage = help.split('\n')[0];
  expect(usage).toMatch(/^Usage: sealbridge delegate /);
  expect(usage).toContain('--to <invite|link|did> | --invite <invite|link|did>');
  expect(usage).toContain('--discover <skill> | --task-type <type>');
  expect(usage).toContain('--title <text> --description <text>');
  expect(usage).toContain('(--input <json> | --input-file <path>)');
  expect(usage).not.toMatch(/\[--(?:title|description|input)\b/);
  for (const flag of ['--payload', '--manifest', '--requester-owner-did', '--correlation-id', '--timeout-ms'])
    expect(help).not.toContain(flag);
  await expect(networkCommand('delegate', [])).rejects.toThrow(usage);
  expect(captured.delegate).not.toHaveBeenCalled();
});

it.each(['token', 'link', 'did'])('accepts --invite as a --to alias for a %s with identical routing', async form => {
  const to = target(form);
  const args = [...taskArgs(), '--relay', relayUrl];
  await networkCommand('delegate', [...args, '--to', to], { transportFactory });
  const original = captured.delegate.mock.calls[0][0];
  await networkCommand('delegate', [...args, '--invite', to], { transportFactory });
  expect(captured.delegate.mock.calls[1][0]).toEqual(original);
  expect(original).toMatchObject({ to, title: 'Echo', description: 'Echo JSON', input: {} });
  expect(transportFactory.mock.calls.map(args => args[0])).toEqual([relayUrl, relayUrl]);
});

it('uses the invite relay when --invite is given without --relay', async () => {
  const to = target('token');
  await networkCommand('delegate', [...taskArgs(), '--invite', to], { transportFactory });
  expect(transportFactory.mock.calls[0][0]).toBe(relayUrl);
  expect(captured.delegate.mock.calls[0][0].to).toBe(to);
});

it.each([false, true])('accepts matching --to and --invite values (invite first=%s)', async inviteFirst => {
  const to = target('token');
  const flags = inviteFirst ? ['--invite', to, '--to', to] : ['--to', to, '--invite', to];
  await networkCommand('delegate', [...taskArgs(), ...flags], { transportFactory });
  expect(captured.delegate).toHaveBeenCalledOnce();
  expect(captured.delegate.mock.calls[0][0].to).toBe(to);
});

it.each([false, true])('rejects differing --to and --invite values (invite first=%s)', async inviteFirst => {
  const to = target('did'), invite = target('token');
  const flags = inviteFirst ? ['--invite', invite, '--to', to] : ['--to', to, '--invite', invite];
  await expect(networkCommand('delegate', [...taskArgs(), ...flags], { transportFactory }))
    .rejects.toThrow('CONFLICTING_TARGET_OPTIONS');
  expect(captured.delegate).not.toHaveBeenCalled();
  expect(transportFactory).not.toHaveBeenCalled();
});

it.each(['--to', '--invite'])('%s rejects missing and duplicate values', async flag => {
  await expect(networkCommand('delegate', [...taskArgs(), flag], { transportFactory }))
    .rejects.toThrow('Missing ' + flag);
  await expect(networkCommand('delegate', [...taskArgs(), flag, target('did'), flag, target('did')], { transportFactory }))
    .rejects.toThrow('Duplicate option: ' + flag);
  expect(captured.delegate).not.toHaveBeenCalled();
});

it.each(['--to', '--invite'])('%s applies invite and relay validation before delegation', async flag => {
  await expect(networkCommand('delegate', [...taskArgs(), flag, 'acp-invite:invalid'], { transportFactory }))
    .rejects.toThrow('INVALID_OR_EXPIRED_INVITE');
  await expect(networkCommand('delegate', [...taskArgs(), flag, target('token'), '--relay', 'https://other.example'], { transportFactory }))
    .rejects.toThrow('CONFLICTING_RELAY');
  expect(captured.delegate).not.toHaveBeenCalled();
  expect(transportFactory).not.toHaveBeenCalled();
});

it.each(['--title', '--description', '--input'])('keeps %s required', async flag => {
  const args = [...taskArgs(), '--to', target('did')];
  args.splice(args.indexOf(flag), 2);
  await expect(networkCommand('delegate', args, { transportFactory })).rejects.toThrow('Missing ' + flag);
  expect(captured.delegate).not.toHaveBeenCalled();
});
