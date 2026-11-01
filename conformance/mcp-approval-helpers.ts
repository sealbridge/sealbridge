// SPDX-License-Identifier: Apache-2.0
import { PassThrough } from 'node:stream';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { AcpMcpServer } from '../packages/runtime/src/index.js';
import type { AcpMcpServerOptions } from '../packages/runtime/src/index.js';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
export function harness(options: AcpMcpServerOptions, framed = false) {
  const input = new PassThrough();
  Object.assign(input, { isTTY: true }); // Even a TTY remains the protocol stream.
  const output = new PassThrough();
  const messages: any[] = [];
  const waiters: Array<{ match: (value: any) => boolean; resolve: (value: any) => void }> = [];
  let buffer: Buffer = Buffer.alloc(0);
  let onMessage: ((message: JSONRPCMessage) => void) | undefined;
  output.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length) {
      let body: string;
      if (framed) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
        if (buffer.length < end + 4 + length) return;
        body = buffer.subarray(end + 4, end + 4 + length).toString();
        buffer = buffer.subarray(end + 4 + length);
      } else {
        const end = buffer.indexOf(10);
        if (end < 0) return;
        body = buffer.subarray(0, end).toString();
        buffer = buffer.subarray(end + 1);
      }
      const message = JSON.parse(body); // Every byte must be JSON-RPC framing.
      messages.push(message);
      for (const waiter of [...waiters]) if (waiter.match(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
      onMessage?.(message);
    }
  });
  const server = new AcpMcpServer(options);
  const serving = server.serve(input, output);
  // Tests may intentionally provoke a framing failure; attach a handler immediately.
  void serving.catch(() => undefined);
  const send = (value: unknown, fragment = false) => {
    const body = JSON.stringify(value);
    const frame = framed ? 'Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body : body + '\r\n';
    if (fragment) for (const byte of Buffer.from(frame)) input.write(Buffer.from([byte]));
    else input.write(frame);
  };
  const transport: Transport = {
    async start() { onMessage = (message) => transport.onmessage?.(message); },
    async send(message) { send(message); },
    async close() { input.end(); await serving; transport.onclose?.(); },
  };
  return {
    input, output, messages, send, serving, transport,
    next: (match: (value: any) => boolean) => {
      const existing = messages.find(match);
      return existing ? Promise.resolve(existing) : new Promise<any>((resolve) => waiters.push({ match, resolve }));
    },
    async close() { input.end(); await serving; output.destroy(); },
  };
}
export function initialize(h: ReturnType<typeof harness>, capabilities: unknown, version = '2025-06-18') {
  h.send({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: version, capabilities } });
  return h.next((m) => m.id === 'init');
}
export function toolCall(id: string, args: unknown, name = 'acp_delegate_task') {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}
export function form(h: ReturnType<typeof harness>, index = 0) {
  return h.next((m) => m.method === 'elicitation/create' &&
    h.messages.filter((v) => v.method === 'elicitation/create').indexOf(m) === index);
}
export function body(message: any): any { return JSON.parse(message.result.content[0].text); }
