// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  createRelayAuthToken,
  createSignedAgentCard,
  generateKeyPair,
  signEnvelope,
  signPayload,
} from '../packages/core/src/index.js';
import {
  KNOWN_RELAY_ERROR_CODES,
  createRelayFetchHandler,
  mapRelayError,
  sanitizeRelayErrorCode,
  startLocalRelay,
} from '../packages/relay/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/fetch.js';

const LEAK = 'SQLITE_ERROR: table secrets at /srv/internal/db.sqlite leaked token=sk-12345';
const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const alice = generateKeyPair();
const bob = generateKeyPair();
const envelope = (recipientDid = bob.did) =>
  signEnvelope(
    { taskId: 'task_p2_10', recipientDid, seq: 0, eventType: 'PING', payload: { ok: true } },
    alice,
  );

function expectNoLeak(body: string): void {
  expect(body).not.toContain('SQLITE_ERROR');
  expect(body).not.toContain('/srv/internal');
  expect(body).not.toContain('db.sqlite');
  expect(body).not.toContain('sk-12345');
  expect(body).not.toContain('leaked token');
  expect(body).not.toContain('Error:');
}

function leakingRelay() {
  return new InMemoryRelay({
    tamper: () => {
      throw new Error(LEAK);
    },
  });
}

async function postEnvelope(
  handler: (request: Request) => Promise<Response>,
  body: unknown,
  url = 'https://relay.example/envelopes',
): Promise<Response> {
  return handler(
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

function wsRequest(socket: WebSocket, body: unknown): Promise<unknown> {
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
    socket.send(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.close();
      }),
  );
  return socket;
}

