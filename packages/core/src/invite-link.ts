// SPDX-License-Identifier: Apache-2.0
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { DEFAULT_CLOCK_SKEW_MS, validateRelayEndpointUrl } from './discovery.js';
import type { RelayEndpointPolicy } from './discovery.js';
import { normalizeRelayOrigin } from './relay-auth.js';

export const INVITE_LINK_CONTEXT = 'sealbridge/invite-link/v1';
/** UTF-8 info labels; each HKDF uses K as IKM and an empty salt (RFC 5869). */
export const INVITE_LINK_HKDF_INFO = Object.freeze({
  id: INVITE_LINK_CONTEXT + '/id',
  encKey: INVITE_LINK_CONTEXT + '/enc-key',
  accessKey: INVITE_LINK_CONTEXT + '/access-key',
});
export const INVITE_LINK_PAD_BLOCK_BYTES = 4096;
export const INVITE_LINK_MAX_PADDED_BYTES = 16384;
export const INVITE_LINK_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const INVITE_LINK_MAX_TTL_MS = 72 * 60 * 60 * 1000;
export const INVITE_LINK_TOKEN_GRACE_MS = 24 * 60 * 60 * 1000;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_LINK_CHARS = 2048;
const DEFAULT_RELAY = 'https://relay.sealbridge.dev';

export interface InviteLinkKeys {
  id: Buffer;
  encKey: Buffer;
  accessKey: Buffer;
}
export interface InviteLinkCiphertext {
  id: Uint8Array;
  /** Encrypted padded plaintext followed by the 16-byte GCM authentication tag. */
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  expiresAt: string;
}
/** Relay storage encoding. No K, plaintext, claim tag, or verification number. */
export interface InviteLinkStorage {
  id: string;
  ciphertext: string;
  nonce: string;
  expiresAt: string;
}
export interface InviteLinkRelayPolicy extends RelayEndpointPolicy {
  /** Same URL comparison as application relay allow-lists (origin + pathname). */
  allowedRelayUrls?: readonly string[];
}
export interface ParsedInviteLink {
  v: 1;
  k: string;
  relayOrigin: string;
}

function decodeBase64url(value: unknown, minBytes: number, maxBytes = minBytes): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes * 4 / 3) ||
      !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('INVALID_INVITE_LINK_ENCODING');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < minBytes || bytes.length > maxBytes || bytes.toString('base64url') !== value)
    throw new Error('INVALID_INVITE_LINK_ENCODING');
  return bytes;
}

function assertBytes(value: Uint8Array, length: number): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== length)
    throw new Error('INVALID_INVITE_LINK_BYTES');
}

/** Expiries on the storage boundary must be UTC ISO strings with milliseconds. */
function canonicalExpiry(expiresAt: string): string {
  if (typeof expiresAt !== 'string' || expiresAt.length !== 24 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt) ||
      !Number.isFinite(Date.parse(expiresAt)) || new Date(expiresAt).toISOString() !== expiresAt)
    throw new Error('INVALID_INVITE_LINK_EXPIRY');
  return expiresAt;
}

/** Returns the link deadline and the inner token deadline (link + 24 hours). */
export function inviteLinkExpiry(now = Date.now(), ttlMs = INVITE_LINK_DEFAULT_TTL_MS): {
  expiresAt: string; tokenExpiresAt: string;
} {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > INVITE_LINK_MAX_TTL_MS)
    throw new Error('INVALID_INVITE_LINK_EXPIRY');
  try {
    return {
      expiresAt: canonicalExpiry(new Date(now + ttlMs).toISOString()),
      tokenExpiresAt: canonicalExpiry(new Date(now + ttlMs + INVITE_LINK_TOKEN_GRACE_MS).toISOString()),
    };
  } catch { throw new Error('INVALID_INVITE_LINK_EXPIRY'); }
}

/** The returned k is exactly 43 unpadded base64url characters encoding 32 random bytes. */
export function generateInviteLinkKey(): string {
  return randomBytes(32).toString('base64url');
}

export function deriveInviteLinkKeys(k: string): InviteLinkKeys {
  const key = decodeBase64url(k, 32);
  const derive = (info: string, length: number) => Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), info, length));
  return {
    id: derive(INVITE_LINK_HKDF_INFO.id, 16),
    encKey: derive(INVITE_LINK_HKDF_INFO.encKey, 32),
    accessKey: derive(INVITE_LINK_HKDF_INFO.accessKey, 32),
  };
}

/** Exact bytes: HMAC-SHA256(accessKey, UTF8("claim") || raw 16-byte id). */
export function inviteLinkClaimTag(accessKey: Uint8Array, id: Uint8Array): Buffer {
  assertBytes(accessKey, 32);
  assertBytes(id, 16);
  return createHmac('sha256', accessKey).update('claim', 'utf8').update(id).digest();
}

