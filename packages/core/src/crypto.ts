// SPDX-License-Identifier: Apache-2.0 AND MIT
// Adapted from newtro/delegateos src/core/crypto.ts (MIT), Scott Smith.
// ACP uses Node Ed25519, SHA-256 and did:key; it is not DelegateOS SJT wire format.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import canonicalizeJson from 'canonicalize';
import type {
  EncryptedEnvelopePayload,
  Json,
  KeyPair,
  Signature,
  Signed,
  SignedEnvelope,
} from './types.js';
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array): string {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let s = '';
  while (n) {
    s = alphabet[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}
function unbase58(s: string): Buffer {
  if (!s || s.length > 128) throw new Error('INVALID_DID');
  let n = 0n;
  for (const c of s) {
    const i = alphabet.indexOf(c);
    if (i < 0) throw new Error('INVALID_DID');
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.concat([
    Buffer.alloc(s.match(/^1*/)?.[0].length ?? 0),
    n ? Buffer.from(hex, 'hex') : Buffer.alloc(0),
  ]);
}
function assertJson(v: unknown, seen = new Set<object>()): void {
  if (v === null || typeof v === 'boolean') return;
  if (typeof v === 'string') {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v))
      throw new Error('INVALID_UNICODE');
    return;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return;
  if (typeof v !== 'object' || seen.has(v)) throw new Error('INVALID_JSON');
  if (
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) !== Object.prototype &&
    Object.getPrototypeOf(v) !== null
  )
    throw new Error('INVALID_JSON');
  seen.add(v);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) assertJson(v[i], seen);
  } else
    for (const [k, x] of Object.entries(v)) {
      assertJson(k);
      assertJson(x, seen);
    }
  seen.delete(v);
}
export function canonicalize(v: unknown): string {
  assertJson(v);
  const s = (canonicalizeJson as unknown as (v: unknown) => string | undefined)(v);
  if (s === undefined) throw new Error('INVALID_JSON');
  return s;
}
export function digestBytes(v: string | Uint8Array): string {
  return 'sha256:' + createHash('sha256').update(v).digest('hex');
}
export function digest(v: unknown): string {
  return digestBytes(canonicalize(v));
}
export function generateKeyPair(): KeyPair {
  const kp = generateKeyPairSync('ed25519');
  const raw = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    did: 'did:key:z' + base58(Buffer.concat([Buffer.from([0xed, 0x01]), raw])),
    privateKey: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
export function resolveDid(did: string) {
  if (!did.startsWith('did:key:z')) throw new Error('INVALID_DID');
  const raw = unbase58(did.slice(9));
  if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 1 || base58(raw) !== did.slice(9))
    throw new Error('INVALID_DID');
  return createPublicKey({
    format: 'der',
    type: 'spki',
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw.subarray(2)]),
  });
}
export function signPayload<T>(
  payload: T,
  key: KeyPair,
  signedAt = new Date().toISOString(),
): Signed<T> {
  const payloadDigest = digest(payload);
  const metadata = {
    signerDid: key.did,
    canonicalization: 'RFC8785-JCS' as const,
    payloadDigest,
    signedAt,
  };
  // Metadata is covered as well as the payload, preventing signer/time substitution.
  const signature =
    'ed25519:' +
    sign(
      null,
      Buffer.from(canonicalize({ payload, ...metadata })),
      createPrivateKey(key.privateKey),
    ).toString('base64url');
  const result = { payload: structuredClone(payload), signature: { ...metadata, signature } };
  if (!verifySigned(result, key.did)) throw new Error('KEY_DID_MISMATCH');
  return result;
}
export function verifySigned<T>(value: Signed<T>, expectedDid?: string): boolean {
  try {
    const { signature, ...metadata } = value.signature;
    if (!/^ed25519:[A-Za-z0-9_-]{86}$/.test(signature)) return false;
    const encoded = signature.slice(8);
    const decoded = Buffer.from(encoded, 'base64url');
    const canonical = decoded
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    if (decoded.length !== 64 || canonical !== encoded) return false;
    return (
      (!expectedDid || metadata.signerDid === expectedDid) &&
      metadata.canonicalization === 'RFC8785-JCS' &&
      Number.isFinite(Date.parse(metadata.signedAt)) &&
      metadata.payloadDigest === digest(value.payload) &&
      verify(
        null,
        Buffer.from(canonicalize({ payload: value.payload, ...metadata })),
        resolveDid(metadata.signerDid),
        decoded,
      )
    );
  } catch {
    return false;
  }
}
export function verifySignature(
  payload: unknown,
  signature: Signature,
  expectedDid?: string,
): boolean {
  return verifySigned({ payload, signature }, expectedDid);
}
const X25519_P = (1n << 255n) - 19n;
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
export interface EnvelopeHeaderContext {
  taskId: string;
  seq: number;
  eventType: string;
  senderDid: string;
  recipientDid: string;
}
function mod(n: bigint, p: bigint): bigint {
  const r = n % p;
  return r >= 0n ? r : r + p;
}
function modInverse(a: bigint, p: bigint): bigint {
  let result = 1n;
  let base = mod(a, p);
  let exp = p - 2n;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % p;
    base = (base * base) % p;
    exp >>= 1n;
  }
  return result;
}
function readLe(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) + BigInt(bytes[i]!);
  return n;
}
function writeLe(value: bigint, length = 32): Buffer {
  const out = Buffer.alloc(length);
  let n = value;
  for (let i = 0; i < length; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}
/**
 * Montgomery u from an Ed25519 public key. RFC 8032 encodes y little-endian
 * with the x sign in bit 255; RFC 7748 uses u = (1 + y) / (1 - y).
 */
function x25519PublicFromDid(did: string): KeyObject {
  const y =
    readLe(resolveDid(did).export({ format: 'der', type: 'spki' }).subarray(-32)) &
    ((1n << 255n) - 1n);
  const yMod = y % X25519_P;
  const denom = mod(1n - yMod, X25519_P);
  if (denom === 0n) throw new Error('INVALID_DID');
  const u = mod((1n + yMod) * modInverse(denom, X25519_P), X25519_P);
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, writeLe(u)]),
    format: 'der',
    type: 'spki',
  });
}
/** Ed25519 seed to the clamped X25519 scalar from the SHA-512 prefix. */
function x25519PrivateFromKey(key: KeyPair): KeyObject {
  const seed = createPrivateKey(key.privateKey)
    .export({ format: 'der', type: 'pkcs8' })
    .subarray(-32);
  const scalar = Buffer.from(createHash('sha512').update(seed).digest().subarray(0, 32));
  scalar[0] &= 248;
  scalar[31] &= 127;
  scalar[31] |= 64;
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, scalar]),
    format: 'der',
    type: 'pkcs8',
  });
}
function envelopeAad(context: EnvelopeHeaderContext): Buffer {
  return Buffer.from(
    canonicalize({
      taskId: context.taskId,
      seq: context.seq,
      eventType: context.eventType,
      senderDid: context.senderDid,
      recipientDid: context.recipientDid,
    }),
  );
}
function rawX25519PublicKey(key: KeyObject): Buffer {
  const raw = key.export({ format: 'der', type: 'spki' }).subarray(-32);
  if (raw.length !== 32) throw new Error('INVALID_PUBLIC_KEY');
  return Buffer.from(raw);
}
/**
 * HKDF-SHA256 info for envelope payload encryption.
 * Binds the canonical header to the ephemeral X25519 public key and the
 * recipient static X25519 public key so the AES key is tied to this
 * Diffie-Hellman transcript as well as the header. Both keys are the raw
 * 32-byte values, encoded base64url. AES-GCM additional data stays the
 * header alone, and the 12-byte nonce stays the HKDF salt.
 */
