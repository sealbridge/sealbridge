// SPDX-License-Identifier: Apache-2.0
import type { Readable, Writable } from 'node:stream';
import type { Json } from '@acp/core';

const MAX_BYTES = 1024 * 1024;
const MAX_CALLS = 32;
const aborted = () => new Error('APPROVAL_ABORTED');

/** Duplex routing keeps replies and cancellation moving while tools await the host. */
export class McpRpc {
  private framed?: boolean;
  private serial = 0;
  private closed = false;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly calls = new Map<string | number, AbortController>();
  private writes: Promise<void> = Promise.resolve();
  constructor(
    private readonly output: Writable,
    private readonly handle: (message: unknown, signal?: AbortSignal) => Promise<Json | undefined>,
  ) {}
  request(method: string, params: Json, signal: AbortSignal): Promise<unknown> {
    if (this.closed || signal.aborted) return Promise.reject(aborted());
    if (this.pending.size >= MAX_CALLS) return Promise.reject(new Error('MCP_TOO_MANY_REQUESTS'));
    const id = 'sealbridge:' + ++this.serial;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.pending.delete(id);
        signal.removeEventListener('abort', cancel);
      };
      const cancel = () => {
        cleanup();
        void this.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });
        reject(signal.reason instanceof Error ? signal.reason : aborted());
      };
      this.pending.set(id, {
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (error) => { cleanup(); reject(error); },
      });
      signal.addEventListener('abort', cancel, { once: true });
      void this.write({ jsonrpc: '2.0', id, method, params }).catch((error: Error) => {
        this.pending.get(id)?.reject(error);
      });
    });
  }
  private write(value: Json): Promise<void> {
    if (this.closed) return Promise.resolve();
    const json = JSON.stringify(value);
    const frame = this.framed
      ? 'Content-Length: ' + Buffer.byteLength(json) + '\r\n\r\n' + json
      : json + '\n';
    const write = this.writes.then(() => new Promise<void>((resolve, reject) => {
      if (this.closed) { resolve(); return; }
      this.output.write(frame, (error) => error ? reject(error) : resolve());
    }));
    this.writes = write.catch(() => undefined);
    return write;
  }
  private route(body: string): void {
    let message: Record<string, unknown>;
    try { message = JSON.parse(body) as Record<string, unknown>; }
    catch {
      void this.write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (message && message.jsonrpc === '2.0' && !Object.hasOwn(message, 'method')) {
      if (typeof message.id === 'string') {
        const pending = this.pending.get(message.id);
        if (Object.hasOwn(message, 'error')) pending?.reject(new Error('APPROVAL_REJECTED'));
        else if (Object.hasOwn(message, 'result')) pending?.resolve(message.result);
      }
      return;
    }
    if (message?.method === 'notifications/cancelled') {
      const id = (message.params as { requestId?: string | number } | undefined)?.requestId;
      if (id !== undefined) this.calls.get(id)?.abort(aborted());
      return;
    }
    const id = message?.id;
    const hasId = typeof id === 'string' || typeof id === 'number';
    if (hasId && (this.calls.size >= MAX_CALLS || this.calls.has(id))) {
      void this.write({ jsonrpc: '2.0', id, error: { code: -32000, message: 'MCP_TOO_MANY_REQUESTS' } });
      return;
    }
    if (!hasId && message?.method !== 'notifications/initialized') return;
    const controller = new AbortController();
    if (hasId) this.calls.set(id, controller);
    void this.handle(message, controller.signal).then((response) => {
      if (response !== undefined) return this.write(response);
    }).catch(() => this.close()).finally(() => { if (hasId) this.calls.delete(id); });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(aborted());
    for (const call of this.calls.values()) call.abort(aborted());
    this.calls.clear();
  }
  async serve(input: Readable): Promise<void> {
    let buffer: Buffer = Buffer.alloc(0);
    const onClose = () => { this.close(); input.destroy(); };
    this.output.once('close', onClose);
    this.output.once('error', onClose);
    try {
      for await (const chunk of input) {
        buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        while (buffer.length) {
          if (this.framed === undefined) {
            const preview = buffer.toString('utf8');
            if (preview.startsWith('Content-Length')) this.framed = true;
            else if (preview.trimStart().startsWith('{') || preview.includes('\n')) this.framed = false;
            else break;
          }
          let body: string;
          if (this.framed) {
            const end = buffer.indexOf('\r\n\r\n');
            if (end < 0) break;
            const match = /^Content-Length:\s*(\d+)\s*$/im.exec(buffer.subarray(0, end).toString('utf8'));
            if (!match) throw new Error('INVALID_FRAMING');
            const length = Number(match[1]);
            if (!Number.isSafeInteger(length) || length > MAX_BYTES) throw new Error('MCP_MESSAGE_TOO_LARGE');
            if (buffer.length < end + 4 + length) break;
            body = buffer.subarray(end + 4, end + 4 + length).toString('utf8');
            buffer = buffer.subarray(end + 4 + length);
          } else {
            const end = buffer.indexOf(10);
            if (end < 0) break;
            if (end > MAX_BYTES) throw new Error('MCP_MESSAGE_TOO_LARGE');
            body = buffer.subarray(0, end).toString('utf8').replace(/\r$/, '');
            buffer = buffer.subarray(end + 1);
          }
          if (body.trim()) this.route(body);
        }
        if (buffer.length > MAX_BYTES) throw new Error('MCP_MESSAGE_TOO_LARGE');
      }
    } catch (error) {
      if (!this.closed) throw error;
    } finally {
      this.close();
      this.output.removeListener('close', onClose);
      this.output.removeListener('error', onClose);
      await this.writes;
    }
  }
}
