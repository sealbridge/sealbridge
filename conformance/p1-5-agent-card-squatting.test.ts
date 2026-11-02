// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  agentCardDelegationStatement,
  createSignedAgentCard,
  generateKeyPair,
  MAX_AGENT_CARD_EXPIRY_MS,
  signPayload,
  verifySignedAgentCard,
} from '../packages/core/src/index.js';
import type { BudgetSpec, KeyPair, SignedAgentCard } from '../packages/core/src/index.js';
import {
  agentRegistryKey,
  createRelayFetchHandler,
  InMemoryRelay,
  selectAgentCard,
} from '../packages/relay/src/fetch.js';
import {
  emptyCursor,
  emptyRelaySnapshot,
  loadRelayState,
  planJournal,
} from '../packages/relay/src/journal.js';
import type { RelayKeyValueStorage } from '../packages/relay/src/journal.js';
import { RelayDurableObject } from '../packages/relay/src/worker.js';
import { AcpMcpServer, WorkerNode } from '../packages/runtime/src/index.js';

const relayEndpoint = 'https://relay.example';
const costModes: BudgetSpec['costBearer'][] = ['worker_byok'];

function cardFields(
  ownerDid: string,
  agentDid: string,
  expiresAt: string,
  name = 'worker',
) {
  return {
    type: 'AgentCard' as const,
    version: '0.2.0',
    description: 'ACP worker',
    costModes,
    name,
    skills: [] as { id: string; name: string }[],
    ownerDid,
    agentDid,
    relayEndpoint,
    expiresAt,
  };
}

function selfCard(owner: KeyPair, name = 'self', expiresAt?: string): SignedAgentCard {
  return createSignedAgentCard(
    {
      name,
      agentDid: owner.did,
      relayEndpoint,
      skills: [],
      ...(expiresAt ? { expiresAt } : {}),
    },
    owner,
  );
}

function delegatedCard(
  owner: KeyPair,
  agent: KeyPair,
  name = 'delegated',
  expiresAt?: string,
): SignedAgentCard {
  return createSignedAgentCard(
    {
      name,
      agentDid: agent.did,
      relayEndpoint,
      skills: [],
      ...(expiresAt ? { expiresAt } : {}),
    },
    owner,
    agent,
  );
}

function memoryStorage(): RelayKeyValueStorage & {
  state: {
    storage: RelayKeyValueStorage;
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => Promise<T>;
  };
} {
  const data = new Map<string, unknown>();
  const storage: RelayKeyValueStorage = {
    get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
    },
    delete: async (key: string) => data.delete(key),
  };
  return {
    ...storage,
    state: {
      storage,
      blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
    },
  };
}

