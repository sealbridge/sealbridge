// SPDX-License-Identifier: Apache-2.0
export class RelayTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  constructor() { super('RELAY_REQUEST_TIMEOUT'); this.name = 'RelayTimeoutError'; }
}

export interface RelayAuthRecoveryOptions {
  /** Additional authenticated attempts after a 401. Zero restores fail-fast behavior. */
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
  constructor(readonly operation: RelayAuthOperation, readonly attempts: number, readonly elapsedMs: number) {
    super('RELAY_AUTH_RECOVERY_EXHAUSTED: Check that the system clock is synchronized and the key matches the registered DID.');
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
    /^(?:SSE_CLOSED|RELAY_IDLE_TIMEOUT)$/.test(e.message) ||
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
        Number.isSafeInteger(detail.elapsedMs) && detail.elapsedMs >= 0 ? detail.elapsedMs : 0);
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
