// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import {
  generateKeyPair,
  createRelayAuthToken,
  createSignedAgentCard,
  verifySignedAgentCard,
  createInviteToken,
  parseAndVerifyInviteToken,
  signApproval,
  verifyApproval,
  signEnvelope,
  signPayload,
  verifySigned,
} from '../packages/core/src/index.js';
import type { Json, KeyPair } from '../packages/core/src/index.js';
import {
  WorkerNode,
  RequesterClient,
  PolicyAutoApprovalProvider,
  InteractiveCliApprovalProvider,
  WebhookApprovalProvider,
  connectMCPTools,
  buildTaskManifest,
  VerificationEngine,
} from '../packages/runtime/src/index.js';
import type {
  AgentAdapter,
  ApprovalProvider,
  DelegateOptions,
  Delivery,
} from '../packages/runtime/src/index.js';
import {
  CommandAgentAdapter,
  ClaudeCodeAdapter,
  CodexCliAdapter,
  OpenAICompatibleAdapter,
  McpClientAdapter,
  SandboxAgentAdapter,
} from '../packages/adapters/src/index.js';
import {
  createRelayFetchHandler,
  startLocalRelay,
  HttpRelayClient,
  InMemoryRelay,
  SseRelayClient,
  WebSocketRelayClient,
} from '../packages/relay/src/index.js';
import {
  detectDockerRuntime,
  runContainerOrSubprocessSandbox,
  containerArguments,
  subprocessSandboxBoundary,
  OCI_CONTAINER_BOUNDARY,
} from '../packages/sandbox/src/index.js';
import { parseJsonl, verifyAudit } from '../packages/ledger/src/index.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function directory() {
  const dir = await mkdtemp(join(realpathSync(tmpdir()), 'acp-network-test-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function bridge() {
  const handler = createRelayFetchHandler();
  const fetcher: typeof fetch = async (input, init) =>
    handler(input instanceof Request && !init ? input : new Request(input, init));
  return {
    fetcher,
    client: new HttpRelayClient('http://relay.local', fetcher, { allowPrivateRelay: true }),
  };
}
async function network() {
  if (process.env.ACP_TEST_FETCH_BRIDGE === '1') {
    const b = bridge();
    return { ...b, url: 'http://relay.local', wsUrl: undefined };
  }
  try {
    const server = await startLocalRelay();
    cleanup.push(server.close);
    return {
      client: new HttpRelayClient(server.url, { allowPrivateRelay: true }),
      fetcher: fetch,
      url: server.url,
      wsUrl: server.wsUrl,
    };
  } catch (e) {
    if (!['EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
    const b = bridge();
    return { ...b, url: 'http://relay.local', wsUrl: undefined };
  }
}
function auto(owner: KeyPair) {
  return new PolicyAutoApprovalProvider(owner);
}
async function session(
  adapter: AgentAdapter,
  options: Partial<DelegateOptions> = {},
  requesterApproval?: ApprovalProvider,
  workerApproval?: ApprovalProvider,
) {
  const alice = generateKeyPair(),
    bob = generateKeyPair(),
    { client } = await network(),
    dir = await directory();
  const worker = new WorkerNode({
    owner: bob,
    relay: client,
    adapter,
    // Adapter sessions use a trusted requester; intake decisions are tested separately.
    allowedRequesterDids: [alice.did],
    approvalProvider: workerApproval ?? auto(bob),
    auditPath: join(dir, 'bob.jsonl'),
    timeoutMs: 10000,
  });
  const engine = new VerificationEngine();
  engine.registerIsolatedCheck(
    'check://network-report',
    'return input.artifact !== null && typeof input.artifact === "object" ? 0 : 1;',
  );
  const manifest = buildTaskManifest({
    ownerDid: alice.did,
    workerDid: bob.did,
    title: 'Report',
    description: 'Return a JSON report',
    outputSchema: options.outputSchema ?? { type: 'object' },
    budget: options.budget,
    capabilities: options.capabilities,
  });
  manifest.verification.checks = [
    {
      checkId: 'chk_network',
      kind: 'deterministic_command',
      target: 'check://network-report',
      expectedExitCode: 0,
    },
  ];
  const requester = new RequesterClient({
    owner: alice,
    relay: client,
    allowPrivateRelay: true,
    verificationEngine: engine,
    approvalProvider: requesterApproval ?? auto(alice),
    auditPath: join(dir, 'alice.jsonl'),
    timeoutMs: 10000,
  });
  const workerPromise = worker.start({ once: true });
  const results = await Promise.allSettled([
    requester.delegate({
      to: worker.invite(),
      title: 'Report',
      description: 'Return a JSON report',
      input: { value: 7 },
      outputSchema: { type: 'object' },
      ...options,
      manifest: options.manifest ?? manifest,
    }),
    workerPromise,
  ]);
  worker.stop();
  return { results, dir };
}
function settled(results: Awaited<ReturnType<typeof session>>['results']) {
  for (const r of results) if (r.status === 'rejected') throw r.reason;
  return results.map(
    (r) => (r as PromiseFulfilledResult<Awaited<ReturnType<RequesterClient['delegate']>>>).value,
  );
}
describe('WP-7/10/11 real adapter sessions across owner boundaries', () => {
  it('runs a real command with stdin, workspace file and a secret-free environment', async () => {
    const script = `let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{if(process.env.OPENAI_API_KEY||process.env.ACP_TEST_SECRET||process.env.NODE_OPTIONS)process.exit(9);const fs=require('node:fs');if(fs.readFileSync(process.env.TASK_INPUT_FILE,'utf8')!==s)process.exit(8);console.log(JSON.stringify({value:JSON.parse(s).value}));});`;
    const before = process.env.ACP_TEST_SECRET;
    process.env.ACP_TEST_SECRET = 'synthetic-host-only';
    try {
      const { results, dir } = await session(
        new CommandAgentAdapter({ command: [process.execPath, '-e', script] }),
      );
      const [alice, bob] = settled(results);
      expect(alice.deliverable).toEqual({ value: 7 });
      expect(alice.state).toBe('SETTLED');
      expect(alice.bundle).toEqual(bob.bundle);
      expect(verifyAudit(alice.bundle).status).toBe('VALID');
      expect(alice.bundle.entries.map((e) => e.body.eventType)).toEqual([
        'PROPOSE',
        'ACCEPT',
        'START',
        'DELIVER',
        'VERIFY_ACCEPT',
        'SETTLED',
      ]);
      for (const name of ['alice', 'bob'])
        expect(
          verifyAudit(parseJsonl(await readFile(join(dir, name + '.jsonl'), 'utf8'))).status,
        ).toBe('VALID');
    } finally {
      if (before === undefined) delete process.env.ACP_TEST_SECRET;
      else process.env.ACP_TEST_SECRET = before;
    }
  });
  it('runs Claude wrapper JSON and records exact token usage', async () => {
    const adapter = new ClaudeCodeAdapter({
      runner: async (r) => {
        expect(r.args.slice(0, 3)).toEqual(['-p', '--output-format', 'json']);
        expect(r.env).not.toHaveProperty('ANTHROPIC_API_KEY');
        return {
          stdout: JSON.stringify({
            result: '{"value":7}',
            usage: { input_tokens: 13, output_tokens: 5 },
          }),
        };
      },
    });
    const [result] = settled((await session(adapter)).results);
    const d = result.bundle.entries.find((e) => e.body.eventType === 'DELIVER')!.body
      .payload as unknown as { usage: { payload: { totalTokens: number } } };
    expect(d.usage.payload.totalTokens).toBe(18);
  });
  it('runs Codex JSONL events and meters completion usage', async () => {
    const adapter = new CodexCliAdapter({
      runner: async (r) => {
        expect(r.args[0]).toBe('exec');
        return {
          stdout: [
            JSON.stringify({
              type: 'item.completed',
              item: { type: 'agent_message', text: '{"value":7}' },
            }),
            JSON.stringify({
              type: 'turn.completed',
              usage: { input_tokens: 11, output_tokens: 4 },
            }),
          ].join('\n'),
        };
      },
    });
    const [result] = settled((await session(adapter)).results);
    expect(result.deliverable).toEqual({ value: 7 });
    expect(verifyAudit(result.bundle).valid).toBe(true);
  });
  it('keeps the HTTP BYOK key exclusively at the provider boundary', async () => {
    const key = 'synthetic-provider-credential';
    let calls = 0;
    const adapter = new OpenAICompatibleAdapter({
      model: 'mock-model',
      apiKey: key,
      endpoint: 'http://provider.local/v1/chat/completions',
      fetch: async (_url, init) => {
        calls++;
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + key);
        expect(init?.body).not.toContain(key);
        return Response.json({
          choices: [{ message: { content: '{"value":7}' } }],
          usage: { prompt_tokens: 17, completion_tokens: 6, total_tokens: 23 },
        });
      },
    });
    const [result] = settled((await session(adapter)).results);
    expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain(key);
    const d = result.bundle.entries.find((e) => e.body.eventType === 'DELIVER')!.body
      .payload as unknown as Delivery;
    expect(d.usage.payload).toMatchObject({ inputTokens: 17, outputTokens: 6, totalTokens: 23 });
  });
  it('executes an official SDK MCP tool through CapGuard and QuotaMeter', async () => {
    const backend = await connectMCPTools(async (name, args) => {
      expect(name).toBe('docs/read');
      return { content: [{ type: 'text', text: JSON.stringify(args) }] };
    });
    cleanup.push(backend.close);
    const adapter = new McpClientAdapter({
      client: backend.client,
      tools: { 'docs/read': { resource: () => 'mcp://docs/public', readOnly: true } },
      taskTool: 'docs/read',
    });
    const [result] = settled(
      (
        await session(adapter, {
          capabilities: [
            {
              capabilityId: 'cap_docs01',
              resource: 'mcp://docs/public',
              allowedTools: ['docs/read'],
              maxInvocations: 2,
              argConstraints: { type: 'object' },
              expiresAt: new Date(Date.now() + 60000).toISOString(),
            },
          ],
        })
      ).results,
    );
    expect(verifyAudit(result.bundle).valid).toBe(true);
    const d = result.bundle.entries.find((e) => e.body.eventType === 'DELIVER')!.body
      .payload as any;
    expect(d.usage.payload.toolCalls).toBe(1);
  });
  it('also completes over an in-memory transport without sockets', async () => {
    const alice = generateKeyPair(),
      bob = generateKeyPair(),
      relay = new InMemoryRelay();
    const worker = new WorkerNode({
      owner: bob,
      relay,
      adapter: new SandboxAgentAdapter(),
      approvalProvider: auto(bob),
    });
    const requester = new RequesterClient({ owner: alice, relay, approvalProvider: auto(alice) });
    const [w, r] = await Promise.all([
      worker.start({ once: true }),
      requester.delegate({
        to: worker.invite(),
        title: 'Echo',
        description: 'Echo JSON',
        input: { ok: true },
      }),
    ]);
    expect(w?.bundle).toEqual(r.bundle);
    expect(r.verification?.stages).toHaveLength(3);
  });
});
describe('WP-8 signed discovery, invite and relay transports', () => {
  it('registers, discovers, verifies A2A cards and rejects signature tampering', async () => {
    const { fetcher, url } = await network(),
      owner = generateKeyPair();
    const card = createSignedAgentCard(
      {
        name: 'Bob',
        agentDid: owner.did,
        relayEndpoint: url,
        skills: [
          {
            id: 'report',
            name: 'Report',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object' },
          },
        ],
      },
      owner,
    );
    const post = (value: unknown) =>
      fetcher(url + '/agents', { method: 'POST', body: JSON.stringify(value) });
    expect((await post(card)).status).toBe(201);
    expect(await (await fetcher(url + '/agents')).json()).toEqual([card]);
    expect(await (await fetcher(url + '/agents/' + encodeURIComponent(owner.did))).json()).toEqual(
      card,
    );
    const wellKnown = (await (await fetcher(url + '/.well-known/agent.json')).json()) as ReturnType<
      typeof import('../packages/core/src/index.js').toA2AAgentCard
    >;
    expect(wellKnown.skills[0].inputSchema).toEqual({ type: 'object' });
    expect(verifySignedAgentCard(wellKnown.signedAgentCard)).toBe(true);
    const changed = structuredClone(card);
    changed.payload.name = 'Mallory';
    expect((await post(changed)).status).toBe(400);
    expect((await fetcher(url + '/health')).status).toBe(200);
    for (const format of ['acp', 'acp-invite'] as const) {
      const token = createInviteToken({ agentCard: card, format }, owner);
      expect(parseAndVerifyInviteToken(token, Date.now(), { allowPrivateRelay: true }).ownerDid).toBe(
        owner.did,
      );
      expect(() => parseAndVerifyInviteToken(token, Date.now() + 7200000)).toThrow(/INVITE/);
    }
    const token = createInviteToken({ agentCard: card }, owner);
    const parsed = JSON.parse(Buffer.from(token.slice(11), 'base64url').toString());
    parsed.payload.relayUrl = 'https://evil.invalid';
    expect(() =>
      parseAndVerifyInviteToken(
        'acp-invite:' + Buffer.from(JSON.stringify(parsed)).toString('base64url'),
      ),
    ).toThrow(/INVITE/);
  });
  it('wakes long polls immediately and prevents envelope replay', async () => {
    const { fetcher, url } = await network(),
      a = generateKeyPair(),
      b = generateKeyPair();
    const pending = fetcher(
      url + '/envelopes?recipient=' + encodeURIComponent(b.did) + '&waitMs=1000',
      { headers: { authorization: 'Bearer ' + createRelayAuthToken(b, { origin: url }) } },
    );
    const envelope = signEnvelope(
      { taskId: 'task_network1', recipientDid: b.did, seq: 0, eventType: 'PING', payload: {} },
      a,
    );
    expect(
      (await fetcher(url + '/envelopes', { method: 'POST', body: JSON.stringify(envelope) }))
        .status,
    ).toBe(202);
    expect(await (await pending).json()).toEqual({ envelopes: [envelope] });
    expect(
      (await fetcher(url + '/envelopes', { method: 'POST', body: JSON.stringify(envelope) }))
        .status,
    ).toBe(400);
    expect(
      await (
        await fetcher(url + '/envelopes?recipient=' + encodeURIComponent(b.did) + '&waitMs=1', {
          headers: { authorization: 'Bearer ' + createRelayAuthToken(b, { origin: url }) },
        })
      ).json(),
    ).toEqual({ envelopes: [] });
    const bad = structuredClone(envelope);
    bad.payload.seq++;
    expect(
      (await fetcher(url + '/envelopes', { method: 'POST', body: JSON.stringify(bad) })).status,
    ).toBe(400);
  });
  it('delivers live SSE envelopes with verified signatures', async () => {
    const { fetcher, url } = await network(),
      a = generateKeyPair(),
      b = generateKeyPair(),
      controller = new AbortController();
    const client = new SseRelayClient(url, fetcher, b, { allowPrivateRelay: true }),
      iterator = client.stream(b.did, controller.signal);
    const pending = iterator.next();
    const e = signEnvelope(
      {
        taskId: 'task_stream01',
        recipientDid: b.did,
        seq: 0,
        eventType: 'PING',
        payload: { test: true },
      },
      a,
    );
    await client.send(e);
    expect((await pending).value).toEqual(e);
    await iterator.return(undefined);
    controller.abort();
  });
  it('retains the original WebSocket request/response API', async () => {
    const n = await network();
    if (!n.wsUrl) return;
    const a = generateKeyPair(),
      b = generateKeyPair();
    const client = new WebSocketRelayClient(n.wsUrl, b, { allowPrivateRelay: true });
    cleanup.push(() => client.close());
    const e = signEnvelope(
      { taskId: 'task_socket01', recipientDid: b.did, seq: 0, eventType: 'PING', payload: {} },
      a,
    );
    await client.send(e);
    expect(await client.receive(b.did)).toEqual(e);
  });
});
describe('WP-9 production approvals and isolation fallback', () => {
  it.each(['y\n', 'n\n', '\n'])(
    'requires explicit interactive confirmation (%j)',
    async (answer) => {
      const key = generateKeyPair(),
        input = new PassThrough(),
        output = new PassThrough();
      let display = '';
      output.on('data', (b) => {
        display += b.toString();
      });
      const provider = new InteractiveCliApprovalProvider(key, { input, output });
      const promise = provider.approve({
        taskId: 'task_approval01',
        gate: 'contract_acceptance',
        target: { budget: 10, capabilities: [] },
      });
      input.end(answer);
      const receipt = await promise;
      expect(verifySigned(receipt, key.did)).toBe(true);
      expect(receipt.payload.decision).toBe(answer === 'y\n' ? 'APPROVED' : 'REJECTED');
      expect(display).toContain('budget');
      expect(display).toContain('targetDigest');
    },
  );
  it('verifies the owner-signed webhook response and exact target', async () => {
    const owner = generateKeyPair(),
      target = { budget: 5 };
    const provider = new WebhookApprovalProvider(owner, {
      url: 'http://approval.local',
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        expect(verifySigned(request, owner.did)).toBe(true);
        return Response.json(
          signApproval(request.payload.taskId, request.payload.gate, request.payload.target, owner),
        );
      },
    });
    const receipt = await provider.approve({
      taskId: 'task_approval01',
      gate: 'contract_acceptance',
      target,
    });
    expect(
      verifyApproval(receipt, owner.did, 'task_approval01', 'contract_acceptance', target),
    ).toBe(true);
    const bad = new WebhookApprovalProvider(owner, {
      url: 'http://approval.local',
      fetch: async () =>
        Response.json(
          signApproval('task_approval01', 'contract_acceptance', {}, generateKeyPair()),
        ),
    });
    await expect(
      bad.approve({ taskId: 'task_approval01', gate: 'contract_acceptance', target }),
    ).rejects.toThrow(/INVALID_APPROVAL/);
  });
  it('does not auto-approve side effects or budget increases with --yes', async () => {
    const owner = generateKeyPair(),
      provider = new PolicyAutoApprovalProvider(owner, undefined, { yes: true });
    for (const gate of ['external_side_effect', 'budget_increase'] as const)
      await expect(provider.approve({ taskId: 'task_policy01', gate, target: {} })).rejects.toThrow(
        /HITL_REQUIRED/,
      );
    const explicit = new PolicyAutoApprovalProvider(owner, undefined, {
      confirmedGates: ['external_side_effect'],
    });
    expect(
      (
        await explicit.approve({
          taskId: 'task_policy01',
          gate: 'external_side_effect',
          target: {},
        })
      ).payload.decision,
    ).toBe('APPROVED');
  });
  it('detects runtime availability and falls back to a restricted subprocess', async () => {
    const seen: string[] = [];
    expect(
      await detectDockerRuntime(async (binary) => {
        seen.push(binary);
        return binary === 'docker';
      }),
    ).toBe('docker');
    expect(seen).toEqual(['podman', 'docker']);
    expect(await detectDockerRuntime(async () => false)).toBeUndefined();
    const result = await runContainerOrSubprocessSandbox({
      isolationLevel: 'oci_container',
      probe: async () => false,
      code: 'return {ok:typeof process==="undefined"};',
      timeoutMs: 2000,
      onTool: async () => null,
    });
    expect(result).toEqual({
      output: { ok: true },
      effectiveIsolationLevel: 'subprocess_restricted',
      sandboxBoundary: subprocessSandboxBoundary(),
    });
    const flags = containerArguments('/tmp/acp');
    for (const flag of ['--read-only', '--cap-drop', '--security-opt', '--pids-limit', '--memory'])
      expect(flags).toContain(flag);
    expect(flags).toContain('none');
    expect(flags).toContain('no-new-privileges');
  });
});
describe('WP-11 adversarial session enforcement', () => {
  it('rejects an unapproved contract before adapter execution', async () => {
    let executed = false;
    const adapter: AgentAdapter = {
      id: 'blocked',
      name: 'blocked',
      skills: [],
      executeTask: async () => {
        executed = true;
        return {};
      },
    };
    const provider: ApprovalProvider = {
      approve: async () => {
        throw new Error('HITL_REQUIRED');
      },
    };
    const { results } = await session(adapter, {}, undefined, provider);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(executed).toBe(false);
  });
  it('halts token overflow even if an adapter catches the usage exception', async () => {
    const adapter: AgentAdapter = {
      id: 'overrun',
      name: 'overrun',
      skills: [],
      executeTask: async (ctx) => {
        try {
          ctx.reportUsage({ inputTokens: 11 });
        } catch {
          /* malicious adapter ignores failure */
        }
        return { bad: true };
      },
    };
    const { results } = await session(adapter, { budget: { maxInputTokens: 10 } });
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });
  it('blocks unauthorized MCP calls before backend invocation', async () => {
    let calls = 0;
    const backend = await connectMCPTools(async () => {
      calls++;
      return { content: [] };
    });
    cleanup.push(backend.close);
    const adapter = new McpClientAdapter({
      client: backend.client,
      tools: { delete: { resource: () => 'mcp://docs/item', readOnly: false } },
      taskTool: 'delete',
    });
    const { results } = await session(adapter);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(calls).toBe(0);
  });
  it('halts tool-call quota overflow through MCPProxy', async () => {
    const backend = await connectMCPTools(async () => ({ content: [] }));
    cleanup.push(backend.close);
    const adapter = new McpClientAdapter({
      client: backend.client,
      tools: { read: { resource: () => 'mcp://docs/item', readOnly: true } },
      execute: async (ctx) => {
        await ctx.callTool('read', {});
        return ctx.callTool('read', {});
      },
    });
    const { results } = await session(adapter, {
      budget: { maxToolInvocations: 1 },
      capabilities: [
        {
          capabilityId: 'cap_read01',
          resource: 'mcp://docs/item',
          allowedTools: ['read'],
          maxInvocations: 3,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      ],
    });
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });
});
function cli(args: string[], options: { onLine?: (line: string) => void } = {}) {
  const child = spawn(process.execPath, ['cli/dist/index.js', ...args], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '',
    buffer = '';
  child.stdout.on('data', (b) => {
    stdout += b.toString();
    buffer += b.toString();
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      options.onLine?.(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
    }
  });
  child.stderr.on('data', (b) => {
    stderr += b.toString();
  });
  const done = new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error('CLI_EXIT_' + code + ': ' + stderr)),
    );
  });
  return { child, done };
}
it('WP-11 CLI: invite, discover, worker --once, delegate, audit-verify', async () => {
  const n = await network();
  // Separate processes need TCP. With EPERM, run the CLI command handlers
  // against the same Web fetch bridge, then verify saved audits in subprocesses.
  const dir = await directory(),
    alice = generateKeyPair(),
    bob = generateKeyPair();
  await writeFile(join(dir, 'alice.private.json'), JSON.stringify(alice), { mode: 0o600 });
  await writeFile(join(dir, 'bob.private.json'), JSON.stringify(bob), { mode: 0o600 });
  if (!n.wsUrl) {
    // Exercise command parsing/discovery using an in-process fetch bridge below.
    const { networkCommand } = await import('../cli/src/network.js');
    const original = globalThis.fetch;
    globalThis.fetch = n.fetcher;
    const output = vi.spyOn(console, 'log').mockImplementation(() => {}),
      errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await networkCommand('invite', [
        'create',
        '--key',
        join(dir, 'bob.private.json'),
        '--relay',
        n.url,
      ]);
      await networkCommand('discover', ['--relay', n.url, '--allow-private-relay']);
      await Promise.all([
        networkCommand('worker', [
          'start',
          '--key',
          join(dir, 'bob.private.json'),
          '--relay',
          n.url,
          '--allow-private-relay',
          '--adapter',
          'sandbox',
          '--auto-accept',
          '--publish',
          '--once',
          '--audit',
          join(dir, 'bob.jsonl'),
        ]),
        networkCommand('delegate', [
          '--key',
          join(dir, 'alice.private.json'),
          '--to',
          bob.did,
          '--relay',
          n.url,
          '--allow-private-relay',
          '--title',
          'Echo',
          '--description',
          'Echo JSON',
          '--input',
          '{"value":7}',
          '--auto-approve',
          '--audit',
          join(dir, 'alice.jsonl'),
          '--out',
          join(dir, 'out.json'),
        ]),
      ]);
    } finally {
      globalThis.fetch = original;
      output.mockRestore();
      errors.mockRestore();
    }
  } else {
    const invite = (
      await cli(['invite', 'create', '--key', join(dir, 'bob.private.json'), '--relay', n.url]).done
    ).trim();
    expect(parseAndVerifyInviteToken(invite, Date.now(), { allowPrivateRelay: true }).ownerDid).toBe(
      bob.did,
    );
    let ready!: (line: string) => void;
    const token = new Promise<string>((resolve) => {
      ready = resolve;
    });
    const worker = cli(
      [
        'worker',
        'start',
        '--key',
        join(dir, 'bob.private.json'),
        '--relay',
        n.url,
        '--allow-private-relay',
        '--adapter',
        'sandbox',
        '--auto-accept',
        '--publish',
        '--once',
        '--audit',
        join(dir, 'bob.jsonl'),
      ],
      {
        onLine: (line) => {
          if (line.startsWith('acp-invite:')) ready(line);
        },
      },
    );
    cleanup.push(async () => {
      worker.child.kill('SIGKILL');
      await worker.done.catch(() => {});
    });
    const workerInvite = await token;
    const found = JSON.parse(
      await cli(['discover', '--relay', n.url, '--allow-private-relay']).done,
    );
    expect(found[0].payload.ownerDid).toBe(bob.did);
    const output = await cli([
      'delegate',
      '--key',
      join(dir, 'alice.private.json'),
      '--to',
      workerInvite,
      '--allow-private-relay',
      '--title',
      'Echo',
      '--description',
      'Echo JSON',
      '--input',
      '{"value":7}',
      '--auto-approve',
      '--audit',
      join(dir, 'alice.jsonl'),
      '--out',
      join(dir, 'out.json'),
    ]).done;
    expect(JSON.parse(output).state).toBe('SETTLED');
    await worker.done;
  }
  expect(JSON.parse(await readFile(join(dir, 'out.json'), 'utf8'))).toEqual({ value: 7 });
  for (const side of ['alice', 'bob'])
    expect(JSON.parse(await cli(['audit-verify', join(dir, side + '.jsonl')]).done).status).toBe(
      'VALID',
    );
}, 20000);

