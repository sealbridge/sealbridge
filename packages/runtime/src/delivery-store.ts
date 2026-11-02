// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { digest, signPayload, verifySigned } from '@acp/core';
import type { KeyPair, SignedEnvelope } from '@acp/core';
import { checkPath, checkStat, inspectDirectory, privateDirectory, readPrivateFile, resolveDataRoot } from './local-identity.js';
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
const kinds = ['messages', 'outbox', 'batches', 'receipts', 'operations', 'idempotency'] as const;
type Kind = keyof DeliveryRecords;
export interface DeliveryWrite { kind: Kind; id: string; record: DeliveryRecords[Kind] }
export interface PreparedDeliveryWrite extends DeliveryWrite { temporary: string; bytes: Buffer; published?: true }
type IdempotencyKind = 'operations' | 'idempotency';
type IdempotencySummary = { operationId: string; retainUntil: number; bytes?: number };
function summarizeIdempotency(record: DeliveryRecords[IdempotencyKind]): IdempotencySummary {
  return { operationId: record.operationId, retainUntil: record.retainUntil,
    bytes: 'response' in record && record.response ? Buffer.byteLength(JSON.stringify(record)) : undefined };
}
type OutboxSummary = Pick<OutboxRecordV1, 'envelopeId' | 'messageId' | 'batchId' | 'state' | 'kind' | 'ordinal' | 'nextAttemptAt' | 'lease'> & { bytes: number };
function summarize(r: OutboxRecordV1): OutboxSummary {
  return { envelopeId: r.envelopeId, messageId: r.messageId, batchId: r.batchId, kind: r.kind,
    state: r.state, ordinal: r.ordinal, nextAttemptAt: r.nextAttemptAt, lease: r.lease ? { ...r.lease } : undefined,
    bytes: Buffer.byteLength(JSON.stringify(r.envelope)) };
}
const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;
// Atomic record replacement changes these attributes, including across store instances.
function fingerprint(stat: fs.BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}
const VERIFIED_CACHE_ENTRIES = 256;
const VERIFIED_CACHE_BYTES = 4 * 1024 * 1024;
function recordIdentity(kind: Kind, id: string, record: DeliveryRecords[Kind]): void {
  const recordId = kind === 'idempotency' ? (record as DeliveryRecords['idempotency']).keyHash
    : kind === 'operations' ? (record as DeliveryRecords['operations']).operationId
    : kind === 'messages' ? (record as MessageRecordV1).messageId
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
  private transactionDirectories?: Set<string>;
  private transactionReads?: Map<string, DeliveryRecords[Kind] | undefined>;
  private readonly verified = new Map<string, { stamp: string; data: string; record: DeliveryRecords[Kind] }>();
  private verifiedBytes = 0;
  private preparedMode = false;
  private outboxIndex?: { stamp: string; entries: Map<string, OutboxSummary> };
  private readonly idempotencyIndexes = new Map<Kind, { stamp: string; entries: Map<string, IdempotencySummary> }>();
  private readonly inspected = new Map<string, string>();
  private readonly listings = new Map<Kind, { stamp: string; ids: string[] }>();
  /** Reuse verified records only while file identity, permissions and timestamps match. */
  private remember(path: string, data: string, record: DeliveryRecords[Kind], stamp = fingerprint(this.io.lstatSync(path, { bigint: true }))): void {
    const previous = this.verified.get(path);
    if (previous) { this.verifiedBytes -= Buffer.byteLength(previous.data); this.verified.delete(path); }
    const bytes = Buffer.byteLength(data);
    if (bytes > VERIFIED_CACHE_BYTES) return;
    while (this.verified.size >= VERIFIED_CACHE_ENTRIES || this.verifiedBytes + bytes > VERIFIED_CACHE_BYTES) {
      const oldest = this.verified.keys().next().value!;
      this.verifiedBytes -= Buffer.byteLength(this.verified.get(oldest)!.data);
      this.verified.delete(oldest);
    }
    this.verified.set(path, { stamp, data, record: structuredClone(record) });
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
    requireDelivery(kind === 'idempotency' ? /^[a-f0-9]{64}$/.test(id) : UUID.test(id));
    return join(this.root, kind, id + '.json');
  }
  private directories(kind?: Kind): string[] {
    return [dirname(dirname(this.root)), dirname(this.root), this.root, ...(kind ? [join(this.root, kind)] : [])];
  }
  private inspectPath(dir: string, create = false): void {
    if (this.transactionDirectories?.has(dir)) return;
    let stat: fs.Stats;
    try { stat = this.io.lstatSync(dir); }
    catch (error) {
      if (!create || errno(error) !== 'ENOENT') throw error;
      privateDirectory(dir, this.io, this.platform);
      stat = this.io.lstatSync(dir);
    }
    checkStat(stat, true);
    const stamp = [stat.dev, stat.ino, stat.mode, stat.uid].join(':');
    if (this.inspected.get(dir) !== stamp) {
      inspectDirectory(dir, this.io, this.platform);
      this.inspected.set(dir, stamp);
    }
    this.transactionDirectories?.add(dir);
  }
  private inspect(kind?: Kind): void {
    if (!this.transactionDirectories) checkPath(dirname(dirname(dirname(this.root))), this.io, this.platform);
    for (const dir of this.directories(kind)) {
      try { this.inspectPath(dir); } catch (e) { if (errno(e) !== 'ENOENT') throw e; }
    }
  }
  private listingStamp(kind: Kind): string {
    try { return fingerprint(this.io.lstatSync(join(this.root, kind), { bigint: true })); }
    catch (error) { if (errno(error) === 'ENOENT') return 'absent'; throw error; }
  }
  ids(kind: Kind, onError?: (error: Error) => void): string[] {
    try {
      this.inspect(kind);
      const stamp = this.listingStamp(kind), cached = this.listings.get(kind);
      if (cached?.stamp === stamp) return [...cached.ids];
      if (stamp === 'absent') { this.listings.set(kind, { stamp, ids: [] }); return []; }
      let invalid = false;
      const ids = this.io.readdirSync(join(this.root, kind)).filter(n => n.endsWith('.json')).flatMap(n => {
        const id = n.slice(0, -5);
        if (kind === 'idempotency' ? /^[a-f0-9]{64}$/.test(id) : UUID.test(id)) return [id];
        if (!onError) throw deliveryError('OUTBOX_STORE_INVALID');
        invalid = true; onError(deliveryError('OUTBOX_STORE_INVALID')); return [];
      }).sort();
      if (!invalid) this.listings.set(kind, { stamp, ids });
      return ids;
    } catch (e) { if (errno(e) === 'ENOENT') return []; throw deliveryError('OUTBOX_STORE_INVALID'); }
  }
  read<K extends Kind>(kind: K, id: string): DeliveryRecords[K] | undefined {
    try {
      const path = this.path(kind, id);
      if (this.transactionReads?.has(path)) return structuredClone(this.transactionReads.get(path)) as DeliveryRecords[K] | undefined;
      this.inspect(kind);
      let stamp: string;
      try {
        const stat = this.io.lstatSync(path, { bigint: true });
        requireDelivery(stat.isFile() && (this.platform === 'win32' || stat.uid === BigInt(process.getuid!()) && (stat.mode & 0o077n) === 0n));
        stamp = fingerprint(stat);
      } catch (error) {
        if (errno(error) !== 'ENOENT') throw error;
        this.transactionReads?.set(path, undefined); return;
      }
      const cached = this.verified.get(path);
      if (cached?.stamp === stamp) {
        this.transactionReads?.set(path, cached.record);
        return structuredClone(cached.record) as DeliveryRecords[K];
      }
      const data = readPrivateFile(path, this.io, kind === 'operations' ? this.limits.operationBytes : this.limits.recordBytes, this.platform);
      requireDelivery(data !== undefined);
      const signed: unknown = JSON.parse(data);
      validateSignedShape(signed);
      requireDelivery(verifySigned(signed, this.owner.did));
      validateDeliveryRecord(kind, signed.payload, this.owner.did);
      const r = signed.payload;
      recordIdentity(kind, id, r);
      // Do not associate bytes read through an old descriptor with a newer replacement.
      if (fingerprint(this.io.lstatSync(path, { bigint: true })) === stamp) this.remember(path, data, r, stamp);
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
  async *scan<K extends Kind>(kind: K, signal: AbortSignal): AsyncGenerator<DeliveryRecords[K]> {
    for (const id of this.ids(kind)) {
      await new Promise<void>(resolve => setImmediate(resolve));
      signal.throwIfAborted();
      const record = this.read(kind, id);
      if (record) yield record;
    }
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
      checkPath(dirname(dirname(dirname(this.root))), this.io, this.platform);
      for (const dir of this.directories()) this.inspectPath(dir, true);
      try {
        // The exclusive empty lock coordinates live writers; it has no recovery payload to flush.
        const fd = this.io.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
          (fs.constants.O_NOFOLLOW ?? 0), 0o600);
        acquired = true;
        try { checkStat(this.io.fstatSync(fd)); } finally { this.io.closeSync(fd); }
      }
      catch (e) { if (errno(e) === 'EEXIST') throw deliveryError('OUTBOX_STORE_BUSY'); throw e; }
      this.transactionReads = new Map();
      this.transactionDirectories = new Set(this.directories());
      return change();
    } catch (e) {
      if (e instanceof Error && /^(OUTBOX_|DELIVERY_RECORD_CONFLICT|IDEMPOTENCY_)/.test(e.message)) throw e;
      throw deliveryError('OUTBOX_STORE_UNWRITABLE');
    } finally { if (acquired) { this.transactionReads = undefined; this.transactionDirectories = undefined; this.io.unlinkSync(lock); } }
  }
  /** Caller holds the signer lock. */
  write<K extends Kind>(kind: K, id: string, record: DeliveryRecords[K]): void {
    validateDeliveryRecord(kind, record, this.owner.did);
    recordIdentity(kind, id, record);
    const listingId = kind === 'receipts' ? receiptFileId(id) : id;
    const path = this.path(kind, id), temporary = join(dirname(path), '.' + randomUUID() + '.tmp');
    const bytes = Buffer.from(JSON.stringify(signPayload(record, this.owner)) + '\n');
    if (bytes.length > (kind === 'operations' ? this.limits.operationBytes : this.limits.recordBytes)) throw deliveryError(kind === 'operations' ? 'IDEMPOTENCY_STORE_FULL' : 'OUTBOX_FULL');
    const retained = this.idempotencyIndexes.get(kind);
    const knownRetained = retained && retained.stamp === this.listingStamp(kind) ? retained : undefined;
    const priorIndex = kind === 'outbox' && this.outboxIndex?.stamp === 'absent' ? this.outboxIndex : undefined;
    this.inspectPath(dirname(path), true);
    if (priorIndex) priorIndex.stamp = this.listingStamp('outbox');
    const listing = this.listings.get(kind);
    const beforeStamp = this.listingStamp(kind);
    const knownListing = listing?.stamp === beforeStamp ? listing : undefined;
    const knownIndex = kind === 'outbox' && this.outboxIndex?.stamp === beforeStamp ? this.outboxIndex : undefined;
    let created = false;
    try {
      // Parent directories were checked under the signer lock. Exclusive creation owns this temp.
      const fd = this.io.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      created = true;
      try {
        checkStat(this.io.fstatSync(fd));
        let offset = 0;
        while (offset < bytes.length) {
          const written = this.io.writeSync(fd, bytes, offset, bytes.length - offset);
          if (!written) throw deliveryError('OUTBOX_STORE_UNWRITABLE');
          offset += written;
        }
      } finally { this.io.closeSync(fd); }
      const previous = this.read(kind, id);
      if (kind === 'outbox' && previous && 'envelopeDigest' in previous &&
        previous.envelopeDigest !== (record as OutboxRecordV1).envelopeDigest) throw deliveryError('DELIVERY_RECORD_CONFLICT');
      this.io.renameSync(temporary, path); created = false;
      this.remember(path, bytes.toString('utf8'), record);
      this.transactionReads?.set(path, structuredClone(record));
      if (knownIndex) {
        knownIndex.entries.set(id, summarize(record as OutboxRecordV1));
        knownIndex.stamp = this.listingStamp('outbox');
      }
      if (knownRetained) {
        knownRetained.entries.set(id, summarizeIdempotency(record as DeliveryRecords[IdempotencyKind]));
        knownRetained.stamp = this.listingStamp(kind);
      }
      if (knownListing) this.listings.set(kind, { stamp: this.listingStamp(kind), ids: [...new Set([...knownListing.ids, listingId])].sort() });
      else this.listings.delete(kind);
    } finally { if (created) this.io.unlinkSync(temporary); }
  }
  /** Creating/removing an unpublished temporary does not change the indexed JSON records. */
  private temporaryChange<T>(kind: Kind, change: () => T): T {
    const before = this.listingStamp(kind), listing = this.listings.get(kind);
    const index = kind === 'outbox' && this.outboxIndex?.stamp === before ? this.outboxIndex : undefined;
    const retained = this.idempotencyIndexes.get(kind);
    const knownRetained = retained?.stamp === before ? retained : undefined;
    try { return change(); }
    finally {
      const stamp = this.listingStamp(kind);
      if (index) index.stamp = stamp;
      if (knownRetained) knownRetained.stamp = stamp;
      if (listing?.stamp === before) listing.stamp = stamp;
    }
  }
  private stageWrites(writes: DeliveryWrite[], prepared: PreparedDeliveryWrite[], descriptors: number[]): void {
    // Unique unpublished files need no writer lock. Publication alone changes visible records.
    checkPath(dirname(dirname(dirname(this.root))), this.io, this.platform);
    for (const dir of this.directories()) this.inspectPath(dir, true);
    for (const { kind, id, record: input } of writes) {
      const record = structuredClone(input);
      validateDeliveryRecord(kind, record, this.owner.did); recordIdentity(kind, id, record);
      const path = this.path(kind, id), temporary = join(dirname(path), '.' + randomUUID() + '.tmp');
      const bytes = Buffer.from(JSON.stringify(signPayload(record, this.owner)) + '\n');
      if (bytes.length > (kind === 'operations' ? this.limits.operationBytes : this.limits.recordBytes))
        throw deliveryError(kind === 'operations' ? 'IDEMPOTENCY_STORE_FULL' : 'OUTBOX_FULL');
      // Make absent directory inventories available before local temporary creation changes them.
      const absentIndex = kind === 'outbox' && this.outboxIndex?.stamp === 'absent' ? this.outboxIndex : undefined;
      const retained = this.idempotencyIndexes.get(kind);
      const absentRetained = retained?.stamp === 'absent' ? retained : undefined;
      this.inspectPath(dirname(path), true);
      if (absentIndex) absentIndex.stamp = this.listingStamp(kind);
      if (absentRetained) absentRetained.stamp = this.listingStamp(kind);
      const fd = this.temporaryChange(kind, () => this.io.openSync(temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600));
      descriptors.push(fd); prepared.push({ kind, id, record, temporary, bytes });
      checkStat(this.io.fstatSync(fd));
    }
  }
  /** Synchronous callers also close written handles before acquiring the publication lock. */
  prepareWritesSync(writes: DeliveryWrite[]): PreparedDeliveryWrite[] {
    const prepared: PreparedDeliveryWrite[] = [], descriptors: number[] = [];
    try {
      this.stageWrites(writes, prepared, descriptors);
      for (let i = 0; i < prepared.length; i++) {
        const { bytes } = prepared[i], fd = descriptors[i];
        let offset = 0;
        while (offset < bytes.length) {
          const written = this.io.writeSync(fd, bytes, offset, bytes.length - offset);
          if (!written) throw deliveryError('OUTBOX_STORE_UNWRITABLE');
          offset += written;
        }
      }
      return prepared;
    } catch (error) {
      for (const fd of descriptors.splice(0)) this.io.closeSync(fd);
      this.discardWrites(prepared);
      if (error instanceof Error && /^(OUTBOX_|DELIVERY_RECORD_CONFLICT|IDEMPOTENCY_)/.test(error.message)) throw error;
      throw deliveryError('OUTBOX_STORE_UNWRITABLE');
    } finally { for (const fd of descriptors) this.io.closeSync(fd); }
  }
  /** Complete unique temporary writes outside the signer lock; close handles before publication. */
  async prepareWrites(writes: DeliveryWrite[]): Promise<PreparedDeliveryWrite[]> {
    const prepared: PreparedDeliveryWrite[] = [], descriptors: number[] = [];
    try {
      this.stageWrites(writes, prepared, descriptors);
      const results = await Promise.allSettled(prepared.map(async ({ bytes }, i) => {
        const fd = descriptors[i];
        let offset = 0;
        while (offset < bytes.length) {
          const written = await new Promise<number>((resolve, reject) => this.io.write(fd, bytes, offset,
            bytes.length - offset, null, (error, count) => error ? reject(error) : resolve(count)));
          if (!written) throw deliveryError('OUTBOX_STORE_UNWRITABLE');
          offset += written;
        }
      }));
      const failed = results.find(r => r.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      return prepared;
    } catch (error) {
      for (const fd of descriptors.splice(0)) this.io.closeSync(fd);
      this.discardWrites(prepared);
      if (error instanceof Error && /^(OUTBOX_|DELIVERY_RECORD_CONFLICT|IDEMPOTENCY_)/.test(error.message)) throw error;
      throw deliveryError('OUTBOX_STORE_UNWRITABLE');
    } finally {
      for (const fd of descriptors) this.io.closeSync(fd);
    }
  }
  /** Caller holds the signer lock. Prepared writes have completed and their handles are closed. */
  publishWrite(write: PreparedDeliveryWrite): void {
    const { kind, id, record, temporary, bytes } = write, path = this.path(kind, id);
    this.inspectPath(dirname(path));
    const previous = this.read(kind, id);
    if (kind === 'outbox' && previous && 'envelopeDigest' in previous &&
        previous.envelopeDigest !== (record as OutboxRecordV1).envelopeDigest) throw deliveryError('DELIVERY_RECORD_CONFLICT');
    const before = this.listingStamp(kind), listing = this.listings.get(kind);
    const index = kind === 'outbox' && this.outboxIndex?.stamp === before ? this.outboxIndex : undefined;
    const retained = this.idempotencyIndexes.get(kind);
    const knownRetained = retained?.stamp === before ? retained : undefined;
    this.io.renameSync(temporary, path);
    write.published = true;
    this.remember(path, bytes.toString('utf8'), record);
    this.transactionReads?.set(path, structuredClone(record));
    if (index) { index.entries.set(id, summarize(record as OutboxRecordV1)); index.stamp = this.listingStamp(kind); }
    if (knownRetained) {
      knownRetained.entries.set(id, summarizeIdempotency(record as DeliveryRecords[IdempotencyKind]));
      knownRetained.stamp = this.listingStamp(kind);
    }
    if (listing?.stamp === before) this.listings.set(kind, { stamp: this.listingStamp(kind),
      ids: [...new Set([...listing.ids, kind === 'receipts' ? receiptFileId(id) : id])].sort() });
    else this.listings.delete(kind);
  }
  discardWrites(writes: PreparedDeliveryWrite[]): void {
    const remaining = writes.filter(write => !write.published);
    if (!remaining.length) return;
    this.transaction(() => {
      for (const { kind, temporary } of remaining) this.temporaryChange(kind, () => {
        try { this.io.unlinkSync(temporary); } catch (error) { if (errno(error) !== 'ENOENT') throw deliveryError('OUTBOX_STORE_UNWRITABLE'); }
      });
    });
  }
  remove(kind: Kind, id: string): void {
    const listingId = kind === 'receipts' ? receiptFileId(id) : id;
    const path = this.path(kind, id);
    const listing = this.listings.get(kind);
    const beforeStamp = this.listingStamp(kind);
    const knownListing = listing?.stamp === beforeStamp ? listing : undefined;
    const knownIndex = kind === 'outbox' && this.outboxIndex?.stamp === beforeStamp ? this.outboxIndex : undefined;
    const retained = this.idempotencyIndexes.get(kind);
    const knownRetained = retained?.stamp === beforeStamp ? retained : undefined;
    if (this.read(kind, id)) {
      this.io.unlinkSync(path);
      this.transactionReads?.set(path, undefined);
      if (knownIndex) { knownIndex.entries.delete(id); knownIndex.stamp = this.listingStamp('outbox'); }
      if (knownRetained) { knownRetained.entries.delete(id); knownRetained.stamp = this.listingStamp(kind); }
      const cached = this.verified.get(path);
      if (cached) { this.verifiedBytes -= Buffer.byteLength(cached.data); this.verified.delete(path); }
      if (knownListing) this.listings.set(kind, { stamp: this.listingStamp(kind), ids: knownListing.ids.filter(entry => entry !== listingId) });
      else this.listings.delete(kind);
    }
  }
  /** Gateway entry points load/reconcile indexes in bounded slices before synchronous publication. */
  async prepare(signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      const stamp = this.listingStamp('outbox');
      if (this.outboxIndex?.stamp === stamp) { this.preparedMode = true; return; }
      const entries = new Map<string, OutboxSummary>();
      for (const id of this.ids('outbox')) {
        await new Promise<void>(resolve => setImmediate(resolve));
        signal?.throwIfAborted();
        const record = this.read('outbox', id);
        if (record) entries.set(id, summarize(record));
      }
      if (this.listingStamp('outbox') === stamp) {
        this.outboxIndex = { stamp, entries }; this.preparedMode = true; return;
      }
    }
  }
  /** Metadata only: local atomic writes update this index without scanning retained ciphertext. */
  private summaries(): OutboxSummary[] {
    const stamp = this.listingStamp('outbox');
    if (this.outboxIndex?.stamp !== stamp) {
      // A concurrent publisher requires another bounded preparation, never a scan inside a live send.
      if (this.preparedMode) throw deliveryError('OUTBOX_STORE_BUSY');
      const entries = new Map(this.snapshot('outbox').map(r => [r.envelopeId, summarize(r)]));
      this.outboxIndex = { stamp, entries };
    }
    return [...this.outboxIndex.entries.values()];
  }
  pending(messageId: string): OutboxSummary[] {
    return this.summaries().filter(r => r.messageId === messageId && r.state === 'pending' &&
      this.read('batches', r.batchId)?.envelopeIds.includes(r.envelopeId)).map(r => structuredClone(r));
  }
  /** Reconcile C2 capacity metadata outside the signer lock, yielding between retained records. */
  async prepareIdempotency(): Promise<void> {
    for (const kind of ['operations', 'idempotency'] as const) for (;;) {
      const stamp = this.listingStamp(kind);
      if (this.idempotencyIndexes.get(kind)?.stamp === stamp) break;
      const entries = new Map<string, IdempotencySummary>();
      for await (const record of this.scan(kind, new AbortController().signal)) {
        const id = kind === 'operations' ? record.operationId : (record as DeliveryRecords['idempotency']).keyHash;
        entries.set(id, summarizeIdempotency(record));
      }
      if (this.listingStamp(kind) === stamp) { this.idempotencyIndexes.set(kind, { stamp, entries }); break; }
    }
  }
  /** Caller holds the signer lock. Unchanged retained results require no file scans or reopens. */
  reserveIdempotencyCapacity(now: number): void {
    const operations = this.idempotencyIndexes.get('operations'), bindings = this.idempotencyIndexes.get('idempotency');
    if (!operations || !bindings || operations.stamp !== this.listingStamp('operations') || bindings.stamp !== this.listingStamp('idempotency'))
      throw deliveryError('IDEMPOTENCY_STORE_BUSY');
    for (const [id, binding] of bindings.entries) if (binding.retainUntil <= now) this.remove('idempotency', id);
    const bound = new Set([...bindings.entries.values()].map(b => b.operationId));
    for (const [id, record] of operations.entries) if (record.retainUntil <= now || !bound.has(id)) this.remove('operations', id);
    const bytes = [...operations.entries.values()].reduce((n, r) => n + (r.bytes ?? this.limits.operationBytes), 0);
    if (operations.entries.size >= this.limits.operations || bytes + this.limits.operationBytes > this.limits.cachedResultBytes)
      throw deliveryError('IDEMPOTENCY_STORE_FULL');
  }
  assertCapacity(records: OutboxRecordV1[], message?: MessageRecordV1): void {
    const all = this.summaries(), active = all.filter(r => r.state === 'pending');
    if (active.length + records.length > this.limits.activeEnvelopes ||
      all.reduce((n, r) => n + r.bytes, 0) + records.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r.envelope)), 0) > this.limits.envelopeBytes ||
      records.some(r => Buffer.byteLength(JSON.stringify(r.envelope)) > this.limits.wireBytes) ||
      message && !this.read('messages', message.messageId) && this.ids('messages').length >= this.limits.messages)
      throw deliveryError('OUTBOX_FULL');
  }
  /** Read-only preflight; publication rechecks capacity under the signer lock. */
  checkAvailable(envelopes = 2): void {
    if (this.summaries().filter(r => r.state === 'pending').length + envelopes > this.limits.activeEnvelopes ||
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
  async receiptPrepared(envelope: SignedEnvelope, deadline: number, state: InboundReceiptV1['state'], signal?: AbortSignal): Promise<void> {
    const now = this.now(), id = envelope.payload.envelopeId;
    for (;;) {
      signal?.throwIfAborted();
      const record = this.nextReceipt(envelope, deadline, state, undefined, now);
      if (JSON.stringify(this.read('receipts', id)) === JSON.stringify(record)) return;
      const prepared = await this.prepareWrites([{ kind: 'receipts', id, record }]);
      try {
        signal?.throwIfAborted();
        const published = this.transaction(() => {
          const current = this.nextReceipt(envelope, deadline, state, undefined, now);
          if (JSON.stringify(current) !== JSON.stringify(record)) return false;
          if (JSON.stringify(this.read('receipts', id)) !== JSON.stringify(record)) this.publishWrite(prepared[0]);
          return true;
        });
        if (published) return;
      } finally { this.discardWrites(prepared); }
    }
  }
  /** Caller holds the signer lock, including when publishing a task checkpoint. */
  receiptLocked(envelope: SignedEnvelope, deadline: number, state: InboundReceiptV1['state'], outcomeCode?: string): InboundReceiptV1 {
    const id = envelope.payload.envelopeId, r = this.nextReceipt(envelope, deadline, state, outcomeCode);
    const prior = this.read('receipts', id);
    if (!prior || JSON.stringify(prior) !== JSON.stringify(r)) this.write('receipts', id, r);
    return r;
  }
  private nextReceipt(envelope: SignedEnvelope, deadline: number, state: InboundReceiptV1['state'], outcomeCode?: string, now = this.now()): InboundReceiptV1 {
    const id = envelope.payload.envelopeId, prior = this.read('receipts', id);
    if (prior && (prior.envelopeId !== id || prior.senderDid !== envelope.payload.senderDid || prior.taskId !== envelope.payload.taskId || prior.envelopeDigest !== digest(envelope)))
      throw deliveryError('DELIVERY_RECORD_CONFLICT');
    if (!prior && this.ids('receipts').length >= this.limits.receipts) throw deliveryError('OUTBOX_FULL');
    const rank = { persisted: 0, processed: 1, terminal: 2 };
    const r: InboundReceiptV1 = { version: 1, envelopeId: id, localOwnerDid: this.owner.did,
      senderDid: envelope.payload.senderDid, taskId: envelope.payload.taskId, envelopeDigest: digest(envelope),
      receivedAt: prior?.receivedAt ?? now, retainUntil: prior?.retainUntil ?? Math.max(now, deadline) + DELIVERY_RETENTION_MS,
      state: prior && rank[prior.state] > rank[state] ? prior.state : state, ...(outcomeCode ? { outcomeCode } : {}) };
    return r;
  }
  private *maintenanceSteps(onError: (error: Error) => void): Generator<() => void> {
    for (const id of this.ids('batches', onError)) yield () => this.transaction(() => {
      const records = this.committed(id);
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
    });
    for (const kind of kinds) for (const id of this.ids(kind, onError)) yield () => this.transaction(() => {
      const r = this.read(kind, id);
      if (!r) return;
      // Recheck under this lock: another process may publish work between maintenance slices.
      const orphan = kind === 'outbox' && !this.read('batches', (r as OutboxRecordV1).batchId)?.envelopeIds.includes(id);
      if (orphan || 'retainUntil' in r && r.retainUntil <= this.now()) this.remove(kind, id);
    });
  }
  maintain(onError: (error: Error) => void = () => {}): void {
    for (const step of this.maintenanceSteps(onError)) {
      try { step(); } catch { onError(deliveryError('OUTBOX_STORE_INVALID')); }
    }
  }
  /** One batch (at most two frames) or one retained record per event-loop turn. */
  async maintainInBackground(onError: (error: Error) => void, signal: AbortSignal): Promise<void> {
    for (const step of this.maintenanceSteps(onError)) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (signal.aborted) return;
      try { step(); } catch { onError(deliveryError('OUTBOX_STORE_INVALID')); }
    }
  }
}
export type DeliveryStore = Pick<DeliveryStoreImplementation, keyof DeliveryStoreImplementation>;
export const DeliveryStore: {
  new(owner: KeyPair, options?: DeliveryStoreOptions): DeliveryStore;
  readonly prototype: DeliveryStore;
} = DeliveryStoreImplementation;
