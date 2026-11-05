// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, readFileSync } from 'node:fs';
import {
  digest,
  signPayload,
  signAck,
  verifySigned,
  verifySignature,
  validateSchema,
} from '@acp/core';
import type { Json, Signature, AckReceipt, KeyPair, Signed } from '@acp/core';
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
// Source locations are diagnostic metadata only: never serialize them into a bundle.
const jsonlLocations = new WeakMap<AuditBundle, { entryLines: number[]; checkpointLine: number }>();
type AuditRecord = { entry?: AuditEntry; checkpoint?: AuditBundle['checkpoint'] };
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
export class MemoryStore implements AuditStore {
  #entries: AuditEntry[] = [];
  read(): AuditEntry[] {
    return structuredClone(this.#entries);
  }
  append(entry: AuditEntry): void {
    this.#entries.push(structuredClone(entry));
  }
}
export class JsonlStore implements AuditStore {
  constructor(readonly path: string) {}
  private records(): { entry?: AuditEntry; checkpoint?: AuditBundle['checkpoint'] }[] {
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
    if (this.records().some((r) => r.checkpoint)) throw new Error('LEDGER_SEALED');
    appendFileSync(this.path, JSON.stringify({ entry }) + '\n', { mode: 0o600 });
  }
  seal(checkpoint: AuditBundle['checkpoint']): void {
    const old = this.records().at(-1)?.checkpoint;
    if (old) {
      if (digest(old.actor.payload) !== digest(checkpoint.actor.payload))
        throw new Error('LEDGER_SEALED');
      return;
    }
    appendFileSync(this.path, JSON.stringify({ checkpoint }) + '\n', { mode: 0o600 });
  }
}
export function parseJsonl(text: string): AuditBundle {
  const records = parseRecords(text);
  const last = records.at(-1);
  const misplaced = records.slice(0, -1).find(({ record }) => !object(record)?.entry || object(record)?.checkpoint);
  if (!object(last?.record)?.checkpoint || object(last?.record)?.entry || misplaced) {
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
