// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRelayAuthToken, generateKeyPair, signEnvelope, signPayload, verifySigned } from '../packages/core/src/index.js';
import { HttpRelayClient } from '../packages/relay/src/index.js';
import { createRelayFetchHandler, InMemoryRelay } from '../packages/relay/src/fetch.js';
import { verifyRelayWake } from '../packages/relay/src/notifications.js';
import type { RelayWakeOptions, SignedRelayWake } from '../packages/relay/src/notifications.js';
import { loadRelayState } from '../packages/relay/src/journal.js';
import { RelayDurableObject, handleRelayEdge, resetRelayRateLimits } from '../packages/relay/src/worker.js';
import { PolicyAutoApprovalProvider, RequesterClient, WorkerNode } from '../packages/runtime/src/index.js';

const origin = 'https://relay.example';
const sender = generateKeyPair(), recipient = generateKeyPair(), other = generateKeyPair();
function envelope(taskId = 'offline', eventType = 'PROPOSE') {
  return signEnvelope({ taskId, recipientDid: recipient.did, seq: 0, eventType,
    payload: { input: 'private task content' } }, sender, { encrypt: true });
}
function request(path: string, key = recipient, method = 'GET', body?: unknown) {
  return new Request(origin + path, { method, headers: {
    authorization: 'Bearer ' + createRelayAuthToken(key, { action: 'receive', origin }),
  }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
const wakePath = '/wake?recipient=' + encodeURIComponent(recipient.did);
function memoryStorage() {
  const values = new Map<string, unknown>();
  const state = {
    storage: {
      async get<T>(key: string) { return structuredClone(values.get(key)) as T | undefined; },
      async put(key: string, value: unknown) { values.set(key, structuredClone(value)); },
      async delete(key: string) { return values.delete(key); },
      setAlarm: vi.fn(async (_at: number | Date) => {}),
      deleteAlarm: vi.fn(async () => {}),
    },
    blockConcurrencyWhile<T>(fn: () => Promise<T>) { return fn(); },
  };
  return { values, state };
}
function client(handler: (r: Request) => Promise<Response>, key = sender) {
  return new HttpRelayClient(origin, async (input, init) => handler(new Request(input, init)), key);
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resetRelayRateLimits(); });

describe('offline wake notifications', () => {
  it('queues offline work without a wake by default', async () => {
    const relay = new InMemoryRelay();
    const handler = createRelayFetchHandler({ relay });
    const e = envelope();
    await client(handler).send(e);
    await relay.flushWakeNotifications();
    expect(relay.snapshot().operations).toEqual([]);
    expect(relay.receive(recipient.did)).toEqual(e);
    expect((await handler(request(wakePath, recipient, 'POST', { channel: 'default' }))).status).toBe(400);
  });

  it('emits exactly one authenticated wake containing only routing metadata for an offline task', async () => {
    const hook = vi.fn(async (_wake: SignedRelayWake) => {});
    const relay = new InMemoryRelay({ wake: { relay: origin, channels: { default: hook } } });
    const handler = createRelayFetchHandler({ relay });
    expect((await handler(request(wakePath, other, 'POST', { channel: 'default' }))).status).toBe(401);
    expect((await handler(request(wakePath, recipient, 'POST', { channel: 'https://unconfigured.example' }))).status).toBe(400);
    expect((await handler(request(wakePath, recipient, 'POST', { channel: 'default' }))).ok).toBe(true);
    const e = envelope();
    await client(handler).send(e);
    await client(handler).send(envelope('offline', 'AUDIT_ENTRY'));
    await relay.flushWakeNotifications();
    expect(hook).toHaveBeenCalledTimes(1);
    const notice = hook.mock.calls[0]![0];
    expect(notice.payload).toEqual({ recipientDid: recipient.did, taskId: 'offline', relay: origin });
    expect(verifyRelayWake(notice, relay.notificationDid, origin)).toBe(true);
    expect(verifyRelayWake(notice, other.did, origin)).toBe(false);
    expect(verifyRelayWake(notice, relay.notificationDid, origin, Date.now() + 300_001)).toBe(false);
    expect(JSON.stringify(notice)).not.toContain('private task content');
    expect(JSON.stringify(notice)).not.toContain(JSON.stringify(e.payload.payload));
  });

  it('requires recipient opt-in and suppresses wakes while an inbox is connected', async () => {
    const hook = vi.fn(async (_wake: SignedRelayWake) => {});
    const relay = new InMemoryRelay({ wake: { relay: origin, channels: { default: hook } } });
    const handler = createRelayFetchHandler({ relay });
    await client(handler).send(envelope('unregistered'));
    expect(hook).not.toHaveBeenCalled();
    await handler(request(wakePath, recipient, 'POST', { channel: 'default' }));
    const off = relay.subscribe(recipient.did, () => {});
    await client(handler).send(envelope('connected'));
    expect(hook).not.toHaveBeenCalled();
    off();
    await client(handler).send(envelope('disconnected'));
    expect(hook).toHaveBeenCalledTimes(1);
    // A recipient can revoke registration and outstanding retry work.
    await handler(request(wakePath, recipient, 'POST', { channel: null }));
    await client(handler).send(envelope('unregistered-again'));
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('retries failed wakes with bounded exponential backoff across durable restarts', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const hook = vi.fn(async () => { throw new Error('unavailable'); });
    const wake: RelayWakeOptions = { relay: origin, channels: { default: hook }, maxAttempts: 3, retryBaseMs: 100 };
    const { state } = memoryStorage();
    let object = new RelayDurableObject(state, { ACP_WAKE: wake });
    await object.fetch(request(wakePath, recipient, 'POST', { channel: 'default' }));
    await client(r => object.fetch(r)).send(envelope());
    await object.alarm();
    expect(hook).toHaveBeenCalledTimes(1);
    object = new RelayDurableObject(state, { ACP_WAKE: wake });
    await object.alarm();
    expect(hook).toHaveBeenCalledTimes(1);
    now += 100;
    await object.alarm();
    expect(hook).toHaveBeenCalledTimes(2);
    now += 199;
    await object.alarm();
    expect(hook).toHaveBeenCalledTimes(2);
    now++;
    await object.alarm();
    expect(hook).toHaveBeenCalledTimes(3);
    now += 10_000;
    object = new RelayDurableObject(state, { ACP_WAKE: wake });
    await object.alarm();
    expect(hook).toHaveBeenCalledTimes(3);
  });

  it('commits a durable wake before calling the endpoint and does not repeat a successful wake after restart', async () => {
    const { state } = memoryStorage();
    const endpoint = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://wake.example/receive');
      expect(init?.redirect).toBe('error');
      const notice = JSON.parse(String(init?.body));
      const loaded = await loadRelayState(state.storage, Date.now(), { seenMod: 4096, authMod: 4096 });
      expect(loaded.snapshot?.operations?.some(([, op]) => op.kind === 'wake' && op.attempts === 1)).toBe(true);
      expect(notice.payload).toEqual({ recipientDid: recipient.did, taskId: 'offline', relay: origin });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', endpoint);
    const env = { ACP_WAKE_ENDPOINT: 'https://wake.example/receive', ACP_WAKE_RELAY: origin };
    let object = new RelayDurableObject(state, env);
    await object.fetch(request(wakePath, recipient, 'POST', { channel: 'default' }));
    await client(r => object.fetch(r)).send(envelope());
    await object.alarm();
    object = new RelayDurableObject(state, env);
    await object.alarm();
    await client(r => object.fetch(r)).send(envelope('offline', 'AUDIT_ENTRY'));
    expect(endpoint).toHaveBeenCalledTimes(1);
  });

  it('keeps durable inbox delivery available while a wake endpoint is still responding', async () => {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const wake: RelayWakeOptions = { relay: origin, channels: { default: async () => { entered(); await waiting; } } };
    const object = new RelayDurableObject(memoryStorage().state, { ACP_WAKE: wake });
    await object.fetch(request(wakePath, recipient, 'POST', { channel: 'default' }));
    const e = envelope();
    await client(r => object.fetch(r)).send(e);
    await started;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const received = await Promise.race([
        client(r => object.fetch(r), recipient).receive(recipient.did, 0),
        new Promise<string>(resolve => { timer = setTimeout(() => resolve('blocked by notification'), 100); }),
      ]);
      expect(received).toEqual(e);
    } finally { clearTimeout(timer); release(); await object.alarm(); }
  });

  it('bounds a hung wake attempt and stops retries after the queued task expires', async () => {
    let now = Date.now();
    const callback = vi.fn(async (_wake: SignedRelayWake, signal: AbortSignal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    const relay = new InMemoryRelay({ now: () => now, envelopeTtlMs: 100,
      wake: { relay: origin, channels: { default: callback }, timeoutMs: 10, retryBaseMs: 10 } });
    const handler = createRelayFetchHandler({ relay });
    await handler(request(wakePath, recipient, 'POST', { channel: 'default' }));
    await client(handler).send(envelope());
    expect(callback).toHaveBeenCalledTimes(1);
    now += 101;
    relay.evictExpired();
    await relay.flushWakeNotifications();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('reconciles queued work on recipient startup without putting task content in the wake', async () => {
    const hook = vi.fn(async (_wake: SignedRelayWake) => {});
    const relay = new InMemoryRelay({ wake: { relay: origin, channels: { default: hook } } });
    const handler = createRelayFetchHandler({ relay });
    const worker = client(handler, recipient);
    const relayDid = await worker.registerWake(recipient.did, 'default');
    const e = envelope();
    await client(handler).send(e);
    expect(verifyRelayWake(hook.mock.calls[0]![0], relayDid, origin)).toBe(true);
    // The notification receiver starts the ordinary recipient process; startup polls its authenticated inbox.
    expect(await worker.receive(recipient.did, 0)).toEqual(e);
    expect(await worker.receive(recipient.did, 0)).toBeUndefined();
  });
});

describe('queued envelope expiry notices', () => {
  it('records a tombstone and returns a signed expiry notice distinct from pending or unknown', async () => {
    let now = Date.now();
    const relay = new InMemoryRelay({ now: () => now, envelopeTtlMs: 100 });
    const handler = createRelayFetchHandler({ relay });
    const requester = client(handler);
    const e = envelope();
    await requester.send(e);
    expect((await requester.deliveryStatus(e))?.payload.state).toBe('pending');
    now += 101;
    const notice = await requester.deliveryStatus(e);
    expect(notice?.payload).toMatchObject({ state: 'expired', taskId: e.payload.taskId,
      envelopeId: e.payload.envelopeId, senderDid: sender.did, recipientDid: recipient.did, relay: origin });
    expect(verifySigned(notice!, relay.notificationDid)).toBe(true);
    expect(relay.snapshot().operations?.some(([, op]) => op.kind === 'expiry' && op.notice.payload.envelopeId === e.payload.envelopeId)).toBe(true);
    expect(relay.receive(recipient.did)).toBeUndefined();
    expect(() => relay.send(e)).toThrow('REPLAYED_ENVELOPE');
    const params = new URLSearchParams({ recipient: recipient.did, sender: sender.did, envelopeId: e.payload.envelopeId });
    expect((await handler(request('/delivery-status?' + params, other))).status).toBe(401);
    params.set('sender', other.did);
    const hidden = await (await handler(request('/delivery-status?' + params, other))).json();
    expect(hidden.payload.state).toBe('unknown');
  });

  it('persists expiry tombstones and relay identity when an inbox expires while asleep', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { state, values } = memoryStorage();
    let object = new RelayDurableObject(state, { ACP_ENVELOPE_TTL_MS: '100' });
    const requester = client(r => object.fetch(r));
    const e = envelope();
    await requester.send(e);
    now += 101;
    object = new RelayDurableObject(state, { ACP_ENVELOPE_TTL_MS: '100' });
    await object.alarm();
    expect([...values.keys()].some(key => key.startsWith('operation:'))).toBe(true);
    object = new RelayDurableObject(state, { ACP_ENVELOPE_TTL_MS: '100' });
    const notice = await requester.deliveryStatus(e);
    expect(notice?.payload.state).toBe('expired');
    const params = new URLSearchParams({ recipient: recipient.did, sender: sender.did, envelopeId: e.payload.envelopeId });
    const again = await (await object.fetch(request('/delivery-status?' + params, sender))).json();
    expect(verifySigned(again, notice!.signature.signerDid)).toBe(true);
    expect(again.payload).toEqual(notice!.payload);
    expect((await object.fetch(request('/envelopes?recipient=' + encodeURIComponent(recipient.did)))).status).toBe(204);
  });

  it('does not issue an expiry notice for an envelope already delivered', async () => {
    let now = Date.now();
    const relay = new InMemoryRelay({ now: () => now, envelopeTtlMs: 10 });
    const handler = createRelayFetchHandler({ relay });
    const requester = client(handler);
    const e = envelope();
    await requester.send(e);
    expect(await client(handler, recipient).receive(recipient.did, 0)).toEqual(e);
    now += 11;
    expect((await requester.deliveryStatus(e))?.payload.state).toBe('unknown');
    expect(relay.snapshot().operations).toEqual([]);
  });

  it.each(['identity', 'routing'])('rejects status notices with tampered %s', async mode => {
    const relay = new InMemoryRelay();
    const handler = createRelayFetchHandler({ relay });
    let substitute = false;
    const requester = new HttpRelayClient(origin, async (input, init) => {
      const result = await handler(new Request(input, init));
      if (!substitute || !String(input).includes('/delivery-status')) return result;
      const notice = await result.json();
      if (mode === 'identity') return Response.json(signPayload(notice.payload, other));
      notice.payload.envelopeId = 'different';
      return Response.json(notice);
    }, sender);
    const e = envelope();
    await requester.send(e);
    substitute = true;
    await expect(requester.deliveryStatus(e)).rejects.toThrow('RELAY_TAMPERING_DETECTED');
  });

  it('bounds tombstone retention without consuming recipient queue admission', async () => {
    let now = Date.now();
    const relay = new InMemoryRelay({ now: () => now, envelopeTtlMs: 10, notificationTtlMs: 100, maxQueueSize: 1 });
    const handler = createRelayFetchHandler({ relay });
    const e = envelope();
    const requester = client(handler);
    await requester.send(e);
    now += 11;
    expect((await requester.deliveryStatus(e))?.payload.state).toBe('expired');
    await requester.send(envelope('next'));
    now += 101;
    relay.evictExpired();
    expect(relay.snapshot().operations?.filter(([, op]) => op.kind === 'expiry')).toHaveLength(1);
  });

  it('routes wake registration and requester status to the original recipient shard', async () => {
    const names: string[] = [];
    const objects = new Map<string, RelayDurableObject>();
    const env = { RELAY: {
      idFromName(name: string) { names.push(name); return name; },
      get(id: unknown) {
        if (!objects.has(String(id))) objects.set(String(id), new RelayDurableObject(memoryStorage().state));
        return objects.get(String(id))!;
      },
    } };
    const requester = client(r => handleRelayEdge(r, env));
    const e = envelope();
    await requester.send(e);
    expect((await requester.deliveryStatus(e))?.payload.state).toBe('pending');
    await handleRelayEdge(request(wakePath, recipient, 'POST', { channel: null }), env);
    expect(names).toEqual(Array(3).fill('inbox:' + recipient.did));
  });

  it('surfaces queued task expiry to the requester as a task error rather than a generic timeout', async () => {
    const relay = new InMemoryRelay({ envelopeTtlMs: 50 });
    const handler = createRelayFetchHandler({ relay });
    const worker = new WorkerNode({ checkPeer: () => 'trusted', owner: recipient, relay: client(handler, recipient), relayUrl: origin,
      adapter: { id: 'offline', name: 'offline', skills: [], async executeTask() { return {}; } },
      approvalProvider: new PolicyAutoApprovalProvider(recipient) });
    const requester = new RequesterClient({ owner: sender, relay: client(handler), timeoutMs: 5000,
      approvalProvider: new PolicyAutoApprovalProvider(sender) });
    await expect(requester.delegate({ to: worker.invite(), title: 'offline', description: 'queued task', input: {} }))
      .rejects.toMatchObject({ code: 'RELAY_ENVELOPE_EXPIRED', notice: { payload: { state: 'expired' } } });
  });
});


it('keeps a shared requester inbox usable after another task expires', async () => {
  const relay = new InMemoryRelay({ envelopeTtlMs: 500 });
  const handler = createRelayFetchHandler({ relay });
  const adapter = { id: 'echo', name: 'echo', skills: [], async executeTask() { return { ok: true }; } };
  const offline = new WorkerNode({ checkPeer: () => 'trusted', owner: recipient, relay: client(handler, recipient), relayUrl: origin,
    adapter, approvalProvider: new PolicyAutoApprovalProvider(recipient) });
  const online = new WorkerNode({ checkPeer: () => 'trusted', owner: other, relay: client(handler, other), relayUrl: origin,
    adapter, approvalProvider: new PolicyAutoApprovalProvider(other) });
  const requester = new RequesterClient({ owner: sender, relay: client(handler), timeoutMs: 5000,
    approvalProvider: new PolicyAutoApprovalProvider(sender) });
  const running = online.start();
  try {
    const expired = expect(requester.delegate({ to: offline.invite(), title: 'offline', description: 'wait', input: {} }))
      .rejects.toMatchObject({ code: 'RELAY_ENVELOPE_EXPIRED' });
    expect((await requester.delegate({ to: online.invite(), title: 'online', description: 'echo', input: {} })).state).toBe('SETTLED');
    await expired;
    expect((await requester.delegate({ to: online.invite(), title: 'still online', description: 'echo', input: {} })).state).toBe('SETTLED');
  } finally { online.stop(); await running; }
});
