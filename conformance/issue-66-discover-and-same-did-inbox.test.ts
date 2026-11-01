// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  createRelayAuthToken,
  createSignedAgentCard,
  generateKeyPair,
  signEnvelope,
  signPayload,
  verifySignedAgentCard,
} from '../packages/core/src/index.js';
import type { SignedAgentCard, SignedEnvelope } from '../packages/core/src/index.js';
import { verifyAudit } from '../packages/ledger/src/index.js';
import {
  createRelayFetchHandler,
  HttpRelayClient,
  InMemoryRelay,
  startLocalRelay,
} from '../packages/relay/src/index.js';
import { RelayDurableObject } from '../packages/relay/src/worker.js';
import {
  AcpMcpServer,
  PolicyAutoApprovalProvider,
  RequesterClient,
  WorkerNode,
} from '../packages/runtime/src/index.js';

function memoryDurableState(initial?: Map<string, unknown>) {
  const data = initial ?? new Map<string, unknown>();
  return {
    data,
    state: {
      storage: {
        get: async <T>(key: string): Promise<T | undefined> =>
          structuredClone(data.get(key)) as T | undefined,
        put: async (key: string, value: unknown) => {
          data.set(key, structuredClone(value));
        },
        delete: async (key: string) => data.delete(key),
      },
      blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
    },
  };
}

