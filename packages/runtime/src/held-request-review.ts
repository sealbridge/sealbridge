// SPDX-License-Identifier: Apache-2.0
import { digest, openEnvelope, signPayload } from '@acp/core';
import type { Json, KeyPair, SignedEnvelope } from '@acp/core';
import { HeldRequestStore, heldSummary, isHeldDigest } from './held-request-store.js';
import type { HeldContentInspection, HeldContentKind, HeldRecord, HeldRequestStoreOptions, HeldSummary, HoldRequest, InspectionStatus } from './held-request-store.js';

export interface InspectionCompletion {
  ownerDid: string; contentDigest: string; envelopeDigest: string; kind: HeldContentKind;
  status: InspectionStatus; reportDigest?: string;
}
export interface HeldInspectionContext {
  owner: KeyPair; recordId: string; contentDigest: string; envelopeDigest: string; kind: HeldContentKind;
}
/** Injected host boundary. Implementations inspect in memory and return content-free completion metadata. */
export interface HeldContentReviewProvider {
  inspect(envelope: SignedEnvelope, context: HeldInspectionContext, signal: AbortSignal): Promise<InspectionCompletion>;
}
export const unavailableHeldContentReviewProvider: HeldContentReviewProvider = Object.freeze({
  async inspect(_envelope: SignedEnvelope, context: HeldInspectionContext): Promise<InspectionCompletion> {
    return { ownerDid: context.owner.did, contentDigest: context.contentDigest, envelopeDigest: context.envelopeDigest,
      kind: context.kind, status: 'unavailable' };
  },
});
/** Task digests match proposal digests. Other kinds bind the entire decrypted body without interpreting its fields. */
export function heldContentDigest(kind: HeldContentKind, content: Json): string {
  if (kind !== 'task') return digest(content);
  if (!content || typeof content !== 'object' || Array.isArray(content) ||
      !Object.hasOwn(content, 'manifest') || !Object.hasOwn(content, 'input')) throw new Error('QUARANTINE_INVALID');
  return digest({ manifest: content.manifest, input: content.input });
}
export interface HeldRequestReviewOptions extends HeldRequestStoreOptions {
  provider?: HeldContentReviewProvider;
  inspectionTimeoutMs?: number;
}
/** Library only: hosts authorize owner review and attach delivery, cleanup and execution separately. */
export class HeldRequestReview {
  readonly store: HeldRequestStore;
  private readonly provider: HeldContentReviewProvider;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  constructor(private readonly owner: KeyPair, options: HeldRequestReviewOptions = {}) {
    this.store = new HeldRequestStore(owner, options);
    this.provider = options.provider ?? unavailableHeldContentReviewProvider;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.inspectionTimeoutMs ?? 5000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 45_000) throw new Error('QUARANTINE_INVALID');
  }
  hold(request: HoldRequest): HeldSummary { return this.store.hold(request); }
  list(): HeldSummary[] { return this.store.list(); }
  private active(id: string): HeldRecord {
    const record = this.store.read(id);
    if (!record || record.expiresAt <= this.now()) throw new Error('QUARANTINE_NOT_FOUND');
    return record;
  }
  private open(record: HeldRecord): Json {
    const content = openEnvelope<Json>(record.envelope, this.owner);
    if (heldContentDigest(record.kind, content) !== record.contentDigest) throw new Error('QUARANTINE_INVALID');
    return content;
  }
  async inspect(id: string, signal?: AbortSignal): Promise<HeldSummary> {
    const record = this.active(id);
    if (record.state === 'reviewable') return heldSummary(record, this.now());
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let status: InspectionStatus = 'error', reportDigest: string | undefined;
    try {
      const interrupted = new Promise<never>((_resolve, reject) => {
        const abort = () => { controller.abort(); reject(new Error('INSPECTION_INCOMPLETE')); };
        timer = setTimeout(abort, this.timeoutMs);
        onAbort = abort;
        if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      });
      // Clone both arguments so a provider cannot change the immutable held record or host key object.
      const completion = await Promise.race([interrupted, Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error('INSPECTION_INCOMPLETE');
        return this.provider.inspect(structuredClone(record.envelope), {
          owner: structuredClone(this.owner), recordId: record.id, contentDigest: record.contentDigest,
          envelopeDigest: record.envelopeDigest, kind: record.kind,
        }, controller.signal);
      })]);
      if (!completion || completion.ownerDid !== this.owner.did || completion.contentDigest !== record.contentDigest ||
          completion.envelopeDigest !== record.envelopeDigest || completion.kind !== record.kind ||
          !['complete', 'unavailable', 'error'].includes(completion.status) ||
          (completion.reportDigest !== undefined && !isHeldDigest(completion.reportDigest)) ||
          completion.status === 'complete' && !isHeldDigest(completion.reportDigest)) throw new Error('INSPECTION_INCOMPLETE');
      if (completion.status === 'complete') this.open(record);
      status = completion.status;
      if (status === 'complete') reportDigest = completion.reportDigest;
    } catch {
      // Failure details can contain provider input; persist only the fixed status.
      status = 'error';
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      controller.abort();
    }
    const receipt: HeldContentInspection = {
      type: 'HeldContentInspection', v: 1, recordId: id, ownerDid: this.owner.did, kind: record.kind,
      contentDigest: record.contentDigest, envelopeDigest: record.envelopeDigest, status, inspectedAt: this.now(),
      ...(reportDigest === undefined ? {} : { reportDigest }),
    };
    return this.store.recordInspection(id, signPayload(receipt, this.owner, new Date(receipt.inspectedAt).toISOString()));
  }
  /** Explicit owner-facing read after completion. This neither executes content nor records connection consent. */
  showReviewedContent(id: string): Json {
    const record = this.active(id);
    if (record.state !== 'reviewable') throw new Error(record.inspectionReceipt?.payload.status === 'unavailable'
      ? 'INSPECTION_UNAVAILABLE' : 'INSPECTION_INCOMPLETE');
    return this.open(record);
  }
  /** Discard offers immediately after a decision, and tasks after result transmission. */
  discard(id: string): boolean { return this.store.discard(id); }
  discardPeer(senderOwnerDid: string): number { return this.store.discardPeer(senderOwnerDid); }
  expire(): number { return this.store.expire(); }
}
