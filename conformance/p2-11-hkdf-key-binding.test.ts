// SPDX-License-Identifier: Apache-2.0
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
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  decryptEnvelopePayload,
  encryptEnvelopePayload,
  envelopeHkdfInfo,
  generateKeyPair,
  isEncryptedEnvelopePayload,
} from '../packages/core/src/index.js';
import type {
  EncryptedEnvelopePayload,
  EnvelopeHeaderContext,
  Json,
  KeyPair,
  SignedEnvelope,
} from '../packages/core/src/index.js';
import { AUDIT_VALID_WITHOUT_TRUST_ANCHOR, verifyAudit } from '../packages/ledger/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import {
  PolicyAutoApprovalProvider,
  RequesterClient,
  WorkerNode,
} from '../packages/runtime/src/index.js';

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

function headerAad(context: EnvelopeHeaderContext): Buffer {
  return Buffer.from(
    canonicalize({
      taskId: context.taskId,
      seq: context.seq,
      eventType: context.eventType,
      senderDid: context.senderDid,
      recipientDid: context.recipientDid,
    }),
    'utf8',
  );
}

/** Independent Ed25519-seed to X25519 conversion, matching RFC 8032 / RFC 7748. */
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

function rawPublicKey(key: KeyObject): Buffer {
  const raw = key.export({ format: 'der', type: 'spki' }).subarray(-32);
  if (raw.length !== 32) throw new Error('INVALID_PUBLIC_KEY');
  return Buffer.from(raw);
}

function importEphemeralPublic(encoded: string): KeyObject {
  const raw = Buffer.from(encoded, 'base64url');
  const der = raw.length === 32 ? Buffer.concat([X25519_SPKI_PREFIX, raw]) : raw;
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function seal(
  payload: Json,
  recipientPublic: KeyObject,
  aad: Buffer,
  infoFor: (ephemeralRaw: Uint8Array) => Buffer,
): EncryptedEnvelopePayload {
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralRaw = rawPublicKey(ephemeral.publicKey);
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipientPublic,
  });
  const iv = randomBytes(12);
  const info = infoFor(ephemeralRaw);
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

function openWith(
  payload: EncryptedEnvelopePayload,
  recipientPrivate: KeyObject,
  info: Buffer,
  aad: Buffer,
): Json {
  const shared = diffieHellman({
    privateKey: recipientPrivate,
    publicKey: importEphemeralPublic(payload.ephemeralPublicKey),
  });
  const iv = Buffer.from(payload.iv, 'base64url');
  const key = Buffer.from(hkdfSync('sha256', shared, iv, info, 32));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64url'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString('utf8')) as Json;
}

