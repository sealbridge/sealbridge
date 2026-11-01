// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSignedAgentCard, generateKeyPair, signApproval, signPayload,
  verifySignedAgentCard } from '../packages/core/src/index.js';
import type { KeyPair } from '../packages/core/src/index.js';
import { createRelayFetchHandler, HttpRelayClient, InMemoryRelay } from '../packages/relay/src/index.js';
import type { RelayTransport } from '../packages/relay/src/index.js';
import { AcpMcpServer, DEFAULT_PUBLIC_RELAY, resolveOrCreateIdentity,
  WorkerNode } from '../packages/runtime/src/index.js';
import type { AcpMcpServerOptions, ApprovalProvider, WorkerNodeOptions } from '../packages/runtime/src/index.js';
import { mcpServerOptionsFromArgs, parseMcpServerArgs } from '../cli/src/mcp.js';

const NOW = new Date('2026-06-01T12:00:00Z');
const POLICY = { maxInputTokens: 1000, maxOutputTokens: 500,
  maxToolInvocations: 2, maxWallClockSeconds: 30 };
const SKILL = { id: 'echo', name: 'Echo', description: 'Return JSON', taskTypes: ['json'],
  inputSchema: { type: 'object', required: ['hello'], properties: { hello: { type: 'string' } } },
  outputSchema: { type: 'object', additionalProperties: true } };
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'sealbridge-open-mcp-'));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('UNEXPECTED_NETWORK'); }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

function approving(key: () => KeyPair, decision: 'APPROVED' | 'REJECTED' = 'APPROVED'): ApprovalProvider {
  return { approve: vi.fn(async request =>
    signApproval(request.taskId, request.gate, request.target, key(), decision)) };
}
async function call(server: AcpMcpServer, name: string, args: Record<string, unknown> = {}) {
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name, arguments: args } }) as {
      error?: { code: number; message: string };
      result?: { isError: boolean; content: { text: string }[]; structuredContent?: unknown };
    };
  return { rpcError: response.error, isError: response.result?.isError,
    value: response.result ? JSON.parse(response.result.content[0].text) : undefined };
}
function card(mode?: 'open' | 'invite-only', owner = generateKeyPair(), endpoint = DEFAULT_PUBLIC_RELAY) {
  return createSignedAgentCard({ name: 'Echo', agentDid: owner.did, relayEndpoint: endpoint,
    skills: [SKILL], accessMode: mode, ...(mode === 'open' ? { openPolicy: POLICY } : {}) }, owner);
}
function harness() {
  const identityOptions = { home: root, env: { SEALBRIDGE_DATA_DIR: join(root, 'data') } };
  const relay = new InMemoryRelay({ now: () => Date.now() });
  const handler = createRelayFetchHandler({ relay });
  const routes: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    expect(new URL(request.url).origin).toBe(DEFAULT_PUBLIC_RELAY);
    routes.push(request.method + ' ' + new URL(request.url).pathname);
    return handler(request);
  };
  const transportFactory = vi.fn((url: string, key?: KeyPair) => new HttpRelayClient(url, fetcher, key));
  const requester = () => resolveOrCreateIdentity('requester', identityOptions);
  const approvalProvider = approving(requester);
  const options = { ...mcpServerOptionsFromArgs(parseMcpServerArgs([])),
    identityOptions, transportFactory, approvalProvider };
  const server = new AcpMcpServer(options);
  return { relay, routes, options, server, requester, approvalProvider, transportFactory };
}
function directory(raw: unknown, options: Partial<AcpMcpServerOptions> = {}) {
  return new AcpMcpServer({
    identityOptions: { home: root, env: { SEALBRIDGE_DATA_DIR: join(root, 'data') } },
    transportFactory: () => ({ discover: async () => raw } as RelayTransport), ...options,
  });
}

