// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRelayAuthToken,
  generateKeyPair,
  normalizeRelayOrigin,
  signEnvelope,
  verifyRelayAuthToken,
} from '../packages/core/src/index.js';
import {
  HttpRelayClient,
  InMemoryRelay,
  SseRelayClient,
  WebSocketRelayClient,
  createRelayFetchHandler,
  startLocalRelay,
} from '../packages/relay/src/index.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const alice = generateKeyPair();
const bob = generateKeyPair();
const envelope = (recipientDid = bob.did) =>
  signEnvelope(
    { taskId: 'task_p2_9', recipientDid, seq: 0, eventType: 'PING', payload: { ok: true } },
    alice,
  );
const recipientQuery = (did = bob.did) => '/envelopes?recipient=' + encodeURIComponent(did);

describe('P2-9 RelayAuth origin binding', () => {
  it('normalizes ws and wss onto the http(s) origin', () => {
    expect(normalizeRelayOrigin('wss://Relay-A.Example/socket')).toBe('https://relay-a.example');
    expect(normalizeRelayOrigin('WS://127.0.0.1:8787/ws')).toBe('http://127.0.0.1:8787');
    expect(normalizeRelayOrigin('https://acp-relay.agent-collab.workers.dev/v1')).toBe(
      'https://acp-relay.agent-collab.workers.dev',
    );
    expect(() => normalizeRelayOrigin('file:///tmp/relay')).toThrow('INVALID_RELAY_ORIGIN');
  });

  it('accepts a token only on the origin it was signed for', async () => {
    const token = createRelayAuthToken(bob, { origin: 'wss://Relay-A.Example/socket' });
    expect(
      verifyRelayAuthToken(token, bob.did, { expectedOrigin: 'https://relay-a.example' }),
    ).toMatchObject({
      valid: true,
      action: 'receive',
    });
    expect(
      verifyRelayAuthToken(token, bob.did, { expectedOrigin: 'https://relay-b.example' }),
    ).toEqual({
      valid: false,
      error: 'RELAY_AUTH_ORIGIN_MISMATCH',
      reason: 'RELAY_AUTH_ORIGIN_MISMATCH',
    });
    expect(
      verifyRelayAuthToken(token, bob.did, {
        expectedOrigin: 'https://relay-b.example',
        requireOrigin: false,
      }).reason,
    ).toBe('RELAY_AUTH_ORIGIN_MISMATCH');
    expect(
      verifyRelayAuthToken(createRelayAuthToken(bob), bob.did, { requireOrigin: true }),
    ).toEqual({
      valid: false,
      error: 'RELAY_AUTH_ORIGIN_REQUIRED',
      reason: 'RELAY_AUTH_ORIGIN_REQUIRED',
    });
    expect(
      verifyRelayAuthToken(createRelayAuthToken(bob), bob.did, {
        expectedOrigin: 'https://relay-a.example',
      }).valid,
    ).toBe(true);

    const relayA = new InMemoryRelay();
    const relayB = new InMemoryRelay();
    const handlerA = createRelayFetchHandler({ relay: relayA });
    const handlerB = createRelayFetchHandler({ relay: relayB });
    const delivered = envelope();
    relayA.send(delivered);
    relayB.send(envelope());
    const accepted = await handlerA(
      new Request('https://relay-a.example' + recipientQuery(), {
        headers: { authorization: 'Bearer ' + token },
      }),
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual(delivered);
    const rejected = await handlerB(
      new Request('https://relay-b.example' + recipientQuery(), {
        headers: { authorization: 'Bearer ' + token },
      }),
    );
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toEqual({ error: 'RELAY_AUTH_ORIGIN_MISMATCH' });
    expect(relayB.snapshot().queues).toHaveLength(1);
  });

  it('rejects a network token that omits origin unless unbound auth is enabled', async () => {
    const relay = new InMemoryRelay();
    const handler = createRelayFetchHandler({ relay });
    const delivered = envelope();
    relay.send(delivered);
    const missing = await handler(
      new Request('https://relay-a.example' + recipientQuery(), {
        headers: { authorization: 'Bearer ' + createRelayAuthToken(bob) },
      }),
    );
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'RELAY_AUTH_ORIGIN_REQUIRED' });
    expect(relay.snapshot().queues).toHaveLength(1);

    const unbound = createRelayFetchHandler({
      relay,
      allowUnboundRelayAuth: true,
    });
    const accepted = await unbound(
      new Request('https://relay-a.example' + recipientQuery(), {
        headers: { authorization: 'Bearer ' + createRelayAuthToken(bob) },
      }),
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual(delivered);

    relay.send(envelope());
    const mismatched = await unbound(
      new Request('https://relay-a.example' + recipientQuery(), {
        headers: {
          authorization:
            'Bearer ' + createRelayAuthToken(bob, { origin: 'https://relay-b.example' }),
        },
      }),
    );
    expect(mismatched.status).toBe(401);
    expect(await mismatched.json()).toEqual({ error: 'RELAY_AUTH_ORIGIN_MISMATCH' });
  });

  it('binds HTTP, SSE, and WebSocket clients and blocks cross-relay replay', async () => {
    const relayA = await startLocalRelay();
    const relayB = await startLocalRelay();
    cleanup.push(relayA.close, relayB.close);
    const http = new HttpRelayClient(relayA.url, bob, { allowPrivateRelay: true });
    const first = envelope();
    await http.send(first);
    expect(await http.receive(bob.did)).toEqual(first);

    let captured = '';
    const capturing = new HttpRelayClient(
      relayA.url,
      fetch,
      (_did, action, origin) => {
        captured = createRelayAuthToken(bob, { action, origin });
        return captured;
      },
      { allowPrivateRelay: true },
    );
    const second = envelope();
    relayA.relay.send(second);
    expect(await capturing.receive(bob.did)).toEqual(second);
    expect(JSON.parse(Buffer.from(captured, 'base64url').toString()).payload.origin).toBe(
      normalizeRelayOrigin(relayA.url),
    );

    const sse = new SseRelayClient(relayA.url, bob, { allowPrivateRelay: true });
    const stream = sse.stream(bob.did);
    const third = envelope();
    relayA.relay.send(third);
    expect((await stream.next()).value).toEqual(third);
    await stream.return(undefined);
    await sse.close();

    const ws = new WebSocketRelayClient(relayA.wsUrl, bob, { allowPrivateRelay: true });
    cleanup.push(() => ws.close());
    const fourth = envelope();
    await ws.send(fourth);
    expect(await ws.receive(bob.did)).toEqual(fourth);
    const subscription = ws.subscribe(bob.did);
    const pending = subscription.next();
    const fifth = envelope();
    relayA.relay.send(fifth);
    expect((await pending).value).toEqual(fifth);
    await subscription.return(undefined);

    relayB.relay.send(envelope());
    const replay = await fetch(relayB.url + recipientQuery(), {
      headers: { authorization: 'Bearer ' + captured },
    });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: 'RELAY_AUTH_ORIGIN_MISMATCH' });
    expect(relayB.relay.snapshot().queues).toHaveLength(1);
  });

  it('rejects ?auth= unless allowQueryAuth is set', async () => {
    const origin = 'https://relay-a.example';
    const token = createRelayAuthToken(bob, { origin });
    const relay = new InMemoryRelay();
    relay.send(envelope());
    const denied = await createRelayFetchHandler({ relay })(
      new Request(origin + recipientQuery() + '&auth=' + token),
    );
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: 'RELAY_QUERY_AUTH_DISABLED' });
    const allowed = await createRelayFetchHandler({ relay, allowQueryAuth: true })(
      new Request(origin + recipientQuery() + '&auth=' + token),
    );
    expect(allowed.status).toBe(200);
    expect(relay.snapshot().queues).toEqual([]);

    const server = await startLocalRelay();
    cleanup.push(server.close);
    const localToken = createRelayAuthToken(bob, { origin: server.url });
    server.relay.send(envelope());
    const localDenied = await fetch(server.url + recipientQuery() + '&auth=' + localToken);
    expect(localDenied.status).toBe(401);
    expect(await localDenied.json()).toEqual({ error: 'RELAY_QUERY_AUTH_DISABLED' });
    const opted = await startLocalRelay({ allowQueryAuth: true });
    cleanup.push(opted.close);
    const queued = envelope();
    opted.relay.send(queued);
    const localAllowed = await fetch(
      opted.url + recipientQuery() + '&auth=' + createRelayAuthToken(bob, { origin: opted.url }),
    );
    expect(localAllowed.status).toBe(200);
    expect(await localAllowed.json()).toEqual(queued);
  });
});
