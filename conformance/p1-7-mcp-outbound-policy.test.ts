// SPDX-License-Identifier: Apache-2.0
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createInviteToken,
  createSignedAgentCard,
  digest,
  generateKeyPair,
  signApproval,
  verifyApproval,
} from '../packages/core/src/index.js';
import type { KeyPair } from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import {
  AcpMcpServer,
  PolicyAutoApprovalProvider,
  WebhookApprovalProvider,
  WorkerNode,
  normalizeMcpRelayUrl,
} from '../packages/runtime/src/index.js';
import type { ApprovalProvider } from '../packages/runtime/src/index.js';
import {
  mcpServerCommand,
  mcpServerOptionsFromArgs,
  parseMcpServerArgs,
} from '../cli/src/mcp.js';

const allowedRelay = 'https://relay.example/acp';

function fetchUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function inviteFor(owner: KeyPair, relayEndpoint: string, agent?: KeyPair): string {
  const agentDid = agent?.did ?? owner.did;
  const card = createSignedAgentCard(
    {
      name: 'worker',
      agentDid,
      relayEndpoint,
      skills: [{ id: 'json-task', name: 'JSON task' }],
    },
    owner,
    agent && agent.did !== owner.did ? agent : undefined,
  );
  return createInviteToken({ agentCard: card }, owner);
}

function echoWorker(owner: KeyPair, relay: InMemoryRelay, tag: string, agent?: KeyPair) {
  return new WorkerNode({
    owner,
    relay,
    relayUrl: allowedRelay + '/',
    agentDid: agent?.did,
    agentKey: agent,
    adapter: {
      id: tag,
      name: tag,
      skills: [],
      executeTask: async (context) => ({ tag, input: context.input }),
    },
    approvalProvider: new PolicyAutoApprovalProvider(owner),
    timeoutMs: 10000,
  });
}

async function callTool(server: AcpMcpServer, name: string, args: Record<string, unknown>) {
  const response = await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const result = (
    response as { result: { isError?: boolean; content: Array<{ text: string }> } }
  ).result;
  return {
    isError: result.isError === true,
    body: JSON.parse(result.content[0].text) as Record<string, unknown>,
  };
}

async function expectBlocked(
  run: () => Promise<{ isError: boolean; body: Record<string, unknown> }>,
  code: string,
  relay?: InMemoryRelay,
) {
  const calls: string[] = [];
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    calls.push(fetchUrl(input));
    throw new Error('UNEXPECTED_NETWORK');
  });
  const send = relay ? vi.spyOn(relay, 'send') : undefined;
  try {
    const result = await run();
    expect(result.isError).toBe(true);
    expect(result.body.error).toBe(code);
    expect(calls).toEqual([]);
    if (send) expect(send).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    send?.mockRestore();
  }
}

describe('MCP relay URL normalization', () => {
  it('compares origin and pathname without a trailing slash', () => {
    expect(normalizeMcpRelayUrl('https://Relay.Example/acp/?x=1#frag')).toBe(
      'https://relay.example/acp',
    );
    expect(normalizeMcpRelayUrl('https://relay.example/acp/')).toBe('https://relay.example/acp');
    expect(normalizeMcpRelayUrl('https://relay.example')).toBe('https://relay.example');
  });
});

