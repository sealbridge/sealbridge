// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { digest, signPayload, verifySigned } from '@acp/core';
import type { KeyPair, Signed, SignedEnvelope } from '@acp/core';
import { checkPath, inspectDirectory, privateDirectory, readPrivateFile, resolveDataRoot, writePrivateFile } from './local-identity.js';
import type { LocalIdentityOptions } from './local-identity.js';
import {
  DEFAULT_DELIVERY_LIMITS, DELIVERY_RETENTION_MS, UUID, deliveryError, effectiveMessage,
  requireDelivery, receiptFileId, validateDeliveryRecord, validateSignedShape,
} from './delivery-records.js';
import type { DeliveryLimits, DeliveryRecords, InboundReceiptV1, MessageRecordV1, OutboxBatchV1, OutboxRecordV1 } from './delivery-records.js';

export interface DeliveryStoreOptions extends LocalIdentityOptions { now?: () => number; limits?: Partial<DeliveryLimits> }
export function deliveryRoot(did: string, options: LocalIdentityOptions = {}): string {
  return join(resolveDataRoot(options), 'delivery', createHash('sha256').update(did, 'utf8').digest('hex'));
}
const kinds = ['messages', 'outbox', 'batches', 'receipts'] as const;
type Kind = keyof DeliveryRecords;
const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;
const VERIFIED_CACHE_ENTRIES = 256;
const VERIFIED_CACHE_BYTES = 4 * 1024 * 1024;
function recordIdentity(kind: Kind, id: string, record: DeliveryRecords[Kind]): void {
  const recordId = kind === 'messages' ? (record as MessageRecordV1).messageId
    : 'envelopeId' in record ? record.envelopeId : (record as OutboxBatchV1).batchId;
  requireDelivery(kind === 'receipts' ? receiptFileId(recordId) === receiptFileId(id) : recordId === id);
}

