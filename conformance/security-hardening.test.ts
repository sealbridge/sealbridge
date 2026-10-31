// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import {
  createRelayAuthToken,
  verifyRelayAuthToken,
  generateKeyPair,
  signPayload,
  signEnvelope,
  createContract,
  createSignedAgentCard,
  createInviteToken,
  parseAndVerifyInviteToken,
  validateRelayEndpointUrl,
  signApproval,
  validateManifest,
} from '../packages/core/src/index.js';
import type { Json, RelayAuthAction, RelayAuthPayload } from '../packages/core/src/index.js';
import {
  createRelayAuthToken as edgeToken,
  verifyRelayAuthToken as edgeVerify,
} from '../packages/core/src/edge.js';
import {
  InMemoryRelay,
  createRelayFetchHandler,
  startLocalRelay,
  HttpRelayClient,
  SseRelayClient,
  WebSocketRelayClient,
} from '../packages/relay/src/index.js';
import { RelayDurableObject } from '../packages/relay/src/worker.js';
import {
  buildTaskManifest,
  createDelivery,
  OwnerGateway,
  VerificationEngine,
  RequesterClient,
  WorkerNode,
  PolicyAutoApprovalProvider,
} from '../packages/runtime/src/index.js';
import { SandboxAgentAdapter } from '../packages/adapters/src/index.js';

describe('root agent operating instructions', () => {
  const setup =
    'git clone https://github.com/acidnyan/agent-collab-platform.git && cd agent-collab-platform && pnpm install --frozen-lockfile && pnpm build';
  it.each(['AGENTS.md', 'SKILL.md'])(
    '%s documents setup, both roles, and safety boundaries',
    (file) => {
      const path = new URL('../' + file, import.meta.url);
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, 'utf8').replace(/\s+/g, ' ');
      expect(content).toContain(setup);
      for (const trigger of [
        'ワーカーとして待機して',
        '招待トークンを出して',
        'Act as a worker and wait for tasks',
        'この acp-invite:... トークンに仕事を依頼して',
        'Delegate this task to <acp-invite:...>',
      ])
        expect(content).toContain(trigger);
      expect(content).toContain('mkdir -p ~/.acp && chmod 700 ~/.acp');
      expect(content).toContain('Omit `--key`');
      expect(content).toContain('identities/requester.private.json');
      expect(content).toContain('identities/worker.private.json');
      for (const command of [
        'pnpm sealbridge relay start --port 8787 --host 127.0.0.1',
        'pnpm sealbridge worker start [--relay <URL>]',
        'pnpm sealbridge delegate --to "<acp-invite:...>"',
        'pnpm sealbridge audit-verify ~/.acp/audit-<taskId>.jsonl',
        'pnpm sealbridge invite create [--relay <URL>]',
        'pnpm sealbridge discover [--relay <URL>]',
        'pnpm sealbridge validate <manifest.json>',
      ])
        expect(content).toContain(command);
      expect(content).toContain(
        'Never print, log, commit, or transmit the contents of `*.private.json`, API keys, or `.env` in chat history, logs, or Git commits.',
      );
      expect(content).toContain(
        'Only `did:key:...` public identifiers and `acp-invite:...` tokens may be shared externally',
      );
      expect(content).toContain('Always obtain explicit human owner confirmation');
      for (const gate of [
        'external_side_effect',
        'budget_increase',
        'contract_acceptance',
        'final_verification',
      ])
        expect(content).toContain('`' + gate + '`');
      for (const option of ['--auto-accept', '--auto-approve'])
        expect(content).toContain('`' + option + '`');
      expect(content).toContain('explicitly authorized by the owner');
    },
  );
  it('SKILL.md starts with the required valid YAML frontmatter and README links both entry points', () => {
    const skill = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8').replace(
      /\r\n/g,
      '\n',
    );
    // Requiring these exact plain YAML scalars verifies valid frontmatter without
    // adding a YAML parser dependency just for this fixed metadata contract.
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill);
    expect(frontmatter?.[1]).toBe(
      [
        'name: sealbridge',
        "description: Autonomous cross-owner agent collaboration via Sealbridge. Use when asked to act as a Sealbridge Worker (wait for delegated tasks, issue acp-invite tokens), delegate a task to another owner's agent via an acp-invite token or DID over a Blind Relay, discover remote agents, or verify bilateral hash-chained audit logs.",
      ].join('\n'),
    );
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    for (const file of ['AGENTS.md', 'SKILL.md']) expect(readme).toContain(`[${file}](${file})`);
  });
});

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const alice = generateKeyPair(),
  bob = generateKeyPair(),
  eve = generateKeyPair();
