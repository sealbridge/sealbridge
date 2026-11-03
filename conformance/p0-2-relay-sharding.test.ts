// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRelayAuthToken,
  createSignedAgentCard,
  generateKeyPair,
  signEnvelope,
} from '../packages/core/src/index.js';
import type { Json, SignedEnvelope } from '../packages/core/src/index.js';
import { createRelayFetchHandler, InMemoryRelay } from '../packages/relay/src/fetch.js';
import relayWorker, {
  RelayDurableObject,
  resetRelayRateLimits,
} from '../packages/relay/src/worker.js';

afterEach(() => {
  vi.useRealTimers();
  resetRelayRateLimits();
});

function envelope(
  sender: ReturnType<typeof generateKeyPair>,
  recipientDid: string,
  payload: Json = { ok: true },
): SignedEnvelope {
  return signEnvelope(
    { taskId: 'task_p0_2', recipientDid, seq: 0, eventType: 'PING', payload },
    sender,
  );
}

function card(owner: ReturnType<typeof generateKeyPair>, name: string) {
  return createSignedAgentCard(
    { name, agentDid: owner.did, relayEndpoint: 'https://relay.example', skills: [] },
    owner,
  );
}

describe('P0-2 per-inbox byte cap', () => {
  it('rejects an envelope that would exceed maxQueueBytesPerRecipient and accepts again after ack or TTL', async () => {
    const alice = generateKeyPair();
    const carol = generateKeyPair();
    const bob = generateKeyPair();
    let now = 1_000_000;
    const first = envelope(alice, bob.did, { n: 1 });
    const second = envelope(alice, bob.did, { n: 2 });
    const third = envelope(alice, bob.did, { n: 3 });
    const pairBytes =
      Buffer.byteLength(JSON.stringify(first)) + Buffer.byteLength(JSON.stringify(second));
    const relay = new InMemoryRelay({
      maxQueueBytesPerRecipient: pairBytes,
      maxQueueSize: 10,
      maxEnvelopesPerSender: 10,
      envelopeTtlMs: 1_000,
      now: () => now,
    });
    relay.send(first);
    relay.send(second);
    expect(() => relay.send(third)).toThrow('RELAY_RETRY_LATER');
    expect(relay.snapshot().queues[0]?.[1]).toHaveLength(2);

    const handler = createRelayFetchHandler({ relay });
    const denied = await handler(
      new Request('https://relay.example/envelopes', {
        method: 'POST',
        body: JSON.stringify(third),
      }),
    );
    expect(denied.status).toBe(429);
    expect(await denied.json()).toEqual({ error: 'RELAY_RETRY_LATER', retryable: true, retryAfterMs: 60000 });
    expect(Number(denied.headers.get('retry-after'))).toBeGreaterThan(0);

    expect(relay.receive(bob.did)).toEqual(first);
    const afterAck = envelope(alice, bob.did, { n: 4 });
    expect(() => relay.send(afterAck)).not.toThrow();

    const held = envelope(alice, bob.did, { n: 6 });
    const other = envelope(carol, bob.did, { n: 5 });
    const capped = new InMemoryRelay({
      maxQueueBytesPerRecipient: Buffer.byteLength(JSON.stringify(held)),
      maxEnvelopesPerSender: 10,
      maxQueueSize: 10,
      envelopeTtlMs: 500,
      now: () => now,
    });
    capped.send(held);
    expect(() => capped.send(other)).toThrow('RELAY_RETRY_LATER');
    const staleId = capped.snapshot().queues[0]![1][0]!.payload.envelopeId;
    expect(
      capped.acknowledge(bob.did, staleId, createRelayAuthToken(bob)),
    ).toBe(true);
    expect(() => capped.send(other)).not.toThrow();

    const expiringEnvelope = envelope(alice, bob.did, { n: 7 });
    const expiring = new InMemoryRelay({
      maxQueueBytesPerRecipient: Buffer.byteLength(JSON.stringify(expiringEnvelope)),
      maxQueueSize: 10,
      envelopeTtlMs: 500,
      now: () => now,
    });
    expiring.send(expiringEnvelope);
    expect(() => expiring.send(envelope(alice, bob.did, { n: 8 }))).toThrow(
      'RELAY_RETRY_LATER',
    );
    now += 501;
    expect(() => expiring.send(envelope(alice, bob.did, { n: 9 }))).not.toThrow();
    expect(expiring.snapshot().queues[0]?.[1]).toHaveLength(1);
  });

  it('stops one sender from filling an inbox that still has room for someone else', () => {
    const alice = generateKeyPair();
    const carol = generateKeyPair();
    const bob = generateKeyPair();
    const relay = new InMemoryRelay({ maxEnvelopesPerSender: 1, maxQueueSize: 8 });
    relay.send(envelope(alice, bob.did, { n: 1 }));
    expect(() => relay.send(envelope(alice, bob.did, { n: 2 }))).toThrow('RELAY_RETRY_LATER');
    expect(() => relay.send(envelope(carol, bob.did, { n: 3 }))).not.toThrow();
    expect(relay.snapshot().queues[0]?.[1]).toHaveLength(2);
  });
});