describe('MCP outbound allowlists', () => {
  it('rejects invalid worker and relay configuration', () => {
    const owner = generateKeyPair();
    expect(() => new AcpMcpServer({ owner, allowedWorkerDids: ['not-a-did'] })).toThrow(
      'INVALID_WORKER_DID',
    );
    expect(() => new AcpMcpServer({ owner, allowedWorkerDids: ['did:key:zzzz'] })).toThrow(
      'INVALID_WORKER_DID',
    );
    expect(() => new AcpMcpServer({ owner, allowedRelayUrls: ['file:///etc/passwd'] })).toThrow(
      'SSRF_BLOCKED_RELAY_URL',
    );
    expect(
      () =>
        new AcpMcpServer({
          owner,
          allowedRelayUrls: ['http://127.0.0.1/relay'],
          allowPrivateRelay: false,
        }),
    ).toThrow('SSRF_BLOCKED_RELAY_URL');
    expect(() => new AcpMcpServer({ owner, approvalWebhookUrl: 'file:///tmp/hook' })).toThrow(
      'INVALID_APPROVAL_WEBHOOK_URL',
    );
  });

  it('rejects unlisted workers and relays, including values inside invite tokens', async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const eve = generateKeyPair();
    const relay = new InMemoryRelay();
    const bobInvite = inviteFor(bob, allowedRelay + '/');
    const eveInvite = inviteFor(eve, allowedRelay);
    const evilInvite = inviteFor(bob, 'https://evil.example/steal');
    const server = new AcpMcpServer({
      owner: alice,
      relay,
      allowedWorkerDids: [bob.did],
      allowedRelayUrls: [allowedRelay],
    });

    await expectBlocked(
      () =>
        callTool(server, 'acp_delegate_task', {
          workerDid: eve.did,
          title: 'Plain DID',
          input: { secret: 'task' },
        }),
      'MCP_WORKER_NOT_ALLOWED',
      relay,
    );
    await expectBlocked(
      () =>
        callTool(server, 'acp_delegate_task', {
          inviteToken: eveInvite,
          title: 'Invite worker',
          input: { secret: 'task' },
        }),
      'MCP_WORKER_NOT_ALLOWED',
      relay,
    );
    await expectBlocked(
      () =>
        callTool(server, 'acp_delegate_task', {
          inviteToken: evilInvite,
          title: 'Invite relay',
          input: { secret: 'task' },
        }),
      'MCP_RELAY_NOT_ALLOWED',
      relay,
    );
    await expectBlocked(
      () =>
        callTool(server, 'acp_delegate_task', {
          inviteToken: bobInvite,
          relayUrl: 'https://evil.example/steal',
          title: 'Arg relay',
          input: { secret: 'task' },
        }),
      'MCP_RELAY_NOT_ALLOWED',
      relay,
    );
    await expectBlocked(
      () =>
        callTool(server, 'acp_delegate_multi', {
          mode: 'race',
          title: 'One outsider',
          workers: [
            { workerDid: bob.did, inviteToken: bobInvite },
            { workerDid: eve.did, inviteToken: eveInvite },
          ],
        }),
      'MCP_WORKER_NOT_ALLOWED',
      relay,
    );
    await expectBlocked(
      () =>
        callTool(server, 'acp_delegate_multi', {
          mode: 'quorum',
          title: 'Evil relay',
          quorumSize: 1,
          workers: [
            { workerDid: bob.did, inviteToken: bobInvite },
            { workerDid: bob.did, inviteToken: evilInvite, relayUrl: 'https://evil.example/steal' },
          ],
        }),
      'MCP_RELAY_NOT_ALLOWED',
      relay,
    );
  });

  it('does not follow an invite or tool relay that differs from the configured relay', async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const pinned = new AcpMcpServer({
      owner: alice,
      relay: 'https://good.example/relay/',
      allowedWorkerDids: [bob.did],
    });
    await expectBlocked(
      () =>
        callTool(pinned, 'acp_delegate_task', {
          inviteToken: inviteFor(bob, 'https://evil.example/steal'),
          title: 'Switch',
        }),
      'MCP_RELAY_NOT_ALLOWED',
    );
    await expectBlocked(
      () =>
        callTool(pinned, 'acp_delegate_task', {
          inviteToken: inviteFor(bob, 'https://good.example/relay'),
          relayUrl: 'https://evil.example/steal',
          title: 'Override',
        }),
      'MCP_RELAY_NOT_ALLOWED',
    );

    const calls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      calls.push(fetchUrl(input));
      throw new Error('UNEXPECTED_NETWORK');
    });
    try {
      const opened = new AcpMcpServer({
        owner: alice,
        relay: 'https://good.example/relay',
        allowAnyRelay: true,
        allowedWorkerDids: [bob.did],
      });
      const result = await callTool(opened, 'acp_delegate_task', {
        inviteToken: inviteFor(bob, 'https://good.example/relay'),
        relayUrl: 'https://evil.example/steal',
        title: 'Opt in',
        description: 'Dial the named relay',
      });
      expect(result.body.error).not.toBe('MCP_RELAY_NOT_ALLOWED');
      expect(calls.some((url) => url.startsWith('https://evil.example/steal'))).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('blocks a metadata relay embedded in an invite before dialing', async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const server = new AcpMcpServer({
      owner: alice,
      relay: 'https://good.example/relay',
      allowAnyRelay: true,
    });
    await expectBlocked(
      () =>
        callTool(server, 'acp_delegate_task', {
          inviteToken: inviteFor(bob, 'http://169.254.169.254/latest'),
          title: 'Metadata',
        }),
      'SSRF_BLOCKED_RELAY_URL',
    );
  });

  it('delegates when the worker DID and normalized relay URL are allowlisted', async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const carol = generateKeyPair();
    const dave = generateKeyPair();
    const agent = generateKeyPair();
    const relay = new InMemoryRelay();
    const bobNode = echoWorker(bob, relay, 'bob');
    const carolNode = echoWorker(carol, relay, 'carol');
    const agentNode = echoWorker(dave, relay, 'agent', agent);
    const server = new AcpMcpServer({
      owner: alice,
      relay,
      allowedWorkerDids: [bob.did, carol.did],
      allowedRelayUrls: ['https://Relay.Example/acp'],
    });
    const ownerOnly = new AcpMcpServer({
      owner: alice,
      relay,
      allowedWorkerDids: [dave.did],
      allowedRelayUrls: [allowedRelay + '/'],
    });
    const agentOnly = new AcpMcpServer({
      owner: alice,
      relay,
      allowedWorkerDids: [agent.did],
      allowedRelayUrls: [allowedRelay],
    });
    const pending = Promise.all([bobNode.start(), carolNode.start(), agentNode.start()]);
    try {
      const single = await callTool(server, 'acp_delegate_task', {
        inviteToken: bobNode.invite(),
        title: 'Echo',
        description: 'Return the input',
        input: { hello: 'mcp' },
      });
      expect(single.isError).toBe(false);
      expect(single.body.status).toBe('SETTLED');
      expect(single.body.deliverable).toEqual({ tag: 'bob', input: { hello: 'mcp' } });

      const multi = await callTool(server, 'acp_delegate_multi', {
        mode: 'race',
        title: 'Either',
        description: 'First verified echo',
        input: { n: 2 },
        workers: [
          { workerDid: bob.did, inviteToken: bobNode.invite() },
          { workerDid: carol.did, inviteToken: carolNode.invite() },
        ],
      });
      expect(multi.isError).toBe(false);
      expect(multi.body.status).toBe('SETTLED');

      const byOwner = await callTool(ownerOnly, 'acp_delegate_task', {
        inviteToken: agentNode.invite(),
        title: 'Owner DID',
        description: 'Allow the invite owner',
        input: { via: 'owner' },
      });
      expect(byOwner.isError).toBe(false);
      expect(byOwner.body.deliverable).toEqual({ tag: 'agent', input: { via: 'owner' } });

      const byAgent = await callTool(agentOnly, 'acp_delegate_task', {
        inviteToken: agentNode.invite(),
        title: 'Agent DID',
        description: 'Allow the invite agent',
        input: { via: 'agent' },
      });
      expect(byAgent.isError).toBe(false);
      expect(byAgent.body.deliverable).toEqual({ tag: 'agent', input: { via: 'agent' } });
    } finally {
      bobNode.stop();
      carolNode.stop();
      agentNode.stop();
      await pending.catch(() => undefined);
    }
  });
});