const envelope = (recipientDid = bob.did) =>
  signEnvelope(
    { taskId: 'task_security01', recipientDid, seq: 0, eventType: 'PING', payload: { ok: true } },
    alice,
  );
const encode = (payload: unknown, key = bob) =>
  Buffer.from(JSON.stringify(signPayload(payload, key))).toString('base64url');
const payload = (action: RelayAuthAction = 'receive'): RelayAuthPayload => ({
  type: 'RelayAuth',
  recipientDid: bob.did,
  action,
  timestamp: new Date().toISOString(),
  nonce: 'test-nonce',
});
const headers = (
  key = bob,
  action: RelayAuthAction = 'receive',
  origin = 'https://relay.example',
) => ({
  authorization: 'Bearer ' + createRelayAuthToken(key, { action, origin }),
});
const recipientPath = (path: string, did = bob.did) =>
  path + '?recipient=' + encodeURIComponent(did);
const attacks = [
  'missing',
  'malformed',
  'tampered',
  'wrong signer',
  'wrong recipient',
  'expired',
  'future',
  'replayed',
  'wrong action',
] as const;
function attackToken(
  attack: (typeof attacks)[number],
  action: RelayAuthAction,
  origin = 'https://relay.example',
): string | undefined {
  switch (attack) {
    case 'missing':
      return;
    case 'malformed':
      return 'not-a-token';
    case 'tampered': {
      const signed = JSON.parse(
        Buffer.from(createRelayAuthToken(bob, { action, origin }), 'base64url').toString(),
      );
      signed.payload.nonce += 'changed';
      return Buffer.from(JSON.stringify(signed)).toString('base64url');
    }
    case 'wrong signer':
      return encode(payload(action), eve);
    case 'wrong recipient':
      return createRelayAuthToken(eve, { action, origin });
    case 'expired':
      return createRelayAuthToken(bob, {
        action,
        origin,
        now: new Date(Date.now() - 300001).toISOString(),
      });
    case 'future':
      return createRelayAuthToken(bob, {
        action,
        origin,
        now: new Date(Date.now() + 600000).toISOString(),
      });
    case 'replayed':
      return createRelayAuthToken(bob, { action, origin });
    case 'wrong action':
      return createRelayAuthToken(bob, {
        action: action === 'receive' ? 'stream' : 'receive',
        origin,
      });
  }
}

describe('M3.1 RelayAuth signatures', () => {
  it('exports compatible helpers from core and edge and creates unique nonces', () => {
    const a = createRelayAuthToken(bob),
      b = edgeToken(bob);
    expect(a).not.toBe(b);
    expect(edgeVerify(a, bob.did)).toMatchObject({ valid: true, action: 'receive' });
    expect(verifyRelayAuthToken(b, bob.did).valid).toBe(true);
    expect(verifyRelayAuthToken(a, eve.did).valid).toBe(false);
  });
  it.each(['receive', 'stream', 'subscribe'] as const)(
    'binds the %s action, time and nonce',
    (action) => {
      const now = Date.parse('2026-10-26T00:00:00.000Z');
      const token = createRelayAuthToken(bob, {
        action,
        now: new Date(now).toISOString(),
        nonce: 'chosen',
      });
      expect(verifyRelayAuthToken(token, bob.did, { now: now + 300000 })).toEqual({
        valid: true,
        nonce: 'chosen',
        action,
      });
      expect(verifyRelayAuthToken(token, bob.did, { now: now - 300000 }).valid).toBe(true);
      expect(verifyRelayAuthToken(token, bob.did, { now: now + 300001 }).valid).toBe(false);
      expect(verifyRelayAuthToken(token, bob.did, { now: now - 300001 }).valid).toBe(false);
      expect(verifyRelayAuthToken(token, bob.did, { now: now + 1, maxSkewMs: 0 }).valid).toBe(
        false,
      );
    },
  );
  it.each([
    { type: 'Other' },
    { recipientDid: eve.did },
    { nonce: '' },
    { nonce: ' ' },
    { nonce: 1 },
    { timestamp: 'invalid' },
    { timestamp: null },
    { action: 'delete' },
  ])('rejects a signed invalid payload %j', (patch) => {
    expect(verifyRelayAuthToken(encode({ ...payload(), ...patch }), bob.did)).toEqual({
      valid: false,
      error: 'RELAY_UNAUTHORIZED',
    });
  });
  it('keeps direct compatibility while verifying every supplied token and strict mode', () => {
    const relay = new InMemoryRelay(),
      e = envelope();
    relay.send(e);
    expect(() => relay.receive(bob.did, '')).toThrow('RELAY_UNAUTHORIZED');
    expect(() => relay.receive(bob.did, createRelayAuthToken(eve))).toThrow('RELAY_UNAUTHORIZED');
    expect(relay.receive(bob.did)).toEqual(e);
    const strict = new InMemoryRelay({ requireAuth: true });
    strict.send(e);
    expect(() => strict.receive(bob.did)).toThrow('RELAY_UNAUTHORIZED');
    expect(strict.receive(bob.did, createRelayAuthToken(bob))).toEqual(e);
  });
});

