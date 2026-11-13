// SPDX-License-Identifier: Apache-2.0
export class RelayTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  constructor() { super('RELAY_REQUEST_TIMEOUT'); this.name = 'RelayTimeoutError'; }
}

export interface RelayAuthRecoveryOptions {
  /** Optional additional-attempt cap after a 401. Default: use the full timeout; zero fails fast. */
  maxAuthRecoveryAttempts?: number;
  /** Monotonic elapsed time allowed after the first 401. */
  authRecoveryTimeoutMs?: number;
}

export function validateRelayAuthRecoveryOptions(options: RelayAuthRecoveryOptions): void {
  const attempts = options.maxAuthRecoveryAttempts ?? 3;
  const timeout = options.authRecoveryTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts > 2_147_483_647)
    throw new Error('INVALID_RELAY_AUTH_RETRIES');
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647)
    throw new Error('INVALID_RELAY_AUTH_RECOVERY_TIMEOUT_MS');
}

export type RelayAuthOperation = 'receive' | 'stream' | 'peek' | 'delivery-status' | 'wake' | 'acknowledge';

/** Status-only diagnostics: never retain the response body or credentials. */
export class RelayHttpError extends Error {
  readonly code = 'RELAY_REJECTED';
  constructor(readonly status: number, readonly operation: RelayAuthOperation) {
    super('RELAY_REJECTED: ' + status);
  }
}

export class RelayAuthRecoveryExhaustedError extends Error {
  readonly code = 'RELAY_AUTH_RECOVERY_EXHAUSTED';
  readonly status = 401;
  constructor(readonly operation: RelayAuthOperation, readonly attempts: number, readonly elapsedMs: number, readonly clockOffsetMs?: number) {
    const clock = clockOffsetMs === undefined ? 'Relay Date unavailable; system clock difference unknown.'
      : Math.abs(clockOffsetMs) <= 5000 ? 'System clock matches relay Date (within 5 seconds); clock skew is not indicated.'
      : 'System clock is approximately ' + Math.round(Math.abs(clockOffsetMs) / 1000) +
        ' seconds ' + (clockOffsetMs > 0 ? 'behind' : 'ahead of') + ' relay Date.';
    super('RELAY_AUTH_RECOVERY_EXHAUSTED: ' + clock + ' Authentication may also fail due to nonce replay or key/DID mismatch.');
  }
}

export function isTransientRelayError(error: unknown): boolean {
  const causes: Error[] = [];
  for (let current = error; current instanceof Error && !causes.includes(current) && causes.length < 16;
    current = current.cause) causes.push(current);
  if (causes.some(e => /^(?:RELAY_(?:REGISTRATION_)?REJECTED:\s*(?:401|403)\b|RELAY_AUTH_RECOVERY_EXHAUSTED\b|RELAY_TAMPERING_DETECTED)/.test(e.message))) return false;
  return causes.some(e => e.name === 'TimeoutError' ||
    ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH']
      .includes((e as NodeJS.ErrnoException).code ?? '') ||
    /^(?:SSE_CLOSED|RELAY_IDLE_TIMEOUT|RELAY_PROXY_UNAVAILABLE)$/.test(e.message) ||
    (e instanceof TypeError && /^(?:fetch failed|terminated)$/.test(e.message)) ||
    /^socket hang up$/i.test(e.message) ||
    /^RELAY_(?:REGISTRATION_)?REJECTED:\s*(429|502|503|504)\b/.test(e.message));
}

export type RelayConnectionStatus = 'connected' | 'reconnecting' | 'unavailable' | 'stopped';

/** Never include an HTTP response body or arbitrary transport text in diagnostics. */
export function relayDiagnostic(error: unknown): Error {
  const seen = new Set<Error>();
  for (let current = error; current instanceof Error && !seen.has(current) && seen.size < 16; current = current.cause) {
    seen.add(current);
    if ('code' in current && current.code === 'RELAY_AUTH_RECOVERY_EXHAUSTED') {
      const detail = current as RelayAuthRecoveryExhaustedError;
      const operation = ['receive', 'stream', 'peek', 'delivery-status', 'wake', 'acknowledge'].includes(detail.operation)
        ? detail.operation : 'receive';
      return new RelayAuthRecoveryExhaustedError(operation,
        Number.isSafeInteger(detail.attempts) && detail.attempts >= 0 ? detail.attempts : 0,
        Number.isSafeInteger(detail.elapsedMs) && detail.elapsedMs >= 0 ? detail.elapsedMs : 0,
        Number.isSafeInteger(detail.clockOffsetMs) ? detail.clockOffsetMs : undefined);
    }
  }
  const message = error instanceof Error ? error.message : '';
  const status = /^RELAY_(?:REGISTRATION_)?REJECTED:\s*(\d{3})\b/.exec(message)?.[1];
  const code = /^(?:RELAY_[A-Z_]+|SSE_[A-Z_]+|SSRF_BLOCKED_RELAY_URL)$/.test(message)
    ? message : 'RELAY_UNAVAILABLE';
  return Object.assign(new Error(status ? 'RELAY_REJECTED: ' + status : code),
    { code: 'RELAY_TERMINAL', ...(status ? { status: Number(status) } : {}) });
}

export function relayRetryDelay(attempt: number): number {
  return Math.round(Math.min(30_000, 250 * 2 ** Math.min(attempt, 7)) * (0.5 + Math.random() * 0.5));
}

export function waitForRelayRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('SESSION_ABORTED')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Bound even injected transports/resolvers that do not honor cancellation. */
export async function relayDeadline<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RelayTimeoutError()), ms);
      abort = () => reject(signal?.reason ?? new Error('SESSION_ABORTED'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    })]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

/** Return only recognized codes, never arbitrary transport messages or proxy URLs. */
export function relayRetryCode(error: unknown): string {
  const seen = new Set<Error>();
  for (let current = error; current instanceof Error && !seen.has(current) && seen.size < 16; current = current.cause) {
    seen.add(current);
    if (current instanceof RelayHttpError) return 'HTTP_' + current.status;
    const status = /^RELAY_(?:REGISTRATION_)?REJECTED:\s*(\d{3})\b/.exec(current.message)?.[1];
    if (status) return 'HTTP_' + status;
    const code = (current as NodeJS.ErrnoException).code;
    if (code && /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID)$/.test(code)) return code;
    if (/^(?:RELAY_PROXY_(?:AUTH_FAILED|REFUSED|TLS_FAILED|UNAVAILABLE|UNSUPPORTED)|SSE_CLOSED|RELAY_IDLE_TIMEOUT|RELAY_AUTH_RECOVERY_EXHAUSTED)$/.test(current.message)) return current.message;
  }
  return 'RELAY_UNAVAILABLE';
}
