// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, verifySigned } from '../packages/core/src/index.js';
import type { WorkerNodeOptions } from '../packages/runtime/src/session.js';

const captured = vi.hoisted(() => ({ options: undefined as WorkerNodeOptions | undefined, starts: 0 }));
vi.mock('../packages/runtime/dist/index.js', async original => {
  const runtime = await original<typeof import('../packages/runtime/src/index.js')>();
  return { ...runtime, WorkerNode: class extends runtime.WorkerNode {
    constructor(options: WorkerNodeOptions) { super(options); captured.options = options; }
    override async start() { captured.starts++; return undefined; }
  } };
});
import { networkCommand } from '../cli/src/network.js';
import { AcpMcpServer, WorkerNode, PolicyAutoApprovalProvider } from '../packages/runtime/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { diagnose } from '../cli/src/doctor.js';
import { LOCAL_PC_DISABLED, LOCAL_PC_MIGRATION, LOCAL_PC_WARNING } from '../cli/src/local-pc.js';

let dir: string;
const owner = generateKeyPair();
beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'sealbridge-local-opt-in-'));
  captured.options = undefined; captured.starts = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
const application = () => ({ identityOptions: { home: dir,
  env: { SEALBRIDGE_DATA_DIR: join(dir, 'data'), SEALBRIDGE_KEY_STORE: 'file' } },
  fetch: vi.fn(() => { throw new Error('UNEXPECTED_NETWORK'); }) });

it.each([
  ['worker', 'start'],
  ...['claude', 'codex', 'command', 'sandbox'].map(adapter => ['worker', 'start', '--adapter', adapter]),
  ['worker', 'start', '--adapter', 'openai', '--on-receive', 'owner-command', '--inbox', 'inbox.jsonl'],
  ['relay', 'start', '--wake-command', 'owner-command', '--wake-relay', 'https://relay.example'],
])('refuses %j before identity, network or hook startup', async (...args: string[]) => {
  const [command, ...rest] = args;
  const app = application();
  await expect(networkCommand(command, rest, app)).rejects.toMatchObject({
    code: 'LOCAL_PC_EXECUTION_REQUIRES_OPT_IN',
    message: 'LOCAL_PC_EXECUTION_REQUIRES_OPT_IN: ' + LOCAL_PC_DISABLED + '\n' + LOCAL_PC_MIGRATION,
  });
  expect(existsSync(join(dir, 'data'))).toBe(false);
  expect(app.fetch).not.toHaveBeenCalled();
  expect(captured.options).toBeUndefined();
  expect(captured.starts).toBe(0);
});

