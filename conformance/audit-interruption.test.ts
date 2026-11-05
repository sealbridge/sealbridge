// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest, generateKeyPair, signPayload, validateOutput, validateSchema } from '../packages/core/src/index.js';
import type { Json } from '../packages/core/src/index.js';
import { BilateralLedger, createAuditInterruption, JsonlStore, MemoryStore, parseAuditJsonl, parseJsonl,
  verifyAudit, verifyAuditEvidence } from '../packages/ledger/src/index.js';
import type { AuditBundle, AuditEvidenceVerificationOptions, AuditInterruption, InterruptedAuditBundle } from '../packages/ledger/src/index.js';
import { AcpMcpServer, buildTaskManifest } from '../packages/runtime/src/index.js';
import { createReceipt } from '../cli/src/receipt.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function directory() { const dir = mkdtempSync(join(tmpdir(), 'audit-interruption-')); dirs.push(dir); return dir; }
function fixture(version: '0.1.0' | '0.2.0' = '0.2.0') {
  const requester = generateKeyPair(), worker = generateKeyPair();
  const manifest = buildTaskManifest({ ownerDid: requester.did, workerDid: worker.did, protocolVersion: version,
    title: 'Interruption', description: 'Offline PROPOSE evidence', now: () => Date.parse('2020-01-01T00:00:00Z') });
  const ledger = new BilateralLedger(manifest.taskId, [requester.did, worker.did]);
  ledger.append('PROPOSE', { proposal: signPayload(manifest, requester), input: {}, capabilityChains: [] } as unknown as Json, requester, worker);
  const entries = ledger.store.read();
  const interruption = createAuditInterruption(entries, worker, 'OWNER_APPROVAL', 'SESSION_TIMEOUT', '2020-01-01T00:01:00.000Z');
  const bundle: InterruptedAuditBundle = { entries, interruption };
  return { requester, worker, ledger, entries, interruption, bundle };
}
function jsonl(b: InterruptedAuditBundle) {
  return '\r\n\n' + b.entries.map(entry => JSON.stringify({ entry }) + '\r\n\n').join('')
    + JSON.stringify({ interruption: b.interruption }) + '\r\n';
}
function cli(path: string, ...flags: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const dir = directory(), outPath = join(dir, 'stdout'), errPath = join(dir, 'stderr');
    const out = openSync(outPath, 'w'), err = openSync(errPath, 'w');
    let child;
    try { child = spawn(process.execPath, ['cli/dist/index.js', 'audit-verify', path, ...flags], { stdio: ['ignore', out, err] }); }
    finally { closeSync(out); closeSync(err); }
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: readFileSync(outPath, 'utf8'), stderr: readFileSync(errPath, 'utf8') }));
  });
}

