// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildContextGrant, contextGrantAuditPayload, createContract, digest, generateKeyPair,
  loadSchema, signEnvelope, signPayload, validateContextGrantUse, validateManifest, validateSchema, verifyContract,
} from '../packages/core/src/index.js';
import type { ContextGrant, DeliveryMode, Json, TaskManifest } from '../packages/core/src/index.js';
import { BilateralLedger, parseJsonl, verifyAudit } from '../packages/ledger/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import {
  appendContextGrantAuditEvent, buildTaskManifest, CONTEXT_GRANT_AUDIT_EVENTS,
  PolicyAutoApprovalProvider, RequesterClient, WorkerNode,
} from '../packages/runtime/src/index.js';
import * as sdk from '../cli/src/sdk.js';

const NOW = Date.parse('2030-01-01T00:00:00Z'), DAY = 86400000;
const requester = generateKeyPair(), worker = generateKeyPair();
const selection = { selectors: ['$.items[*]'], angle: 'Assess production feasibility.' };
function manifest(mode: DeliveryMode = 'view_only', now = NOW): TaskManifest {
  return buildTaskManifest({ ownerDid: requester.did, workerDid: worker.did, title: 'Context',
    description: 'Review selected dimensions', contextGrant: { ...selection, deliveryMode: mode }, now: () => now });
}
afterEach(() => vi.useRealTimers());

