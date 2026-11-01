// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { realpathSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, parseAndVerifyInviteToken, createSignedAgentCard, createInviteToken } from '../packages/core/src/index.js';
import type { DelegateOptions, WorkerNodeOptions } from '../packages/runtime/src/session.js';

const captured = vi.hoisted(() => ({ worker: undefined as WorkerNodeOptions | undefined,
  task: undefined as DelegateOptions | undefined,
  interactive: undefined as { formatRequest?: unknown } | undefined }));
vi.mock('../packages/runtime/dist/index.js', async original => {
  const runtime = await original<typeof import('../packages/runtime/src/index.js')>();
  return { ...runtime,
    InteractiveCliApprovalProvider: class extends runtime.InteractiveCliApprovalProvider {
      constructor(owner: ConstructorParameters<typeof runtime.InteractiveCliApprovalProvider>[0],
        options: ConstructorParameters<typeof runtime.InteractiveCliApprovalProvider>[1]) {
        super(owner, options);
        captured.interactive = options;
      }
    },
    WorkerNode: class extends runtime.WorkerNode {
      constructor(options: WorkerNodeOptions) { super(options); captured.worker = options; }
      override async start() { return undefined; }
    },
    RequesterClient: class {
      async delegate(options: DelegateOptions) {
        captured.task = options;
        return { taskId: 'task_review', state: 'SETTLED', deliverable: {} };
      }
    },
  };
});
import { networkCommand } from '../cli/src/network.js';

let dir: string, key: string;
beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'sealbridge-review-cli-'));
  key = join(dir, 'owner.private.json');
  writeFileSync(key, JSON.stringify(generateKeyPair()), { mode: 0o600 });
  captured.worker = undefined;
  captured.task = undefined;
  captured.interactive = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
const delegateArgs = () => ['--key', key, '--to', 'did:key:local', '--title', 'Review diff', '--description', 'Check changes'];
const workerArgs = () => ['start', '--key', key, '--relay', 'https://relay.example', '--contacts', join(dir, 'contacts.json')];