describe('P0-2 TTL eviction', () => {
  it('drops expired queued envelopes, replay ids, and agent cards', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const carol = generateKeyPair();
    let now = 5_000;
    const relay = new InMemoryRelay({
      envelopeTtlMs: 1_000,
      seenTtlMs: 1_000,
      agentCardTtlMs: 1_000,
      maxAgents: 1,
      now: () => now,
    });
    const queued = envelope(alice, bob.did, { n: 1 });
    relay.send(queued);
    relay.register(card(alice, 'alice'));
    expect(() => relay.register(card(carol, 'carol'))).toThrow('RELAY_CAPACITY');
    expect(relay.discover()).toHaveLength(1);
    expect(relay.receive(bob.did)).toEqual(queued);
    expect(() => relay.send(queued)).toThrow('REPLAYED_ENVELOPE');

    now += 1_001;
    expect(relay.discover()).toEqual([]);
    expect(relay.snapshot().queues).toEqual([]);
    expect(() => relay.send(queued)).not.toThrow();
    relay.register(card(carol, 'carol'));
    expect(relay.discover().map((entry) => entry.payload.name)).toEqual(['carol']);
    expect(relay.receive(bob.did)?.payload.payload).toEqual({ n: 1 });
  });
});

describe('P0-2 per-IP rate limit', () => {
  it('returns 429 after the sliding window is exhausted and allows another IP', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T00:00:00.000Z'));
    const bob = generateKeyPair();
    const names: string[] = [];
    const env = {
      ACP_RATE_LIMIT_MAX: '2',
      ACP_RATE_LIMIT_WINDOW_MS: '60000',
      RELAY: {
        idFromName: (name: string) => {
          names.push(name);
          return name;
        },
        get: (id: unknown) => ({
          fetch: async () => Response.json({ routed: id }),
        }),
      },
    };
    const post = (ip: string) =>
      relayWorker.fetch(
        new Request('https://relay.example/v1/envelopes', {
          method: 'POST',
          headers: { 'cf-connecting-ip': ip, 'content-type': 'application/json' },
          body: JSON.stringify({ payload: { recipientDid: bob.did } }),
        }),
        env,
      );
    expect((await post('203.0.113.10')).status).toBe(200);
    expect((await post('203.0.113.10')).status).toBe(200);
    const limited = await post('203.0.113.10');
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'RATE_LIMITED' });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(names).toEqual(['inbox:' + bob.did, 'inbox:' + bob.did]);
    expect((await post('203.0.113.11')).status).toBe(200);

    vi.setSystemTime(new Date('2026-10-27T00:01:01.000Z'));
    expect((await post('203.0.113.10')).status).toBe(200);

    const poll = await relayWorker.fetch(
      new Request('https://relay.example/envelopes?recipient=' + encodeURIComponent(bob.did), {
        headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' },
      }),
      { ...env, ACP_RATE_LIMIT_MAX: '1' },
    );
    expect(poll.status).toBe(200);
    const pollAgain = await relayWorker.fetch(
      new Request('https://relay.example/envelopes?recipient=' + encodeURIComponent(bob.did), {
        headers: { 'x-forwarded-for': '198.51.100.7' },
      }),
      { ...env, ACP_RATE_LIMIT_MAX: '1' },
    );
    expect(pollAgain.status).toBe(429);

    const agent = await relayWorker.fetch(
      new Request('https://relay.example/v1/agents', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '203.0.113.50', 'content-type': 'application/json' },
        body: '{}',
      }),
      { ...env, ACP_RATE_LIMIT_MAX: '1' },
    );
    expect(agent.status).toBe(200);
    expect(names.at(-1)).toBe('registry');
    const agentAgain = await relayWorker.fetch(
      new Request('https://relay.example/agents', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '203.0.113.50' },
        body: '{}',
      }),
      { ...env, ACP_RATE_LIMIT_MAX: '1' },
    );
    expect(agentAgain.status).toBe(429);
  });
});

