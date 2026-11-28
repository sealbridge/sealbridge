// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { generateKeyPair, createContract, signPayload } from '../packages/core/src/index.js';
import { buildTaskManifest, OwnerGateway, WorkerNode } from '../packages/runtime/src/index.js';
import type { WorkerNodeOptions } from '../packages/runtime/src/session.js';
import {
  SandboxAgentAdapter,
  CommandAgentAdapter,
  ClaudeCodeAdapter,
  CodexCliAdapter,
} from '../packages/runtime-local/src/index.js';
import { requireNonRootLocalExecution } from '../packages/runtime-local/src/local-execution.js';
import { formatCliError } from '../cli/src/error-messages.js';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClientAdapter } from '../packages/adapters/src/mcp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { networkCommand } from '../cli/src/network.js';

const roots: string[] = [];
const hostPlatform = process.platform;
function application() {
  const root = mkdtempSync(join(tmpdir(), 'root-startup-'));
  roots.push(root);
  return {
    root,
    app: {
      identityOptions: { platform: hostPlatform, env: { SEALBRIDGE_DATA_DIR: join(root, 'data') } },
      fetch: vi.fn(() => {
        throw new Error('UNEXPECTED_NETWORK');
      }),
    },
  };
}
beforeEach(() => vi.stubEnv('SEALBRIDGE_ALLOW_ROOT_LOCAL_EXECUTION', undefined));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function identity(platform: NodeJS.Platform, real: number, effective: number) {
  vi.stubGlobal('process', { ...process, platform, getuid: () => real, geteuid: () => effective });
}
it.each(['sandbox', 'command', 'claude', 'codex'])(
  'rejects CLI %s before identity creation, registration or acceptance',
  async (adapter) => {
    const { root, app } = application();
    const fetch = vi.spyOn(globalThis, 'fetch');
    identity('linux', 1001, 0);
    await expect(
      networkCommand('worker', ['start', '--adapter', adapter, '--allow-local-pc'], app),
    ).rejects.toThrow('LOCAL_EXECUTION_ROOT_FORBIDDEN');
    expect(readdirSync(root)).toEqual([]);
    expect(app.fetch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);
it.each([
  new SandboxAgentAdapter(),
  new CommandAgentAdapter({ command: 'unused', id: 'renamed-local-command' }),
  new ClaudeCodeAdapter(),
  new CodexCliAdapter(),
])('rejects local worker startup before registration with adapter $id', (adapter) => {
  identity('linux', 1001, 0);
  const relay = { register: vi.fn() };
  expect(() => new WorkerNode({ adapter, relay } as unknown as WorkerNodeOptions)).toThrow(
    'LOCAL_EXECUTION_ROOT_FORBIDDEN',
  );
  expect(relay.register).not.toHaveBeenCalled();
});
it.each([
  ['linux', 0, 1001],
  ['win32', 0, 0],
] as const)(
  'uses effective uid and leaves %s uid=%s euid=%s allowed',
  (platform, real, effective) => {
    identity(platform, real, effective);
    expect(requireNonRootLocalExecution).not.toThrow();
  },
);
it('does not guard internal gateways but guards standalone local execute', async () => {
  identity('linux', 1001, 0);
  const requester = generateKeyPair(),
    worker = generateKeyPair();
  const manifest = buildTaskManifest({
    ownerDid: requester.did,
    workerDid: worker.did,
    title: 'Synthetic',
    description: 'Synthetic',
  });
  const contract = createContract(manifest, signPayload(manifest, requester), worker);
  const policy = { requiredGates: [], autoApprove: [] };
  const internal = new OwnerGateway(worker, contract, policy);
  await expect(internal.execute('return 1;', {} as never)).rejects.toThrow(
    'LOCAL_EXECUTION_ROOT_FORBIDDEN',
  );
  internal.close();
  const gateway = new OwnerGateway(requester, contract, policy);
  gateway.close();
});
it('provides local bilingual non-root guidance without inventing a bypass', () => {
  identity('linux', 0, 0);
  let failure: unknown;
  try {
    requireNonRootLocalExecution();
  } catch (error) {
    failure = error;
  }
  const local = formatCliError(failure);
  expect(local).toContain('dedicated non-root user');
  expect(local).toContain('専用の非 root ユーザー');
  expect(local).toContain('USER node');
  expect(local).toContain('SEALBRIDGE_ALLOW_ROOT_LOCAL_EXECUTION=1');
  expect(local).not.toContain('--allow-root');
});
it.each(['true', 'yes', '0', '01'])('does not accept ambiguous root override %s', (value) => {
  identity('linux', 0, 0);
  vi.stubEnv('SEALBRIDGE_ALLOW_ROOT_LOCAL_EXECUTION', value);
  expect(requireNonRootLocalExecution).toThrow('LOCAL_EXECUTION_ROOT_FORBIDDEN');
});
it('permits the exact host launch override and warns on every startup', () => {
  identity('linux', 0, 0);
  vi.stubEnv('SEALBRIDGE_ALLOW_ROOT_LOCAL_EXECUTION', '1');
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  new SandboxAgentAdapter().assertStartup();
  new CodexCliAdapter().assertStartup();
  expect(stderr).toHaveBeenCalledTimes(2);
  expect(stderr.mock.calls[0][0]).toContain('SEALBRIDGE_ALLOW_ROOT_LOCAL_EXECUTION=1');
});
it('does not take a root override from peer/task/manifest fields', () => {
  identity('linux', 0, 0);
  const supplied = { SEALBRIDGE_ALLOW_ROOT_LOCAL_EXECUTION: '1' };
  expect(
    () =>
      new WorkerNode({
        adapter: new SandboxAgentAdapter(),
        manifest: supplied,
        input: supplied,
        invite: supplied,
        env: supplied,
      } as unknown as WorkerNodeOptions),
  ).toThrow('LOCAL_EXECUTION_ROOT_FORBIDDEN');
});

it.runIf(hostPlatform !== 'win32')(
  'runs actual networkCommand preview with explicit host override',
  async () => {
    const { app } = application();
    identity(hostPlatform, process.getuid?.() ?? 0, 0);
    vi.stubEnv('SEALBRIDGE_ALLOW_ROOT_LOCAL_EXECUTION', '1');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await networkCommand(
      'worker',
      ['start', '--adapter', 'sandbox', '--allow-local-pc', '--preview'],
      app,
    );
    expect(stderr.mock.calls.some(([line]) => String(line).includes('starting as root'))).toBe(
      true,
    );
    expect(app.fetch).not.toHaveBeenCalled();
  },
);
it('blocks local notify shell on remote worker before files/network', async () => {
  const { root, app } = application();
  identity('linux', 0, 0);
  await expect(
    networkCommand(
      'worker',
      ['start', '--adapter', 'openai', '--notify', 'synthetic-command', '--allow-local-pc'],
      app,
    ),
  ).rejects.toThrow('LOCAL_EXECUTION_ROOT_FORBIDDEN');
  expect(readdirSync(root)).toEqual([]);
  expect(app.fetch).not.toHaveBeenCalled();
});
it.runIf(hostPlatform !== 'win32')(
  'leaves URL notification on remote worker outside local startup policy',
  async () => {
    const { app } = application();
    identity(hostPlatform, process.getuid?.() ?? 0, 0);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await networkCommand(
      'worker',
      ['start', '--adapter', 'openai', '--notify', 'https://notify.example', '--preview'],
      app,
    );
    expect(app.fetch).not.toHaveBeenCalled();
  },
);
it('checks stdio MCP startup before spawn and leaves remote transport alone', () => {
  identity('linux', 0, 0);
  const start = vi.spyOn(StdioClientTransport.prototype, 'start');
  const adapter = new McpClientAdapter({ stdio: { command: 'never-start' }, tools: {} });
  expect(() => new WorkerNode({ adapter } as unknown as WorkerNodeOptions)).toThrow(
    'LOCAL_EXECUTION_ROOT_FORBIDDEN',
  );
  expect(start).not.toHaveBeenCalled();
  expect(() =>
    new McpClientAdapter({ transport: {} as never, tools: {} }).assertStartup(),
  ).not.toThrow();
});
it('does not fail an overridden startup if local warning write throws', () => {
  identity('linux', 0, 0);
  vi.stubEnv('SEALBRIDGE_ALLOW_ROOT_LOCAL_EXECUTION', '1');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => {
    throw new Error('synthetic stderr failure');
  });
  expect(requireNonRootLocalExecution).not.toThrow();
});
it('does not emit root override warnings for per-task gateway construction', () => {
  identity('linux', 0, 0);
  vi.stubEnv('SEALBRIDGE_ALLOW_ROOT_LOCAL_EXECUTION', '1');
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const a = generateKeyPair(),
    b = generateKeyPair();
  const m = buildTaskManifest({
    ownerDid: a.did,
    workerDid: b.did,
    title: 'Synthetic',
    description: 'Synthetic',
  });
  new OwnerGateway(b, createContract(m, signPayload(m, a), b), {
    requiredGates: [],
    autoApprove: [],
  }).close();
  expect(stderr).not.toHaveBeenCalled();
});
