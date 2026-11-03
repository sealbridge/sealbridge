// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { digest, isInviteTarget } from '@acp/core';
import type { Json, KeyPair } from '@acp/core';
import { DeliveryStore } from './delivery-store.js';
import type { DeliveryStoreOptions, DeliveryWrite } from './delivery-store.js';
import { DELIVERY_RETENTION_MS, deliveryError } from './delivery-records.js';
import type { DeliveryRecords, IdempotencyAuthorization, IdempotencyOperationV1, PreparedIdempotentAction } from './delivery-records.js';

type Mutation = Pick<DeliveryStore, 'read' | 'write' | 'reserveIdempotencyCapacity'>;

export type IdempotencyResponse = { isError: boolean; value: Json };
export interface IdempotencyStoreOptions extends DeliveryStoreOptions { leaseMs?: number }
export function validateIdempotencyKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 1 || Buffer.byteLength(value, 'utf8') > 200 ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))
    throw deliveryError('INVALID_IDEMPOTENCY_KEY');
}
export function idempotencyKeyHash(owner: string, tool: string, key: string): string {
  validateIdempotencyKey(key);
  // digest uses RFC 8785 canonicalization, including the exact key bytes.
  return digest([1, owner, tool, key]).slice(7);
}
export function idempotencyFailure(error: unknown): IdempotencyResponse {
  const e = error as { code?: unknown; message?: unknown; pendingId?: string; originalTaskId?: string; nextStep?: string; pendingStoreError?: string };
  const code = typeof e?.code === 'string' ? e.code : typeof e?.message === 'string' ? e.message : 'DELEGATION_FAILED';
  return { isError: true, value: { error: code, ...(code === 'PENDING_OWNER_APPROVAL' ? { retryable: false } : {}),
    ...(e?.pendingId ? { pendingId: e.pendingId } : {}), ...(e?.originalTaskId ? { originalTaskId: e.originalTaskId } : {}),
    ...(e?.nextStep ? { nextStep: e.nextStep } : {}), ...(e?.pendingStoreError ? { pendingStoreError: e.pendingStoreError } : {}) } };
}
export function unwrapIdempotency<T>(response: IdempotencyResponse): T {
  if (!response.isError) return response.value as T;
  const value = response.value as Record<string, Json>;
  throw Object.assign(new Error(String(value.error)), value, { code: value.error });
}
/** Remove process-local hooks and paths; retain every execution option in the fingerprint. */
export function runtimeIdempotencyAction(options: object, defaults: Record<string, unknown> = {}): Json {
  const copy: Record<string, unknown> = { ...defaults, ...options };
  for (const key of ['idempotencyKey', 'idempotencyOperation', 'idempotencyChildIndex', 'signal', 'onProgress',
    'beforePropose', 'beforeTransmit', 'auditPath', 'outputPath']) delete copy[key];
  if (copy.relay && typeof copy.relay !== 'string') {
    const relay = copy.relay as { url?: unknown };
    copy.relay = typeof relay.url === 'string' ? relay.url : 'injected transport';
  }
  if (typeof copy.to === 'string' && isInviteTarget(copy.to)) copy.to = digest(copy.to);
  if (Array.isArray(copy.workers)) copy.workers = copy.workers.map(w => {
    const worker = { ...w }; if (worker.inviteToken !== undefined) worker.inviteToken = digest(worker.inviteToken); return worker;
  });
  // Validate the JSON representation before any task IDs or approval are produced.
  const action = JSON.parse(JSON.stringify(copy)) as Json;
  digest(action); return action;
}