describe('P0-2 O(1) durable writes', () => {
  it('writes a constant number of keys for one POST regardless of inbox or registry size', async () => {
    const storage = memoryStorage();
    const object = new RelayDurableObject(storage.state);
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const counts: number[] = [];
    const metaSizes: number[] = [];
    const saved: SignedEnvelope[] = [];
    for (let i = 0; i < 24; i++) {
      storage.puts.length = 0;
      const message = envelope(alice, bob.did, { marker: 'ACPITEM' + String(i).padStart(4, '0') + 'END' });
      saved.push(message);
      const response = await object.fetch(
        new Request('https://relay.example/envelopes', {
          method: 'POST',
          body: JSON.stringify(message),
        }),
      );
      expect(response.status).toBe(202);
      counts.push(storage.puts.length);
      const meta = storage.puts.find((put) => put.key === 'meta');
      expect(meta).toBeDefined();
      metaSizes.push(meta!.bytes);
      const bodies = storage.puts.map((put) => put.json).join('\n');
      for (let older = 0; older < i; older++)
        expect(bodies).not.toContain('ACPITEM' + String(older).padStart(4, '0') + 'END');
    }
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[0]).toBeLessThanOrEqual(5);
    expect(Math.max(...metaSizes)).toBeLessThan(512);
    expect(storage.puts.every((put) => /^(env:\d+|seen:\d+|meta)$/.test(put.key))).toBe(true);

    const agentPuts: number[] = [];
    for (let i = 0; i < 12; i++) {
      storage.puts.length = 0;
      const owner = generateKeyPair();
      const response = await object.fetch(
        new Request('https://relay.example/agents', {
          method: 'POST',
          body: JSON.stringify(card(owner, 'agent-' + i)),
        }),
      );
      expect(response.status).toBe(201);
      agentPuts.push(storage.puts.length);
    }
    expect(new Set(agentPuts).size).toBe(1);
    expect(agentPuts[0]).toBeLessThanOrEqual(5);

    const restarted = new RelayDurableObject(storage.state);
    const listed = (await (
      await restarted.fetch(new Request('https://relay.example/agents'))
    ).json()) as Array<{ payload: { name: string } }>;
    expect(listed).toHaveLength(12);
    const replay = await restarted.fetch(
      new Request('https://relay.example/envelopes', {
        method: 'POST',
        body: JSON.stringify(saved[0]),
      }),
    );
    expect(replay.status).toBe(400);
  });
});

