// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import {
  createInviteToken,
  createSignedAgentCard,
  generateKeyPair,
  parseAndVerifyInviteToken,
  validateIpAddress,
  validateRelayEndpointUrl,
} from '../packages/core/src/index.js';
import type { RelayLookup } from '../packages/relay/src/index.js';
import {
  HttpRelayClient,
  resolveAndValidateRelayEndpoint,
  startLocalRelay,
} from '../packages/relay/src/index.js';
import { RequesterClient } from '../packages/runtime/src/index.js';

const alice = generateKeyPair();
const bob = generateKeyPair();
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

const blockedByDefault = [
  'http://127.0.0.1',
  'http://localhost',
  'http://10.1.2.3',
  'http://172.16.5.6',
  'http://192.168.1.9',
  'http://100.64.0.1',
  'http://0.0.0.0',
  'http://198.18.0.1',
  'http://169.254.169.254',
  'http://[::1]',
  'http://[fc00::1]',
  'http://[fe80::1]',
  'http://[::ffff:127.0.0.1]',
  'http://[::ffff:100.64.0.1]',
  'http://[::ffff:169.254.169.254]',
];

function inviteFor(relayUrl: string): string {
  const card = createSignedAgentCard(
    { name: 'Bob', agentDid: bob.did, relayEndpoint: relayUrl, skills: [] },
    bob,
  );
  return createInviteToken({ agentCard: card }, bob);
}

function lookupOf(...addresses: string[]): RelayLookup {
  return async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
}

describe('P1-6 SSRF and DNS rebinding', () => {
  it.each(blockedByDefault)('blocks %s by default for URLs and invites', (relayUrl) => {
    expect(() => validateRelayEndpointUrl(relayUrl)).toThrow('SSRF_BLOCKED_RELAY_URL');
    expect(() => parseAndVerifyInviteToken(inviteFor(relayUrl))).toThrow('SSRF_BLOCKED_RELAY_URL');
  });

  it('allows loopback only when allowPrivateRelay is exactly true', () => {
    for (const relayUrl of ['http://127.0.0.1', 'http://localhost']) {
      expect(() => validateRelayEndpointUrl(relayUrl, { allowPrivateRelay: true })).not.toThrow();
      expect(
        parseAndVerifyInviteToken(inviteFor(relayUrl), Date.now(), { allowPrivateRelay: true })
          .relayUrl,
      ).toBe(relayUrl);
    }
    for (const relayUrl of ['http://169.254.169.254', 'http://0.0.0.0']) {
      expect(() => validateRelayEndpointUrl(relayUrl, { allowPrivateRelay: true })).toThrow(
        'SSRF_BLOCKED_RELAY_URL',
      );
      expect(() =>
        parseAndVerifyInviteToken(inviteFor(relayUrl), Date.now(), { allowPrivateRelay: true }),
      ).toThrow('SSRF_BLOCKED_RELAY_URL');
      expect(() =>
        validateIpAddress(new URL(relayUrl).hostname, { allowPrivateRelay: true }),
      ).toThrow('SSRF_BLOCKED_RELAY_URL');
    }
    expect(() => validateIpAddress('100.64.0.1')).toThrow('SSRF_BLOCKED_RELAY_URL');
    expect(() => validateIpAddress('198.18.0.1')).toThrow('SSRF_BLOCKED_RELAY_URL');
    expect(() => validateIpAddress('8.8.8.8')).not.toThrow();
  });

  it.each([
    ['127.0.0.1'],
    ['100.64.0.1'],
    ['169.254.169.254'],
    ['8.8.8.8', '10.0.0.8'],
    ['2001:4860:4860::8888', 'fc00::1'],
  ])('blocks a hostname when any resolved address is disallowed (%j)', async (...addresses) => {
    let fetched = false;
    const fetcher = (async () => {
      fetched = true;
      return new Response('[]');
    }) as typeof fetch;
    const client = new HttpRelayClient('https://rebinding.example/relay', fetcher, {
      lookup: lookupOf(...addresses),
    });
    await expect(client.discover()).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
    expect(fetched).toBe(false);
    await expect(
      resolveAndValidateRelayEndpoint('https://rebinding.example/relay', {
        lookup: lookupOf(...addresses),
      }),
    ).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
  });

  it('blocks a hostname when DNS returns no addresses', async () => {
    const requester = new RequesterClient({
      owner: alice,
      relay: 'https://worker.example',
      lookup: async () => [],
    });
    await expect(
      requester.delegate({
        to: bob.did,
        title: 'Blocked',
        description: 'Empty DNS',
        input: {},
      }),
    ).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
  });

  it('pins later lookups to the address accepted before connect', async () => {
    let calls = 0;
    const lookup: RelayLookup = async () => {
      calls += 1;
      return calls === 1
        ? [{ address: '8.8.8.8', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }];
    };
    const resolved = await resolveAndValidateRelayEndpoint('https://relay.example/v1', { lookup });
    expect(resolved.addresses).toEqual([{ address: '8.8.8.8', family: 4 }]);
    const pinned = await new Promise<Array<{ address: string; family: number }>>(
      (resolve, reject) => {
        resolved.lookup('relay.example', { all: true }, (error, addresses) => {
          if (error) reject(error);
          else resolve(addresses as Array<{ address: string; family: number }>);
        });
      },
    );
    expect(pinned).toEqual([{ address: '8.8.8.8', family: 4 }]);
    expect(calls).toBe(1);
  });

  it('dials the validated address when a later lookup would return metadata', async () => {
    const server = await startLocalRelay();
    closers.push(server.close);
    const port = new URL(server.url).port;
    let calls = 0;
    const lookup: RelayLookup = async () => {
      calls += 1;
      return calls === 1
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '169.254.169.254', family: 4 }];
    };
    const client = new HttpRelayClient('http://pin.example:' + port, {
      allowPrivateRelay: true,
      lookup,
    });
    await expect(client.discover()).resolves.toEqual([]);
    await expect(client.discover()).resolves.toEqual([]);
    expect(calls).toBe(1);
  });
});