export function envelopeHkdfInfo(
  context: EnvelopeHeaderContext,
  ephemeralPublicKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): Buffer {
  if (ephemeralPublicKey.length !== 32 || recipientPublicKey.length !== 32)
    throw new Error('INVALID_PUBLIC_KEY');
  return Buffer.from(
    canonicalize({
      taskId: context.taskId,
      seq: context.seq,
      eventType: context.eventType,
      senderDid: context.senderDid,
      recipientDid: context.recipientDid,
      ephemeralPublicKey: Buffer.from(ephemeralPublicKey).toString('base64url'),
      recipientPublicKey: Buffer.from(recipientPublicKey).toString('base64url'),
    }),
    'utf8',
  );
}
function importEphemeralPublic(encoded: string): KeyObject {
  const raw = Buffer.from(encoded, 'base64url');
  const der = raw.length === 32 ? Buffer.concat([X25519_SPKI_PREFIX, raw]) : raw;
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}
export function isEncryptedEnvelopePayload(payload: unknown): payload is EncryptedEnvelopePayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  return (
    value.__acpEncrypted === 'X25519-HKDF-AES256GCM' &&
    typeof value.ephemeralPublicKey === 'string' &&
    typeof value.iv === 'string' &&
    typeof value.ciphertext === 'string' &&
    typeof value.tag === 'string'
  );
}
export function encryptEnvelopePayload(
  payload: Json,
  context: EnvelopeHeaderContext,
): EncryptedEnvelopePayload {
  const ephemeral = generateKeyPairSync('x25519');
  const recipientPublic = x25519PublicFromDid(context.recipientDid);
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipientPublic,
  });
  const iv = randomBytes(12);
  const aad = envelopeAad(context);
  const info = envelopeHkdfInfo(
    context,
    rawX25519PublicKey(ephemeral.publicKey),
    rawX25519PublicKey(recipientPublic),
  );
  // The nonce remains the HKDF salt. Info binds the header and both X25519 public keys.
  const key = Buffer.from(hkdfSync('sha256', shared, iv, info, 32));
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
    cipher.final(),
  ]);
  return {
    __acpEncrypted: 'X25519-HKDF-AES256GCM',
    ephemeralPublicKey: ephemeral.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64url'),
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
}
export function decryptEnvelopePayload<T = Json>(
  payload: Json,
  recipient: KeyPair,
  context: EnvelopeHeaderContext,
  options: { requireEncrypted?: boolean } = {},
): T {
  // Session peers must opt in to cleartext. A missing flag rejects it.
  const requireEncrypted = options.requireEncrypted ?? true;
  if (!isEncryptedEnvelopePayload(payload)) {
    if (requireEncrypted) throw new Error('UNENCRYPTED_ENVELOPE_REJECTED');
    return payload as T;
  }
  try {
    const iv = Buffer.from(payload.iv, 'base64url');
    const aad = envelopeAad(context);
    const ephemeralPublic = importEphemeralPublic(payload.ephemeralPublicKey);
    const recipientPublic = x25519PublicFromDid(context.recipientDid);
    const shared = diffieHellman({
      privateKey: x25519PrivateFromKey(recipient),
      publicKey: ephemeralPublic,
    });
    const info = envelopeHkdfInfo(
      context,
      rawX25519PublicKey(ephemeralPublic),
      rawX25519PublicKey(recipientPublic),
    );
    // The nonce remains the HKDF salt. Info binds the header and both X25519 public keys.
    const key = Buffer.from(hkdfSync('sha256', shared, iv, info, 32));
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64url'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64url')),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString('utf8')) as T;
  } catch (error) {
    if (error instanceof Error && error.message === 'ENVELOPE_DECRYPTION_FAILED') throw error;
    throw new Error('ENVELOPE_DECRYPTION_FAILED');
  }
}
export function openEnvelope<T = Json>(
  envelope: SignedEnvelope,
  recipient: KeyPair,
  options: { requireEncrypted?: boolean } = {},
): T {
  return decryptEnvelopePayload<T>(
    envelope.payload.payload,
    recipient,
    {
      taskId: envelope.payload.taskId,
      seq: envelope.payload.seq,
      eventType: envelope.payload.eventType,
      senderDid: envelope.payload.senderDid,
      recipientDid: envelope.payload.recipientDid,
    },
    { requireEncrypted: options.requireEncrypted ?? true },
  );
}
