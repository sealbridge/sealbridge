// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, readFileSync, openSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  digest,
  signPayload,
  signAck,
  verifySigned,
  verifySignature,
  validateSchema,
  validateManifest,
} from '@acp/core';
import type { Json, Signature, AckReceipt, KeyPair, Signed, TaskManifest } from '@acp/core';
export interface AuditBody {
  taskId: string;
  seq: number;
  prevEntryHash: string | null;
  actorDid: string;
  receiverDid: string;
  eventType: string;
  payload: Json;
}
export interface AuditEntry {
  body: AuditBody;
  entryHash: string;
  actorSignature: Signature;
  counterSignature: AckReceipt;
}
export interface Checkpoint {
  type: 'AuditCheckpoint';
  taskId: string;
  count: number;
  head: string | null;
  actors: [string, string];
}
export interface AuditBundle {
  entries: AuditEntry[];
  checkpoint: { actor: Signed<Checkpoint>; receiver: Signed<Signed<Checkpoint>> };
}
/** Local storage format 1; never a wire event or bilateral checkpoint. */
export interface AuditInterruption {
  type: 'AuditInterruption';
  formatVersion: 1;
  taskId: string;
  actors: [string, string];
  seq: number;
  prevEntryHash: string;
  acknowledgedPrefix: { count: number; lastSeq: number; head: string; entriesDigest: string };
  phase: 'OWNER_APPROVAL' | 'ACCEPT_ACK_WAIT';
  reason: 'SESSION_TIMEOUT' | 'WORKER_STOPPED' | 'WORKER_RESTART_OBSERVED' | 'HELD_ATTEMPT_CLOSED';
  observedAt: string;
}
export interface InterruptedAuditBundle {
  entries: AuditEntry[];
  interruption: Signed<AuditInterruption>;
}
export type AuditEvidence = AuditBundle | InterruptedAuditBundle;
export type AuditFileRecord = { entry: AuditEntry } | { checkpoint: AuditBundle['checkpoint'] }
  | { interruption: Signed<AuditInterruption> };
