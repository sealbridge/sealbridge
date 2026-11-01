// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  verifyEnvelope,
  verifySigned,
  resolveDid,
  createRelayAuthToken,
  normalizeRelayOrigin,
  validateRelayEndpointUrl,
} from '@acp/core';
import type { SignedEnvelope, KeyPair, RelayAuthAction } from '@acp/core';
import {
  classifyEnvelopeRole,
  DEFAULT_MAX_ENVELOPE_BYTES,
  InMemoryRelay,
  createRelayFetchHandler,
  mapRelayError,
  normalizeReceiveFilter,
  relayHttpHeaders,
  sanitizeRelayErrorCode,
} from './fetch.js';
import type { InMemoryRelayOptions, RelayAuthContext, RelayInboxRole, RelayReceiveFilter } from './fetch.js';
import type { SignedRelayDeliveryStatus } from './notifications.js';
import { createPinnedRelayFetch, resolveAndValidateRelayEndpoint } from './ssrf.js';
import type { RelayClientSecurityOptions } from './ssrf.js';
export * from './fetch.js';
export * from './retry.js';
import { isTransientRelayError, relayRetryDelay, waitForRelayRetry, relayDeadline, relayDiagnostic,
  RelayHttpError, RelayAuthRecoveryExhaustedError, validateRelayAuthRecoveryOptions } from './retry.js';