/** One operation owns preparation, authorization and all fan-out children. */
export class IdempotencyOperation {
  private readonly ready = new Set<number>();
  private readonly waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  private preparationFailure?: unknown;
  private prepared = false;
  constructor(readonly store: IdempotencyStore, readonly operationId: string, readonly holderId: string, readonly children: number, private readonly keyHash: string) {}
  private change(change: (r: IdempotencyOperationV1, records: Mutation) => void): Promise<void> {
    return this.store.mutate(records => {
      const r = records.read('operations', this.operationId);
      if (!r || r.phase === 'finished' || r.lease?.holderId !== this.holderId) throw deliveryError('IDEMPOTENCY_RESULT_UNAVAILABLE');
      change(r, records); records.write('operations', r.operationId, r);
    });
  }
  async prepare(action: PreparedIdempotentAction): Promise<void> {
    await this.change(r => {
      if (r.preparedActions.some(a => a.childIndex === action.childIndex)) throw deliveryError('IDEMPOTENCY_STORE_INVALID');
      r.preparedActions.push(structuredClone(action)); r.preparedActions.sort((a, b) => a.childIndex - b.childIndex);
      r.taskIds = r.preparedActions.map(a => a.manifest.taskId);
    });
    await new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject }); void this.childReady(action.childIndex);
    });
  }
  async childReady(index: number, error?: unknown): Promise<void> {
    if (this.prepared) return;
    if (error) this.preparationFailure ??= error;
    this.ready.add(index);
    if (this.ready.size < this.children) return;
    this.prepared = true;
    try {
      if (this.preparationFailure) throw this.preparationFailure;
      await this.change((r, records) => {
        r.phase = 'awaiting_approval';
        r.retainUntil = Math.max(r.createdAt, ...r.preparedActions.map(a => Date.parse(a.manifest.deadline))) + DELIVERY_RETENTION_MS;
        const binding = records.read('idempotency', this.keyHash);
        if (!binding) throw deliveryError('IDEMPOTENCY_STORE_INVALID');
        records.write('idempotency', binding.keyHash, { ...binding, retainUntil: r.retainUntil });
      });
      for (const waiter of this.waiters.splice(0)) waiter.resolve();
    } catch (error) { for (const waiter of this.waiters.splice(0)) waiter.reject(error); }
  }
  async authorize(childIndex: number, evidence: IdempotencyAuthorization | void): Promise<void> {
    if (!evidence) throw deliveryError('IDEMPOTENCY_AUTHORIZATION_REQUIRED');
    await this.change(r => {
      const a = r.preparedActions.find(a => a.childIndex === childIndex);
      if (!a || a.approvalTargetDigest !== evidence.targetDigest) throw deliveryError('IDEMPOTENCY_STORE_INVALID');
      r.approvals ??= []; r.approvals.push({ ...evidence, childIndex }); r.phase = 'approved';
    });
  }
  sending(): Promise<void> { return this.change(r => { r.phase = 'sending'; }); }
  renew(): Promise<void> { return this.change(r => { r.lease!.until = this.store.records.now() + this.store.leaseMs; }); }
}