describe('default MCP open discovery', () => {
  it('discovers over GET /agents and delegates returned DID/relay with default application options', async () => {
    const h = harness();
    const owner = resolveOrCreateIdentity('worker', h.options.identityOptions);
    const agent = generateKeyPair();
    const executeTask = vi.fn(async (ctx: Parameters<WorkerNodeOptions['adapter']['executeTask']>[0]) => {
      expect(ctx.manifest.task.description).toBe('Echo JSON');
      expect(ctx.manifest.budget).toMatchObject(POLICY);
      expect(ctx.manifest.worker).toMatchObject({ ownerDid: owner.did, agentDid: agent.did });
      return ctx.input;
    });
    const worker = new WorkerNode({ owner, agentDid: agent.did, agentKey: agent,
      relay: h.transportFactory(DEFAULT_PUBLIC_RELAY, owner), relayUrl: DEFAULT_PUBLIC_RELAY,
      accessMode: 'open', openPolicy: POLICY, publishToRegistry: true, allowedRequesterDids: [],
      approvalProvider: approving(() => owner),
      adapter: { id: 'echo', name: 'Echo', skills: [SKILL], executeTask } });
    await h.server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    await h.server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(h.routes).toEqual([]);
    await worker.register();
    const discovered = await call(h.server, 'acp_discover_workers');
    expect(discovered.isError).toBe(false);
    expect(discovered.value).toMatchObject({ count: 1, relayUrl: DEFAULT_PUBLIC_RELAY });
    const selected = discovered.value.workers[0];
    expect(selected).toMatchObject({ workerDid: agent.did, ownerDid: owner.did,
      relayUrl: DEFAULT_PUBLIC_RELAY, accessMode: 'open', openPolicy: POLICY,
      acceptance: 'worker_decides', skills: [SKILL] });
    expect(verifySignedAgentCard(selected.signedAgentCard)).toBe(true);
    expect(existsSync(join(root, 'data', 'identities', 'requester.private.json'))).toBe(false);
    expect(h.approvalProvider.approve).not.toHaveBeenCalled();
    const done = worker.start({ once: true });
    try {
      const result = await call(h.server, 'acp_delegate_task', {
        workerDid: selected.workerDid, relayUrl: selected.relayUrl,
        title: 'Echo JSON', input: { hello: 'world' },
      });
      expect(result).toMatchObject({ isError: false, value: { status: 'SETTLED',
        deliverable: { hello: 'world' }, auditBundle: { valid: true } } });
      expect((await done)?.state).toBe('SETTLED');
      expect(executeTask).toHaveBeenCalledTimes(1);
      const approvals = vi.mocked(h.approvalProvider.approve).mock.calls.map(([request]) => request);
      expect(approvals).toEqual(expect.arrayContaining([
        expect.objectContaining({ gate: 'external_side_effect', target: expect.objectContaining({ description: 'Echo JSON' }) }),
        expect.objectContaining({ gate: 'final_verification' }),
      ]));
      expect(h.requester().did).not.toBe(owner.did);
      expect(h.routes).toContain('POST /agents');
      expect(h.routes.filter(route => route === 'GET /agents')).toHaveLength(2);
      expect(h.transportFactory.mock.calls.every(([url]) => url === DEFAULT_PUBLIC_RELAY)).toBe(true);
    } finally { worker.stop(); await done.catch(() => undefined); }
  });

  it('lists published open workers only; publication remains independent of access mode', async () => {
    const h = harness();
    const workers = [
      { accessMode: 'open' as const, publishToRegistry: true },
      { accessMode: 'open' as const, publishToRegistry: false },
      { accessMode: 'invite-only' as const, publishToRegistry: true },
    ].map(options => {
      const owner = generateKeyPair();
      return new WorkerNode({ owner, ...options, relay: h.transportFactory(DEFAULT_PUBLIC_RELAY, owner),
        relayUrl: DEFAULT_PUBLIC_RELAY, approvalProvider: approving(() => owner),
        adapter: { id: 'echo', name: 'Echo', skills: [], executeTask: async ctx => ctx.input } });
    });
    // Explicit listener signals avoid waiting for polling or elapsed time.
    const started = workers.map(worker => {
      let ready!: () => void;
      const listening = new Promise<void>(resolve => { ready = resolve; });
      worker.options.onStatus = status => { if (status === 'connected') ready(); };
      return { listening, done: worker.start() };
    });
    try {
      await Promise.all(started.map(value => value.listening));
      const open = await call(h.server, 'acp_discover_workers');
      expect(open.value.workers.map((w: { workerDid: string }) => w.workerDid)).toEqual([workers[0].agentCard.payload.agentDid]);
      const all = await call(h.server, 'acp_discover_workers', { accessMode: 'all' });
      expect(all.value.count).toBe(2);
      expect(all.value.workers.map((w: { accessMode: string }) => w.accessMode).sort()).toEqual(['invite-only', 'open']);
    } finally {
      workers.forEach(worker => worker.stop());
      await Promise.allSettled(started.map(value => value.done));
    }
  });

  it('resolves newest cards before mode, skill, task type and endpoint filtering', async () => {
    const owner = generateKeyPair();
    const olderOpen = card('open', owner);
    const expiringOwner = generateKeyPair();
    const expiringCard = card('open', expiringOwner);
    const expired = signPayload({ ...expiringCard.payload,
      expiresAt: new Date(NOW.getTime() + 500).toISOString() }, expiringOwner);
    expect(verifySignedAgentCard(expired, NOW.getTime())).toBe(true);
    vi.setSystemTime(new Date(NOW.getTime() + 1000));
    const newestPrivate = card('invite-only', owner);
    const legacy = card();
    const open = card('open');
    const mismatch = card('open', generateKeyPair(), 'https://other.example');
    const normalized = card('open', generateKeyPair(), DEFAULT_PUBLIC_RELAY.toUpperCase() + '/');
    expect(verifySignedAgentCard(expired)).toBe(false);
    const tampered = { ...open, payload: { ...open.payload, name: 'Changed' } };
    const server = directory([olderOpen, newestPrivate, legacy, open, mismatch, normalized, expired, tampered, null, {}]);
    const result = await call(server, 'acp_discover_workers');
    expect(result.value.count).toBe(2);
    expect(result.value.workers.map((w: { workerDid: string }) => w.workerDid).sort())
      .toEqual([open.payload.agentDid, normalized.payload.agentDid].sort());
    expect(result.value.workers.every((w: { relayUrl: string }) => w.relayUrl === DEFAULT_PUBLIC_RELAY)).toBe(true);
    const all = await call(server, 'acp_discover_workers', { accessMode: 'all' });
    expect(all.value.count).toBe(4);
    const privateWorkers = await call(server, 'acp_discover_workers', { accessMode: 'invite-only' });
    expect(privateWorkers.value.workers.map((w: { workerDid: string }) => w.workerDid).sort())
      .toEqual([owner.did, legacy.payload.agentDid].sort());
    expect((await call(server, 'acp_discover_workers', { skillId: 'echo', taskType: 'json' })).value.count).toBe(2);
    for (const args of [{ skillId: 'other' }, { taskType: 'text' }])
      expect((await call(server, 'acp_discover_workers', args)).value.count).toBe(0);
    vi.setSystemTime(new Date(NOW.getTime() + 2000));
    const first = card('open', owner);
    vi.setSystemTime(new Date(NOW.getTime() + 3000));
    const updated = signPayload({ ...first.payload, skills: [{ id: 'other', name: 'Other' }] }, owner);
    expect((await call(directory([first, updated]), 'acp_discover_workers', { skillId: 'echo' })).value.count).toBe(0);
    vi.setSystemTime(new Date(NOW.getTime() + 4000));
    const moved = signPayload({ ...first.payload, relayEndpoint: 'https://other.example' }, owner);
    expect((await call(directory([first, moved]), 'acp_discover_workers')).value.count).toBe(0);
  });

  it('keeps ambiguous-owner errors and deterministic same-time selection', async () => {
    const owner = generateKeyPair(), other = generateKeyPair(), agent = generateKeyPair();
    const a = createSignedAgentCard({ name: 'A', agentDid: agent.did, relayEndpoint: DEFAULT_PUBLIC_RELAY,
      accessMode: 'open', skills: [] }, owner, agent);
    const b = createSignedAgentCard({ name: 'B', agentDid: agent.did, relayEndpoint: DEFAULT_PUBLIC_RELAY,
      accessMode: 'open', skills: [] }, owner, agent);
    const first = await call(directory([a, b]), 'acp_discover_workers');
    expect(await call(directory([b, a]), 'acp_discover_workers')).toEqual(first);
    expect(first.value.count).toBe(1);
    const conflict = createSignedAgentCard({ name: 'Other', agentDid: agent.did,
      relayEndpoint: DEFAULT_PUBLIC_RELAY, accessMode: 'invite-only', skills: [] }, other, agent);
    expect(await call(directory([a, conflict]), 'acp_discover_workers'))
      .toMatchObject({ isError: true, value: { error: 'AMBIGUOUS_AGENT_CARD_OWNER' } });
  });

  it('matches skill and task type on the same skill and preserves complete schemas', async () => {
    const owner = generateKeyPair();
    const signed = createSignedAgentCard({ name: 'Mixed', agentDid: owner.did, relayEndpoint: DEFAULT_PUBLIC_RELAY,
      accessMode: 'open', skills: [SKILL, { id: 'text', name: 'Text', taskTypes: ['text'] }] }, owner);
    const server = directory([signed]);
    expect((await call(server, 'acp_discover_workers', { skillId: 'echo', taskType: 'text' })).value.count).toBe(0);
    const result = await call(server, 'acp_discover_workers', { taskType: 'json' });
    expect(result.value.workers[0].skills).toEqual(signed.payload.skills);
    expect(result.value.workers[0].signedAgentCard).toEqual(signed);
  });

  it.each([{ raw: [] }, { raw: [null, {}, { payload: {} }] }])('returns empty results for unusable directory %#', async ({ raw }) => {
    expect(await call(directory(raw), 'acp_discover_workers'))
      .toMatchObject({ isError: false, value: { count: 0, workers: [] } });
  });
  it('reports non-array, unavailable, and HTTP directory failures without task transmission', async () => {
    expect(await call(directory({ agents: [] }), 'acp_discover_workers'))
      .toMatchObject({ isError: true, value: { error: 'INVALID_AGENT_CARD' } });
    expect(await call(directory([], { transportFactory: () => ({} as RelayTransport) }), 'acp_discover_workers'))
      .toMatchObject({ isError: true, value: { error: 'DISCOVERY_UNAVAILABLE' } });
    const fetcher = vi.fn(async () => new Response('unavailable', { status: 503 }));
    expect(await call(directory([], { transportFactory: url => new HttpRelayClient(url, fetcher) }), 'acp_discover_workers'))
      .toMatchObject({ isError: true, value: { error: 'DISCOVERY_FAILED' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([{ accessMode: 'private' }, { accessMode: null }, { skillId: 1 }, { skillId: '' },
    { taskType: [] }, { relayUrl: 1 }])('rejects malformed discovery selectors %#', async args => {
    expect((await call(directory([]), 'acp_discover_workers', args)).rpcError?.code).toBe(-32602);
  });

  it('retains explicit operator and private-relay policies before dialing', async () => {
    const h = harness();
    const selected = card('open');
    const args = { workerDid: selected.payload.agentDid, relayUrl: DEFAULT_PUBLIC_RELAY, title: 'Echo', input: {} };
    for (const policy of [{ allowedWorkerDids: [] }, { allowedWorkerDids: [generateKeyPair().did] }, { allowedRelayUrls: [] }]) {
      expect((await call(new AcpMcpServer({ ...h.options, ...policy }), 'acp_delegate_task', args)).value.error)
        .toMatch(/^MCP_(WORKER|RELAY)_NOT_ALLOWED$/);
    }
    expect((await call(new AcpMcpServer({ ...h.options, allowedRelayUrls: [] }), 'acp_discover_workers')).value.error)
      .toBe('MCP_RELAY_NOT_ALLOWED');
    for (const relayUrl of ['http://127.0.0.1:8787', 'http://169.254.169.254'])
      expect((await call(h.server, 'acp_discover_workers', { relayUrl })).value.error).toBe('SSRF_BLOCKED_RELAY_URL');
    expect(h.transportFactory).not.toHaveBeenCalled();
    expect(h.routes).toEqual([]);
  });

  it('rejects a non-string description before dialing', async () => {
    const h = harness();
    expect((await call(h.server, 'acp_delegate_task', {
      workerDid: generateKeyPair().did, title: 'Echo', description: null, input: {},
    })).rpcError?.code).toBe(-32602);
    expect(h.transportFactory).not.toHaveBeenCalled();
  });
});

describe('MCP DID admission compatibility', () => {
  it.each(['invite-only', 'allowed-requester', 'allow-any-private', 'open-default', 'open-empty', 'open-disallowed',
    'worker-declines', 'excess-budget', 'mode-changed'] as const)
    ('preserves worker decisions and does not retry: %s', async scenario => {
      const h = harness();
      const owner = generateKeyPair();
      const executeTask = vi.fn(async (ctx: Parameters<WorkerNodeOptions['adapter']['executeTask']>[0]) => ctx.input);
      const options: WorkerNodeOptions = { owner, relay: h.transportFactory(DEFAULT_PUBLIC_RELAY, owner),
        relayUrl: DEFAULT_PUBLIC_RELAY, accessMode: scenario.includes('private') || scenario === 'invite-only' || scenario === 'allowed-requester'
          ? 'invite-only' : 'open', openPolicy: POLICY,
        allowedRequesterDids: scenario === 'allowed-requester' ? [h.requester().did]
          : scenario === 'open-disallowed' ? [generateKeyPair().did] : scenario === 'open-default' ? undefined : [],
        allowAnyRequester: scenario === 'allow-any-private',
        approvalProvider: approving(() => owner, scenario === 'worker-declines' ? 'REJECTED' : 'APPROVED'),
        adapter: { id: 'echo', name: 'Echo', skills: [SKILL], executeTask } };
      const worker = new WorkerNode(options);
      await worker.register();
      const view = await call(h.server, 'acp_discover_workers', { accessMode: 'all' });
      const selected = view.value.workers[0];
      if (scenario === 'mode-changed') {
        options.accessMode = 'invite-only';
        vi.setSystemTime(new Date(NOW.getTime() + 1000));
        await h.relay.register(card('invite-only', owner));
      }
      const done = worker.start({ once: true }).catch((error: Error) => error);
      try {
        const result = await call(h.server, 'acp_delegate_task', {
          workerDid: selected.workerDid, relayUrl: selected.relayUrl, title: 'Echo',
          input: { hello: 'world' },
          ...(scenario === 'excess-budget' ? { budget: { maxInputTokens: POLICY.maxInputTokens + 1 } } : {}),
        });
        const success = scenario === 'allowed-requester' || scenario === 'open-empty' || scenario === 'open-default';
        if (success) {
          expect(result).toMatchObject({ isError: false, value: { status: 'SETTLED', auditBundle: { valid: true } } });
          expect(executeTask).toHaveBeenCalledTimes(1);
        } else {
          const error = scenario === 'worker-declines' ? 'APPROVAL' : scenario === 'open-disallowed' ? 'PROPOSAL_REJECTED'
            : scenario === 'excess-budget' ? 'TASK_SCOPE_REJECTED' : 'INVITE_REQUIRED';
          expect(result).toMatchObject({ isError: true });
          expect(result.value.error).toContain(error);
          expect(executeTask).not.toHaveBeenCalled();
        }
        expect(h.routes.filter(route => route === 'GET /agents')).toHaveLength(2);
      } finally { worker.stop(); await done; }
    });
});