describe('P2-10 relay error sanitization', () => {
  it('returns allowlisted codes exactly and hides every other message', () => {
    const statuses: Record<string, number> = {
      INVALID_ENVELOPE: 400,
      INVALID_SIGNED_ENVELOPE: 400,
      REPLAYED_ENVELOPE: 400,
      DUPLICATE_ENVELOPE_ID: 400,
      RELAY_CAPACITY: 400,
      RELAY_QUEUE_FULL: 400,
      ENVELOPE_TOO_LARGE: 400,
      PAYLOAD_TOO_LARGE: 400,
      BODY_TOO_LARGE: 400,
      INVALID_AGENT_CARD: 400,
      AGENT_CARD_EXPIRED: 400,
      AGENT_OWNER_OR_VERSION_MISMATCH: 400,
      INVALID_DID: 400,
      INVALID_RECIPIENT_DID: 400,
      MISSING_RECIPIENT_DID: 400,
      INVALID_REQUEST: 400,
      INVALID_JSON: 400,
      INVALID_WAIT: 400,
      INVALID_TIMEOUT: 400,
      RELAY_UNAUTHORIZED: 401,
      RELAY_AUTH_REQUIRED: 401,
      RELAY_AUTH_INVALID: 401,
      RELAY_AUTH_SIGNATURE_INVALID: 401,
      RELAY_AUTH_RECIPIENT_MISMATCH: 401,
      RELAY_AUTH_ACTION_MISMATCH: 401,
      RELAY_AUTH_EXPIRED: 401,
      RELAY_AUTH_FUTURE_ISSUED_AT: 401,
      RELAY_AUTH_REPLAYED: 401,
      RELAY_AUTH_NONCE_INVALID: 401,
      RELAY_AUTH_ORIGIN_MISMATCH: 401,
      RELAY_AUTH_ORIGIN_REQUIRED: 401,
      RELAY_QUERY_AUTH_DISABLED: 401,
      QUEUE_BYTES_EXCEEDED: 429,
      RELAY_BYTE_BUDGET_EXCEEDED: 429,
      SENDER_QUOTA_EXCEEDED: 429,
      RATE_LIMITED: 429,
      NOT_FOUND: 404,
      NO_AGENT_REGISTERED: 404,
      RATE_LIMITER_UNAVAILABLE: 503,
      RELAY_INTERNAL_ERROR: 500,
    };
    for (const code of Object.keys(statuses)) expect(KNOWN_RELAY_ERROR_CODES).toContain(code);
    for (const code of KNOWN_RELAY_ERROR_CODES) {
      const mapped = mapRelayError(new Error(code));
      expect(mapped.error).toBe(code);
      expect(mapped.status).not.toBe(code === 'RELAY_INTERNAL_ERROR' ? 400 : 500);
      const expected = statuses[code];
      if (expected !== undefined) expect(mapped).toEqual({ status: expected, error: code });
    }
    expect(sanitizeRelayErrorCode(LEAK)).toBe('RELAY_INTERNAL_ERROR');
    expect(sanitizeRelayErrorCode(new Error(LEAK))).toBe('RELAY_INTERNAL_ERROR');
    expect(sanitizeRelayErrorCode(new Error('Error: ' + LEAK))).toBe('RELAY_INTERNAL_ERROR');
    expect(sanitizeRelayErrorCode(new Error('INVALID_ENVELOPE ' + LEAK))).toBe(
      'RELAY_INTERNAL_ERROR',
    );
    expect(sanitizeRelayErrorCode(new Error(LEAK), 'INVALID_REQUEST')).toBe('INVALID_REQUEST');
    expect(sanitizeRelayErrorCode(new Error(LEAK), LEAK)).toBe('RELAY_INTERNAL_ERROR');
    expect(mapRelayError(new Error(LEAK))).toEqual({
      status: 500,
      error: 'RELAY_INTERNAL_ERROR',
    });
    expect(mapRelayError(new SyntaxError('Unexpected token ' + LEAK))).toEqual({
      status: 400,
      error: 'INVALID_REQUEST',
    });
    expect(mapRelayError(new URIError('URI malformed ' + LEAK))).toEqual({
      status: 400,
      error: 'INVALID_REQUEST',
    });
    expect(mapRelayError(new TypeError('Invalid URL'))).toEqual({
      status: 400,
      error: 'INVALID_REQUEST',
    });
    const internal = mapRelayError(new TypeError('Cannot read properties of ' + LEAK));
    expect(internal).toEqual({ status: 500, error: 'RELAY_INTERNAL_ERROR' });
  });

  it('hides a storage callback failure on the fetch handler and keeps protocol codes', async () => {
    const relay = leakingRelay();
    const handler = createRelayFetchHandler({ relay });
    const leaked = await postEnvelope(handler, envelope());
    expect(leaked.status).toBe(500);
    const leakedText = await leaked.text();
    expect(JSON.parse(leakedText)).toEqual({ error: 'RELAY_INTERNAL_ERROR' });
    expectNoLeak(leakedText);
    expect(leaked.headers.get('content-type')).toContain('application/json');

    const invalid = await postEnvelope(handler, { nope: true });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'INVALID_ENVELOPE' });

    const malformed = await postEnvelope(handler, '{' + LEAK);
    expect(malformed.status).toBe(400);
    const malformedText = await malformed.text();
    expect(JSON.parse(malformedText)).toEqual({ error: 'INVALID_REQUEST' });
    expectNoLeak(malformedText);

    const card = await handler(
      new Request('https://relay.example/agents', {
        method: 'POST',
        body: JSON.stringify({ nope: true }),
      }),
    );
    expect(card.status).toBe(400);
    expect(await card.json()).toEqual({ error: 'INVALID_AGENT_CARD' });

    const did = await handler(new Request('https://relay.example/envelopes?recipient=not-a-did'));
    expect(did.status).toBe(400);
    expect(await did.json()).toEqual({ error: 'INVALID_DID' });

    const queryAuth = await handler(
      new Request('https://relay.example/envelopes?recipient=' + encodeURIComponent(bob.did) + '&auth=tok'),
    );
    expect(queryAuth.status).toBe(401);
    expect(await queryAuth.json()).toEqual({ error: 'RELAY_QUERY_AUTH_DISABLED' });

    const badPercent = await handler(
      new Request('https://relay.example/envelopes/%E0%A4%A?recipient=' + encodeURIComponent(bob.did), {
        method: 'DELETE',
      }),
    );
    expect(badPercent.status).toBe(400);
    expect(await badPercent.json()).toEqual({ error: 'INVALID_REQUEST' });

    const origin = 'https://relay-a.example';
    const queued = envelope();
    const authed = new InMemoryRelay();
    authed.send(queued);
    const mismatch = await createRelayFetchHandler({ relay: authed })(
      new Request('https://relay-b.example/envelopes?recipient=' + encodeURIComponent(bob.did), {
        headers: {
          authorization: 'Bearer ' + createRelayAuthToken(bob, { origin }),
        },
      }),
    );
    expect(mismatch.status).toBe(401);
    expect(await mismatch.json()).toEqual({ error: 'RELAY_AUTH_ORIGIN_MISMATCH' });
    expect(authed.snapshot().queues).toHaveLength(1);

    const capped = new InMemoryRelay({ maxQueueSize: 1 });
    const cappedHandler = createRelayFetchHandler({ relay: capped });
    expect((await postEnvelope(cappedHandler, envelope())).status).toBe(202);
    const full = await postEnvelope(cappedHandler, envelope());
    expect(full.status).toBe(429);
    expect(await full.json()).toEqual({ error: 'RELAY_RETRY_LATER', retryable: true, retryAfterMs: 60000 });

    const first = envelope();
    const replayRelay = new InMemoryRelay();
    const replayHandler = createRelayFetchHandler({ relay: replayRelay });
    expect((await postEnvelope(replayHandler, first)).status).toBe(202);
    const replay = await postEnvelope(replayHandler, first);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: 'REPLAYED_ENVELOPE' });

    const budgeted = envelope();
    const budgetRelay = new InMemoryRelay({
      maxQueueBytesPerRecipient: Buffer.byteLength(JSON.stringify(budgeted)),
      maxQueueSize: 10,
      maxEnvelopesPerSender: 10,
    });
    budgetRelay.send(budgeted);
    const budget = await postEnvelope(
      createRelayFetchHandler({ relay: budgetRelay }),
      envelope(),
    );
    expect(budget.status).toBe(429);
    expect(await budget.json()).toEqual({ error: 'RELAY_RETRY_LATER', retryable: true, retryAfterMs: 60000 });
    expect(budget.headers.get('retry-after')).toBeTruthy();

    const registered = createSignedAgentCard(
      {
        name: 'Bob',
        agentDid: bob.did,
        relayEndpoint: 'https://relay.example',
        skills: [],
      },
      bob,
    );
    const fresh = new InMemoryRelay();
    fresh.register(registered);
    const older = signPayload(
      registered.payload,
      bob,
      new Date(Date.now() - 60_000).toISOString(),
    );
    const staleCard = await createRelayFetchHandler({ relay: fresh })(
      new Request('https://relay.example/agents', {
        method: 'POST',
        body: JSON.stringify(older),
      }),
    );
    expect(staleCard.status).toBe(400);
    expect(await staleCard.json()).toEqual({ error: 'AGENT_OWNER_OR_VERSION_MISMATCH' });
  });

  it('hides the same storage failure on the local HTTP and WebSocket servers', async () => {
    const server = await startLocalRelay({
      tamper: () => {
        throw new Error(LEAK);
      },
    });
    cleanup.push(server.close);
    const http = await fetch(server.url + '/envelopes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope()),
    });
    expect(http.status).toBe(500);
    const httpText = await http.text();
    expect(JSON.parse(httpText)).toEqual({ error: 'RELAY_INTERNAL_ERROR' });
    expectNoLeak(httpText);

    const socket = await openSocket(server.wsUrl);
    const frame = await wsRequest(socket, { method: 'send', envelope: envelope() });
    expect(frame).toEqual({ ok: false, error: 'RELAY_INTERNAL_ERROR' });
    expectNoLeak(JSON.stringify(frame));
    expect(
      await wsRequest(socket, { method: 'receive', recipientDid: bob.did }),
    ).toEqual({ ok: false, error: 'RELAY_UNAUTHORIZED' });
    expect(await wsRequest(socket, { method: 'nope' })).toEqual({
      ok: false,
      error: 'INVALID_REQUEST',
    });
    const raw = await wsRequest(socket, 'not-json ' + LEAK);
    expect(raw).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expectNoLeak(JSON.stringify(raw));

    const healthy = await startLocalRelay();
    cleanup.push(healthy.close);
    const rejected = await fetch(healthy.url + '/envelopes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: true }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: 'INVALID_ENVELOPE' });
    const healthySocket = await openSocket(healthy.wsUrl);
    expect(await wsRequest(healthySocket, { method: 'send', envelope: { nope: true } })).toEqual({
      ok: false,
      error: 'INVALID_ENVELOPE',
    });
  });
});
