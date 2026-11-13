// SPDX-License-Identifier: Apache-2.0
import { lookup as dnsLookup } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import type { LookupFunction } from 'node:net';
import { validateIpAddress, validateRelayEndpointUrl } from '@acp/core';
import { RelayTimeoutError, relayDeadline, isTransientRelayError, relayProxyError } from './retry.js';
import type { RelayEndpointPolicy } from '@acp/core';
import type { RelayAuthRecoveryOptions } from './retry.js';
import { connectRelayProxy, relayProxyFor, type RelayProxy } from './proxy.js';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Injectable DNS resolver. Tests pass a mock; production uses dns.lookup. */
export interface RelayLookup {
  (
    hostname: string,
    options?: { all?: boolean; family?: number; verbatim?: boolean },
  ): Promise<ResolvedAddress[]>;
}

export interface RelayClientSecurityOptions extends RelayEndpointPolicy, RelayAuthRecoveryOptions {
  lookup?: RelayLookup;
  requestTimeoutMs?: number;
  socketTimeoutMs?: number;
}

export interface ResolvedRelayEndpoint {
  url: URL;
  proxy?: RelayProxy;
  addresses: ResolvedAddress[];
  /** Pins validated direct answers, including detected synthetic TLS egress. */
  lookup: LookupFunction;
  syntheticDns?: boolean;
}

async function systemLookup(hostname: string): Promise<ResolvedAddress[]> {
  const found = await dnsLookup(hostname, { all: true, verbatim: true });
  return found.map((item) => ({
    address: item.address,
    family: item.family === 6 ? 6 : 4,
  }));
}

function pinnedNodeLookup(addresses: ResolvedAddress[]): LookupFunction {
  const listed = addresses.map((item) => ({ address: item.address, family: item.family }));
  const lookup: LookupFunction = (_hostname, options, callback) => {
    const family = options.family;
    const selected =
      family === 4 || family === 6 ? listed.filter((item) => item.family === family) : listed;
    const chosen = selected.length > 0 ? selected : listed;
    if (chosen.length === 0) {
      callback(Object.assign(new Error('SSRF_BLOCKED_RELAY_URL'), { code: 'ENOTFOUND' }), '', 4);
      return;
    }
    if (options.all) {
      callback(null, chosen);
      return;
    }
    callback(null, chosen[0].address, chosen[0].family);
  };
  return lookup;
}

function benchmarkOnly(addresses: ResolvedAddress[]): boolean {
  return Array.isArray(addresses) && addresses.length > 0 && addresses.every(item => item &&
    item.family === 4 && typeof item.address === 'string' && /^198\.(?:18|19)\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/.test(item.address) &&
    item.address.split('.').every(part => Number(part) <= 255));
}

// One bounded canary per process resolver (including injected test resolvers).
// Cache failures too; a timeout or real NXDOMAIN must never enable this route.
const syntheticResolvers = new WeakMap<RelayLookup, Promise<boolean>>();
function syntheticResolver(lookup: RelayLookup, timeoutMs: number): Promise<boolean> {
  let pending = syntheticResolvers.get(lookup);
  if (!pending) {
    pending = relayDeadline(Promise.resolve().then(() =>
      lookup('sb-' + randomUUID() + '.invalid', { all: true, verbatim: true })),
      Math.min(timeoutMs, 2000)).then(benchmarkOnly, () => false);
    syntheticResolvers.set(lookup, pending);
  }
  return pending;
}

function literalAddress(hostname: string): ResolvedAddress | undefined {
  if (hostname.includes(':')) return { address: hostname, family: 6 };
  if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(hostname))
    return { address: hostname, family: 4 };
  return undefined;
}

/**
 * Validate URL policy first. Direct routes validate and pin every A/AAAA answer;
 * configured proxy routes defer destination DNS to the proxy (see below).
 */