export interface InterruptionStore {
  /** Idempotent only for exactly the same signed terminal record and prefix.
   * beforeWrite must synchronously persist the signed intent; promises are rejected. */
  closeInterrupted(bundle: InterruptedAuditBundle, beforeWrite?: () => void): void;
}
function persistInterruptionIntent(beforeWrite?: () => void): void {
  const result: unknown = beforeWrite?.();
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    void Promise.resolve(result).catch(() => {});
    throw new Error('ASYNC_AUDIT_INTENT_FORBIDDEN');
  }
}
// Source locations are diagnostic metadata only: never serialize them into a bundle.
const jsonlLocations = new WeakMap<AuditBundle, { entryLines: number[]; checkpointLine: number }>();
type AuditRecord = { entry?: AuditEntry; checkpoint?: AuditBundle['checkpoint']; interruption?: Signed<AuditInterruption> };
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function diagnosticText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (/acp-invite:/i.test(value)) return '[redacted]';
  return value.length > 160 ? value.slice(0, 160) + '...' : value;
}
function diagnosticJson(value: unknown): string {
  // JSON escaping covers C0 controls; also escape DEL, C1 and Unicode display controls.
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g,
    char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
}
function entryLocation(entry: unknown, locationKind: 'entry' | 'last-entry', index?: number, line?: number) {
  const e = object(entry), body = object(e?.body);
  return {
    locationKind,
    taskId: diagnosticText(body?.taskId),
    seq: typeof body?.seq === 'number' && Number.isSafeInteger(body.seq) && body.seq >= 0
      ? body.seq : undefined,
    entryHash: diagnosticText(e?.entryHash),
    line,
    index,
    verified: false,
  };
}
function checkpointLocation(bundle: AuditBundle) {
  const checkpoint = object(bundle?.checkpoint), payload = object(object(checkpoint?.actor)?.payload);
  const entries = Array.isArray(bundle?.entries) ? bundle.entries : [];
  const source = jsonlLocations.get(bundle);
  return {
    locationKind: 'checkpoint',
    taskId: diagnosticText(payload?.taskId),
    head: diagnosticText(payload?.head),
    line: source?.checkpointLine,
    lastEntry: entries.length
      ? entryLocation(entries.at(-1), 'last-entry', entries.length - 1, source?.entryLines.at(-1)) : undefined,
    verified: false,
  };
}
function parseRecords(text: string): Array<{ record: AuditRecord; line: number }> {
  // Keep the existing trim/filter rules while counting physical lines before filtering.
  const start = text.length - text.trimStart().length;
  const firstLine = text.slice(0, start).split('\n').length;
  return text.trim().split('\n').flatMap((line, index) => {
    if (!line) return [];
    const physicalLine = firstLine + index;
    let record: AuditRecord;
    try {
      record = JSON.parse(line) as AuditRecord;
    } catch {
      // Engine JSON errors can quote the input, including task payloads or invitations.
      throw new SyntaxError('Invalid JSON; auditLocation=' + diagnosticJson({ line: physicalLine, verified: false }));
    }
    return [{ record, line: physicalLine }];
  });
}
export interface AuditStore {
  read(): AuditEntry[];
  append(entry: AuditEntry, checkpoint: AuditBundle['checkpoint']): void;
  seal?(checkpoint: AuditBundle['checkpoint']): void;
}
export class MemoryStore implements AuditStore, InterruptionStore {
  #entries: AuditEntry[] = [];
  #interruption?: Signed<AuditInterruption>;
  #checkpoint?: AuditBundle['checkpoint'];
  #closing = false;
  read(): AuditEntry[] {
    return structuredClone(this.#entries);
  }
  append(entry: AuditEntry): void {
    if (this.#closing) throw new Error('LEDGER_BUSY');
    if (this.#interruption || this.#checkpoint) throw new Error('LEDGER_SEALED');
    this.#entries.push(structuredClone(entry));
  }
  seal(checkpoint: AuditBundle['checkpoint']): void {
    if (this.#closing) throw new Error('LEDGER_BUSY');
    if (this.#interruption) throw new Error('LEDGER_SEALED');
    if (this.#checkpoint && digest(this.#checkpoint.actor.payload) !== digest(checkpoint.actor.payload)) throw new Error('LEDGER_SEALED');
    this.#checkpoint = structuredClone(checkpoint);
  }
  closeInterrupted(bundle: InterruptedAuditBundle, beforeWrite?: () => void): void {
    if (this.#closing) throw new Error('LEDGER_BUSY');
    bundle = structuredClone(bundle);
    if (this.#checkpoint) throw new Error('LEDGER_SEALED');
    if (digest(this.#entries) !== digest(bundle.entries) ||
        verifyAuditEvidence(bundle).status !== 'UNILATERALLY_CLOSED') throw new Error('INVALID_AUDIT_INTERRUPTION');
    if (this.#interruption && digest(this.#interruption) !== digest(bundle.interruption)) throw new Error('LEDGER_SEALED');
    this.#closing = true;
    try { persistInterruptionIntent(beforeWrite); this.#interruption = bundle.interruption; }
    finally { this.#closing = false; }
  }
}
export class JsonlStore implements AuditStore, InterruptionStore {
  constructor(readonly path: string) {}
  /** All cooperating writers use this exclusive file lock. Never share with an older writer.
   * A lock left by process death is an explicit local recovery operation, never stolen. */
  private exclusive<T>(operation: () => T): T {
    const path = resolve(this.path) + '.lock';
    let fd: number;
    try { fd = openSync(path, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('LEDGER_BUSY');
      throw error;
    }
    try { return operation(); }
    finally { closeSync(fd); unlinkSync(path); }
  }
  private records(): AuditRecord[] {
    try {
      return parseRecords(readFileSync(this.path, 'utf8')).map(({ record }) => record);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }
  read(): AuditEntry[] {
    return this.records()
      .filter((r) => r.entry)
      .map((r) => r.entry!);
  }
  append(entry: AuditEntry): void {
    this.exclusive(() => {
      if (this.records().some((r) => r.checkpoint || Object.hasOwn(r, 'interruption'))) throw new Error('LEDGER_SEALED');
      appendFileSync(this.path, JSON.stringify({ entry }) + '\n', { mode: 0o600 });
    });
  }
  seal(checkpoint: AuditBundle['checkpoint']): void {
    this.exclusive(() => {
      const records = this.records();
      if (records.some(r => Object.hasOwn(r, 'interruption'))) throw new Error('LEDGER_SEALED');
      const old = records.at(-1)?.checkpoint;
      if (old) {
        if (digest(old.actor.payload) !== digest(checkpoint.actor.payload)) throw new Error('LEDGER_SEALED');
        return;
      }
      appendFileSync(this.path, JSON.stringify({ checkpoint }) + '\n', { mode: 0o600 });
    });
  }
  closeInterrupted(bundle: InterruptedAuditBundle, beforeWrite?: () => void): void {
    bundle = structuredClone(bundle);
    this.exclusive(() => {
      if (verifyAuditEvidence(bundle).status !== 'UNILATERALLY_CLOSED') throw new Error('INVALID_AUDIT_INTERRUPTION');
      const text = readFileSync(this.path, 'utf8'), records = parseRecords(text);
      const terminal = records.at(-1)?.record.interruption;
      if (terminal) {
        const existing = parseAuditJsonl(text);
        if (digest(existing) !== digest(bundle)) throw new Error('LEDGER_SEALED');
      } else {
        if (records.some(({ record }) => !object(record) || Object.keys(record).length !== 1 || !record.entry) ||
            digest(records.map(({ record }) => record.entry)) !== digest(bundle.entries))
          throw new Error('AUDIT_PREFIX_MISMATCH');
      }
      persistInterruptionIntent(beforeWrite);
      // Journal callbacks must not change the audit. Cooperating processes remain excluded.
      if (readFileSync(this.path, 'utf8') !== text) throw new Error('AUDIT_PREFIX_MISMATCH');
      const fd = openSync(this.path, 'a');
      try {
        if (!terminal) appendFileSync(fd, (text.endsWith('\n') ? '' : '\n') + JSON.stringify({ interruption: bundle.interruption }) + '\n');
        // Includes the original acknowledged prefix, and also retries a failed sync after append.
        fsyncSync(fd);
      } finally { closeSync(fd); }
      if (process.platform !== 'win32') {
        const dir = openSync(dirname(this.path), 'r');
        try { fsyncSync(dir); } finally { closeSync(dir); }
      }
    });
  }
}
export function parseJsonl(text: string): AuditBundle {
  const records = parseRecords(text);
  const last = records.at(-1);
  const misplaced = records.slice(0, -1).find(({ record }) => !object(record)?.entry || object(record)?.checkpoint || Object.hasOwn(record, 'interruption'));
  if (!object(last?.record)?.checkpoint || object(last?.record)?.entry || Object.hasOwn(last!.record, 'interruption') || misplaced) {
    const offending = misplaced ?? last;
    const entry = object(offending?.record)?.entry;
    const checkpoint = object(offending?.record)?.checkpoint;
    const payload = object(object(object(checkpoint)?.actor)?.payload);
    const lastEntry = !entry && !checkpoint
      ? records.findLast(({ record }) => object(record)?.entry) : undefined;
    const location = entry
      ? entryLocation(entry, !misplaced && !object(last?.record)?.checkpoint ? 'last-entry' : 'entry')
      : { locationKind: checkpoint ? 'checkpoint' : 'record', taskId: diagnosticText(payload?.taskId),
        head: diagnosticText(payload?.head), verified: false };
    throw new Error('MISSING_OR_MISPLACED_CHECKPOINT; auditLocation=' + diagnosticJson({
      ...location, line: offending?.line,
      lastEntry: lastEntry ? { ...entryLocation(lastEntry.record.entry, 'last-entry'), line: lastEntry.line } : undefined,
    }));
  }
  const entryRecords = records.slice(0, -1);
  const bundle = { entries: entryRecords.map(({ record }) => record.entry!), checkpoint: last!.record.checkpoint! };
  jsonlLocations.set(bundle, { entryLines: entryRecords.map(({ line }) => line), checkpointLine: last!.line });
  return bundle;
}
export class BilateralLedger {
  constructor(
    readonly taskId: string,
    readonly actors: [string, string],
    readonly store: AuditStore = new MemoryStore(),
  ) {
    if (actors[0] === actors[1]) throw new Error('DISTINCT_ACTORS_REQUIRED');
  }
  private checkpoint(
    entries: AuditEntry[],
    actor: KeyPair,
    receiver: KeyPair,
  ): AuditBundle['checkpoint'] {
    const payload: Checkpoint = {
      type: 'AuditCheckpoint',
      taskId: this.taskId,
      count: entries.length,
      head: entries.at(-1)?.entryHash ?? null,
      actors: this.actors,
    };
    const signed = signPayload(payload, actor);
    return { actor: signed, receiver: signPayload(signed, receiver) };
  }
  append(eventType: string, payload: Json, actor: KeyPair, receiver: KeyPair): AuditEntry {
    if (
      actor.did === receiver.did ||
      !this.actors.includes(actor.did) ||
      !this.actors.includes(receiver.did)
    )
      throw new Error('INVALID_LEDGER_PARTIES');
    const entries = this.store.read();
    if (!verifyAudit({ entries, checkpoint: this.checkpoint(entries, actor, receiver) }).valid)
      throw new Error('CORRUPT_EXISTING_LEDGER');
    const body: AuditBody = {
      taskId: this.taskId,
      seq: entries.length,
      prevEntryHash: entries.at(-1)?.entryHash ?? null,
      actorDid: actor.did,
      receiverDid: receiver.did,
      eventType,
      payload,
    };
    const entryHash = digest(body),
      actorSignature = signPayload(body, actor).signature;
    const counterSignature = signAck(
      {
        type: 'AckReceipt',
        taskId: this.taskId,
        entryHash,
        actorDid: actor.did,
        receiverDid: receiver.did,
      },
      receiver,
    );
    const entry = { body, entryHash, actorSignature, counterSignature };
    validateSchema('audit-entry', entry);
    this.store.append(entry, this.checkpoint([...entries, entry], actor, receiver));
    return entry;
  }
  bundle(actor: KeyPair, receiver: KeyPair): AuditBundle {
    const entries = this.store.read();
    const checkpoint = this.checkpoint(entries, actor, receiver);
    this.store.seal?.(checkpoint);
    return { entries, checkpoint };
  }
}
/** External pin for the bilateral checkpoint. `head` is the checkpoint head. */
export interface AuditTrustAnchor {
  taskId?: string;
  actors?: [string, string];
  head?: string;
  expectedFinalState?: string;
  expectedLastEntryHash?: string;
  expectedEntryCount?: number;
}
export interface AuditVerificationOptions extends AuditTrustAnchor {
  trustAnchor?: AuditTrustAnchor;
}
export interface AuditVerificationResult {
  valid: boolean;
  status: 'VALID' | 'INVALID';
  statusLabel: string;
  trustAnchorVerified: boolean;
  truncationChecked: boolean;
  reason?: string;
}
/**
 * Intact chain with no external anchor. A hash chain cannot tell a complete
 * older log from the current one, so tail truncation is not checked.
 */
export const AUDIT_VALID_WITHOUT_TRUST_ANCHOR =
  'VALID (no trust anchor: truncation not checked)';
function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function textField(primary: string | undefined, fallback: string | undefined): string | undefined {
  if (hasText(primary)) return primary;
  if (hasText(fallback)) return fallback;
  return undefined;
}
function anchorSupplied(options?: AuditVerificationOptions): boolean {
  if (!options) return false;
  return [options, options.trustAnchor].some((part) => {
    if (!part) return false;
    return (
      part.taskId !== undefined ||
      part.actors !== undefined ||
      hasText(part.head) ||
      hasText(part.expectedFinalState) ||
      hasText(part.expectedLastEntryHash) ||
      typeof part.expectedEntryCount === 'number'
    );
  });
}
function sameAnchorField(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return true;
  return digest(left) === digest(right);
}
function resolveAnchor(options?: AuditVerificationOptions): AuditTrustAnchor {
  const nested = options?.trustAnchor;
  if (
    options &&
    nested &&
    (!sameAnchorField(options.taskId, nested.taskId) ||
      !sameAnchorField(options.actors, nested.actors) ||
      !sameAnchorField(options.head, nested.head) ||
      !sameAnchorField(options.expectedFinalState, nested.expectedFinalState) ||
      !sameAnchorField(options.expectedLastEntryHash, nested.expectedLastEntryHash) ||
      !sameAnchorField(options.expectedEntryCount, nested.expectedEntryCount))
  )
    throw new Error('trust anchor');
  return {
    taskId: options?.taskId ?? nested?.taskId,
    actors: options?.actors ?? nested?.actors,
    head: textField(options?.head, nested?.head),
    expectedFinalState: textField(options?.expectedFinalState, nested?.expectedFinalState),
    expectedLastEntryHash: textField(options?.expectedLastEntryHash, nested?.expectedLastEntryHash),
    expectedEntryCount: options?.expectedEntryCount ?? nested?.expectedEntryCount,
  };
}
function assertTrustAnchor(
  anchor: AuditTrustAnchor,
  checkpoint: Checkpoint,
  entries: AuditEntry[],
): void {
  if (anchor.taskId !== undefined && anchor.taskId !== checkpoint.taskId)
    throw new Error('trust anchor');
  if (anchor.actors !== undefined) {
    if (
      !Array.isArray(anchor.actors) ||
      anchor.actors.length !== 2 ||
      digest(anchor.actors) !== digest(checkpoint.actors)
    )
      throw new Error('trust anchor');
  }
  const last = entries.at(-1)?.entryHash ?? null;
  if (anchor.head !== undefined && anchor.head !== checkpoint.head) throw new Error('trust anchor');
  if (anchor.expectedLastEntryHash !== undefined && anchor.expectedLastEntryHash !== last)
    throw new Error('trust anchor');
  if (anchor.expectedEntryCount !== undefined) {
    if (
      typeof anchor.expectedEntryCount !== 'number' ||
      !Number.isSafeInteger(anchor.expectedEntryCount) ||
      anchor.expectedEntryCount < 0 ||
      anchor.expectedEntryCount !== checkpoint.count
    )
      throw new Error('trust anchor');
  }
  if (
    anchor.expectedFinalState !== undefined &&
    entries.at(-1)?.body.eventType !== anchor.expectedFinalState
  )
    throw new Error('trust anchor');
}
function auditResult(supplied: boolean, error?: unknown): AuditVerificationResult {
  if (error !== undefined)
    return {
      valid: false,
      status: 'INVALID',
      statusLabel: 'INVALID',
      trustAnchorVerified: false,
      truncationChecked: supplied,
      reason: String(error),
    };
  if (!supplied)
    return {
      valid: true,
      status: 'VALID',
      statusLabel: AUDIT_VALID_WITHOUT_TRUST_ANCHOR,
      trustAnchorVerified: false,
      truncationChecked: false,
    };
  return {
    valid: true,
    status: 'VALID',
    statusLabel: 'VALID',
    trustAnchorVerified: true,
    truncationChecked: true,
  };
}
function verificationError(error: unknown): string {
  // Retain existing verifier codes and schema explanations, without forwarding arbitrary exceptions.
  if (error instanceof Error && (/^(checkpoint|trust anchor|entry \d+|[A-Z][A-Z0-9_]{0,79})$/.test(error.message)
    || error.message.startsWith('SCHEMA_VIOLATION: '))) {
    const message = error.message;
    const bounded = message.length > 1024 ? message.slice(0, 1024) + '...' : message;
    return 'Error: ' + diagnosticJson(bounded).slice(1, -1);
  }
  return error instanceof TypeError ? 'TypeError' : 'Error';
}
export function verifyAudit(
  bundle: AuditBundle,
  expected?: AuditVerificationOptions,
): AuditVerificationResult {
  const supplied = anchorSupplied(expected);
  let location: unknown = checkpointLocation(bundle);
  try {
    if (object(bundle) && Object.hasOwn(bundle, 'interruption')) throw new Error('checkpoint');
    const { entries, checkpoint } = bundle,
      c = checkpoint.actor.payload;
    const selfDelegated = Array.isArray(c?.actors) && c.actors.length === 2 && c.actors[0] === c.actors[1];
    if (
      c.type !== 'AuditCheckpoint' ||
      c.actors.length !== 2 ||
      !c.actors.includes(checkpoint.actor.signature.signerDid) ||
      !c.actors.includes(checkpoint.receiver.signature.signerDid) ||
      (!selfDelegated &&
        checkpoint.actor.signature.signerDid === checkpoint.receiver.signature.signerDid) ||
      !verifySigned(checkpoint.actor) ||
      !verifySigned(checkpoint.receiver) ||
      digest(checkpoint.receiver.payload) !== digest(checkpoint.actor) ||
      c.count !== entries.length ||
      c.head !== (entries.at(-1)?.entryHash ?? null)
    )
      throw new Error('checkpoint');
    assertTrustAnchor(resolveAnchor(expected), c, entries);
    for (let i = 0; i < entries.length; i++) {
      location = entryLocation(entries[i], 'entry', i, jsonlLocations.get(bundle)?.entryLines[i]);
      const e = entries[i],
        b = e.body,
        a = e.counterSignature;
      validateSchema('audit-entry', e);
      if (
        b.taskId !== c.taskId ||
        b.seq !== i ||
        b.prevEntryHash !== (entries[i - 1]?.entryHash ?? null) ||
        e.entryHash !== digest(b) ||
        !c.actors.includes(b.actorDid) ||
        !c.actors.includes(b.receiverDid) ||
        (!selfDelegated && b.actorDid === b.receiverDid) ||
        !verifySignature(b, e.actorSignature, b.actorDid) ||
        !verifySigned(a, b.receiverDid) ||
        a.payload.entryHash !== e.entryHash ||
        a.payload.taskId !== b.taskId ||
        a.payload.actorDid !== b.actorDid ||
        a.payload.receiverDid !== b.receiverDid
      )
        throw new Error('entry ' + i);
    }
    return auditResult(supplied);
  } catch (e) {
    return auditResult(supplied, verificationError(e) + '; auditLocation=' + diagnosticJson(location));
  }
}

export interface AuditEvidenceTrustAnchor extends AuditTrustAnchor {
  expectedClosureKind?: 'bilateral' | 'interruption';
  expectedInterruptionHash?: string;
}
export interface AuditEvidenceVerificationOptions extends AuditEvidenceTrustAnchor {
  trustAnchor?: AuditEvidenceTrustAnchor;
}
export interface InterruptedAuditVerificationResult {
  valid: false;
  status: 'UNILATERALLY_CLOSED' | 'INVALID';
  statusLabel: string;
  reason: string;
  prefixVerified: boolean;
  terminalSignatureVerified: boolean;
  bilateralCheckpointVerified: false;
  trustAnchorVerified: boolean;
  /** For interruption only: an actual tail condition was compared, not identity alone. */
  truncationChecked: boolean;
  closureKind: 'interruption';
}
export type AuditEvidenceVerificationResult = AuditVerificationResult | InterruptedAuditVerificationResult;
const interruptionLocations = new WeakMap<InterruptedAuditBundle, { entryLines: number[]; terminalLine: number }>();
function interruptionLocation(bundle: InterruptedAuditBundle) {
  const signed = object(bundle?.interruption), p = object(signed?.payload);
  const source = interruptionLocations.get(bundle);
  const entries = Array.isArray(bundle?.entries) ? bundle.entries : [];
  let interruptionHash: string | undefined;
  try { if (p) interruptionHash = digest(p); } catch { /* Only expose a computed digest. */ }
  return {
    locationKind: 'interruption', taskId: diagnosticText(p?.taskId),
    seq: typeof p?.seq === 'number' && Number.isSafeInteger(p.seq) && p.seq >= 0 ? p.seq : undefined,
    interruptionHash, line: source?.terminalLine, verified: false,
    lastEntry: entries.length ? entryLocation(entries.at(-1), 'last-entry', entries.length - 1, source?.entryLines.at(-1)) : undefined,
  };
}
/** Read either terminal form, retaining physical JSONL locations out of band. */
export function parseAuditJsonl(text: string): AuditEvidence {
  const records = parseRecords(text);
  // Keep the bilateral parser's diagnostics for old files, including missing checkpoints.
  if (!records.some(({ record }) => object(record) && Object.hasOwn(record, 'interruption'))) {
    const bilateral = parseJsonl(text);
    const malformed = records.find(({ record }) => !object(record) || Object.keys(record).length !== 1 ||
      !['entry', 'checkpoint'].includes(Object.keys(record)[0]));
    if (!malformed) return bilateral;
    throw new Error('INVALID_AUDIT_RECORD; auditLocation=' + diagnosticJson({ line: malformed.line, verified: false }));
  }
  const bad = records.find(({ record }, index) => {
    const r = object(record);
    return !r || Object.keys(r).length !== 1 ||
      (index === records.length - 1 ? !Object.hasOwn(r, 'interruption') : !Object.hasOwn(r, 'entry'));
  });
  if (bad) throw new Error('MISPLACED_AUDIT_TERMINAL; auditLocation=' + diagnosticJson({ line: bad.line, verified: false }));
  const bundle = { entries: records.slice(0, -1).map(({ record }) => record.entry!), interruption: records.at(-1)!.record.interruption! };
  interruptionLocations.set(bundle, { entryLines: records.slice(0, -1).map(({ line }) => line), terminalLine: records.at(-1)!.line });
  return bundle;
}

/** Verify a PROPOSE-only acknowledged prefix, including offline manifest roles/signature. */
function assertInterruptionPrefix(entries: AuditEntry[], taskId: string, actors: [string, string]): void {
  if (!Array.isArray(entries) || entries.length !== 1 || actors.length !== 2 || actors[0] === actors[1])
    throw new Error('INTERRUPTION_SCOPE');
  const e = entries[0];
  validateSchema('audit-entry', e);
  const b = e.body, a = e.counterSignature;
  if (b.eventType !== 'PROPOSE' || b.taskId !== taskId || b.seq !== 0 || b.prevEntryHash !== null ||
      b.actorDid !== actors[0] || b.receiverDid !== actors[1] || e.entryHash !== digest(b) ||
      !verifySignature(b, e.actorSignature, actors[0]) || !verifySigned(a, actors[1]) ||
      a.payload.type !== 'AckReceipt' || a.payload.taskId !== taskId || a.payload.entryHash !== e.entryHash ||
      a.payload.actorDid !== actors[0] || a.payload.receiverDid !== actors[1]) throw new Error('entry 0');
  const proposal = object(b.payload)?.proposal as Signed<TaskManifest> | undefined;
  if (!proposal) throw new Error('INTERRUPTION_MANIFEST');
  validateManifest(proposal.payload);
  if (!verifySigned(proposal, actors[0]) || proposal.payload.taskId !== taskId ||
      proposal.payload.requester.ownerDid !== actors[0] || proposal.payload.worker?.ownerDid !== actors[1])
    throw new Error('INTERRUPTION_MANIFEST');
  // Deliberately no live expiry, retirement clock, or peer-floor policy in offline verification.
}
function evidencePins(options?: AuditEvidenceVerificationOptions): AuditEvidenceTrustAnchor {
  const base = resolveAnchor(options);
  for (const key of ['expectedClosureKind', 'expectedInterruptionHash'] as const) {
    if (!sameAnchorField(options?.[key], options?.trustAnchor?.[key])) throw new Error('trust anchor');
  }
  return { ...base,
    expectedClosureKind: options?.expectedClosureKind ?? options?.trustAnchor?.expectedClosureKind,
    expectedInterruptionHash: options?.expectedInterruptionHash ?? options?.trustAnchor?.expectedInterruptionHash };
}
function assertInterruptionPins(options?: AuditEvidenceVerificationOptions): void {
  if (options !== undefined && !object(options)) throw new Error('trust anchor');
  if (options?.trustAnchor !== undefined && !object(options.trustAnchor)) throw new Error('trust anchor');
  for (const part of [options, options?.trustAnchor]) {
    if (!part) continue;
    for (const key of ['taskId', 'head', 'expectedLastEntryHash', 'expectedFinalState', 'expectedInterruptionHash'] as const)
      if (part[key] !== undefined && !hasText(part[key])) throw new Error('trust anchor');
    if (part.expectedClosureKind !== undefined && !['bilateral', 'interruption'].includes(part.expectedClosureKind))
      throw new Error('trust anchor');
    if (part.actors !== undefined && (!Array.isArray(part.actors) || part.actors.length !== 2 || !part.actors.every(hasText)))
      throw new Error('trust anchor');
    if (part.expectedEntryCount !== undefined && (!Number.isSafeInteger(part.expectedEntryCount) || part.expectedEntryCount < 0))
      throw new Error('trust anchor');
  }
}
/** Both formats are verified locally. A worker-only observation never becomes VALID. */
export function verifyAuditEvidence(bundle: unknown, expected?: AuditEvidenceVerificationOptions): AuditEvidenceVerificationResult {
  const value = object(bundle);
  if (!value || !Object.hasOwn(value, 'interruption')) {
    const bilateral = bundle as AuditBundle;
    const result = verifyAudit(bilateral, expected);
    if (!result.valid) return result;
    try {
      validateSchema('audit-evidence', bundle);
      const pins = evidencePins(expected);
      if (pins.expectedClosureKind !== undefined && pins.expectedClosureKind !== 'bilateral' ||
          pins.expectedInterruptionHash !== undefined) throw new Error('trust anchor');
      return pins.expectedClosureKind === 'bilateral' ? { ...result, trustAnchorVerified: true } : result;
    } catch (error) {
      return auditResult(anchorSupplied(expected), verificationError(error) + '; auditLocation=' + diagnosticJson(checkpointLocation(bilateral)));
    }
  }
  const interrupted = bundle as InterruptedAuditBundle;
  let prefixVerified = false, terminalSignatureVerified = false, truncationChecked = false;
  let location: unknown = interruptionLocation(interrupted);
  try {
    // Exclusive object shape and terminal schema before interpreting its fields.
    if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'entries')) throw new Error('INVALID_AUDIT_EVIDENCE');
    validateSchema('audit-interruption', interrupted.interruption);
    const { entries, interruption } = interrupted, p = interruption.payload;
    location = entryLocation(entries?.[0], 'entry', 0, interruptionLocations.get(interrupted)?.entryLines[0]);
    assertInterruptionPrefix(entries, p.taskId, p.actors);
    prefixVerified = true;
    location = interruptionLocation(interrupted);
    const prefix = p.acknowledgedPrefix, head = entries[0].entryHash;
    if (p.formatVersion !== 1 || p.seq !== 1 || prefix.count !== 1 || prefix.lastSeq !== 0 ||
        p.prevEntryHash !== head || prefix.head !== head || prefix.entriesDigest !== digest(entries) ||
        !Number.isSafeInteger(p.seq) || !Number.isSafeInteger(prefix.count) || !Number.isSafeInteger(prefix.lastSeq) ||
        p.observedAt !== interruption.signature.signedAt || !Number.isFinite(Date.parse(p.observedAt)) ||
        !verifySigned(interruption, p.actors[1])) throw new Error('INVALID_AUDIT_INTERRUPTION');
    terminalSignatureVerified = true;
    assertInterruptionPins(expected);
    const pins = evidencePins(expected);
    const prefixCheckpoint: Checkpoint = { type: 'AuditCheckpoint', taskId: p.taskId, actors: p.actors, count: 1, head };
    assertTrustAnchor({ taskId: pins.taskId, actors: pins.actors }, prefixCheckpoint, entries);
    if (pins.expectedClosureKind !== undefined && pins.expectedClosureKind !== 'interruption') throw new Error('trust anchor');
    if ([pins.head, pins.expectedLastEntryHash, pins.expectedFinalState, pins.expectedEntryCount].some(v => v !== undefined)) {
      truncationChecked = true;
      assertTrustAnchor(pins, prefixCheckpoint, entries);
    }
    if (pins.expectedInterruptionHash !== undefined) {
      truncationChecked = true;
      if (pins.expectedInterruptionHash !== digest(p)) throw new Error('trust anchor');
    }
    const supplied = anchorSupplied(expected) || pins.expectedClosureKind !== undefined || pins.expectedInterruptionHash !== undefined;
    return { valid: false, status: 'UNILATERALLY_CLOSED',
      statusLabel: 'UNILATERALLY_CLOSED (worker-only terminal; no peer terminal signature)', reason: 'WORKER_ONLY_INTERRUPTION',
      prefixVerified, terminalSignatureVerified, bilateralCheckpointVerified: false,
      trustAnchorVerified: supplied, truncationChecked, closureKind: 'interruption' };
  } catch (error) {
    return { valid: false, status: 'INVALID', statusLabel: 'INVALID',
      reason: verificationError(error) + '; auditLocation=' + diagnosticJson(location),
      prefixVerified, terminalSignatureVerified, bilateralCheckpointVerified: false,
      trustAnchorVerified: false, truncationChecked, closureKind: 'interruption' };
  }
}
/** Creates a worker observation; callers must preserve the original prefix and journal the intent before writing. */
export function createAuditInterruption(entries: AuditEntry[], worker: KeyPair,
  phase: AuditInterruption['phase'], reason: AuditInterruption['reason'], observedAt = new Date().toISOString()): Signed<AuditInterruption> {
  const first = entries[0];
  if (!first) throw new Error('INTERRUPTION_SCOPE');
  const actors: [string, string] = [first.body.actorDid, worker.did];
  assertInterruptionPrefix(entries, first.body.taskId, actors);
  const payload: AuditInterruption = { type: 'AuditInterruption', formatVersion: 1,
    taskId: first.body.taskId, actors, seq: 1, prevEntryHash: first.entryHash,
    acknowledgedPrefix: { count: 1, lastSeq: 0, head: first.entryHash, entriesDigest: digest(entries) },
    phase, reason, observedAt };
  const interruption = signPayload(payload, worker, observedAt);
  if (verifyAuditEvidence({ entries, interruption }).status !== 'UNILATERALLY_CLOSED') throw new Error('INVALID_AUDIT_INTERRUPTION');
  return interruption;
}
