// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  decryptInviteLink, deriveInviteLinkKeys, encryptInviteLink, generateInviteLinkKey,
  inviteLinkAad, inviteLinkClaimTag, inviteLinkExpiry, packInviteLinkCiphertext,
  padInviteLinkToken, parseInviteLink, unpackInviteLinkCiphertext, unpadInviteLinkToken,
  INVITE_LINK_DEFAULT_TTL_MS, INVITE_LINK_MAX_TTL_MS, INVITE_LINK_TOKEN_GRACE_MS,
} from '../packages/core/src/index.js';

// Keep deterministic nonces inside this test module; production always generates them.
vi.mock('node:crypto', async importOriginal => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return { ...original, randomBytes: vi.fn(original.randomBytes) };
});

const K = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64url');
const NOW = Date.parse('2030-01-01T00:00:00.000Z');
const EXPIRY = '2030-01-02T00:00:00.000Z';
const RELAY = 'https://relay.sealbridge.dev';
const WEB = 'https://sealbridge.app/j#';
const APP = 'sealbridge://join#';
const FRAGMENT = 'v=1&k=' + K;
const wrap = (token = 'acp-invite:fixed-vector') => encryptInviteLink(token, K, {
  relayOrigin: RELAY, expiresAt: EXPIRY, now: NOW,
});
const flip = (bytes: Uint8Array, index = 0) => {
  const changed = Buffer.from(bytes); changed[index] ^= 1; return changed;
};