describe('Improvement 1: expired and invalid AgentCard resilience in discover and delegate', () => {
  it('prunes expired or malformed cards in InMemoryRelay, HTTP relay, DurableObject, and MCP discover', async () => {
    let now = Date.now();
    const relay = new InMemoryRelay({ now: () => now });
    const staleOwner = generateKeyPair();
    const liveOwner = generateKeyPair();

    const shortCard = createSignedAgentCard(
      {
        name: 'Short-lived Worker',
        agentDid: staleOwner.did,
        relayEndpoint: 'https://relay.example',
        skills: [{ id: 'echo', name: 'Echo' }],
        expiresAt: new Date(now + 2_000).toISOString(),
      },
      staleOwner,
    );
    const liveCard = createSignedAgentCard(
      {
        name: 'Live Worker',
        agentDid: liveOwner.did,
        relayEndpoint: 'https://relay.example',
        skills: [{ id: 'echo', name: 'Echo' }],
        expiresAt: new Date(now + 60_000).toISOString(),
      },
      liveOwner,
    );
    relay.register(shortCard);
    relay.register(liveCard);

    // Advance clock past shortCard's expiry and inject a corrupted legacy card without expiresAt.
    now += 5_000;
    const legacyPoison = signPayload(
      {
        type: 'AgentCard' as const,
        version: '0.2.0',
        description: 'Legacy card missing expiresAt',
        costModes: ['worker_byok' as const],
        name: 'Legacy Poison',
        skills: [{ id: 'json-task', name: 'JSON task' }],
        ownerDid: staleOwner.did,
        agentDid: staleOwner.did,
        relayEndpoint: 'https://relay.example',
      },
      staleOwner,
    ) as unknown as SignedAgentCard;
    relay.agents.set('legacy/poison', legacyPoison);

    const discovered = relay.discover();
    expect(discovered).toEqual([liveCard]);
    expect(relay.agents.has('legacy/poison')).toBe(false);

    const handler = createRelayFetchHandler({ relay, allowUnboundRelayAuth: true });
    const httpClient = new HttpRelayClient(
      'https://relay.example',
      (input, init) => handler(new Request(input, init)),
      liveOwner,
    );
    expect(await httpClient.discover()).toEqual([liveCard]);

    const mcp = new AcpMcpServer({
      owner: liveOwner,
      relay: {
        send: (e) => relay.send(e),
        receive: (did, waitMs, signal, filter) =>
          relay.receive(did, undefined, signal, undefined, filter),
        // Return a mix of valid, expired, and malformed cards from a custom transport.
        discover: async () => [
          signPayload(
            {
              ...shortCard.payload,
              expiresAt: new Date(Date.now() - 1_000).toISOString(),
            },
            staleOwner,
            new Date(Date.now() - 10_000).toISOString(),
          ) as SignedAgentCard,
          legacyPoison,
          liveCard,
        ],
      },
    });
    const mcpResponse = (await mcp.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'acp_discover_workers', arguments: { accessMode: 'all' } },
    })) as { result?: { structuredContent?: { count: number; workers: Array<{ name: string }> } } };
    expect(mcpResponse.result?.structuredContent?.count).toBe(1);
    expect(mcpResponse.result?.structuredContent?.workers.map((w) => w.name)).toEqual([
      'Live Worker',
    ]);
  });

  it('migrates legacy DurableObject storage containing pre-expiry cards without throwing INVALID_RELAY_SNAPSHOT', async () => {
    const owner = generateKeyPair();
    const legacyCard = signPayload(
      {
        type: 'AgentCard' as const,
        version: '0.2.0',
        description: 'Sealbridge worker',
        costModes: ['worker_byok' as const],
        name: 'Cloudflare E2E Bob',
        agentDid: owner.did,
        relayEndpoint: 'https://acp-relay.agent-collab.workers.dev',
        skills: [{ id: 'json-task', name: 'JSON task' }],
        ownerDid: owner.did,
      },
      owner,
      '2026-10-25T23:46:17.908Z',
    );
    const validOwner = generateKeyPair();
    const validCard = createSignedAgentCard(
      {
        name: 'Valid Worker',
        agentDid: validOwner.did,
        relayEndpoint: 'https://acp-relay.agent-collab.workers.dev',
        skills: [{ id: 'json-task', name: 'JSON task' }],
      },
      validOwner,
    );
    const raw = Buffer.from(
      JSON.stringify({
        queues: [],
        seen: [],
        authSeen: [],
        agents: [legacyCard, validCard],
      }),
    );
    const initial = new Map<string, unknown>();
    initial.set('relay-head', { generation: 'legacy', count: 1 });
    initial.set('relay:legacy:0', new Uint8Array(raw));
    const { data, state } = memoryDurableState(initial);
    const durable = new RelayDurableObject(state);
    const res = await durable.fetch(new Request('https://acp-relay.agent-collab.workers.dev/agents'));
    expect(res.status).toBe(200);
    const listed = (await res.json()) as SignedAgentCard[];
    expect(listed).toEqual([validCard]);
    expect(listed.every((c) => verifySignedAgentCard(c))).toBe(true);
    expect(data.has('relay-head')).toBe(false);
  });

  it('completes DID-targeted delegation when unrelated expired cards exist and selects the newest valid card', async () => {
    const requesterKey = generateKeyPair();
    const workerOwner = generateKeyPair();
    const workerAgent = generateKeyPair();
    const poisonedOwner = generateKeyPair();
    const baseRelay = new InMemoryRelay();

    const expiredCard = signPayload(
      {
        type: 'AgentCard' as const,
        version: '0.2.0',
        description: 'Expired third-party worker',
        costModes: ['worker_byok' as const],
        name: 'Expired Worker',
        skills: [],
        ownerDid: poisonedOwner.did,
        agentDid: poisonedOwner.did,
        relayEndpoint: 'https://relay.example',
        expiresAt: new Date(Date.now() - 10_000).toISOString(),
      },
      poisonedOwner,
      new Date(Date.now() - 20_000).toISOString(),
    ) as SignedAgentCard;

    const olderValidCard = createSignedAgentCard(
      {
        name: 'Older Worker Card',
        agentDid: workerAgent.did,
        relayEndpoint: 'https://relay.example',
        skills: [],
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      },
      workerOwner,
      workerAgent,
    );
    const newerValidCard = createSignedAgentCard(
      {
        name: 'Newer Worker Card',
        agentDid: workerAgent.did,
        relayEndpoint: 'https://relay.example',
        skills: [],
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
      workerOwner,
      workerAgent,
    );

    const customRelay = {
      send: (e: SignedEnvelope) => baseRelay.send(e),
      receive: (
        did: string,
        _waitMs?: number,
        signal?: AbortSignal,
        filter?: Parameters<typeof baseRelay.receive>[4],
      ) => baseRelay.receive(did, undefined, signal, undefined, filter),
      discover: async () => [expiredCard, olderValidCard, newerValidCard],
    };

    const worker = new WorkerNode({
      accessMode: 'open',
      owner: workerOwner,
      agentDid: workerAgent.did,
      agentKey: workerAgent,
      relay: customRelay,
      approvalProvider: new PolicyAutoApprovalProvider(workerOwner),
      adapter: {
        id: 'echo',
        name: 'echo',
        skills: [],
        executeTask: async (ctx) => ({ echoed: ctx.input, workerAgent: ctx.manifest.worker?.agentDid ?? '' }),
      },
    });
    const workerPromise = worker.start({ once: true });

    const client = new RequesterClient({
      owner: requesterKey,
      relay: customRelay,
      approvalProvider: new PolicyAutoApprovalProvider(requesterKey),
      timeoutMs: 5000,
    });

    const result = await client.delegate({
      to: workerAgent.did,
      title: 'Delegate by DID with poisoned registry',
      description: 'Should ignore expired third-party card and resolve workerOwner via newest card',
      input: { hello: 'world' },
    });
    await workerPromise;
    expect(result.state).toBe('SETTLED');
    expect(result.deliverable).toEqual({
      echoed: { hello: 'world' },
      workerAgent: workerAgent.did,
    });
    expect(verifyAudit(result.bundle).valid).toBe(true);
  });
});