describe.each(['/envelopes', '/stream'])('M3.1 HTTP %s authentication', (path) => {
  const action = path === '/stream' ? 'stream' : 'receive';
  it.each(attacks)('blocks %s without draining the queue', async (attack) => {
    const relay = new InMemoryRelay(),
      handler = createRelayFetchHandler({ relay }),
      token = attackToken(attack, action);
    if (attack === 'replayed') {
      const first = await handler(
        new Request('https://relay.example' + recipientPath(path), {
          headers: { authorization: 'Bearer ' + token },
        }),
      );
      expect(first.ok).toBe(true);
      if (path === '/stream') await first.body!.cancel();
    }
    const e = envelope();
    relay.send(e);
    const r = await handler(
      new Request('https://relay.example' + recipientPath(path), {
        headers: token === undefined ? {} : { authorization: 'Bearer ' + token },
      }),
    );
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'RELAY_UNAUTHORIZED' });
    const legitimate = await handler(
      new Request('https://relay.example' + recipientPath('/envelopes'), { headers: headers() }),
    );
    expect(legitimate.status).toBe(200);
    expect(await legitimate.json()).toEqual(e);
  });
  it.each(['authorization', 'x-acp-relay-auth'] as const)(
    'accepts fresh auth via %s',
    async (source) => {
      const relay = new InMemoryRelay({ requireAuth: true }),
        handler = createRelayFetchHandler({ relay }),
        token = createRelayAuthToken(bob, { action, origin: 'https://relay.example' }),
        e = envelope();
      relay.send(e);
      const r = await handler(
        new Request('https://relay.example' + recipientPath(path), {
          headers: { [source]: source === 'authorization' ? 'Bearer ' + token : token },
        }),
      );
      expect(r.status).toBe(200);
      if (path === '/stream') {
        const reader = r.body!.getReader();
        try {
          expect(new TextDecoder().decode((await reader.read()).value)).toContain('connected');
          expect(new TextDecoder().decode((await reader.read()).value)).toContain(
            e.payload.envelopeId,
          );
        } finally {
          await reader.cancel();
        }
      } else expect(await r.json()).toEqual(e);
      expect(relay.snapshot().queues).toEqual([]);
    },
  );
  it('rejects ?auth= unless allowQueryAuth is enabled', async () => {
    const relay = new InMemoryRelay({ requireAuth: true }),
      handler = createRelayFetchHandler({ relay }),
      origin = 'https://relay.example',
      token = createRelayAuthToken(bob, { action, origin }),
      e = envelope();
    relay.send(e);
    const denied = await handler(
      new Request(origin + recipientPath(path) + '&auth=' + token),
    );
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: 'RELAY_QUERY_AUTH_DISABLED' });
    expect(relay.snapshot().queues).toEqual([[bob.did, [e]]]);
    const allowed = await createRelayFetchHandler({ relay, allowQueryAuth: true })(
      new Request(origin + recipientPath(path) + '&auth=' + token),
    );
    expect(allowed.status).toBe(200);
    if (path === '/stream') {
      const reader = allowed.body!.getReader();
      try {
        expect(new TextDecoder().decode((await reader.read()).value)).toContain('connected');
        expect(new TextDecoder().decode((await reader.read()).value)).toContain(
          e.payload.envelopeId,
        );
      } finally {
        await reader.cancel();
      }
    } else expect(await allowed.json()).toEqual(e);
    expect(relay.snapshot().queues).toEqual([]);
  });
});

