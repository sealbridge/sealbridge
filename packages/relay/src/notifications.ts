// SPDX-License-Identifier: Apache-2.0
import { verifySigned } from '@acp/core/edge';
import type { Signed } from '@acp/core/edge';

/** Wake messages deliberately carry no envelope, sender, or task content. */
export interface RelayWake {
  recipientDid: string;
  taskId: string;
  relay: string;
}
export type SignedRelayWake = Signed<RelayWake>;
export interface RelayDeliveryStatus {
  type: 'RelayDeliveryStatus';
  state: 'pending' | 'expired' | 'unknown';
  envelopeId: string;
  senderDid: string;
  recipientDid: string;
  relay: string;
  taskId?: string;
  expiresAt?: number;
}
export type SignedRelayDeliveryStatus = Signed<RelayDeliveryStatus>;
export interface RelayWakeOptions {
  /** Operator-owned channels. Recipients may select a name, never supply an endpoint. */
  channels: Record<string, (wake: SignedRelayWake, signal: AbortSignal) => Promise<void>>;
  relay: string;
  maxAttempts?: number;
  retryBaseMs?: number;
  timeoutMs?: number;
}
/** Transient attempt handle. Only routing metadata is passed to the configured channel. */
export interface RelayWakeAttempt {
  id: string;
  attempt: number;
  notice: SignedRelayWake;
  deliver: (wake: SignedRelayWake, signal: AbortSignal) => Promise<void>;
  timeoutMs: number;
}
export type RelayOperation =
  | { kind: 'registration'; recipientDid: string; channel: string; expiresAt: number }
  | {
      kind: 'wake';
      recipientDid: string;
      taskId: string;
      channel: string;
      expiresAt: number;
      attempts: number;
      nextAttempt: number;
      done: boolean;
    }
  | { kind: 'expiry'; notice: SignedRelayDeliveryStatus; expiresAt: number };

/** Pin the relay identity obtained from the operator; reject stale or extra-content wakes. */
export function verifyRelayWake(
  wake: SignedRelayWake,
  relayDid: string,
  relay: string,
  now = Date.now(),
): boolean {
  try {
    return (
      Object.keys(wake.payload).sort().join() === 'recipientDid,relay,taskId' &&
      typeof wake.payload.recipientDid === 'string' &&
      typeof wake.payload.taskId === 'string' &&
      wake.payload.relay === relay &&
      Math.abs(now - Date.parse(wake.signature.signedAt)) <= 300_000 &&
      verifySigned(wake, relayDid)
    );
  } catch {
    return false;
  }
}
export class RelayEnvelopeExpiredError extends Error {
  readonly code = 'RELAY_ENVELOPE_EXPIRED';
  constructor(readonly notice: SignedRelayDeliveryStatus) {
    super('RELAY_ENVELOPE_EXPIRED');
  }
}

/** Fixed operator endpoint; HTTP clients can only select the channel name. */
export function relayWakeFromEnv(env?: Record<string, unknown>): RelayWakeOptions | undefined {
  if (!env?.ACP_WAKE_ENDPOINT) return undefined;
  if (typeof env.ACP_WAKE_ENDPOINT !== 'string' || typeof env.ACP_WAKE_RELAY !== 'string')
    throw new Error('INVALID_REQUEST');
  const endpoint = new URL(env.ACP_WAKE_ENDPOINT);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('INVALID_REQUEST');
  const count = (name: string): number | undefined => {
    const value = env[name];
    if (value === undefined) return;
    const parsed = typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('INVALID_RELAY_LIMIT');
    return parsed;
  };
  return {
    relay: env.ACP_WAKE_RELAY,
    maxAttempts: count('ACP_WAKE_MAX_ATTEMPTS'),
    retryBaseMs: count('ACP_WAKE_RETRY_BASE_MS'),
    timeoutMs: count('ACP_WAKE_TIMEOUT_MS'),
    channels: {
      default: async (wake, signal) => {
        const response = await fetch(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(wake),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error('RELAY_WAKE_FAILED');
      },
    },
  };
}
