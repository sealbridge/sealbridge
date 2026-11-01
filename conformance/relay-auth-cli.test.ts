// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInviteToken, createSignedAgentCard, generateKeyPair } from '../packages/core/src/index.js';
import type { KeyPair } from '../packages/core/src/index.js';
import type { RelayClientSecurityOptions } from '../packages/relay/src/index.js';

// Inject only the transport; worker supervision and the CLI error/exit path are real.
const state = vi.hoisted(() => ({ fetcher: undefined as typeof fetch | undefined,
  options: undefined as RelayClientSecurityOptions | undefined }));
vi.mock('../packages/relay/dist/index.js', async original => {
  const relay = await original<typeof import('../packages/relay/src/index.js')>();
  return { ...relay, HttpRelayClient: class extends relay.HttpRelayClient {
    constructor(url: string, key: KeyPair, options?: RelayClientSecurityOptions) {
      super(url, (input, init) => state.fetcher!(input, init), key, options);
      state.options = options;
    }
  } };
});
import { networkCommand } from '../cli/src/network.js';
import { mcpServerCommand, parseMcpServerArgs, mcpServerOptionsFromArgs } from '../cli/src/mcp.js';

const dirs: string[] = [];
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
afterEach(() => {
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function identity() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-auth-cli-'));
  dirs.push(dir);
  const key = join(dir, 'owner.private.json');
  writeFileSync(key, JSON.stringify(generateKeyPair()), { mode: 0o600 });
  return { key, contacts: join(dir, 'contacts.json') };
}

it.each(['worker', 'delegate'])('forwards auth settings on %s before creating a relay client', async command => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { key, contacts } = identity();
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    init?.method === 'POST' ? new Response(null, { status: 204 }) : new Response('ignored response', { status: 401 }));
  state.fetcher = fetcher;
  const flags = ['--key', key, '--relay-auth-retries', '1',
    '--relay-auth-recovery-timeout-ms', '2000'];
  const target = generateKeyPair();
  const card = createSignedAgentCard({ name: 'local', agentDid: target.did, relayEndpoint: 'https://relay.example', skills: [] }, target);
  const invite = createInviteToken({ agentCard: card }, target);
  const result = command === 'worker'
    ? networkCommand('worker', ['start', ...flags, '--relay', 'https://relay.example', '--contacts', contacts])
    : networkCommand('delegate', [...flags, '--to', invite, '--title', 'local',
      '--description', 'local task', '--input', '{}']);
  const checked = expect(result).rejects.toThrow('RELAY_AUTH_RECOVERY_EXHAUSTED');
  await vi.advanceTimersByTimeAsync(2000);
  await checked;
  expect(state.options).toMatchObject({ maxAuthRecoveryAttempts: 1, authRecoveryTimeoutMs: 2000 });
  expect(fetcher.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2);
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)).payload.eventType))
    .toEqual(command === 'worker' ? [] : ['PROPOSE', 'AUDIT_ENTRY']);
});

it.each(['worker', 'delegate', 'mcp-server'])('validates auth flags in %s without loading an identity or contacting a relay', async command => {
  for (const [flag, value] of [['--relay-auth-retries', '-1'], ['--relay-auth-retries', '1.5'],
    ['--relay-auth-retries', 'Infinity'], ['--relay-auth-retries', '2147483648'],
    ['--relay-auth-recovery-timeout-ms', '0'], ['--relay-auth-recovery-timeout-ms', 'NaN'],
    ['--relay-auth-recovery-timeout-ms', '2147483648']]) {
    const args = [flag, value];
    const run = command === 'mcp-server' ? mcpServerCommand(args)
      : networkCommand(command, command === 'worker' ? ['start', ...args] : args);
    await expect(run).rejects.toThrow('INVALID_RELAY_AUTH');
  }
  const run = command === 'mcp-server' ? mcpServerCommand(['--relay-auth-retries'])
    : networkCommand(command, command === 'worker' ? ['start', '--relay-auth-retries'] : ['--relay-auth-retries']);
  await expect(run).rejects.toThrow('INVALID_RELAY_AUTH_RETRIES');
});

it('forwards MCP auth settings and accepts zero retries', () => {
  const parsed = parseMcpServerArgs(['--relay-auth-retries', '0', '--relay-auth-recovery-timeout-ms', '5000']);
  expect(mcpServerOptionsFromArgs(parsed, generateKeyPair())).toMatchObject({
    maxAuthRecoveryAttempts: 0, authRecoveryTimeoutMs: 5000,
  });
});

it.each(['worker', 'delegate', 'mcp-server'])('documents auth defaults and attempt semantics in %s help', async command => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  if (command === 'mcp-server') await mcpServerCommand(['--help']);
  else await networkCommand(command, command === 'worker' ? ['start', '--help'] : ['--help']);
  const help = String(log.mock.calls[0][0]);
  expect(help).toContain('--relay-auth-retries');
  expect(help).toContain('Additional attempts');
  expect(help).toContain('default: 3');
  expect(help).toContain('--relay-auth-recovery-timeout-ms');
  expect(help).toContain('120000');
});

it('sets a non-zero worker start exit code on exhausted authentication recovery', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { key, contacts } = identity();
  const fetcher = vi.fn(async () => new Response('private response text', { status: 401 }));
  state.fetcher = fetcher;
  process.exitCode = undefined;
  process.argv = [originalArgv[0], 'sealbridge', 'worker', 'start', '--key', key,
    '--relay', 'https://relay.example', '--contacts', contacts];
  await import('../cli/src/index.js');
  await vi.advanceTimersByTimeAsync(875);
  expect(process.exitCode).toBe(1);
  expect(fetcher).toHaveBeenCalledTimes(4);
  const text = JSON.stringify(errors.mock.calls);
  expect(text).toContain('RELAY_AUTH_RECOVERY_EXHAUSTED');
  expect(text).toContain('system clock');
  expect(text).not.toContain('private response text');
});