it('delegate reads a diff file without changing whitespace and forwards an HTTPS invite link', async () => {
  const diff = 'diff --git a/a.ts b/a.ts\n-old\n+new\n';
  const file = join(dir, 'code.diff');
  writeFileSync(file, diff);
  const args = delegateArgs();
  const owner = generateKeyPair();
  const card = createSignedAgentCard({ name: 'Echo', agentDid: owner.did, relayEndpoint: 'https://relay.example', skills: [] }, owner);
  args[3] = 'https://sealbridge.app/i#' + createInviteToken({ agentCard: card }, owner);
  await networkCommand('delegate', [...args, '--input-file', file]);
  expect(captured.task?.input).toEqual({ diff });
  expect(captured.task?.to === args[3]).toBe(true);
});
it('delegate reads a JSON object file and keeps inline input compatible', async () => {
  const file = join(dir, 'input.txt');
  writeFileSync(file, '{"diff":"changes","context":{"language":"typescript"}}');
  await networkCommand('delegate', [...delegateArgs(), '--input-file', file]);
  expect(captured.task?.input).toEqual({ diff: 'changes', context: { language: 'typescript' } });
  await networkCommand('delegate', [...delegateArgs(), '--input', '{"existing":true}']);
  expect(captured.task?.input).toEqual({ existing: true });
});
it.each(['Please review this change.\n', ''])('delegate wraps plain text and empty files as a diff (%j)', async contents => {
  const file = join(dir, 'notes.txt');
  writeFileSync(file, contents);
  await networkCommand('delegate', [...delegateArgs(), '--input-file', file]);
  expect(captured.task?.input).toEqual({ diff: contents });
});
it('delegate rejects conflicting input sources before sending a task', async () => {
  await expect(networkCommand('delegate', [...delegateArgs(), '--input', '{}', '--input-file', 'unused']))
    .rejects.toThrow('INVALID_INPUT_OPTIONS');
  expect(captured.task).toBeUndefined();
});
it.each(['{broken', 'null', '[]', '42'])('delegate rejects invalid JSON object files (%s)', async contents => {
  const file = join(dir, 'input.json');
  writeFileSync(file, contents);
  await expect(networkCommand('delegate', [...delegateArgs(), '--input-file', file])).rejects.toThrow('INVALID_INPUT_FILE');
  expect(captured.task).toBeUndefined();
});
it('delegate reports unreadable input files before sending a task', async () => {
  await expect(networkCommand('delegate', [...delegateArgs(), '--input-file', join(dir, 'absent.diff')]))
    .rejects.toThrow('ENOENT');
  expect(captured.task).toBeUndefined();
});
it('worker defaults to a 24-hour invite and prints its ready-to-share HTTPS link', async () => {
  await networkCommand('worker', workerArgs());
  const log = vi.mocked(console.log);
  const token = String(log.mock.calls[0][0]);
  const invite = parseAndVerifyInviteToken(token);
  expect(Date.parse(invite.expiresAt) - Date.parse(invite.issuedAt)).toBe(86400000);
  expect(log.mock.calls[1][0] === 'https://sealbridge.app/i#' + token).toBe(true);
  expect(captured.worker?.inviteTtlSeconds).toBe(86400);
});
it('worker applies invite-ttl to both the invitation and the signed card', async () => {
  await networkCommand('worker', [...workerArgs(), '--invite-ttl', '172800']);
  const invite = parseAndVerifyInviteToken(String(vi.mocked(console.log).mock.calls[0][0]));
  expect(Date.parse(invite.expiresAt) - Date.parse(invite.issuedAt)).toBe(172800000);
  expect(Math.abs(Date.parse(invite.agentCard.payload.expiresAt) - Date.parse(invite.expiresAt))).toBeLessThan(1000);
});
it.each(['0', '-1', '1.5', '2592001', 'NaN'])('worker rejects invalid invite-ttl (%s) before starting', async ttl => {
  await expect(networkCommand('worker', [...workerArgs(), '--invite-ttl', ttl])).rejects.toThrow('INVALID_INVITE_TTL');
  expect(captured.worker).toBeUndefined();
});
it.each(['claude', 'codex'])('worker fails early with actionable authentication guidance for %s', async adapter => {
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', '');
  await expect(networkCommand('worker', [...workerArgs(), '--adapter', adapter]))
    .rejects.toThrow('AGENT_AUTH_REQUIRED');
  expect(captured.worker).toBeUndefined();
});
it.each([['claude', 'ANTHROPIC_API_KEY'], ['codex', 'OPENAI_API_KEY']])('worker accepts a configured host key for %s', async (adapter, variable) => {
  vi.stubEnv(variable, 'local-fixture-value');
  await networkCommand('worker', [...workerArgs(), '--adapter', adapter]);
  expect(captured.worker?.adapter.id).toBe(adapter);
});
it('worker preserves explicit command overrides that manage their own authentication', async () => {
  vi.stubEnv('OPENAI_API_KEY', '');
  await networkCommand('worker', [...workerArgs(), '--adapter', 'codex', '--cmd', 'owner-configured-command']);
  expect(captured.worker?.adapter.id).toBe('codex');
});
it.each(['delegate', 'worker'])('%s help documents input files, invite links, TTL and verbose defaults', async command => {
  await networkCommand(command, ['--help']);
  const help = String(vi.mocked(console.log).mock.calls[0][0]);
  for (const value of ['--input-file', '--invite-ttl', '86400 / 24h', '--verbose', 'default: off', 'fresh'])
    expect(help).toContain(value);
});

it.each([false, true])('CLI worker wires concise or verbose approval display (verbose=%s)', async verbose => {
  await networkCommand('worker', [...workerArgs(), ...(verbose ? ['--verbose'] : [])]);
  expect(typeof captured.interactive?.formatRequest === 'function').toBe(!verbose);
});
it.each([false, true])('CLI delegate wires concise or verbose approval display (verbose=%s)', async verbose => {
  await networkCommand('delegate', [...delegateArgs(), '--input', '{}', ...(verbose ? ['--verbose'] : [])]);
  expect(typeof captured.interactive?.formatRequest === 'function').toBe(!verbose);
});