describe('SC1 invite-link v1 byte conformance', () => {
  it('matches independent HKDF, claim HMAC, AAD and AES-GCM vectors', () => {
    // Computed independently with Python hmac/hashlib and cryptography AESGCM.
    const keys = deriveInviteLinkKeys(K);
    expect(keys.id.toString('hex')).toBe('a790cbb0c011a413ee86b19913a5f85d');
    expect(keys.encKey.toString('hex')).toBe('3297072bbc597a4e74d1251a6173e50010cf6acf8e3c8bfe4130a2b2f422c058');
    expect(keys.accessKey.toString('hex')).toBe('227a556a330cd54e65144789b3cfbe66f559c3bfba64ec8815b69dcc2612588d');
    expect(inviteLinkClaimTag(keys.accessKey, keys.id).toString('hex'))
      .toBe('1de2201212698a1e97aa46b8bac7780c7a69eada60c653d68a4db6ecfd085165');
    expect(inviteLinkAad(keys.id, RELAY, EXPIRY).toString('hex')).toBe(
      '7365616c6272696467652f696e766974652d6c696e6b2f7631a790cbb0c011a413ee86b19913a5f85d' +
      '68747470733a2f2f72656c61792e7365616c6272696467652e646576323033302d30312d30325430303a30303a30302e3030305a');
    vi.mocked(randomBytes).mockImplementationOnce(() => Buffer.from(Array.from({ length: 12 }, (_, i) => i)));
    const encrypted = wrap(), ciphertext = Buffer.from(encrypted.ciphertext);
    expect(encrypted.nonce).toEqual(Buffer.from('000102030405060708090a0b', 'hex'));
    expect(ciphertext.length).toBe(4096 + 16);
    expect(ciphertext.subarray(0, 32).toString('hex')).toBe('2522cf8721eaf202d0bd3c4909bc582ced1c34ae26d0ecba3192e588b01492bd');
    expect(ciphertext.subarray(-16).toString('hex')).toBe('3d12c3bc5739b18666c52c22fc11ef74');
    expect(createHash('sha256').update(ciphertext).digest('hex'))
      .toBe('9ce3950d80948559ca4b71381d30d730b5094f910bb3f605d8d27430a3818d22');
    expect(decryptInviteLink(encrypted, K, RELAY, NOW)).toBe('acp-invite:fixed-vector');
  });

  it('generates canonical 32-byte keys and fresh 12-byte nonces', () => {
    const first = generateInviteLinkKey(), second = generateInviteLinkKey();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first, 'base64url').length).toBe(32);
    expect(first).not.toBe(second);
    expect(wrap().nonce).not.toEqual(wrap().nonce);
    expect(deriveInviteLinkKeys(first).id.length).toBe(16);
  });

  it('rejects one-bit changes to ciphertext, authentication tag, nonce, id and K', () => {
    const encrypted = wrap();
    for (const mutated of [
      { ...encrypted, ciphertext: flip(encrypted.ciphertext) },
      { ...encrypted, ciphertext: flip(encrypted.ciphertext, encrypted.ciphertext.length - 1) },
      { ...encrypted, nonce: flip(encrypted.nonce) },
      { ...encrypted, id: flip(encrypted.id) },
    ]) expect(() => decryptInviteLink(mutated, K, RELAY, NOW)).toThrow('INVITE_LINK_DECRYPTION_FAILED');
    expect(() => decryptInviteLink(encrypted, flip(Buffer.from(K, 'base64url')).toString('base64url'), RELAY, NOW))
      .toThrow('INVITE_LINK_DECRYPTION_FAILED');
  });

  it('binds expiry and canonical relay origin', () => {
    const encrypted = wrap();
    expect(() => decryptInviteLink({ ...encrypted, expiresAt: '2030-01-02T00:00:01.000Z' }, K, RELAY, NOW))
      .toThrow('INVITE_LINK_DECRYPTION_FAILED');
    for (const relay of ['https://other.example', 'http://relay.sealbridge.dev', RELAY + ':8443'])
      expect(() => decryptInviteLink(encrypted, K, relay, NOW)).toThrow('INVITE_LINK_DECRYPTION_FAILED');
    expect(decryptInviteLink(encrypted, K, 'wss://RELAY.SEALBRIDGE.DEV:443/socket', NOW))
      .toBe('acp-invite:fixed-vector');
  });

  it.each([1, 4092, 4093, 8188, 8189, 12284, 12285, 16380])('pads %i bytes to the smallest 4 KiB block', size => {
    const token = 'a'.repeat(size), padded = padInviteLinkToken(token);
    expect(padded.length).toBe(Math.ceil((size + 4) / 4096) * 4096);
    expect(padded.readUInt32BE()).toBe(size);
    expect(unpadInviteLinkToken(padded)).toBe(token);
    const encrypted = wrap(token);
    expect(encrypted.ciphertext.length).toBe(padded.length + 16);
    expect(decryptInviteLink(encrypted, K, RELAY, NOW)).toBe(token);
  });

  it('bounds UTF-8 byte sizes and rejects invalid padding or lossy text', () => {
    expect(() => padInviteLinkToken('a'.repeat(16381))).toThrow('INVITE_LINK_TOO_LARGE');
    expect(() => padInviteLinkToken('é'.repeat(8191))).toThrow('INVITE_LINK_TOO_LARGE');
    expect(unpadInviteLinkToken(padInviteLinkToken('é'.repeat(8190)))).toBe('é'.repeat(8190));
    for (const token of ['', '\ud800', '\udfff']) expect(() => padInviteLinkToken(token)).toThrow('INVALID_INVITE_LINK_PLAINTEXT');
    for (const size of [0, 4095, 4097, 16385, 20480])
      expect(() => unpadInviteLinkToken(Buffer.alloc(size))).toThrow('INVALID_INVITE_LINK_PLAINTEXT');
    const invalidLength = padInviteLinkToken('x'); invalidLength.writeUInt32BE(4096);
    const invalidUtf8 = padInviteLinkToken('x'); invalidUtf8[4] = 0xff;
    for (const bad of [Buffer.alloc(4096), invalidLength, invalidUtf8, flip(padInviteLinkToken('x'), 4095),
      Buffer.concat([padInviteLinkToken('x'), Buffer.alloc(4096)])])
      expect(() => unpadInviteLinkToken(bad)).toThrow('INVALID_INVITE_LINK_PLAINTEXT');
  });

  it('packs only the relay storage fields and strictly decodes them', () => {
    const encrypted = wrap(), packed = packInviteLinkCiphertext(encrypted);
    expect(Object.keys(packed).sort()).toEqual(['ciphertext', 'expiresAt', 'id', 'nonce']);
    expect(packed.id).toBe(deriveInviteLinkKeys(K).id.toString('base64url'));
    const unpacked = unpackInviteLinkCiphertext(JSON.parse(JSON.stringify(packed)));
    expect(unpacked).toEqual(encrypted);
    expect(decryptInviteLink(unpacked, K, RELAY, NOW)).toBe('acp-invite:fixed-vector');
    for (const bad of [null, [], {}, { ...packed, k: K }, { ...packed, id: packed.id + '=' },
      { ...packed, nonce: 'AA' }, { ...packed, ciphertext: 'a'.repeat(22000) },
      { ...packed, ciphertext: Buffer.alloc(4097 + 16).toString('base64url') },
      { ...packed, expiresAt: '2030-01-02T00:00:00Z' }])
      expect(() => unpackInviteLinkCiphertext(bad)).toThrow();
    expect(() => packInviteLinkCiphertext({ ...encrypted, nonce: Buffer.alloc(11) })).toThrow();
    expect(() => packInviteLinkCiphertext({ ...encrypted, ciphertext: Buffer.alloc(20480 + 16) })).toThrow();
  });

  it('uses 24-hour default, 72-hour maximum, token grace and 60-second receive skew', () => {
    expect(inviteLinkExpiry(NOW)).toEqual({ expiresAt: EXPIRY, tokenExpiresAt: '2030-01-03T00:00:00.000Z' });
    expect(INVITE_LINK_DEFAULT_TTL_MS).toBe(86400000);
    expect(INVITE_LINK_MAX_TTL_MS).toBe(3 * 86400000);
    expect(INVITE_LINK_TOKEN_GRACE_MS).toBe(86400000);
    expect(inviteLinkExpiry(NOW, INVITE_LINK_MAX_TTL_MS).expiresAt).toBe('2030-01-04T00:00:00.000Z');
    for (const ttl of [0, -1, 0.5, NaN, Infinity, INVITE_LINK_MAX_TTL_MS + 1])
      expect(() => inviteLinkExpiry(NOW, ttl)).toThrow('INVALID_INVITE_LINK_EXPIRY');
    for (const expiresAt of ['2030-02-30T00:00:00.000Z', '2030-01-02T00:00:00Z',
      '2030-01-02T09:00:00.000+09:00', '2030-01-01T00:00:00.000Z', '2030-01-04T00:00:00.001Z'])
      expect(() => encryptInviteLink('x', K, { relayOrigin: RELAY, expiresAt, now: NOW })).toThrow('INVALID_INVITE_LINK_EXPIRY');
    const encrypted = wrap();
    expect(decryptInviteLink(encrypted, K, RELAY, Date.parse(EXPIRY) + 59999)).toBe('acp-invite:fixed-vector');
    expect(() => decryptInviteLink(encrypted, K, RELAY, Date.parse(EXPIRY) + 60000)).toThrow('INVITE_LINK_DECRYPTION_FAILED');
    expect(() => decryptInviteLink(encrypted, K, RELAY, NaN)).toThrow('INVITE_LINK_DECRYPTION_FAILED');
  });
});

