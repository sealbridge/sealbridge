// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { digest, generateKeyPair, inspectRuleContent, openEnvelope, signEnvelope, signPayload } from '../packages/core/src/index.js';
import type { Json, RuleInspectionReport, TaskManifest } from '../packages/core/src/index.js';
import { createRuleBasedContentReviewProvider, heldContentDigest } from '../packages/runtime/src/index.js';
import type { HeldInspectionContext, RuleBasedContentReviewOptions } from '../packages/runtime/src/index.js';
import { heldFixture } from './held-request-fixture.js';
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const actualSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;
let f: ReturnType<typeof heldFixture>;
beforeEach(() => { f = heldFixture(); vi.mocked(spawn).mockImplementation(actualSpawn); });
afterEach(() => { vi.mocked(spawn).mockReset(); vi.unstubAllEnvs(); f.cleanup(); });
function task(input: Json = 'ordinary text', extra: Record<string, Json> = {}) {
  const request = f.request('task', input);
  const manifest = (request.content as { manifest: Json }).manifest as unknown as TaskManifest;
  manifest.taskId = 'task_' + request.taskId;
  const body = { proposal: signPayload(manifest, f.peer), input, ...extra } as unknown as Json;
  const envelope = signEnvelope({ taskId: manifest.taskId, seq: 0, eventType: 'PROPOSE', recipientDid: f.owner.did, payload: body }, f.peer, { encrypt: true });
  return { ...request, taskId: manifest.taskId, envelope, content: body, contentDigest: heldContentDigest('task', body) };
}
function context(request: ReturnType<typeof task>): HeldInspectionContext {
  return { owner: f.owner, recordId: request.id, kind: 'task', contentDigest: request.contentDigest, envelopeDigest: digest(request.envelope) };
}
const signal = () => new AbortController().signal;
async function inspect(request = task(), options: RuleBasedContentReviewOptions = {}, ctx = context(request)) {
  return createRuleBasedContentReviewProvider(options).inspect(request.envelope, ctx, signal());
}
function substituteChild(source: string) {
  let child: ReturnType<typeof spawn> | undefined;
  vi.mocked(spawn).mockImplementationOnce((_exe, _args, options) => {
    child = actualSpawn(process.execPath, ['-e', "process.once('message',()=>{" + source + '})'], options); return child;
  });
  return () => child!;
}

