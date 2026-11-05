// SPDX-License-Identifier: Apache-2.0
import { createHash, timingSafeEqual } from 'node:crypto';
import { verifyRelayAuthToken, unpackInviteLinkCiphertext, INVITE_LINK_MAX_TTL_MS } from '@acp/core/edge';
import type { InviteLinkStorage } from '@acp/core/edge';

export interface InviteStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm?(at: number | Date): Promise<void>;
  deleteAlarm?(): Promise<void>;
}
export interface InviteNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
interface RecordState {
  ownerDid: string; id: string; expiresAt: string; status: 'unused' | 'claimed' | 'expired' | 'cancelled' | 'locked_out';
  tagHash?: string; encrypted?: InviteLinkStorage; wrongTags: number;
  claimedAt?: string; retryUntil?: number; claimNonceHash?: string;
}
interface OwnerState { creates: number[]; links: { id: string; expiresAt: string }[]; nonces: { hash: string; until: number }[] }
interface ClaimRateState { claims: number[]; failures: number[] }
const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-type': 'application/json' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
export const inviteUnavailable = () => json({ error: 'INVITE_LINK_UNAVAILABLE' }, 404);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function bytes(value: unknown, length: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(length * 4 / 3)) throw new Error('INVALID_INVITE_LINK_REQUEST');
  const result = Buffer.from(value, 'base64url');
  if (result.length !== length || result.toString('base64url') !== value) throw new Error('INVALID_INVITE_LINK_REQUEST');
  return result;
}
export function inviteOwner(request: Request): { did: string; nonce: string; until: number } {
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  let did: string, timestamp: string;
  try {
    if (token.length > 16384) throw new Error();
    const p = JSON.parse(Buffer.from(token, 'base64url').toString()).payload;
    did = p.recipientDid; timestamp = p.timestamp;
  } catch { throw new Error('RELAY_UNAUTHORIZED'); }
  const result = verifyRelayAuthToken(token, did, { expectedOrigin: new URL(request.url).origin, requireOrigin: true });
  if (!result.valid || result.action !== 'invite-manage') throw new Error('RELAY_UNAUTHORIZED');
  return { did, nonce: result.nonce!, until: Date.parse(timestamp) + 300001 };
}
export async function inviteBody(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length')) > 24000) throw new Error('INVALID_INVITE_LINK_REQUEST');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('INVALID_INVITE_LINK_REQUEST');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 24000) { await reader.cancel(); throw new Error('INVALID_INVITE_LINK_REQUEST'); }
      chunks.push(value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString());
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new Error('INVALID_INVITE_LINK_REQUEST'); }
  finally { reader.releaseLock(); }
}
function ciphertextBody(body: Record<string, unknown>): InviteLinkStorage {
  if (Object.keys(body).length !== 5) throw new Error('INVALID_INVITE_LINK_REQUEST');
  const { tagHash, ...encrypted } = body;
  bytes(tagHash, 32); unpackInviteLinkCiphertext(encrypted);
  const expires = Date.parse(encrypted.expiresAt as string), now = Date.now();
  if (expires <= now || expires - now > INVITE_LINK_MAX_TTL_MS) throw new Error('INVALID_INVITE_LINK_EXPIRY');
  return encrypted as unknown as InviteLinkStorage;
}
function childRequest(request: Request, path: string, method: string, body?: unknown): Request {
  const url = new URL(request.url); url.pathname = path;
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.delete('content-length');
  return new Request(url, { method, headers: forwardedHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
/** One serialized instance per invite id, owner DID, or hashed claimant IP. */
export class InviteDurableObject {
  private turn: Promise<unknown> = Promise.resolve();
  constructor(private state: { storage: InviteStorage }, private env: { INVITES?: InviteNamespace } = {}) {}
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.turn.then(work);
    // Keep only completion in the queue, never a response containing ciphertext.
    this.turn = next.then(() => undefined, () => undefined);
    return next;
  }
  async alarm(): Promise<void> { await this.enqueue(async () => {
    await this.cleanup();
    const rate = await this.state.storage.get<ClaimRateState>('claim-rate');
    if (rate) await this.saveClaimRate(rate);
  }); }
  private async saveClaimRate(rate: ClaimRateState): Promise<void> {
    const now = Date.now();
    rate.claims = rate.claims.filter(t => t > now - 3600000);
    rate.failures = rate.failures.filter(t => t > now - 3600000);
    await this.state.storage.put('claim-rate', rate);
    const oldest = Math.min(...rate.claims, ...rate.failures);
    if (Number.isFinite(oldest)) await this.state.storage.setAlarm?.(oldest + 3600000);
    else await this.state.storage.deleteAlarm?.();
  }
  private async limitedClaim(request: Request): Promise<Response> {
    const now = Date.now();
    const rate = await this.state.storage.get<ClaimRateState>('claim-rate') ?? { claims: [], failures: [] };
    const windows = [
      { times: rate.claims, limit: 10, ms: 60000 },
      { times: rate.claims, limit: 60, ms: 3600000 },
      { times: rate.failures, limit: 10, ms: 3600000 },
    ];
    let retry = 0;
    for (const { times, limit, ms } of windows) {
      const fresh = times.filter(t => t > now - ms);
      if (fresh.length >= limit) retry = Math.max(retry, Math.ceil((fresh[0] + ms - now) / 1000));
    }
    if (retry) return Response.json({ error: 'RATE_LIMITED' }, { status: 429, headers: { ...headers, 'retry-after': String(retry) } });
    // Reserve before forwarding. An interrupted response still counts as an attempt.
    rate.claims.push(now);
    await this.saveClaimRate(rate);
    const url = new URL(request.url); url.pathname = '/v1/invites/claim';
    const response = await routeInvite(new Request(url, request), this.env.INVITES!);
    if (response.status === 404) {
      rate.failures.push(now);
      await this.saveClaimRate(rate);
    }
    return response;
  }
  private async cleanup(): Promise<RecordState | undefined> {
    const r = await this.state.storage.get<RecordState>('invite');
    if (!r) return;
    const now = Date.now(); let changed = false;
    if (r.status === 'unused' && Date.parse(r.expiresAt) <= now) { r.status = 'expired'; changed = true; }
    if (r.status !== 'unused' && (r.status !== 'claimed' || now >= r.retryUntil! || now >= Date.parse(r.expiresAt))) {
      changed ||= r.encrypted !== undefined;
      delete r.encrypted; delete r.tagHash; delete r.claimNonceHash; delete r.retryUntil;
    }
    if (changed) await this.state.storage.put('invite', r);
    if (r.encrypted) await this.state.storage.setAlarm?.(r.status === 'claimed' ? Math.min(r.retryUntil!, Date.parse(r.expiresAt)) : Date.parse(r.expiresAt));
    else await this.state.storage.deleteAlarm?.();
    return r;
  }
  fetch(request: Request): Promise<Response> { return this.enqueue(() => this.handle(request)); }
  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.replace(/^\/v1/, '');
    const claim = request.method === 'POST' && path === '/invites/claim';
    try {
      // Only the edge/local router can reach this internal coordinator route.
      if (request.method === 'POST' && path === '/invite-claims') return await this.limitedClaim(request);
      if (claim) {
        const body = await inviteBody(request);
        bytes(body.id, 16); const tag = bytes(body.tag, 32); bytes(body.claimNonce, 32);
        if (Object.keys(body).length !== 3) return inviteUnavailable();
        const r = await this.cleanup();
        if (!r || r.id !== body.id || !r.encrypted || Date.parse(r.expiresAt) <= Date.now() || !r.tagHash) return inviteUnavailable();
        const valid = timingSafeEqual(createHash('sha256').update(tag).digest(), bytes(r.tagHash, 32));
        if (!valid) {
          if (r.status === 'unused') {
            r.wrongTags++;
            if (r.wrongTags >= 3) { r.status = 'locked_out'; delete r.encrypted; delete r.tagHash; }
            await this.state.storage.put('invite', r); await this.cleanup();
          }
          return inviteUnavailable();
        }
        const nonceHash = hash(body.claimNonce as string);
        if (r.status === 'claimed') return r.claimNonceHash === nonceHash && Date.now() < r.retryUntil! ? json(r.encrypted) : inviteUnavailable();
        if (r.status !== 'unused') return inviteUnavailable();
        r.status = 'claimed'; r.claimedAt = new Date().toISOString(); r.retryUntil = Date.now() + 120000; r.claimNonceHash = nonceHash;
        await this.state.storage.put('invite', r); await this.cleanup();
        return json(r.encrypted);
      }
      const auth = inviteOwner(request);
      if (request.method === 'POST' && path === '/invites') {
        const body = await inviteBody(request), encrypted = ciphertextBody(body);
        const existing = await this.state.storage.get<RecordState>('invite');
        if (existing) return json({ error: 'INVITE_LINK_EXISTS' }, 409);
        await this.state.storage.put('invite', { ownerDid: auth.did, id: encrypted.id, expiresAt: encrypted.expiresAt,
          status: 'unused', tagHash: body.tagHash as string, encrypted, wrongTags: 0 } satisfies RecordState);
        await this.cleanup(); return json({ id: encrypted.id, expiresAt: encrypted.expiresAt }, 201);
      }
      if (request.method === 'POST' && path === '/invite-admissions') {
        const body = await inviteBody(request), encrypted = ciphertextBody(body);
        const owner = await this.state.storage.get<OwnerState>('owner') ?? { creates: [], links: [], nonces: [] };
        const now = Date.now(); owner.creates = owner.creates.filter(t => t > now - 86400000);
        owner.nonces = owner.nonces.filter(n => n.until >= now);
        if (owner.nonces.some(n => n.hash === hash(auth.nonce))) throw new Error('RELAY_UNAUTHORIZED');
        owner.nonces.push({ hash: hash(auth.nonce), until: auth.until });
        // Durable reservation precedes child writes. Failed/uncertain writes consume a create slot.
        const unused = [];
        for (const link of owner.links.filter(l => Date.parse(l.expiresAt) > now)) {
          const res = await this.env.INVITES!.get(this.env.INVITES!.idFromName('invite:' + link.id)).fetch(childRequest(request, '/v1/invites/' + link.id + '/status', 'GET'));
          if (!res.ok || (await res.json() as { status: string }).status === 'unused') unused.push(link);
        }
        owner.links = unused;
        if (owner.creates.length >= 50 || unused.length >= 20) return Response.json({ error: 'RATE_LIMITED' }, { status: 429, headers: { ...headers, 'retry-after': '86400' } });
        owner.creates.push(now); owner.links.push({ id: encrypted.id, expiresAt: encrypted.expiresAt });
        await this.state.storage.put('owner', owner);
        return this.env.INVITES!.get(this.env.INVITES!.idFromName('invite:' + encrypted.id)).fetch(childRequest(request, '/v1/invites', 'POST', body));
      }
      const match = /^\/invites\/([A-Za-z0-9_-]{22})(\/status)?$/.exec(path);
      if (!match) return json({ error: 'NOT_FOUND' }, 404);
      const r = await this.cleanup();
      if (!r || r.id !== match[1] || r.ownerDid !== auth.did) return inviteUnavailable();
      if (request.method === 'GET' && match[2]) return json({ id: r.id, status: r.status, expiresAt: r.expiresAt, ...(r.claimedAt ? { claimedAt: r.claimedAt } : {}) });
      if (request.method === 'DELETE' && !match[2]) {
        const used = (await this.state.storage.get<OwnerState['nonces']>('cancel-nonces') ?? []).filter(n => n.until >= Date.now());
        if (used.some(n => n.hash === hash(auth.nonce))) throw new Error('RELAY_UNAUTHORIZED');
        await this.state.storage.put('cancel-nonces', [...used, { hash: hash(auth.nonce), until: auth.until }]);
        r.status = 'cancelled'; delete r.encrypted; delete r.tagHash; delete r.claimNonceHash; delete r.retryUntil;
        await this.state.storage.put('invite', r); await this.cleanup(); return json({ cancelled: true });
      }
      return json({ error: 'NOT_FOUND' }, 404);
    } catch (error) {
      if (claim) return inviteUnavailable();
      const unauthorized = error instanceof Error && error.message === 'RELAY_UNAUTHORIZED';
      return json({ error: unauthorized ? 'RELAY_UNAUTHORIZED' : 'INVALID_INVITE_LINK_REQUEST' }, unauthorized ? 401 : 400);
    }
  }
}

/** Coordinates the exact rolling IP limits across edge isolates and object restarts. */
export function routeInviteClaim(request: Request, namespace: InviteNamespace, ip: string): Promise<Response> {
  const url = new URL(request.url); url.pathname = '/v1/invite-claims';
  return namespace.get(namespace.idFromName('claim-ip:' + hash(ip))).fetch(new Request(url, request));
}

/** Shared router for edge and local relay. Names never contain K, tag or token. */
export async function routeInvite(request: Request, namespace: InviteNamespace): Promise<Response> {
  const url = new URL(request.url), path = url.pathname.replace(/^\/v1/, '');
  if (request.method === 'GET' && path === '/capabilities') return json({ inviteLinks: 1 });
  try {
    if (request.method === 'POST' && path === '/invites') {
      const owner = inviteOwner(request); const body = await inviteBody(request); ciphertextBody(body);
      return namespace.get(namespace.idFromName('owner:' + owner.did)).fetch(childRequest(request, '/v1/invite-admissions', 'POST', body));
    }
    if (request.method === 'POST' && path === '/invites/claim') {
      const body = await inviteBody(request); bytes(body.id, 16);
      return namespace.get(namespace.idFromName('invite:' + body.id)).fetch(childRequest(request, '/v1/invites/claim', 'POST', body));
    }
    const match = /^\/invites\/([A-Za-z0-9_-]{22})(?:\/status)?$/.exec(path);
    if (match) { inviteOwner(request); bytes(match[1], 16); return namespace.get(namespace.idFromName('invite:' + match[1])).fetch(request); }
    return request.method === 'POST' && path === '/invites/claim' ? inviteUnavailable() : json({ error: 'NOT_FOUND' }, 404);
  } catch (error) {
    if (path === '/invites/claim') return inviteUnavailable();
    return json({ error: error instanceof Error && error.message === 'RELAY_UNAUTHORIZED' ? 'RELAY_UNAUTHORIZED' : 'INVALID_INVITE_LINK_REQUEST' }, error instanceof Error && error.message === 'RELAY_UNAUTHORIZED' ? 401 : 400);
  }
}
export function createMemoryInviteHandler(): (request: Request) => Promise<Response> {
  const objects = new Map<string, InviteDurableObject>();
  const namespace: InviteNamespace = {
    idFromName: name => name,
    get(id) {
      const name = String(id); let object = objects.get(name);
      if (!object) {
        const values = new Map<string, unknown>();
        let alarm: ReturnType<typeof setTimeout> | undefined;
        object = new InviteDurableObject({ storage: { get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
          put: async (key, value) => { values.set(key, structuredClone(value)); },
          setAlarm: async at => {
            clearTimeout(alarm);
            alarm = setTimeout(() => { void object!.alarm().catch(() => {}); }, Math.max(1, Number(at) - Date.now()));
            alarm.unref();
          },
          deleteAlarm: async () => { clearTimeout(alarm); alarm = undefined; },
        } }, { INVITES: namespace }); objects.set(name, object);
      }
      return object;
    },
  };
  return request => request.method === 'POST' && new URL(request.url).pathname === '/v1/invites/claim'
    ? routeInviteClaim(request, namespace, request.headers.get('cf-connecting-ip') ?? 'local')
    : routeInvite(request, namespace);
}
