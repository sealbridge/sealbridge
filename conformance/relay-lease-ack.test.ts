// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { createRelayAuthToken, generateKeyPair, signEnvelope } from '../packages/core/src/index.js';
import { HttpRelayClient } from '../packages/relay/src/index.js';
import { createRelayFetchHandler, InMemoryRelay } from '../packages/relay/src/fetch.js';
import { RelayDurableObject } from '../packages/relay/src/worker.js';

const sender = generateKeyPair(), recipient = generateKeyPair(), stranger = generateKeyPair();
const origin = 'https://relay.example';
function envelope() { return signEnvelope({ taskId: 'lease', recipientDid: recipient.did, seq: 0, eventType: 'PROPOSE', payload: {} }, sender); }
function request(path: string, key = recipient, method = 'GET') {
  return new Request(origin + path, { method, headers: { authorization: 'Bearer ' + createRelayAuthToken(key, { action: 'receive', origin }) } });
}
const path = '/envelopes?waitMs=0&recipient=' + encodeURIComponent(recipient.did);

describe('relay leases (#84)', () => {
  it('redelivers after a crash before ack, retains quotas, and keeps legacy fetch destructive', async () => {
    let now = Date.now();
    const relay = new InMemoryRelay({ now: () => now, maxQueueSize: 1 });
    const handler = createRelayFetchHandler({ relay });
    const e = envelope(); relay.send(e);
    expect(await (await handler(request(path + '&lease=true'))).json()).toEqual({ envelopes: [e] });
    expect(await (await handler(request(path + '&lease=true'))).json()).toEqual({ envelopes: [] });
    expect(() => relay.send(envelope())).toThrow('RELAY_CAPACITY');
    now += 30_001;
    expect(await (await handler(request(path + '&lease=true'))).json()).toEqual({ envelopes: [e] });
    now += 30_001;
    expect(await (await handler(request(path))).json()).toEqual({ envelopes: [e] });
    now += 30_001;
    expect(await (await handler(request(path))).json()).toEqual({ envelopes: [] });
  });
  it('acks only for the authenticated recipient and preserves replay rejection', async () => {
    let now = Date.now();
    const relay = new InMemoryRelay({ now: () => now });
    const handler = createRelayFetchHandler({ relay });
    const e = envelope(); relay.send(e);
    await handler(request(path + '&lease=true'));
    const ackPath = '/envelopes/' + e.payload.envelopeId + '?recipient=' + encodeURIComponent(recipient.did);
    expect((await handler(request(ackPath, stranger, 'DELETE'))).status).toBe(401);
    expect((await handler(request(path + '&lease=true', stranger))).status).toBe(401);
    expect((await handler(request(ackPath, recipient, 'DELETE'))).ok).toBe(true);
    now += 30_001;
    expect(await (await handler(request(path + '&lease=true'))).json()).toEqual({ envelopes: [] });
    expect(() => relay.send(e)).toThrow('REPLAYED_ENVELOPE');
  });
  it('persists leases across durable object restarts and deletes on ack', async () => {
    const values = new Map<string, unknown>();
    const state = {
      storage: { async get<T>(key: string) { return structuredClone(values.get(key)) as T | undefined; }, async put(key: string, value: unknown) { values.set(key, structuredClone(value)); }, async delete(key: string) { return values.delete(key); } },
      blockConcurrencyWhile<T>(fn: () => Promise<T>) { return fn(); },
    };
    let object = new RelayDurableObject(state);
    const e = envelope();
    expect((await object.fetch(new Request(origin + '/envelopes', { method: 'POST', body: JSON.stringify(e) }))).ok).toBe(true);
    expect(await (await object.fetch(request(path + '&lease=true'))).json()).toEqual({ envelopes: [e] });
    object = new RelayDurableObject(state);
    expect(await (await object.fetch(request(path + '&lease=true'))).json()).toEqual({ envelopes: [] });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_001);
    try {
      object = new RelayDurableObject(state);
      expect(await (await object.fetch(request(path + '&lease=true'))).json()).toEqual({ envelopes: [e] });
    } finally { clock.mockRestore(); }
    expect((await object.fetch(request('/envelopes/' + e.payload.envelopeId + '?recipient=' + encodeURIComponent(recipient.did), recipient, 'DELETE'))).ok).toBe(true);
    object = new RelayDurableObject(state);
    expect(await (await object.fetch(request(path + '&lease=true'))).json()).toEqual({ envelopes: [] });
  });
  it('processes duplicate deliveries once and retries a lost ack on redelivery', async () => {
    let now = Date.now(), loseAck = true;
    const relay = new InMemoryRelay({ now: () => now });
    const handler = createRelayFetchHandler({ relay });
    const fetcher: typeof fetch = async (input, init) => {
      if (init?.method === 'DELETE' && loseAck) { loseAck = false; throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); }
      return handler(new Request(input, init));
    };
    const client = new HttpRelayClient(origin, fetcher, recipient);
    const e = envelope(); relay.send(e);
    expect(await client.receive(recipient.did, 0, undefined, { lease: true })).toEqual(e);
    now += 30_001;
    expect(await client.receive(recipient.did, 0, undefined, { lease: true })).toBeUndefined();
    await expect(client.acknowledgeDelivery(recipient.did, e.payload.envelopeId)).rejects.toThrow('reset');
    now += 30_001;
    expect(await client.receive(recipient.did, 0, undefined, { lease: true })).toBeUndefined();
    expect(relay.snapshot().queues).toEqual([]);
  });
});