/** Signer-scoped records. Construction and reads have no publication or cleanup side effects. */
class DeliveryStoreImplementation {
  readonly root: string;
  readonly limits: DeliveryLimits;
  readonly io: typeof fs;
  readonly platform: NodeJS.Platform;
  readonly now: () => number;
  private transactionReads?: Map<string, DeliveryRecords[Kind] | undefined>;
  private readonly verified = new Map<string, { data: string; record: DeliveryRecords[Kind] }>();
  private verifiedBytes = 0;
  /** Reuse validation only for identical bytes; every unlocked read still checks the file. */
  private remember(path: string, data: string, record: DeliveryRecords[Kind]): void {
    const previous = this.verified.get(path);
    if (previous) { this.verifiedBytes -= Buffer.byteLength(previous.data); this.verified.delete(path); }
    const bytes = Buffer.byteLength(data);
    if (bytes > VERIFIED_CACHE_BYTES) return;
    while (this.verified.size >= VERIFIED_CACHE_ENTRIES || this.verifiedBytes + bytes > VERIFIED_CACHE_BYTES) {
      const oldest = this.verified.keys().next().value!;
      this.verifiedBytes -= Buffer.byteLength(this.verified.get(oldest)!.data);
      this.verified.delete(oldest);
    }
    this.verified.set(path, { data, record: structuredClone(record) });
    this.verifiedBytes += bytes;
  }
  constructor(readonly owner: KeyPair, readonly options: DeliveryStoreOptions = {}) {
    try { requireDelivery(owner?.privateKey && verifySigned(signPayload({ type: 'DeliveryStore' }, owner), owner.did)); }
    catch { throw deliveryError('OUTBOX_STORE_INVALID'); }
    this.root = deliveryRoot(owner.did, options);
    this.io = options.fs ?? fs; this.platform = options.platform ?? process.platform; this.now = options.now ?? Date.now;
    this.limits = { ...DEFAULT_DELIVERY_LIMITS, ...options.limits };
    requireDelivery(Object.values(this.limits).every(n => Number.isSafeInteger(n) && n > 0));
  }
  path(kind: Kind, id: string): string {
    if (kind === 'receipts') id = receiptFileId(id);
    requireDelivery(UUID.test(id));
    return join(this.root, kind, id + '.json');
  }
  private directories(kind?: Kind): string[] {
    return [dirname(dirname(this.root)), dirname(this.root), this.root, ...(kind ? [join(this.root, kind)] : [])];
  }
  private inspect(kind?: Kind): void {
    for (const dir of this.directories(kind)) {
      try { inspectDirectory(dir, this.io, this.platform); } catch (e) { if (errno(e) !== 'ENOENT') throw e; }
    }
  }
  ids(kind: Kind, onError?: (error: Error) => void): string[] {
    try {
      this.inspect(kind);
      return this.io.readdirSync(join(this.root, kind)).filter(n => n.endsWith('.json')).flatMap(n => {
        const id = n.slice(0, -5);
        if (UUID.test(id)) return [id];
        if (!onError) throw deliveryError('OUTBOX_STORE_INVALID');
        onError(deliveryError('OUTBOX_STORE_INVALID')); return [];
      }).sort();
    } catch (e) { if (errno(e) === 'ENOENT') return []; throw deliveryError('OUTBOX_STORE_INVALID'); }
  }
  read<K extends Kind>(kind: K, id: string): DeliveryRecords[K] | undefined {
    try {
      const path = this.path(kind, id);
      if (this.transactionReads?.has(path)) return structuredClone(this.transactionReads.get(path)) as DeliveryRecords[K] | undefined;
      this.inspect(kind);
      const data = readPrivateFile(path, this.io, this.limits.recordBytes, this.platform);
      if (data === undefined) { this.transactionReads?.set(path, undefined); return; }
      const cached = this.verified.get(path);
      if (cached?.data === data) {
        this.transactionReads?.set(path, cached.record);
        return structuredClone(cached.record) as DeliveryRecords[K];
      }
      const signed: unknown = JSON.parse(data);
      validateSignedShape(signed);
      requireDelivery(verifySigned(signed, this.owner.did));
      validateDeliveryRecord(kind, signed.payload, this.owner.did);
      const r = signed.payload;
      recordIdentity(kind, id, r);
      this.remember(path, data, r);
      this.transactionReads?.set(path, structuredClone(r));
      return r;
    } catch { throw deliveryError('OUTBOX_STORE_INVALID'); }
  }
  snapshot<K extends Kind>(kind: K, onError?: (error: Error) => void): DeliveryRecords[K][] {
    return this.ids(kind, onError).flatMap(id => {
      try { const r = this.read(kind, id); return r ? [r] : []; }
      catch (error) { if (!onError) throw error; onError(deliveryError('OUTBOX_STORE_INVALID')); return []; }
    });
  }
  getMessage(id: string): MessageRecordV1 | undefined {
    const r = this.read('messages', id);
    if (!r || this.now() >= r.retainUntil) return;
    if (r?.status === 'queued') {
      const proposal = this.read('outbox', id);
      if (!proposal || !this.committed(proposal.batchId).length) return;
    }
    return r && effectiveMessage(r, this.now());
  }
  findTask(taskId: string): MessageRecordV1[] {
    return this.snapshot('messages').filter(r => r.taskId === taskId).flatMap(r => this.getMessage(r.messageId) ?? []);
  }
  /** All cross-process changes use this short lock; no callback performs I/O to a relay. */
  transaction<T>(change: () => T): T {
    const lock = join(this.root, '.lock');
    let acquired = false;
    try {
      for (const dir of this.directories()) privateDirectory(dir, this.io, this.platform);
      try { writePrivateFile(lock, Buffer.alloc(0), this.io, this.platform); acquired = true; }
      catch (e) { if (errno(e) === 'EEXIST') throw deliveryError('OUTBOX_STORE_BUSY'); throw e; }
      this.transactionReads = new Map();
      return change();
    } catch (e) {
      if (e instanceof Error && /^(OUTBOX_|DELIVERY_RECORD_CONFLICT)/.test(e.message)) throw e;
      throw deliveryError('OUTBOX_STORE_UNWRITABLE');
    } finally { if (acquired) { this.transactionReads = undefined; this.io.unlinkSync(lock); } }
  }
  /** Caller holds the signer lock. */
  write<K extends Kind>(kind: K, id: string, record: DeliveryRecords[K]): void {
    validateDeliveryRecord(kind, record, this.owner.did);
    recordIdentity(kind, id, record);
    const path = this.path(kind, id), temporary = join(dirname(path), '.' + randomUUID() + '.tmp');
    const bytes = Buffer.from(JSON.stringify(signPayload(record, this.owner)) + '\n');
    if (bytes.length > this.limits.recordBytes) throw deliveryError('OUTBOX_FULL');
    privateDirectory(dirname(path), this.io, this.platform);
    let created = false;
    try {
      writePrivateFile(temporary, bytes, this.io, this.platform); created = true;
      checkPath(path, this.io, this.platform);
      if (this.io.existsSync(path)) {
        const previous = this.read(kind, id);
        if (kind === 'outbox' && previous && 'envelopeDigest' in previous &&
          previous.envelopeDigest !== (record as OutboxRecordV1).envelopeDigest) throw deliveryError('DELIVERY_RECORD_CONFLICT');
      }
      this.io.renameSync(temporary, path); created = false;
      this.remember(path, bytes.toString('utf8'), record);
      this.transactionReads?.set(path, structuredClone(record));
      this.flushDirectory(dirname(path));
    } finally { if (created) this.io.unlinkSync(temporary); }
  }
  private flushDirectory(path: string): void {
    if (this.platform === 'win32') return;
    const fd = this.io.openSync(path, fs.constants.O_RDONLY);
    try { this.io.fsyncSync(fd); } finally { this.io.closeSync(fd); }
  }
  remove(kind: Kind, id: string): void {
    const path = this.path(kind, id);
    checkPath(path, this.io, this.platform);
    if (this.read(kind, id)) {
      this.io.unlinkSync(path);
      this.transactionReads?.set(path, undefined);
      const cached = this.verified.get(path);
      if (cached) { this.verifiedBytes -= Buffer.byteLength(cached.data); this.verified.delete(path); }
      this.flushDirectory(dirname(path));
    }
  }
  assertCapacity(records: OutboxRecordV1[], message?: MessageRecordV1): void {
    const all = this.snapshot('outbox'), active = all.filter(r => r.state === 'pending');
    if (active.length + records.length > this.limits.activeEnvelopes ||
      [...all, ...records].reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r.envelope)), 0) > this.limits.envelopeBytes ||
      records.some(r => Buffer.byteLength(JSON.stringify(r.envelope)) > this.limits.wireBytes) ||
      message && !this.read('messages', message.messageId) && this.ids('messages').length >= this.limits.messages)
      throw deliveryError('OUTBOX_FULL');
  }
  /** Read-only preflight; publication rechecks capacity under the signer lock. */
  checkAvailable(envelopes = 2): void {
    if (this.snapshot('outbox').filter(r => r.state === 'pending').length + envelopes > this.limits.activeEnvelopes ||
        this.ids('messages').length >= this.limits.messages) throw deliveryError('OUTBOX_FULL');
  }
  committed(batchId: string): OutboxRecordV1[] {
    const b = this.read('batches', batchId);
    if (!b) return [];
    const records = b.envelopeIds.map(id => this.read('outbox', id));
    requireDelivery(records.every((r): r is OutboxRecordV1 => !!r && r.batchId === b.batchId && r.messageId === b.messageId));
    const members = records as OutboxRecordV1[];
    requireDelivery(members.every(r => r.localOwnerDid === b.localOwnerDid && r.peerOwnerDid === members[0].peerOwnerDid &&
      r.relayUrl === members[0].relayUrl && r.deliveryDeadline === members[0].deliveryDeadline && r.kind === members[0].kind) &&
      (members.length === 1 || members[0].kind === 'task' && members[1].ordinal === members[0].ordinal + 1 &&
        members[1].envelope.payload.eventType === 'AUDIT_ENTRY' && members[0].envelope.payload.taskId === members[1].envelope.payload.taskId));
    const proposal = members.find(r => r.envelope.payload.eventType === 'PROPOSE');
    if (proposal) {
      const message = this.read('messages', b.messageId);
      requireDelivery(message && message.messageId === proposal.envelopeId && message.proposalEnvelopeDigest === proposal.envelopeDigest &&
        message.peerOwnerDid === proposal.peerOwnerDid && message.relayUrl === proposal.relayUrl &&
        message.taskId === proposal.envelope.payload.taskId && message.deliveryDeadline === proposal.deliveryDeadline);
    }
    return members;
  }
  finishBatch(batchId: string): void {
    const records = this.committed(batchId);
    if (!records.length || records.some(r => r.state === 'pending')) return;
    // The marker is removed first; an interrupted unlink cannot make members dispatchable.
    this.remove('batches', batchId);
    for (const r of records) this.remove('outbox', r.envelopeId);
  }
  receipt(envelope: SignedEnvelope, deadline: number, state: InboundReceiptV1['state'], outcomeCode?: string): InboundReceiptV1 {
    return this.transaction(() => this.receiptLocked(envelope, deadline, state, outcomeCode));
  }
  /** Caller holds the signer lock, including when publishing a task checkpoint. */
  receiptLocked(envelope: SignedEnvelope, deadline: number, state: InboundReceiptV1['state'], outcomeCode?: string): InboundReceiptV1 {
    const id = envelope.payload.envelopeId, prior = this.read('receipts', id), now = this.now();
    if (prior && (prior.envelopeId !== id || prior.senderDid !== envelope.payload.senderDid || prior.taskId !== envelope.payload.taskId || prior.envelopeDigest !== digest(envelope)))
      throw deliveryError('DELIVERY_RECORD_CONFLICT');
    if (!prior && this.ids('receipts').length >= this.limits.receipts) throw deliveryError('OUTBOX_FULL');
    const rank = { persisted: 0, processed: 1, terminal: 2 };
    const r: InboundReceiptV1 = { version: 1, envelopeId: id, localOwnerDid: this.owner.did,
      senderDid: envelope.payload.senderDid, taskId: envelope.payload.taskId, envelopeDigest: digest(envelope),
      receivedAt: prior?.receivedAt ?? now, retainUntil: prior?.retainUntil ?? Math.max(now, deadline) + DELIVERY_RETENTION_MS,
      state: prior && rank[prior.state] > rank[state] ? prior.state : state, ...(outcomeCode ? { outcomeCode } : {}) };
    this.write('receipts', id, r); return r;
  }
  maintain(onError: (error: Error) => void = () => {}): void {
    this.transaction(() => {
      const referenced = new Set<string>();
      for (const id of this.ids('batches', onError)) {
        try {
          for (const member of this.read('batches', id)?.envelopeIds ?? []) referenced.add(member);
          const records = this.committed(id);
          for (const r of records) referenced.add(r.envelopeId);
          // Close members before pruning their message metadata, including after a long shutdown.
          const now = this.now();
          for (const r of records) if (r.state === 'pending' && r.deliveryDeadline <= now) {
            const next = { ...r, state: 'closed' as const, lastError: 'OUTBOX_DEADLINE_EXPIRED' };
            delete next.lease;
            this.write('outbox', r.envelopeId, next);
            const message = r.kind === 'task' && this.read('messages', r.messageId);
            if (message && ['queued', 'relayed'].includes(message.status)) this.write('messages', message.messageId,
              { ...message, status: 'closed', closedBy: 'deadline', lastError: 'OUTBOX_DEADLINE_EXPIRED', updatedAt: now });
          }
          this.finishBatch(id);
        } catch { onError(deliveryError('OUTBOX_STORE_INVALID')); }
      }
      for (const kind of kinds) for (const id of this.ids(kind, onError)) {
        try {
          const r = this.read(kind, id)!;
          if (kind === 'outbox' && !referenced.has(id) || 'retainUntil' in r && r.retainUntil <= this.now()) this.remove(kind, id);
        } catch { onError(deliveryError('OUTBOX_STORE_INVALID')); }
      }
    });
  }
}
export type DeliveryStore = Pick<DeliveryStoreImplementation, keyof DeliveryStoreImplementation>;
export const DeliveryStore: {
  new(owner: KeyPair, options?: DeliveryStoreOptions): DeliveryStore;
  readonly prototype: DeliveryStore;
} = DeliveryStoreImplementation;
