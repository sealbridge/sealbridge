// SPDX-License-Identifier: Apache-2.0
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { BudgetSpec } from '@acp/core';

export interface ProxyUsageMetrics {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  toolCalls?: number;
}

/** Fields the proxy reads from a runtime `QuotaMeter`. */
export interface ProxyQuotaMeter {
  record(inputTokens?: number, outputTokens?: number, toolCalls?: number): void;
  readonly controller: AbortController;
}

export interface CredentialProxyOptions {
  apiKey: string;
  baseUrl: string;
  style: 'openai' | 'anthropic';
  signal: AbortSignal;
  fetch?: typeof fetch;
  /** When set, each proxied response is charged with `meter.record`. */
  meter?: ProxyQuotaMeter;
  /** Called once per proxied response that carries provider usage. */
  reportUsage?: (metrics: ProxyUsageMetrics) => void;
  /** Token caps checked before another upstream request is forwarded. */
  budget?: BudgetSpec;
  /**
   * Maximum upstream requests. Defaults to `budget.maxToolInvocations` when that
   * value is positive, otherwise 16.
   */
  maxRequests?: number;
}

export interface CredentialProxyHandle {
  url: string;
  token: string;
  /** Requests to a provider route authenticated with this run's token. */
  readonly authenticatedRequests: number;
  /** Provider responses whose usage was recorded for this proxy. */
  readonly responsesMetered: number;
  close: () => Promise<void>;
}

const PROVIDER_PATHS = new Set([
  '/v1/messages',
  '/v1/chat/completions',
  '/v1/responses',
  '/messages',
  '/chat/completions',
  '/responses',
]);

interface UsageSnapshot {
  seen: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

function headerText(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 1) return value[0];
  return undefined;
}