it('persists before ack and suppresses a proposal after a worker crash before ack', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { WorkerNode, RequesterClient, PolicyAutoApprovalProvider } = await import('../packages/runtime/src/index.js');
  const dir = await mkdtemp(join(tmpdir(), 'acp-lease-'));
  const inbox = join(dir, 'inbox.jsonl');
  let now = Date.now(), proposalId = '', holdAck = true, calls = 0;
  const relay = new InMemoryRelay({ now: () => now });
  const handler = createRelayFetchHandler({ relay });
  const fetcher: typeof fetch = async (input, init) => {
    if (init?.method === 'POST' && String(input).endsWith('/envelopes')) {
      const e = JSON.parse(String(init.body));
      if (e.payload.eventType === 'PROPOSE') proposalId = e.payload.envelopeId;
    }
    if (init?.method === 'DELETE' && String(input).includes(proposalId) && proposalId) {
      const record = JSON.parse((await readFile(inbox, 'utf8')).trim());
      expect(record.envelopeId).toBe(proposalId);
      if (holdAck) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    }
    return handler(new Request(input, init));
  };
  const options = { owner: recipient, inboxPath: inbox, timeoutMs: 3000,
    adapter: { id: 'test', name: 'test', skills: [], executeTask: async () => { calls++; return { ok: true }; } },
    approvalProvider: new PolicyAutoApprovalProvider(recipient) };
  const worker = new WorkerNode({ checkPeer: () => 'trusted', ...options, relay: new HttpRelayClient(origin, fetcher, recipient), relayUrl: origin });
  try {
    const client = new RequesterClient({ owner: sender, relay: new HttpRelayClient(origin, fetcher, sender), timeoutMs: 3000, approvalProvider: new PolicyAutoApprovalProvider(sender) });
    const running = worker.start({ once: true });
    const [result] = await Promise.all([client.delegate({ to: worker.invite(), title: 'lease', description: 'persist', input: {} }), running]);
    expect(result.state).toBe('SETTLED');
    expect(calls).toBe(1);
    worker.stop();
    now += 30_001; holdAck = false;
    const restarted = new WorkerNode({ checkPeer: () => 'trusted', ...options, relay: new HttpRelayClient(origin, fetcher, recipient), relayUrl: origin });
    await restarted.start({ signal: AbortSignal.timeout(100) });
    restarted.stop();
    expect(calls).toBe(1);
    expect((await readFile(inbox, 'utf8')).trim().split('\n')).toHaveLength(1);
    expect(relay.snapshot().queues.flatMap(([, q]) => q).some(e => e.payload.envelopeId === proposalId)).toBe(false);
  } finally { worker.stop(); await rm(dir, { recursive: true, force: true }); }
});

it('does not busy-poll an inbox containing only leased envelopes', async () => {
  const relay = new InMemoryRelay();
  const e = envelope(); relay.send(e);
  relay.receive(recipient.did, undefined, undefined, { lease: true });
  const controller = new AbortController();
  let finished = false;
  const waiting = relay.wait(recipient.did, 1000, controller.signal, { lease: true }).then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(finished).toBe(false);
  controller.abort();
  await waiting;
});

it('never extends the envelope TTL by leasing', async () => {
  let now = Date.now();
  const relay = new InMemoryRelay({ now: () => now, envelopeTtlMs: 1000 });
  relay.send(envelope());
  expect(relay.receive(recipient.did, undefined, undefined, { lease: true })).toBeDefined();
  now += 1001;
  expect(relay.receive(recipient.did, undefined, undefined, { lease: true })).toBeUndefined();
  expect(relay.snapshot().queues).toEqual([]);
});
