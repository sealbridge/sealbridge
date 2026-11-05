// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInviteToken, createSignedAgentCard, decryptInviteLink, digest, encryptInviteLink,
  generateInviteLinkKey, inviteLinkVerificationNumber, parseAndVerifyInviteToken,
} from '../packages/core/src/index.js';
import { inviteLinkVerificationNumber as sdkNumber, parseInviteLink as sdkParse } from '../cli/src/sdk.js';
import { inviteLinkVerificationNumber as edgeNumber } from '../packages/core/src/edge.js';

const NOW = Date.parse('2030-01-01T00:00:00.000Z');
const RELAY = 'https://relay.sealbridge.dev';
afterEach(() => vi.useRealTimers());

describe('SC5 link verification number', () => {
  it('matches fixed vectors using UTF-8 digest strings and unsigned big-endian reduction', () => {
    // Independent Python hashlib vectors, including the sha256: prefix.
    expect(inviteLinkVerificationNumber('sha256:' + '00'.repeat(32))).toBe('544163');
    expect(inviteLinkVerificationNumber('sha256:' + 'ff'.repeat(32))).toBe('960087');
    expect(sdkNumber('sha256:' + '00'.repeat(32))).toBe('544163');
    expect(edgeNumber('sha256:' + '00'.repeat(32))).toBe('544163');
    expect(typeof sdkParse).toBe('function');
  });

  it('keeps leading zeros', () => {
    expect(inviteLinkVerificationNumber('sha256:' + '0'.repeat(62) + '8f')).toBe('007755');
  });

  it('gives sender and receiver the same number from the existing verified Invite digest', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    // Public test fixture: Ed25519 seed 00..1f, never an operational identity.
    const owner = { did: 'did:key:z6MkehRgf7yJbgaGfYsdoAsKdBPE3dj2CYhowQdcjqSJgvVd',
      privateKey: '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f\n-----END PRIVATE KEY-----\n' };
    const key = generateInviteLinkKey();
    const fixture = (name: string) => {
      const card = createSignedAgentCard({ name, agentDid: owner.did, relayEndpoint: RELAY,
        skills: [], protocolVersions: ['0.2.0', '0.1.0'], now: NOW,
        expiresAt: '2030-01-04T00:00:00.000Z' }, owner);
      return createInviteToken({ agentCard: card, issuedAt: new Date(NOW).toISOString(), expiresInSeconds: 2 * 86400 }, owner);
    };
    const token = fixture('First invite'), otherToken = fixture('Second invite');
    const senderDigest = digest(parseAndVerifyInviteToken(token, NOW));
    const encrypted = encryptInviteLink(token, key, { relayOrigin: RELAY, now: NOW, expiresAt: '2030-01-02T00:00:00.000Z' });
    const received = decryptInviteLink(encrypted, key, RELAY, NOW);
    const receiverDigest = digest(parseAndVerifyInviteToken(received, NOW));
    expect(receiverDigest).toBe(senderDigest);
    expect(inviteLinkVerificationNumber(receiverDigest)).toBe(inviteLinkVerificationNumber(senderDigest));
    // Distinct fixtures; six-digit numbers can collide in general.
    expect(inviteLinkVerificationNumber(digest(parseAndVerifyInviteToken(otherToken, NOW))))
      .not.toBe(inviteLinkVerificationNumber(senderDigest));
  });

  it('rejects noncanonical or missing digest strings', () => {
    for (const value of ['', '00'.repeat(32), 'sha256:' + 'AA'.repeat(32), 'sha256:abc', 'sha512:' + '00'.repeat(64),
      'sha256:' + '00'.repeat(32) + '\n'])
      expect(() => inviteLinkVerificationNumber(value)).toThrow('INVALID_INVITE_DIGEST');
  });
});