describe('P0-2 edge sharding', () => {
  it('routes each recipient inbox separately from the registry and rejects a bad DID first', async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const names: string[] = [];
    const env = {
      RELAY: {
        idFromName: (name: string) => {
          names.push(name);
          return name;
        },
        get: () => ({
          fetch: async () => Response.json({ status: 'ok' }),
        }),
      },
    };
    const health = await relayWorker.fetch(new Request('https://relay.example/health'), env);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
    expect(names).toEqual([]);

    const missing = await relayWorker.fetch(new Request('https://relay.example/envelopes'), env);
    expect(missing.status).toBe(400);
    const invalid = await relayWorker.fetch(
      new Request('https://relay.example/v1/envelopes?recipient=not-a-did'),
      env,
    );
    expect(invalid.status).toBe(400);
    const badPost = await relayWorker.fetch(
      new Request('https://relay.example/envelopes', {
        method: 'POST',
        body: JSON.stringify({ payload: { recipientDid: 'did:key:nope' } }),
      }),
      env,
    );
    expect(badPost.status).toBe(400);
    expect(names).toEqual([]);

    await relayWorker.fetch(
      new Request('https://relay.example/envelopes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: { recipientDid: bob.did } }),
      }),
      env,
    );
    await relayWorker.fetch(
      new Request(
        'https://relay.example/v1/envelopes?recipient=' + encodeURIComponent(alice.did),
      ),
      env,
    );
    await relayWorker.fetch(
      new Request(
        'https://relay.example/envelopes/env-1?recipient=' + encodeURIComponent(bob.did),
        { method: 'DELETE' },
      ),
      env,
    );
    await relayWorker.fetch(
      new Request('https://relay.example/stream?recipient=' + encodeURIComponent(bob.did)),
      env,
    );
    await relayWorker.fetch(new Request('https://relay.example/v1/agents'), env);
    await relayWorker.fetch(
      new Request('https://relay.example/agents', { method: 'POST', body: '{}' }),
      env,
    );
    await relayWorker.fetch(new Request('https://relay.example/.well-known/agent.json'), env);
    expect(names).toEqual([
      'inbox:' + bob.did,
      'inbox:' + alice.did,
      'inbox:' + bob.did,
      'inbox:' + bob.did,
      'registry',
      'registry',
      'registry',
    ]);
  });

  it('serves an envelope stored by the pre-sharding snapshot and then drops that blob', async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const queued = envelope(alice, bob.did, { legacy: true });
    const raw = Buffer.from(
      JSON.stringify({
        queues: [[bob.did, [queued]]],
        seen: [queued.payload.envelopeId],
        authSeen: [],
        agents: [],
      }),
    );
    const data = new Map<string, unknown>();
    data.set('relay-head', { generation: 'legacy', count: 1 });
    data.set('relay:legacy:0', new Uint8Array(raw));
    const state = {
      storage: {
        get: async <T>(key: string): Promise<T | undefined> =>
          structuredClone(data.get(key)) as T | undefined,
        put: async (key: string, value: unknown) => {
          data.set(key, structuredClone(value));
        },
        delete: async (key: string) => data.delete(key),
      },
      blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
    };
    const object = new RelayDurableObject(state);
    const response = await object.fetch(
      new Request('https://relay.example/envelopes?recipient=' + encodeURIComponent(bob.did), {
        headers: {
          authorization: 'Bearer ' + createRelayAuthToken(bob, { origin: 'https://relay.example' }),
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(queued);
    expect(data.has('relay-head')).toBe(false);
    expect(data.has('meta')).toBe(true);
  });
});

function memoryStorage() {
  const data = new Map<string, unknown>();
  const puts: { key: string; bytes: number; json: string }[] = [];
  return {
    puts,
    state: {
      storage: {
        get: async <T>(key: string): Promise<T | undefined> =>
          structuredClone(data.get(key)) as T | undefined,
        put: async (key: string, value: unknown) => {
          const json = JSON.stringify(value);
          puts.push({ key, bytes: Buffer.byteLength(json), json });
          data.set(key, structuredClone(value));
        },
        delete: async (key: string) => data.delete(key),
      },
      blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
    },
  };
}