describe('ContextGrant contract', () => {
  it.each(['view_only', 'hand_over'] as const)('round-trips %s through schemas, signatures and SDK exports', mode => {
    const m = manifest(mode), copy = JSON.parse(JSON.stringify(m));
    validateManifest(copy); validateSchema('task-manifest', copy); validateSchema('context-grant', copy.contextGrant);
    expect(verifyContract(createContract(copy, signPayload(copy, requester), worker))).toBe(true);
    expect(sdk.buildTaskManifest).toBeTypeOf('function');
    const grant: sdk.ContextGrant = sdk.buildContextGrant(selection, m.createdAt);
    const deliveryMode: sdk.DeliveryMode = grant.deliveryMode;
    expect(deliveryMode).toBe('view_only');
    expect(sdk.contextGrantAuditPayload(grant)).toEqual({ grantDigest: digest(grant), deliveryMode });
    expect(sdk.appendContextGrantAuditEvent).toBeTypeOf('function');
    expect(sdk.validateManifest).toBeTypeOf('function');
    expect(sdk.validateContextGrantUse).toBeTypeOf('function');
    expect(sdk.CONTEXT_GRANT_MAX_BYTES).toBe(65536);
    expect(grant).toMatchObject({ inputRetentionAllowed: false, retention: 'ephemeral_view', maxBytes: 65536,
      expiresAt: new Date(NOW + DAY).toISOString() });
    expect(grant).not.toHaveProperty('maxDelegationDepth');
    const contract = createContract(m, signPayload(m, requester), worker);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW + 20 * DAY);
    expect(verifyContract(contract)).toBe(true);
    expect(() => validateContextGrantUse(m, {})).toThrow('CONTEXT_GRANT_EXPIRED');
  });

  for (const mode of ['view_only', 'hand_over'] as const)
    for (const depth of [0, 1, 5])
      for (const retention of ['ephemeral_view', 'keep_deliverable'] as const)
        for (const inputRetentionAllowed of [false, true])
          it(`${mode} depth=${depth} retention=${retention} inputRetention=${inputRetentionAllowed}`, () => {
            const m = manifest(mode);
            m.permissions.maxDelegationDepth = depth;
            Object.assign(m.contextGrant!, { retention, inputRetentionAllowed });
            const valid = depth === 0 && retention === (mode === 'view_only' ? 'ephemeral_view' : 'keep_deliverable') && !inputRetentionAllowed;
            if (valid) expect(() => validateManifest(m)).not.toThrow();
            else expect(() => validateManifest(m)).toThrow();
          });

  it('leaves optional absence and both older fixture versions unchanged', () => {
    const defaultManifest = buildTaskManifest({ ownerDid: requester.did, workerDid: worker.did, title: 'Old', description: 'Old' });
    expect(defaultManifest).not.toHaveProperty('contextGrant'); validateManifest(defaultManifest);
    expect(loadSchema('task-manifest.0.2.0').required).not.toContain('contextGrant');
    expect(loadSchema('task-manifest.0.1.0').properties).not.toHaveProperty('contextGrant');
    for (const path of ['sample-task-manifest.json', 'sample-task-manifest.0.1.0.json', 'sample-task-manifest.0.2.0.json']) {
      const fixture = JSON.parse(readFileSync('spec/examples/' + path, 'utf8'));
      expect(fixture).not.toHaveProperty('contextGrant'); validateManifest(fixture);
    }
    expect(() => validateManifest({ ...manifest(), protocolVersion: '0.1.0' })).toThrow('SCHEMA_VIOLATION');
    expect(() => buildTaskManifest({ ownerDid: requester.did, workerDid: worker.did, title: 'Old', description: 'Old',
      protocolVersion: '0.1.0', contextGrant: selection })).toThrow();
  });

  it('reserves the redelegation shape but refuses active creation, proposal and acceptance', () => {
    const m = manifest(); m.contextGrant!.deliveryMode = 'approval_redelegation';
    validateSchema('context-grant', m.contextGrant);
    expect(() => buildContextGrant({ ...selection, deliveryMode: 'approval_redelegation' })).toThrow('CONTEXT_GRANT_MODE_UNAVAILABLE');
    m.permissions.maxDelegationDepth = 1;
    validateSchema('task-manifest.0.2.0', m);
    expect(() => validateManifest(m)).toThrow('CONTEXT_GRANT_MODE_UNAVAILABLE');
    expect(() => createContract(m, signPayload(m, requester), worker)).toThrow('CONTEXT_GRANT_MODE_UNAVAILABLE');
  });

  it.each([
    { selectors: [] }, { selectors: [''] }, { selectors: ['  '] }, { selectors: ['x', 'x'] },
    { angle: '' }, { angle: '\t' }, { maxBytes: 65537 }, { maxBytes: 0 }, { maxBytes: 1.5 },
    { maxDelegationDepth: 0 }, { fieldsAllowed: ['customer'], fieldsDenied: ['customer'] },
    { expiresAt: 'invalid' }, { expiresAt: new Date(NOW).toISOString() },
    { expiresAt: new Date(NOW + 7 * DAY + 1).toISOString() },
  ])('rejects invalid declarations %j', patch => {
    const m = manifest(); Object.assign(m.contextGrant!, patch);
    expect(() => validateManifest(m)).toThrow();
  });

  it('requires selectors and angle, allows absent input retention, and checks filesystem declarations', () => {
    for (const field of ['selectors', 'angle', 'deliveryMode', 'expiresAt', 'maxBytes', 'retention']) {
      const m = manifest(); delete (m.contextGrant as unknown as Record<string, unknown>)[field];
      expect(() => validateManifest(m)).toThrow();
    }
    const m = manifest(); delete m.contextGrant!.inputRetentionAllowed; validateManifest(m);
    m.sandboxPolicy.filesystemScope = 'read_only_inputs';
    expect(() => validateManifest(m)).toThrow();
    const handed = manifest('hand_over'); handed.sandboxPolicy.filesystemScope = 'read_only_inputs';
    validateManifest(handed);
  });

  it('enforces seven days, the expiry instant and UTF-8 JSON byte boundaries', () => {
    const m = manifest(); m.contextGrant!.expiresAt = new Date(NOW + 7 * DAY).toISOString();
    validateManifest(m); validateContextGrantUse(m, {}, NOW + 7 * DAY - 1);
    expect(() => validateContextGrantUse(m, {}, NOW + 7 * DAY)).toThrow('CONTEXT_GRANT_EXPIRED');
    m.contextGrant!.maxBytes = Buffer.byteLength(JSON.stringify('あ'), 'utf8');
    validateContextGrantUse(m, 'あ', NOW);
    expect(() => validateContextGrantUse(m, 'あa', NOW)).toThrow('CONTEXT_GRANT_MAX_BYTES_EXCEEDED');
    m.contextGrant!.maxBytes = 65536;
    validateContextGrantUse(m, 'x'.repeat(65534), NOW);
    expect(() => validateContextGrantUse(m, 'x'.repeat(65535), NOW)).toThrow('CONTEXT_GRANT_MAX_BYTES_EXCEEDED');
  });
});