describe('SC1 strict fragment parsing', () => {
  it.each([WEB, APP])('accepts the specified %s form without network I/O', prefix => {
    expect(parseInviteLink(prefix + FRAGMENT)).toEqual({ v: 1, k: K, relayOrigin: RELAY });
    expect(parseInviteLink(prefix + 'k=' + K + '&r=Relay.Example%3A8443&v=1', {
      allowedRelayUrls: ['https://relay.example:8443/'],
    })).toEqual({ v: 1, k: K, relayOrigin: 'https://relay.example:8443' });
  });

  it('applies endpoint restrictions and the optional relay allow-list', () => {
    for (const host of ['127.0.0.1', 'localhost', '10.0.0.1', '[::1]', 'metadata.google.internal', '169.254.169.254'])
      expect(() => parseInviteLink(WEB + FRAGMENT + '&r=' + host)).toThrow('SSRF_BLOCKED_RELAY_URL');
    expect(parseInviteLink(WEB + FRAGMENT + '&r=127.0.0.1:8787', { allowPrivateRelay: true }).relayOrigin)
      .toBe('https://127.0.0.1:8787');
    expect(() => parseInviteLink(WEB + FRAGMENT + '&r=metadata.google.internal', { allowPrivateRelay: true })).toThrow();
    for (const allowedRelayUrls of [[], ['https://other.example'], [RELAY + '/specific-path']])
      expect(() => parseInviteLink(WEB + FRAGMENT, { allowedRelayUrls })).toThrow('INVITE_LINK_RELAY_NOT_ALLOWED');
    expect(parseInviteLink(WEB + FRAGMENT, { allowedRelayUrls: [RELAY + '/'] }).relayOrigin).toBe(RELAY);
  });

  it('rejects extra fields, duplicates, queries, userinfo and URL normalization tricks', () => {
    for (const uri of [
      WEB + FRAGMENT + '&extra=1', WEB + FRAGMENT + '&v=1', WEB + FRAGMENT + '&k=' + K,
      WEB + FRAGMENT + '&r=one.example&r=two.example', WEB + FRAGMENT + '&', WEB + FRAGMENT + '#extra',
      WEB + FRAGMENT + '?x=y', 'https://sealbridge.app/j?x=y#' + FRAGMENT,
      'https://sealbridge.app/j?#' + FRAGMENT, 'https://user@sealbridge.app/j#' + FRAGMENT,
      'https://user:pass@sealbridge.app/j#' + FRAGMENT, 'https://sealbridge.app:443/j#' + FRAGMENT,
      'https://sealbridge.app/a/../j#' + FRAGMENT, 'https://sealbridge.app/j/#' + FRAGMENT,
      'https://other.example/j#' + FRAGMENT, 'http://sealbridge.app/j#' + FRAGMENT,
      'https://sealbridge.app/i#' + FRAGMENT, 'sealbridge://join/#' + FRAGMENT,
      'sealbridge://user@join#' + FRAGMENT, 'sealbridge://join?x=y#' + FRAGMENT,
      WEB + FRAGMENT + '\n', WEB + 'v=1&k=' + 'a'.repeat(3000),
      WEB + 'v=2&k=' + K, WEB + 'v=01&k=' + K, WEB + 'v=%31&k=' + K,
      WEB + 'k=' + K, WEB + 'v=1', WEB + 'v=1&k=', WEB + FRAGMENT.replace('k=', '%6b='),
    ]) expect(() => parseInviteLink(uri), uri).toThrow();
  });

  it('rejects malformed and noncanonical base64url keys', () => {
    const noncanonical = K.slice(0, -1) + '9'; // Same decoded bytes, nonzero unused trailing bits.
    for (const k of ['', 'A'.repeat(42), 'A'.repeat(44), K + '=', K.slice(0, -1) + '+',
      K.slice(0, -1) + '/', '%41' + K.slice(1), 'AA%ZZ', noncanonical]) {
      expect(() => parseInviteLink(WEB + 'v=1&k=' + k)).toThrow();
      expect(() => deriveInviteLinkKeys(k)).toThrow();
    }
  });

  it('rejects relay URLs, credentials, paths and encoded delimiters in r', () => {
    for (const r of ['', 'https://relay.example', 'user@relay.example', 'relay.example/path', 'relay.example?x',
      'relay.example#x', 'relay.example\\path', 'relay.example%2Fpath', 'relay.example%3Fx',
      'user%40relay.example', 'relay.example%252Fpath', 'relay.example%00', 'relay.example%0A', '%ZZ', 'relay.example:99999'])
      expect(() => parseInviteLink(WEB + FRAGMENT + '&r=' + r), r).toThrow();
  });
});