/** Compare UTF-8 bytes. Different lengths return false without calling `timingSafeEqual`. */
function tokensMatch(presented: string | undefined, expected: string): boolean {
  const left = Buffer.from(presented ?? '', 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

function authorized(request: IncomingMessage, token: string): boolean {
  const bearerOk = tokensMatch(headerText(request.headers.authorization), 'Bearer ' + token);
  const apiKeyOk = tokensMatch(headerText(request.headers['x-api-key']), token);
  return bearerOk || apiKeyOk;
}

function budgetAbort(signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  const reason = signal.reason;
  const text = typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : '';
  return text.includes('BUDGET_EXCEEDED');
}

function resolveMaxRequests(options: CredentialProxyOptions): number {
  if (options.maxRequests !== undefined) {
    if (!Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1)
      throw new Error('INVALID_MAX_REQUESTS');
    return options.maxRequests;
  }
  return Math.max(1, options.budget?.maxToolInvocations || 16);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Later cumulative fields replace earlier ones. They are not added together. */
function takeUsage(snapshot: UsageSnapshot, value: unknown): void {
  const usage = asRecord(value);
  if (!usage) return;
  const input = tokenCount(usage.prompt_tokens) ?? tokenCount(usage.input_tokens);
  const output = tokenCount(usage.completion_tokens) ?? tokenCount(usage.output_tokens);
  if (input === undefined && output === undefined) return;
  if (input !== undefined) snapshot.inputTokens = input;
  if (output !== undefined) snapshot.outputTokens = output;
  snapshot.seen = true;
}

function noteEvent(snapshot: UsageSnapshot, value: unknown): void {
  const event = asRecord(value);
  if (!event) return;
  const type = typeof event.type === 'string' ? event.type : '';
  if (type === 'message_start') {
    takeUsage(snapshot, asRecord(event.message)?.usage);
    return;
  }
  if (type === 'message_delta') {
    takeUsage(snapshot, event.usage);
    return;
  }
  if (type === 'response.completed' || type === 'response.done') {
    const nested = asRecord(event.response)?.usage;
    takeUsage(snapshot, nested ?? event.usage);
    return;
  }
  takeUsage(snapshot, event.usage);
}

function usageFromJson(text: string): UsageSnapshot {
  const snapshot: UsageSnapshot = { seen: false };
  try {
    const body = asRecord(JSON.parse(text) as unknown);
    if (!body) return snapshot;
    takeUsage(snapshot, body.usage);
    if (!snapshot.seen) takeUsage(snapshot, asRecord(body.response)?.usage);
  } catch {
    return { seen: false };
  }
  return snapshot;
}

/** Reassembles `data:` lines that arrive split across chunks and ignores `[DONE]`. */
class SseUsageParser {
  #pending = '';
  #decoder = new TextDecoder();
  #snapshot: UsageSnapshot = { seen: false };

  push(chunk: Uint8Array): void {
    this.#pending += this.#decoder.decode(chunk, { stream: true });
    this.#drain(false);
  }

  finish(): UsageSnapshot {
    this.#pending += this.#decoder.decode();
    this.#drain(true);
    return this.#snapshot;
  }

  #drain(flush: boolean): void {
    while (true) {
      const newline = this.#pending.indexOf('\n');
      if (newline < 0) break;
      const line = this.#pending.slice(0, newline);
      this.#pending = this.#pending.slice(newline + 1);
      this.#consume(line);
    }
    if (flush && this.#pending.length > 0) this.#consume(this.#pending);
    if (flush) this.#pending = '';
  }

  #consume(line: string): void {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1).trim() : line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice('data:'.length).trim();
    if (!data || data === '[DONE]') return;
    try {
      noteEvent(this.#snapshot, JSON.parse(data) as unknown);
    } catch {
      // Malformed events are forwarded unchanged and do not contribute usage.
    }
  }
}

function emptyUsage(): UsageSnapshot {
  return { seen: false };
}

interface UpstreamRead {
  snapshot: UsageSnapshot;
  /** Set when the copy stopped before a clean EOF. Usage already parsed is still returned. */
  error?: unknown;
}

/**
 * Copy the provider body to the client and collect usage.
 * `reader.read()` and `response.write()` can fail after valid SSE or JSON
 * usage has already been forwarded. That failure must not drop the snapshot:
 * the caller accounts it once, then surfaces the stream error.
 */
async function readUpstream(result: Response, response: ServerResponse): Promise<UpstreamRead> {
  const reader = result.body?.getReader();
  if (!reader) return { snapshot: emptyUsage() };
  const contentType = (result.headers.get('content-type') ?? '').toLowerCase();
  const sse = contentType.includes('text/event-stream');
  const parser = sse ? new SseUsageParser() : undefined;
  const jsonChunks: Buffer[] = [];
  let error: unknown;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      const bytes = Buffer.from(value);
      if (parser) parser.push(bytes);
      else jsonChunks.push(bytes);
      if (response.destroyed || response.writableEnded) {
        error = new Error('DOWNSTREAM_WRITE_FAILED');
        break;
      }
      try {
        response.write(bytes);
      } catch (caught) {
        error = caught;
        break;
      }
    }
  } catch (caught) {
    error = caught;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  let snapshot = emptyUsage();
  try {
    snapshot = parser
      ? parser.finish()
      : usageFromJson(Buffer.concat(jsonChunks).toString('utf8'));
  } catch (caught) {
    error ??= caught;
  }
  return error === undefined ? { snapshot } : { snapshot, error };
}

function deny(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  error?: string,
): void {
  request.resume();
  if (!error) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error }));
}