describe('AuditInterruption format 1 reader and verifier', () => {
  it.each(['0.1.0', '0.2.0'] as const)('verifies an expired %s manifest offline without live clocks or peer-floor changes', version => {
    const f = fixture(version), parsed = parseAuditJsonl(jsonl(f.bundle));
    expect(parsed).toEqual(f.bundle);
    expect(verifyAuditEvidence(parsed)).toMatchObject({ valid: false, status: 'UNILATERALLY_CLOSED',
      reason: 'WORKER_ONLY_INTERRUPTION', prefixVerified: true, terminalSignatureVerified: true,
      bilateralCheckpointVerified: false, trustAnchorVerified: false, truncationChecked: false, closureKind: 'interruption' });
    expect(() => parseJsonl(jsonl(f.bundle))).toThrow('MISSING_OR_MISPLACED_CHECKPOINT');
    expect(verifyAudit(f.bundle as unknown as AuditBundle).status).toBe('INVALID');
    for (const schema of ['audit-evidence', 'audit-interruption', 'audit-file-record']) {
      const value = schema === 'audit-evidence' ? f.bundle : schema === 'audit-interruption' ? f.interruption : { interruption: f.interruption };
      expect(() => validateSchema(schema, value)).not.toThrow();
    }
    expect(digest(f.interruption.payload)).toBe(f.interruption.signature.payloadDigest);
  });

  const changes: Array<[string, (p: AuditInterruption) => void]> = [
    ['task', p => { p.taskId += '_other'; }],
    ['actors reversed', p => { p.actors.reverse(); }],
    ['same owner', p => { p.actors[0] = p.actors[1]; }],
    ['seq', p => { p.seq = 2; }], ['negative seq', p => { p.seq = -1; }],
    ['fractional seq', p => { p.seq = 1.1; }], ['unsafe seq', p => { p.seq = Number.MAX_SAFE_INTEGER + 1; }],
    ['prev hash', p => { p.prevEntryHash = 'sha256:' + '0'.repeat(64); }],
    ['count', p => { p.acknowledgedPrefix.count = 2; }],
    ['last seq', p => { p.acknowledgedPrefix.lastSeq = 1; }],
    ['head', p => { p.acknowledgedPrefix.head = 'sha256:' + '0'.repeat(64); }],
    ['entries digest', p => { p.acknowledgedPrefix.entriesDigest = 'sha256:' + '0'.repeat(64); }],
    ['uppercase hash', p => { p.prevEntryHash = 'sha256:' + 'A'.repeat(64); }],
    ['unknown version', p => { (p as { formatVersion: number }).formatVersion = 2; }],
    ['unknown phase', p => { (p as { phase: string }).phase = 'RUNNING'; }],
    ['unknown reason', p => { (p as { reason: string }).reason = 'REQUESTER_DIED'; }],
    ['extra field', p => { Object.assign(p, { arbitrary: true }); }],
    ['extra prefix field', p => { Object.assign(p.acknowledgedPrefix, { arbitrary: true }); }],
    ['non UTC timestamp', p => { p.observedAt = '2020-01-01T00:00:00+09:00'; }],
    ['invalid date', p => { p.observedAt = '2020-02-30T00:00:00Z'; }],
  ];
  it.each(changes)('rejects signed misuse: %s', (_name, change) => {
    const f = fixture(); change(f.interruption.payload);
    f.bundle.interruption = signPayload(f.interruption.payload, f.worker, f.interruption.payload.observedAt);
    expect(verifyAuditEvidence(f.bundle).status).toBe('INVALID');
  });
  it('requires the worker owner signature and exact signedAt, including signature metadata', () => {
    const f = fixture();
    for (const key of [f.requester, generateKeyPair()]) {
      expect(verifyAuditEvidence({ ...f.bundle, interruption: signPayload(f.interruption.payload, key, f.interruption.payload.observedAt) }).status).toBe('INVALID');
    }
    f.bundle.interruption = signPayload(f.interruption.payload, f.worker, '2020-01-01T00:02:00Z');
    expect(verifyAuditEvidence(f.bundle).status).toBe('INVALID');
    f.interruption.signature.signedAt = '2020-01-01T00:03:00Z';
    expect(verifyAuditEvidence({ ...f.bundle, interruption: f.interruption }).status).toBe('INVALID');
  });
  it('requires every entry signature and binds the whole saved prefix, not only its body hash', () => {
    const f = fixture(), originalHash = f.entries[0].entryHash;
    f.entries[0].actorSignature = signPayload(f.entries[0].body, f.requester, '2021-01-01T00:00:00Z').signature;
    expect(f.entries[0].entryHash).toBe(originalHash);
    expect(verifyAuditEvidence(f.bundle)).toMatchObject({ status: 'INVALID', prefixVerified: true });
    f.bundle.interruption = createAuditInterruption(f.entries, f.worker, 'ACCEPT_ACK_WAIT', 'SESSION_TIMEOUT');
    expect(verifyAuditEvidence(f.bundle).status).toBe('UNILATERALLY_CLOSED');
    delete (f.entries[0] as Partial<typeof f.entries[0]>).counterSignature;
    expect(verifyAuditEvidence(f.bundle)).toMatchObject({ status: 'INVALID', prefixVerified: false });
  });
  it('validates manifest task, roles and signature independently of entry signatures', () => {
    for (const change of ['signature', 'task', 'worker', 'schema']) {
      const f = fixture();
      const payload = structuredClone(f.entries[0].body.payload) as any;
      if (change === 'signature') payload.proposal.signature.signature = 'ed25519:' + 'A'.repeat(86);
      if (change === 'task') payload.proposal.payload.taskId += '_other';
      if (change === 'worker') payload.proposal.payload.worker.ownerDid = generateKeyPair().did;
      if (change === 'schema') payload.proposal.payload.protocolVersion = '9.0.0';
      if (change !== 'signature') payload.proposal = signPayload(payload.proposal.payload, f.requester);
      const ledger = new BilateralLedger(f.entries[0].body.taskId, [f.requester.did, f.worker.did]);
      ledger.append('PROPOSE', payload, f.requester, f.worker);
      const entries = ledger.store.read();
      const p = { ...f.interruption.payload, prevEntryHash: entries[0].entryHash,
        acknowledgedPrefix: { count: 1, lastSeq: 0, head: entries[0].entryHash, entriesDigest: digest(entries) } };
      expect(verifyAuditEvidence({ entries, interruption: signPayload(p, f.worker, p.observedAt) }).status).toBe('INVALID');
    }
  });
  it('rejects empty and longer prefixes, including ACCEPT, SETTLED and CANCEL', () => {
    const f = fixture();
    expect(verifyAuditEvidence({ ...f.bundle, entries: [] }).status).toBe('INVALID');
    for (const event of ['ACCEPT', 'SETTLED', 'CANCEL']) {
      const ledger = new BilateralLedger(f.entries[0].body.taskId, [f.requester.did, f.worker.did]);
      ledger.append(event, {}, f.requester, f.worker);
      expect(verifyAuditEvidence({ ...f.bundle, entries: ledger.store.read() }).status).toBe('INVALID');
    }
    f.ledger.append('ACCEPT', {}, f.worker, f.requester);
    expect(verifyAuditEvidence({ ...f.bundle, entries: f.ledger.store.read() }).status).toBe('INVALID');
  });
  it('rejects every misplaced or mixed terminal, unknown row, and exclusive-object violation', () => {
    const f = fixture(), e = { entry: f.entries[0] }, i = { interruption: f.interruption };
    const c = { checkpoint: f.ledger.bundle(f.requester, f.worker).checkpoint };
    for (const records of [[i, e], [e, i, e], [e, i, i], [e, c, i], [e, i, c], [e, { ...i, ...c }],
      [e, { ...i, ...e }], [e, {}, i], [e, { unknown: true }], [e, { ...c, ...e }]]) {
      expect(() => parseAuditJsonl(records.map(r => JSON.stringify(r)).join('\n'))).toThrow();
    }
    expect(verifyAuditEvidence({ ...f.bundle, checkpoint: c.checkpoint }).status).toBe('INVALID');
    expect(verifyAudit({ ...f.bundle, checkpoint: c.checkpoint } as AuditBundle).status).toBe('INVALID');
    expect(verifyAuditEvidence({ ...f.bundle, extra: true }).status).toBe('INVALID');
    expect(() => parseAuditJsonl(jsonl(f.bundle) + '{"body":"acp-invite:never-echo"')).toThrow('Invalid JSON');
  });
  it('retains D8 terminal and entry physical locations without reflecting task content', () => {
    const f = fixture(); f.interruption.signature.signature = 'ed25519:' + 'A'.repeat(86);
    const terminal = verifyAuditEvidence(parseAuditJsonl(jsonl(f.bundle)));
    const loc = JSON.parse(terminal.reason!.split('; auditLocation=')[1]);
    expect(loc).toMatchObject({ locationKind: 'interruption', taskId: f.entries[0].body.taskId, seq: 1,
      interruptionHash: digest(f.interruption.payload), line: 5,
      lastEntry: { line: 3, seq: 0, entryHash: f.entries[0].entryHash }, verified: false });
    f.entries[0].body.payload = { private: 'not-for-diagnostics' };
    const entry = verifyAuditEvidence(parseAuditJsonl(jsonl(f.bundle)));
    expect(JSON.parse(entry.reason!.split('; auditLocation=')[1])).toMatchObject({ locationKind: 'entry', line: 3, seq: 0 });
    expect(entry.reason).not.toContain('not-for-diagnostics');
  });
  it('compares every independent pin without promoting worker evidence or claiming latest history', () => {
    const f = fixture(), p = f.interruption.payload;
    const pins: AuditEvidenceVerificationOptions = { taskId: p.taskId, actors: p.actors };
    expect(verifyAuditEvidence(f.bundle, pins)).toMatchObject({ status: 'UNILATERALLY_CLOSED', trustAnchorVerified: true, truncationChecked: false });
    expect(verifyAuditEvidence(f.bundle, { expectedClosureKind: 'interruption' })).toMatchObject({ trustAnchorVerified: true, truncationChecked: false });
    for (const pin of [{ head: p.prevEntryHash }, { expectedLastEntryHash: p.prevEntryHash }, { expectedEntryCount: 1 },
      { expectedFinalState: 'PROPOSE' }, { expectedInterruptionHash: digest(p) }]) {
      expect(verifyAuditEvidence(f.bundle, pin)).toMatchObject({ valid: false, status: 'UNILATERALLY_CLOSED', trustAnchorVerified: true, truncationChecked: true });
    }
    for (const pin of [{ head: 'sha256:' + '0'.repeat(64) }, { expectedLastEntryHash: 'sha256:' + '0'.repeat(64) },
      { expectedEntryCount: 2 }, { expectedFinalState: 'SETTLED' }, { expectedInterruptionHash: 'sha256:' + '0'.repeat(64) },
      { taskId: p.taskId + '_other' }, { actors: [p.actors[1], p.actors[0]] as [string, string] }, { expectedClosureKind: 'bilateral' as const },
      { expectedClosureKind: 'interruption' as const, trustAnchor: { expectedClosureKind: 'bilateral' as const } }]) {
      expect(verifyAuditEvidence(f.bundle, pin)).toMatchObject({ status: 'INVALID', valid: false, trustAnchorVerified: false });
    }
    expect(verifyAuditEvidence(f.bundle, { taskId: p.taskId + '_other', head: p.prevEntryHash })).toMatchObject({ status: 'INVALID', truncationChecked: false });
    expect(verifyAuditEvidence(f.bundle, { expectedClosureKind: 'bilateral', expectedInterruptionHash: digest(p) })).toMatchObject({ status: 'INVALID', truncationChecked: false });
    const bilateral = f.ledger.bundle(f.requester, f.worker);
    expect(verifyAuditEvidence(bilateral)).toEqual(verifyAudit(bilateral));
    // Preserve the old bilateral identity-only semantics (D7).
    expect(verifyAuditEvidence(bilateral, pins)).toMatchObject({ valid: true, truncationChecked: true });
    expect(verifyAuditEvidence(bilateral, { expectedClosureKind: 'interruption' }).status).toBe('INVALID');
    expect(verifyAuditEvidence(bilateral, { expectedInterruptionHash: digest(p) }).status).toBe('INVALID');
    expect(verifyAuditEvidence(f.bundle)).toEqual(verifyAuditEvidence(structuredClone(f.bundle)));
  });
  it.each([{ actors: null }, { expectedEntryCount: null }, { expectedEntryCount: -1 }, { head: '' },
    { trustAnchor: null }, { expectedInterruptionHash: '' }])('rejects malformed interruption pins %j', options => {
    expect(verifyAuditEvidence(fixture().bundle, options as unknown as AuditEvidenceVerificationOptions)).toMatchObject({ status: 'INVALID', truncationChecked: false });
  });
  it('preserves independent longer and completed histories without merging or revoking their evidence', () => {
    const f = fixture();
    for (const event of ['ACCEPT', 'START', 'DELIVER', 'VERIFY_ACCEPT', 'SETTLED']) f.ledger.append(event, {}, f.worker, f.requester);
    const completed = f.ledger.bundle(f.requester, f.worker);
    expect(verifyAuditEvidence(completed).status).toBe('VALID');
    expect(verifyAuditEvidence(f.bundle).status).toBe('UNILATERALLY_CLOSED');
    expect(verifyAuditEvidence(f.bundle, { expectedEntryCount: completed.entries.length }).status).toBe('INVALID');
    expect(verifyAuditEvidence(f.bundle, { head: completed.checkpoint.actor.payload.head! }).status).toBe('INVALID');
    expect(verifyAuditEvidence(f.bundle, { expectedFinalState: 'SETTLED' }).status).toBe('INVALID');
    // A separately retained shorter copy cannot be inferred or declared contradictory from this bundle alone.
    expect(f.bundle.entries).toHaveLength(1); expect(completed.entries).toHaveLength(6);
  });
  it('keeps interruption evidence out of completed receipts without adding a receipt state', () => {
    const f = fixture(), receipt = createReceipt(jsonl(f.bundle));
    expect(receipt.status).toBe('INVALID');
    expect(receipt.message).toContain('Worker-only signed interruption');
    expect(receipt.verification.status).toBe('UNILATERALLY_CLOSED');
    expect(receipt.taskId).toBeNull();
    expect(receipt.who).toEqual([]);
  });
  it('reports CLI status and exit 2 for JSON/JSONL and exit 1 for mismatched pins', async () => {
    const f = fixture(), dir = directory();
    const anchor = join(dir, 'closure-anchor.json'); writeFileSync(anchor, JSON.stringify({ expectedClosureKind: 'interruption' }));
    for (const [name, content] of [['audit.jsonl', jsonl(f.bundle)], ['bundle.json', JSON.stringify(f.bundle)]]) {
      const path = join(dir, name); writeFileSync(path, content);
      const result = await cli(path);
      expect(result.code).toBe(2); expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'UNILATERALLY_CLOSED', valid: false });
      const pinned = await cli(path, '--expect-closure-kind', 'interruption', '--expect-interruption-hash', digest(f.interruption.payload));
      expect(pinned.code).toBe(2);
      expect(JSON.parse(pinned.stdout)).toMatchObject({ trustAnchorVerified: true, truncationChecked: true });
      const identityOnly = await cli(path, anchor); expect(identityOnly.code).toBe(2);
      expect(JSON.parse(identityOnly.stdout)).toMatchObject({ trustAnchorVerified: true, truncationChecked: false });
      const mismatched = await cli(path, '--expect-final-state', 'SETTLED');
      expect(mismatched.code).toBe(1); expect(JSON.parse(mismatched.stdout).status).toBe('INVALID');
    }
  });
  it('exposes both MCP forms as normal schema-conforming results and preserves -32602 for bad argument shapes', async () => {
    const f = fixture(), server = new AcpMcpServer({ owner: f.worker });
    const listed = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as any;
    const tool = listed.result.tools.find((t: any) => t.name === 'acp_verify_audit_bundle');
    expect(validateOutput(tool.inputSchema, { bundle: f.bundle })).toBe(true);
    expect(validateOutput(tool.inputSchema, { bundle: { ...f.bundle, checkpoint: {} } })).toBe(false);
    for (const bundle of [f.bundle, f.ledger.bundle(f.requester, f.worker)]) {
      const response = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: tool.name, arguments: { bundle } } }) as any;
      expect(response.result.isError).not.toBe(true);
      const report = response.result.structuredContent;
      expect(report.status).toBe('interruption' in bundle ? 'UNILATERALLY_CLOSED' : 'VALID');
      expect(validateOutput(tool.outputSchema, report)).toBe(true);
    }
    const anchored = await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: tool.name,
      arguments: { bundle: f.bundle, anchor: { expectedClosureKind: 'interruption' } } } }) as any;
    expect(anchored.result.structuredContent).toMatchObject({ status: 'UNILATERALLY_CLOSED', trustAnchorVerified: true, truncationChecked: false });
    expect(validateOutput(tool.inputSchema, { bundle: f.bundle, anchor: { expectedClosureKind: 'interruption' } })).toBe(true);
    const error = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: tool.name, arguments: { bundle: [] } } }) as any;
    expect(error.error.code).toBe(-32602);
  });
});