it('completes a full session using persistent SSE transport', async () => {
  const n = await network(),
    alice = generateKeyPair(),
    bob = generateKeyPair();
  const aTransport = new SseRelayClient(n.url, n.fetcher, { allowPrivateRelay: true }),
    bTransport = new SseRelayClient(n.url, n.fetcher, { allowPrivateRelay: true });
  cleanup.push(
    () => aTransport.close(),
    () => bTransport.close(),
  );
  const worker = new WorkerNode({
    owner: bob,
    relay: bTransport,
    relayUrl: n.url,
    adapter: new SandboxAgentAdapter(),
    approvalProvider: auto(bob),
  });
  const client = new RequesterClient({
    owner: alice,
    relay: aTransport,
    allowPrivateRelay: true,
    approvalProvider: auto(alice),
  });
  const [w, r] = await Promise.all([
    worker.start({ once: true }),
    client.delegate({
      to: worker.invite(),
      title: 'SSE',
      description: 'SSE echo',
      input: { streaming: true },
    }),
  ]);
  expect(w?.bundle).toEqual(r.bundle);
  expect(verifyAudit(r.bundle).status).toBe('VALID');
});

it('persists the edge relay registry, queue and replay protection across restarts', async () => {
  const { RelayDurableObject } = await import('../packages/relay/src/worker.js');
  const data = new Map<string, unknown>();
  const state = {
    storage: {
      get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
      put: async (key: string, value: unknown) => {
        data.set(key, structuredClone(value));
      },
      delete: async (key: string) => data.delete(key),
    },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
  };
  const owner = generateKeyPair(),
    peer = generateKeyPair();
  const card = createSignedAgentCard(
    {
      name: 'Durable Worker',
      agentDid: owner.did,
      relayEndpoint: 'https://relay.local',
      skills: [],
    },
    owner,
  );
  const envelope = signEnvelope(
    { taskId: 'task_durable1', recipientDid: peer.did, seq: 0, eventType: 'PING', payload: {} },
    owner,
  );
  const first = new RelayDurableObject(state);
  expect(
    (
      await first.fetch(
        new Request('https://relay.local/agents', { method: 'POST', body: JSON.stringify(card) }),
      )
    ).status,
  ).toBe(201);
  expect(
    (
      await first.fetch(
        new Request('https://relay.local/envelopes', {
          method: 'POST',
          body: JSON.stringify(envelope),
        }),
      )
    ).status,
  ).toBe(202);
  const second = new RelayDurableObject(state);
  expect(await (await second.fetch(new Request('https://relay.local/agents'))).json()).toEqual([
    card,
  ]);
  expect(
    await (
      await second.fetch(
        new Request('https://relay.local/envelopes?recipient=' + encodeURIComponent(peer.did), {
          headers: {
            authorization: 'Bearer ' + createRelayAuthToken(peer, { origin: 'https://relay.local' }),
          },
        }),
      )
    ).json(),
  ).toEqual(envelope);
  const third = new RelayDurableObject(state);
  expect(
    (
      await third.fetch(
        new Request('https://relay.local/envelopes', {
          method: 'POST',
          body: JSON.stringify(envelope),
        }),
      )
    ).status,
  ).toBe(400);
});

