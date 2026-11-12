// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { HttpRelayClient, SseRelayClient, WebSocketRelayClient, createPinnedRelayFetch,
  resolveAndValidateRelayEndpoint, relayProxyFor, relayProxyLabel, relayDiagnostic } from '../packages/relay/src/index.js';
import { generateKeyPair, signEnvelope } from '../packages/core/src/index.js';
import { diagnose } from '../cli/src/doctor.js';
import { formatCliError } from '../cli/src/error-messages.js';

vi.mock('node:dns/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});

const variables = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
const ca = readFileSync(new URL('./fixtures/relay-proxy/ca.pem', import.meta.url));
const key = readFileSync(new URL('./fixtures/relay-proxy/relay-key.pem', import.meta.url));
const cert = readFileSync(new URL('./fixtures/relay-proxy/relay.pem', import.meta.url));
const sender = generateKeyPair(), recipient = generateKeyPair();
const envelope = signEnvelope({ taskId: 'proxy-test', recipientDid: recipient.did, seq: 0,
  eventType: 'PROPOSE', payload: { hello: 'proxy' } }, sender);
const syntheticLookup = vi.fn(async () => [{ address: '198.18.202.102', family: 4 as const }]);
const cleanups: Array<() => Promise<unknown> | void> = [];
const actualConnect = tls.connect;
beforeEach(() => {
  for (const name of variables) vi.stubEnv(name, '');
  syntheticLookup.mockClear();
  // Supply only our test CA; verification and hostname checks remain enabled.
  vi.spyOn(tls, 'connect').mockImplementation(((options: tls.ConnectionOptions) =>
    actualConnect({ ...options, ca })) as typeof tls.connect);
});
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function listen(server: http.Server | https.Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const sockets = new Set<net.Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return (server.address() as net.AddressInfo).port;
}

async function fixture(auth = false, status = 200, secure = true) {
  const requests: Array<{ method?: string; path?: string; proxyAuth?: string }> = [];
  let posted: unknown;
  const handler: http.RequestListener = (req, res) => {
    requests.push({ method: req.method, path: req.url, proxyAuth: req.headers['proxy-authorization'] });
    if (req.url?.startsWith('/stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      const timer = setTimeout(() => res.write('data: ' + JSON.stringify(envelope) + '\n\n'), 1200);
      req.on('close', () => clearTimeout(timer));
    } else if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => { posted = JSON.parse(body); res.end('{}'); });
    } else if (req.url?.startsWith('/envelopes')) res.end(JSON.stringify({ envelopes: [envelope] }));
    else res.end('[]');
  };
  const server = secure ? https.createServer({ key, cert }, handler) : http.createServer(handler);
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', socket => socket.on('message', raw => {
    const value = JSON.parse(raw.toString());
    if (value.method === 'send') { posted = value.envelope; socket.send('{}'); }
    else socket.send(JSON.stringify({ envelope }));
  }));
  const port = await listen(server);
  const connects: string[] = [];
  const authorizations: Array<string | undefined> = [];
  const proxy = http.createServer();
  proxy.on('connect', (req, socket, head) => {
    connects.push(req.url!); authorizations.push(req.headers['proxy-authorization']);
    if (status !== 200) { socket.end(`HTTP/1.1 ${status} secret-pass\r\nProxy-Authenticate: test-user\r\n\r\nsecret-pass`); return; }
    if (auth && req.headers['proxy-authorization'] !== 'Basic ' + Buffer.from('test-user:secret-pass').toString('base64')) {
      socket.end('HTTP/1.1 407 Authentication Required\r\n\r\n'); return;
    }
    const upstream = net.connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  const proxyPort = await listen(proxy);
  const proxyUrl = `http://${auth ? 'test-user:secret-pass@' : ''}127.0.0.1:${proxyPort}`;
  vi.stubEnv(secure ? 'HTTPS_PROXY' : 'HTTP_PROXY', proxyUrl);
  const url = `${secure ? 'https' : 'http'}://relay.example:${port}`;
  return { url, port, proxyPort, requests, connects, authorizations, posted: () => posted };
}

describe('relay environment HTTP proxy conformance', () => {
  it.each([false, true])('tunnels send, poll, SSE and WebSocket with verified TLS (auth %s)', async auth => {
    const f = await fixture(auth);
    const security = { lookup: syntheticLookup, requestTimeoutMs: 3000, socketTimeoutMs: 2000 };
    const client = new HttpRelayClient(f.url, recipient, security);
    await client.send(envelope);
    expect(f.posted()).toEqual(envelope);
    expect(await client.pollInbox(recipient.did, { waitMs: 1 })).toEqual(envelope);
    const sse = new SseRelayClient(f.url, recipient, { ...security, requestTimeoutMs: 1000 });
    const stream = sse.stream(recipient.did);
    // A frame after the request deadline proves the SSE deadline is cleared at headers.
    expect((await stream.next()).value).toEqual(envelope);
    await stream.return(undefined);
    const ws = new WebSocketRelayClient(f.url.replace('https:', 'wss:') + '/ws', recipient, security);
    cleanups.push(() => ws.close());
    await ws.send(envelope);
    expect(await ws.receive(recipient.did)).toEqual(envelope);
    expect(syntheticLookup).not.toHaveBeenCalled();
    expect(f.connects.length).toBeGreaterThanOrEqual(4);
    expect(f.connects.every(value => value === `relay.example:${f.port}`)).toBe(true);
    expect(f.requests.every(value => value.proxyAuth === undefined)).toBe(true);
    expect(f.authorizations.every(value => auth ? value?.startsWith('Basic ') : value === undefined)).toBe(true);
  });

  it('retains TLS trust and hostname verification', async () => {
    const f = await fixture();
    vi.mocked(tls.connect).mockImplementation(((options: tls.ConnectionOptions) => actualConnect(options)) as typeof tls.connect);
    await expect(new HttpRelayClient(f.url).discover()).rejects.toThrow('RELAY_PROXY_TLS_FAILED');
    vi.mocked(tls.connect).mockImplementation(((options: tls.ConnectionOptions) => actualConnect({ ...options, ca })) as typeof tls.connect);
    await expect(new HttpRelayClient(f.url.replace('relay.example', 'wrong.example')).discover()).rejects.toThrow('RELAY_PROXY_TLS_FAILED');
  });

  it('also tunnels HTTP and WS through HTTP_PROXY without local destination DNS', async () => {
    const f = await fixture(true, 200, false);
    const client = new HttpRelayClient(f.url, recipient, { lookup: syntheticLookup });
    await client.send(envelope);
    expect(await client.pollInbox(recipient.did)).toEqual(envelope);
    const ws = new WebSocketRelayClient(f.url.replace('http:', 'ws:') + '/ws', recipient, { lookup: syntheticLookup });
    cleanups.push(() => ws.close());
    await ws.send(envelope);
    expect(await ws.receive(recipient.did)).toEqual(envelope);
    expect(syntheticLookup).not.toHaveBeenCalled();
    expect(f.connects).toHaveLength(3);
  });

  it('does not resolve synthetic destination DNS through proxy; direct and NO_PROXY still reject it', async () => {
    const f = await fixture();
    await expect(new HttpRelayClient(f.url, { lookup: syntheticLookup }).discover()).resolves.toEqual([]);
    expect(syntheticLookup).not.toHaveBeenCalled();
    vi.stubEnv('NO_PROXY', 'relay.example');
    await expect(resolveAndValidateRelayEndpoint(f.url, { lookup: syntheticLookup })).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
    vi.stubEnv('NO_PROXY', ''); vi.stubEnv('HTTPS_PROXY', '');
    await expect(resolveAndValidateRelayEndpoint(f.url, { lookup: syntheticLookup })).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
  });

  it('NO_PROXY connects directly using the validated address', async () => {
    const f = await fixture();
    vi.stubEnv('NO_PROXY', `.example:${f.port}`);
    // Direct TLS uses the same test CA without changing production trust.
    const createConnection = https.Agent.prototype.createConnection;
    vi.spyOn(https.Agent.prototype, 'createConnection').mockImplementation(function(this: https.Agent, options, callback) {
      return createConnection.call(this, { ...options, ca }, callback);
    });
    await expect(new HttpRelayClient(f.url, { allowPrivateRelay: true,
      lookup: async () => [{ address: '127.0.0.1', family: 4 }] }).discover()).resolves.toEqual([]);
    expect(f.connects).toEqual([]);
  });

  it.each([403, 407])('reports safe fixed diagnostics for CONNECT %s across all transports', async status => {
    const logs: unknown[][] = [];
    for (const method of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, method).mockImplementation((...values) => { logs.push(values); });
    const f = await fixture(true, status);
    const expected = status === 407 ? 'RELAY_PROXY_AUTH_FAILED' : 'RELAY_PROXY_REFUSED';
    const clients = [new HttpRelayClient(f.url), new SseRelayClient(f.url, recipient),
      new WebSocketRelayClient(f.url.replace('https:', 'wss:') + '/ws')];
    for (const client of clients) {
      const action = client instanceof WebSocketRelayClient ? client.ready() : client instanceof SseRelayClient
        ? client.stream(recipient.did).next() : client.discover();
      const error = await action.catch(error => error);
      expect(error).toBeInstanceOf(Error); expect(error.message).toBe(expected);
      const output = [String(error), JSON.stringify(error), formatCliError(error), relayDiagnostic(error).message].join('\n');
      for (const secret of ['test-user', 'secret-pass', Buffer.from('test-user:secret-pass').toString('base64')]) expect(output).not.toContain(secret);
    }
    const checks = await diagnose({ home: process.env.HOME, identityOptions: { keyStore: 'file' } });
    expect(checks.at(-1)?.ok).toBe(false);
    expect(JSON.stringify(checks)).not.toMatch(/test-user|secret-pass/);
    expect(JSON.stringify(logs)).not.toMatch(/test-user|secret-pass/);
  });

  it('doctor uses the same tunnel, with only the proxy host and port in its output', async () => {
    const f = await fixture(true);
    const checks = await diagnose({ home: process.env.HOME, identityOptions: { keyStore: 'file' } });
    expect(checks.at(-1)).toMatchObject({ ok: true, message: `Reachable; via proxy (127.0.0.1:${f.proxyPort})` });
    expect(f.connects).toContain('relay.sealbridge.dev:443');
    expect(JSON.stringify(checks)).not.toMatch(/test-user|secret-pass/);
  });

  it('doctor cannot report Reachable when the direct SSRF DNS policy blocks the relay', async () => {
    const f = await fixture();
    vi.mocked(dnsLookup).mockResolvedValue([{ address: '198.18.202.102', family: 4 }] as never);
    const options = { home: process.env.HOME, identityOptions: { keyStore: 'file' as const } };
    expect((await diagnose(options)).at(-1)?.ok).toBe(true);
    expect(dnsLookup).not.toHaveBeenCalled();
    vi.stubEnv('NO_PROXY', 'relay.sealbridge.dev');
    expect((await diagnose(options)).at(-1)).toMatchObject({ ok: false, message: 'Unreachable' });
    expect(dnsLookup).toHaveBeenCalled();
    expect(f.connects).toEqual(['relay.sealbridge.dev:443']);
  });

  it('blocks other origins and URL-policy violations before CONNECT', async () => {
    const f = await fixture();
    const fetcher = createPinnedRelayFetch(f.url);
    for (const target of [f.url.replace('relay.example', 'other.example'), f.url.replace('https:', 'http:'), 'https://relay.example:1'])
      await expect(fetcher(target)).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
    for (const target of ['https://localhost', 'https://service.local', 'https://service.internal', 'https://metadata.google.internal',
      'https://169.254.169.254', 'https://198.18.1.1', 'https://127.0.0.1'])
      await expect(resolveAndValidateRelayEndpoint(target)).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
    expect(f.connects).toEqual([]);
  });

  it('bounds stalled CONNECT and supports cancellation', async () => {
    const server = http.createServer();
    server.on('connect', () => {});
    const port = await listen(server);
    vi.stubEnv('HTTPS_PROXY', `http://127.0.0.1:${port}`);
    await expect(new HttpRelayClient('https://relay.example', { requestTimeoutMs: 30 }).discover()).rejects.toThrow('RELAY_REQUEST_TIMEOUT');
    await expect(createPinnedRelayFetch('https://relay.example')('https://relay.example', {
      signal: AbortSignal.timeout(30) })).rejects.toThrow('ABORT');
  });

  it('keeps the SSE idle timeout after headers and makes proxy network failures retryable', async () => {
    const f = await fixture();
    const sse = new SseRelayClient(f.url, recipient, { requestTimeoutMs: 1000, socketTimeoutMs: 50 });
    await expect(sse.stream(recipient.did).next()).rejects.toThrow(/RELAY_(?:IDLE_TIMEOUT|REQUEST_TIMEOUT|UNAVAILABLE)/);
    const { isTransientRelayError } = await import('../packages/relay/src/retry.js');
    expect(isTransientRelayError(new Error('RELAY_PROXY_UNAVAILABLE'))).toBe(true);
    expect(isTransientRelayError(new Error('RELAY_PROXY_AUTH_FAILED'))).toBe(false);
    expect(isTransientRelayError(new Error('RELAY_PROXY_REFUSED'))).toBe(false);
    expect(isTransientRelayError(new Error('RELAY_PROXY_TLS_FAILED'))).toBe(false);
  });
});

describe('proxy selection', () => {
  it('handles protocol-specific precedence, lowercase, ALL_PROXY and safe invalid URL errors', () => {
    const https = new URL('https://relay.example'), http = new URL('http://relay.example'), wss = new URL('wss://relay.example');
    expect(relayProxyLabel(relayProxyFor(https, { https_proxy: 'http://lower:3128' })!)).toBe('lower:3128');
    expect(relayProxyFor(https, { HTTPS_PROXY: 'http://upper', https_proxy: 'http://lower' })?.hostname).toBe('upper');
    expect(relayProxyFor(wss, { ALL_PROXY: 'http://fallback' })?.hostname).toBe('fallback');
    expect(relayProxyFor(https, { all_proxy: 'http://fallback' })?.hostname).toBe('fallback');
    expect(relayProxyFor(http, { http_proxy: 'http://plain', HTTPS_PROXY: 'http://secure' })?.hostname).toBe('plain');
    expect(relayProxyFor(http, { ALL_PROXY: 'http://fallback' })).toBeUndefined();
    expect(relayProxyFor(https, { HTTP_PROXY: 'http://plain' })).toBeUndefined();
    expect(relayProxyFor(https, { HTTPS_PROXY: 'http://u%40ser:p%3Ass@proxy' })?.authorization)
      .toBe('Basic ' + Buffer.from('u@ser:p:ss').toString('base64'));
    expect(JSON.stringify(relayProxyFor(https, { HTTPS_PROXY: 'http://test-user:secret-pass@proxy' })))
      .toBe('{"hostname":"proxy","port":80}');
    for (const value of ['https://test-user:secret-pass@proxy', 'socks5://test-user:secret-pass@proxy', 'bad secret-pass', 'http://test-user:%zz@proxy']) {
      expect(() => relayProxyFor(https, { HTTPS_PROXY: value })).toThrow(/^RELAY_PROXY_UNSUPPORTED$/);
    }
  });
  it.each([
    ['relay.example', 'https://relay.example', true], ['.example', 'https://relay.example', true],
    ['.example', 'https://example', true], ['.example', 'https://badexample', false],
    ['*', 'https://anything.example', true], ['relay.example:443', 'https://relay.example', true],
    ['relay.example:80', 'https://relay.example', false], ['127.0.0.1', 'http://127.0.0.1', true],
    ['::1', 'http://[::1]', true], ['[::1]:80', 'http://[::1]', true], ['[::1]:81', 'http://[::1]', false],
    ['0:0:0:0:0:0:0:1', 'http://[::1]', true],
    ['other, relay.example.', 'https://relay.example', true], ['RELAY.EXAMPLE', 'https://RELAY.EXAMPLE', true],
  ])('matches NO_PROXY %s against %s: %s', (noProxy, target, bypass) => {
    expect(relayProxyFor(new URL(target), { HTTP_PROXY: 'http://proxy', HTTPS_PROXY: 'http://proxy', no_proxy: noProxy }) === undefined).toBe(bypass);
  });
});