/** Owner-signed operation cache sharing C1's atomic store and short signer lock. */
export class IdempotencyStore {
  readonly records: DeliveryStore;
  readonly leaseMs: number;
  private readonly live = new Map<string, { requestDigest: string; promise: Promise<IdempotencyResponse> }>();
  constructor(owner: KeyPair, options: IdempotencyStoreOptions = {}) {
    this.records = new DeliveryStore(owner, options); this.leaseMs = options.leaseMs ?? 120_000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1) throw deliveryError('IDEMPOTENCY_STORE_INVALID');
  }
  /** Plan under the signer lock, write outside it, then compare before publishing. */
  async mutate<T>(change: (records: Mutation) => T): Promise<T> {
    try {
      for (;;) {
        try {
          const reads = new Map<string, { kind: keyof DeliveryRecords; id: string; value: string | undefined }>();
          const writes = new Map<string, DeliveryWrite>();
          let capacityNow: number | undefined;
          const read = <K extends keyof DeliveryRecords>(kind: K, id: string): DeliveryRecords[K] | undefined => {
            const key = kind + ':' + id;
            const pending = writes.get(key);
            if (pending) return structuredClone(pending.record) as DeliveryRecords[K];
            const record = this.records.read(kind, id);
            reads.set(key, { kind, id, value: JSON.stringify(record) });
            return record;
          };
          const result = this.records.transaction(() => change({ read,
            write: (kind, id, record) => {
              const key = kind + ':' + id;
              if (!reads.has(key)) read(kind, id);
              writes.set(key, { kind, id, record: structuredClone(record) });
            },
            reserveIdempotencyCapacity: now => {
              this.records.reserveIdempotencyCapacity(now); capacityNow = now;
            },
          }));
          if (!writes.size) return result;
          const prepared = await this.records.prepareWrites([...writes.values()]);
          try {
            if (capacityNow !== undefined) await this.records.prepareIdempotency();
            const published = this.records.transaction(() => {
              if ([...reads.values()].some(r => JSON.stringify(this.records.read(r.kind, r.id)) !== r.value)) return false;
              if (capacityNow !== undefined) this.records.reserveIdempotencyCapacity(capacityNow);
              for (const write of prepared) this.records.publishWrite(write);
              return true;
            });
            if (published) return result;
          } finally { this.records.discardWrites(prepared); }
        } catch (error) {
          // Another store may have changed capacity inventories while our write yielded.
          if (!(error instanceof Error) || error.message !== 'IDEMPOTENCY_STORE_BUSY') throw error;
          await this.records.prepareIdempotency();
        }
      }
    } catch (error) { throw this.storeError(error); }
  }
  private storeError(error: unknown): unknown {
    const code = error instanceof Error ? error.message : '';
    if (code.startsWith('IDEMPOTENCY_')) return error;
    return deliveryError(code === 'OUTBOX_FULL' ? 'IDEMPOTENCY_STORE_FULL' :
      code === 'OUTBOX_STORE_BUSY' ? 'IDEMPOTENCY_STORE_BUSY' :
      code === 'OUTBOX_STORE_INVALID' ? 'IDEMPOTENCY_STORE_INVALID' : 'IDEMPOTENCY_STORE_UNWRITABLE');
  }
  async run(tool: string, key: string, action: Json, run: (operation: IdempotencyOperation) => Promise<IdempotencyResponse>,
    options: { children?: number; deadline?: number } = {}): Promise<IdempotencyResponse> {
    const keyHash = idempotencyKeyHash(this.records.owner.did, tool, key);
    const requestDigest = digest({ version: 1, tool, action });
    const active = this.live.get(keyHash);
    if (active) {
      if (active.requestDigest !== requestDigest) throw deliveryError('IDEMPOTENCY_CONFLICT');
      return structuredClone(await active.promise);
    }
    // Join calls even while recovery is yielding, before any reservation or owner prompt.
    const promise = this.execute(tool, keyHash, requestDigest, run, options);
    this.live.set(keyHash, { requestDigest, promise });
    try { return structuredClone(await promise); } finally { this.live.delete(keyHash); }
  }
  private async execute(tool: string, keyHash: string, requestDigest: string,
    run: (operation: IdempotencyOperation) => Promise<IdempotencyResponse>,
    options: { children?: number; deadline?: number }): Promise<IdempotencyResponse> {
    try {
      const binding = this.records.read('idempotency', keyHash);
      if (!binding || binding.retainUntil <= this.records.now()) await this.records.prepareIdempotency();
    } catch (error) { throw this.storeError(error); }
    const now = this.records.now(), holderId = randomUUID();
    const reservation = await this.mutate(records => {
      let binding = records.read('idempotency', keyHash);
      const retained = binding && records.read('operations', binding.operationId);
      if (binding && (!retained || retained.tool !== binding.tool || retained.requestDigest !== binding.requestDigest))
        throw deliveryError('IDEMPOTENCY_STORE_INVALID');
      if (binding && retained && binding.retainUntil !== retained.retainUntil) {
        // Complete an interrupted two-record horizon publication using original prepared deadlines.
        const retainUntil = retained.preparedActions.length ? Math.max(retained.createdAt,
          ...retained.preparedActions.map(a => Date.parse(a.manifest.deadline))) + DELIVERY_RETENTION_MS : retained.retainUntil;
        retained.retainUntil = retainUntil;
        records.write('operations', retained.operationId, retained);
        binding = { ...binding, retainUntil }; records.write('idempotency', keyHash, binding);
      }
      if (binding && binding.retainUntil > now) {
        if (binding.requestDigest !== requestDigest) throw deliveryError('IDEMPOTENCY_CONFLICT');
        const r = records.read('operations', binding.operationId);
        if (!r || r.requestDigest !== requestDigest || r.tool !== tool || binding.tool !== tool || r.retainUntil !== binding.retainUntil)
          throw deliveryError('IDEMPOTENCY_STORE_INVALID');
        if (r.response) return { response: r.response };
        if (r.lease && r.lease.until > now) return { response: { isError: true, value: {
          error: 'IDEMPOTENCY_IN_PROGRESS', operationId: r.operationId, taskIds: r.taskIds, messageIds: r.messageIds,
        } } as IdempotencyResponse };
        // Only C1's committed immutable envelopes may continue; never reconstruct a task session.
        const error = ['reserved', 'awaiting_approval'].includes(r.phase) && !r.approvals?.length
          ? 'APPROVAL_INTERRUPTED' : 'IDEMPOTENCY_RESULT_UNAVAILABLE';
        r.response = { isError: true, value: { error, operationId: r.operationId, taskIds: r.taskIds, messageIds: r.messageIds } };
        r.phase = 'finished'; delete r.lease; records.write('operations', r.operationId, r);
        return { response: r.response };
      }
      // Expiry and orphan cleanup are mutations, never side effects of a read.
      records.reserveIdempotencyCapacity(now);
      const r: IdempotencyOperationV1 = { version: 1, operationId: randomUUID(), localOwnerDid: this.records.owner.did,
        tool, requestDigest, createdAt: now, retainUntil: Math.max(now, options.deadline ?? now + 600_000) + DELIVERY_RETENTION_MS,
        phase: 'reserved', messageIds: [], taskIds: [], preparedActions: [], lease: { holderId, until: now + this.leaseMs } };
      records.write('operations', r.operationId, r);
      records.write('idempotency', keyHash, { version: 1, localOwnerDid: r.localOwnerDid, tool, keyHash,
        requestDigest, operationId: r.operationId, createdAt: now, retainUntil: r.retainUntil });
      return { operation: r };
    });
    if (reservation.response) return structuredClone(reservation.response);
    const operation = new IdempotencyOperation(this, reservation.operation!.operationId, holderId, options.children ?? 1, keyHash);
    return Promise.resolve().then(async () => {
      let renewalError: unknown;
      let renewal = Promise.resolve();
      const timer = setInterval(() => {
        renewal = renewal.then(() => operation.renew()).catch(error => { renewalError = error; });
      }, Math.max(1, Math.floor(this.leaseMs / 3)));
      timer.unref();
      try {
        let response: IdempotencyResponse;
        try { response = await run(operation); } catch (error) { response = idempotencyFailure(error); }
        clearInterval(timer); await renewal;
        if (renewalError) throw renewalError;
        response = JSON.parse(JSON.stringify(response)) as IdempotencyResponse;
        await this.mutate(records => {
          const r = records.read('operations', operation.operationId);
          if (!r || r.phase === 'finished' || r.lease?.holderId !== holderId) throw deliveryError('IDEMPOTENCY_RESULT_UNAVAILABLE');
          r.phase = 'finished'; r.response = response; delete r.lease;
          records.write('operations', r.operationId, r);
        });
        return response;
      } finally { clearInterval(timer); }
    });
  }
}