export async function resolveAndValidateRelayEndpoint(
  value: string,
  options: RelayClientSecurityOptions = {},
): Promise<ResolvedRelayEndpoint> {
  validateRelayEndpointUrl(value, { allowPrivateRelay: options.allowPrivateRelay });
  const url = new URL(value);
  const proxy = relayProxyFor(url);
  if (proxy) {
    // The configured proxy resolves the destination. Local DNS can be synthetic
    // (e.g. Muse's 198.18/15 answers) and must neither block nor pin this route.
    // URL/literal/metadata policy above still applies; NO_PROXY uses the complete
    // direct DNS validation and pinning path below, unchanged.
    return { url, proxy, addresses: [], lookup: pinnedNodeLookup([]) };
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
  const literal = literalAddress(hostname);
  let addresses: ResolvedAddress[];
  if (literal) {
    validateIpAddress(literal.address, { allowPrivateRelay: options.allowPrivateRelay });
    addresses = [literal];
  } else {
    let found: ResolvedAddress[];
    try {
      found = await relayDeadline((options.lookup ?? systemLookup)(hostname, { all: true, verbatim: true }), options.requestTimeoutMs ?? 45_000);
    } catch (error) {
      if (isTransientRelayError(error)) throw error;
      if (error instanceof Error && error.message === 'SSRF_BLOCKED_RELAY_URL') throw error;
      throw new Error('SSRF_BLOCKED_RELAY_URL');
    }
    if (!Array.isArray(found) || found.length === 0) throw new Error('SSRF_BLOCKED_RELAY_URL');
    addresses = found.map((item) => ({
      address: item.address,
      family: item.family === 6 ? 6 : 4,
    }));
    if ((url.protocol === 'https:' || url.protocol === 'wss:') && benchmarkOnly(addresses) &&
        await syntheticResolver(options.lookup ?? systemLookup, options.requestTimeoutMs ?? 45_000)) {
      // A random .invalid name cannot resolve on real DNS. This local sinkhole is
      // an SNI egress route: the egress proxy selects the destination by hostname,
      // with the same trust as explicit HTTPS_PROXY. An invite cannot configure
      // the local resolver. Keep URL/literal policy above and normal TLS/SNI
      // verification. Pin these validated synthetic answers so a second lookup
      // cannot switch the connection to an unvalidated address.
      return { url, addresses, lookup: pinnedNodeLookup(addresses), syntheticDns: true };
    }
    for (const item of addresses)
      validateIpAddress(item.address, { allowPrivateRelay: options.allowPrivateRelay });
  }
  return { url, addresses, lookup: pinnedNodeLookup(addresses) };
}

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return new URL(input.href);
  return new URL(input.url);
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    if (key === 'host') return;
    out[key] = value;
  });
  return out;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return Object.assign(new Error('ABORT'), { name: 'AbortError' });
}

function sameOrigin(target: URL, endpoint: URL): boolean {
  return (
    target.protocol === endpoint.protocol &&
    target.hostname === endpoint.hostname &&
    target.port === endpoint.port
  );
}