describe('interruption-aware stores', () => {
  it.each(['memory', 'jsonl'] as const)('seals %s atomically, accepts only an identical retry, and excludes subsequent writes', kind => {
    const f = fixture(), path = join(directory(), 'audit.jsonl');
    const store = kind === 'memory' ? new MemoryStore() : new JsonlStore(path);
    store.append(f.entries[0]);
    let intents = 0;
    store.closeInterrupted(f.bundle, () => { intents++; });
    store.closeInterrupted(f.bundle);
    expect(intents).toBe(1);
    expect(() => store.append(f.entries[0])).toThrow('LEDGER_SEALED');
    expect(() => store.seal(f.ledger.bundle(f.requester, f.worker).checkpoint)).toThrow('LEDGER_SEALED');
    const other = { ...f.bundle, interruption: createAuditInterruption(f.entries, f.worker, 'OWNER_APPROVAL', 'WORKER_STOPPED') };
    expect(() => store.closeInterrupted(other)).toThrow('LEDGER_SEALED');
    if (kind === 'jsonl') expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
  });
  it.each(['memory', 'jsonl'] as const)('rejects asynchronous %s intent callbacks before writing a terminal', kind => {
    const f = fixture(), path = join(directory(), 'audit.jsonl');
    const store = kind === 'memory' ? new MemoryStore() : new JsonlStore(path); store.append(f.entries[0]);
    expect(() => store.closeInterrupted(f.bundle, async () => {})).toThrow('ASYNC_AUDIT_INTENT_FORBIDDEN');
    if (kind === 'jsonl') expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
    store.closeInterrupted(f.bundle);
  });
  it('holds the file lock across intent and rechecks bytes after the journal callback', () => {
    const f = fixture(), path = join(directory(), 'audit.jsonl'), store = new JsonlStore(path);
    store.append(f.entries[0]);
    store.closeInterrupted(f.bundle, () => {
      expect(() => new JsonlStore(path).append(f.entries[0])).toThrow('LEDGER_BUSY');
      expect(() => new JsonlStore(path).seal(f.ledger.bundle(f.requester, f.worker).checkpoint)).toThrow('LEDGER_BUSY');
      expect(() => new JsonlStore(path).closeInterrupted(f.bundle)).toThrow('LEDGER_BUSY');
    });
    const second = join(directory(), 'audit.jsonl'), s = new JsonlStore(second); s.append(f.entries[0]);
    expect(() => s.closeInterrupted(f.bundle, () => { writeFileSync(second, readFileSync(second, 'utf8') + '{}\n'); })).toThrow('AUDIT_PREFIX_MISMATCH');
    expect(readFileSync(second, 'utf8')).not.toContain('"interruption"');
  });
  it('preserves existing bilateral terminals, mismatching prefixes, and torn audit lines', () => {
    const f = fixture(), path = join(directory(), 'audit.jsonl'), store = new JsonlStore(path);
    store.append(f.entries[0]); store.seal(f.ledger.bundle(f.requester, f.worker).checkpoint);
    const original = readFileSync(path, 'utf8');
    let intent = false;
    expect(() => store.closeInterrupted(f.bundle, () => { intent = true; })).toThrow();
    expect(intent).toBe(false); expect(readFileSync(path, 'utf8')).toBe(original);
    for (const bad of [JSON.stringify({ entry: { ...f.entries[0], entryHash: 'sha256:' + '0'.repeat(64) } }) + '\n',
      JSON.stringify({ entry: f.entries[0] }) + '\n{"interruption":', JSON.stringify({ entry: f.entries[0] }) + '\n{}\n']) {
      writeFileSync(path, bad);
      expect(() => store.closeInterrupted(f.bundle)).toThrow(); expect(readFileSync(path, 'utf8')).toBe(bad);
    }
  });
});
