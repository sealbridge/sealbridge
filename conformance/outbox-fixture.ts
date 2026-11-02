// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, signEnvelope } from '../packages/core/src/index.js';
import type { KeyPair } from '../packages/core/src/index.js';
import type { RelayTransport } from '../packages/relay/src/index.js';
import { GatewayDeliveryService } from '../packages/runtime/src/outbox.js';
import type { GatewayDeliveryOptions } from '../packages/runtime/src/outbox.js';

export const outboxOrigin = 'https://relay.example';
export function outboxFixture(options: Partial<GatewayDeliveryOptions> = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'outbox-'));
  const identityOptions = { env: { SEALBRIDGE_DATA_DIR: join(root, 'data') } };
  const owner = generateKeyPair(), peer = generateKeyPair();
  let now = Date.now();
  const epoch = now;
  const sleeps: number[] = [];
  const posted: unknown[] = [];
  const relay: RelayTransport = { send: e => { posted.push(structuredClone(e)); }, receive: () => undefined };
  const serviceOptions: GatewayDeliveryOptions = { identityOptions, now: () => now,
    sleep: async ms => { sleeps.push(ms); now += ms; }, resolveTransport: () => relay, ...options };
  const service = new GatewayDeliveryService(owner, serviceOptions);
  function frame(seq = 0, eventType = 'PROPOSE') {
    return signEnvelope({ taskId: 'task_outbox', recipientDid: peer.did, seq, eventType,
      payload: { input: 'local ciphertext fixture' } }, owner, { encrypt: true });
  }
  function prepare(two = false, deadline = epoch + 86400_000) {
    const first = frame();
    const frames = two ? [first, frame(1, 'AUDIT_ENTRY')] : [first];
    const context = { messageId: first.payload.envelopeId, peerOwnerDid: peer.did, relayUrl: outboxOrigin,
      deliveryDeadline: deadline, message: { taskId: first.payload.taskId, peerAgentDid: peer.did, protocolVersion: '0.2.0' as const } };
    return { frames, first, context };
  }
  const services = [service];
  return { root, identityOptions, owner, peer, epoch, posted, sleeps, relay, service, frame, prepare,
    now: () => now, setNow: (n: number) => { now = n; },
    restart: (key: KeyPair = owner, changes: Partial<GatewayDeliveryOptions> = {}) => {
      const s = new GatewayDeliveryService(key, { ...serviceOptions, ...changes }); services.push(s); return s;
    },
    cleanup: () => { services.forEach(s => s.stop()); rmSync(root, { recursive: true, force: true }); },
  };
}

/** Count the synchronous operations that dominate delegation on filesystem-backed gateways. */
export const deliveryFsOperations = ['openSync', 'writeSync', 'fsyncSync', 'renameSync', 'readFileSync',
  'readdirSync', 'statSync', 'unlinkSync', 'lstatSync', 'fstatSync', 'readSync', 'closeSync', 'mkdirSync'] as const;
export function countDeliveryFs(io: typeof fs = fs) {
  const counts = Object.fromEntries(deliveryFsOperations.map(name => [name, 0])) as Record<typeof deliveryFsOperations[number], number>;
  const asyncCounts = { write: 0, fsync: 0 };
  const wrapped: typeof fs = { ...io };
  for (const name of deliveryFsOperations) {
    const original = io[name] as (...args: unknown[]) => unknown;
    Object.assign(wrapped, { [name]: (...args: unknown[]) => { counts[name]++; return original(...args); } });
  }
  for (const name of ['write', 'fsync'] as const) {
    const original = io[name] as (...args: unknown[]) => unknown;
    Object.assign(wrapped, { [name]: Object.assign((...args: unknown[]) => { asyncCounts[name]++; return original(...args); }, io[name]) });
  }
  return { fs: wrapped, counts, asyncCounts, reset: () => {
    for (const name of deliveryFsOperations) counts[name] = 0;
    asyncCounts.write = 0; asyncCounts.fsync = 0;
  },
    total: () => deliveryFsOperations.slice(0, 8).reduce((sum, name) => sum + counts[name], 0) };
}
