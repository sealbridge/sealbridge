// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, unlinkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { digest, generateKeyPair, signPayload, signAck, signEnvelope } from '../packages/core/src/index.js';
import type { Json, Signed } from '../packages/core/src/index.js';
import { BilateralLedger, createAuditInterruption, JsonlStore, parseAuditJsonl, parseJsonl, verifyAudit, verifyAuditEvidence } from '../packages/ledger/src/index.js';
import type { AuditInterruption, InterruptedAuditBundle } from '../packages/ledger/src/index.js';
import { buildTaskManifest, HeldRequestReview, InteractiveCliApprovalProvider, PolicyAutoApprovalProvider, RequesterClient, WorkerNode } from '../packages/runtime/src/index.js';
import { JsonlStore as RuntimeJsonlStore } from '../packages/ledger/dist/index.js';
import { TaskJournal } from '../packages/runtime/src/task-journal.js';
import type { TaskCheckpoint } from '../packages/runtime/src/task-journal.js';
import { SessionWire } from '../packages/runtime/src/session-audit.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { cliTaskInspection } from '../cli/src/task-review.js';
import { tasksCommand } from '../cli/src/tasks.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function directory() { const dir = mkdtempSync(join(tmpdir(), 'worker-audit-interruption-')); dirs.push(dir); return dir; }
function event() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { resolve, promise }; }
function journalRecords(path: string): TaskCheckpoint[] {
  return readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line).payload);
}
function liveFixture() {
  const dir = directory(), path = join(dir, 'worker.jsonl'), inbox = join(dir, 'inbox.jsonl');
  const owner = generateKeyPair(), requester = generateKeyPair(), relay = new InMemoryRelay();
  const input = new PassThrough(); let prompt = event(), rejected = event(), executions = 0;
  const human = new InteractiveCliApprovalProvider(owner, { input, output: new Writable({ write(chunk, _enc, cb) {
    if (String(chunk).includes('Approve [y/N]?')) prompt.resolve(); cb();
  } }) });
  const identityOptions = { env: { SEALBRIDGE_DATA_DIR: join(dir, 'identity') } };
  const review = new HeldRequestReview(owner, { ...identityOptions, provider: cliTaskInspection(() => {}) });
  const worker = new WorkerNode({ owner, relay, relayUrl: 'https://relay.example', auditPath: path, inboxPath: inbox,
    auditInterruptionFormat: 1, timeoutMs: 1200, identityOptions, heldReview: review,
    approvalProvider: new PolicyAutoApprovalProvider(owner), ownerApprovalProvider: human,
    onEvent: (name, _id, error) => { if (name === 'REJECTED' && error?.code !== 'AUDIT_INTERRUPTION_WRITE_FAILED') rejected.resolve(); },
    adapter: { id: 'echo', name: 'echo', skills: [], executeTask: async ctx => { executions++; return ctx.input; } } });
  const client = new RequesterClient({ owner: requester, relay, timeoutMs: 5000, approvalProvider: new PolicyAutoApprovalProvider(requester) });
  return { dir, path, inbox, journalPath: inbox + '.tasks.jsonl', owner, requester, relay, input, review, identityOptions, worker, client,
    prompt: () => prompt.promise, rejected: () => rejected.promise, executions: () => executions,
    reset: () => { prompt = event(); rejected = event(); } };
}

