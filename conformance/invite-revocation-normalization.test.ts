// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import {
  createRevocationNotice,
  generateKeyPair,
  inviteRevocationId,
  parseAndVerifyInviteToken,
  RevocationRegistry,
  verifyRevocationNotice,
} from '../packages/core/src/index.js';
import type { Json } from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import {
  deliverRevocation,
  PolicyAutoApprovalProvider,
  RequesterClient,
  WorkerNode,
} from '../packages/runtime/src/index.js';

type Spelling = 'prefixed' | 'uri' | 'raw' | 'reserialized';

function spell(token: string, spelling: Spelling): string {
  const raw = token.slice('acp-invite:'.length);
  if (spelling === 'raw') return raw;
  if (spelling === 'prefixed') return token;
  if (spelling === 'uri') return 'acp://invite?token=' + raw;
  const signed = JSON.parse(Buffer.from(raw, 'base64url').toString());
  signed.payload = Object.fromEntries(Object.entries(signed.payload).reverse());
  const serialized = JSON.stringify({ signature: signed.signature, payload: signed.payload }, null, 2);
  return 'acp://invite?token=' + Buffer.from(serialized).toString('base64url');
}

function fixture(relayUrl?: string, expiresInSeconds?: number) {
  const owner = generateKeyPair();
  const relay = new InMemoryRelay();
  const registry = new RevocationRegistry();
  const calls: Json[] = [];
  const events: string[] = [];
  const worker = new WorkerNode({ checkPeer: () => 'trusted',
    owner,
    relay,
    relayUrl, allowPrivateRelay: relayUrl?.startsWith('http://127.'),
    revocation: registry,
    adapter: {
      id: 'normalization-echo',
      name: 'Normalization echo',
      skills: [],
      executeTask: async (context) => {
        calls.push(context.input);
        return context.input;
      },
    },
    approvalProvider: new PolicyAutoApprovalProvider(owner),
    onEvent: (event) => events.push(event),
    timeoutMs: 10000,
  });
  const token = worker.invite(expiresInSeconds);
  const noticeFor = (targetId: string, issuer = owner) =>
    createRevocationNotice({ targetType: 'invite', targetId, reason: 'rotation' }, issuer);
  return { owner, relay, registry, calls, events, worker, token, noticeFor };
}

async function expectAdmissionRevoked(
  context: ReturnType<typeof fixture>,
  to: string,
  mode: 'runOnce' | 'start' = 'runOnce',
) {
  const requester = generateKeyPair();
  const client = new RequesterClient({
    owner: requester,
    relay: context.relay,
    approvalProvider: new PolicyAutoApprovalProvider(requester),
    timeoutMs: 10000,
  });
  const running = mode === 'runOnce' ? context.worker.runOnce() : context.worker.start({ once: true });
  try {
    const results = await Promise.allSettled([
      running,
      client.delegate({ to, title: 'Invite normalization', description: 'Admission validation', input: {} }),
    ]);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(String(result.reason)).toContain('TOKEN_REVOKED');
    }
    expect(context.calls).toEqual([]);
    expect(context.events).not.toContain('ACCEPT');
  } finally {
    context.worker.stop();
    await running.catch(() => undefined);
  }
}