it('appends all lifecycle events with only digest and mode and rejects extra payload fields', async () => {
  const grant = manifest().contextGrant!, ledger = new BilateralLedger('task_context_audit', [requester.did, worker.did]);
  for (const event of CONTEXT_GRANT_AUDIT_EVENTS) {
    await appendContextGrantAuditEvent((type, payload) => { ledger.append(type, payload, worker, requester); }, event, grant);
    expect(() => ledger.append(event, { ...contextGrantAuditPayload(grant), angle: 'body' }, worker, requester)).toThrow('SCHEMA_VIOLATION');
    expect(() => ledger.append(event, { grantDigest: digest(grant), deliveryMode: 'approval_redelegation' }, worker, requester)).toThrow();
  }
  const bundle = ledger.bundle(worker, requester);
  expect(verifyAudit(bundle).valid).toBe(true);
  expect(bundle.entries).toHaveLength(5);
  for (const entry of bundle.entries) expect(entry.body.payload).toEqual(contextGrantAuditPayload(grant));
  expect(JSON.stringify(bundle)).not.toContain(grant.angle);
});

async function sessionFixture(mode: DeliveryMode = 'view_only', relay = new InMemoryRelay(), auditInterruptionFormat?: 1) {
  const owner = generateKeyPair(), clientOwner = generateKeyPair();
  const directory = mkdtempSync(join(tmpdir(), 'cp1-'));
  const approval = new PolicyAutoApprovalProvider(owner);
  const executeTask = vi.fn(async (ctx: { input: Json; workspaceDir: string }) => {
    expect(existsSync(ctx.workspaceDir)).toBe(true); return { ok: true };
  });
  const node = new WorkerNode({ owner, relay, now: () => Date.now(), checkPeer: () => 'trusted', timeoutMs: 4000,
    approvalProvider: approval, auditPath: join(directory, 'worker.jsonl'), auditInterruptionFormat,
    adapter: { id: 'cp1', name: 'CP1', skills: [], executeTask } });
  const client = new RequesterClient({ owner: clientOwner, relay, now: () => Date.now(), timeoutMs: 4000,
    approvalProvider: new PolicyAutoApprovalProvider(clientOwner) });
  const m = buildTaskManifest({ ownerDid: clientOwner.did, workerDid: owner.did,
    title: 'Context test', description: 'Context test', contextGrant: { ...selection, deliveryMode: mode } });
  const clean = () => { node.stop(); rmSync(directory, { recursive: true, force: true }); };
  return { owner, clientOwner, directory, node, client, m, executeTask, approval, clean };
}

it.each((['view_only', 'hand_over'] as const).flatMap(mode => [
  { mode, auditInterruptionFormat: undefined }, { mode, auditInterruptionFormat: 1 as const },
]))('settles $mode with interruption format $auditInterruptionFormat and compact bilateral lifecycle evidence', async ({ mode, auditInterruptionFormat }) => {
  const f = await sessionFixture(mode, new InMemoryRelay(), auditInterruptionFormat);
  try {
    const run = f.node.start({ once: true });
    const result = await f.client.delegate({ to: f.node.invite(), manifest: f.m, title: 'Context', description: 'Context', input: { confidential: 'input-only-value' } });
    await run;
    expect(result.state).toBe('SETTLED'); expect(f.executeTask).toHaveBeenCalledOnce();
    expect(existsSync(f.executeTask.mock.calls[0][0].workspaceDir)).toBe(false);
    const local = parseJsonl(readFileSync(join(f.directory, 'worker.jsonl'), 'utf8'));
    expect(local).toEqual(result.bundle); expect(verifyAudit(local).valid).toBe(true);
    expect(local.entries.filter(e => e.body.eventType.startsWith('CONTEXT_')).map(e => e.body.eventType))
      .toEqual(['CONTEXT_GRANT', 'CONTEXT_MODE', 'CONTEXT_OPENED', 'CONTEXT_DELETION_ATTEMPTED']);
    for (const e of local.entries.filter(e => e.body.eventType.startsWith('CONTEXT_')))
      expect(e.body.payload).toEqual(contextGrantAuditPayload(f.m.contextGrant!));
    const text = JSON.stringify(local);
    for (const body of [selection.angle, selection.selectors[0], 'input-only-value']) expect(text).not.toContain(body);
    expect(text).not.toContain('"contextGrant"');
  } finally { f.clean(); }
});

