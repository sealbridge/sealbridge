import { expect, it, vi } from 'vitest';
import https from 'node:https';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { createRelayFetchHandler } from '../packages/relay/src/index.js';
import type { RelayTransport } from '../packages/relay/src/index.js';
import { OpenAICompatibleAdapter } from '../packages/adapters/dist/index.js';
import { WorkerNode, RequesterClient } from '../packages/runtime/dist/index.js';
import { networkCommand } from '../cli/src/network.js';
import { diagnose } from '../cli/src/doctor.js';
import { protocolTestNow } from './protocol-test-clock.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '198.18.0.1', family: 4 }]) }));

it('doctor, CLI worker start and delegate use the default TLS hostname route without network flags', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(protocolTestNow('2026-11-01T00:00:00Z'));
  const handler = createRelayFetchHandler();
  const server = https.createServer({
    key: readFileSync(new URL('./fixtures/relay-proxy/relay-key.pem', import.meta.url)),
    cert: readFileSync(new URL('./fixtures/relay-proxy/relay.pem', import.meta.url)),
  }, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const response = await handler(new Request('https://relay.sealbridge.dev' + req.url, {
      method: req.method, headers: req.headers as Record<string, string>,
      ...(body.length ? { body } : {}),
    }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const connect = tls.connect;
  const routes: tls.ConnectionOptions[] = [];
  vi.spyOn(tls, 'connect').mockImplementation(((options: tls.ConnectionOptions) => {
    routes.push(options);
    // Test-only egress proxy: preserve TLS verification and hostname/SNI while
    // forwarding the socket to the local relay fixture.
    return connect({ ...options, port, ca: readFileSync(new URL('./fixtures/relay-proxy/ca.pem', import.meta.url)),
      lookup: (_host, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]) });
  }) as typeof tls.connect);
  vi.spyOn(OpenAICompatibleAdapter.prototype, 'executeTask').mockImplementation(async ctx => ctx.input);
  // Exercise CLI transport construction and real TLS requests independently of
  // task execution and owner approval (covered by session conformance).
  vi.spyOn(WorkerNode.prototype, 'startDelivery').mockResolvedValue();
  vi.spyOn(WorkerNode.prototype, 'start').mockImplementation(async function (this: WorkerNode) {
    await this.relay.discover!();
    return undefined;
  });
  vi.spyOn(RequesterClient.prototype, 'startDelivery').mockResolvedValue();
  vi.spyOn(RequesterClient.prototype, 'delegate').mockImplementation(async function (this: RequesterClient) {
    await (this.options.relay as RelayTransport).discover!();
    throw new Error('TEST_TASK_REACHED_RELAY');
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let worker: Promise<void> | undefined;
  try {
    expect((await diagnose()).at(-1)).toMatchObject({ ok: true, message: 'Reachable' });
    worker = networkCommand('worker', ['start', '--adapter', 'openai', '--once']);
    const workerResult = worker.then(() => undefined, error => error);
    await vi.waitFor(() => expect(log.mock.calls.some(([value]) => String(value).startsWith('acp-invite:'))).toBe(true));
    const token = log.mock.calls.find(([value]) => String(value).startsWith('acp-invite:'))![0] as string;
    await expect(networkCommand('delegate', ['--to', token, '--title', 'Echo', '--description', 'Echo JSON', '--input', '{"ok":true}', '--auto-approve'])).rejects.toThrow('TEST_TASK_REACHED_RELAY');
    expect(await workerResult).toBeUndefined();
    expect(OpenAICompatibleAdapter.prototype.executeTask).not.toHaveBeenCalled();
    expect(routes.length).toBeGreaterThan(2);
    expect(routes.every(route => route.servername === 'relay.sealbridge.dev' && typeof route.lookup === 'function' && route.rejectUnauthorized !== false)).toBe(true);
    for (const route of routes) {
      const callback = vi.fn();
      route.lookup!('relay.sealbridge.dev', { all: true }, callback);
      expect(callback).toHaveBeenCalledWith(null, [{ address: '198.18.0.1', family: 4 }]);
    }
  } finally {
    if (worker) { process.emit('SIGINT'); await worker.catch(() => {}); }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
