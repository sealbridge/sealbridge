// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { digest, isEncryptedEnvelopePayload, resolveDid, signPayload, verifyEnvelope, verifySigned } from '@acp/core';
import type { KeyPair, Signed, SignedEnvelope } from '@acp/core';
import { checkPath, inspectDirectory, privateDirectory, readPrivateFile, resolveDataRoot, writePrivateFile } from './local-identity.js';
import type { LocalIdentityOptions } from './local-identity.js';

export type HeldContentKind = 'task' | 'connection' | 'application';
export type InspectionStatus = 'complete' | 'unavailable' | 'error';
export interface HeldContentInspection {
  type: 'HeldContentInspection'; v: 1; recordId: string; ownerDid: string; kind: HeldContentKind;
  contentDigest: string; envelopeDigest: string; status: InspectionStatus; reportDigest?: string; inspectedAt: number;
}
export interface HeldRecord {
  version: 1; id: string; kind: HeldContentKind; ownerDid: string; senderOwnerDid: string;
  requestId?: string; taskId?: string; contentDigest: string; envelopeDigest: string;
  receivedAt: number; expiresAt: number; state: 'held' | 'reviewable'; envelope: SignedEnvelope;
  inspectionReceipt?: Signed<HeldContentInspection>;
}
export interface HeldSummary {
  id: string; kind: HeldContentKind; ownerDid: string; senderOwnerDid: string; requestId?: string; taskId?: string;
  contentDigest: string; envelopeDigest: string; receivedAt: number; expiresAt: number;
  state: 'held' | 'reviewable' | 'expired'; inspectionStatus: InspectionStatus | 'pending'; sizeBytes: number;
}
export interface HoldRequest {
  id?: string; kind: HeldContentKind; senderOwnerDid: string; requestId?: string; taskId?: string;
  contentDigest: string; deadline: number; envelope: SignedEnvelope;
}
export const HELD_CONTENT_BOUNDS = Object.freeze({
  retentionMs: 24 * 60 * 60_000, envelopeBytes: 256 * 1024, records: 100,
  totalEnvelopeBytes: 32 * 1024 * 1024, metadataBytes: 8 * 1024,
});
export interface HeldRequestStoreOptions extends LocalIdentityOptions {
  now?: () => number;
  /** When known, reject a quarantine path inside the adapter workspace. */
  workspaceDir?: string;
  /** Embedders may select smaller storage bounds. */
  limits?: { envelopeBytes?: number; records?: number; totalEnvelopeBytes?: number };
}
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const isHeldDigest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const kinds = ['task', 'connection', 'application'];
function fail(): never { throw new Error('QUARANTINE_INVALID'); }
function keys(value: object, allowed: string[]): boolean { return Object.keys(value).every(k => allowed.includes(k)); }
function signedShape(value: Signed<unknown>): boolean {
  return keys(value, ['payload', 'signature']) && !!value.signature && keys(value.signature,
    ['signerDid', 'canonicalization', 'payloadDigest', 'signedAt', 'signature']);
}
function identifier(value: unknown): boolean { return value === undefined || typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
function encrypted(envelope: SignedEnvelope, ownerDid: string): void {
  if (!isEncryptedEnvelopePayload(envelope?.payload?.payload)) throw new Error('UNENCRYPTED_ENVELOPE_REJECTED');
  const payload = envelope.payload.payload;
  if (!verifyEnvelope(envelope, ownerDid) || !keys(payload, ['__acpEncrypted', 'ephemeralPublicKey', 'iv', 'ciphertext', 'tag']) ||
      ![payload.ephemeralPublicKey, payload.iv, payload.ciphertext, payload.tag].every(s => /^[A-Za-z0-9_-]*$/.test(s)) ||
      Buffer.from(payload.iv, 'base64url').length !== 12 || Buffer.from(payload.tag, 'base64url').length !== 16) fail();
}
export function heldRequestDirectory(ownerDid: string, options: LocalIdentityOptions = {}): string {
  return join(resolveDataRoot(options), 'quarantine', createHash('sha256').update(ownerDid).digest('hex'));
}
export function heldSummary(record: HeldRecord, now: number): HeldSummary {
  return { id: record.id, kind: record.kind, ownerDid: record.ownerDid, senderOwnerDid: record.senderOwnerDid,
    ...(record.requestId === undefined ? {} : { requestId: record.requestId }),
    ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
    contentDigest: record.contentDigest, envelopeDigest: record.envelopeDigest,
    receivedAt: record.receivedAt, expiresAt: record.expiresAt,
    state: record.expiresAt <= now ? 'expired' : record.state,
    inspectionStatus: record.inspectionReceipt?.payload.status ?? 'pending', sizeBytes: bytes(record.envelope) };
}
/** Owner-local ciphertext storage. Reads never create, migrate, prune or rewrite files. */
export class HeldRequestStore {
  readonly directory: string;
  private readonly io: typeof fs;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly limits: { envelopeBytes: number; records: number; totalEnvelopeBytes: number };
  constructor(private readonly owner: KeyPair, options: HeldRequestStoreOptions = {}) {
    this.directory = heldRequestDirectory(owner.did, options);
    this.io = options.fs ?? fs; this.platform = options.platform ?? process.platform; this.now = options.now ?? Date.now;
    this.limits = { ...HELD_CONTENT_BOUNDS, ...options.limits };
    for (const name of ['envelopeBytes', 'records', 'totalEnvelopeBytes'] as const)
      if (!Number.isInteger(this.limits[name]) || this.limits[name] < 1 || this.limits[name] > HELD_CONTENT_BOUNDS[name]) fail();
    if (options.workspaceDir !== undefined) {
      const path = relative(resolve(options.workspaceDir), this.directory);
      if (!path || !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)) fail();
    }
  }
  private directories(): string[] { return [dirname(dirname(this.directory)), dirname(this.directory), this.directory]; }
  private path(id: string): string { if (!idPattern.test(id)) fail(); return join(this.directory, id + '.json'); }
  private validate(record: HeldRecord, id: string): void {
    if (!record || !keys(record, ['version', 'id', 'kind', 'ownerDid', 'senderOwnerDid', 'requestId', 'taskId', 'contentDigest',
      'envelopeDigest', 'receivedAt', 'expiresAt', 'state', 'envelope', 'inspectionReceipt']) || record.version !== 1 ||
      record.id !== id || record.ownerDid !== this.owner.did || !kinds.includes(record.kind) ||
      !identifier(record.requestId) || !identifier(record.taskId) || !isHeldDigest(record.contentDigest) ||
      ![record.receivedAt, record.expiresAt].every(Number.isSafeInteger) || record.expiresAt <= record.receivedAt ||
      record.expiresAt - record.receivedAt > HELD_CONTENT_BOUNDS.retentionMs ||
      !['held', 'reviewable'].includes(record.state) || record.envelopeDigest !== digest(record.envelope)) fail();
    resolveDid(record.senderOwnerDid);
    encrypted(record.envelope, this.owner.did);
    if (record.taskId !== undefined && record.taskId !== record.envelope.payload.taskId) fail();
    const receipt = record.inspectionReceipt, p = receipt?.payload;
    if (receipt && (!signedShape(receipt) || !verifySigned(receipt, this.owner.did) || !p ||
      !keys(p, ['type', 'v', 'recordId', 'ownerDid', 'kind', 'contentDigest', 'envelopeDigest', 'status', 'reportDigest', 'inspectedAt']) ||
      p.type !== 'HeldContentInspection' || p.v !== 1 || p.recordId !== id || p.ownerDid !== this.owner.did || p.kind !== record.kind ||
      p.contentDigest !== record.contentDigest || p.envelopeDigest !== record.envelopeDigest ||
      !['complete', 'unavailable', 'error'].includes(p.status) || !Number.isSafeInteger(p.inspectedAt) ||
      p.inspectedAt < record.receivedAt || p.inspectedAt >= record.expiresAt ||
      (p.reportDigest !== undefined && !isHeldDigest(p.reportDigest)) || p.status === 'complete' && !p.reportDigest)) fail();
    if ((record.state === 'reviewable') !== (p?.status === 'complete')) fail();
    const { envelope, ...metadata } = record;
    if (bytes(envelope) > HELD_CONTENT_BOUNDS.envelopeBytes || bytes(metadata) + 1024 > HELD_CONTENT_BOUNDS.metadataBytes) fail();
  }
  /** Returns ciphertext and signed inspection metadata, never decrypted content. */
  read(id: string): HeldRecord | undefined {
    const path = this.path(id);
    try {
      for (const directory of this.directories()) {
        try { inspectDirectory(directory, this.io, this.platform); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      }
      const raw = readPrivateFile(path, this.io, HELD_CONTENT_BOUNDS.envelopeBytes + HELD_CONTENT_BOUNDS.metadataBytes, this.platform);
      if (raw === undefined) return undefined;
      const signed = JSON.parse(raw) as Signed<HeldRecord>;
      if (!signedShape(signed) || !verifySigned(signed, this.owner.did)) fail();
      this.validate(signed.payload, id);
      return signed.payload;
    } catch { fail(); }
  }
  private records(): HeldRecord[] {
    try {
      for (const directory of this.directories()) {
        try { inspectDirectory(directory, this.io, this.platform); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      }
      let names: string[];
      try { names = this.io.readdirSync(this.directory); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
      const files = names.filter(n => n.endsWith('.json'));
      if (files.length > HELD_CONTENT_BOUNDS.records) fail();
      return files.sort().map(name => this.read(name.slice(0, -5)) ?? fail());
    } catch { fail(); }
  }
  list(): HeldSummary[] { const now = this.now(); return this.records().map(r => heldSummary(r, now)); }
  private mutate<T>(operation: (records: HeldRecord[]) => T): T {
    const lock = join(this.directory, '.lock'); let locked = false;
    try {
      for (const directory of this.directories()) privateDirectory(directory, this.io, this.platform);
      try { writePrivateFile(lock, Buffer.alloc(0), this.io, this.platform); locked = true; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('QUARANTINE_BUSY'); throw e; }
      return operation(this.records());
    } catch (e) {
      if (e instanceof Error && /^(QUARANTINE_|INSPECTION_|UNENCRYPTED_ENVELOPE_REJECTED$)/.test(e.message)) throw e;
      throw new Error('QUARANTINE_UNWRITABLE');
    } finally { if (locked) this.io.unlinkSync(lock); }
  }
  private publish(record: HeldRecord): void {
    this.validate(record, record.id);
    const target = this.path(record.id), temporary = target + '.' + randomUUID() + '.tmp';
    try {
      writePrivateFile(temporary, Buffer.from(JSON.stringify(signPayload(record, this.owner, new Date(this.now()).toISOString())) + '\n'), this.io, this.platform);
      checkPath(target, this.io, this.platform);
      this.io.renameSync(temporary, target);
    } finally {
      try { this.io.unlinkSync(temporary); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
  }
  /** Caller validates sender-owner delegation and the task/offer deadline before holding. Return only after publication. */
  hold(request: HoldRequest): HeldSummary {
    let record: HeldRecord;
    try {
      const now = this.now();
      encrypted(request.envelope, this.owner.did);
      if (!Number.isSafeInteger(request.deadline)) fail();
      if (bytes(request.envelope) > this.limits.envelopeBytes) throw new Error('QUARANTINE_FULL');
      record = { version: 1, id: request.id ?? randomUUID(), kind: request.kind, ownerDid: this.owner.did,
        senderOwnerDid: request.senderOwnerDid, contentDigest: request.contentDigest, envelopeDigest: digest(request.envelope),
        receivedAt: now, expiresAt: Math.min(request.deadline, now + HELD_CONTENT_BOUNDS.retentionMs), state: 'held',
        envelope: structuredClone(request.envelope),
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        ...(request.requestId === undefined ? {} : { requestId: request.requestId }) };
      this.path(record.id); this.validate(record, record.id);
    } catch (e) {
      if (e instanceof Error && /^(QUARANTINE_|UNENCRYPTED_ENVELOPE_REJECTED$)/.test(e.message)) throw e;
      fail();
    }
    return this.mutate(records => {
      const previous = records.find(r => r.id === record.id);
      if (previous) {
        if (previous.expiresAt <= this.now() || previous.envelopeDigest !== record.envelopeDigest || previous.contentDigest !== record.contentDigest ||
            previous.kind !== record.kind || previous.senderOwnerDid !== record.senderOwnerDid ||
            previous.requestId !== record.requestId || previous.taskId !== record.taskId) fail();
        return heldSummary(previous, this.now());
      }
      this.prune(records);
      const live = records.filter(r => r.expiresAt > this.now());
      if (live.length >= this.limits.records || live.reduce((sum, r) => sum + bytes(r.envelope), 0) + bytes(record.envelope) > this.limits.totalEnvelopeBytes)
        throw new Error('QUARANTINE_FULL');
      this.publish(record); return heldSummary(record, this.now());
    });
  }
  /** Commits a provider completion bound to the stored ciphertext. Does not approve a task or a connection. */
  recordInspection(id: string, receipt: Signed<HeldContentInspection>): HeldSummary {
    return this.mutate(records => {
      const record = records.find(r => r.id === id && r.expiresAt > this.now());
      if (!record) throw new Error('QUARANTINE_NOT_FOUND');
      if (record.state === 'reviewable') return heldSummary(record, this.now());
      record.inspectionReceipt = structuredClone(receipt);
      record.state = receipt.payload.status === 'complete' ? 'reviewable' : 'held';
      this.publish(record); return heldSummary(record, this.now());
    });
  }
  private prune(records: HeldRecord[]): number {
    const expired = records.filter(r => r.expiresAt <= this.now());
    for (const r of expired) this.io.unlinkSync(this.path(r.id));
    return expired.length;
  }
  expire(): number { return this.mutate(records => this.prune(records)); }
  discard(id: string): boolean {
    this.path(id);
    return this.mutate(records => { if (!records.some(r => r.id === id)) return false; this.io.unlinkSync(this.path(id)); return true; });
  }
  /** Call when a peer is blocked; connection state is managed separately. */
  discardPeer(senderOwnerDid: string): number {
    return this.mutate(records => {
      const matches = records.filter(r => r.senderOwnerDid === senderOwnerDid);
      for (const r of matches) this.io.unlinkSync(this.path(r.id));
      return matches.length;
    });
  }
  clear(): number {
    return this.mutate(records => { for (const r of records) this.io.unlinkSync(this.path(r.id)); return records.length; });
  }
}