describe('worker AuditInterruption live scope (#194)', () => {
  it.each(['OWNER_APPROVAL', 'ACCEPT_ACK_WAIT'] as const)('closes %s after requester exit, preserves held review, and settles the fresh task separately', async phase => {
    const f = liveFixture(), controller = new AbortController(), running = f.worker.start();
    const invite = f.worker.invite();
    const task = { to: invite, title: 'Interrupted PROPOSE', description: 'Requester exits at live owner prompt', input: {} };
    const attempt = f.client.delegate({ ...task, signal: controller.signal }).then(() => 'unexpected', e => String(e));
    try {
      await f.prompt(); const before = readFileSync(f.path, 'utf8');
      const proposal = JSON.parse(before.trim()).entry;
      controller.abort(new Error('REQUESTER_EXITED_TEST')); expect(await attempt).toContain('REQUESTER_EXITED_TEST');
      if (phase === 'ACCEPT_ACK_WAIT') f.input.write('y\n');
      await f.rejected();
      const text = readFileSync(f.path, 'utf8'), bundle = parseAuditJsonl(text) as InterruptedAuditBundle;
      expect(bundle.entries).toEqual([proposal]); expect(text.startsWith(before)).toBe(true);
      expect(bundle.interruption.payload).toMatchObject({ phase, reason: 'SESSION_TIMEOUT', taskId: proposal.body.taskId });
      expect(verifyAuditEvidence(bundle).status).toBe('UNILATERALLY_CLOSED');
      expect(f.executions()).toBe(0); expect(f.worker.lastResult).toBeUndefined();
      const records = journalRecords(f.journalPath).filter(r => r.taskId === proposal.body.taskId);
      const intent = records.find(r => r.auditClosure?.state === 'pending')!;
      expect(intent.auditClosure!.interruption).toEqual(bundle.interruption);
      expect(records.at(-1)).toMatchObject({ phase: 'terminal', outcome: { code: 'TASK_INTERRUPTED' }, auditClosure: { state: 'written' } });
      expect(records.at(-1)?.outcome?.result).toBeUndefined();
      expect(f.review.list()).toHaveLength(1);
      const key = join(f.dir, 'worker.private.json'); writeFileSync(key, JSON.stringify(f.owner), { mode: 0o600 });
      const output: string[] = [];
      await tasksCommand(['approve', f.review.list()[0].id, '--key', key], { identityOptions: f.identityOptions, review: async () => true, output: s => output.push(s) });
      expect(JSON.parse(output.at(-1)!).executed).toBe(false);
      expect(readFileSync(f.path, 'utf8')).toBe(text);
      f.reset();
      const requesterPath = join(f.dir, 'requester-settled.jsonl');
      const fresh = f.client.delegate({ ...task, auditPath: requesterPath });
      await f.prompt(); f.input.write('y\n');
      const settled = await fresh;
      expect(settled.state).toBe('SETTLED'); expect(f.executions()).toBe(1);
      const later = f.path.replace(/(?:\.jsonl)?$/, '.' + settled.taskId + '.jsonl');
      expect(verifyAudit(parseJsonl(readFileSync(later, 'utf8'))).valid).toBe(true);
      expect(verifyAudit(parseJsonl(readFileSync(requesterPath, 'utf8'))).valid).toBe(true);
      expect(readFileSync(f.path, 'utf8')).toBe(text);
    } finally { controller.abort(); f.input.end(); f.worker.stop(); await Promise.allSettled([running, attempt]); f.input.destroy(); }
  });
  it('records controlled worker stop before the early idle-signal throw', async () => {
    const f = liveFixture(), controller = new AbortController(), running = f.worker.start();
    const attempt = f.client.delegate({ to: f.worker.invite(), title: 'Stop', description: 'Stop during owner prompt', input: {}, signal: controller.signal }).catch(e => e);
    try {
      await f.prompt(); f.worker.stop(); f.input.write('y\n'); await running;
      const bundle = parseAuditJsonl(readFileSync(f.path, 'utf8')) as InterruptedAuditBundle;
      expect(bundle.interruption.payload).toMatchObject({ phase: 'OWNER_APPROVAL', reason: 'WORKER_STOPPED' });
      expect(journalRecords(f.journalPath).at(-1)).toMatchObject({ phase: 'terminal', outcome: { code: 'TASK_INTERRUPTED' }, auditClosure: { state: 'written' } });
      expect(f.executions()).toBe(0); expect(f.review.list()).toHaveLength(1);
    } finally { controller.abort(); f.input.end(); f.worker.stop(); await Promise.allSettled([running, attempt]); f.input.destroy(); }
  });
  it('does not create an interruption for ordinary owner refusal', async () => {
    const f = liveFixture(), running = f.worker.start(), controller = new AbortController();
    const attempt = f.client.delegate({ to: f.worker.invite(), title: 'Refusal', description: 'Owner refuses', input: {}, signal: controller.signal }).catch(e => e);
    try {
      await f.prompt(); f.input.write('n\n'); await f.rejected();
      expect(readFileSync(f.path, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(journalRecords(f.journalPath).at(-1)).toMatchObject({ auditStage: 'OUT_OF_SCOPE', phase: 'terminal' });
    } finally { controller.abort(); f.input.end(); f.worker.stop(); await Promise.allSettled([running, attempt]); f.input.destroy(); }
  });
  it.each(['before-append', 'after-append'] as const)('retains a pending intent on %s failure and recovers the same signed record', async boundary => {
    const f = liveFixture(), running = f.worker.start(), controller = new AbortController();
    const originalClose = RuntimeJsonlStore.prototype.closeInterrupted;
    const close = vi.spyOn(RuntimeJsonlStore.prototype, 'closeInterrupted').mockImplementation(function (this: RuntimeJsonlStore, bundle, intent) {
      if (boundary === 'after-append') originalClose.call(this, bundle, intent); else intent?.();
      throw new Error('DISK_FAILURE');
    });
    const attempt = f.client.delegate({ to: f.worker.invite(), title: 'Write failure', description: 'Retain original interruption', input: {}, signal: controller.signal }).catch(e => e);
    let intended!: Signed<AuditInterruption>;
    try {
      await f.prompt(); controller.abort(); await f.rejected();
      const last = journalRecords(f.journalPath).at(-1)!;
      expect(last).toMatchObject({ phase: 'terminal', outcome: { code: 'TASK_INTERRUPTED' }, auditClosure: { state: 'pending' } });
      intended = last.auditClosure!.interruption;
      expect(readFileSync(f.path, 'utf8').trim().split('\n')).toHaveLength(boundary === 'before-append' ? 1 : 2);
      expect(readFileSync(f.path + '.errors.jsonl', 'utf8')).toContain('AUDIT_INTERRUPTION_WRITE_FAILED');
    } finally { close.mockRestore(); controller.abort(); f.input.end(); f.worker.stop(); await Promise.allSettled([running, attempt]); f.input.destroy(); }
    const node = new WorkerNode({ ...f.worker.options });
    try {
      await node.start({ signal: AbortSignal.abort() });
      expect((parseAuditJsonl(readFileSync(f.path, 'utf8')) as InterruptedAuditBundle).interruption).toEqual(intended);
      expect(journalRecords(f.journalPath).at(-1)?.auditClosure?.state).toBe('written');
    } finally { node.stop(); }
  });
});

function restartFixture() {
  const dir = directory(), path = join(dir, 'worker.jsonl'), owner = generateKeyPair(), requester = generateKeyPair();
  const relay = new InMemoryRelay(); let executions = 0;
  const manifest = buildTaskManifest({ ownerDid: requester.did, workerDid: owner.did, title: 'Restart', description: 'Preserve interrupted prefix' });
  const proposal = { proposal: signPayload(manifest, requester), input: {}, capabilityChains: [] };
  const ledger = new BilateralLedger(manifest.taskId, [requester.did, owner.did], new JsonlStore(path));
  ledger.append('PROPOSE', proposal as unknown as Json, requester, owner);
  const entries = ledger.store.read();
  const record: TaskCheckpoint = { version: 1, taskId: manifest.taskId, requesterDid: requester.did,
    envelopeId: 'env_interruption', proposalDigest: digest({ manifest, input: {} }), phase: 'received', auditPath: path,
    auditStage: 'OWNER_APPROVAL', invocations: [] };
  const interruption = createAuditInterruption(entries, owner, 'OWNER_APPROVAL', 'SESSION_TIMEOUT', '2026-01-01T00:00:00.000Z');
  const journal = new TaskJournal(path + '.tasks.jsonl', owner);
  function save(patch: Partial<TaskCheckpoint> = {}) { journal.save({ ...record, ...patch }); }
  function worker(optIn = true) { return new WorkerNode({ owner, relay, auditPath: path,
    ...(optIn ? { auditInterruptionFormat: 1 } : {}), checkPeer: () => 'trusted',
    approvalProvider: new PolicyAutoApprovalProvider(owner), adapter: { id: 'echo', name: 'echo', skills: [], executeTask: async () => { executions++; return {}; } } }); }
  async function restart(optIn = true) { const node = worker(optIn); try { await node.start({ signal: AbortSignal.abort() }); expect(node.lastResult).toBeUndefined(); } finally { node.stop(); } }
  return { path, owner, requester, relay, ledger, entries, record, interruption, journal, save, restart, executions: () => executions };
}

describe('worker interruption restart journal', () => {
  it.each(['OWNER_APPROVAL', 'ACCEPT_ACK_WAIT'] as const)('auto-closes a persisted new-format %s stage, even when writer opt-in is absent on restart', async phase => {
    const f = restartFixture(); f.save({ auditStage: phase });
    const before = Date.now(); await f.restart(false);
    const b = parseAuditJsonl(readFileSync(f.path, 'utf8')) as InterruptedAuditBundle;
    expect(b.interruption.payload).toMatchObject({ phase, reason: 'WORKER_RESTART_OBSERVED' });
    expect(Date.parse(b.interruption.payload.observedAt)).toBeGreaterThanOrEqual(before);
    expect(f.executions()).toBe(0);
    expect(journalRecords(f.journal.path).at(-1)).toMatchObject({ outcome: { code: 'TASK_INTERRUPTED' }, auditClosure: { state: 'written' } });
    const original = readFileSync(f.path, 'utf8'); await f.restart(); expect(readFileSync(f.path, 'utf8')).toBe(original);
  });
  it.each([false, true])('reuses a pending intent with already-written terminal=%s instead of re-signing', async written => {
    const f = restartFixture(); f.save({ auditClosure: { state: 'pending', interruption: f.interruption } });
    if (written) new JsonlStore(f.path).closeInterrupted({ entries: f.entries, interruption: f.interruption });
    await f.restart();
    expect((parseAuditJsonl(readFileSync(f.path, 'utf8')) as InterruptedAuditBundle).interruption).toEqual(f.interruption);
    expect(journalRecords(f.journal.path).at(-1)?.auditClosure?.state).toBe('written');
  });
  it.each(['legacy', 'out-of-scope', 'terminal-legacy', 'terminal-refusal'] as const)('does not backfill %s files', async kind => {
    const f = restartFixture();
    f.save({ auditStage: kind === 'out-of-scope' ? 'OUT_OF_SCOPE' : kind === 'terminal-refusal' ? 'OWNER_APPROVAL' : undefined,
      ...(kind.startsWith('terminal') ? { phase: 'terminal', outcome: { code: kind === 'terminal-refusal' ? 'APPROVAL_REJECTED' : 'TASK_INTERRUPTED' } } : {}) });
    const before = readFileSync(f.path, 'utf8'); await f.restart(); expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(journalRecords(f.journal.path).at(-1)?.auditClosure).toBeUndefined();
  });
  it('closes a new-format audit stage left unfinished by a failure before intent persistence', async () => {
    const f = restartFixture();
    f.save({ phase: 'terminal', outcome: { code: 'TASK_INTERRUPTED' } });
    await f.restart();
    const b = parseAuditJsonl(readFileSync(f.path, 'utf8')) as InterruptedAuditBundle;
    expect(b.interruption.payload.reason).toBe('WORKER_RESTART_OBSERVED');
    expect(journalRecords(f.journal.path).at(-1)).toMatchObject({ outcome: { code: 'TASK_INTERRUPTED' }, auditClosure: { state: 'written' } });
    expect(f.executions()).toBe(0);
  });
  it.each(['checkpoint', 'different-terminal', 'longer-prefix', 'torn-line', 'wrong-proposal'] as const)('preserves %s instead of overwriting it', async kind => {
    const f = restartFixture();
    f.save(kind === 'different-terminal' ? { auditClosure: { state: 'pending', interruption: f.interruption } } :
      kind === 'wrong-proposal' ? { proposalDigest: digest({ wrong: true }) } : {});
    if (kind === 'checkpoint') f.ledger.bundle(f.requester, f.owner);
    if (kind === 'different-terminal') new JsonlStore(f.path).closeInterrupted({ entries: f.entries,
      interruption: createAuditInterruption(f.entries, f.owner, 'OWNER_APPROVAL', 'WORKER_STOPPED') });
    if (kind === 'longer-prefix') f.ledger.append('ACCEPT', {}, f.owner, f.requester);
    if (kind === 'torn-line') writeFileSync(f.path, readFileSync(f.path, 'utf8') + '{"interruption":');
    const before = readFileSync(f.path, 'utf8'); await f.restart(); expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(f.executions()).toBe(0); expect(journalRecords(f.journal.path).at(-1)?.auditClosure?.state).not.toBe('written');
    expect(readFileSync(f.path + '.errors.jsonl', 'utf8')).toContain('AUDIT_INTERRUPTION_WRITE_FAILED');
  });
  it.skipIf(process.platform === 'win32').each(['before-intent', 'after-intent', 'after-append', 'after-written'])('recovers after real process death at %s without changing the signed intent', async boundary => {
    const f = restartFixture(); f.save();
    const path = join(directory(), 'fixture.json');
    writeFileSync(path, JSON.stringify({ owner: f.owner, record: f.record, entries: f.entries, interruption: f.interruption }), { mode: 0o600 });
    const signal = await new Promise<string | null>((resolve, reject) => {
      const child = spawn(process.execPath, ['conformance/fixtures/audit-interruption-crash.mjs', path, boundary], { stdio: 'ignore' });
      child.on('error', reject); child.on('close', (_code, signal) => resolve(signal));
    });
    expect(signal).toBe('SIGKILL');
    if (existsSync(f.path + '.lock')) {
      // Disposable test lock: the child is known dead. Production recovery requires this same exclusive-owner check.
      const before = readFileSync(f.path, 'utf8'); await f.restart();
      expect(readFileSync(f.path, 'utf8')).toBe(before);
      expect(readFileSync(f.path + '.errors.jsonl', 'utf8')).toContain('AUDIT_INTERRUPTION_WRITE_FAILED');
      unlinkSync(f.path + '.lock');
    }
    await f.restart();
    const bundle = parseAuditJsonl(readFileSync(f.path, 'utf8')) as InterruptedAuditBundle;
    if (boundary === 'before-intent') expect(bundle.interruption.payload.reason).toBe('WORKER_RESTART_OBSERVED');
    else expect(bundle.interruption).toEqual(f.interruption);
    expect(verifyAuditEvidence(bundle).status).toBe('UNILATERALLY_CLOSED'); expect(f.executions()).toBe(0);
  });
  it('validates stage and closure metadata while decoding the signed journal', () => {
    const f = restartFixture();
    for (const patch of [{ auditStage: 'RUNNING' }, { auditClosure: { state: 'unknown', interruption: f.interruption } },
      { auditClosure: { state: 'pending', interruption: { ...f.interruption, payload: { ...f.interruption.payload, taskId: 'task_other' } } } },
      { auditStage: undefined, auditClosure: { state: 'pending', interruption: f.interruption } }]) {
      writeFileSync(f.journal.path, JSON.stringify(signPayload(JSON.parse(JSON.stringify({ ...f.record, ...patch })), f.owner)) + '\n');
      expect(() => new TaskJournal(f.journal.path, f.owner).load()).toThrow('INVALID_TASK_JOURNAL');
    }
  });
});

it('freezes an already-resolved ACK continuation before choosing the interruption prefix', async () => {
  const f = restartFixture(), signal = new AbortController(), wire = new SessionWire(f.relay, f.owner, f.requester.did,
    f.record.taskId, [f.requester.did, f.owner.did], signal.signal, f.path, false, true);
  wire.entries.push(...f.entries);
  const body = { taskId: f.record.taskId, seq: 1, prevEntryHash: f.entries[0].entryHash,
    actorDid: f.owner.did, receiverDid: f.requester.did, eventType: 'ACCEPT', payload: {} };
  const ack = signAck({ type: 'AckReceipt', taskId: f.record.taskId, entryHash: digest(body),
    actorDid: f.owner.did, receiverDid: f.requester.did }, f.requester);
  const frame = signEnvelope({ taskId: f.record.taskId, recipientDid: f.owner.did, seq: 0, eventType: 'AUDIT_ACK',
    payload: ack as unknown as Json }, f.requester);
  let quiescing!: ReturnType<SessionWire['quiesceAudit']>;
  vi.spyOn(wire, 'rawReceive').mockImplementationOnce(async () => {
    // The ACK is ready, but closure wins before transmit's continuation can persist ACCEPT.
    quiescing = wire.quiesceAudit(); return frame;
  });
  const sending = wire.sendEvent('ACCEPT', {});
  await expect(sending).rejects.toThrow('SESSION_CLOSED');
  const prefix = await quiescing;
  expect(prefix).toEqual(f.entries);
  await expect(wire.sendEvent('LATE', {})).rejects.toThrow('SESSION_CLOSED');
  await expect(wire.finishWorker()).rejects.toThrow('SESSION_CLOSED');
  await expect(wire.receiveEvent('PROPOSE')).rejects.toThrow('SESSION_CLOSED');
  new JsonlStore(f.path).closeInterrupted({ entries: prefix, interruption: f.interruption });
  expect(verifyAuditEvidence(parseAuditJsonl(readFileSync(f.path, 'utf8'))).status).toBe('UNILATERALLY_CLOSED');
});
