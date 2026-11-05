// SPDX-License-Identifier: Apache-2.0
import { routeInvite, routeInviteClaim } from './invites.js';
import type { InviteNamespace } from './invites.js';
export { InviteDurableObject } from './invites.js';
import { resolveDid, generateKeyPair } from '@acp/core/edge';
import type { SignedEnvelope, KeyPair } from '@acp/core/edge';
import {
  beginDurableLongPoll,
  canonicalRelayPath,
  createRelayFetchHandler,
  DEFAULT_MAX_ENVELOPE_BYTES,
  inboxRecipientFromRequest,
  InMemoryRelay,
  relayErrorResponse,
  relayHttpHeaders,
  relayLimitsFromEnv,
} from './fetch.js';
import { relayWakeFromEnv } from './notifications.js';
import type { RelayWakeOptions } from './notifications.js';
import type { DurableLongPoll, RelaySnapshot } from './fetch.js';
import {
  emptyCursor,
  emptyRelaySnapshot,
  loadRelayState,
  planJournal,
} from './journal.js';
import type { RelayMeta, JournalCursor, JournalPlan } from './journal.js';

interface DurableStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete?(key: string): Promise<unknown>;
  setAlarm?(scheduledTime: number | Date): Promise<void>;
  deleteAlarm?(): Promise<void>;
}
interface DurableState {
  storage: DurableStorage;
  waitUntil?(promise: Promise<unknown>): void;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
/**
 * One inbox or the registry. Storage is granular: a POST writes the new
 * envelope, its seen-id slot, and the fixed-size meta record. Write cost does
 * not grow with the number of queued envelopes or registered agents.
 */
export class RelayDurableObject {
  private relay: InMemoryRelay;
  private handler: (request: Request) => Promise<Response>;
  private ready: Promise<void>;
  /** Serializes handler mutation, snapshot write, and rollback for every request. */
  private turn: Promise<unknown> = Promise.resolve();
  private persistedVersion = 0;
  private notifications?: Promise<void>;
  private notificationKey!: KeyPair;
  private configuredNotificationKey?: KeyPair;
  private committedSnapshot: RelaySnapshot;
  private cursor: JournalCursor;
  constructor(
    private state: DurableState,
    env?: Record<string, unknown>,
  ) {
    this.configuredNotificationKey = typeof env?.ACP_NOTIFICATION_KEY === 'string'
      ? JSON.parse(env.ACP_NOTIFICATION_KEY) as KeyPair : undefined;
    this.relay = new InMemoryRelay({ ...relayLimitsFromEnv(env),
      // Channels are supplied by the embedding operator, never by an HTTP request.
      wake: (env?.ACP_WAKE as RelayWakeOptions | undefined) ?? relayWakeFromEnv(env),
    });
    this.handler = createRelayFetchHandler({ relay: this.relay, deferNotifications: true });
    this.cursor = emptyCursor(this.relay.maxSeenEntries, this.relay.maxAuthSeenEntries);
    this.committedSnapshot = emptyRelaySnapshot();
    this.ready = state.blockConcurrencyWhile(() => this.bootstrap());
  }
  private async bootstrap(): Promise<void> {
    const meta = await this.state.storage.get<RelayMeta>('meta');
    const key = this.configuredNotificationKey ?? meta?.notificationKey ?? generateKeyPair();
    this.notificationKey = key;
    this.relay.setNotificationKey(key);
    const loaded = await loadRelayState(this.state.storage, Date.now(), {
      seenMod: this.relay.maxSeenEntries,
      authMod: this.relay.maxAuthSeenEntries,
    });
    this.cursor = loaded.cursor;
    if (loaded.snapshot) this.relay.restore(loaded.snapshot);
    this.committedSnapshot = loaded.snapshot ?? emptyRelaySnapshot();
    this.persistedVersion = -1;
    if (loaded.legacy) await this.migrateLegacy(loaded.legacy);
    await this.writeSnapshot();
  }
  /** Rewrite a pre-sharding blob into per-key records once, then drop the blob. */
  private async migrateLegacy(legacy: { generation: string; count: number }): Promise<void> {
    const next = this.relay.snapshot();
    const plan = planJournal(
      emptyCursor(this.relay.maxSeenEntries, this.relay.maxAuthSeenEntries),
      emptyRelaySnapshot(),
      next,
    );
    await this.commitPlan(plan, next, this.relay.mutationVersion);
    if (!this.state.storage.delete) return;
    await this.state.storage.delete('relay-head');
    for (let i = 0; i < legacy.count; i++)
      await this.state.storage.delete('relay:' + legacy.generation + ':' + i);
  }
  /** Queue one turn. A rejection stays on that turn and does not poison the next one. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.turn.catch(() => undefined).then(work);
    this.turn = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  /**
   * Persist the current relay. Caller must already hold the request turn.
   * A single POST /envelopes or DELETE /envelopes/:id commits a constant
   * number of keys (the touched envelope, its replay slot, and `meta`).
   * The fixed-size `meta` record is independent of inbox and registry length.
   */
  private async writeSnapshot(): Promise<void> {
    this.relay.evictExpired();
    if (this.persistedVersion === this.relay.mutationVersion) {
      await this.bestEffortAlarm();
      return;
    }
    const next = this.relay.snapshot();
    const version = this.relay.mutationVersion;
    const plan = planJournal(this.cursor, this.committedSnapshot, next);
    if (plan.puts.length === 0 && plan.deletes.length === 0) {
      this.cursor = plan.cursor;
      this.persistedVersion = version;
      this.committedSnapshot = next;
      await this.bestEffortAlarm();
      return;
    }
    const rollback = this.committedSnapshot;
    let committed = false;
    try {
      // Item keys first, then meta. A crash before meta leaves unreachable
      // orphans; the previous meta still describes the last committed inbox.
      for (const put of plan.puts) await this.state.storage.put(put.key, put.value);
      await this.state.storage.put('meta', { ...plan.meta, notificationKey: this.notificationKey });
      this.cursor = plan.cursor;
      this.persistedVersion = version;
      this.committedSnapshot = next;
      committed = true;
      if (this.state.storage.delete)
        for (const key of plan.deletes) await this.state.storage.delete(key);
    } catch (error) {
      // A failed put must not leave memory ahead of the last durable meta record.
      if (!committed && this.relay.mutationVersion === version) this.relay.restore(rollback);
      throw error;
    }
    await this.bestEffortAlarm();
  }
  private async commitPlan(plan: JournalPlan, next: RelaySnapshot, version: number): Promise<void> {
    for (const put of plan.puts) await this.state.storage.put(put.key, put.value);
    await this.state.storage.put('meta', { ...plan.meta, notificationKey: this.notificationKey });
    this.cursor = plan.cursor;
    this.persistedVersion = version;
    this.committedSnapshot = next;
    if (!this.state.storage.delete) return;
    for (const key of plan.deletes) await this.state.storage.delete(key);
  }
  private async bestEffortAlarm(): Promise<void> {
    const setAlarm = this.state.storage.setAlarm;
    if (!setAlarm) return;
    try {
      const next = this.relay.nextExpiry();
      if (next === undefined) {
        await this.state.storage.deleteAlarm?.();
        return;
      }
      await setAlarm(next);
    } catch {
      /* A committed mutation must not fail because the alarm could not be set. */
    }
  }
  /** Later SSE pulls persist after the request turn has released this lock. */
  private persist(): Promise<void> {
    return this.enqueue(() => this.writeSnapshot());
  }
  /** Claims and completions are serialized; external notification delivery never holds the inbox turn. */
  private runNotifications(): Promise<void> {
    if (this.notifications) return this.notifications;
    this.notifications = (async () => {
      for (;;) {
        const attempt = await this.enqueue(async () => {
          this.relay.evictExpired();
          const next = this.relay.claimWakeNotification();
          await this.writeSnapshot();
          return next;
        });
        if (!attempt) return;
        const delivered = await this.relay.deliverWakeNotification(attempt);
        await this.enqueue(async () => {
          this.relay.completeWakeNotification(attempt, delivered);
          await this.writeSnapshot();
        });
      }
    })().finally(() => { this.notifications = undefined; });
    return this.notifications;
  }
  private scheduleNotifications(): void {
    const work = this.runNotifications();
    this.state.waitUntil?.(work);
    // A failed storage turn is retried on the next request/alarm, without failing an admitted POST.
    void work.catch(() => {});
  }
  async alarm(): Promise<void> {
    await this.ready;
    await this.enqueue(() => this.writeSnapshot());
    await this.runNotifications();
  }
  async fetch(request: Request): Promise<Response> {
    await this.ready;
    if (this.longPollWait(request) !== undefined) return this.handleLongPoll(request);
    return this.enqueue(() => this.handle(request));
  }
  /** Positive waitMs on GET /envelopes. Invalid values stay on the normal handler path. */
  private longPollWait(request: Request): number | undefined {
    if (request.method !== 'GET') return undefined;
    const url = new URL(request.url);
    const path = canonicalRelayPath(url.pathname);
    if (
      (path !== '/envelopes' && !path.startsWith('/inbox/')) ||
      !url.searchParams.has('waitMs')
    )
      return undefined;
    const ms = Number(url.searchParams.get('waitMs'));
    if (!Number.isFinite(ms) || ms <= 0) return undefined;
    return ms;
  }
  private emptyPoll(): Response {
    return Response.json({ envelopes: [] }, { headers: relayHttpHeaders('json') });
  }
  /**
   * Authenticate and pop inside the mutation turn, then release that turn while
   * relay.wait is pending so a POST can wake the poll.
   */
  private async handleLongPoll(request: Request): Promise<Response> {
    const opened = await this.enqueue(() => this.openLongPoll(request));
    if (opened.mode === 'response') return opened.response;
    await this.relay.wait(opened.recipient, opened.waitMs, request.signal, opened.filter);
    // send() wakes wait before the POST snapshot finishes. A disconnect in that gap must not dequeue.
    if (request.signal.aborted) return this.emptyPoll();
    return this.enqueue(() => this.finishLongPoll(opened.receive, request.signal));
  }
  private async openLongPoll(request: Request): Promise<DurableLongPoll> {
    const started = beginDurableLongPoll(this.relay, request);
    if (started.mode === 'response') {
      if (started.response.ok) await this.writeSnapshot();
      return started;
    }
    await this.writeSnapshot();
    return started;
  }
  private async finishLongPoll(
    receive: () => SignedEnvelope | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    // Abort can land while this turn waits behind the POST storage.put.
    if (signal.aborted) return this.emptyPoll();
    const envelopes: SignedEnvelope[] = [];
    try {
      let envelope: SignedEnvelope | undefined;
      while ((envelope = receive())) envelopes.push(envelope);
    } catch (error) {
      return relayErrorResponse(error, this.relay);
    }
    await this.writeSnapshot();
    return Response.json({ envelopes }, { headers: relayHttpHeaders('json') });
  }
  private async handle(request: Request): Promise<Response> {
    const response = await this.handler(request);
    const path = canonicalRelayPath(new URL(request.url).pathname);
    if (!response.ok) return response;
    if (request.method === 'GET' && path === '/stream' && response.body) {
      await this.writeSnapshot();
      const reader = response.body.getReader();
      const persist = () => this.persist();
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { value, done } = await reader.read();
            if (done) controller.close();
            else {
              await persist();
              controller.enqueue(value);
            }
          },
          async cancel() {
            await reader.cancel();
          },
        }),
        { status: response.status, headers: response.headers },
      );
    }
    if (
      (request.method === 'POST' && ['/agents', '/envelopes'].includes(path)) ||
      (request.method === 'DELETE' &&
        (path === '/envelopes' || path.startsWith('/envelopes/'))) ||
      (request.method === 'GET' && (path === '/envelopes' || path.startsWith('/inbox/'))) ||
      this.persistedVersion !== this.relay.mutationVersion
    )
      await this.writeSnapshot();
    this.scheduleNotifications();
    return response;
  }
}