/** Task-scoped loopback broker. Only the host fetch sees the real provider key. */
export async function startCredentialProxy(
  options: CredentialProxyOptions,
): Promise<CredentialProxyHandle> {
  const token = randomBytes(32).toString('base64url');
  const upstream = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(upstream.protocol)) throw new Error('INVALID_PROVIDER_URL');
  const maxRequests = resolveMaxRequests(options);
  let forwarded = 0;
  let authenticatedRequests = 0;
  let responsesMetered = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let halted = false;

  const rejection = (): 'BUDGET_EXCEEDED' | 'RATE_LIMITED' | undefined => {
    const overBudget =
      halted ||
      options.meter?.controller.signal.aborted === true ||
      budgetAbort(options.signal) ||
      (options.budget !== undefined &&
        (inputTokens > options.budget.maxInputTokens ||
          outputTokens > options.budget.maxOutputTokens));
    if (overBudget) return 'BUDGET_EXCEEDED';
    if (forwarded >= maxRequests) return 'RATE_LIMITED';
    return undefined;
  };

  const account = (snapshot: UsageSnapshot): void => {
    if (!snapshot.seen) return;
    responsesMetered += 1;
    const deltaIn = snapshot.inputTokens ?? 0;
    const deltaOut = snapshot.outputTokens ?? 0;
    inputTokens += deltaIn;
    outputTokens += deltaOut;
    const metrics: ProxyUsageMetrics = {
      inputTokens: deltaIn,
      outputTokens: deltaOut,
      totalTokens: deltaIn + deltaOut,
    };
    try {
      options.meter?.record(deltaIn, deltaOut);
    } catch {
      halted = true;
    }
    try {
      options.reportUsage?.(metrics);
    } catch {
      halted = true;
    }
    if (
      options.budget &&
      (inputTokens > options.budget.maxInputTokens || outputTokens > options.budget.maxOutputTokens)
    )
      halted = true;
  };

  const server = createServer(async (request, response) => {
    try {
      if (!authorized(request, token)) {
        deny(request, response, 401);
        return;
      }
      const path = new URL(request.url ?? '/', 'http://localhost');
      if (request.method !== 'POST' || !PROVIDER_PATHS.has(path.pathname)) {
        deny(request, response, 403);
        return;
      }
      authenticatedRequests += 1;
      const blocked = rejection();
      if (blocked) {
        deny(request, response, 429, blocked);
        return;
      }
      forwarded += 1;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > 4194304) throw new Error('PROVIDER_REQUEST_LIMIT');
        chunks.push(chunk as Buffer);
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (options.style === 'anthropic') {
        headers['x-api-key'] = options.apiKey;
        headers['anthropic-version'] = String(request.headers['anthropic-version'] ?? '2023-06-01');
        if (request.headers['anthropic-beta'])
          headers['anthropic-beta'] = String(request.headers['anthropic-beta']);
      } else headers.authorization = 'Bearer ' + options.apiKey;
      const target = new URL(upstream);
      target.pathname = upstream.pathname.replace(/\/$/, '') + path.pathname.replace(/^\/v1/, '');
      const result = await (options.fetch ?? fetch)(target, {
        method: 'POST',
        headers,
        body: Buffer.concat(chunks),
        signal: options.signal,
        redirect: 'error',
      });
      // Provider error bodies can contain account details; keep those in the host.
      if (!result.ok) {
        response.writeHead(result.status).end(JSON.stringify({ error: 'PROVIDER_REQUEST_FAILED' }));
        await result.body?.cancel();
        return;
      }
      response.writeHead(result.status, {
        'content-type': result.headers.get('content-type') ?? 'application/json',
      });
      const upstreamBody = await readUpstream(result, response);
      account(upstreamBody.snapshot);
      if (upstreamBody.error) throw upstreamBody.error;
      if (!response.writableEnded) response.end();
    } catch {
      try {
        if (!response.headersSent) response.writeHead(502);
        if (!response.writableEnded)
          response.end(JSON.stringify({ error: 'PROVIDER_REQUEST_FAILED' }));
      } catch {
        // The client socket can already be gone when the upstream stream fails.
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('CREDENTIAL_PROXY_BIND_FAILED');
  return {
    url: 'http://127.0.0.1:' + address.port,
    token,
    get authenticatedRequests() {
      return authenticatedRequests;
    },
    get responsesMetered() {
      return responsesMetered;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