it.each(['view_only', 'hand_over'] as const)('preserves interrupted %s lifecycle evidence outside format-1 closure scope on stop and restart', async mode => {
  const f = await sessionFixture(mode, new InMemoryRelay(), 1), controller = new AbortController();
  let entered!: () => void;
  const reviewing = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(f.approval, 'approve').mockImplementation(async ({ signal }) => {
    entered();
    await new Promise<void>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    });
    throw new Error('UNREACHABLE');
  });
  const running = f.node.start();
  const attempt = f.client.delegate({ to: f.node.invite(), manifest: f.m,
    title: 'Context', description: 'Context', input: { confidential: 'input-only-value' }, signal: controller.signal }).catch(e => e);
  try {
    await reviewing;
    f.node.stop(); await running;
    const path = join(f.directory, 'worker.jsonl'), before = readFileSync(path, 'utf8');
    const entries = before.trim().split('\n').map(line => JSON.parse(line).entry);
    expect(entries.map(e => e.body.eventType)).toEqual(['PROPOSE', 'CONTEXT_GRANT', 'CONTEXT_MODE']);
    for (const body of [selection.angle, selection.selectors[0], 'input-only-value', 'interruption']) expect(before).not.toContain(body);
    expect(f.executeTask).not.toHaveBeenCalled();
    const records = readFileSync(path + '.tasks.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line).payload);
    expect(records.every(r => r.auditStage === undefined && r.auditClosure === undefined)).toBe(true);
    const restarted = new WorkerNode({ ...f.node.options });
    try { await restarted.start({ signal: AbortSignal.abort() }); } finally { restarted.stop(); }
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(existsSync(path + '.errors.jsonl')).toBe(false);
    expect(restarted.lastResult).toBeUndefined();
    expect(f.executeTask).not.toHaveBeenCalled();
  } finally {
    controller.abort(); f.node.stop(); await Promise.allSettled([running, attempt]); f.clean();
  }
});

it('rejects local contradictions before sending any proposal', async () => {
  const relay = new InMemoryRelay(), send = vi.spyOn(relay, 'send'), f = await sessionFixture('view_only', relay);
  try {
    const invite = f.node.invite(); send.mockClear(); f.m.permissions.maxDelegationDepth = 1;
    await expect(f.client.delegate({ to: invite, manifest: f.m, title: 'Bad', description: 'Bad', input: {} })).rejects.toThrow();
    expect(send.mock.calls.filter(([e]) => e.payload.eventType === 'PROPOSE')).toHaveLength(0);
    expect(f.executeTask).not.toHaveBeenCalled();
  } finally { f.clean(); }
});

it.each(['depth', 'expiry', 'bytes', 'redelegation'] as const)('rejects inbound %s before owner approval or execution', async kind => {
  const relay = new InMemoryRelay(), f = await sessionFixture('view_only', relay), approve = vi.spyOn(f.approval, 'approve');
  try {
    const input = { value: 'too large' };
    if (kind === 'depth') f.m.permissions.maxDelegationDepth = 1;
    if (kind === 'expiry') f.m.contextGrant!.expiresAt = new Date(Date.now() - 1).toISOString();
    if (kind === 'bytes') f.m.contextGrant!.maxBytes = 1;
    if (kind === 'redelegation') f.m.contextGrant!.deliveryMode = 'approval_redelegation';
    const run = f.node.start({ once: true });
    await relay.send(signEnvelope({ taskId: f.m.taskId, recipientDid: f.owner.did, seq: 0, eventType: 'PROPOSE',
      payload: JSON.parse(JSON.stringify({ proposal: signPayload(f.m, f.clientOwner), input, capabilityChains: [] })) as Json }, f.clientOwner, { encrypt: true }));
    await expect(run).rejects.toThrow();
    expect(approve).not.toHaveBeenCalled(); expect(f.executeTask).not.toHaveBeenCalled();
  } finally { f.clean(); }
});

it('records a discard after contract approval refusal without recording opened', async () => {
  const f = await sessionFixture();
  const approve = vi.spyOn(f.approval, 'approve').mockRejectedValue(new Error('APPROVAL_REJECTED'));
  try {
    const run = f.node.start({ once: true });
    const results = await Promise.allSettled([f.client.delegate({ to: f.node.invite(), manifest: f.m,
      title: 'Context', description: 'Context', input: {} }), run]);
    expect(results.every(r => r.status === 'rejected')).toBe(true);
    expect(approve).toHaveBeenCalledOnce(); expect(f.executeTask).not.toHaveBeenCalled();
    const events = readFileSync(join(f.directory, 'worker.jsonl'), 'utf8').trim().split('\n')
      .map(line => JSON.parse(line).entry.body.eventType);
    expect(events).toEqual(['PROPOSE', 'CONTEXT_GRANT', 'CONTEXT_MODE', 'CONTEXT_DISCARDED']);
  } finally { f.clean(); }
});