async function pinnedRequest(
  pin: ResolvedRelayEndpoint,
  input: RequestInfo | URL,
  init?: RequestInit,
  options: RelayClientSecurityOptions = {},
): Promise<Response> {
  const target = requestUrl(input);
  if (!sameOrigin(target, pin.url)) throw new Error('SSRF_BLOCKED_RELAY_URL');
  const secure = target.protocol === 'https:';
  if (target.protocol !== 'http:' && target.protocol !== 'https:')
    throw new Error('SSRF_BLOCKED_RELAY_URL');
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const lib = secure ? https : http;
  const signal = init?.signal ?? undefined;
  const started = performance.now();
  const tunnel = pin.proxy ? await connectRelayProxy(pin.proxy, target, options.requestTimeoutMs ?? 45_000, signal) : undefined;
  const agent = tunnel ? (secure ? new https.Agent({ keepAlive: true }) : new http.Agent({ keepAlive: true })) : undefined;
  // One agent per request: keep-alive controls the wire header, not tunnel reuse.
  if (agent && tunnel) agent.createConnection = () => tunnel;
  return new Promise<Response>((resolve, reject) => {
    let response: http.IncomingMessage | undefined;
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname,
        port: target.port === '' ? undefined : Number(target.port),
        method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
        path: target.pathname + target.search,
        headers: headerRecord(init?.headers),
        lookup: pin.lookup,
        agent: agent ?? false,
        ...(secure ? { servername: hostname } : {}),
      },
      (incoming) => {
        response = incoming;
        // Destroy even an idle/free tunnel once the body ends or is cancelled.
        if (agent) incoming.once('close', () => { agent.destroy(); tunnel?.destroy(); });
        // SSE is intentionally long-lived; retain its idle timeout after headers arrive.
        if (target.pathname.endsWith('/stream') && incoming.headers['content-type']?.startsWith('text/event-stream'))
          clearTimeout(deadline);
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value === undefined) continue;
          if (key === 'transfer-encoding' || key === 'content-length') continue;
          if (Array.isArray(value)) for (const item of value) headers.append(key, item);
          else headers.set(key, value);
        }
        const status = incoming.statusCode ?? 0;
        // 204/205/304 cannot carry a body. A stream argument makes Response throw.
        const nullBody = status === 101 || status === 204 || status === 205 || status === 304;
        if (nullBody) incoming.resume();
        const rawBody = nullBody
          ? null
          : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        const reader = pin.proxy ? rawBody?.getReader() : undefined;
        const body = reader ? new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) controller.close();
              else controller.enqueue(chunk.value);
            } catch (error) {
              controller.error(signal?.aborted ? abortError(signal) :
                error instanceof RelayTimeoutError ? error : relayProxyError('RELAY_PROXY_UNAVAILABLE', 'response', error));
            }
          },
          cancel: reason => reader.cancel(reason),
        }) : rawBody;
        try {
          resolve(
            new Response(body, {
              status,
              statusText: incoming.statusMessage,
              headers,
            }),
          );
        } catch (error) {
          incoming.destroy();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    );
    const fail = (error: Error) => {
      if (signal?.aborted) reject(abortError(signal));
      else reject(pin.proxy && !(error instanceof RelayTimeoutError) ? relayProxyError('RELAY_PROXY_UNAVAILABLE', response ? 'response' : 'request', error) : error);
    };
    req.on('error', fail);
    const timeout = () => {
      const error = pin.proxy
        ? new RelayTimeoutError(response ? 'response' : 'request')
        : new RelayTimeoutError();
      response?.destroy(error);
      req.destroy(error);
    };
    const deadline = setTimeout(timeout, pin.proxy
      ? Math.max(1, (options.requestTimeoutMs ?? 45_000) - (performance.now() - started))
      : options.requestTimeoutMs ?? 45_000);
    req.setTimeout(options.socketTimeoutMs ?? 35_000, timeout);
    req.once('close', () => { clearTimeout(deadline); agent?.destroy(); tunnel?.destroy(); });
    if (signal) {
      const onAbort = () => req.destroy(abortError(signal));
      if (signal.aborted) {
        req.destroy();
        reject(abortError(signal));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', onAbort));
    }
    const body = init?.body ?? null;
    if (body == null) req.end();
    else if (typeof body === 'string' || body instanceof Uint8Array) req.end(body);
    else if (body instanceof URLSearchParams) req.end(body.toString());
    else req.destroy(new Error('UNSUPPORTED_BODY'));
  }).catch(error => {
    // Also cover synchronous request-construction failures (e.g. invalid headers).
    agent?.destroy(); tunnel?.destroy();
    throw error;
  });
}

/** Fetch using a validated direct pin or the selected hostname-based proxy tunnel. */
export function createPinnedRelayFetch(
  endpoint: string | ResolvedRelayEndpoint,
  options: RelayClientSecurityOptions = {},
): typeof fetch {
  let pending: Promise<ResolvedRelayEndpoint> | undefined;
  const resolve = () => {
    if (typeof endpoint !== 'string') return Promise.resolve(endpoint);
    pending ??= resolveAndValidateRelayEndpoint(endpoint, options).catch((error: unknown) => {
      if (isTransientRelayError(error)) pending = undefined;
      throw error;
    });
    return pending;
  };
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    pinnedRequest(await resolve(), input, init, options)) as typeof fetch;
}