it('actual CLI prints the code, English migration and existing Japanese error guidance', () => {
  const result = spawnSync(process.execPath, ['cli/dist/index.js', 'worker', 'start', '--adapter', 'command'], {
    encoding: 'utf8', env: { ...process.env, SEALBRIDGE_DATA_DIR: join(dir, 'data') }, timeout: 10_000,
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('LOCAL_PC_EXECUTION_REQUIRES_OPT_IN');
  expect(result.stderr).toContain(LOCAL_PC_DISABLED);
  expect(result.stderr).toContain(LOCAL_PC_MIGRATION);
  expect(result.stderr).toContain('乗り換え:');
  expect(existsSync(join(dir, 'data'))).toBe(false);
});

it.each(['environment', 'configuration'])('does not accept %s opt-in', async source => {
  const app = application();
  if (source === 'environment') {
    vi.stubEnv('SEALBRIDGE_ALLOW_LOCAL_PC', 'true');
    vi.stubEnv('ACP_ALLOW_LOCAL_PC', '1');
    Object.assign(app.identityOptions.env, { SEALBRIDGE_ALLOW_LOCAL_PC: 'true', ACP_ALLOW_LOCAL_PC: '1' });
  } else {
    mkdirSync(join(dir, 'data'), { mode: 0o700 });
    writeFileSync(join(dir, 'data', 'config.json'), JSON.stringify({ version: 1, allowLocalPc: true,
      'allow-local-pc': true, relays: ['https://relay.example'] }), { mode: 0o600 });
  }
  await expect(networkCommand('worker', ['start', '--adapter', 'sandbox'], app))
    .rejects.toMatchObject({ code: 'LOCAL_PC_EXECUTION_REQUIRES_OPT_IN' });
  expect(existsSync(join(dir, 'data', 'identities'))).toBe(false);
  expect(app.fetch).not.toHaveBeenCalled();
});

it.each(['false', 'true', '1'])('rejects a flag value (%s)', async value => {
  await expect(networkCommand('worker', ['start', '--allow-local-pc', value], application()))
    .rejects.toThrow('INVALID_ALLOW_LOCAL_PC');
});

it.each(['sandbox', 'command', 'claude', 'codex', 'openai'])('starts opted-in %s workers with a warning and signed startup audit every time', async adapter => {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const app = application();
  const audit = join(dir, 'worker.jsonl');
  for (let attempt = 0; attempt < 2; attempt++) {
    await networkCommand('worker', ['start', '--adapter', adapter, '--cmd', 'owner-command',
      '--allow-local-pc', '--relay', 'https://relay.example', '--audit', audit,
      ...(adapter === 'openai' ? ['--on-receive', 'owner-hook', '--inbox', join(dir, 'inbox.jsonl')] : []),
      '--contacts', join(dir, 'contacts.json'), '--invite-output', 'none'], app);
  }
  expect(captured.starts).toBe(2);
  expect(stderr.mock.calls.filter(([line]) => line === LOCAL_PC_WARNING + '\n')).toHaveLength(2);
  const records = readFileSync(audit + '.events.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(records).toHaveLength(2);
  for (const record of records) {
    expect(verifySigned(record)).toBe(true);
    expect(record.payload).toMatchObject({ event: 'LOCAL_PC_OPT_IN', workerDid: captured.options!.owner.did,
      isolation: 'host_adapter', ownerApproval: true, contentInspection: true });
  }
  expect(captured.options?.automaticApproval).toBe(false);
  expect(captured.options?.heldReview).toBeDefined();
  expect(captured.options?.approvalProvider).toBeDefined();
  expect(app.fetch).not.toHaveBeenCalled();
});

it.each(['claude', 'codex', 'openai'])('keeps the %s LLM auto-accept allowlist guard with opt-in', async adapter => {
  await expect(networkCommand('worker', ['start', '--adapter', adapter, '--cmd', 'owner-command',
    '--allow-local-pc', '--auto-accept', '--contacts', join(dir, 'contacts.json')], application()))
    .rejects.toThrow('LLM_AUTO_ACCEPT_REQUIRES_ALLOWLIST');
  expect(captured.starts).toBe(0);
});

it('leaves API-only workers, delegate and requester MCP initialization available without opt-in', async () => {
  const app = application();
  await networkCommand('worker', ['start', '--adapter', 'openai', '--contacts', join(dir, 'contacts.json'),
    '--invite-output', 'none'], app);
  expect(captured.starts).toBe(1);
  // Normal requester input validation is still reached, rather than the local execution guard.
  await expect(networkCommand('delegate', ['--input', '{}'], app)).rejects.toThrow('Missing --title');
  const server = new AcpMcpServer({ owner, identityOptions: app.identityOptions });
  for (const method of ['initialize', 'tools/list'])
    expect(await server.handle({ jsonrpc: '2.0', id: 1, method })).not.toHaveProperty('error');
  expect(app.fetch).not.toHaveBeenCalled();
});

it('doctor explains the requirement and migration without network in offline mode', async () => {
  const app = application();
  const checks = await diagnose({ ...app, offline: true, path: '', version: '22.22.0' });
  const message = checks.find(check => check.name === 'Local PC execution')!.message;
  for (const text of ['0.7.0', '--allow-local-pc', 'sandbox', 'npm i -g sealbridge-local',
    'planned for publication', 'keys and data directory are reused']) expect(message).toContain(text);
  expect(app.fetch).not.toHaveBeenCalled();
});

it.each(['delegate', 'mcp-server'])('settles actual %s requests without local PC opt-in', async mode => {
  const relay = new InMemoryRelay(), remote = generateKeyPair();
  const app = application();
  const key = join(dir, 'requester.private.json');
  writeFileSync(key, JSON.stringify(owner), { mode: 0o600 });
  let executions = 0;
  const worker = new WorkerNode({ owner: remote, relay, relayUrl: 'https://relay.example',
    checkPeer: () => 'trusted', allowedRequesterDids: [owner.did],
    approvalProvider: new PolicyAutoApprovalProvider(remote), timeoutMs: 5000,
    adapter: { id: 'remote-echo', name: 'Remote echo', skills: [], executeTask: async ctx => {
      executions++; return ctx.input;
    } } });
  const running = worker.start({ once: true });
  const settled = Promise.allSettled([running]);
  try {
    if (mode === 'delegate') {
      await networkCommand('delegate', ['--key', key, '--to', worker.invite(), '--title', 'Echo',
        '--description', 'Remote echo', '--input', '{"ok":true}', '--auto-approve'], {
        ...app, transportFactory: () => relay,
      });
      expect(vi.mocked(console.log).mock.calls.some(([line]) => String(line).includes('SETTLED'))).toBe(true);
    } else {
      const server = new AcpMcpServer({ owner, relay, identityOptions: app.identityOptions,
        approvalProvider: new PolicyAutoApprovalProvider(owner) });
      const result = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'acp_delegate_task', arguments: { inviteToken: worker.invite(), title: 'Echo',
          description: 'Remote echo', input: { ok: true }, taskTimeoutMs: 5000 },
      } });
      expect(JSON.stringify(result)).toContain('SETTLED');
      server.stopDelivery();
    }
    expect(executions).toBe(1);
    expect((await settled)[0].status).toBe('fulfilled');
  } finally { worker.stop(); await settled; }
});
