// SPDX-License-Identifier: Apache-2.0
import http from 'node:http';
import tls from 'node:tls';
import { isIP, type Socket } from 'node:net';
import { RelayTimeoutError, relayProxyError, type RelayProxyStage } from './retry.js';

/** Internal routing information. Never serialize this object: it contains credentials. */
export interface RelayProxy {
  hostname: string;
  port: number;
  authorization?: string;
}

function normalizeHost(host: string): string {
  const normalized = host.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
  return isIP(normalized) === 6 ? new URL('http://[' + normalized + ']').hostname.slice(1, -1) : normalized;
}

function bypassProxy(url: URL, value: string): boolean {
  const host = normalizeHost(url.hostname);
  const port = url.port || (['https:', 'wss:'].includes(url.protocol) ? '443' : '80');
  return value.split(/[\s,]+/).some(entry => {
    if (entry === '*') return true;
    let pattern = entry.toLowerCase();
    let requiredPort: string | undefined;
    const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(pattern);
    if (match) { pattern = match[1]; requiredPort = match[2]; }
    if (requiredPort && requiredPort !== port) return false;
    const suffix = pattern.startsWith('.');
    pattern = normalizeHost(pattern);
    return suffix ? host === pattern.slice(1) || host.endsWith(pattern) : host === pattern;
  });
}

/** Read only the variable for the destination protocol, then ALL_PROXY as fallback. */
export function relayProxyFor(url: URL, env: NodeJS.ProcessEnv = process.env): RelayProxy | undefined {
  if (bypassProxy(url, env.NO_PROXY || env.no_proxy || '')) return undefined;
  const secure = ['https:', 'wss:'].includes(url.protocol);
  const value = secure
    ? env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy
    : env.HTTP_PROXY || env.http_proxy;
  if (!value) return undefined;
  try {
    const proxy = new URL(value);
    if (proxy.protocol !== 'http:') throw new Error();
    if (!proxy.hostname || proxy.pathname !== '/' || proxy.search || proxy.hash) throw new Error();
    const credentials = proxy.username || proxy.password
      ? Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64')
      : undefined;
    const route: RelayProxy = { hostname: normalizeHost(proxy.hostname), port: Number(proxy.port || 80) };
    // Keep even encoded credentials out of incidental JSON/log projections.
    if (credentials) Object.defineProperty(route, 'authorization', { value: 'Basic ' + credentials });
    return route;
  } catch {
    // URL parsing exceptions include the input. Never retain them as message or cause.
    throw new Error('RELAY_PROXY_UNSUPPORTED');
  }
}

export function relayProxyLabel(proxy: RelayProxy): string {
  return (isIP(proxy.hostname) === 6 ? '[' + proxy.hostname + ']' : proxy.hostname) + ':' + proxy.port;
}

/** CONNECT uses the relay hostname; only the explicitly configured proxy is resolved locally. */
export function connectRelayProxy(proxy: RelayProxy, target: URL, timeoutMs: number,
  signal?: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const secure = ['https:', 'wss:'].includes(target.protocol);
    const hostname = normalizeHost(target.hostname);
    const authority = (isIP(hostname) === 6 ? '[' + hostname + ']' : hostname) + ':' +
      (target.port || (secure ? '443' : '80'));
    let tunnel: Socket | undefined;
    let settled = false;
    let stage: RelayProxyStage = 'proxy_connect';
    const request = http.request({ hostname: proxy.hostname, port: proxy.port, method: 'CONNECT',
      path: authority, agent: false,
      headers: { Host: authority, ...(proxy.authorization ? { 'Proxy-Authorization': proxy.authorization } : {}) } });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      request.destroy();
      tunnel?.destroy();
      reject(error);
    };
    const abort = () => fail(Object.assign(new Error('ABORT'), { name: 'AbortError' }));
    const timer = setTimeout(() => fail(new RelayTimeoutError(stage)), timeoutMs);
    request.once('socket', socket => { socket.once('connect', () => { stage = 'connect_response'; }); });
    request.on('error', error => fail(relayProxyError('RELAY_PROXY_UNAVAILABLE', stage, error)));
    request.once('connect', (response, socket, head) => {
      tunnel = socket;
      if (settled) { socket.destroy(); return; }
      if (response.statusCode !== 200) {
        fail(relayProxyError(response.statusCode === 407 ? 'RELAY_PROXY_AUTH_FAILED' : 'RELAY_PROXY_REFUSED',
          'connect_response', response.statusCode));
        return;
      }
      if (head.length) socket.unshift(head);
      if (!secure) { settled = true; cleanup(); resolve(socket); return; }
      // Default CA verification stays enabled. Never use the proxy host as TLS identity.
      stage = 'tls';
      const tlsSocket = tls.connect({ socket, servername: isIP(hostname) ? undefined : hostname,
        checkServerIdentity: (_name, cert) => tls.checkServerIdentity(hostname, cert) });
      tunnel = tlsSocket;
      tlsSocket.once('error', error => fail(relayProxyError('RELAY_PROXY_TLS_FAILED', 'tls', error)));
      tlsSocket.once('secureConnect', () => { settled = true; cleanup(); resolve(tlsSocket); });
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else request.end();
  });
}