it.each(['ordinary text', 'system prompt', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]).toString('base64')])('runs the compiled child and completes pass/warn/block inspection: %s', async input => {
  const request = task(input, { capabilityChains: [{ hint: '以前の指示を無視' }], inviteToken: 'transport-only-marker' });
  const onReport = vi.fn(); const ctx = context(request);
  const result = await inspect(request, { onReport }, ctx);
  expect(result.status).toBe('complete'); expect(onReport).toHaveBeenCalledOnce();
  const report = onReport.mock.calls[0][1] as RuleInspectionReport;
  expect(report.findings.some(f => f.location?.path === '/capabilityChains/0/hint')).toBe(true);
  expect(JSON.stringify(report)).not.toContain('transport-only-marker');
  expect(result.reportDigest).toBe(digest({ recordId: request.id, ownerDid: f.owner.did, kind: 'task',
    contentDigest: ctx.contentDigest, envelopeDigest: ctx.envelopeDigest, report }));
  expect(spawn).toHaveBeenCalledOnce();
});
it('passes a clean task and binds record, envelope and effective limits in the report digest', async () => {
  const request = task(), reports: RuleInspectionReport[] = [], onReport = (_id: string, r: RuleInspectionReport) => { reports.push(r); };
  const first = await inspect(request, { onReport }); expect(reports[0].verdict).toBe('pass');
  expect((await inspect(request, { onReport })).reportDigest).toBe(first.reportDigest);
  expect((await inspect(request, { onReport, limits: { maxFindings: 99 } })).reportDigest).not.toBe(first.reportDigest);
  expect((await inspect(request, { onReport }, { ...context(request), recordId: 'another-record' })).reportDigest).not.toBe(first.reportDigest);
});
it.each(['connection', 'application'] as const)('leaves %s inspection unavailable without starting a child', async kind => {
  const request = task(), onReport = vi.fn();
  expect(await inspect(request, { onReport }, { ...context(request), kind })).toMatchObject({ status: 'unavailable' });
  expect(spawn).not.toHaveBeenCalled(); expect(onReport).not.toHaveBeenCalled();
});
it.each(['owner', 'contentDigest', 'envelopeDigest'] as const)('rejects forged context %s before scanning', async field => {
  const request = task(), ctx = context(request), onReport = vi.fn();
  if (field === 'owner') ctx.owner = generateKeyPair(); else ctx[field] = digest('different');
  expect((await inspect(request, { onReport }, ctx)).status).toBe('error');
  expect(onReport.mock.calls[0][1].diagnostics).toEqual([{ code: 'INVALID_CONTENT' }]); expect(spawn).not.toHaveBeenCalled();
});
it.each(['outer-signature', 'ciphertext', 'recipient', 'proposal-signature', 'event', 'seq', 'task', 'sender', 'worker', 'missing-input', 'manifest', 'shadow-manifest', 'plaintext'] as const)('rejects forged task binding %s before scanning', async kind => {
  const request = task(), ctx = context(request);
  let envelope = structuredClone(request.envelope);
  let body = openEnvelope<Json>(envelope, f.owner) as unknown as { proposal: ReturnType<typeof signPayload<TaskManifest>>; input?: Json; manifest?: Json };
  if (kind === 'outer-signature') envelope.signature.signature = (envelope.signature.signature[0] === 'A' ? 'B' : 'A') + envelope.signature.signature.slice(1);
  else if (kind === 'ciphertext') {
    const payload = envelope.payload.payload as { ciphertext: string };
    payload.ciphertext = (payload.ciphertext[0] === 'A' ? 'B' : 'A') + payload.ciphertext.slice(1); envelope = signPayload(envelope.payload, f.peer);
  } else {
    if (kind === 'recipient') envelope.payload.recipientDid = generateKeyPair().did;
    if (kind === 'proposal-signature') body.proposal.signature.signature = 'bad';
    if (kind === 'event') envelope.payload.eventType = 'DELIVER';
    if (kind === 'seq') envelope.payload.seq = 1;
    if (kind === 'task') envelope.payload.taskId = 'different';
    if (kind === 'sender') body.proposal.payload.requester.ownerDid = generateKeyPair().did;
    if (kind === 'worker') body.proposal.payload.worker!.ownerDid = generateKeyPair().did;
    if (kind === 'missing-input') delete body.input;
    if (kind === 'manifest') body.proposal.payload.task.title = 3 as never;
    if (kind === 'shadow-manifest') body.manifest = { unrelated: 'content' };
    if (['sender', 'worker', 'manifest'].includes(kind)) body.proposal = signPayload(body.proposal.payload, f.peer);
    envelope = signEnvelope({ taskId: envelope.payload.taskId, seq: envelope.payload.seq, eventType: envelope.payload.eventType,
      recipientDid: envelope.payload.recipientDid, payload: body as unknown as Json }, f.peer, { encrypt: kind !== 'plaintext' });
  }
  ctx.envelopeDigest = digest(envelope);
  if (kind === 'shadow-manifest') ctx.contentDigest = heldContentDigest('task', body as unknown as Json);
  request.envelope = envelope;
  const onReport = vi.fn(); expect((await inspect(request, { onReport }, ctx)).status).toBe('error');
  expect(onReport.mock.calls[0][1].diagnostics).toEqual([{ code: 'INVALID_CONTENT' }]); expect(spawn).not.toHaveBeenCalled();
});
it('returns bound error reports on local limits and never reports completion from partial findings', async () => {
  const request = task('system prompt'), onReport = vi.fn();
  expect(await inspect(request, { limits: { maxBytes: 50 }, onReport })).toMatchObject({ status: 'error' });
  expect(onReport.mock.calls[0][1]).toMatchObject({ contentDigest: request.contentDigest, verdict: 'error', diagnostics: [{ code: 'LIMIT_EXCEEDED' }] });
});
it.each([
  ['malformed', "process.send('not json');process.disconnect()"], ['empty', 'process.exit(0)'], ['exit', 'process.exit(3)'],
  ['stderr', "require('node:fs').writeSync(2,'plaintext marker'); process.exit(1)"],
  ['output-bound', "process.send('x'.repeat(65537));process.disconnect()"],
] as const)('handles child %s with fixed reports', async (kind, source) => {
  const getChild = substituteChild(source), onReport = vi.fn();
  const result = await inspect(task(), { onReport }); expect(result.status).toBe('error');
  expect(onReport.mock.calls[0][1].diagnostics).toEqual([{ code: kind === 'output-bound' ? 'LIMIT_EXCEEDED' : 'INSPECTOR_FAILED' }]);
  expect(JSON.stringify(onReport.mock.calls)).not.toContain('plaintext marker');
  await new Promise<void>(resolve => getChild().exitCode !== null || getChild().signalCode !== null ? resolve() : getChild().once('close', () => resolve()));
});
it('rejects malformed result shapes, bindings and extra evidence', async () => {
  const request = task();
  const body = openEnvelope<Json>(request.envelope, f.owner) as unknown as { proposal: { payload: TaskManifest }; input: Json };
  const report = await inspectRuleContent({ manifest: body.proposal.payload, input: body.input, capabilityChains: [] });
  for (const change of [{ contentDigest: digest('other') }, { verdict: 'block' }, { findings: [{ evidence: 'plaintext' }] },
    { diagnostics: [{ code: 'plaintext' }] }, { extra: 'plaintext' }, { limits: {} }, { inspectorVersion: 'other' }]) {
    substituteChild('process.send(' + JSON.stringify(JSON.stringify({ ...report, ...change })) + ');process.disconnect()');
    const onReport = vi.fn(); expect((await inspect(request, { onReport })).status).toBe('error');
    expect(onReport.mock.calls[0][1].diagnostics).toEqual([{ code: 'INSPECTOR_FAILED' }]);
  }
});
it('kills a hanging child on timeout, escalating when SIGTERM is ignored', async () => {
  const getChild = substituteChild("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)");
  const onReport = vi.fn();
  expect((await inspect(task(), { timeoutMs: 250, onReport })).status).toBe('error');
  expect(onReport.mock.calls[0][1].diagnostics).toEqual([{ code: 'TIMEOUT' }]);
  const child = getChild(); if (child.signalCode === null) await new Promise(resolve => child.once('close', resolve));
  expect(child.signalCode).toBe('SIGKILL');
});
it('aborts before spawn and during a pending child, ignoring late output', async () => {
  const request = task(), early = new AbortController(); early.abort('plaintext');
  const provider = createRuleBasedContentReviewProvider();
  expect((await provider.inspect(request.envelope, context(request), early.signal)).status).toBe('error'); expect(spawn).not.toHaveBeenCalled();
  const getChild = substituteChild("setTimeout(()=>{process.send('{}');process.disconnect()},500)");
  const controller = new AbortController(), onReport = vi.fn();
  const pending = createRuleBasedContentReviewProvider({ onReport }).inspect(request.envelope, context(request), controller.signal);
  controller.abort('plaintext'); expect((await pending).status).toBe('error');
  expect(onReport.mock.calls[0][1].diagnostics).toEqual([{ code: 'ABORTED' }]);
  if (getChild().signalCode === null) await new Promise(resolve => getChild().once('close', resolve));
  await delay(30); expect(onReport).toHaveBeenCalledOnce();
});
it('fails on spawn failures with no native exception content', async () => {
  vi.mocked(spawn).mockImplementationOnce(() => { throw Error('plaintext marker'); });
  const onReport = vi.fn(); expect((await inspect(task(), { onReport })).status).toBe('error');
  expect(onReport.mock.calls[0][1].diagnostics).toEqual([{ code: 'INSPECTOR_FAILED' }]);
  expect(JSON.stringify(onReport.mock.calls)).not.toContain('plaintext marker');
});
it('cannot complete after a callback throws or aborts, and isolates callback mutation', async () => {
  const request = task();
  expect((await inspect(request, { onReport: () => { throw Error('plaintext'); } })).status).toBe('error');
  const controller = new AbortController();
  const provider = createRuleBasedContentReviewProvider({ onReport: () => controller.abort() });
  expect((await provider.inspect(request.envelope, context(request), controller.signal)).status).toBe('error');
  const onReport = vi.fn((_id: string, report: RuleInspectionReport) => { report.status = 'error'; report.findings.push({} as never); });
  expect((await inspect(request, { onReport })).status).toBe('complete');
});
it('runs with no inherited credentials, plaintext argv/files/logs, or network calls', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'credential-marker'); vi.stubEnv('NODE_OPTIONS', '--trace-warnings'); vi.stubEnv('HTTPS_PROXY', 'proxy-marker');
  const hook = join(f.root, 'child-hook.mjs');
  writeFileSync(hook, `
    import fs from 'node:fs'; import fsp from 'node:fs/promises';
    import net from 'node:net'; import tls from 'node:tls'; import dns from 'node:dns';
    import http from 'node:http'; import https from 'node:https'; import dgram from 'node:dgram';
    import { syncBuiltinESMExports } from 'node:module';
    const deny = () => { throw Error('forbidden operation'); };
    if (process.env.OPENAI_API_KEY || process.env.NODE_OPTIONS || process.env.HTTPS_PROXY) throw Error('inherited environment');
    globalThis.fetch = deny; console.log = console.error = console.warn = deny;
    for (const name of ['writeFile','appendFile','mkdir','mkdtemp','rename','unlink','createWriteStream',
      'writeFileSync','appendFileSync','mkdirSync','mkdtempSync','renameSync','unlinkSync']) if(name in fs) fs[name]=deny;
    for (const name of ['writeFile','appendFile','mkdir','mkdtemp','rename','unlink']) fsp[name]=deny;
    net.connect=net.createConnection=net.Socket.prototype.connect=deny; tls.connect=deny;
    http.request=http.get=https.request=https.get=deny; dgram.createSocket=deny;
    for(const name of ['lookup','resolve','resolve4','resolve6']) {dns[name]=deny;dns.promises[name]=deny;}
    syncBuiltinESMExports();
  `);
  const before = readdirSync(f.root);
  vi.mocked(spawn).mockImplementationOnce((exe, argv, options) => {
    expect(exe).toBe(process.execPath);
    expect(JSON.stringify(argv)).not.toContain('plaintext-marker'); expect(JSON.stringify(options)).not.toContain('credential-marker');
    expect(options?.env).toEqual({ LANG: 'C.UTF-8', TZ: 'UTC', HOME: options?.cwd, TMPDIR: options?.cwd });
    const child = actualSpawn(exe, ['--import', pathToFileURL(hook).href, ...argv!], options);
    const send = child.send.bind(child);
    child.send = ((message: string, callback: (error: Error | null) => void) => {
      expect(message).not.toContain(f.owner.privateKey); expect(message).not.toContain(f.peer.privateKey);
      const request = JSON.parse(message);
      expect(Object.keys(request).sort()).toEqual(['content', 'limits']);
      expect(Object.keys(request.content).sort()).toEqual(['capabilityChains', 'input', 'manifest']);
      return send(message, callback);
    }) as typeof child.send;
    return child;
  });
  const onReport = vi.fn();
  expect((await inspect(task({ note: 'plaintext-marker', url: 'http://127.0.0.1/' }), { onReport })).status).toBe('complete');
  expect(readdirSync(f.root)).toEqual(before);
  expect(JSON.stringify(onReport.mock.calls)).not.toContain('plaintext-marker');
});
it('does not install defaults, persist reports, or reconstruct findings from cached receipts', async () => {
  const request = task('system prompt'), onReport = vi.fn(), provider = createRuleBasedContentReviewProvider({ onReport });
  const review = f.review({ provider }); review.hold(request);
  expect(await review.inspect(request.id)).toMatchObject({ state: 'reviewable', inspectionStatus: 'complete' });
  const record = f.store.read(request.id)!;
  expect(Object.keys(record.inspectionReceipt!.payload).sort()).toEqual(['type', 'v', 'recordId', 'ownerDid', 'kind', 'contentDigest', 'envelopeDigest', 'status', 'reportDigest', 'inspectedAt'].sort());
  const raw = readFileSync(join(f.store.directory, request.id + '.json'), 'utf8');
  expect(raw).not.toContain('system prompt'); expect(raw).not.toContain('findings');
  const restart = f.review({ provider }); await restart.inspect(request.id); expect(onReport).toHaveBeenCalledOnce();
  // A host explicitly recomputes from the verified envelope when it needs a report after restart.
  await provider.inspect(record.envelope, context(request), signal()); expect(onReport).toHaveBeenCalledTimes(2);
  expect(restart.showReviewedContent(request.id)).toEqual(request.content);
});
it('rejects unsupported limits and timeout values', () => {
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: 45001 }, { limits: { maxBytes: 9999999 } }, { limits: { maxDepth: NaN } }]) {
    expect(() => createRuleBasedContentReviewProvider(options)).toThrow('INVALID_INSPECTION_OPTIONS');
  }
});