it('rejects schema-invalid output before asking for final owner approval', async () => {
  let finalApprovalCalls = 0;
  const { results } = await session(
    new CommandAgentAdapter({ command: [process.execPath, '-e', 'console.log("{}")'] }),
    { outputSchema: { type: 'object', required: ['missing'] } },
    {
      approve: async () => {
        finalApprovalCalls++;
        throw new Error('SHOULD_NOT_ASK');
      },
    },
  );
  expect(results.every((r) => r.status === 'rejected')).toBe(true);
  expect(finalApprovalCalls).toBe(0);
});

it('keeps the real CLI provider key in the host broker and forwards only the task-scoped key to the subprocess', async () => {
  const n = await network();
  if (!n.wsUrl) return; // The real CLI broker needs a loopback socket.
  const dir = await directory(),
    script = join(dir, 'mock-claude.cjs');
  const key = 'synthetic-real-host-provider-key';
  let calls = 0;
  await writeFile(
    script,
    `#!/usr/bin/env node\nlet input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',async()=>{if(process.env.ANTHROPIC_API_KEY===${JSON.stringify(key)})process.exit(12);const r=await fetch(process.env.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',headers:{'x-api-key':process.env.ANTHROPIC_API_KEY,'content-type':'application/json'},body:JSON.stringify({prompt:JSON.parse(input)})});if(!r.ok)process.exit(13);const v=await r.json();console.log(JSON.stringify({result:JSON.stringify({value:7}),usage:v.usage}));});`,
    { mode: 0o700 },
  );
  const adapter = new ClaudeCodeAdapter({
    binaryPath: script,
    apiKey: key,
    fetch: async (_url, init) => {
      calls++;
      expect(new Headers(init?.headers).get('x-api-key')).toBe(key);
      return Response.json({ usage: { input_tokens: 8, output_tokens: 3 }, content: [] });
    },
  });
  const [result] = settled((await session(adapter)).results);
  expect(calls).toBe(1);
  expect(JSON.stringify(result)).not.toContain(key);
});

it('exercises the OCI JSON tool/usage bridge with a simulated container process', async () => {
  let usage = 0,
    toolCalls = 0;
  const result = await runContainerOrSubprocessSandbox({
    isolationLevel: 'oci_container',
    runtime: 'docker',
    timeoutMs: 2000,
    input: { value: 7 },
    code: 'const v=await callTool("read",input);await reportUsage(2,3);return v;',
    containerSpawn: (_runtime, args, options) => {
      expect(args).toContain('--read-only');
      expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
      return spawn(process.execPath, ['runner.cjs'], {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    },
    onTool: async (name, args) => {
      toolCalls++;
      expect(name).toBe('read');
      return args;
    },
    onUsage: (i, o) => {
      usage += i + o;
    },
  });
  expect(result).toEqual({
    output: { value: 7 },
    effectiveIsolationLevel: 'oci_container',
    sandboxBoundary: OCI_CONTAINER_BOUNDARY,
  });
  expect(toolCalls).toBe(1);
  expect(usage).toBe(5);
});