describe('relay HTTP security headers', () => {
  const required = {
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
  } as const;
  function expectSecurity(response: Response): void {
    for (const [name, value] of Object.entries(required))
      expect(response.headers.get(name)).toBe(value);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  }
  async function exercise(
    base: string,
    request: (input: string, init?: RequestInit) => Promise<Response>,
  ): Promise<void> {
    const origin = new URL(base).origin;
    const health = await request(base + '/health');
    expect(health.status).toBe(200);
    expectSecurity(health);
    expect(health.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(health.headers.get('cache-control')).toBe('no-store');
    const posted = await request(base + '/envelopes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope()),
    });
    expect(posted.status).toBe(202);
    expectSecurity(posted);
    expect(posted.headers.get('cache-control')).toBe('no-store');
    const delivered = await request(base + recipientPath('/envelopes'), {
      headers: headers(bob, 'receive', origin),
    });
    expect(delivered.status).toBe(200);
    expectSecurity(delivered);
    expect(delivered.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(delivered.headers.get('cache-control')).toBe('no-store');
    const empty = await request(base + recipientPath('/envelopes'), {
      headers: headers(bob, 'receive', origin),
    });
    expect(empty.status).toBe(204);
    expectSecurity(empty);
    expect(empty.headers.get('cache-control')).toBe('no-store');
    const stream = await request(base + recipientPath('/stream'), {
      headers: headers(bob, 'stream', origin),
    });
    expect(stream.status).toBe(200);
    expectSecurity(stream);
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    expect(stream.headers.get('cache-control')).toBe('no-cache, no-store');
    await stream.body?.cancel();
  }
  it('createRelayFetchHandler sets nosniff, CSP, and DENY on health, envelopes, and stream', async () => {
    const handler = createRelayFetchHandler();
    await exercise('https://relay.example', (input, init) => handler(new Request(input, init)));
  });
  it('startLocalRelay sets nosniff, CSP, and DENY on health, envelopes, and stream', async () => {
    const server = await startLocalRelay();
    cleanup.push(server.close);
    await exercise(server.url, (input, init) => fetch(input, init));
  });
});

function wsRequest(socket: WebSocket, body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', receive);
      reject(new Error('TEST_WS_TIMEOUT'));
    }, 2000);
    const receive = (raw: import('ws').RawData) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()));
    };
    socket.once('message', receive);
    socket.send(JSON.stringify(body));
  });
}
async function socketAt(url: string) {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        socket.once('close', resolve);
        socket.close();
      }),
  );
  return socket;
}
describe.each(['receive', 'subscribe'] as const)('M3.1 WebSocket %s authentication', (action) => {
  it.each(attacks)('blocks %s and leaves messages for Bob', async (attack) => {
    const server = await startLocalRelay();
    cleanup.push(server.close);
    const socket = await socketAt(server.wsUrl),
      token = attackToken(attack, action, server.url);
    if (attack === 'replayed') expect(server.relay.authenticate(bob.did, token)).toBe(true);
    const e = envelope();
    server.relay.send(e);
    expect(
      await wsRequest(socket, { method: action, recipientDid: bob.did, authToken: token }),
    ).toEqual({ ok: false, error: 'RELAY_UNAUTHORIZED' });
    // An unauthorized subscription must not receive later messages either.
    const later = envelope();
    server.relay.send(later);
    expect(
      await wsRequest(socket, {
        method: 'receive',
        recipientDid: bob.did,
        auth: createRelayAuthToken(bob, { origin: server.url }),
      }),
    ).toEqual({ envelope: e });
    expect(
      await wsRequest(socket, {
        method: 'receive',
        recipientDid: bob.did,
        authToken: createRelayAuthToken(bob, { origin: server.url }),
      }),
    ).toEqual({ envelope: later });
  });
});

it('forwards Node headers and auto-signs fresh HTTP, SSE and WebSocket requests', async () => {
  const server = await startLocalRelay();
  cleanup.push(server.close);
  const client = new HttpRelayClient(server.url, bob, { allowPrivateRelay: true }),
    e = envelope();
  await client.send(e);
  expect(await client.receive(bob.did)).toEqual(e);
  expect(await client.receive(bob.did)).toBeUndefined();
  const extra = envelope();
  server.relay.send(extra);
  const response = await fetch(server.url + recipientPath('/envelopes'), {
    headers: {
      'x-acp-relay-auth': createRelayAuthToken(bob, { origin: server.url }),
      accept: 'application/json',
    },
  });
  expect(await response.json()).toEqual(extra);
  const sse = new SseRelayClient(
    server.url,
    fetch,
    (did, action, origin) => {
      expect(did).toBe(bob.did);
      expect(origin).toBe(new URL(server.url).origin);
      return createRelayAuthToken(bob, { action, origin });
    },
    { allowPrivateRelay: true },
  );
  const iterator = sse.stream(bob.did);
  const pending = iterator.next();
  const live = envelope();
  await client.send(live);
  expect((await pending).value).toEqual(live);
  await iterator.return(undefined);
  const ws = new WebSocketRelayClient(server.wsUrl, bob, { allowPrivateRelay: true });
  cleanup.push(() => ws.close());
  const next = envelope();
  await ws.send(next);
  expect(await ws.receive(bob.did)).toEqual(next);
  expect(await ws.receive(bob.did)).toBeUndefined();
  const subscription = ws.subscribe(bob.did),
    message = subscription.next(),
    streamed = envelope();
  await client.send(streamed);
  expect((await message).value).toEqual(streamed);
  await subscription.return(undefined);
});