describe('invite revocation normalization', () => {
  it.each(['prefixed', 'uri', 'raw', 'reserialized'] as const)(
    'registers %s invite targets under the verified payload identifier',
    (spelling) => {
      const { registry, token, noticeFor } = fixture();
      const notice = noticeFor(spell(token, spelling));
      registry.revoke(notice);
      for (const equivalent of ['prefixed', 'uri', 'raw', 'reserialized'] as const) {
        expect(registry.isRevoked('invite', spell(token, equivalent))).toBe(true);
        expect(inviteRevocationId(spell(token, equivalent))).toBe(inviteRevocationId(token));
      }
      expect(registry.noticesFor('invite', inviteRevocationId(token))).toEqual([notice]);
    },
  );

  it.each(['prefixed', 'uri', 'raw', 'reserialized'] as const)(
    'checks normalized %s revocations before admission',
    async (spelling) => {
      const context = fixture();
      context.registry.revoke(context.noticeFor(spell(context.token, spelling)));
      const presented = spelling === 'uri' || spelling === 'reserialized' ? 'prefixed' : 'reserialized';
      await expectAdmissionRevoked(context, spell(context.token, presented));
    },
  );

  it.each(['prefixed', 'uri'] as const)(
    'checks stable identifier revocations for the %s invite form',
    async (spelling) => {
      const context = fixture();
      context.registry.revoke(context.noticeFor(inviteRevocationId(context.token)));
      await expectAdmissionRevoked(context, spell(context.token, spelling));
    },
  );

  it.each([3600001, 2 * 24 * 60 * 60 * 1000])(
    'normalizes historical invites after %i milliseconds',
    (elapsed) => {
      const { registry, token, noticeFor } = fixture(undefined, 3600);
      const targetId = inviteRevocationId(token);
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + elapsed);
      try {
        expect(() => parseAndVerifyInviteToken(token)).toThrow('INVITE_EXPIRED');
        expect(inviteRevocationId(token)).toBe(targetId);
        registry.revoke(noticeFor(spell(token, 'uri')));
        const copy = new RevocationRegistry();
        copy.importNotices(JSON.parse(JSON.stringify(registry.exportNotices())));
        expect(() => copy.assertNotRevoked('invite', spell(token, 'reserialized'))).toThrow('TOKEN_REVOKED');
        expect(copy.isRevoked('invite', targetId)).toBe(true);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it('preserves signed notices while rebuilding normalized lookup on import', async () => {
    const context = fixture();
    const notice = context.noticeFor(context.token);
    const original = JSON.stringify(notice);
    const registry = new RevocationRegistry();
    registry.revoke(notice);
    registry.revoke(notice);
    const exported = JSON.stringify(registry.exportNotices());
    expect(exported).toBe('[' + original + ']');
    const copy = new RevocationRegistry();
    copy.importNotices(JSON.parse(exported));
    expect(verifyRevocationNotice(copy.exportNotices()[0]!, context.owner.did)).toBe(true);
    expect(JSON.stringify(copy.exportNotices())).toBe(exported);
    expect(copy.noticesFor('invite', spell(context.token, 'uri'))).toEqual([notice]);
    context.registry.importNotices(copy.exportNotices());
    await expectAdmissionRevoked(context, spell(context.token, 'reserialized'));
  });

  it.each(['prefixed', 'uri', 'raw', 'reserialized'] as const)(
    'requires the invite owner for normalized %s targets',
    (spelling) => {
      const { registry, token, noticeFor } = fixture();
      const notice = noticeFor(spell(token, spelling), generateKeyPair());
      expect(() => registry.revoke(notice)).toThrow('INVALID_REVOCATION_ISSUER');
      expect(() => registry.importNotices([notice])).toThrow('INVALID_REVOCATION_ISSUER');
      expect(registry.isRevoked('invite', inviteRevocationId(token))).toBe(false);
      expect(registry.exportNotices()).toEqual([]);
    },
  );

  it('retains exact-string lookup for unverifiable invite targets', () => {
    const { registry, token, noticeFor } = fixture();
    const raw = spell(token, 'raw');
    const signed = JSON.parse(Buffer.from(raw, 'base64url').toString());
    signed.payload.expiresAt = new Date(Date.now() + 7200000).toISOString();
    const target = 'acp-invite:' + Buffer.from(JSON.stringify(signed)).toString('base64url');
    registry.revoke(noticeFor(target));
    expect(registry.isRevoked('invite', target)).toBe(true);
    expect(registry.isRevoked('invite', spell(target, 'uri'))).toBe(false);
    expect(registry.isRevoked('invite', inviteRevocationId(token))).toBe(false);
  });

  it('normalizes local relay invite targets without dialing the relay', () => {
    const { registry, token, noticeFor } = fixture('http://127.0.0.1:8787');
    registry.revoke(noticeFor(token));
    const targetId = inviteRevocationId(token, { allowPrivateRelay: true });
    expect(registry.isRevoked('invite', targetId)).toBe(true);
    expect(registry.isRevoked('invite', spell(token, 'reserialized'))).toBe(true);
  });

  it.each(['runOnce', 'start'] as const)(
    'normalizes queued invite notices before admission via %s',
    async (mode) => {
      const context = fixture();
      const notice = context.noticeFor(spell(context.token, 'uri'));
      await deliverRevocation({
        relay: context.relay,
        from: context.owner,
        recipientDid: context.owner.did,
        notice,
      });
      await expectAdmissionRevoked(context, spell(context.token, 'reserialized'), mode);
      expect(context.registry.noticesFor('invite', inviteRevocationId(context.token))).toEqual([notice]);
      expect(context.worker.revocation.isRevoked('invite', context.token)).toBe(true);
    },
  );
});
