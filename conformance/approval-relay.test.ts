import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { generateKeyPair, signPayload } from '../packages/core/src/index.js';
import { ApprovalDurableObject } from '../packages/relay/src/approvals.js';
import { handleRelayEdge } from '../packages/relay/src/worker.js';

describe('opaque approval relay mailbox', () => {
  it('persists ciphertext across instances, authenticates access, and expires with an alarm', async () => {
    let value: unknown, alarm: number | Date | undefined;
    const state = {
      storage: {
        get: async <T>() => value as T,
        put: async (_key: string, v: unknown) => {
          value = structuredClone(v);
        },
        setAlarm: async (at: number | Date) => {
          alarm = at;
        },
      },
    };
    const object = new ApprovalDurableObject(state),
      owner = generateKeyPair(),
      id = 'ab'.repeat(32),
      access = 'private-capability';
    const url = 'https://relay.example/v1/approvals/' + id;
    const signed = signPayload(
      {
        id,
        ownerDid: owner.did,
        expiresAt: Date.now() + 60000,
        accessHash: createHash('sha256').update(access).digest('base64url'),
        request: 'encrypted-only',
      },
      owner,
    );
    expect(
      (await object.fetch(new Request(url, { method: 'POST', body: JSON.stringify(signed) })))
        .status,
    ).toBe(201);
    expect(alarm).toBe(signed.payload.expiresAt);
    const restarted = new ApprovalDurableObject(state);
    expect((await restarted.fetch(new Request(url))).status).toBe(404);
    const headers = { authorization: 'Bearer ' + access };
    const request = await restarted.fetch(new Request(url, { headers }));
    expect(request.headers.get('access-control-allow-origin')).toBe('https://sealbridge.app');
    expect(await request.json()).toEqual({ request: 'encrypted-only' });
    expect(
      (
        await restarted.fetch(
          new Request(url + '/results', {
            method: 'POST',
            headers,
            body: JSON.stringify({ result: 'encrypted-result' }),
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      await (await restarted.fetch(new Request(url + '/results', { headers }))).json(),
    ).toEqual({ results: ['encrypted-result'] });
    expect(
      (await restarted.fetch(new Request(url, { method: 'POST', body: JSON.stringify(signed) })))
        .status,
    ).toBe(400);
    await restarted.alarm();
    expect((await restarted.fetch(new Request(url, { headers }))).status).toBe(410);
  });
  it('rejects unsigned creation, oversized bodies, unknown paths and unsupported production bindings', async () => {
    const object = new ApprovalDurableObject({
        storage: { get: async () => undefined, put: async () => {} },
      }),
      url = 'https://relay.example/v1/approvals/' + 'cd'.repeat(32);
    expect((await object.fetch(new Request(url, { method: 'POST', body: '{}' }))).status).toBe(400);
    expect(
      (
        await object.fetch(
          new Request(url, { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024 + 1) }),
        )
      ).status,
    ).toBe(400);
    expect((await object.fetch(new Request(url + '/bad'))).status).toBe(404);
    const response = await handleRelayEdge(new Request(url), {
      RELAY: {
        idFromName: (n) => n,
        get: () => ({
          fetch: async () => {
            throw new Error('unexpected existing relay route');
          },
        }),
      },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'APPROVAL_UNSUPPORTED_RELAY' });
  });
});