export const DEFAULT_RATE_LIMIT_MAX = 300;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

interface RelayNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
export interface RelayEdgeEnv {
  RELAY?: RelayNamespace;
  INVITES?: InviteNamespace;
  RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  [key: string]: unknown;
}

const buckets = new Map<string, number[]>();

/** Test hook. Production isolates keep this map for the life of the isolate. */
export function resetRelayRateLimits(): void {
  buckets.clear();
}

function envString(env: RelayEdgeEnv | undefined, key: string): string | undefined {
  const value = env?.[key];
  return typeof value === 'string' ? value : undefined;
}
function envInt(env: RelayEdgeEnv | undefined, key: string, fallback: number): number {
  const value = envString(env, key);
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

/** CF-Connecting-IP wins. X-Forwarded-For is only a fallback for local tests. */
export function clientIp(request: Request): string {
  const cf = request.headers.get('cf-connecting-ip')?.trim();
  if (cf) return cf;
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}

function rateBucket(method: string, path: string): string | undefined {
  if (path === '/wake' || path === '/delivery-status') return 'notifications';
  if (method === 'POST' && path === '/envelopes') return 'post-envelope';
  if (method === 'GET' && (path === '/envelopes' || path.startsWith('/inbox/')))
    return 'get-envelope';
  if (method === 'POST' && path === '/agents') return 'post-agent';
  return undefined;
}

function slidingWindow(
  key: string,
  max: number,
  windowMs: number,
  now: number,
): { allowed: boolean; retryAfterSeconds: number } {
  const fresh = (buckets.get(key) ?? []).filter((stamp) => now - stamp < windowMs);
  if (fresh.length >= max) {
    buckets.set(key, fresh);
    const retryAfterSeconds = Math.max(1, Math.ceil((fresh[0]! + windowMs - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }
  fresh.push(now);
  buckets.set(key, fresh);
  if (buckets.size > 20000) {
    const oldest = buckets.keys().next().value;
    if (oldest !== undefined) buckets.delete(oldest);
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

function tooMany(retryAfterSeconds: number): Response {
  return Response.json(
    { error: 'RATE_LIMITED' },
    {
      status: 429,
      headers: { ...relayHttpHeaders('json'), 'retry-after': String(retryAfterSeconds) },
    },
  );
}

async function applyRateLimit(
  request: Request,
  env: RelayEdgeEnv | undefined,
  bucket: string,
): Promise<Response | undefined> {
  const ip = clientIp(request);
  const decision = slidingWindow(
    bucket + '\n' + ip,
    envInt(env, 'ACP_RATE_LIMIT_MAX', DEFAULT_RATE_LIMIT_MAX),
    envInt(env, 'ACP_RATE_LIMIT_WINDOW_MS', DEFAULT_RATE_LIMIT_WINDOW_MS),
    Date.now(),
  );
  if (!decision.allowed) return tooMany(decision.retryAfterSeconds);
  const limiter = env?.RATE_LIMITER;
  if (!limiter) return undefined;
  try {
    const result = await limiter.limit({ key: ip + ':' + bucket });
    if (!result.success) return tooMany(60);
  } catch {
    return Response.json(
      { error: 'RATE_LIMITER_UNAVAILABLE' },
      { status: 503, headers: relayHttpHeaders('json') },
    );
  }
  return undefined;
}

function recipientOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const payload = (value as { payload?: unknown }).payload;
  if (!payload || typeof payload !== 'object') return undefined;
  const did = (payload as { recipientDid?: unknown }).recipientDid;
  return typeof did === 'string' ? did : undefined;
}

async function readBody(request: Request, limit: number): Promise<string> {
  if (Number(request.headers.get('content-length')) > limit) throw new Error('BODY_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('MISSING_BODY');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error('BODY_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function forward(request: Request, body?: string): Request {
  const url = new URL(request.url);
  url.pathname = canonicalRelayPath(url.pathname);
  if (body === undefined) return new Request(url, request);
  return new Request(url, { method: request.method, headers: request.headers, body });
}

function inboxRoutes(method: string, path: string): boolean {
  if (path === '/wake' || path === '/delivery-status') return true;
  if (method === 'POST' && path === '/envelopes') return true;
  if (
    method === 'GET' &&
    (path === '/envelopes' || path === '/stream' || path.startsWith('/inbox/'))
  )
    return true;
  return method === 'DELETE' && (path === '/envelopes' || path.startsWith('/envelopes/'));
}

const localHandler = createRelayFetchHandler();

export async function handleRelayEdge(
  request: Request,
  env?: RelayEdgeEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const path = canonicalRelayPath(url.pathname);
  if (request.method === 'GET' && path === '/health')
    return Response.json({ status: 'ok' }, { headers: relayHttpHeaders('json') });
  if (request.method === 'GET' && url.pathname === '/v1/capabilities')
    return Response.json(env?.RELAY && !env.INVITES ? {} : { inviteLinks: 1 }, { headers: relayHttpHeaders('json') });
  if (url.pathname.startsWith('/v1/invites')) {
    const claim = request.method === 'POST' && url.pathname === '/v1/invites/claim';
    if (claim && env?.RATE_LIMITER) {
      try { if (!(await env.RATE_LIMITER.limit({ key: clientIp(request) + ':invite-claim' })).success) return tooMany(60); }
      catch { return Response.json({ error: 'RATE_LIMITER_UNAVAILABLE' }, { status: 503, headers: relayHttpHeaders('json') }); }
    }
    if (env?.RELAY && !env.INVITES) return Response.json({ error: 'INVITE_LINK_UNAVAILABLE' }, { status: 503, headers: relayHttpHeaders('json') });
    return env?.INVITES
      ? claim ? routeInviteClaim(request, env.INVITES, clientIp(request)) : routeInvite(request, env.INVITES)
      : localHandler(request);
  }
  const bucket = rateBucket(request.method, path);
  if (bucket) {
    const limited = await applyRateLimit(request, env, bucket);
    if (limited) return limited;
  }
  if (!env?.RELAY) return localHandler(request);
  try {
    if (!inboxRoutes(request.method, path))
      return env.RELAY.get(env.RELAY.idFromName('registry')).fetch(forward(request));
    let body: string | undefined;
    let recipient = '';
    if (request.method === 'POST' && path === '/envelopes') {
      body = await readBody(
        request,
        envInt(env, 'ACP_MAX_ENVELOPE_BYTES', DEFAULT_MAX_ENVELOPE_BYTES),
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error('INVALID_REQUEST');
      }
      recipient = recipientOf(parsed) ?? '';
    } else recipient = inboxRecipientFromRequest(path, url) ?? url.searchParams.get('recipient') ?? '';
    // Validate before idFromName so a missing or forged DID cannot mint an object.
    resolveDid(recipient);
    return env.RELAY.get(env.RELAY.idFromName('inbox:' + recipient)).fetch(forward(request, body));
  } catch (error) {
    return relayErrorResponse(error);
  }
}

export default {
  fetch(request: Request, env?: RelayEdgeEnv): Promise<Response> {
    return handleRelayEdge(request, env);
  },
};
