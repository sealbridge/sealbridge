// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { createRelayAuthToken, generateKeyPair, signPayload, verifyRelayAuthToken } from '../packages/core/src/index.js';
import { verifyRelayAuthToken as edgeVerify } from '../packages/core/src/edge.js';
import { createRelayFetchHandler, InMemoryRelay } from '../packages/relay/src/index.js';
import type { RelayAuthAction } from '../packages/core/src/index.js';

const NOW = Date.parse('2030-01-01T00:00:00.000Z');
const ORIGIN = 'https://relay.example';
const owner = generateKeyPair(), other = generateKeyPair();
const actions: RelayAuthAction[] = ['receive', 'stream', 'subscribe', 'invite-manage'];

describe('SC3 additive invite-manage relay authentication', () => {
  it.each(actions)('retains signature, origin, recipient, freshness and nonce checks for %s', action => {
    const options = { now: NOW, expectedOrigin: ORIGIN, requireOrigin: true };
    const token = createRelayAuthToken(owner, { action, origin: 'wss://RELAY.EXAMPLE:443/ws',
      now: new Date(NOW).toISOString(), nonce: 'fixture-nonce' });
    const accepted = { valid: true, nonce: 'fixture-nonce', action };
    expect(verifyRelayAuthToken(token, owner.did, options)).toEqual(accepted);
    expect(edgeVerify(token, owner.did, options)).toEqual(accepted);
    expect(verifyRelayAuthToken(token, owner.did, { ...options, expectedOrigin: 'https://other.example' }))
      .toEqual({ valid: false, error: 'RELAY_AUTH_ORIGIN_MISMATCH', reason: 'RELAY_AUTH_ORIGIN_MISMATCH' });
    expect(verifyRelayAuthToken(token, other.did, options)).toEqual({ valid: false, error: 'RELAY_UNAUTHORIZED' });
    expect(verifyRelayAuthToken(token, owner.did, { ...options, now: NOW + 300001 }).valid).toBe(false);
    const noNonce = createRelayAuthToken(owner, { action, origin: ORIGIN, nonce: '', now: new Date(NOW).toISOString() });
    expect(verifyRelayAuthToken(noNonce, owner.did, options).valid).toBe(false);
    const unbound = createRelayAuthToken(owner, { action, now: new Date(NOW).toISOString() });
    expect(verifyRelayAuthToken(unbound, owner.did, options)).toEqual({
      valid: false, error: 'RELAY_AUTH_ORIGIN_REQUIRED', reason: 'RELAY_AUTH_ORIGIN_REQUIRED',
    });
    expect(verifyRelayAuthToken(unbound, owner.did, { now: NOW, expectedOrigin: ORIGIN }).valid).toBe(true);
    const signed = JSON.parse(Buffer.from(token, 'base64url').toString());
    signed.payload.action = action === 'invite-manage' ? 'receive' : 'invite-manage';
    expect(verifyRelayAuthToken(Buffer.from(JSON.stringify(signed)).toString('base64url'), owner.did, options).valid).toBe(false);
  });

  it('still defaults to receive and rejects unknown signed actions', () => {
    expect(verifyRelayAuthToken(createRelayAuthToken(owner), owner.did)).toMatchObject({ valid: true, action: 'receive' });
    const signed = signPayload({ type: 'RelayAuth', recipientDid: owner.did, action: 'unknown',
      timestamp: new Date(NOW).toISOString(), nonce: 'nonce', origin: ORIGIN }, owner);
    expect(verifyRelayAuthToken(Buffer.from(JSON.stringify(signed)).toString('base64url'), owner.did, { now: NOW }).valid).toBe(false);
  });

  it('does not let invite-manage authenticate existing inbox actions or replay a nonce', () => {
    const relay = new InMemoryRelay();
    const token = createRelayAuthToken(owner, { action: 'invite-manage', origin: ORIGIN });
    for (const action of ['receive', 'stream', 'subscribe'] as const)
      expect(relay.authenticate(owner.did, token, action, { expectedOrigin: ORIGIN, requireOrigin: true })).toBe(false);
    expect(relay.authenticate(owner.did, token, 'invite-manage', { expectedOrigin: ORIGIN, requireOrigin: true })).toBe(true);
    expect(relay.authenticate(owner.did, token, 'invite-manage', { expectedOrigin: ORIGIN, requireOrigin: true })).toBe(false);
  });

  it('rejects invite-manage on the existing HTTP receive endpoint', async () => {
    const response = await createRelayFetchHandler({ relay: new InMemoryRelay() })(
      new Request(ORIGIN + '/envelopes?recipient=' + encodeURIComponent(owner.did), {
        headers: { authorization: 'Bearer ' + createRelayAuthToken(owner, { action: 'invite-manage', origin: ORIGIN }) },
      }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'RELAY_UNAUTHORIZED' });
  });
});