import type { RelayConnectionStatus, RelayAuthOperation } from './retry.js';
export { createPinnedRelayFetch, resolveAndValidateRelayEndpoint } from './ssrf.js';
export type {
  RelayClientSecurityOptions,
  RelayLookup,
  ResolvedAddress,
  ResolvedRelayEndpoint,
} from './ssrf.js';
export {
  createSignedAgentCard,
  verifySignedAgentCard,
  findDiscoveredAgentCard,
  toA2AAgentCard,
  createInviteToken,
  parseAndVerifyInviteToken,
} from '@acp/core';
export async function startLocalRelay(
  options: {
    relayOptions?: InMemoryRelayOptions;
    port?: number;
    host?: string;
    tamper?: (e: SignedEnvelope) => SignedEnvelope;
    allowQueryAuth?: boolean;
    allowUnboundRelayAuth?: boolean;
  } = {},
) {
  const relay = new InMemoryRelay({
    ...options.relayOptions,
    tamper: options.tamper,
    allowUnboundRelayAuth: options.allowUnboundRelayAuth,
  });
  const handler = createRelayFetchHandler({
    relay,
    allowQueryAuth: options.allowQueryAuth,
    allowUnboundRelayAuth: options.allowUnboundRelayAuth,
  });
  let boundOrigin = 'http://127.0.0.1';
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    response.once('close', () => controller.abort());
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > DEFAULT_MAX_ENVELOPE_BYTES) throw new Error('BODY_TOO_LARGE');
        chunks.push(chunk as Buffer);
      }
      const result = await handler(
        new Request(new URL(request.url ?? '/', boundOrigin), {
          method: request.method,
          headers: Object.entries(request.headers).flatMap(([name, value]) =>
            value === undefined
              ? []
              : (Array.isArray(value) ? value : [value]).map((v) => [name, v] as [string, string]),
          ),
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
          signal: controller.signal,
        }),
      );
      const kind = result.headers.get('content-type')?.startsWith('text/event-stream')
        ? 'sse'
        : result.body == null
          ? 'empty'
          : 'json';
      response.writeHead(result.status, {
        ...Object.fromEntries(result.headers),
        ...relayHttpHeaders(kind),
      });
      if (!result.body) {
        response.end();
        return;
      }
      const reader = result.body.getReader();
      try {
        while (!response.destroyed && !response.writableEnded) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!response.write(value)) {
            // A disconnected client never emits drain. Close and error must unblock the write.
            if (response.destroyed || response.writableEnded) break;
            await new Promise<void>((resolve) => {
              const doneWriting = () => {
                response.off('drain', doneWriting);
                response.off('close', doneWriting);
                response.off('error', doneWriting);
                resolve();
              };
              response.once('drain', doneWriting);
              response.once('close', doneWriting);
              response.once('error', doneWriting);
              if (response.destroyed || response.writableEnded) doneWriting();
            });
            if (response.destroyed || response.writableEnded) break;
          }
        }
      } finally {
        await reader.cancel();
        if (!response.destroyed && !response.writableEnded) response.end();
      }
    } catch (e) {
      const mapped = mapRelayError(e);
      if (!response.headersSent) response.writeHead(mapped.status, relayHttpHeaders('json'));
      if (!response.destroyed) response.end(JSON.stringify({ error: mapped.error }));
    }
  });
  server.requestTimeout = 10000;
  const wsServer = new WebSocketServer({ server, path: '/ws', maxPayload: 1048576 });
  const wsAuth = (): RelayAuthContext => ({
    expectedOrigin: boundOrigin,
    requireOrigin: options.allowUnboundRelayAuth !== true,
  });
  wsServer.on('connection', (socket) => {
    let subscription: {
      disposed: boolean;
      timer?: ReturnType<typeof setTimeout>;
      stop: () => void;
    } = { disposed: true, stop: () => {} };
    const disposeSubscription = () => {
      subscription.disposed = true;
      if (subscription.timer !== undefined) {
        clearTimeout(subscription.timer);
        subscription.timer = undefined;
      }
      subscription.stop();
      subscription.stop = () => {};
    };
    socket.once('close', () => disposeSubscription());
    socket.on('message', (raw) => {
      try {
        const request = JSON.parse(raw.toString()) as {
          method: 'send' | 'receive' | 'subscribe' | 'unsubscribe';
          envelope?: SignedEnvelope;
          recipientDid?: string;
          authToken?: string;
          auth?: string;
          role?: RelayInboxRole;
          taskId?: string | string[];
          peek?: boolean;
        };
        if (request.method === 'send' && request.envelope) {
          relay.send(request.envelope);
          socket.send(JSON.stringify({ ok: true }));
        } else if (request.method === 'receive' && request.recipientDid) {
          const receive = relay.openInbox(
            request.recipientDid,
            request.authToken ?? request.auth,
            'receive',
            wsAuth(),
            { role: request.role, taskId: request.taskId, peek: request.peek },
          );
          socket.send(JSON.stringify({ envelope: receive() ?? null }));
        } else if (request.method === 'subscribe' && request.recipientDid) {
          const did = request.recipientDid,
            receive = relay.openInbox(
              did,
              request.authToken ?? request.auth,
              'subscribe',
              wsAuth(),
              { role: request.role, taskId: request.taskId },
            );
          disposeSubscription();
          const current: {
            disposed: boolean;
            timer?: ReturnType<typeof setTimeout>;
            stop: () => void;
          } = { disposed: false, stop: () => {} };
          subscription = current;
          const flush = () => {
            if (current.disposed) return;
            let envelope;
            // A slow socket must not pull the recipient queue ahead of maxQueueSize.
            while (
              !current.disposed &&
              socket.readyState === WebSocket.OPEN &&
              socket.bufferedAmount < 1048576 &&
              (envelope = receive())
            )
              socket.send(JSON.stringify({ envelope }));
            if (
              !current.disposed &&
              socket.readyState === WebSocket.OPEN &&
              socket.bufferedAmount >= 1048576
            ) {
              if (current.timer !== undefined) clearTimeout(current.timer);
              current.timer = setTimeout(() => {
                current.timer = undefined;
                flush();
              }, 20);
            }
          };
          current.stop = relay.subscribe(did, flush);
          flush();
        } else if (request.method === 'unsubscribe') {
          disposeSubscription();
        } else throw new Error('INVALID_REQUEST');
      } catch (e) {
        socket.send(JSON.stringify({ ok: false, error: sanitizeRelayErrorCode(e) }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('RELAY_BIND'));
        return;
      }
      const hostname = address.address.includes(':')
        ? '[' + address.address + ']'
        : address.address;
      boundOrigin = 'http://' + hostname + ':' + address.port;
      resolve();
    });
  });
  const maintenance = setInterval(() => {
    relay.evictExpired();
    void relay.flushWakeNotifications();
  }, 1000);
  maintenance.unref();
  return {
    relay,
    url: boundOrigin,
    wsUrl: boundOrigin.replace(/^http:/, 'ws:') + '/ws',
    close: async () => {
      clearInterval(maintenance);
      for (const client of wsServer.clients) client.terminate();
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
export type RelayAuthSource =
  | KeyPair
  | ((
      recipientDid: string,
      action: RelayAuthAction,
      origin?: string,
    ) => string | Promise<string>);
class RelayCredentials {
  private recipientKeys = new Map<string, KeyPair>();
  constructor(
    private authSource: RelayAuthSource | undefined,
    private relayUrl: string,
  ) {}
  setRecipientKey(key: KeyPair): this {
    this.recipientKeys.set(key.did, key);
    return this;
  }
  protected requireAuth(did: string): void {
    if (!this.recipientKeys.has(did) && typeof this.authSource !== 'function' && this.authSource?.did !== did)
      throw new Error('RELAY_AUTH_REQUIRED');
  }
  protected async authToken(did: string, action: RelayAuthAction): Promise<string> {
    const origin = normalizeRelayOrigin(this.relayUrl);
    const key = this.recipientKeys.get(did);
    if (key) return createRelayAuthToken(key, { action, origin });
    if (typeof this.authSource === 'function') return this.authSource(did, action, origin);
    if (this.authSource?.did === did)
      return createRelayAuthToken(this.authSource, { action, origin });
    throw new Error('RELAY_AUTH_REQUIRED');
  }
}
export interface RelayTransport {
  readonly connectionStatus?: RelayConnectionStatus;
  /** The transport bounds each request and its own recovery waits. */
  readonly managesRequestDeadlines?: boolean;
  withRecipient?(key: KeyPair): RelayTransport;
  setRecipientKey?(key: KeyPair): unknown;
  send(envelope: SignedEnvelope): void | Promise<void>;
  deliveryStatus?(envelope: SignedEnvelope, signal?: AbortSignal): SignedRelayDeliveryStatus | undefined | Promise<SignedRelayDeliveryStatus | undefined>;
  acknowledgeDelivery?(recipientDid: string, envelopeId: string, signal?: AbortSignal): void | Promise<void>;
  receive(
    recipientDid: string,
    waitMs?: number,
    signal?: AbortSignal,
    filter?: RelayReceiveFilter,
  ): SignedEnvelope | undefined | Promise<SignedEnvelope | undefined>;
  peek?(
    recipientDid: string,
    filter?: Omit<RelayReceiveFilter, 'peek'>,
  ): SignedEnvelope | undefined | Promise<SignedEnvelope | undefined>;
  pollInbox?(
    recipientDid: string,
    filter?: RelayReceiveFilter & { waitMs?: number; signal?: AbortSignal },
  ): SignedEnvelope | undefined | Promise<SignedEnvelope | undefined>;
  register?(card: import('@acp/core').SignedAgentCard): void | Promise<void>;
  discover?():
    | import('@acp/core').SignedAgentCard[]
    | Promise<import('@acp/core').SignedAgentCard[]>;
}
const nativeFetch = globalThis.fetch;
function isKeyPair(value: unknown): value is KeyPair {
  return (
    !!value &&
    typeof value === 'object' &&
    'did' in value &&
    'privateKey' in value &&
    typeof (value as KeyPair).did === 'string' &&
    typeof (value as KeyPair).privateKey === 'string'
  );
}
function splitRelayArgs(
  second?: typeof fetch | KeyPair | RelayClientSecurityOptions,
  third?: RelayAuthSource | RelayClientSecurityOptions,
  fourth?: RelayClientSecurityOptions,
): { fetcher: typeof fetch; auth?: RelayAuthSource; security: RelayClientSecurityOptions } {
  let fetcher: typeof fetch = fetch;
  let auth: RelayAuthSource | undefined;
  let security: RelayClientSecurityOptions = {};
  if (typeof second === 'function') fetcher = second;
  else if (isKeyPair(second)) auth = second;
  else if (second) security = { ...second };
  if (typeof third === 'function' || isKeyPair(third)) auth = third;
  else if (third) security = { ...security, ...third };
  if (fourth) security = { ...security, ...fourth };
  return { fetcher, auth, security };
}
export class HttpRelayClient extends RelayCredentials implements RelayTransport {
  readonly managesRequestDeadlines = true;
  connectionStatus: RelayConnectionStatus = 'stopped';
  // Concurrent failures of the same protected operation/identity share a bound,
  // never a response. Unrelated successful requests cannot clear an active episode.
  private authRecoveries = new Map<string, { started: number; attempts: number; users: number }>();
  private statusPins = new Map<string, string>();
  private buffered = new Map<string, SignedEnvelope[]>();
  private delivered = new Map<string, { expires: number; acknowledged: boolean }>();
  private readonly baseFetcher: typeof fetch;
  protected readonly security: RelayClientSecurityOptions;
  private transportPromise?: Promise<typeof fetch>;
  readonly fetcher: typeof fetch;
  constructor(
    readonly url: string,
    fetcherOrKey: typeof fetch | KeyPair | RelayClientSecurityOptions = fetch,
    authOrOptions?: RelayAuthSource | RelayClientSecurityOptions,
    options?: RelayClientSecurityOptions,
  ) {
    const parsed = splitRelayArgs(fetcherOrKey, authOrOptions, options);
    super(parsed.auth, url);
    this.baseFetcher = parsed.fetcher;
    this.security = parsed.security;
    validateRelayAuthRecoveryOptions(this.security);
    this.fetcher = ((input: RequestInfo | URL, init?: RequestInit) =>
      this.dispatch(input, init)) as typeof fetch;
  }
  private async dispatch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const transport = await this.prepare();
    return transport(input, init);
  }
  private prepare(): Promise<typeof fetch> {
    // Cache successful pins and security failures; transient DNS failures can be retried.
    this.transportPromise ??= this.buildTransport().catch((error: unknown) => {
      if (isTransientRelayError(error)) this.transportPromise = undefined;
      throw error;
    });
    return this.transportPromise;
  }
  private async buildTransport(): Promise<typeof fetch> {
    const custom = this.baseFetcher !== nativeFetch;
    if (custom && !this.security.lookup) {
      validateRelayEndpointUrl(this.url, { allowPrivateRelay: this.security.allowPrivateRelay });
      return this.baseFetcher;
    }
    const resolved = await resolveAndValidateRelayEndpoint(this.url, this.security);
    if (custom) return this.baseFetcher;
    return createPinnedRelayFetch(resolved, this.security);
  }
  protected async authenticatedRequest<T>(
    did: string, action: RelayAuthAction, operation: RelayAuthOperation,
    input: string, init: RequestInit, consume: (response: Response) => Promise<T>,
    signal?: AbortSignal, acceptedStatuses: number[] = [],
  ): Promise<T> {
    const maxAttempts = this.security.maxAuthRecoveryAttempts ?? 3;
    const windowMs = this.security.authRecoveryTimeoutMs ?? 120_000;
    const key = did + '\0' + operation;
    let episode: { started: number; attempts: number; users: number } | undefined;
    const exhausted = () => new RelayAuthRecoveryExhaustedError(operation, episode!.attempts,
      Math.round(performance.now() - episode!.started));
    try {
      for (;;) {
        signal?.throwIfAborted();
        if (episode) {
          const remaining = windowMs - (performance.now() - episode.started);
          if (episode.attempts >= maxAttempts || remaining <= 0) throw exhausted();
          this.connectionStatus = 'reconnecting';
          console.warn('Relay authentication retry ' + (episode.attempts + 1) + '/' + maxAttempts);
          await waitForRelayRetry(Math.min(relayRetryDelay(episode.attempts), remaining), signal);
          signal?.throwIfAborted();
          if (episode.attempts >= maxAttempts || performance.now() - episode.started >= windowMs) throw exhausted();
          episode.attempts++;
        }
        const timeout = Math.min(this.security.requestTimeoutMs ?? 45_000,
          episode ? windowMs - (performance.now() - episode.started) : Infinity);
        const controller = new AbortController();
        const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        try {
          const value = await relayDeadline((async () => {
            this.requireAuth(did);
            const transport = await this.prepare();
            requestSignal.throwIfAborted();
            // Sign after preparation and backoff, immediately before dispatch.
            const token = await this.authToken(did, action);
            requestSignal.throwIfAborted();
            const headers = new Headers(init.headers);
            headers.set('authorization', 'Bearer ' + token);
            const response = await transport(input, { ...init, headers, signal: requestSignal });
            if (requestSignal.aborted || (!response.ok && !acceptedStatuses.includes(response.status))) {
              void response.body?.cancel().catch(() => {});
              requestSignal.throwIfAborted();
              throw new RelayHttpError(response.status, operation);
            }
            return consume(response);
          })(), timeout, requestSignal);
          this.connectionStatus = 'connected';
          return value;
        } catch (error) {
          controller.abort(error);
          signal?.throwIfAborted();
          if (error instanceof RelayHttpError && error.status === 401) {
            if (maxAttempts === 0) throw error;
            if (!episode) {
              episode = this.authRecoveries.get(key) ?? { started: performance.now(), attempts: 0, users: 0 };
              episode.users++;
              this.authRecoveries.set(key, episode);
            }
          } else if (!episode || !isTransientRelayError(error)) throw error;
          // Transient failures during recovery consume the same attempt/window
          // budget; the outer poll/SSE supervisor must not start another episode.
        }
      }
    } catch (error) {
      if (error instanceof RelayAuthRecoveryExhaustedError || error instanceof RelayHttpError)
        this.connectionStatus = 'unavailable';
      throw error;
    } finally {
      if (episode && --episode.users === 0) this.authRecoveries.delete(key);
    }
  }
  async send(envelope: SignedEnvelope): Promise<void> {
    const result = await this.fetcher(this.url + '/envelopes', {
      method: 'POST',
      body: JSON.stringify(envelope),
      headers: { 'content-type': 'application/json' },
    });
    if (!result.ok) {
      await result.body?.cancel();
      throw new Error('RELAY_REJECTED: ' + result.status);
    }
    const relayDid = result.headers.get('x-acp-relay-did');
    if (relayDid) {
      if (this.statusPins.size >= 16384) this.statusPins.delete(this.statusPins.keys().next().value!);
      this.statusPins.set(envelope.payload.envelopeId, relayDid);
    }
  }
  /** Register an operator-configured channel; null unregisters it. Startup still drains the normal inbox. */
  async registerWake(recipientDid: string, channel: string | null, signal?: AbortSignal): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.authenticatedRequest(recipientDid, 'receive', 'wake',
          this.url + '/wake?recipient=' + encodeURIComponent(recipientDid), {
            method: 'POST', body: JSON.stringify({ channel }),
            headers: { 'content-type': 'application/json' },
          }, async r => {
            const value = await r.json() as { relayDid: string };
            resolveDid(value.relayDid);
            return value.relayDid;
          }, signal);
      } catch (error) {
        if (attempt >= 4 || !isTransientRelayError(error)) throw error;
        console.warn('Relay wake registration retry ' + (attempt + 1));
        await waitForRelayRetry(relayRetryDelay(attempt), signal);
      }
    }
  }
  async deliveryStatus(envelope: SignedEnvelope, signal?: AbortSignal): Promise<SignedRelayDeliveryStatus | undefined> {
    const p = envelope.payload;
    const relayDid = this.statusPins.get(p.envelopeId);
    // Old relays do not advertise signed delivery status support.
    if (!relayDid) return;
    const params = new URLSearchParams({ recipient: p.recipientDid, sender: p.senderDid, envelopeId: p.envelopeId });
    return this.authenticatedRequest(p.senderDid, 'receive', 'delivery-status',
      this.url + '/delivery-status?' + params, {}, async r => {
      const notice = await r.json() as SignedRelayDeliveryStatus;
      const value = notice.payload;
      if (!verifySigned(notice, relayDid) || value.type !== 'RelayDeliveryStatus' ||
          value.envelopeId !== p.envelopeId || value.senderDid !== p.senderDid ||
          value.recipientDid !== p.recipientDid || !['pending', 'expired', 'unknown'].includes(value.state) ||
          (value.state !== 'unknown' && value.taskId !== p.taskId) ||
          value.relay !== new URL(this.url).origin ||
          (value.state !== 'unknown' && !Number.isSafeInteger(value.expiresAt)) ||
          (value.state === 'pending' && Math.abs(Date.now() - Date.parse(notice.signature.signedAt)) > 300_000)) throw new Error('RELAY_TAMPERING_DETECTED');
      if (value.state !== 'pending') this.statusPins.delete(p.envelopeId);
      return notice;
    }, signal);
  }
  async register(card: import('@acp/core').SignedAgentCard): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        const timeout = this.security.requestTimeoutMs ?? 45_000;
        await relayDeadline((async () => {
          const r = await this.fetcher(this.url + '/agents', {
            method: 'POST', body: JSON.stringify(card),
            headers: { 'content-type': 'application/json' },
            signal: AbortSignal.timeout(timeout),
          });
          if (!r.ok) {
            await r.body?.cancel();
            throw new Error('RELAY_REGISTRATION_REJECTED: ' + r.status);
          }
          await r.arrayBuffer();
        })(), timeout);
        return;
      } catch (error) {
        if (attempt >= 4 || !isTransientRelayError(error)) throw error;
        console.warn('Relay registration retry ' + (attempt + 1));
        await waitForRelayRetry(relayRetryDelay(attempt));
      }
    }
  }

  async discover(): Promise<import('@acp/core').SignedAgentCard[]> {
    const r = await this.fetcher(this.url + '/agents');
    if (!r.ok) throw new Error('DISCOVERY_FAILED');
    const cards = (await r.json()) as import('@acp/core').SignedAgentCard[];
    if (!Array.isArray(cards)) throw new Error('INVALID_AGENT_CARD');
    const { verifySignedAgentCard } = await import('@acp/core');
    const now = Date.now();
    return cards.filter((c) => verifySignedAgentCard(c, now));
  }
  async receive(
    recipientDid: string,
    waitMs?: number,
    signal?: AbortSignal,
    filter?: RelayReceiveFilter,
  ): Promise<SignedEnvelope | undefined> {
    const normalized = normalizeReceiveFilter(filter);
    const bufferKey =
      recipientDid +
      '\0' +
      (normalized.lease ? 'lease:' : '') + (normalized.role ?? '') +
      '\0' +
      (normalized.taskIds ? [...normalized.taskIds].sort().join(',') : '');
    if (!normalized.peek) {
      const queue = this.buffered.get(bufferKey) ?? [];
      if (queue.length) return queue.shift();
    }
    const params = new URLSearchParams({ recipient: recipientDid });
    if (waitMs !== undefined) params.set('waitMs', String(waitMs));
    if (normalized.role) params.set('role', normalized.role);
    if (normalized.taskIds) {
      for (const id of normalized.taskIds) params.append('taskId', id);
    }
    if (normalized.peek) params.set('peek', 'true');
    else if (normalized.lease) params.set('lease', 'true');
    const values = await this.authenticatedRequest(recipientDid, 'receive', normalized.peek ? 'peek' : 'receive',
      this.url + '/envelopes?' + params.toString(), {}, async r => {
        if (r.status === 204) return [];
        const body = (await r.json()) as SignedEnvelope | { envelopes: SignedEnvelope[] };
        const envelopes = 'envelopes' in body ? body.envelopes : [body];
        if (!Array.isArray(envelopes) || envelopes.some(e => !verifyEnvelope(e, recipientDid)))
          throw new Error('RELAY_TAMPERING_DETECTED');
        return envelopes;
      }, signal);
    if (normalized.peek) return values[0];
    const fresh: SignedEnvelope[] = [];
    for (const envelope of values)
      if (!normalized.lease || await this.rememberDelivery(recipientDid, envelope, signal)) fresh.push(envelope);
    this.buffered.set(bufferKey, fresh);
    return fresh.shift();
  }

  protected async rememberDelivery(recipientDid: string, envelope: SignedEnvelope, signal?: AbortSignal): Promise<boolean> {
    const now = Date.now();
    for (const [id, entry] of this.delivered) if (entry.expires <= now) this.delivered.delete(id);
    const id = recipientDid + ':' + envelope.payload.envelopeId;
    const prior = this.delivered.get(id);
    if (prior) {
      if (prior.acknowledged) {
        try { await this.acknowledgeDelivery(recipientDid, envelope.payload.envelopeId, signal); }
        catch (error) { if (!isTransientRelayError(error)) throw error; }
      }
      return false;
    }
    if (this.delivered.size >= 16384) throw new Error('RELAY_DEDUPE_CAPACITY');
    this.delivered.set(id, { expires: now + 10 * 60_000, acknowledged: false });
    return true;
  }
  async acknowledgeDelivery(recipientDid: string, envelopeId: string, signal?: AbortSignal): Promise<void> {
    const entry = this.delivered.get(recipientDid + ':' + envelopeId);
    if (!entry) return;
    // Processing has completed even if the DELETE response is lost. Redelivery retries the ack.
    entry.acknowledged = true;
    await this.authenticatedRequest(recipientDid, 'receive', 'acknowledge',
      this.url + '/envelopes/' + encodeURIComponent(envelopeId) +
        '?recipient=' + encodeURIComponent(recipientDid), { method: 'DELETE' },
      async r => { await r.arrayBuffer(); }, signal, [404]);
  }
  async peek(
    recipientDid: string,
    filter?: Omit<RelayReceiveFilter, 'peek'>,
  ): Promise<SignedEnvelope | undefined> {
    return this.receive(recipientDid, undefined, undefined, { ...filter, peek: true });
  }
  async pollInbox(
    recipientDid: string,
    filter?: RelayReceiveFilter & { waitMs?: number; signal?: AbortSignal },
  ): Promise<SignedEnvelope | undefined> {
    return this.receive(recipientDid, filter?.waitMs, filter?.signal, filter);
  }
}
/** Persistent SSE transport. Leased frames remain on the relay until explicitly acknowledged. */
export class SseRelayClient extends HttpRelayClient {
  maxBufferBytes = 2 * 1024 * 1024;
  private streams = new Map<string, {
    controller: AbortController;
    queue: SignedEnvelope[];
    notify: Set<() => void>;
    error?: Error;
    pump?: Promise<void>;
  }>();
  override async receive(
    recipientDid: string,
    waitMs = 30000,
    signal?: AbortSignal,
    filter?: RelayReceiveFilter,
  ): Promise<SignedEnvelope | undefined> {
    signal?.throwIfAborted();
    if (filter?.peek) return super.receive(recipientDid, waitMs, signal, filter);
    const normalized = normalizeReceiveFilter(filter);
    const key = recipientDid + '\0' + (normalized.role ?? '') + '\0' +
      (normalized.taskIds ? [...normalized.taskIds].sort().join(',') : '');
    let state = this.streams.get(key);
    if (!state) {
      state = { controller: new AbortController(), queue: [], notify: new Set() };
      this.streams.set(key, state);
    }
    const current = state;
    if (!current.pump && !current.error) {
      current.controller = new AbortController();
      current.pump = (async () => {
        let attempt = 0;
        while (!current.controller.signal.aborted) {
          const started = Date.now();
          try {
            for await (const e of this.stream(recipientDid, current.controller.signal, filter)) {
              if (current.queue.length >= 1000) throw new Error('SSE_CAPACITY');
              current.queue.push(e);
              attempt = 0;
              for (const notify of [...current.notify]) notify();
            }
            throw new Error('SSE_CLOSED');
          } catch (error) {
            if (current.controller.signal.aborted) break;
            if (!isTransientRelayError(error)) {
              current.error = relayDiagnostic(error);
              this.connectionStatus = 'unavailable';
              break;
            }
            this.connectionStatus = 'reconnecting';
            if (Date.now() - started > 35_000) attempt = 0;
            try { await waitForRelayRetry(relayRetryDelay(attempt++), current.controller.signal); }
            catch { break; }
          }
        }
        for (const notify of [...current.notify]) notify();
      })().finally(() => { current.pump = undefined; });
    }
    const abort = () => current.controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (current.error) throw current.error;
      if (current.queue.length) return current.queue.shift();
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          current.notify.delete(wake);
          signal?.removeEventListener('abort', stop);
        };
        const wake = () => { cleanup(); resolve(); };
        const stop = () => { cleanup(); reject(signal?.reason ?? new Error('SSE_ABORTED')); };
        const timer = setTimeout(wake, Math.max(0, Math.min(waitMs, 30000)));
        current.notify.add(wake);
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted) stop();
      });
      if (current.error) throw current.error;
      return current.queue.shift();
    } finally { signal?.removeEventListener('abort', abort); }
  }
  async close(): Promise<void> {
    this.connectionStatus = 'stopped';
    const states = [...this.streams.values()];
    this.streams.clear();
    for (const state of states) {
      state.error = new Error('SSE_ABORTED');
      state.controller.abort(state.error);
      for (const notify of [...state.notify]) notify();
    }
    await Promise.all(states.map((s) => s.pump));
  }
  async *stream(recipientDid: string, signal?: AbortSignal, filter?: RelayReceiveFilter): AsyncGenerator<SignedEnvelope> {
    const params = new URLSearchParams({ recipient: recipientDid, lease: 'true' });
    const normalized = normalizeReceiveFilter(filter);
    if (normalized.role) params.set('role', normalized.role);
    for (const id of normalized.taskIds ?? []) params.append('taskId', id);
    const controller = new AbortController();
    const stopped = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', stopped, { once: true });
    if (signal?.aborted) stopped();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const r = await this.authenticatedRequest(recipientDid, 'stream', 'stream',
        this.url + '/stream?' + params, {}, async response => response, controller.signal);
      if (!r.body) throw new Error('SSE_CLOSED');
      this.connectionStatus = 'connected';
      reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        timer = setTimeout(() => controller.abort(new Error('RELAY_IDLE_TIMEOUT')), this.security.socketTimeoutMs ?? 35_000);
        const { value, done } = await relayDeadline(reader.read(), this.security.socketTimeoutMs ?? 35_000, controller.signal);
        clearTimeout(timer);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replaceAll('\r\n', '\n');
        if (Buffer.byteLength(buffer, 'utf8') > this.maxBufferBytes) throw new Error('SSE_BUFFER_OVERFLOW');
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, '')).join('\n');
          if (data) {
            const e = JSON.parse(data) as SignedEnvelope;
            if (!verifyEnvelope(e, recipientDid)) throw new Error('RELAY_TAMPERING_DETECTED');
            if (!await this.rememberDelivery(recipientDid, e, controller.signal)) continue;
            yield e;
          }
        }
      }
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
      signal?.removeEventListener('abort', stopped);
      await reader?.cancel().catch(() => {});
    }
  }
}
function socketIsOpen(socket: WebSocket | undefined): boolean {
  return socket?.readyState === WebSocket.OPEN;
}
export class WebSocketRelayClient extends RelayCredentials {
  private socket?: WebSocket;
  private pending = false;
  private stopped = false;
  private opening?: Promise<void>;
  private readonly security: RelayClientSecurityOptions;
  constructor(
    readonly url: string,
    authOrOptions?: RelayAuthSource | RelayClientSecurityOptions,
    options?: RelayClientSecurityOptions,
  ) {
    const parsed = splitRelayArgs(undefined, authOrOptions, options);
    super(parsed.auth, url);
    this.security = parsed.security;
  }
  private requireSocket(): WebSocket {
    if (!this.socket) throw new Error('RELAY_CLOSED');
    return this.socket;
  }
  private async open(): Promise<void> {
    const resolved = await resolveAndValidateRelayEndpoint(this.url, this.security);
    if (this.stopped) return;
    const hostname = resolved.url.hostname.replace(/^\[|\]$/g, '');
    const secure = resolved.url.protocol === 'wss:';
    const wsOptions = {
      lookup: resolved.lookup,
      ...(secure ? { servername: hostname } : {}),
    };
    const socket = new WebSocket(this.url, wsOptions);
    this.socket = socket;
    if (this.stopped) {
      socket.close();
      return;
    }
    if (socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(error);
      socket.once('open', () => {
        socket.off('error', fail);
        resolve();
      });
      socket.once('error', fail);
    });
  }
  async ready(): Promise<void> {
    if (this.stopped) throw new Error('RELAY_CLOSED');
    // Read readyState through a helper so the early check does not exclude OPEN later.
    if (!socketIsOpen(this.socket)) {
      this.opening ??= this.open();
      await this.opening;
    }
    if (this.stopped || !socketIsOpen(this.socket)) throw new Error('RELAY_CLOSED');
  }
  private async request(body: unknown): Promise<{ error?: string; envelope?: SignedEnvelope }> {
    await this.ready();
    if (this.pending) throw new Error('CONCURRENT_RELAY_REQUEST');
    this.pending = true;
    try {
      const socket = this.requireSocket();
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.removeListener('message', receive);
          reject(new Error('RELAY_TIMEOUT'));
        }, 5000);
        const receive = (raw: import('ws').RawData) => {
          clearTimeout(timer);
          try {
            const r = JSON.parse(raw.toString()) as { error?: string };
            r.error ? reject(new Error(r.error)) : resolve(r);
          } catch (e) {
            reject(e);
          }
        };
        socket.once('message', receive);
        socket.send(JSON.stringify(body));
      });
    } finally {
      this.pending = false;
    }
  }
  async send(envelope: SignedEnvelope): Promise<void> {
    await this.request({ method: 'send', envelope });
  }
  async receive(
    recipientDid: string,
    _waitMs?: number,
    _signal?: AbortSignal,
    filter?: RelayReceiveFilter,
  ): Promise<SignedEnvelope | undefined> {
    const r = await this.request({
      method: 'receive',
      recipientDid,
      authToken: await this.authToken(recipientDid, 'receive'),
      ...(filter?.role ? { role: filter.role } : {}),
      ...(filter?.taskId ? { taskId: filter.taskId } : {}),
      ...(filter?.peek ? { peek: true } : {}),
    });
    if (r.envelope && !verifyEnvelope(r.envelope, recipientDid))
      throw new Error('RELAY_TAMPERING_DETECTED');
    return r.envelope ?? undefined;
  }
  async *subscribe(recipientDid: string, signal?: AbortSignal): AsyncGenerator<SignedEnvelope> {
    signal?.throwIfAborted();
    await this.ready();
    const authToken = await this.authToken(recipientDid, 'subscribe');
    if (this.pending) throw new Error('CONCURRENT_RELAY_REQUEST');
    this.pending = true;
    const queue: SignedEnvelope[] = [];
    let failure: unknown,
      wake = () => {};
    const receive = (raw: import('ws').RawData) => {
      try {
        const r = JSON.parse(raw.toString()) as { error?: string; envelope?: SignedEnvelope };
        if (r.error) throw new Error(r.error);
        if (!r.envelope || !verifyEnvelope(r.envelope, recipientDid))
          throw new Error('RELAY_TAMPERING_DETECTED');
        if (queue.length >= 1000) throw new Error('RELAY_CAPACITY');
        queue.push(r.envelope);
      } catch (e) {
        failure = e;
      }
      wake();
    };
    const close = () => {
        failure = new Error('RELAY_CLOSED');
        wake();
      },
      error = (e: Error) => {
        failure = e;
        wake();
      };
    const abort = () => wake();
    const socket = this.requireSocket();
    socket.on('message', receive);
    socket.once('close', close);
    socket.once('error', error);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      socket.send(JSON.stringify({ method: 'subscribe', recipientDid, authToken }));
      while (!signal?.aborted) {
        if (failure) throw failure;
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (queue.length || failure || signal?.aborted) resolve();
        });
      }
    } finally {
      socket.off('message', receive);
      socket.off('close', close);
      socket.off('error', error);
      signal?.removeEventListener('abort', abort);
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ method: 'unsubscribe' }));
      this.pending = false;
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    const socket = this.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once('close', resolve);
      socket.close();
    });
  }
}
