// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSignedAgentCard,
  generateKeyPair,
  signEnvelope,
} from '../packages/core/src/index.js';
import {
  createPinnedRelayFetch,
  HttpRelayClient,
  isTransientRelayError,
} from '../packages/relay/src/index.js';
import { receiveRelay } from '../packages/runtime/src/session-audit.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const owner = generateKeyPair();
const card = createSignedAgentCard(
  { name: 'test', agentDid: owner.did, relayEndpoint: 'https://relay.example', skills: [] },
  owner,
);

describe('relay resilience (#83)', () => {
  it.each(['headers', 'body', 'idle'] as const)(
    'bounds a hung %s connection and closes it',
    async (mode) => {
      const server = createServer((_req, res) => {
        if (mode === 'body') {
          res.writeHead(200);
          res.write('{');
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address() as { port: number };
      const url = 'http://127.0.0.1:' + address.port;
      const fetcher = createPinnedRelayFetch(url, {
        allowPrivateRelay: true,
        requestTimeoutMs: mode === 'idle' ? 1000 : 50,
        socketTimeoutMs: mode === 'idle' ? 50 : 1000,
      });
      try {
        await expect(
          (async () => {
            const r = await fetcher(url);
            await r.text();
          })(),
        ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
  it.each(['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'socket hang up'])(
    'keeps polling after %s',
    async (code) => {
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const envelope = signEnvelope(
        { taskId: 'retry', recipientDid: owner.did, seq: 0, eventType: 'PROPOSE', payload: {} },
        owner,
      );
      const receive = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error(code), { code }))
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(envelope);
      const result = receiveRelay({ send() {}, receive }, owner.did);
      await vi.runAllTimersAsync();
      expect(await result).toEqual(envelope);
      expect(receive).toHaveBeenCalledTimes(3);
    },
  );
  it('aborts backoff promptly', async () => {
    const controller = new AbortController();
    const result = receiveRelay(
      {
        send() {},
        receive() {
          throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        },
      },
      owner.did,
      controller.signal,
    );
    controller.abort(new Error('stopped'));
    await expect(result).rejects.toThrow('stopped');
  });
  it.each([400, 401, 403, 404, 422])('fails fast on HTTP %s', async (status) => {
    const receive = vi.fn().mockRejectedValue(new Error('RELAY_REJECTED: ' + status));
    await expect(receiveRelay({ send() {}, receive }, owner.did)).rejects.toThrow(String(status));
    expect(receive).toHaveBeenCalledTimes(1);
  });
  it('bounds registration and retries a hung injected transport', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const client = new HttpRelayClient('https://relay.example', fetcher as typeof fetch, {
      requestTimeoutMs: 50,
    });
    const result = client.register(card);
    await vi.runAllTimersAsync();
    await result;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not retry registration auth failures', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 403 }));
    await expect(
      new HttpRelayClient('https://relay.example', fetcher as typeof fetch).register(card),
    ).rejects.toThrow('403');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds DNS resolution and retains fail-closed security errors', async () => {
    const fetcher = createPinnedRelayFetch('https://relay.example', {
      requestTimeoutMs: 20,
      lookup: () => new Promise(() => {}),
    });
    await expect(fetcher('https://relay.example')).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(isTransientRelayError(new Error('SSRF_BLOCKED_RELAY_URL'))).toBe(false);
  });
});

it('caps registration retries at five attempts', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fetcher = vi
    .fn()
    .mockRejectedValue(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
  const result = new HttpRelayClient('https://relay.example', fetcher as typeof fetch).register(
    card,
  );
  const rejected = expect(result).rejects.toThrow('reset');
  await vi.runAllTimersAsync();
  await rejected;
  expect(fetcher).toHaveBeenCalledTimes(5);
});

it('retries transient DNS without bypassing address validation', async () => {
  const lookup = vi
    .fn()
    .mockRejectedValueOnce(Object.assign(new Error('dns'), { code: 'EAI_AGAIN' }))
    .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
  const fetcher = vi.fn();
  const client = new HttpRelayClient('https://relay.example', fetcher as typeof fetch, { lookup });
  await expect(client.receive(owner.did)).rejects.toThrow('RELAY_AUTH_REQUIRED');
  // Discovery has no auth prerequisite and exercises DNS preparation directly.
  await expect(client.discover()).rejects.toMatchObject({ code: 'EAI_AGAIN' });
  await expect(client.discover()).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
  await expect(client.discover()).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
  expect(lookup).toHaveBeenCalledTimes(2);
  expect(fetcher).not.toHaveBeenCalled();
});