describe('MCP outbound approval', () => {
  it('signs an owner decision from WebhookApprovalProvider and rejects denials', async () => {
    const owner = generateKeyPair();
    const target = { hello: 'outbound' };
    let body: Record<string, unknown> | undefined;
    const provider = new WebhookApprovalProvider(owner, {
      url: 'https://hooks.example/approve',
      response: 'owner-decision',
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ approved: true });
      },
    });
    const receipt = await provider.approve({
      taskId: 'task_mcp_1',
      gate: 'external_side_effect',
      target,
      details: { reason: 'outbound delegation to a remote Sealbridge worker' },
    });
    expect(body).toEqual({
      taskId: 'task_mcp_1',
      summaryHash: digest(target),
      reason: 'outbound delegation to a remote Sealbridge worker',
      approverDid: owner.did,
    });
    expect(verifyApproval(receipt, owner.did, 'task_mcp_1', 'external_side_effect', target)).toBe(
      true,
    );
    const deny = new WebhookApprovalProvider(owner, {
      url: 'https://hooks.example/approve',
      response: 'owner-decision',
      fetch: async () => Response.json({ approved: false }),
    });
    await expect(
      deny.approve({ taskId: 'task_mcp_1', gate: 'external_side_effect', target }),
    ).rejects.toThrow('APPROVAL_REJECTED');
    const down = new WebhookApprovalProvider(owner, {
      url: 'https://hooks.example/approve',
      response: 'owner-decision',
      fetch: async () => new Response('no', { status: 502 }),
    });
    await expect(
      down.approve({ taskId: 'task_mcp_1', gate: 'external_side_effect', target }),
    ).rejects.toThrow('APPROVAL_REJECTED');
  });

  it('approves and rejects MCP delegation through approvalWebhookUrl', async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const relay = new InMemoryRelay();
    const bobNode = echoWorker(bob, relay, 'bob');
    const posts: Array<Record<string, unknown>> = [];
    const sendDuringApproval = vi.spyOn(relay, 'send');
    const fetcher: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (posts.length === 0) expect(sendDuringApproval).not.toHaveBeenCalled();
      posts.push(body);
      return Response.json({ approved: true });
    };
    const server = new AcpMcpServer({
      owner: alice,
      relay,
      allowedWorkerDids: [bob.did],
      allowedRelayUrls: [allowedRelay],
      approvalWebhookUrl: 'https://hooks.example/approve',
      approvalWebhookFetcher: fetcher,
    });
    const pending = bobNode.start();
    try {
      const result = await callTool(server, 'acp_delegate_task', {
        inviteToken: bobNode.invite(),
        title: 'Webhook',
        description: 'Webhook approves the send',
        input: { n: 1 },
      });
      expect(result.isError).toBe(false);
      expect(result.body.status).toBe('SETTLED');
      expect(result.body.deliverable).toEqual({ tag: 'bob', input: { n: 1 } });
      expect(posts[0]).toMatchObject({
        reason: 'outbound delegation to a remote Sealbridge worker',
        approverDid: alice.did,
      });
      expect(posts[0].summaryHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(posts.length).toBeGreaterThan(1);
    } finally {
      sendDuringApproval.mockRestore();
      bobNode.stop();
      await pending.catch(() => undefined);
    }

    const deniedPosts: unknown[] = [];
    const denied = new AcpMcpServer({
      owner: alice,
      relay,
      allowedWorkerDids: [bob.did],
      allowedRelayUrls: [allowedRelay],
      approvalWebhookUrl: 'https://hooks.example/approve',
      approvalWebhookFetcher: async (_url, init) => {
        deniedPosts.push(JSON.parse(String(init?.body)));
        return Response.json({ approved: false });
      },
    });
    const send = vi.spyOn(relay, 'send');
    try {
      const rejected = await callTool(denied, 'acp_delegate_task', {
        inviteToken: bobNode.invite(),
        title: 'Denied',
        description: 'Decline this task',
        input: { n: 2 },
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.body.error).toBe('APPROVAL_REJECTED');
      expect(deniedPosts).toHaveLength(1);
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
    }

    const unavailable = new AcpMcpServer({
      owner: alice,
      relay,
      allowedWorkerDids: [bob.did],
      allowedRelayUrls: [allowedRelay],
      approvalWebhookUrl: 'https://hooks.example/approve',
      approvalWebhookFetcher: async () => new Response('down', { status: 503 }),
    });
    const again = await callTool(unavailable, 'acp_delegate_multi', {
      mode: 'race',
      title: 'Down',
      description: 'Unavailable webhook',
      workers: [{ workerDid: bob.did, inviteToken: bobNode.invite() }],
    });
    expect(again.body.error).toBe('APPROVAL_REJECTED');
  });

  it('honors a custom approval provider before sending', async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const relay = new InMemoryRelay();
    const bobNode = echoWorker(bob, relay, 'bob');
    let calls = 0;
    const approve: ApprovalProvider = {
      async approve(request) {
        calls += 1;
        return signApproval(request.taskId, request.gate, request.target, alice, 'APPROVED');
      },
    };
    const server = new AcpMcpServer({
      owner: alice,
      relay,
      allowedWorkerDids: [bob.did],
      allowedRelayUrls: [allowedRelay],
      approvalProvider: approve,
    });
    const pending = bobNode.start();
    try {
      const result = await callTool(server, 'acp_delegate_task', {
        inviteToken: bobNode.invite(),
        title: 'Custom',
        description: 'Custom provider approves the send',
        input: { ok: true },
      });
      expect(result.body.status).toBe('SETTLED');
      expect(result.body.deliverable).toEqual({ tag: 'bob', input: { ok: true } });
      expect(calls).toBeGreaterThan(0);
    } finally {
      bobNode.stop();
      await pending.catch(() => undefined);
    }

    calls = 0;
    const reject: ApprovalProvider = {
      async approve(request) {
        calls += 1;
        return signApproval(request.taskId, request.gate, request.target, alice, 'REJECTED');
      },
    };
    const denied = new AcpMcpServer({
      owner: alice,
      relay,
      approvalProvider: reject,
    });
    const send = vi.spyOn(relay, 'send');
    try {
      const result = await callTool(denied, 'acp_delegate_task', {
        inviteToken: bobNode.invite(),
        title: 'No',
        description: 'Reject this task',
        input: { ok: false },
      });
      expect(result.body.error).toBe('APPROVAL_REJECTED');
      expect(calls).toBe(1);
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
    }
  });

  it('returns an immediate channel error without consuming terminal streams', async () => {
    const owner = generateKeyPair();
    const worker = generateKeyPair();
    const relay = new InMemoryRelay();
    const input = new PassThrough();
    Object.assign(input, { isTTY: true });
    const output = new PassThrough();
    const shown: unknown[] = [];
    output.on('data', (chunk) => shown.push(chunk));
    const server = new AcpMcpServer({ owner, relay, requireInteractiveApproval: true });
    const send = vi.spyOn(relay, 'send');
    const result = await callTool(server, 'acp_delegate_task', {
      inviteToken: inviteFor(worker, allowedRelay), title: 'Host approval', input: { ask: true },
    });
    expect(result.body.error).toMatch(/APPROVAL_CHANNEL_UNAVAILABLE.*host.*elicitation.*--approval-webhook/);
    expect(shown).toEqual([]);
    expect(input.listenerCount('data')).toBe(0);
    expect(send).not.toHaveBeenCalled();
    input.destroy();
    output.destroy();
  });
});

