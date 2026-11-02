// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifySigned } from '../packages/core/src/index.js';
import { DEFAULT_ENVELOPE_TTL_MS, InMemoryRelay, relayLimitsFromEnv } from '../packages/relay/src/fetch.js';
import { RelayDurableObject } from '../packages/relay/src/worker.js';
import { authorized, day, envelope, memoryStorage, origin, post, recipient, sender, start, statusPath } from './relay-test-fixtures.js';

afterEach(() => vi.restoreAllMocks());

describe('relay retention', () => {
  it.each([-1, 0, 1])('applies the default 24-hour boundary at offset %i ms in memory', offset => {
    let now = start;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const relay = new InMemoryRelay({ now: () => now });
    const e = envelope();
    relay.send(e);
    expect(DEFAULT_ENVELOPE_TTL_MS).toBe(day);
    expect(relay.snapshot().envelopeExpiry).toEqual([[e.payload.envelopeId, start + day]]);
    now = start + day + offset;
    expect(relay.receive(recipient.did, undefined, undefined, { peek: true })).toEqual(offset < 0 ? e : undefined);
    const status = relay.getDeliveryStatus(recipient.did, e.payload.envelopeId, sender.did, origin,
      // Direct calls still require a sender credential for status lookup.
      authorized(statusPath(e.payload.envelopeId), sender, now).headers.get('authorization')!.slice(7));
    expect(status.payload.state).toBe(offset < 0 ? 'pending' : 'expired');
    expect(status.payload.expiresAt).toBe(start + day);
    expect(verifySigned(status, relay.notificationDid)).toBe(true);
  });

  it.each([-1, 0, 1])('preserves the 24-hour boundary after object reconstruction at offset %i ms', async offset => {
    let now = start;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const store = memoryStorage();
    let object = new RelayDurableObject(store.state);
    const e = envelope();
    const accepted = await object.fetch(post(e));
    expect(accepted.status).toBe(202);
    const relayDid = accepted.headers.get('x-acp-relay-did')!;
    await store.settled();
    expect(store.values.get('env:0')).toMatchObject({ expiresAt: start + day, envelope: e });
    now = start + day + offset;
    object = new RelayDurableObject(store.state);
    const result = await object.fetch(authorized(statusPath(e.payload.envelopeId), sender, now));
    expect(result.status).toBe(200);
    const status = await result.json();
    expect(status.payload.state).toBe(offset < 0 ? 'pending' : 'expired');
    expect(status.payload.expiresAt).toBe(start + day);
    expect(verifySigned(status, relayDid)).toBe(true);
    await store.settled();
    expect(store.values.has('env:0')).toBe(offset < 0);
  });

  it.each([60_000, 2 * day])('uses an explicit retention interval of %i ms', ttl => {
    let now = start;
    const relay = new InMemoryRelay({ envelopeTtlMs: ttl, now: () => now });
    const e = envelope(); relay.send(e);
    now += ttl - 1;
    expect(relay.receive(recipient.did, undefined, undefined, { peek: true })).toEqual(e);
    now++;
    expect(relay.receive(recipient.did)).toBeUndefined();
  });

  it.each([60_000, 2 * day])('preserves a configured %i ms expiry across object reconstruction', async ttl => {
    let now = start;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const store = memoryStorage(), env = { ACP_ENVELOPE_TTL_MS: String(ttl) }, e = envelope();
    let object = new RelayDurableObject(store.state, env);
    expect((await object.fetch(post(e))).status).toBe(202); await store.settled();
    for (const offset of [-1, 0, 1]) {
      now = start + ttl + offset;
      object = new RelayDurableObject(store.state, env);
      const response = await object.fetch(authorized(statusPath(e.payload.envelopeId), sender, now));
      expect(response.status).toBe(200);
      expect((await response.json()).payload).toMatchObject({ state: offset < 0 ? 'pending' : 'expired',
        expiresAt: start + ttl });
      await store.settled();
    }
  });

  it('keeps live IDs and original expiry after the one-hour replay record expires or turns over', () => {
    let now = start;
    const relay = new InMemoryRelay({ now: () => now, maxSeenEntries: 1 });
    const first = envelope(), second = envelope();
    relay.send(first); relay.send(second);
    const afterTurnover = relay.snapshot();
    expect(afterTurnover.seen).toEqual([second.payload.envelopeId]);
    expect(() => relay.send(first)).toThrow('REPLAYED_ENVELOPE');
    expect(relay.snapshot()).toEqual(afterTurnover);
    now += 3_600_001;
    const afterExpiry = relay.snapshot();
    expect(afterExpiry.seen).toEqual([]);
    expect(() => relay.send(first)).toThrow('REPLAYED_ENVELOPE');
    expect(relay.snapshot()).toEqual(afterExpiry);
    expect(relay.snapshot().envelopeExpiry).toContainEqual([first.payload.envelopeId, start + day]);
  });

  it('keeps a stored ten-minute expiry when the object starts with the new default', async () => {
    let now = start;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const store = memoryStorage();
    let object = new RelayDurableObject(store.state, { ACP_ENVELOPE_TTL_MS: '600000' });
    const old = envelope();
    expect((await object.fetch(post(old))).status).toBe(202);
    await store.settled();
    now += 599_999;
    store.puts.length = 0;
    object = new RelayDurableObject(store.state);
    expect((await object.fetch(new Request(origin + '/health'))).status).toBe(200);
    await store.settled();
    expect(store.puts).not.toContain('env:0');
    expect(store.values.get('env:0')).toMatchObject({ expiresAt: start + 600_000 });
    const fresh = envelope();
    expect((await object.fetch(post(fresh))).status).toBe(202);
    await store.settled();
    expect(store.values.get('env:1')).toMatchObject({ expiresAt: now + day });
    now++;
    await object.alarm();
    expect(store.values.has('env:0')).toBe(false);
    expect(store.values.has('env:1')).toBe(true);
  });

  it('honors explicit expiries while migrating a legacy snapshot', async () => {
    let now = start;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const store = memoryStorage(), e = envelope();
    store.values.set('relay-head', { generation: 'legacy', count: 1 });
    store.values.set('relay:legacy:0', new Uint8Array(Buffer.from(JSON.stringify({
      queues: [[recipient.did, [e]]], seen: [], agents: [],
      envelopeExpiry: [[e.payload.envelopeId, start + 600_000]],
    }))));
    const object = new RelayDurableObject(store.state);
    await object.fetch(new Request(origin + '/health')); await store.settled();
    expect(store.values.has('relay-head')).toBe(false);
    expect(store.values.get('env:0')).toMatchObject({ expiresAt: start + 600_000 });
    now += 600_000;
    await object.alarm();
    expect(store.values.has('env:0')).toBe(false);
  });

  it('reschedules alarms after replay expiry and retains a signed expiry notice across restart', async () => {
    let now = start;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const store = memoryStorage();
    let object = new RelayDurableObject(store.state);
    const e = envelope();
    const accepted = await object.fetch(post(e)); await store.settled();
    const relayDid = accepted.headers.get('x-acp-relay-did')!;
    expect(store.state.storage.setAlarm).toHaveBeenLastCalledWith(start + 3_600_000);
    now += 3_600_000;
    await object.alarm();
    expect(store.state.storage.setAlarm).toHaveBeenLastCalledWith(start + day);
    now = start + day;
    await object.alarm();
    expect(store.values.has('env:0')).toBe(false);
    expect(store.state.storage.setAlarm).toHaveBeenLastCalledWith(now + 3_600_000);
    object = new RelayDurableObject(store.state);
    const status = await (await object.fetch(authorized(statusPath(e.payload.envelopeId), sender, now))).json();
    expect(status.payload.state).toBe('expired');
    expect(verifySigned(status, relayDid)).toBe(true);
    await store.settled();
  });

  it('keeps the existing environment fallback and positive-integer constructor validation', () => {
    const defaults = new InMemoryRelay(relayLimitsFromEnv({}));
    expect([defaults.envelopeTtlMs, defaults.maxQueueSize, defaults.maxQueueBytesPerRecipient,
      defaults.maxEnvelopeBytes, defaults.maxEnvelopesPerSender, defaults.seenTtlMs,
      defaults.authSeenTtlMs, defaults.agentCardTtlMs, defaults.notificationTtlMs])
      .toEqual([day, 256, 4_194_304, 262_144, 256, 3_600_000, 600_000, 3_600_000, 3_600_000]);
    const options = { envelopeTtlMs: 'ACP_ENVELOPE_TTL_MS', maxQueueSize: 'ACP_MAX_QUEUE_SIZE',
      maxQueueBytesPerRecipient: 'ACP_MAX_QUEUE_BYTES', maxEnvelopeBytes: 'ACP_MAX_ENVELOPE_BYTES',
      maxEnvelopesPerSender: 'ACP_MAX_ENVELOPES_PER_SENDER', seenTtlMs: 'ACP_SEEN_TTL_MS' } as const;
    for (const [option, binding] of Object.entries(options)) {
      expect(new InMemoryRelay(relayLimitsFromEnv({ [binding]: '123' }))[option as keyof typeof options]).toBe(123);
      for (const invalid of ['', 'no', '0', '-1', '1.5', 'Infinity', '9007199254740992']) {
        expect(relayLimitsFromEnv({ [binding]: invalid })[option as keyof typeof options]).toBeUndefined();
      }
      for (const invalid of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
        expect(() => new InMemoryRelay({ [option]: invalid })).toThrow('INVALID_RELAY_LIMIT');
    }
    expect(new InMemoryRelay({ maxQueueSize: 7 }).maxEnvelopesPerSender).toBe(7);
  });
});