describe('P2-11 HKDF info binds both X25519 public keys', () => {
  const alice = generateKeyPair();
  const bob = generateKeyPair();
  const context: EnvelopeHeaderContext = {
    taskId: 'task_hkdf_binding',
    seq: 3,
    eventType: 'PROPOSE',
    senderDid: alice.did,
    recipientDid: bob.did,
  };
  const plaintext = { secret: 'p2-11-payload-secret', token: 'CapabilityToken' };
  const bobPrivate = x25519PrivateFromKey(bob);
  const bobPublic = createPublicKey(bobPrivate);
  const bobRaw = rawPublicKey(bobPublic);
  const aad = headerAad(context);

  it('derives the AES key with info bound to the ephemeral and recipient public keys', () => {
    const encrypted = encryptEnvelopePayload(plaintext, context);
    expect(isEncryptedEnvelopePayload(encrypted)).toBe(true);
    const ephemeralRaw = rawPublicKey(importEphemeralPublic(encrypted.ephemeralPublicKey));
    const info = envelopeHkdfInfo(context, ephemeralRaw, bobRaw);
    const parsed = JSON.parse(info.toString('utf8')) as {
      taskId: string;
      seq: number;
      eventType: string;
      senderDid: string;
      recipientDid: string;
      ephemeralPublicKey: string;
      recipientPublicKey: string;
    };
    expect(parsed).toMatchObject({
      taskId: context.taskId,
      seq: context.seq,
      eventType: context.eventType,
      senderDid: context.senderDid,
      recipientDid: context.recipientDid,
      ephemeralPublicKey: Buffer.from(ephemeralRaw).toString('base64url'),
      recipientPublicKey: bobRaw.toString('base64url'),
    });
    expect(info.equals(aad)).toBe(false);
    expect(envelopeHkdfInfo(context, ephemeralRaw, bobRaw).equals(info)).toBe(true);
    expect(openWith(encrypted, bobPrivate, info, aad)).toEqual(plaintext);
    expect(() => openWith(encrypted, bobPrivate, aad, aad)).toThrow();
    expect(() => openWith(encrypted, bobPrivate, info, info)).toThrow();
    expect(decryptEnvelopePayload(encrypted, bob, context)).toEqual(plaintext);
  });

  it('rejects a ciphertext derived with header-only HKDF info', () => {
    const legacy = seal(plaintext, bobPublic, aad, () => aad);
    expect(openWith(legacy, bobPrivate, aad, aad)).toEqual(plaintext);
    expect(() => decryptEnvelopePayload(legacy, bob, context)).toThrow(
      'ENVELOPE_DECRYPTION_FAILED',
    );
  });

  it('rejects an altered ephemeral public key or recipient key context', () => {
    const encrypted = encryptEnvelopePayload(plaintext, context);
    const swapped = {
      ...encrypted,
      ephemeralPublicKey: generateKeyPairSync('x25519')
        .publicKey.export({ format: 'der', type: 'spki' })
        .toString('base64url'),
    };
    expect(() => decryptEnvelopePayload(swapped, bob, context)).toThrow(
      'ENVELOPE_DECRYPTION_FAILED',
    );
    const mallory = generateKeyPair();
    const malloryRaw = rawPublicKey(createPublicKey(x25519PrivateFromKey(mallory)));
    const wrongRecipientInfo = seal(plaintext, bobPublic, aad, (ephemeralRaw) =>
      envelopeHkdfInfo(context, ephemeralRaw, malloryRaw),
    );
    expect(() => decryptEnvelopePayload(wrongRecipientInfo, bob, context)).toThrow(
      'ENVELOPE_DECRYPTION_FAILED',
    );
    expect(() =>
      decryptEnvelopePayload(encrypted, bob, { ...context, recipientDid: mallory.did }),
    ).toThrow('ENVELOPE_DECRYPTION_FAILED');
    expect(() => decryptEnvelopePayload(encrypted, mallory, context)).toThrow(
      'ENVELOPE_DECRYPTION_FAILED',
    );
    expect(() =>
      decryptEnvelopePayload(encrypted, bob, { ...context, taskId: 'task_other' }),
    ).toThrow('ENVELOPE_DECRYPTION_FAILED');
  });

  it('settles an encrypted session with VALID audit bundles', async () => {
    const relay = new InMemoryRelay();
    const traffic: SignedEnvelope[] = [];
    const send = relay.send.bind(relay);
    relay.send = (envelope) => {
      traffic.push(structuredClone(envelope));
      send(envelope);
    };
    const input = { marker: 'p2-11-session-secret' };
    const worker = new WorkerNode({ checkPeer: () => 'trusted',
      owner: bob,
      relay,
      adapter: {
        id: 'echo',
        name: 'Echo',
        skills: [],
        executeTask: async (task) => ({ echoed: task.input }),
      },
      approvalProvider: new PolicyAutoApprovalProvider(bob),
      timeoutMs: 10000,
    });
    const requester = new RequesterClient({
      owner: alice,
      relay,
      approvalProvider: new PolicyAutoApprovalProvider(alice),
      timeoutMs: 10000,
    });
    const pending = worker.start({ once: true });
    const result = await requester.delegate({
      to: worker.invite(),
      title: 'HKDF key binding',
      description: 'Echo the input through an encrypted session',
      input,
    });
    const settled = await pending;
    worker.stop();
    expect(result.state).toBe('SETTLED');
    expect(settled?.state).toBe('SETTLED');
    expect(result.deliverable).toEqual({ echoed: input });
    expect(verifyAudit(result.bundle)).toEqual({
      valid: true,
      status: 'VALID',
      statusLabel: AUDIT_VALID_WITHOUT_TRUST_ANCHOR,
      trustAnchorVerified: false,
      truncationChecked: false,
    });
    expect(verifyAudit(settled!.bundle)).toEqual({
      valid: true,
      status: 'VALID',
      statusLabel: AUDIT_VALID_WITHOUT_TRUST_ANCHOR,
      trustAnchorVerified: false,
      truncationChecked: false,
    });
    expect(traffic.length).toBeGreaterThan(0);
    for (const envelope of traffic)
      expect(isEncryptedEnvelopePayload(envelope.payload.payload)).toBe(true);
    expect(JSON.stringify(traffic)).not.toContain('p2-11-session-secret');
  });
});