it('rechecks grant expiry after worker owner review', async () => {
  const f = await sessionFixture(), start = Date.now();
  f.m.contextGrant!.expiresAt = new Date(start + 1000).toISOString();
  const original = f.approval.approve.bind(f.approval);
  vi.spyOn(f.approval, 'approve').mockImplementation(async request => {
    const approval = await original(request);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start + 1001);
    return approval;
  });
  try {
    const run = f.node.start({ once: true });
    const results = await Promise.allSettled([f.client.delegate({ to: f.node.invite(), manifest: f.m,
      title: 'Context', description: 'Context', input: {} }), run]);
    expect(results.every(r => r.status === 'rejected' && String(r.reason).includes('CONTEXT_GRANT_EXPIRED'))).toBe(true);
    expect(f.executeTask).not.toHaveBeenCalled();
    expect(readFileSync(join(f.directory, 'worker.jsonl'), 'utf8')).not.toContain('CONTEXT_OPENED');
  } finally { f.clean(); }
});

it('binds opt-in grants to idempotent requests and rejects a changed selection', async () => {
  const f = await sessionFixture();
  try {
    const run = f.node.start({ once: true });
    const options = { to: f.node.invite(), idempotencyKey: 'context-grant-cp1', title: 'Context', description: 'Context',
      input: {}, contextGrant: selection };
    const result = await f.client.delegate(options); await run;
    const replay = await f.client.delegate(options);
    expect(replay.bundle).toEqual(result.bundle); expect(f.executeTask).toHaveBeenCalledOnce();
    await expect(f.client.delegate({ ...options, contextGrant: { ...selection, angle: 'A different angle' } }))
      .rejects.toThrow('IDEMPOTENCY_CONFLICT');
  } finally { f.clean(); }
});

it('recovers the same signed task from compact proposal and acceptance audit evidence', async () => {
  const f = await sessionFixture();
  try {
    const options = { to: f.node.invite(), manifest: f.m, title: 'Context', description: 'Context', input: {} };
    const run = f.node.start({ once: true });
    const result = await f.client.delegate(options); await run;
    const retry = f.node.start({ once: true });
    const recovered = await f.client.delegate(options); await retry;
    expect(recovered).toMatchObject({ taskId: result.taskId, state: result.state, deliverable: result.deliverable, bundle: result.bundle });
    expect(f.executeTask).toHaveBeenCalledOnce();
  } finally { f.clean(); }
});

it('uses compact acceptance evidence for existing multi-delegation worker identity checks', async () => {
  const f = await sessionFixture('hand_over');
  try {
    const run = f.node.start({ once: true });
    const result = await f.client.delegateMulti({ workers: [{ workerDid: f.owner.did, inviteToken: f.node.invite() }],
      mode: 'race', title: 'Context', description: 'Context', input: {}, contextGrant: { ...selection, deliveryMode: 'hand_over' } });
    await run;
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0].workerDid).toBe(f.owner.did);
    const grantEvent = result.receipts[0].bundle.entries.find(e => e.body.eventType === 'CONTEXT_GRANT');
    expect(grantEvent?.body.payload).toMatchObject({ deliveryMode: 'hand_over' });
  } finally { f.clean(); }
});

it('refuses the persistent plaintext inbox path before input is written', async () => {
  const f = await sessionFixture();
  const inboxPath = join(f.directory, 'inbox.jsonl');
  f.node.options.inboxPath = inboxPath;
  try {
    const run = f.node.start({ once: true });
    const results = await Promise.allSettled([f.client.delegate({ to: f.node.invite(), manifest: f.m,
      title: 'Context', description: 'Context', input: {} }), run]);
    expect(results.every(r => r.status === 'rejected' && String(r.reason).includes('CONTEXT_GRANT_INPUT_RETENTION_CONFLICT'))).toBe(true);
    expect(existsSync(inboxPath)).toBe(false); expect(f.executeTask).not.toHaveBeenCalled();
  } finally { f.clean(); }
});