/**
 * AAD = UTF8(context) || raw id || UTF8(normalizeRelayOrigin(relayOrigin)) ||
 * UTF8(expiresAt). No separators, length prefixes, JSON, or terminating NULs.
 * The origin has no path, trailing slash, or default port; ws(s) maps to http(s).
 */
export function inviteLinkAad(id: Uint8Array, relayOrigin: string, expiresAt: string): Buffer {
  assertBytes(id, 16);
  return Buffer.concat([Buffer.from(INVITE_LINK_CONTEXT), id,
    Buffer.from(normalizeRelayOrigin(relayOrigin)), Buffer.from(canonicalExpiry(expiresAt))]);
}

/** Four-byte big-endian UTF-8 byte length, token bytes, then zero padding. */
export function padInviteLinkToken(token: string): Buffer {
  if (typeof token !== 'string' || !token)
    throw new Error('INVALID_INVITE_LINK_PLAINTEXT');
  if (token.length > INVITE_LINK_MAX_PADDED_BYTES - 4) throw new Error('INVITE_LINK_TOO_LARGE');
  const size = Buffer.byteLength(token, 'utf8');
  if (size > INVITE_LINK_MAX_PADDED_BYTES - 4) throw new Error('INVITE_LINK_TOO_LARGE');
  if (Buffer.from(token, 'utf8').toString('utf8') !== token) throw new Error('INVALID_INVITE_LINK_PLAINTEXT');
  const padded = Buffer.alloc(Math.ceil((size + 4) / INVITE_LINK_PAD_BLOCK_BYTES) * INVITE_LINK_PAD_BLOCK_BYTES);
  padded.writeUInt32BE(size);
  padded.write(token, 4, size, 'utf8');
  return padded;
}

export function unpadInviteLinkToken(padded: Uint8Array): string {
  if (!(padded instanceof Uint8Array) || !validPaddedSize(padded.byteLength))
    throw new Error('INVALID_INVITE_LINK_PLAINTEXT');
  const bytes = Buffer.from(padded), size = bytes.readUInt32BE();
  if (!size || size > bytes.length - 4 ||
      Math.ceil((size + 4) / INVITE_LINK_PAD_BLOCK_BYTES) * INVITE_LINK_PAD_BLOCK_BYTES !== bytes.length ||
      bytes.subarray(4 + size).some(byte => byte !== 0)) throw new Error('INVALID_INVITE_LINK_PLAINTEXT');
  const tokenBytes = bytes.subarray(4, 4 + size), token = tokenBytes.toString('utf8');
  if (!Buffer.from(token, 'utf8').equals(tokenBytes)) throw new Error('INVALID_INVITE_LINK_PLAINTEXT');
  return token;
}

function validPaddedSize(size: number): boolean {
  return size >= INVITE_LINK_PAD_BLOCK_BYTES && size <= INVITE_LINK_MAX_PADDED_BYTES &&
    size % INVITE_LINK_PAD_BLOCK_BYTES === 0;
}

function validateCiphertext(value: InviteLinkCiphertext): void {
  assertBytes(value.id, 16);
  assertBytes(value.nonce, NONCE_BYTES);
  if (!(value.ciphertext instanceof Uint8Array) || !validPaddedSize(value.ciphertext.byteLength - AUTH_TAG_BYTES))
    throw new Error('INVALID_INVITE_LINK_CIPHERTEXT');
  canonicalExpiry(value.expiresAt);
}

export function packInviteLinkCiphertext(value: InviteLinkCiphertext): InviteLinkStorage {
  validateCiphertext(value);
  return {
    id: Buffer.from(value.id).toString('base64url'),
    ciphertext: Buffer.from(value.ciphertext).toString('base64url'),
    nonce: Buffer.from(value.nonce).toString('base64url'),
    expiresAt: value.expiresAt,
  };
}

/** Strict local decoding of an untrusted relay response, without contacting a relay. */
export function unpackInviteLinkCiphertext(value: unknown): InviteLinkCiphertext {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 4 ||
      !['id', 'ciphertext', 'nonce', 'expiresAt'].every(key => Object.hasOwn(value, key)))
    throw new Error('INVALID_INVITE_LINK_STORAGE');
  const record = value as InviteLinkStorage;
  const decoded = {
    id: decodeBase64url(record.id, 16),
    ciphertext: decodeBase64url(record.ciphertext, INVITE_LINK_PAD_BLOCK_BYTES + AUTH_TAG_BYTES,
      INVITE_LINK_MAX_PADDED_BYTES + AUTH_TAG_BYTES),
    nonce: decodeBase64url(record.nonce, NONCE_BYTES),
    expiresAt: canonicalExpiry(record.expiresAt),
  };
  validateCiphertext(decoded);
  return decoded;
}

