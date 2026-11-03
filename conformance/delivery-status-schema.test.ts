// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { generateKeyPair, signDeliveryStatus, signPayload, verifyDeliveryStatus, validateSchema, projectDeliveryState } from '../packages/core/src/index.js';
const sender = generateKeyPair(), recipient = generateKeyPair();
const payload = { type: 'DeliveryStatus' as const, version: 1 as const, messageId: randomUUID(), taskId: 'task_schema', senderDid: sender.did,
  recipientDid: recipient.did, state: 'received_held' as const, revision: 1, occurredAt: 1_800_000_000_000, retainUntil: 1_800_604_800_000 };
it.each(['received_held','opened','handed_to_agent','closed'] as const)('validates recipient-signed %s with exact fields', state => {
  const signed = signDeliveryStatus({ ...payload, state }, recipient);
  expect(verifyDeliveryStatus(signed)).toBe(true); expect(() => validateSchema('delivery-status', signed)).not.toThrow();
});
it.each(['input','output','title','reason','inspection','trust','contentDigest'])('rejects extra payload field %s', field => {
  const signed = signPayload({ ...payload, [field]: 'excluded metadata' }, recipient);
  expect(verifyDeliveryStatus(signed)).toBe(false); expect(() => validateSchema('delivery-status', signed)).toThrow();
});
it('rejects incorrect signer, wrapper fields, versions, states and number formats', () => {
  expect(verifyDeliveryStatus(signPayload(payload, sender))).toBe(false);
  for (const change of [{ type: 'RelayDeliveryStatus' }, { version: 2 }, { state: 'replied' }, { messageId: '../message' },
    { revision: 0 }, { revision: 1.5 }, { occurredAt: -1 }, { retainUntil: 0 }, { taskId: '' }])
    expect(verifyDeliveryStatus(signPayload({ ...payload, ...change }, recipient))).toBe(false);
  expect(verifyDeliveryStatus({ ...signPayload(payload, recipient), extra: true })).toBe(false);
  expect(() => validateSchema('delivery-status', { ...signPayload(payload, recipient), extra: true })).toThrow();
});
it('projects coarse and disconnected states through the same disclosure rule', () => {
  for (const disclosure of ['coarse','connected'] as const) for (const connection of ['none','pending','connected','blocked'] as const)
    for (const state of ['received_held','opened','handed_to_agent','closed'] as const)
      expect(projectDeliveryState(state, disclosure, connection)).toBe(connection !== 'blocked' &&
        (state === 'received_held' || state === 'closed' || disclosure === 'connected' && connection === 'connected') ? state : undefined);
});

it('rejects non-date-time signature timestamps and normalizes invalid signing inputs', () => {
  expect(verifyDeliveryStatus(signPayload(payload, recipient, '2026'))).toBe(false);
  expect(() => signDeliveryStatus({ ...payload, occurredAt: Number.NaN }, recipient)).toThrow('INVALID_DELIVERY_STATUS');
});
