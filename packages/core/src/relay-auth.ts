// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { signPayload, verifySigned } from './crypto.js';
import type { KeyPair, Signed } from './types.js';

export type RelayAuthAction = 'receive' | 'stream' | 'subscribe' | 'invite-manage';
export interface RelayAuthPayload {
  type: 'RelayAuth';
  recipientDid: string;
  action: RelayAuthAction;
  timestamp: string;
  nonce: string;
  /** Canonical destination origin. `ws:`/`wss:` are stored as `http:`/`https:`. */
  origin?: string;
}
export interface CreateRelayAuthOptions {
  action?: RelayAuthAction;
  now?: string;
  nonce?: string;
  /** Destination relay URL or origin. Normalized before it is signed. */
  origin?: string;
  /** Alias of `origin` for callers that have a relay URL. */
  relayUrl?: string;
}
export interface VerifyRelayAuthOptions {
  now?: number;
  maxSkewMs?: number;
  expectedOrigin?: string;
  requireOrigin?: boolean;
}
export interface RelayAuthVerification {
  valid: boolean;
  nonce?: string;
  action?: RelayAuthAction;
  error?: string;
  reason?: string;
}
const RELAY_AUTH_ACTIONS = new Set<RelayAuthAction>(['receive', 'stream', 'subscribe', 'invite-manage']);

/**
 * Canonical origin for HTTP, SSE, and WebSocket on the same host:port.
 * `ws:` becomes `http:` and `wss:` becomes `https:` before `origin` is taken.
 */
export function normalizeRelayOrigin(urlOrOrigin: string): string {
  if (typeof urlOrOrigin !== 'string' || !urlOrOrigin.trim())
    throw new Error('INVALID_RELAY_ORIGIN');
  let url: URL;
  try {
    url = new URL(urlOrOrigin.trim());
  } catch {
    throw new Error('INVALID_RELAY_ORIGIN');
  }
  if (url.protocol === 'ws:') url.protocol = 'http:';
  else if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('INVALID_RELAY_ORIGIN');
  if (!url.host || url.origin === 'null') throw new Error('INVALID_RELAY_ORIGIN');
  return url.origin.toLowerCase();
}

export function createRelayAuthToken(
  recipient: KeyPair,
  options: CreateRelayAuthOptions = {},
): string {
  const rawOrigin = options.origin ?? options.relayUrl;
  const payload: RelayAuthPayload = {
    type: 'RelayAuth',
    recipientDid: recipient.did,
    action: options.action ?? 'receive',
    timestamp: options.now ?? new Date().toISOString(),
    nonce: options.nonce ?? randomUUID({ disableEntropyCache: true }),
    ...(rawOrigin !== undefined ? { origin: normalizeRelayOrigin(rawOrigin) } : {}),
  };
  return Buffer.from(JSON.stringify(signPayload(payload, recipient))).toString('base64url');
}

function originFailure(
  code: 'RELAY_AUTH_ORIGIN_MISMATCH' | 'RELAY_AUTH_ORIGIN_REQUIRED',
): RelayAuthVerification {
  return { valid: false, error: code, reason: code };
}

function checkRelayAuthOrigin(
  origin: RelayAuthPayload['origin'],
  options: VerifyRelayAuthOptions,
): RelayAuthVerification | undefined {
  const hasOrigin = typeof origin === 'string' && origin.trim().length > 0;
  if (origin !== undefined && !hasOrigin) {
    if (options.expectedOrigin !== undefined) return originFailure('RELAY_AUTH_ORIGIN_MISMATCH');
    if (options.requireOrigin) return originFailure('RELAY_AUTH_ORIGIN_REQUIRED');
    return { valid: false, error: 'RELAY_UNAUTHORIZED' };
  }
  if (!hasOrigin) {
    if (options.requireOrigin) return originFailure('RELAY_AUTH_ORIGIN_REQUIRED');
    return undefined;
  }
  let canonical: string;
  try {
    canonical = normalizeRelayOrigin(origin);
  } catch {
    if (options.expectedOrigin !== undefined) return originFailure('RELAY_AUTH_ORIGIN_MISMATCH');
    return { valid: false, error: 'RELAY_UNAUTHORIZED' };
  }
  if (options.expectedOrigin === undefined) return undefined;
  try {
    if (canonical !== normalizeRelayOrigin(options.expectedOrigin))
      return originFailure('RELAY_AUTH_ORIGIN_MISMATCH');
  } catch {
    return originFailure('RELAY_AUTH_ORIGIN_MISMATCH');
  }
  return undefined;
}

export function verifyRelayAuthToken(
  token: string,
  expectedRecipientDid: string,
  options: VerifyRelayAuthOptions = {},
): RelayAuthVerification {
  try {
    if (typeof token !== 'string' || token.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(token))
      throw new Error();
    const signed = JSON.parse(
        Buffer.from(token, 'base64url').toString('utf8'),
      ) as Signed<RelayAuthPayload>,
      p = signed.payload;
    const now = options.now ?? Date.now(),
      skew = options.maxSkewMs ?? 300000;
    if (
      !verifySigned(signed, expectedRecipientDid) ||
      p.type !== 'RelayAuth' ||
      p.recipientDid !== expectedRecipientDid ||
      !RELAY_AUTH_ACTIONS.has(p.action) ||
      typeof p.nonce !== 'string' ||
      !p.nonce.trim() ||
      typeof p.timestamp !== 'string' ||
      !Number.isFinite(Date.parse(p.timestamp)) ||
      !Number.isFinite(now) ||
      !Number.isFinite(skew) ||
      skew < 0 ||
      Math.abs(now - Date.parse(p.timestamp)) > skew
    )
      throw new Error();
    const origin = checkRelayAuthOrigin(p.origin, options);
    if (origin) return origin;
    return { valid: true, nonce: p.nonce, action: p.action };
  } catch {
    return { valid: false, error: 'RELAY_UNAUTHORIZED' };
  }
}
