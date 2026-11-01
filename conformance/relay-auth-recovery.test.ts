// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, signEnvelope } from '../packages/core/src/index.js';
import { createRelayFetchHandler, HttpRelayClient, InMemoryRelay, SseRelayClient,
  isTransientRelayError, relayDiagnostic, RelayAuthRecoveryExhaustedError } from '../packages/relay/src/index.js';
import type { RelayClientSecurityOptions } from '../packages/relay/src/index.js';
import { receiveRelay } from '../packages/runtime/src/session-audit.js';

const origin = 'https://relay.example';
const owner = generateKeyPair();
const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('UNEXPECTED_NETWORK'); }));
});
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function bridge(relay = new InMemoryRelay()): typeof fetch {
  const handler = createRelayFetchHandler({ relay });
  return async (input, init) => handler(new Request(input, init));
}
function credential(init?: RequestInit): { nonce: string; timestamp: string; action: string } {
  const token = new Headers(init?.headers).get('authorization')!.slice(7);
  return JSON.parse(Buffer.from(token, 'base64url').toString()).payload;
}
function envelope(taskId = 'auth-recovery') {
  return signEnvelope({ taskId, recipientDid: owner.did, seq: 0, eventType: 'PROPOSE', payload: {} }, owner);
}

describe('bounded relay authentication recovery', () => {
  it.each([1, 2, 3])('recovers after %s rejection(s), signing only after each jittered wait', async failures => {
    const proofs: ReturnType<typeof credential>[] = [];
    const requests: string[] = [];
    const base = bridge();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      proofs.push(credential(init));
      requests.push(String(input));
      return proofs.length <= failures ? new Response('ignored response', { status: 401 }) : base(input, init);
    });
    const client = new HttpRelayClient(origin, fetcher, owner);
    const result = client.pollInbox(owner.did, { role: 'worker', taskId: 'task-a', lease: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (let i = 0; i < failures; i++) {
      const delay = Math.round(250 * 2 ** i * 0.5);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetcher).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetcher).toHaveBeenCalledTimes(i + 2);
    }
    await expect(result).resolves.toBeUndefined();
    expect(new Set(proofs.map(p => p.nonce)).size).toBe(failures + 1);
    expect(new Set(proofs.map(p => p.timestamp)).size).toBe(failures + 1);
    expect(proofs.every(p => p.action === 'receive')).toBe(true);
    expect(new Set(requests).size).toBe(1);
    expect(client.connectionStatus).toBe('connected');
  });

  it('exhausts initial + three attempts and preserves actionable sanitized diagnostics', async () => {
    const fetcher = vi.fn(async () => new Response('private response text', { status: 401 }));
    const client = new HttpRelayClient(origin, fetcher, owner);
    const checked = expect(client.receive(owner.did)).rejects.toMatchObject({
      code: 'RELAY_AUTH_RECOVERY_EXHAUSTED', status: 401, attempts: 3, elapsedMs: 875,
      message: expect.stringContaining('system clock'),
    });
    await vi.advanceTimersByTimeAsync(875);
    await checked;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(client.connectionStatus).toBe('unavailable');
    const error = new RelayAuthRecoveryExhaustedError('receive', 3, 875);
    const wrapped = new TypeError('fetch failed', { cause: error });
    expect(isTransientRelayError(wrapped)).toBe(false);
    expect(relayDiagnostic(wrapped)).toMatchObject({ code: error.code, message: error.message, attempts: 3 });
    expect(JSON.stringify((console.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('private response');
  });

  it.each([401, 403, 400, 404, 422])('keeps HTTP %s fail-fast with zero recovery attempts', async status => {
    const fetcher = vi.fn(async () => new Response('private response text', { status }));
    const client = new HttpRelayClient(origin, fetcher, owner, { maxAuthRecoveryAttempts: 0 });
    await expect(client.receive(owner.did)).rejects.toThrow('RELAY_REJECTED: ' + status);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('never retries a 403 with the default policy', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 403 }));
    await expect(new HttpRelayClient(origin, fetcher, owner).receive(owner.did)).rejects.toMatchObject({ status: 403 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retains one auth budget through intervening transient errors and resets after success', async () => {
    const frame = envelope();
    const outcomes = ['reset', 503, 401, 'reset', 429, 200, 401, 200];
    const fetcher = vi.fn(async () => {
      const next = outcomes.shift();
      if (next === 'reset') throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      return next === 200 ? Response.json(frame) : new Response(null, { status: next as number });
    });
    const client = new HttpRelayClient(origin, fetcher, owner);
    const first = receiveRelay(client, owner.did);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await first).toEqual(frame);
    const second = client.receive(owner.did);
    await vi.advanceTimersByTimeAsync(125);
    expect(await second).toEqual(frame);
    expect(fetcher).toHaveBeenCalledTimes(8);
    expect(outcomes.length).toBe(0);
  });

  it('does not let transient errors start a new episode after the auth budget is spent', async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => new Response(null, { status: ++calls % 2 ? 401 : 503 }));
    const checked = expect(receiveRelay(new HttpRelayClient(origin, fetcher, owner), owner.did))
      .rejects.toMatchObject({ code: 'RELAY_AUTH_RECOVERY_EXHAUSTED', attempts: 3 });
    await vi.advanceTimersByTimeAsync(10_000);
    await checked;
    expect(calls).toBe(4);
  });

  it('clamps hung attempts to the remaining monotonic window despite a wall-clock jump', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockImplementation(() => new Promise(() => {}));
    const client = new HttpRelayClient(origin, fetcher as typeof fetch, owner, { authRecoveryTimeoutMs: 200 });
    const checked = expect(client.receive(owner.did)).rejects.toMatchObject({
      code: 'RELAY_AUTH_RECOVERY_EXHAUSTED', elapsedMs: 200, attempts: 1,
    });
    await vi.advanceTimersByTimeAsync(125);
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    await vi.advanceTimersByTimeAsync(75);
    await checked;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true);
  });

  it('expires during backoff without signing another credential', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 401 }));
    const checked = expect(new HttpRelayClient(origin, fetcher, owner, { authRecoveryTimeoutMs: 100 })
      .receive(owner.did)).rejects.toMatchObject({ code: 'RELAY_AUTH_RECOVERY_EXHAUSTED', attempts: 0 });
    await vi.advanceTimersByTimeAsync(100);
    await checked;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('aborts an auth wait without a late request', async () => {
    const stop = new AbortController();
    const fetcher = vi.fn(async () => new Response(null, { status: 401 }));
    const checked = expect(new HttpRelayClient(origin, fetcher, owner).receive(owner.did, 0, stop.signal))
      .rejects.toThrow('owner stopped');
    await vi.advanceTimersByTimeAsync(0);
    stop.abort(new Error('owner stopped'));
    await checked;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares the recovery attempt bound across concurrent failed reads without sharing responses', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 401 }));
    const client = new HttpRelayClient(origin, fetcher, owner);
    const results = Promise.allSettled([
      client.receive(owner.did, 0, undefined, { taskId: 'one' }),
      client.receive(owner.did, 0, undefined, { taskId: 'two' }),
    ]);
    await vi.advanceTimersByTimeAsync(3000);
    for (const result of await results) expect(result).toMatchObject({ status: 'rejected',
      reason: { code: 'RELAY_AUTH_RECOVERY_EXHAUSTED', attempts: 3 } });
    // Two initial reads share three additional attempts.
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('does not reset a failing read when another identity or operation succeeds', async () => {
    const base = bridge();
    let failingCalls = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.searchParams.get('recipient') === owner.did && !url.searchParams.has('peek') && url.searchParams.get('taskId') !== 'healthy') {
        failingCalls++;
        return new Response(null, { status: 401 });
      }
      return base(input, init);
    };
    const other = generateKeyPair();
    const client = new HttpRelayClient(origin, fetcher, owner, { maxAuthRecoveryAttempts: 1 });
    client.setRecipientKey(other);
    const checked = expect(client.receive(owner.did)).rejects.toMatchObject({ code: 'RELAY_AUTH_RECOVERY_EXHAUSTED' });
    await vi.advanceTimersByTimeAsync(0);
    await client.peek(owner.did);
    await client.receive(owner.did, 0, undefined, { taskId: 'healthy' });
    await client.receive(other.did);
    await vi.advanceTimersByTimeAsync(125);
    await checked;
    expect(failingCalls).toBe(2);
  });

  it.each(['peek', 'wake', 'delivery-status', 'acknowledge'] as const)('recovers %s with fresh receive credentials', async operation => {
    const relay = new InMemoryRelay();
    const base = bridge(relay);
    const frame = envelope();
    let calls = 0;
    const proofs: ReturnType<typeof credential>[] = [];
    let target = false;
    const client = new HttpRelayClient(origin, async (input, init) => {
      if (target) {
        calls++;
        proofs.push(credential(init));
        if (calls === 1) return new Response(null, { status: 401 });
        if (operation === 'wake') return Response.json({ relayDid: owner.did });
        if (operation === 'acknowledge') return new Response(null, { status: 404 });
      }
      return base(input, init);
    }, owner);
    await client.send(frame);
    if (operation === 'acknowledge') await client.receive(owner.did, 0, undefined, { lease: true });
    target = true;
    const result = operation === 'peek' ? client.peek(owner.did)
      : operation === 'wake' ? client.registerWake(owner.did, null)
      : operation === 'delivery-status' ? client.deliveryStatus(frame)
      : client.acknowledgeDelivery(owner.did, frame.payload.envelopeId);
    await vi.advanceTimersByTimeAsync(125);
    await result;
    expect(calls).toBe(2);
    expect(new Set(proofs.map(p => p.nonce)).size).toBe(2);
    expect(new Set(proofs.map(p => p.timestamp)).size).toBe(2);
    expect(proofs.every(p => p.action === 'receive')).toBe(true);
  });

  it.each(['acknowledge', 'wake'] as const)('interrupts %s auth recovery on cancellation', async operation => {
    const stop = new AbortController();
    const frame = envelope();
    let recovering = false;
    const rejected = vi.fn(async () => new Response(null, { status: 401 }));
    const client = new HttpRelayClient(origin, async (input, init) => recovering
      ? rejected() : Response.json(frame), owner);
    await client.receive(owner.did, 0, undefined, { lease: true });
    recovering = true;
    const result = operation === 'acknowledge'
      ? client.acknowledgeDelivery(owner.did, frame.payload.envelopeId, stop.signal)
      : client.registerWake(owner.did, null, stop.signal);
    const checked = expect(result).rejects.toThrow('owner stopped');
    await vi.advanceTimersByTimeAsync(0);
    stop.abort(new Error('owner stopped'));
    await checked;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it('cancels rejected response bodies without reading or logging them', async () => {
    const pull = vi.fn(), cancel = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), { status: 401 }));
    const checked = expect(new HttpRelayClient(origin, fetcher, owner).receive(owner.did))
      .rejects.toThrow('RELAY_AUTH_RECOVERY_EXHAUSTED');
    await vi.advanceTimersByTimeAsync(875);
    await checked;
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(4);
  });

  it('keeps envelope verification terminal after recovering authentication', async () => {
    const tampered = envelope();
    tampered.payload.seq++;
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json(tampered));
    const checked = expect(new HttpRelayClient(origin, fetcher as typeof fetch, owner).receive(owner.did))
      .rejects.toThrow('RELAY_TAMPERING_DETECTED');
    await vi.advanceTimersByTimeAsync(125);
    await checked;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not resend an envelope POST rejected with 401', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 401 }));
    await expect(new HttpRelayClient(origin, fetcher, owner).send(envelope())).rejects.toThrow('RELAY_REJECTED: 401');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('calls a legacy auth provider again, bounding a provider that keeps returning rejected credentials', async () => {
    const provider = vi.fn(() => 'not-a-credential');
    const fetcher = vi.fn(async () => new Response(null, { status: 401 }));
    const checked = expect(new HttpRelayClient(origin, fetcher, provider).receive(owner.did))
      .rejects.toMatchObject({ code: 'RELAY_AUTH_RECOVERY_EXHAUSTED' });
    await vi.advanceTimersByTimeAsync(875);
    await checked;
    expect(provider).toHaveBeenCalledTimes(4);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([
    { maxAuthRecoveryAttempts: -1 }, { maxAuthRecoveryAttempts: 0.5 }, { maxAuthRecoveryAttempts: Infinity },
    { maxAuthRecoveryAttempts: NaN }, { authRecoveryTimeoutMs: 0 }, { authRecoveryTimeoutMs: -1 },
    { authRecoveryTimeoutMs: Infinity }, { authRecoveryTimeoutMs: 2_147_483_648 },
  ] satisfies RelayClientSecurityOptions[])('rejects invalid settings before dispatch: %j', options => {
    const fetcher = vi.fn();
    expect(() => new HttpRelayClient(origin, fetcher, owner, options)).toThrow('INVALID_RELAY_AUTH');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('SSE authentication recovery in the receive pump', () => {
  it('recovers initial and reconnect 401s, retaining queued frames and stream filters', async () => {
    const first = envelope('first'), second = envelope('second');
    const proofs: ReturnType<typeof credential>[] = [];
    const requests: string[] = [];
    let calls = 0;
    const client = new SseRelayClient(origin, async (input, init) => {
      calls++;
      requests.push(String(input));
      proofs.push(credential(init));
      if (calls === 1 || calls === 3) return new Response(null, { status: 401 });
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(calls === 2 ? first : second) + '\n\n'));
        if (calls === 2) controller.close();
      } }));
    }, owner);
    cleanup.push(() => client.close());
    const filter = { role: 'worker' as const, taskId: ['first', 'second'] };
    const receivedFirst = client.receive(owner.did, 30_000, undefined, filter);
    await vi.advanceTimersByTimeAsync(125);
    expect(await receivedFirst).toEqual(first);
    await vi.advanceTimersByTimeAsync(250);
    expect(await client.receive(owner.did, 0, undefined, filter)).toEqual(second);
    expect(calls).toBe(4);
    expect(new Set(requests).size).toBe(1);
    expect(new Set(proofs.map(p => p.nonce)).size).toBe(4);
    expect(proofs.every(p => p.action === 'stream')).toBe(true);
    expect(client.connectionStatus).toBe('connected');
  });

  it('makes exhaustion sticky without a second pump or another auth budget', async () => {
    const fetcher = vi.fn(async () => new Response('ignored response', { status: 401 }));
    const client = new SseRelayClient(origin, fetcher, owner);
    cleanup.push(() => client.close());
    const checked = expect(client.receive(owner.did)).rejects.toMatchObject({ code: 'RELAY_AUTH_RECOVERY_EXHAUSTED' });
    await vi.advanceTimersByTimeAsync(875);
    await checked;
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(client.receive(owner.did)).rejects.toMatchObject({ code: 'RELAY_AUTH_RECOVERY_EXHAUSTED' });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(client.connectionStatus).toBe('unavailable');
  });

  it('stops during authentication backoff without a late SSE connection', async () => {
    const stop = new AbortController();
    const fetcher = vi.fn(async () => new Response(null, { status: 401 }));
    const client = new SseRelayClient(origin, fetcher, owner);
    cleanup.push(() => client.close());
    const checked = expect(client.receive(owner.did, 30_000, stop.signal)).rejects.toThrow('owner stopped');
    await vi.advanceTimersByTimeAsync(0);
    stop.abort(new Error('owner stopped'));
    await checked;
    await client.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
