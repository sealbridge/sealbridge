// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, isEncryptedEnvelopePayload, signEnvelope, signPayload } from '../packages/core/src/index.js';
import type { Json } from '../packages/core/src/index.js';
import { HttpRelayClient, isTransientRelayError } from '../packages/relay/src/index.js';
import { createRelayFetchHandler, InMemoryRelay, relayErrorBody } from '../packages/relay/src/fetch.js';
import { handleRelayEdge, RelayDurableObject, resetRelayRateLimits } from '../packages/relay/src/worker.js';
import { buildTaskManifest } from '../packages/runtime/src/session.js';
import { authorized, day, envelope, memoryStorage, origin, post, recipient, sender, start } from './relay-test-fixtures.js';

const retry = { error: 'RELAY_RETRY_LATER', retryable: true, retryAfterMs: 60_000 };
afterEach(() => { vi.restoreAllMocks(); resetRelayRateLimits(); });

async function expectTemporary(response: Response) {
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual(retry);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.headers.get('retry-after')).toBe('60');
  expect(response.headers.get('cache-control')).toBe('no-store');
}
const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

describe('relay admission', () => {
  it('counts leased entries at the recipient count boundary and admits a refused ID after acknowledgement', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(start);
    const relay = new InMemoryRelay({ maxQueueSize: 1, now: () => start });
    const handler = createRelayFetchHandler({ relay });
    const first = envelope(), next = envelope();
    expect((await handler(post(first))).status).toBe(202);
    expect(relay.receive(recipient.did, undefined, undefined, { lease: true })).toEqual(first);
    const before = relay.snapshot();
    await expectTemporary(await handler(post(next)));
    expect(relay.snapshot()).toEqual(before);
    expect(relay.acknowledge(recipient.did, first.payload.envelopeId,
      authorized('/envelopes', recipient, start).headers.get('authorization')!.slice(7))).toBe(true);
    expect((await handler(post(next))).status).toBe(202);
    expect(relay.snapshot().queues).toEqual([[recipient.did, [next]]]);
  });

  it('uses serialized UTF-8 bytes at equality and refuses the next byte without mutation', async () => {
    const first = envelope({ text: '日本語' }, sender, recipient, false);
    const second = envelope({ text: 'a' }, sender, recipient, false);
    const total = byteLength(first) + byteLength(second);
    expect(byteLength(first)).toBeGreaterThan(JSON.stringify(first).length);
    const equal = new InMemoryRelay({ maxQueueBytesPerRecipient: total, now: () => start });
    equal.send(first); equal.send(second);
    expect(equal.snapshot().queues[0]![1]).toHaveLength(2);
    const below = new InMemoryRelay({ maxQueueBytesPerRecipient: total - 1, now: () => start });
    below.send(first);
    const before = below.snapshot();
    await expectTemporary(await createRelayFetchHandler({ relay: below })(post(second)));
    expect(below.snapshot()).toEqual(before);
    below.receive(recipient.did);
    expect(() => below.send(second)).not.toThrow();
  });

  it('applies sender count within each recipient and combines it with recipient occupancy', async () => {
    const other = generateKeyPair(), another = generateKeyPair();
    const relay = new InMemoryRelay({ maxQueueSize: 2, maxEnvelopesPerSender: 1 });
    const handler = createRelayFetchHandler({ relay });
    relay.send(envelope());
    await expectTemporary(await handler(post(envelope())));
    expect((await handler(post(envelope({}, sender, another)))).status).toBe(202);
    expect((await handler(post(envelope({}, other)))).status).toBe(202);
    await expectTemporary(await handler(post(envelope({}, another))));
    expect(relay.snapshot().queues.find(([did]) => did === recipient.did)![1]).toHaveLength(2);
  });

  it('returns temporary global queue refusal and preserves permanent size and validation errors', async () => {
    const e = envelope(), other = generateKeyPair();
    const relay = new InMemoryRelay({ maxQueues: 1 });
    relay.send(e);
    const before = relay.snapshot();
    await expectTemporary(await createRelayFetchHandler({ relay })(post(envelope({}, sender, other))));
    expect(relay.snapshot()).toEqual(before);
    for (const options of [{ maxEnvelopeBytes: byteLength(e) - 1 }, { maxQueueBytesPerRecipient: byteLength(e) - 1 }]) {
      const capped = new InMemoryRelay(options);
      expect(() => capped.send(e)).toThrow('ENVELOPE_TOO_LARGE');
      const response = await createRelayFetchHandler({ relay: capped })(post(e));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'maxEnvelopeBytes' in options ? 'BODY_TOO_LARGE' : 'ENVELOPE_TOO_LARGE' });
      expect(response.headers.has('retry-after')).toBe(false);
      expect(capped.snapshot().seen).toEqual([]);
      expect(capped.snapshot().queues).toEqual([]);
    }
    const invalid = await createRelayFetchHandler()(post({ payload: {} }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'INVALID_ENVELOPE' });
    const exact = new InMemoryRelay({ maxEnvelopeBytes: byteLength(e), maxQueueBytesPerRecipient: byteLength(e) });
    expect((await createRelayFetchHandler({ relay: exact })(post(e))).status).toBe(202);
  });

  it('does not add replay, expiry, listener or wake state on refusal', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(start);
    const hook = vi.fn(async () => {}), listener = vi.fn();
    const relay = new InMemoryRelay({ maxQueueSize: 1, now: () => start,
      wake: { relay: origin, channels: { default: hook } } });
    relay.registerWake(recipient.did, 'default',
      authorized('/wake', recipient, start).headers.get('authorization')!.slice(7));
    const handler = createRelayFetchHandler({ relay, deferNotifications: true });
    const first = envelope(), refused = envelope();
    expect((await handler(post(first))).status).toBe(202);
    const off = relay.subscribe(recipient.did, listener);
    const before = relay.snapshot();
    await expectTemporary(await handler(post(refused)));
    expect(relay.snapshot()).toEqual(before);
    expect(listener).not.toHaveBeenCalled(); expect(hook).not.toHaveBeenCalled();
    off();
  });

  it.each([false, true])('rejects a live ID after replay expiry or turnover, including restart=%s', async restart => {
    let now = start;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const store = memoryStorage();
    let object = new RelayDurableObject(store.state, { ACP_MAX_SEEN_ENTRIES: '1' });
    const first = envelope(), second = envelope();
    await object.fetch(post(first)); await object.fetch(post(second)); await store.settled();
    const expiry = structuredClone(store.values.get('env:0'));
    const expectReplay = async () => {
      const response = await object.fetch(post(first));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'REPLAYED_ENVELOPE' });
      await store.settled();
      expect(store.values.get('env:0')).toEqual(expiry);
      expect([...store.values.keys()].filter(k => k.startsWith('env:'))).toHaveLength(2);
    };
    if (restart) object = new RelayDurableObject(store.state, { ACP_MAX_SEEN_ENTRIES: '1' });
    await expectReplay();
    now += 3_600_001;
    if (restart) object = new RelayDurableObject(store.state, { ACP_MAX_SEEN_ENTRIES: '1' });
    await expectReplay();
    // ID equality is global even if a newly signed header selects another recipient.
    const moved = signPayload({ ...first.payload, recipientDid: generateKeyPair().did }, sender);
    const inMemory = new InMemoryRelay({ maxSeenEntries: 1, now: () => now });
    inMemory.send(first); inMemory.send(second);
    expect(() => inMemory.send(moved)).toThrow('REPLAYED_ENVELOPE');
  });

  it('keeps acknowledged replay records after reconstruction and bounds history after both records expire', async () => {
    let now = start;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const store = memoryStorage();
    let object = new RelayDurableObject(store.state);
    const e = envelope();
    await object.fetch(post(e)); await store.settled();
    const ack = '/envelopes/' + e.payload.envelopeId + '?recipient=' + encodeURIComponent(recipient.did);
    expect((await object.fetch(authorized(ack, recipient, now, 'DELETE'))).status).toBe(204);
    await store.settled();
    object = new RelayDurableObject(store.state);
    expect((await object.fetch(post(e))).status).toBe(400);
    await store.settled();
    now += 3_600_001;
    object = new RelayDurableObject(store.state);
    expect((await object.fetch(post(e))).status).toBe(202);
    await store.settled();
  });

  it('rolls back admission on a persistence failure and permits the same ID on retry', async () => {
    const store = memoryStorage();
    const object = new RelayDurableObject(store.state);
    await object.fetch(new Request(origin + '/health')); await store.settled();
    const before = structuredClone(store.values);
    const e = envelope();
    store.failNext('meta');
    await expect(object.fetch(post(e))).rejects.toThrow('TEST_STORAGE_WRITE');
    expect(store.values.get('meta')).toEqual(before.get('meta'));
    expect((await object.fetch(post(e))).status).toBe(202);
    await store.settled();
    expect(store.values.get('env:0')).toMatchObject({ envelope: e });
    expect([...store.values.keys()].filter(k => k.startsWith('env:'))).toEqual(['env:0']);
    const restarted = new RelayDurableObject(store.state);
    expect((await restarted.fetch(post(e))).status).toBe(400);
    await store.settled();
  });

  it('preserves durable bytes and leased occupancy on byte refusal across reconstruction', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(start);
    const first = envelope(), next = envelope();
    const store = memoryStorage(), env = { ACP_MAX_QUEUE_BYTES: String(byteLength(first)) };
    let object = new RelayDurableObject(store.state, env);
    expect((await object.fetch(post(first))).status).toBe(202); await store.settled();
    const inbox = '/envelopes?recipient=' + encodeURIComponent(recipient.did) + '&lease=true';
    expect(await (await object.fetch(authorized(inbox, recipient, start))).json()).toEqual(first);
    await store.settled();
    object = new RelayDurableObject(store.state, env);
    await object.fetch(new Request(origin + '/health')); await store.settled();
    const before = structuredClone(store.values);
    store.puts.length = 0;
    await expectTemporary(await object.fetch(post(next))); await store.settled();
    expect(store.values).toEqual(before);
    expect(store.puts).toEqual([]);
    expect(await (await object.fetch(authorized(inbox, recipient, start))).text()).toBe('');
    await store.settled();
    const ack = '/envelopes/' + first.payload.envelopeId + '?recipient=' + encodeURIComponent(recipient.did);
    expect((await object.fetch(authorized(ack, recipient, start, 'DELETE'))).status).toBe(204);
    await store.settled();
    expect((await object.fetch(post(next))).status).toBe(202); await store.settled();
    expect(store.values.get('env:1')).toMatchObject({ envelope: next, expiresAt: start + day });
  });

  it('forwards exact admission errors on recipient shards through both route forms', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(start);
    const store = memoryStorage(), names: string[] = [], paths: string[] = [];
    let object = new RelayDurableObject(store.state, { ACP_MAX_QUEUE_SIZE: '1' });
    const env = { RELAY: {
      idFromName(name: string) { names.push(name); return name; },
      get() { return { fetch(request: Request) { paths.push(new URL(request.url).pathname); return object.fetch(request); } }; },
    } };
    const first = envelope(), refused = envelope();
    expect((await handleRelayEdge(post(first), env)).status).toBe(202); await store.settled();
    const before = structuredClone(store.values);
    for (const prefix of ['', '/v1']) {
      await expectTemporary(await handleRelayEdge(post(refused, prefix), env));
      expect(store.values).toEqual(before);
    }
    object = new RelayDurableObject(store.state, { ACP_MAX_QUEUE_SIZE: '1' });
    await expectTemporary(await handleRelayEdge(post(refused, '/v1'), env)); await store.settled();
    expect(names).toEqual(Array(4).fill('inbox:' + recipient.did));
    expect(paths).toEqual(Array(4).fill('/envelopes'));
    expect([...store.values.values()].filter(value => JSON.stringify(value).includes(refused.payload.envelopeId))).toEqual([]);
    const handler = createRelayFetchHandler();
    for (const prefix of ['', '/v1']) {
      const malformed = () => new Request(origin + prefix + '/envelopes', { method: 'POST', body: '{' });
      for (const response of [await handler(malformed()), await handleRelayEdge(malformed(), env)]) {
        expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'INVALID_REQUEST' });
      }
      const oversized = new Request(origin + prefix + '/envelopes', { method: 'POST', body: 'x'.repeat(1025) });
      const response = await handleRelayEdge(oversized, { ...env, ACP_MAX_ENVELOPE_BYTES: '1024' });
      expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'BODY_TOO_LARGE' });
    }
  });

  it('retains immutable ciphertext and deadline in a sender-owned queue fixture until admission', async () => {
    let now = start;
    const relay = new InMemoryRelay({ maxQueueSize: 1, now: () => now });
    const handler = createRelayFetchHandler({ relay });
    relay.send(envelope());
    const queued = { envelope: envelope(), deadline: start + 2 * day };
    const outbox = [queued], original = JSON.stringify(queued);
    const drain = async () => {
      if (now >= queued.deadline) return;
      const response = await handler(post(outbox[0]!.envelope));
      if (response.status === 202) outbox.shift();
      else { await expectTemporary(response); expect(JSON.stringify(outbox[0])).toBe(original); }
    };
    await drain();
    expect(outbox).toHaveLength(1);
    relay.receive(recipient.did);
    now += 60_000;
    await drain();
    expect(outbox).toHaveLength(0);
    expect(relay.receive(recipient.did)).toEqual(queued.envelope);
    expect(JSON.stringify(queued)).toBe(original);
  });

  it('stores encrypted task traffic and routing without task text or owner private keys', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(start);
    const payload = { title: 'TITLE_CONTENT_312', description: 'DESCRIPTION_CONTENT_571', input: 'INPUT_CONTENT_923' };
    const manifest = buildTaskManifest({ ...payload, ownerDid: sender.did, workerDid: recipient.did,
      now: () => start, taskTimeoutMs: 2 * day });
    const e = signEnvelope({ taskId: manifest.taskId, recipientDid: recipient.did, seq: 0, eventType: 'PROPOSE',
      payload: { proposal: signPayload(manifest, sender), input: payload.input, capabilityChains: [] } as unknown as Json }, sender, { encrypt: true });
    const raw = JSON.stringify(e);
    expect(isEncryptedEnvelopePayload(e.payload.payload)).toBe(true);
    const store = memoryStorage(), object = new RelayDurableObject(store.state);
    expect((await object.fetch(post(e))).status).toBe(202); await store.settled();
    const stored = JSON.stringify([...store.values]);
    expect(stored).not.toContain(manifest.deadline);
    for (const content of Object.values(payload)) { expect(raw).not.toContain(content); expect(stored).not.toContain(content); }
    for (const key of [sender, recipient]) expect(stored).not.toContain(key.privateKey);
    expect(store.values.get('env:0')).toMatchObject({ envelope: e });
    expect(stored).toContain(sender.did); expect(stored).toContain(recipient.did);
    expect(stored).toContain((e.payload.payload as { ciphertext: string }).ciphertext);
  });

  it('keeps current HTTP clients at one rejected attempt and a parseable WebSocket error body', async () => {
    const relay = new InMemoryRelay({ maxQueueSize: 1 });
    relay.send(envelope());
    const handler = createRelayFetchHandler({ relay });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => handler(new Request(input, init)));
    const client = new HttpRelayClient(origin, fetcher, sender);
    let failure: unknown;
    try { await client.send(envelope()); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('RELAY_REJECTED: 429');
    expect(isTransientRelayError(failure)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(JSON.stringify({ ok: false, ...relayErrorBody(new Error('RELAY_RETRY_LATER')) })))
      .toEqual({ ok: false, ...retry });
  });
});