it('handles IPC send errors and never completes before a child exits successfully', async () => {
  vi.mocked(spawn).mockImplementationOnce((exe, argv, options) => {
    const child = actualSpawn(exe, argv!, options);
    child.send = ((_message: unknown, callback: (error: Error) => void) => {
      callback(new Error('plaintext')); return false;
    }) as typeof child.send;
    return child;
  });
  const onReport = vi.fn(); expect((await inspect(task(), { onReport })).status).toBe('error');
  expect(onReport.mock.calls[0][1].diagnostics).toEqual([{ code: 'INSPECTOR_FAILED' }]);
  const request = task(), body = openEnvelope<Json>(request.envelope, f.owner) as unknown as { proposal: { payload: TaskManifest }; input: Json };
  const report = await inspectRuleContent({ manifest: body.proposal.payload, input: body.input, capabilityChains: [] });
  substituteChild('process.send(' + JSON.stringify(JSON.stringify(report)) + ',()=>process.exit(3))');
  expect((await inspect(request)).status).toBe('error');
});
it('bounds asynchronous report callbacks and treats rejection or late completion as error', async () => {
  expect((await inspect(task(), { onReport: async () => { throw Error('plaintext'); } })).status).toBe('error');
  let finish!: () => void;
  const onReport = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  expect((await inspect(task(), { timeoutMs: 400, onReport })).status).toBe('error');
  expect(onReport).toHaveBeenCalledOnce(); finish(); await delay(10); expect(onReport).toHaveBeenCalledOnce();
});

it('honors a shorter HeldRequestReview deadline and never completes from late child activity', async () => {
  const getChild = substituteChild("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)");
  const request = task(), onReport = vi.fn();
  const review = f.review({ inspectionTimeoutMs: 100,
    provider: createRuleBasedContentReviewProvider({ timeoutMs: 5000, onReport }) });
  review.hold(request);
  expect(await review.inspect(request.id)).toMatchObject({ state: 'held', inspectionStatus: 'error' });
  if (getChild().signalCode === null) await new Promise(resolve => getChild().once('close', resolve));
  expect(review.list()[0]).toMatchObject({ state: 'held', inspectionStatus: 'error' });
  expect(() => review.showReviewedContent(request.id)).toThrow('INSPECTION_INCOMPLETE');
});