describe('P1-5 agent card squatting', () => {
  it('rejects a card whose agentDid is not the owner and has no agent delegation', () => {
    const attacker = generateKeyPair();
    const victim = generateKeyPair();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const forged = signPayload(
      cardFields(attacker.did, victim.did, expiresAt, 'squatter'),
      attacker,
    ) as SignedAgentCard;
    expect(verifySignedAgentCard(forged)).toBe(false);
    expect(() =>
      createSignedAgentCard(
        { name: 'squatter', agentDid: victim.did, relayEndpoint, skills: [] },
        attacker,
      ),
    ).toThrow('AGENT_DELEGATION_REQUIRED');
    const relay = new InMemoryRelay();
    expect(() => relay.register(forged)).toThrow('INVALID_AGENT_CARD');
    expect(relay.discover()).toEqual([]);
  });

  it('rejects a delegation signed by the wrong key and accepts a real agent key', async () => {
    const attacker = generateKeyPair();
    const victim = generateKeyPair();
    const stranger = generateKeyPair();
    const signedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const fields = {
      ownerDid: attacker.did,
      agentDid: victim.did,
      relayEndpoint,
      expiresAt,
    };
    const wrong = signPayload(
      {
        ...cardFields(attacker.did, victim.did, expiresAt, 'wrong-key'),
        agentDelegation: signPayload(agentCardDelegationStatement(fields), attacker, signedAt)
          .signature,
      },
      attacker,
      signedAt,
    ) as SignedAgentCard;
    expect(verifySignedAgentCard(wrong)).toBe(false);
    expect(() => new InMemoryRelay().register(wrong)).toThrow('INVALID_AGENT_CARD');
    expect(() =>
      createSignedAgentCard(
        { name: 'wrong-key', agentDid: victim.did, relayEndpoint, skills: [] },
        attacker,
        stranger,
      ),
    ).toThrow('AGENT_DELEGATION_REQUIRED');

    const legitimate = delegatedCard(attacker, victim, 'legitimate');
    expect(verifySignedAgentCard(legitimate)).toBe(true);
    expect(legitimate.payload.agentDelegation?.signerDid).toBe(victim.did);
    const viaOption = createSignedAgentCard(
      {
        name: 'option-key',
        agentDid: victim.did,
        relayEndpoint,
        skills: [],
        agentKey: victim,
      },
      attacker,
    );
    expect(verifySignedAgentCard(viaOption)).toBe(true);
    const self = selfCard(victim, 'victim');
    expect(verifySignedAgentCard(self)).toBe(true);
    expect(self.payload.agentDelegation).toBeUndefined();
    expect(self.payload.expiresAt > self.signature.signedAt).toBe(true);

    const relay = new InMemoryRelay();
    const handler = createRelayFetchHandler({ relay });
    const post = (body: unknown) =>
      handler(
        new Request('https://relay.example/agents', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      );
    expect((await post(wrong)).status).toBe(400);
    expect(await (await post(wrong)).json()).toMatchObject({
      error: expect.stringContaining('INVALID_AGENT_CARD'),
    });
    expect((await post(legitimate)).status).toBe(201);
    expect((await post(self)).status).toBe(201);
    expect(relay.agents.has(agentRegistryKey(attacker.did, victim.did))).toBe(true);
    expect(relay.agents.has(agentRegistryKey(victim.did, victim.did))).toBe(true);
    expect(() => selectAgentCard(relay.discover(), victim.did)).toThrow('AMBIGUOUS_AGENT_CARD_OWNER');
  });

  it('rejects an expired card on verification, registration, and eviction', async () => {
    const owner = generateKeyPair();
    const signedAt = new Date(Date.now() - 10_000).toISOString();
    const expiredAt = new Date(Date.now() - 1_000).toISOString();
    const expired = signPayload(
      cardFields(owner.did, owner.did, expiredAt, 'expired'),
      owner,
      signedAt,
    ) as SignedAgentCard;
    expect(verifySignedAgentCard(expired)).toBe(false);
    expect(verifySignedAgentCard(expired, Date.parse(expiredAt) - 1)).toBe(true);
    expect(() =>
      createSignedAgentCard(
        {
          name: 'expired',
          agentDid: owner.did,
          relayEndpoint,
          skills: [],
          expiresAt: expiredAt,
        },
        owner,
      ),
    ).toThrow('INVALID_AGENT_CARD');
    const freshSignedAt = new Date().toISOString();
    const tooLongAt = new Date(Date.parse(freshSignedAt) + MAX_AGENT_CARD_EXPIRY_MS + 1_000).toISOString();
    const tooLong = signPayload(
      cardFields(owner.did, owner.did, tooLongAt, 'too-long'),
      owner,
      freshSignedAt,
    ) as SignedAgentCard;
    expect(verifySignedAgentCard(tooLong)).toBe(false);

    let now = Date.now();
    const expiresAt = new Date(now + 5_000).toISOString();
    const relay = new InMemoryRelay({ now: () => now, agentCardTtlMs: 60_000 });
    const live = selfCard(owner, 'live', expiresAt);
    relay.register(live);
    expect(relay.snapshot().agentExpiry).toEqual([
      [agentRegistryKey(owner.did, owner.did), Date.parse(expiresAt)],
    ]);
    const handler = createRelayFetchHandler({ relay });
    expect(
      (
        await handler(
          new Request('https://relay.example/agents', {
            method: 'POST',
            body: JSON.stringify(expired),
          }),
        )
      ).status,
    ).toBe(400);
    now = Date.parse(expiresAt);
    expect(verifySignedAgentCard(live, now)).toBe(false);
    expect(() => relay.register(live)).toThrow('INVALID_AGENT_CARD');
    expect(relay.discover()).toEqual([]);

    let ttlNow = Date.now();
    const longLived = selfCard(
      owner,
      'ttl',
      new Date(ttlNow + 60 * 60 * 1000).toISOString(),
    );
    const ttlRelay = new InMemoryRelay({ now: () => ttlNow, agentCardTtlMs: 1_000 });
    ttlRelay.register(longLived);
    expect(ttlRelay.snapshot().agentExpiry?.[0]?.[1]).toBe(ttlNow + 1_000);
    ttlNow += 1_000;
    expect(ttlRelay.discover()).toEqual([]);
  });

  it('keys the registry by owner and agent and restores that pair', async () => {
    const owner = generateKeyPair();
    const other = generateKeyPair();
    const agent = generateKeyPair();
    const attacker = generateKeyPair();
    const self = selfCard(owner, 'owner');
    const delegated = delegatedCard(owner, agent, 'owner-agent');
    const otherDelegated = delegatedCard(other, agent, 'other-agent');
    const attackerSelf = selfCard(attacker, 'attacker');
    const forged = signPayload(
      cardFields(attacker.did, agent.did, new Date(Date.now() + 60_000).toISOString(), 'forged'),
      attacker,
    ) as SignedAgentCard;

    const relay = new InMemoryRelay();
    relay.register(attackerSelf);
    expect(() => relay.register(forged)).toThrow('INVALID_AGENT_CARD');
    relay.register(self);
    relay.register(delegated);
    relay.register(otherDelegated);
    expect(() => relay.register(delegated)).not.toThrow();
    const older = signPayload(delegated.payload, owner, new Date(Date.now() - 60_000).toISOString());
    expect(() => relay.register(older as SignedAgentCard)).toThrow('AGENT_OWNER_OR_VERSION_MISMATCH');
    expect(relay.discover()).toHaveLength(4);
    expect(relay.agents.has(agentRegistryKey(owner.did, agent.did))).toBe(true);
    expect(relay.agents.has(agentRegistryKey(other.did, agent.did))).toBe(true);
    expect(() => selectAgentCard(relay.agents.values(), agent.did)).toThrow('AMBIGUOUS_AGENT_CARD_OWNER');
    expect(selectAgentCard(relay.agents.values(), owner.did)?.payload.name).toBe('owner');

    const handler = createRelayFetchHandler({ relay });
    const get = (path: string) => handler(new Request('https://relay.example' + path));
    expect(
      await (
        await get(
          '/agents/' +
            encodeURIComponent(owner.did) +
            '/' +
            encodeURIComponent(agent.did),
        )
      ).json(),
    ).toEqual(delegated);
    const ambiguous = await get('/agents/' + encodeURIComponent(agent.did));
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json()).toEqual({ error: 'AMBIGUOUS_AGENT_CARD_OWNER' });
    expect(await (await get('/agents/' + encodeURIComponent(owner.did))).json()).toEqual(self);
    expect(
      await (
        await get(
          '/agents?ownerDid=' +
            encodeURIComponent(other.did) +
            '&agentDid=' +
            encodeURIComponent(agent.did),
        )
      ).json(),
    ).toEqual([otherDelegated]);

    const snapshot = relay.snapshot();
    const plan = planJournal(
      emptyCursor(relay.maxSeenEntries, relay.maxAuthSeenEntries),
      emptyRelaySnapshot(),
      snapshot,
    );
    expect(plan.cursor.agents.map((entry) => entry.did).sort()).toEqual(
      [
        agentRegistryKey(attacker.did, attacker.did),
        agentRegistryKey(owner.did, owner.did),
        agentRegistryKey(owner.did, agent.did),
        agentRegistryKey(other.did, agent.did),
      ].sort(),
    );
    const storage = memoryStorage();
    for (const put of plan.puts) await storage.put(put.key, put.value);
    await storage.put('meta', plan.meta);
    const loaded = await loadRelayState(storage, Date.now(), {
      seenMod: relay.maxSeenEntries,
      authMod: relay.maxAuthSeenEntries,
    });
    const restored = new InMemoryRelay();
    restored.restore(loaded.snapshot!);
    expect(restored.discover()).toEqual(relay.discover());
    const again = planJournal(plan.cursor, snapshot, restored.snapshot());
    expect(again.puts.filter((put) => put.key.startsWith('agent'))).toEqual([]);

    const durable = new RelayDurableObject(storage.state);
    const postCard = (card: SignedAgentCard) =>
      durable.fetch(
        new Request('https://relay.example/agents', {
          method: 'POST',
          body: JSON.stringify(card),
        }),
      );
    expect((await postCard(forged)).status).toBe(400);
    expect((await postCard(self)).status).toBe(201);
    expect((await postCard(delegated)).status).toBe(201);
    const restarted = new RelayDurableObject(storage.state);
    const listed = (await (
      await restarted.fetch(new Request('https://relay.example/agents'))
    ).json()) as SignedAgentCard[];
    expect(listed.map((card) => card.payload.name).sort()).toEqual(
      ['attacker', 'owner', 'owner-agent', 'other-agent'].sort(),
    );
    expect(
      await (
        await restarted.fetch(
          new Request(
            'https://relay.example/agents/' +
              encodeURIComponent(owner.did) +
              '/' +
              encodeURIComponent(agent.did),
          ),
        )
      ).json(),
    ).toEqual(delegated);
  });

  it('requires the worker agent key at the runtime call sites that separate agentDid from ownerDid', async () => {
    const owner = generateKeyPair();
    const agent = generateKeyPair();
    const relay = new InMemoryRelay();
    const adapter = {
      id: 'echo',
      name: 'echo',
      skills: [],
      executeTask: async () => ({ ok: true }),
    };
    expect(
      () =>
        new WorkerNode({ checkPeer: () => 'trusted',
          owner,
          agentDid: agent.did,
          relay,
          adapter,
        }),
    ).toThrow('AGENT_DELEGATION_REQUIRED');
    const worker = new WorkerNode({ checkPeer: () => 'trusted',
      owner,
      agentDid: agent.did,
      agentKey: agent,
      relay,
      adapter,
    });
    await worker.register();
    expect(relay.discover()[0]?.payload.agentDid).toBe(agent.did);
    expect(verifySignedAgentCard(worker.agentCard)).toBe(true);

    const denied = await new AcpMcpServer({ owner }).handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'acp_create_invite',
        arguments: { relayUrl: relayEndpoint, agentDid: agent.did },
      },
    });
    expect(JSON.stringify(denied)).toContain('AGENT_DELEGATION_REQUIRED');
    const allowed = await new AcpMcpServer({ owner, agentKey: agent }).handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'acp_create_invite',
        arguments: { relayUrl: relayEndpoint, agentDid: agent.did },
      },
    });
    expect(JSON.stringify(allowed)).not.toContain('AGENT_DELEGATION_REQUIRED');
    expect(JSON.stringify(allowed)).toContain('acp-invite:');
  });
});
