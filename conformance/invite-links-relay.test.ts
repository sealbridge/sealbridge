// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createRelayAuthToken, generateKeyPair, generateInviteLinkKey, deriveInviteLinkKeys, inviteLinkClaimTag,
  encryptInviteLink, packInviteLinkCiphertext } from '../packages/core/src/index.js';
import { InviteDurableObject, routeInvite } from '../packages/relay/src/invites.js';
import type { InviteNamespace, InviteStorage } from '../packages/relay/src/invites.js';
import { handleRelayEdge, resetRelayRateLimits } from '../packages/relay/src/worker.js';
import { createRelayFetchHandler } from '../packages/relay/src/fetch.js';

const origin = 'https://relay.example';
afterEach(() => { vi.useRealTimers(); resetRelayRateLimits(); });
function harness() {
  const values = new Map<string, Map<string, unknown>>(), objects = new Map<string, InviteDurableObject>(), alarms = new Map<string, number>();
  const namespace: InviteNamespace = { idFromName: n => n, get(id) {
    const name = String(id); let object = objects.get(name);
    if (!object) {
      let map = values.get(name); if (!map) { map = new Map(); values.set(name, map); }
      const storage: InviteStorage = { get: async <T>(k: string) => structuredClone(map!.get(k)) as T,
        put: async (k, v) => { map!.set(k, structuredClone(v)); },
        setAlarm: async at => { alarms.set(name, Number(at)); }, deleteAlarm: async () => { alarms.delete(name); } };
      object = new InviteDurableObject({ storage }, { INVITES: namespace }); objects.set(name, object);
    }
    return object;
  } };
  return { namespace, values, objects, alarms, restart: () => objects.clear(), fetch: (request: Request) => routeInvite(request, namespace) };
}
function fixture(owner = generateKeyPair(), ttl = 86400000) {
  const k = generateInviteLinkKey(), keys = deriveInviteLinkKeys(k), tag = inviteLinkClaimTag(keys.accessKey, keys.id).toString('base64url');
  const encrypted = packInviteLinkCiphertext(encryptInviteLink('acp-invite:plaintext-must-never-be-stored', k,
    { relayOrigin: origin, expiresAt: new Date(Date.now() + ttl).toISOString() }));
  return { owner, k, tag, id: encrypted.id, encrypted, create: { ...encrypted, tagHash: createHash('sha256').update(Buffer.from(tag, 'base64url')).digest('base64url') },
    claim: { id: encrypted.id, tag, claimNonce: randomBytes(32).toString('base64url') } };
}
function req(path: string, method = 'GET', body?: unknown, owner?: ReturnType<typeof generateKeyPair>, ip = '192.0.2.1') {
  return new Request(origin + '/v1' + path, { method, headers: { 'cf-connecting-ip': ip,
    ...(owner ? { authorization: 'Bearer ' + createRelayAuthToken(owner, { action: 'invite-manage', origin }) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function admit(h: ReturnType<typeof harness>, f: ReturnType<typeof fixture>) {
  expect((await h.fetch(req('/invites', 'POST', f.create, f.owner))).status).toBe(201);
}
const unavailable = { error: 'INVITE_LINK_UNAVAILABLE' };

describe('SC2 invite object', () => {
  it('has one concurrent winner, a bounded retry for its nonce, and alarm ciphertext cleanup', async () => {
    vi.useFakeTimers(); const h = harness(), f = fixture(); await admit(h, f);
    const claims = await Promise.all([h.fetch(req('/invites/claim', 'POST', f.claim)), h.fetch(req('/invites/claim', 'POST', { ...f.claim, claimNonce: randomBytes(32).toString('base64url') }))]);
    expect(claims.map(r => r.status)).toEqual([200, 404]);
    expect(await claims[0].json()).toEqual(f.encrypted);
    h.restart();
    expect((await h.fetch(req('/invites/claim', 'POST', f.claim))).status).toBe(200);
    vi.advanceTimersByTime(119999);
    expect((await h.fetch(req('/invites/claim', 'POST', f.claim))).status).toBe(200);
    vi.advanceTimersByTime(1);
    await (h.namespace.get('invite:' + f.id) as InviteDurableObject).alarm();
    expect((await h.fetch(req('/invites/claim', 'POST', f.claim))).status).toBe(404);
    const saved = h.values.get('invite:' + f.id)!.get('invite') as Record<string, unknown>;
    expect(saved).not.toHaveProperty('encrypted'); expect(saved).not.toHaveProperty('tagHash');
    expect(saved).not.toHaveProperty('claimNonceHash'); expect(h.alarms.has('invite:' + f.id)).toBe(false);
    const status = await (await h.fetch(req('/invites/' + f.id + '/status', 'GET', undefined, f.owner))).json();
    expect(status).toMatchObject({ status: 'claimed', claimedAt: expect.any(String) });
    expect(Object.keys(status as object).sort()).toEqual(['claimedAt', 'expiresAt', 'id', 'status']);
    expect(JSON.stringify(status)).not.toContain('192.0.2.1');
  });
  it('expires at the exact boundary and alarm wipes the ciphertext', async () => {
    vi.useFakeTimers(); const h = harness(), f = fixture(undefined, 300000); await admit(h, f);
    vi.advanceTimersByTime(300000);
    await (h.namespace.get('invite:' + f.id) as InviteDurableObject).alarm();
    expect(await (await h.fetch(req('/invites/claim', 'POST', f.claim))).json()).toEqual(unavailable);
    expect(await (await h.fetch(req('/invites/' + f.id + '/status', 'GET', undefined, f.owner))).json()).toMatchObject({ status: 'expired' });
    expect(JSON.stringify(h.values.get('invite:' + f.id)!.get('invite'))).not.toContain(f.encrypted.ciphertext);
  });
  it('locks after exactly three wrong tags across restarts', async () => {
    const h = harness(), f = fixture(); await admit(h, f);
    for (let i = 0; i < 3; i++) {
      expect(await (await h.fetch(req('/invites/claim', 'POST', { ...f.claim, tag: randomBytes(32).toString('base64url') }))).json()).toEqual(unavailable);
      h.restart();
      const status = await (await h.fetch(req('/invites/' + f.id + '/status', 'GET', undefined, f.owner))).json() as { status: string };
      expect(status.status).toBe(i < 2 ? 'unused' : 'locked_out');
    }
    expect((await h.fetch(req('/invites/claim', 'POST', f.claim))).status).toBe(404);
    expect(JSON.stringify(h.values.get('invite:' + f.id)!.get('invite'))).not.toContain(f.encrypted.ciphertext);
  });
  it('uses one claimant 404 shape for missing, malformed, bad tag, cancelled and used links', async () => {
    const h = harness(), f = fixture(); await admit(h, f);
    for (const body of [{}, { ...f.claim, id: randomBytes(16).toString('base64url') }, { ...f.claim, tag: randomBytes(32).toString('base64url') }, { ...f.claim, claimNonce: '' }]) {
      const response = await h.fetch(req('/invites/claim', 'POST', body));
      expect(response.status).toBe(404); expect(await response.json()).toEqual(unavailable);
    }
    expect((await h.fetch(req('/invites/claim', 'POST', f.claim))).status).toBe(200);
    expect(await (await h.fetch(req('/invites/claim', 'POST', { ...f.claim, claimNonce: randomBytes(32).toString('base64url') }))).json()).toEqual(unavailable);
    expect((await h.fetch(req('/invites/' + f.id, 'DELETE', undefined, f.owner))).status).toBe(200);
    expect(await (await h.fetch(req('/invites/claim', 'POST', f.claim))).json()).toEqual(unavailable);
  });
  it('retains no key, plaintext, raw tag or nonce and rejects extra create fields', async () => {
    const h = harness(), f = fixture(); await admit(h, f);
    await h.fetch(req('/invites/claim', 'POST', f.claim));
    const saved = JSON.stringify([...h.values.values()].map(m => [...m]));
    for (const secret of [f.k, f.tag, f.claim.claimNonce, 'plaintext-must-never-be-stored']) expect(saved).not.toContain(secret);
    const other = fixture();
    expect((await h.fetch(req('/invites', 'POST', { ...other.create, token: 'plaintext' }, other.owner))).status).toBe(400);
  });
  it('requires owner and origin-bound invite-manage auth for create, status and deletion', async () => {
    const h = harness(), f = fixture(); await admit(h, f);
    for (const [path, method, body] of [['/invites', 'POST', f.create], ['/invites/' + f.id + '/status', 'GET'], ['/invites/' + f.id, 'DELETE']] as const) {
      expect((await h.fetch(req(path, method, body))).status).toBe(401);
      const request = req(path, method, body);
      request.headers.set('authorization', 'Bearer ' + createRelayAuthToken(f.owner, { action: 'receive', origin }));
      expect((await h.fetch(request)).status).toBe(401);
      request.headers.set('authorization', 'Bearer ' + createRelayAuthToken(f.owner, { action: 'invite-manage', origin: 'https://different.example' }));
      expect((await h.fetch(request)).status).toBe(401);
    }
    expect((await h.fetch(req('/invites/' + f.id + '/status', 'GET', undefined, generateKeyPair()))).status).toBe(404);
    expect((await h.fetch(req('/invites/' + f.id, 'DELETE', undefined, generateKeyPair()))).status).toBe(404);
  });
  it('enforces 20 unused links across concurrent creates and restarts, freeing claimed slots', async () => {
    const h = harness(), owner = generateKeyPair(), fixtures = Array.from({ length: 21 }, () => fixture(owner));
    const responses = await Promise.all(fixtures.map(f => h.fetch(req('/invites', 'POST', f.create, owner))));
    expect(responses.filter(r => r.status === 201)).toHaveLength(20);
    expect(responses[20].status).toBe(429); expect(responses[20].headers.get('retry-after')).toBeTruthy();
    h.restart();
    expect((await h.fetch(req('/invites', 'POST', fixtures[20].create, owner))).status).toBe(429);
    await h.fetch(req('/invites/claim', 'POST', fixtures[0].claim));
    await admit(h, fixtures[20]);
  });
  it('enforces 50 creates in a rolling day even after cancellation', async () => {
    vi.useFakeTimers(); const h = harness(), owner = generateKeyPair();
    for (let i = 0; i < 50; i++) {
      const f = fixture(owner); await admit(h, f);
      expect((await h.fetch(req('/invites/' + f.id, 'DELETE', undefined, owner))).ok).toBe(true);
    }
    h.restart(); const last = fixture(owner);
    expect((await h.fetch(req('/invites', 'POST', last.create, owner))).status).toBe(429);
    vi.advanceTimersByTime(86400000); await admit(h, fixture(owner));
  });
  it('rejects create auth replay and oversized TTL, and advertises only inviteLinks', async () => {
    const h = harness(), f = fixture(), request = req('/invites', 'POST', f.create, f.owner);
    expect((await h.fetch(request.clone())).status).toBe(201);
    expect((await h.fetch(request)).status).toBe(401);
    const tooLong = { ...f.create, expiresAt: new Date(Date.now() + 259210000).toISOString() };
    expect((await h.fetch(req('/invites', 'POST', tooLong, f.owner))).status).toBe(400);
    expect(await (await h.fetch(req('/capabilities'))).json()).toEqual({ inviteLinks: 1 });
    const local = createRelayFetchHandler();
    expect(await (await local(req('/capabilities'))).json()).toEqual({ inviteLinks: 1 });
  });
});

it('limits edge claim IPs to 10/minute and 10 failures/hour and uses RATE_LIMITER', async () => {
  vi.useFakeTimers(); const h = harness(), limiter = { limit: vi.fn(async () => ({ success: true })) };
  for (let i = 0; i < 10; i++) expect((await handleRelayEdge(req('/invites/claim', 'POST', {}), { INVITES: h.namespace, RATE_LIMITER: limiter })).status).toBe(404);
  expect(limiter.limit).toHaveBeenCalledTimes(10);
  expect((await handleRelayEdge(req('/invites/claim', 'POST', {}), { INVITES: h.namespace })).status).toBe(429);
  vi.advanceTimersByTime(60001);
  expect((await handleRelayEdge(req('/invites/claim', 'POST', {}), { INVITES: h.namespace })).status).toBe(429);
  vi.advanceTimersByTime(3600000);
  expect((await handleRelayEdge(req('/invites/claim', 'POST', {}), { INVITES: h.namespace })).status).toBe(404);
});

it('limits successful edge claims to 60/hour', async () => {
  vi.useFakeTimers(); const h = harness(), f = fixture(); await admit(h, f);
  for (let minute = 0; minute < 6; minute++) {
    // Use a fresh successful link each minute to stay inside the 120s retry window.
    const current = minute === 0 ? f : fixture(f.owner); if (minute) await admit(h, current);
    for (let i = 0; i < 10; i++) expect((await handleRelayEdge(req('/invites/claim', 'POST', current.claim), { INVITES: h.namespace })).status).toBe(200);
    vi.advanceTimersByTime(60001);
  }
  expect((await handleRelayEdge(req('/invites/claim', 'POST', f.claim), { INVITES: h.namespace })).status).toBe(429);
});

it('keeps claim IP limits across isolate resets and object restarts, with independent IPs', async () => {
  vi.useFakeTimers(); const h = harness();
  const attempt = (ip = '192.0.2.1') => handleRelayEdge(req('/invites/claim', 'POST', {}, undefined, ip), { INVITES: h.namespace });
  for (let i = 0; i < 10; i++) {
    expect((await attempt()).status).toBe(404);
    resetRelayRateLimits(); h.restart();
  }
  vi.advanceTimersByTime(60001);
  const refused = await attempt();
  expect(refused.status).toBe(429); expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
  expect((await attempt('192.0.2.2')).status).toBe(404);
  vi.advanceTimersByTime(3600000);
  const rateObject = [...h.objects.entries()].find(([name]) => name.startsWith('claim-ip:'))!;
  await rateObject[1].alarm();
  expect(h.alarms.has(rateObject[0])).toBe(false);
  expect((await attempt()).status).toBe(404);
});

it('serializes concurrent claim IP admissions and keeps internal routes off the public router', async () => {
  const h = harness();
  const responses = await Promise.all(Array.from({ length: 11 }, () => handleRelayEdge(req('/invites/claim', 'POST', {}), { INVITES: h.namespace })));
  expect(responses.filter(r => r.status === 404)).toHaveLength(10);
  expect(responses.filter(r => r.status === 429)).toHaveLength(1);
  for (const path of ['/invite-claims', '/invite-admissions']) expect((await h.fetch(req(path, 'POST', {}))).status).toBe(404);
});

it('caps same-nonce recovery at link expiry and preserves the status after alarm cleanup', async () => {
  vi.useFakeTimers(); const h = harness(), f = fixture(undefined, 300000); await admit(h, f);
  vi.advanceTimersByTime(299999);
  expect((await h.fetch(req('/invites/claim', 'POST', f.claim))).status).toBe(200);
  expect(h.alarms.get('invite:' + f.id)).toBe(Date.parse(f.encrypted.expiresAt));
  vi.advanceTimersByTime(1);
  await (h.namespace.get('invite:' + f.id) as InviteDurableObject).alarm();
  const response = await h.fetch(req('/invites/claim', 'POST', f.claim));
  expect(response.status).toBe(404); expect(await response.json()).toEqual(unavailable);
  expect(await (await h.fetch(req('/invites/' + f.id + '/status', 'GET', undefined, f.owner))).json()).toMatchObject({ status: 'claimed' });
});

it('rejects replayed deletion auth after more than fifty other deletions', async () => {
  const h = harness(), f = fixture(); await admit(h, f);
  const request = req('/invites/' + f.id, 'DELETE', undefined, f.owner);
  expect((await h.fetch(request.clone())).status).toBe(200);
  for (let i = 0; i < 51; i++) expect((await h.fetch(req('/invites/' + f.id, 'DELETE', undefined, f.owner))).status).toBe(200);
  h.restart(); expect((await h.fetch(request)).status).toBe(401);
});

it('bounds request streams and returns the same claimant refusal for invalid JSON or oversize bodies', async () => {
  const h = harness();
  for (const body of ['{', 'null', '[]', 'x'.repeat(24001)]) {
    const response = await h.fetch(new Request(origin + '/v1/invites/claim', { method: 'POST', body }));
    expect(response.status).toBe(404); expect(await response.json()).toEqual(unavailable);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  const f = fixture();
  expect((await h.fetch(req('/invites', 'POST', { ...f.create, ciphertext: 'x'.repeat(24001) }, f.owner))).status).toBe(400);
});

it('advertises only configured hosted invites and respects optional limiter refusals', async () => {
  const h = harness();
  expect(await (await handleRelayEdge(req('/capabilities'), { INVITES: h.namespace })).json()).toEqual({ inviteLinks: 1 });
  const relay = { idFromName: (n: string) => n, get: () => ({ fetch: async () => { throw new Error('unexpected inbox route'); } }) };
  expect(await (await handleRelayEdge(req('/capabilities'), { RELAY: relay })).json()).toEqual({});
  expect((await handleRelayEdge(req('/invites/claim', 'POST', {}), { RELAY: relay })).status).toBe(503);
  const response = await handleRelayEdge(req('/invites/claim', 'POST', {}), { INVITES: h.namespace,
    RATE_LIMITER: { limit: async () => ({ success: false }) } });
  expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('60');
  expect((await handleRelayEdge(req('/invites/claim', 'POST', {}), { INVITES: h.namespace,
    RATE_LIMITER: { limit: async () => { throw new Error('limiter unavailable'); } } })).status).toBe(503);
});
