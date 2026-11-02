// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { createRelayAuthToken, generateKeyPair, signEnvelope } from '../packages/core/src/index.js';
import type { Json, KeyPair } from '../packages/core/src/index.js';

export const origin = 'https://relay.example';
export const start = Date.parse('2026-11-02T00:00:00Z');
export const day = 86_400_000;
export const sender = generateKeyPair();
export const recipient = generateKeyPair();
export function envelope(payload: Json = { content: '保留中' }, from = sender, to = recipient, encrypt = true) {
  return signEnvelope({ taskId: 'task_' + randomUUID(), recipientDid: to.did, seq: 0,
    eventType: 'PROPOSE', payload }, from, { encrypt });
}
export function post(value: unknown, prefix = '') {
  return new Request(origin + prefix + '/envelopes', { method: 'POST', body: JSON.stringify(value) });
}
export function authorized(path: string, key: KeyPair, now: number, method = 'GET') {
  return new Request(origin + path, { method, headers: {
    authorization: 'Bearer ' + createRelayAuthToken(key, { origin, now: new Date(now).toISOString() }),
  } });
}
export function statusPath(id: string) {
  return '/delivery-status?recipient=' + encodeURIComponent(recipient.did) +
    '&sender=' + encodeURIComponent(sender.did) + '&envelopeId=' + encodeURIComponent(id);
}
export function memoryStorage() {
  const values = new Map<string, unknown>();
  const puts: string[] = [];
  let failure: string | undefined;
  const pending: Promise<unknown>[] = [];
  const state = {
    storage: {
      async get<T>(key: string) { return structuredClone(values.get(key)) as T | undefined; },
      async put(key: string, value: unknown) {
        puts.push(key);
        if (failure === key) { failure = undefined; throw new Error('TEST_STORAGE_WRITE'); }
        values.set(key, structuredClone(value));
      },
      async delete(key: string) { return values.delete(key); },
      setAlarm: vi.fn(async (_at: number | Date) => {}),
      deleteAlarm: vi.fn(async () => {}),
    },
    blockConcurrencyWhile<T>(fn: () => Promise<T>) { return fn(); },
    waitUntil(work: Promise<unknown>) { pending.push(work); },
  };
  return { values, puts, state,
    failNext(key: string) { failure = key; },
    async settled() { while (pending.length) await Promise.all(pending.splice(0)); },
  };
}