describe('MCP tool disclosure and CLI flags', () => {
  it('states that delegation transmits input externally', async () => {
    const server = new AcpMcpServer({ owner: generateKeyPair() });
    const listed = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (listed as { result: { tools: Array<{ name: string; description: string }> } })
      .result.tools;
    const task = tools.find((tool) => tool.name === 'acp_delegate_task');
    const multi = tools.find((tool) => tool.name === 'acp_delegate_multi');
    expect(task?.description).toMatch(/transmitted externally/i);
    expect(task?.description).toMatch(/relay/i);
    expect(multi?.description).toMatch(/transmitted externally/i);
    expect(multi?.description).toMatch(/worker/i);
  });

  it('parses allowlists and approval flags for acp mcp-server', async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const carol = generateKeyPair();
    const parsed = parseMcpServerArgs([
      '--relay',
      allowedRelay,
      '--allow-worker',
      alice.did,
      '--allow-worker',
      bob.did + ',' + carol.did,
      '--allow-relay',
      'https://relay.example/acp/,https://other.example',
      '--allow-relay',
      'https://third.example/path',
      '--require-approval',
    ]);
    expect(parsed.allowedWorkerDids).toEqual([alice.did, bob.did, carol.did]);
    expect(parsed.allowedRelayUrls).toEqual([
      'https://relay.example/acp/',
      'https://other.example',
      'https://third.example/path',
    ]);
    expect(parsed.requireInteractiveApproval).toBe(true);
    expect(parsed.allowPrivateRelay).toBe(false);
    expect(parsed.relay).toBe(allowedRelay);
    const privateRelay = parseMcpServerArgs(['--allow-private-relay']);
    expect(privateRelay.allowPrivateRelay).toBe(true);
    expect(
      mcpServerOptionsFromArgs(privateRelay, alice).allowPrivateRelay,
    ).toBe(true);
    const webhook = parseMcpServerArgs(['--approval-webhook', 'https://hooks.example/acp']);
    expect(webhook.approvalWebhookUrl).toBe('https://hooks.example/acp');
    expect(webhook.requireInteractiveApproval).toBe(false);
    expect(() =>
      parseMcpServerArgs([
        '--require-approval',
        '--approval-webhook',
        'https://hooks.example/acp',
      ]),
    ).toThrow(/require-approval/);
    expect(() => parseMcpServerArgs(['--allow-worker'])).toThrow('Missing --allow-worker');
    expect(() => parseMcpServerArgs(['--allow-relay'])).toThrow('Missing --allow-relay');

    const owner = generateKeyPair();
    expect(() =>
      new AcpMcpServer(
        mcpServerOptionsFromArgs(parseMcpServerArgs(['--allow-worker', 'did:key:not-valid']), owner),
      ),
    ).toThrow('INVALID_WORKER_DID');
    expect(() =>
      new AcpMcpServer(
        mcpServerOptionsFromArgs(parseMcpServerArgs(['--allow-relay', 'file:///etc/passwd']), owner),
      ),
    ).toThrow('SSRF_BLOCKED_RELAY_URL');
    expect(() =>
      new AcpMcpServer(
        mcpServerOptionsFromArgs(
          parseMcpServerArgs(['--approval-webhook', 'notaurl']),
          owner,
        ),
      ),
    ).toThrow('INVALID_APPROVAL_WEBHOOK_URL');
    await expect(mcpServerCommand(['--allow-worker'])).rejects.toThrow('Missing --allow-worker');
  });
});
