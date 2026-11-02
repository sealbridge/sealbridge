// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ websocket: undefined as EventEmitter | undefined,
  http: undefined as ((request: unknown, response: unknown) => Promise<void>) | undefined }));
vi.mock('node:http', async original => {
  const { EventEmitter } = await import('node:events');
  return { ...await original<typeof import('node:http')>(), createServer: (handler: typeof state.http) => {
    state.http = handler;
    return Object.assign(new EventEmitter(), {
    listen(_port: number, _host: string, ready: () => void) { ready(); },
    address() { return { address: '127.0.0.1', port: 8787 }; },
    closeAllConnections() {}, close(done: () => void) { done(); },
    });
  } };
});
vi.mock('ws', async original => {
  const { EventEmitter } = await import('node:events');
  return { ...await original<typeof import('ws')>(), WebSocketServer: class extends EventEmitter {
    clients = new Set();
    constructor() { super(); state.websocket = this; }
    close(done: () => void) { done(); }
  } };
});
import { startLocalRelay } from '../packages/relay/src/index.js';
import { envelope } from './relay-test-fixtures.js';

afterEach(() => vi.restoreAllMocks());

it('returns a temporary admission frame from the WebSocket handler without opening a listener', async () => {
  const server = await startLocalRelay({ relayOptions: { maxQueueSize: 1 } });
  const send = vi.fn();
  const socket = Object.assign(new EventEmitter(), { send });
  try {
    state.websocket!.emit('connection', socket);
    socket.emit('message', Buffer.from(JSON.stringify({ method: 'send', envelope: envelope() })));
    expect(JSON.parse(send.mock.calls[0]![0])).toEqual({ ok: true });
    socket.emit('message', Buffer.from(JSON.stringify({ method: 'send', envelope: envelope() })));
    expect(JSON.parse(send.mock.calls[1]![0])).toEqual({ ok: false, error: 'RELAY_RETRY_LATER',
      retryable: true, retryAfterMs: 60_000 });
    expect(server.relay.snapshot().queues[0]![1]).toHaveLength(1);
  } finally { socket.emit('close'); await server.close(); }
});

it('honors a configured local HTTP envelope cap above the default without opening a listener', async () => {
  const e = envelope({ input: 'x'.repeat(270_000) }), raw = JSON.stringify(e);
  const bytes = Buffer.byteLength(raw);
  expect(bytes).toBeGreaterThan(262_144);
  const server = await startLocalRelay({ relayOptions: { maxEnvelopeBytes: bytes } });
  const request = (body: string) => Object.assign(Readable.from([Buffer.from(body)]), {
    headers: {}, method: 'POST', url: '/envelopes',
  });
  const response = () => Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, headersSent: false,
    writeHead: vi.fn(), end: vi.fn(), write: vi.fn(() => true),
  });
  try {
    const accepted = response();
    await state.http!(request(raw), accepted);
    expect(accepted.writeHead.mock.calls[0]![0]).toBe(202);
    const rejected = response();
    await state.http!(request(raw + ' '), rejected);
    expect(rejected.writeHead.mock.calls[0]![0]).toBe(400);
    expect(JSON.parse(rejected.end.mock.calls[0]![0])).toEqual({ error: 'BODY_TOO_LARGE' });
  } finally { await server.close(); }
});