describe('M3.1 bounded relay state', () => {
  it('rotates envelope replay IDs in FIFO order without permanent capacity failure', () => {
    const relay = new InMemoryRelay({ maxSeenEntries: 2 }),
      a = envelope(),
      b = envelope(),
      c = envelope();
    for (const e of [a, b]) {
      relay.send(e);
      expect(relay.receive(bob.did)).toEqual(e);
    }
    expect(() => relay.send(a)).toThrow('REPLAYED_ENVELOPE');
    relay.send(c);
    relay.receive(bob.did);
    expect(relay.snapshot().seen).toEqual([b.payload.envelopeId, c.payload.envelopeId]);
    expect(() => relay.send(b)).toThrow('REPLAYED_ENVELOPE');
    expect(() => relay.send(a)).not.toThrow();
    expect(relay.snapshot().seen).toEqual([c.payload.envelopeId, a.payload.envelopeId]);
  });
  it('rotates auth nonces in FIFO order and scopes them to the recipient', () => {
    const relay = new InMemoryRelay({ maxAuthSeenEntries: 2 });
    const tokens = ['a', 'b', 'c'].map((nonce) => createRelayAuthToken(bob, { nonce }));
    expect(relay.authenticate(bob.did, tokens[0])).toBe(true);
    expect(relay.authenticate(bob.did, tokens[1])).toBe(true);
    expect(relay.authenticate(bob.did, tokens[0])).toBe(false);
    expect(relay.authenticate(bob.did, tokens[2])).toBe(true);
    expect(relay.snapshot().authSeen).toEqual([bob.did + ':b', bob.did + ':c']);
    expect(relay.authenticate(bob.did, tokens[1])).toBe(false);
    expect(relay.authenticate(bob.did, tokens[0])).toBe(true);
    expect(relay.authenticate(eve.did, createRelayAuthToken(eve, { nonce: 'a' }))).toBe(true);
  });
  it('deletes drained queue entries and refuses new recipients at maxQueues', () => {
    const relay = new InMemoryRelay({ maxQueues: 1 }),
      e = envelope();
    relay.send(e);
    expect(() => relay.send(envelope(eve.did))).toThrow('RELAY_CAPACITY');
    expect(relay.receive(bob.did)).toEqual(e);
    expect(relay.snapshot().queues).toEqual([]);
    relay.send(envelope(eve.did));
    expect(relay.snapshot().queues).toHaveLength(1);
  });
  it('bounds waiting queues and releases them on abort or timeout', async () => {
    const relay = new InMemoryRelay({ maxQueues: 1 }),
      controller = new AbortController();
    const pending = relay.wait(bob.did, 30000, controller.signal);
    await expect(relay.wait(eve.did, 1)).rejects.toThrow('RELAY_CAPACITY');
    expect(() => relay.send(envelope(eve.did))).toThrow('RELAY_CAPACITY');
    controller.abort();
    await pending;
    expect(relay.snapshot().queues).toEqual([]);
    await relay.wait(eve.did, 1);
    expect(relay.snapshot().queues).toEqual([]);
  });
  it('keeps queue and envelope size bounds independent of replay cache rotation', () => {
    const relay = new InMemoryRelay({ maxSeenEntries: 1 });
    const oversized = signEnvelope(
      {
        taskId: 'task_security01',
        recipientDid: bob.did,
        seq: 0,
        eventType: 'PING',
        payload: 'x'.repeat(1048576),
      },
      alice,
    );
    expect(() => relay.send(oversized)).toThrow('RELAY_CAPACITY');
    expect(relay.snapshot().seen).toEqual([]);
    for (let i = 0; i < relay.maxQueueSize; i++) relay.send(envelope());
    expect(() => relay.send(envelope())).toThrow('RELAY_CAPACITY');
  });
  it.each(['ascii', 'utf8'])(
    'cancels SSE when an incomplete %s frame exceeds 2MB',
    async (encoding) => {
      const cancel = vi.fn(),
        chunk = new TextEncoder().encode(
          encoding === 'ascii' ? 'x'.repeat(1048577) : 'あ'.repeat(350000),
        );
      const fetcher: typeof fetch = async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(chunk);
              c.enqueue(chunk);
            },
            cancel,
          }),
        );
      const client = new SseRelayClient('https://relay.example', fetcher, bob);
      await expect(client.stream(bob.did).next()).rejects.toThrow('SSE_BUFFER_OVERFLOW');
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
  it('allows configuring a smaller SSE cap', async () => {
    const cancel = vi.fn(),
      fetcher: typeof fetch = async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('data: ' + 'x'.repeat(64)));
            },
            cancel,
          }),
        );
    const client = new SseRelayClient('https://relay.example', fetcher, bob);
    client.maxBufferBytes = 32;
    await expect(client.stream(bob.did).next()).rejects.toThrow('SSE_BUFFER_OVERFLOW');
    expect(cancel).toHaveBeenCalledOnce();
  });
});

