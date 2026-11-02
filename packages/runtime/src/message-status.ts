// SPDX-License-Identifier: Apache-2.0
import type { SignedDeliveryStatus } from '@acp/core';
import type { DeliveryStore } from './delivery-store.js';
import { deliveryError } from './delivery-records.js';
import type { MessageStatus } from './delivery-records.js';

export type MessageStatusSelector = { messageId: string; taskId?: never } | { taskId: string; messageId?: never };
export type MessageStatusResult = { found: false } | {
  found: true; messageId: string; taskId: string; peerDid: string;
  status: MessageStatus; source: 'local' | 'relay' | 'recipient' | 'reply';
  createdAt: number; updatedAt: number; deliveryDeadline: number; retainUntil: number;
  retry: { pending: boolean; attemptCount: number; nextAttemptAt: number | null };
  recipientStatus: SignedDeliveryStatus | null;
};

/** Read sender-local facts without starting delivery, changing records or pruning expired bytes. */
export function messageStatus(store: DeliveryStore, selector: MessageStatusSelector): MessageStatusResult {
  const matches = selector.messageId !== undefined
    ? [store.getMessage(selector.messageId)].flatMap(r => r ? [r] : [])
    : store.findTask(selector.taskId);
  if (matches.length > 1) throw deliveryError('MESSAGE_STATUS_AMBIGUOUS');
  const message = matches[0];
  if (!message) return { found: false };
  const proposal = store.read('outbox', message.messageId);
  const pending = message.status === 'queued' && proposal?.state === 'pending' && store.now() < message.deliveryDeadline;
  // C4 verifies the recipient binding and pins disclosure before publishing each event.
  const recipientStatus = message.protocolVersion === '0.2.0' && message.remoteStatus &&
    store.now() < message.remoteStatus.payload.retainUntil ? message.remoteStatus : null;
  const source = message.status === 'replied' ? 'reply'
    : recipientStatus?.payload.state === message.status ? 'recipient'
    : message.status === 'relayed' ? 'relay' : 'local';
  return {
    found: true, messageId: message.messageId, taskId: message.taskId, peerDid: message.peerOwnerDid,
    status: message.status, source, createdAt: message.createdAt, updatedAt: message.updatedAt,
    deliveryDeadline: message.deliveryDeadline, retainUntil: message.retainUntil,
    // C1 removes completed batch members; absent attempt metadata is reported as zero.
    retry: { pending, attemptCount: proposal?.attemptCount ?? 0, nextAttemptAt: pending ? proposal.nextAttemptAt : null },
    recipientStatus,
  };
}