describe('Improvement 2: same-DID concurrent WorkerNode + RequesterClient and non-destructive peek', () => {
  it('supports non-destructive peek via InMemoryRelay, HTTP /envelopes?peek=true, and /inbox/:did?peek=1', async () => {
    const server = await startLocalRelay();
    try {
      const alice = generateKeyPair();
      const bob = generateKeyPair();
      const client = new HttpRelayClient(server.url, bob, { allowPrivateRelay: true });
      const env1 = signEnvelope(
        {
          taskId: 'task_peek_1',
          recipientDid: bob.did,
          seq: 0,
          eventType: 'PROPOSE',
          payload: { n: 1 },
        },
        alice,
      );
      await client.send(env1);

      // Peek via HttpRelayClient.peek
      const peeked1 = await client.peek(bob.did, { role: 'worker', taskId: 'task_peek_1' });
      expect(peeked1).toEqual(env1);

      // Peek via GET /inbox/:did?peek=1
      const inboxPeekRes = await fetch(
        server.url + '/inbox/' + encodeURIComponent(bob.did) + '?peek=1&role=worker',
        {
          headers: {
            authorization: 'Bearer ' + createRelayAuthToken(bob, { origin: server.url }),
          },
        },
      );
      expect(inboxPeekRes.status).toBe(200);
      expect(await inboxPeekRes.json()).toEqual(env1);

      // Peek with waitMs returns { envelopes } without dequeuing
      const longPeekRes = await fetch(
        server.url +
          '/envelopes?recipient=' +
          encodeURIComponent(bob.did) +
          '&waitMs=50&peek=true&taskId=task_peek_1',
        {
          headers: {
            authorization: 'Bearer ' + createRelayAuthToken(bob, { origin: server.url }),
          },
        },
      );
      expect(longPeekRes.status).toBe(200);
      expect(await longPeekRes.json()).toEqual({ envelopes: [env1] });

      // Filtering for role=requester returns 204 because env1 is PROPOSE (role=worker)
      const nonMatchingPeek = await client.peek(bob.did, { role: 'requester' });
      expect(nonMatchingPeek).toBeUndefined();

      // Now normal receive dequeues env1 once, and the queue is then empty.
      const consumed = await client.receive(bob.did, undefined, undefined, { role: 'worker' });
      expect(consumed).toEqual(env1);
      expect(await client.peek(bob.did)).toBeUndefined();
      expect(await client.receive(bob.did)).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('allows two agents to simultaneously run WorkerNode and RequesterClient on the same DID over HTTP relay', async () => {
    const server = await startLocalRelay();
    const grokKey = generateKeyPair();
    const dotsKey = generateKeyPair();

    const grokWorker = new WorkerNode({
      accessMode: 'open',
      owner: grokKey,
      relay: server.url,
      allowPrivateRelay: true,
      publishToRegistry: true,
      approvalProvider: new PolicyAutoApprovalProvider(grokKey),
      adapter: {
        id: 'grok-worker',
        name: 'Grok Worker',
        skills: [{ id: 'review', name: 'Review' }],
        executeTask: async (ctx) => {
          await new Promise((r) => setTimeout(r, 30));
          return { handledBy: 'grok', input: ctx.input };
        },
      },
    });

    const dotsWorker = new WorkerNode({
      accessMode: 'open',
      owner: dotsKey,
      relay: server.url,
      allowPrivateRelay: true,
      publishToRegistry: true,
      approvalProvider: new PolicyAutoApprovalProvider(dotsKey),
      adapter: {
        id: 'dots-worker',
        name: 'Dots Worker',
        skills: [{ id: 'audit', name: 'Audit' }],
        executeTask: async (ctx) => {
          await new Promise((r) => setTimeout(r, 30));
          return { handledBy: 'dots', input: ctx.input };
        },
      },
    });

    const grokWorkerLoop = grokWorker.start();
    const dotsWorkerLoop = dotsWorker.start();

    try {
      // Wait for both workers to register and start polling their respective inboxes.
      await new Promise((r) => setTimeout(r, 50));

      // Now create RequesterClients using the EXACT SAME DIDs (grokKey and dotsKey)
      // while grokWorker and dotsWorker are actively polling the same inboxes!
      const grokRequester = new RequesterClient({
        owner: grokKey,
        relay: server.url,
        allowPrivateRelay: true,
        approvalProvider: new PolicyAutoApprovalProvider(grokKey),
        timeoutMs: 10000,
      });
      const dotsRequester = new RequesterClient({
        owner: dotsKey,
        relay: server.url,
        allowPrivateRelay: true,
        approvalProvider: new PolicyAutoApprovalProvider(dotsKey),
        timeoutMs: 10000,
      });

      const [grokToDots, dotsToGrok] = await Promise.all([
        grokRequester.delegate({
          to: dotsKey.did,
          title: 'Task from Grok to Dots',
          description: 'Concurrent bidirectional delegation 1',
          input: { direction: 'grok->dots' },
        }),
        dotsRequester.delegate({
          to: grokKey.did,
          title: 'Task from Dots to Grok',
          description: 'Concurrent bidirectional delegation 2',
          input: { direction: 'dots->grok' },
        }),
      ]);

      expect(grokToDots.state).toBe('SETTLED');
      expect(grokToDots.deliverable).toEqual({
        handledBy: 'dots',
        input: { direction: 'grok->dots' },
      });
      expect(verifyAudit(grokToDots.bundle).valid).toBe(true);

      expect(dotsToGrok.state).toBe('SETTLED');
      expect(dotsToGrok.deliverable).toEqual({
        handledBy: 'grok',
        input: { direction: 'dots->grok' },
      });
      expect(verifyAudit(dotsToGrok.bundle).valid).toBe(true);
    } finally {
      grokWorker.stop();
      dotsWorker.stop();
      await Promise.allSettled([grokWorkerLoop, dotsWorkerLoop]);
      await server.close();
    }
  });

  it('supports same-DID self-delegation where WorkerNode and RequesterClient share one DID', async () => {
    const relay = new InMemoryRelay();
    const sameKey = generateKeyPair();

    const worker = new WorkerNode({
      accessMode: 'open',
      owner: sameKey,
      relay,
      publishToRegistry: true,
      approvalProvider: new PolicyAutoApprovalProvider(sameKey),
      adapter: {
        id: 'self-worker',
        name: 'Self Worker',
        skills: [],
        executeTask: async (ctx) => ({ selfEcho: ctx.input }),
      },
    });
    const workerRun = worker.start({ once: true });

    const requester = new RequesterClient({
      owner: sameKey,
      relay,
      approvalProvider: new PolicyAutoApprovalProvider(sameKey),
      timeoutMs: 5000,
    });

    const [settledWorker, settledRequester] = await Promise.all([
      workerRun,
      requester.delegate({
        to: sameKey.did,
        title: 'Self delegation',
        description: 'Same DID acts as both requester and worker',
        input: { ping: 'pong' },
      }),
    ]);

    expect(settledRequester.state).toBe('SETTLED');
    expect(settledRequester.deliverable).toEqual({ selfEcho: { ping: 'pong' } });
    expect(settledWorker?.state).toBe('SETTLED');
    expect(verifyAudit(settledRequester.bundle).valid).toBe(true);
  });
});