function durableState() {
  const data = new Map<string, unknown>();
  return {
    storage: {
      get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
      put: vi.fn(async (key: string, value: unknown) => {
        data.set(key, structuredClone(value));
      }),
      delete: async (key: string) => data.delete(key),
    },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
  };
}
describe('M3.1 Durable Object mutation persistence', () => {
  it('avoids storage writes for reads, rejected authentication and failed posts', async () => {
    const state = durableState(),
      durable = new RelayDurableObject(state);
    const card = createSignedAgentCard(
      { name: 'Bob', agentDid: bob.did, relayEndpoint: 'https://relay.example', skills: [] },
      bob,
    );
    for (const path of [
      '/health',
      '/agents',
      '/agents/' + encodeURIComponent(bob.did),
      '/.well-known/agent.json',
      recipientPath('/envelopes'),
      '/envelopes',
      recipientPath('/stream'),
    ])
      await durable.fetch(new Request('https://relay.example' + path));
    for (const path of ['/agents', '/envelopes'])
      expect(
        (
          await durable.fetch(
            new Request('https://relay.example' + path, { method: 'POST', body: '{}' }),
          )
        ).status,
      ).toBe(400);
    expect(state.storage.put).not.toHaveBeenCalled();
    expect(
      (
        await durable.fetch(
          new Request('https://relay.example/agents', {
            method: 'POST',
            body: JSON.stringify(card),
          }),
        )
      ).status,
    ).toBe(201);
    expect(state.storage.put).toHaveBeenCalled();
    state.storage.put.mockClear();
    for (const path of [
      '/health',
      '/agents',
      '/agents/' + encodeURIComponent(bob.did),
      '/.well-known/agent.json',
    ])
      expect((await durable.fetch(new Request('https://relay.example' + path))).status).toBe(200);
    expect(
      (await durable.fetch(new Request('https://relay.example' + recipientPath('/envelopes'))))
        .status,
    ).toBe(401);
    expect(state.storage.put).not.toHaveBeenCalled();
  });
  it('persists successful sends, receives and nonce replay protection across restarts', async () => {
    const state = durableState(),
      first = new RelayDurableObject(state),
      e = envelope();
    const post = (d: RelayDurableObject) =>
      d.fetch(
        new Request('https://relay.example/envelopes', { method: 'POST', body: JSON.stringify(e) }),
      );
    expect((await post(first)).status).toBe(202);
    state.storage.put.mockClear();
    const token = createRelayAuthToken(bob, { origin: 'https://relay.example' }),
      request = () =>
        new Request('https://relay.example' + recipientPath('/envelopes'), {
          headers: { authorization: 'Bearer ' + token },
        });
    expect(await (await first.fetch(request())).json()).toEqual(e);
    expect(state.storage.put).toHaveBeenCalled();
    const second = new RelayDurableObject(state);
    state.storage.put.mockClear();
    expect((await second.fetch(request())).status).toBe(401);
    expect((await post(second)).status).toBe(400);
    expect(state.storage.put).not.toHaveBeenCalled();
    expect(
      (
        await second.fetch(
          new Request('https://relay.example' + recipientPath('/envelopes'), {
            headers: headers(),
          }),
        )
      ).status,
    ).toBe(204);
    expect(state.storage.put).toHaveBeenCalled();
  });
  it('persists authenticated SSE auth and delivery but skips idle heartbeats', async () => {
    vi.useFakeTimers();
    const state = durableState(),
      durable = new RelayDurableObject(state),
      token = createRelayAuthToken(bob, { action: 'stream', origin: 'https://relay.example' });
    const r = await durable.fetch(
      new Request('https://relay.example' + recipientPath('/stream'), {
        headers: { authorization: 'Bearer ' + token },
      }),
    );
    expect(r.status).toBe(200);
    expect(state.storage.put).toHaveBeenCalled();
    const reader = r.body!.getReader();
    await reader.read();
    state.storage.put.mockClear();
    await vi.advanceTimersByTimeAsync(15000);
    await reader.read();
    expect(state.storage.put).not.toHaveBeenCalled();
    const e = envelope();
    await durable.fetch(
      new Request('https://relay.example/envelopes', { method: 'POST', body: JSON.stringify(e) }),
    );
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(e.payload.envelopeId);
    await reader.cancel();
    const restarted = new RelayDurableObject(state);
    expect(
      (
        await restarted.fetch(
          new Request('https://relay.example' + recipientPath('/stream'), {
            headers: { authorization: 'Bearer ' + token },
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await restarted.fetch(
          new Request('https://relay.example' + recipientPath('/envelopes'), {
            headers: headers(),
          }),
        )
      ).status,
    ).toBe(204);
  });
});

describe('M3.1 attested isolation enforcement', () => {
  it.each([
    [undefined, 'subprocess_restricted', true, false],
    [false, 'subprocess_restricted', true, false],
    [undefined, undefined, true, false],
    [undefined, 'host_adapter', true, false],
    [true, 'subprocess_restricted', true, true],
    [undefined, 'oci_container', true, true],
    [undefined, 'subprocess_restricted', false, true],
  ] as const)(
    'fallback=%s effective=%s required=%s accepts=%s',
    async (fallback, effective, required, accepted) => {
      const m = buildTaskManifest({
        ownerDid: alice.did,
        workerDid: bob.did,
        title: 'Isolation',
        description: 'Require OCI execution',
      });
      m.sandboxPolicy.isolationLevel = 'oci_container';
      if (fallback !== undefined) m.sandboxPolicy.allowSubprocessFallback = fallback;
      m.verification.requireExecutionAttestation = required;
      validateManifest(m);
      const contract = createContract(m, signPayload(m, alice), bob);
      const gateway = new OwnerGateway(alice, contract, { requiredGates: [], autoApprove: [] });
      try {
        for (const [event, owner] of [
          ['ACCEPT', bob],
          ['START', bob],
          ['DELIVER', bob],
        ] as const)
          gateway.machine.apply(gateway.machine.event(event, owner));
        const usage = signPayload(
          {
            type: 'UsageReceipt' as const,
            taskId: m.taskId,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            toolCalls: 0,
            wallTimeMs: 0,
            halted: false,
          },
          bob,
        );
        const d = createDelivery(
          m.taskId,
          contract.contractDigest,
          {},
          usage,
          bob,
          effective ? { effectiveIsolationLevel: effective } : undefined,
        );
        const e = signEnvelope(
          {
            taskId: m.taskId,
            recipientDid: alice.did,
            seq: 0,
            eventType: 'DELIVER',
            payload: d as unknown as Json,
          },
          bob,
        );
        const approval = vi.fn(async () => signApproval(m.taskId, 'final_verification', d, alice));
        const { result } = await gateway.verifyAndSettle(
          e,
          new VerificationEngine({ allowUnencryptedEnvelopes: true }),
          approval,
        );
        expect(result.accepted).toBe(accepted);
        expect(gateway.machine.state).toBe(accepted ? 'SETTLED' : 'VERIFY_REJECT');
        if (!accepted) {
          expect(result.reason).toBe('Error: ISOLATION_LEVEL_MISMATCH');
          expect(result.stages).toEqual([]);
          expect(approval).not.toHaveBeenCalled();
        }
      } finally {
        gateway.close();
      }
    },
  );
});

const alwaysBlocked = [
  '169.254.169.254',
  '169.254.170.2',
  '169.254.1.1',
  '[fd00:ec2::254]',
  '[fd00:ec2:0:0:0:0:0:254]',
  'metadata.google.internal',
  'metadata.goog',
  'METADATA.GOOG.',
  '0.0.0.0',
  '[::]',
  '[::ffff:169.254.169.254]',
  '[::ffff:0:0]',
  '[fe80::1]',
  '[febf::1]',
];
const privateHosts = [
  'localhost',
  'LOCALHOST.',
  '127.0.0.1',
  '127.42.0.1',
  '127.1',
  '2130706433',
  '0x7f000001',
  '10.2.3.4',
  '172.16.0.1',
  '172.31.255.255',
  '192.168.1.1',
  '[::1]',
  '[0:0:0:0:0:0:0:1]',
  '[fc00::1]',
  '[fd12::1]',
  '[::ffff:127.0.0.1]',
  'relay.local',
  'service.internal',
];
describe('M3.1 invite SSRF guard', () => {
  it.each(alwaysBlocked)('always blocks %s', (host) => {
    for (const allowPrivateRelay of [undefined, true, false])
      expect(() =>
        validateRelayEndpointUrl('http://' + host + '/relay', { allowPrivateRelay }),
      ).toThrow('SSRF_BLOCKED_RELAY_URL');
  });
  it.each(privateHosts)('blocks private %s unless allowPrivateRelay is true', (host) => {
    expect(() => validateRelayEndpointUrl('http://' + host)).toThrow('SSRF_BLOCKED_RELAY_URL');
    expect(() => validateRelayEndpointUrl('http://' + host, { allowPrivateRelay: false })).toThrow(
      'SSRF_BLOCKED_RELAY_URL',
    );
    expect(() =>
      validateRelayEndpointUrl('http://' + host, { allowPrivateRelay: true }),
    ).not.toThrow();
  });
  it.each(['http:', 'https:', 'ws:', 'wss:'])('accepts public %s endpoints', (scheme) => {
    for (const host of [
      'relay.example.com',
      '8.8.8.8',
      '172.15.0.1',
      '172.32.0.1',
      '[2001:4860:4860::8888]',
    ])
      expect(() =>
        validateRelayEndpointUrl(scheme + '//' + host, { allowPrivateRelay: false }),
      ).not.toThrow();
  });
  it.each([
    'file:///etc/passwd',
    'ftp://relay.example',
    'javascript:alert(1)',
    'not a url',
    'https://user:pass@relay.example',
  ])('rejects invalid URL %s', (url) => {
    expect(() => validateRelayEndpointUrl(url)).toThrow('SSRF_BLOCKED_RELAY_URL');
  });
  it.each(['http://169.254.169.254', 'http://127.0.0.1'])(
    'checks signed invites and RequesterClient before any network access (%s)',
    async (relayUrl) => {
      const card = createSignedAgentCard(
          { name: 'Bob', agentDid: bob.did, relayEndpoint: relayUrl, skills: [] },
          bob,
        ),
        invite = createInviteToken({ agentCard: card }, bob);
      const strict = { allowPrivateRelay: false };
      expect(() => parseAndVerifyInviteToken(invite, Date.now(), strict)).toThrow(
        'SSRF_BLOCKED_RELAY_URL',
      );
      expect(() => parseAndVerifyInviteToken(invite)).toThrow('SSRF_BLOCKED_RELAY_URL');
      if (!relayUrl.includes('169.254'))
        expect(
          parseAndVerifyInviteToken(invite, Date.now(), { allowPrivateRelay: true }).relayUrl,
        ).toBe(relayUrl);
      const client = new RequesterClient({ owner: alice, ...strict });
      await expect(
        client.delegate({ to: invite, title: 'Blocked', description: 'SSRF test', input: {} }),
      ).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
      await expect(
        client.delegate({
          to: bob.did,
          relay: relayUrl,
          title: 'Blocked',
          description: 'SSRF test',
          input: {},
        }),
      ).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
    },
  );
});

it('auto-signs WorkerNode and RequesterClient receives against a strict in-memory relay', async () => {
  const relay = new InMemoryRelay({ requireAuth: true });
  const worker = new WorkerNode({
    owner: bob,
    relay,
    adapter: new SandboxAgentAdapter(),
    approvalProvider: new PolicyAutoApprovalProvider(bob),
  });
  const client = new RequesterClient({
    owner: alice,
    relay,
    approvalProvider: new PolicyAutoApprovalProvider(alice),
  });
  const [w, r] = await Promise.all([
    worker.start({ once: true }),
    client.delegate({
      to: worker.invite(),
      title: 'Strict auth',
      description: 'Echo input',
      input: { strict: true },
    }),
  ]);
  expect(w?.state).toBe('SETTLED');
  expect(r.deliverable).toEqual({ strict: true });
  expect(w?.bundle).toEqual(r.bundle);
});
