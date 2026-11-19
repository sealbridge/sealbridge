// SPDX-License-Identifier: Apache-2.0
export interface SessionTimeoutOptions {
  /** Legacy alias for taskTimeoutMs. */
  timeoutMs?: number;
  /** Local execution limit; generated proposals use this as their wall-clock budget. */
  executionTimeoutMs?: number;
  /** Overall task limit, including approval and settlement. Default 600000. */
  taskTimeoutMs?: number;
  /** Maximum time in a peer/owner approval wait phase. Default 600000. */
  waitTimeoutMs?: number;
  /** Relay connection/request limit. Default 45000. */
  connectTimeoutMs?: number;
  /** No authenticated peer activity during execution. Default 90000. */
  transportIdleTimeoutMs?: number;
  /** Worker liveness interval, independent of usage accounting. Default 15000. */
  heartbeatIntervalMs?: number;
}
const timeoutKeys = [
  'timeoutMs',
  'executionTimeoutMs',
  'taskTimeoutMs',
  'waitTimeoutMs',
  'connectTimeoutMs',
  'transportIdleTimeoutMs',
  'heartbeatIntervalMs',
] as const;

export function resolveSessionTimeouts(
  defaults: SessionTimeoutOptions,
  overrides: SessionTimeoutOptions,
): SessionTimeoutOptions {
  return Object.fromEntries(timeoutKeys.map((key) => [key, overrides[key] ?? defaults[key]]));
}

export function validateSessionTimeouts(options: SessionTimeoutOptions): void {
  for (const name of timeoutKeys) {
    const value = options[name];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647))
      throw new Error('INVALID_TIMEOUT: ' + name);
  }
  if (
    options.executionTimeoutMs !== undefined &&
    options.taskTimeoutMs !== undefined &&
    options.executionTimeoutMs > options.taskTimeoutMs
  )
    throw new Error('INCOMPATIBLE_TIMEOUTS: executionTimeoutMs exceeds taskTimeoutMs');
  if ((options.heartbeatIntervalMs ?? 15_000) >= (options.transportIdleTimeoutMs ?? 90_000))
    throw new Error(
      'INCOMPATIBLE_TIMEOUTS: heartbeatIntervalMs must be below transportIdleTimeoutMs',
    );
}

/** Phase timers never renew the absolute task deadline or the contractual quota. */
export class SessionTimeouts {
  private readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private readonly overall: ReturnType<typeof setTimeout>;
  private phase?: ReturnType<typeof setTimeout>;
  private idle?: ReturnType<typeof setTimeout>;
  constructor(
    readonly options: SessionTimeoutOptions,
    deadline: string,
    parent?: AbortSignal,
  ) {
    validateSessionTimeouts(options);
    this.signal = AbortSignal.any([this.controller.signal, ...(parent ? [parent] : [])]);
    const remaining = Math.max(1, Date.parse(deadline) - Date.now());
    this.overall = setTimeout(
      () => this.controller.abort(new Error('TASK_TIMEOUT')),
      Math.min(options.taskTimeoutMs ?? options.timeoutMs ?? 600_000, remaining),
    );
    this.overall.unref();
    this.wait();
  }
  wait(): void {
    clearTimeout(this.phase);
    clearTimeout(this.idle);
    this.phase = setTimeout(
      () => this.controller.abort(new Error('PEER_WAIT_TIMEOUT')),
      this.options.waitTimeoutMs ?? 600_000,
    );
    this.phase.unref();
  }
  running(): void {
    clearTimeout(this.phase);
    clearTimeout(this.idle);
  }
  executing(budgetMs: number): void {
    this.running();
    this.phase = setTimeout(
      () => this.controller.abort(new Error('EXECUTION_TIMEOUT')),
      Math.min(budgetMs, 2_147_483_647),
    );
    this.phase.unref();
    this.activity();
  }
  activity(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(
      () => this.controller.abort(new Error('PEER_IDLE_TIMEOUT')),
      this.options.transportIdleTimeoutMs ?? 90_000,
    );
    this.idle.unref();
  }
  close(): void {
    clearTimeout(this.overall);
    clearTimeout(this.phase);
    clearTimeout(this.idle);
  }
}