/** Opaque token wrapping only. Signature/card/relay verification remains the caller's next step. */
export function encryptInviteLink(token: string, k: string, options: {
  relayOrigin: string; expiresAt: string; now?: number;
}): InviteLinkCiphertext {
  const now = options.now ?? Date.now(), deadline = Date.parse(canonicalExpiry(options.expiresAt));
  if (!Number.isSafeInteger(now) || deadline <= now || deadline - now > INVITE_LINK_MAX_TTL_MS)
    throw new Error('INVALID_INVITE_LINK_EXPIRY');
  const keys = deriveInviteLinkKeys(k), nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keys.encKey, nonce, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(inviteLinkAad(keys.id, options.relayOrigin, options.expiresAt));
  const ciphertext = Buffer.concat([cipher.update(padInviteLinkToken(token)), cipher.final(), cipher.getAuthTag()]);
  return { id: keys.id, nonce, ciphertext, expiresAt: options.expiresAt };
}

export function decryptInviteLink(value: InviteLinkCiphertext, k: string, relayOrigin: string, now = Date.now()): string {
  try {
    validateCiphertext(value);
    if (!Number.isSafeInteger(now) || Date.parse(value.expiresAt) <= now - DEFAULT_CLOCK_SKEW_MS)
      throw new Error();
    const keys = deriveInviteLinkKeys(k);
    if (!keys.id.equals(value.id)) throw new Error();
    const ciphertext = Buffer.from(value.ciphertext);
    const decipher = createDecipheriv('aes-256-gcm', keys.encKey, value.nonce, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(inviteLinkAad(value.id, relayOrigin, value.expiresAt));
    decipher.setAuthTag(ciphertext.subarray(-AUTH_TAG_BYTES));
    return unpadInviteLinkToken(Buffer.concat([decipher.update(ciphertext.subarray(0, -AUTH_TAG_BYTES)), decipher.final()]));
  } catch { throw new Error('INVITE_LINK_DECRYPTION_FAILED'); }
}

function normalizeAllowlistUrl(value: string, policy: RelayEndpointPolicy): string {
  validateRelayEndpointUrl(value, policy);
  const url = new URL(value);
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/** Only the two v1 fragment forms are accepted. Parsing performs no network I/O. */
export function parseInviteLink(uri: string, policy: InviteLinkRelayPolicy = {}): ParsedInviteLink {
  if (typeof uri !== 'string' || uri.length > MAX_LINK_CHARS || /\s/.test(uri))
    throw new Error('INVALID_INVITE_LINK');
  // Match the literal URL prefix: URL normalization must not erase a query,
  // credentials, default port, dot-segment path, control character, or extra slash.
  const match = /^(?:https:\/\/sealbridge\.app\/j|sealbridge:\/\/join)#([^\s#?]+)$/.exec(uri);
  if (!match) throw new Error('INVALID_INVITE_LINK');
  const fields = new Map<string, string>();
  for (const field of match[1].split('&')) {
    const part = /^(v|k|r)=([^=]+)$/.exec(field);
    if (!part || fields.has(part[1])) throw new Error('INVALID_INVITE_LINK');
    fields.set(part[1], part[2]);
  }
  if (fields.get('v') !== '1' || !fields.has('k')) throw new Error('INVALID_INVITE_LINK');
  const k = fields.get('k')!;
  decodeBase64url(k, 32);
  let relayOrigin = DEFAULT_RELAY;
  if (fields.has('r')) {
    let host: string;
    try { host = decodeURIComponent(fields.get('r')!); }
    catch { throw new Error('INVALID_INVITE_LINK'); }
    // r is a host[:port], including bracketed IPv6, never a URL or a path.
    if (/\s/.test(host) || !/^[A-Za-z0-9.\[\]:-]+$/.test(host)) throw new Error('INVALID_INVITE_LINK');
    const relay = 'https://' + host;
    validateRelayEndpointUrl(relay, policy);
    relayOrigin = normalizeRelayOrigin(relay);
  }
  validateRelayEndpointUrl(relayOrigin, policy);
  if (policy.allowedRelayUrls !== undefined &&
      !policy.allowedRelayUrls.map(value => normalizeAllowlistUrl(value, policy)).includes(relayOrigin))
    throw new Error('INVITE_LINK_RELAY_NOT_ALLOWED');
  return { v: 1, k, relayOrigin };
}
