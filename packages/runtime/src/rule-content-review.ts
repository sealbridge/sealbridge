// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { sanitizedEnvironment, terminateSubprocess } from '@acp/sandbox';
import { CONTENT_INSPECTION_LIMITS, CONTENT_INSPECTION_RULES, CONTENT_INSPECTION_RULESET_DIGEST,
  CONTENT_INSPECTION_RULESET_VERSION, digest, openEnvelope, validateManifest, verifyEnvelope, verifySigned } from '@acp/core';
import type { Json, RuleInspectionDiagnosticCode, RuleInspectionInput, RuleInspectionOptions,
  RuleInspectionReport, Signed, SignedEnvelope, TaskManifest } from '@acp/core';
import { heldContentDigest } from './held-request-review.js';
import type { HeldContentReviewProvider, HeldInspectionContext, InspectionCompletion } from './held-request-review.js';

export interface RuleBasedContentReviewOptions {
  limits?: RuleInspectionOptions;
  timeoutMs?: number;
  onReport?: (recordId: string, report: RuleInspectionReport) => void;
}
const MAX_RESULT_BYTES = 64 * 1024;
// Works both from source (after build) and in the packaged dist tree. Never run task-supplied code.
const childEntry = fileURLToPath(new URL('../dist/rule-content-review-child.js', import.meta.url));
function project(envelope: SignedEnvelope, context: HeldInspectionContext): RuleInspectionInput {
  if (!verifyEnvelope(envelope, context.owner.did) || digest(envelope) !== context.envelopeDigest ||
    envelope.payload.eventType !== 'PROPOSE' || envelope.payload.seq !== 0) throw new Error('INVALID_CONTENT');
  const body = openEnvelope<Json>(envelope, context.owner) as unknown as {
    proposal: Signed<TaskManifest>; input: Json; capabilityChains?: Json;
  };
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'input')) throw new Error('INVALID_CONTENT');
  const manifest = body.proposal?.payload;
  validateManifest(manifest);
  if (manifest.taskId !== envelope.payload.taskId || manifest.worker?.ownerDid !== context.owner.did ||
    manifest.requester.ownerDid !== envelope.payload.senderDid || !verifySigned(body.proposal, manifest.requester.ownerDid) ||
    heldContentDigest('task', body as unknown as Json) !== context.contentDigest ||
    digest({ manifest, input: body.input }) !== context.contentDigest) throw new Error('INVALID_CONTENT');
  return { manifest, input: body.input, capabilityChains: body.capabilityChains ?? [] };
}
function validReport(value: unknown, contentDigest: string, limits: Required<RuleInspectionOptions>): value is RuleInspectionReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as RuleInspectionReport;
  if (Object.keys(report).sort().join() !== ['inspectorId', 'inspectorVersion', 'rulesetDigest', 'contentDigest', 'sizeBytes', 'limits', 'status', 'verdict', 'findings', 'diagnostics'].sort().join() ||
    report.inspectorId !== 'rules' || report.inspectorVersion !== CONTENT_INSPECTION_RULESET_VERSION ||
    report.rulesetDigest !== CONTENT_INSPECTION_RULESET_DIGEST || digest(report.limits) !== digest(limits) ||
    !Number.isSafeInteger(report.sizeBytes) || report.sizeBytes < 0 ||
    !['ok', 'error'].includes(report.status) || !Array.isArray(report.findings) || report.findings.length > limits.maxFindings ||
    !Array.isArray(report.diagnostics)) return false;
  if (report.status === 'ok' && (report.contentDigest !== contentDigest || report.sizeBytes > limits.maxBytes || report.diagnostics.length)) return false;
  if (report.status === 'error' && (report.verdict !== 'error' || report.diagnostics.length !== 1)) return false;
  for (const diagnostic of report.diagnostics) {
    if (!diagnostic || Object.keys(diagnostic).join() !== 'code' ||
      !['LIMIT_EXCEEDED', 'ABORTED', 'INVALID_CONTENT', 'INSPECTOR_FAILED'].includes(diagnostic.code)) return false;
  }
  for (const finding of report.findings) {
    const rule = CONTENT_INSPECTION_RULES.find(rule => rule.id === finding?.ruleId);
    if (!rule || finding.kind !== rule.kind || finding.severity !== rule.severity || finding.noteCode !== rule.noteCode ||
      Object.keys(finding).some(key => !['ruleId', 'kind', 'severity', 'noteCode', 'location'].includes(key))) return false;
    if (finding.location !== undefined) {
      const location = finding.location;
      if (!location || Object.keys(location).some(key => !['path', 'start', 'end'].includes(key)) ||
        typeof location.path !== 'string' || location.path.length > 4096 || (location.path !== '' && !location.path.startsWith('/') || /~(?![01])/u.test(location.path)) ||
        /[\p{C}]/u.test(location.path) ||
        (location.start !== undefined && (!Number.isSafeInteger(location.start) || location.start < 0 ||
          !Number.isSafeInteger(location.end) || location.end! < location.start || location.end! > limits.maxStringLength)) ||
        (location.start === undefined && location.end !== undefined)) return false;
    }
  }
  const verdict = report.findings.some(f => f.severity === 'block') ? 'block' : report.findings.some(f => f.severity === 'warn') ? 'warn' : 'pass';
  return report.status === 'error' || report.verdict === verdict;
}
/** Opt-in task inspector. Completion is review material; owner opening stays on the live admission path. */
export function createRuleBasedContentReviewProvider(options: RuleBasedContentReviewOptions = {}): HeldContentReviewProvider {
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 45_000) throw new Error('INVALID_INSPECTION_OPTIONS');
  const limits: Required<RuleInspectionOptions> = { ...CONTENT_INSPECTION_LIMITS, ...options.limits };
  for (const key of Object.keys(limits) as (keyof RuleInspectionOptions)[]) {
    if (!Object.hasOwn(CONTENT_INSPECTION_LIMITS, key) || !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 || limits[key] > CONTENT_INSPECTION_LIMITS[key]) throw new Error('INVALID_INSPECTION_OPTIONS');
  }
  const onReport = options.onReport;
  return { async inspect(envelope, context, signal): Promise<InspectionCompletion> {
    const completion = { ownerDid: context.owner.did, kind: context.kind, contentDigest: context.contentDigest,
      envelopeDigest: context.envelopeDigest };
    if (context.kind !== 'task') return { ...completion, status: 'unavailable' };
    const started = performance.now();
    let report: RuleInspectionReport;
    const errorReport = (code: RuleInspectionDiagnosticCode): RuleInspectionReport => ({
      inspectorId: 'rules', inspectorVersion: CONTENT_INSPECTION_RULESET_VERSION, rulesetDigest: CONTENT_INSPECTION_RULESET_DIGEST,
      contentDigest: context.contentDigest, sizeBytes: 0, limits: { ...limits }, status: 'error', verdict: 'error', findings: [], diagnostics: [{ code }],
    });
    try {
      if (signal.aborted) throw 'ABORTED';
      let content: RuleInspectionInput;
      try { content = project(envelope, context); } catch { throw 'INVALID_CONTENT'; }
      if (signal.aborted) throw 'ABORTED';
      const remaining = timeoutMs - (performance.now() - started);
      if (remaining <= 0) throw 'TIMEOUT';
      report = await new Promise<RuleInspectionReport>((resolve, reject) => {
        const directory = tmpdir();
        const child = spawn(process.execPath, ['--no-addons', '--disable-proto=throw', '--max-old-space-size=64', childEntry], {
          cwd: directory, env: sanitizedEnvironment(directory), stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
        });
        let done = false;
        let childReport: RuleInspectionReport | undefined;
        const finish = (code?: RuleInspectionDiagnosticCode, result?: RuleInspectionReport) => {
          if (done) return;
          done = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
          terminateSubprocess(child);
          if (code) reject(code); else resolve(result!);
        };
        const abort = () => finish('ABORTED');
        const timer = setTimeout(() => finish('TIMEOUT'), remaining);
        signal.addEventListener('abort', abort, { once: true });
        child.once('error', () => finish('INSPECTOR_FAILED'));
        child.stderr?.on('error', () => finish('INSPECTOR_FAILED'));
        // Never retain or relay child stderr, including native parser/error text.
        child.stderr?.on('data', () => finish('INSPECTOR_FAILED'));
        child.on('message', (message: unknown) => {
          if (done) return;
          if (typeof message !== 'string') return finish('INSPECTOR_FAILED');
          if (Buffer.byteLength(message) > MAX_RESULT_BYTES) return finish('LIMIT_EXCEEDED');
          try {
            const result: unknown = JSON.parse(message);
            if (childReport || !validReport(result, context.contentDigest, limits)) return finish('INSPECTOR_FAILED');
            // Even an early bound failure is attached to the authenticated parent digest.
            childReport = { ...result, contentDigest: context.contentDigest };
          } catch { finish('INSPECTOR_FAILED'); }
        });
        child.once('close', code => {
          if (done) return;
          if (code !== 0 || !childReport) return finish('INSPECTOR_FAILED');
          finish(undefined, childReport);
        });
        if (signal.aborted) abort();
        if (!done) {
          try {
            const request = JSON.stringify({ content, limits });
            if (Buffer.byteLength(request) > 256 * 1024 + 4096) finish('LIMIT_EXCEEDED');
            else child.send(request, error => { if (error) finish('INSPECTOR_FAILED'); });
          } catch { finish('INSPECTOR_FAILED'); }
        }
      });
    } catch (code) {
      report = errorReport(['ABORTED', 'TIMEOUT', 'INVALID_CONTENT', 'LIMIT_EXCEEDED'].includes(code as string)
        ? code as RuleInspectionDiagnosticCode : 'INSPECTOR_FAILED');
    }
    if (signal.aborted) report = errorReport('ABORTED');
    if (performance.now() - started >= timeoutMs) report = errorReport('TIMEOUT');
    // Bind before calling host code, which receives an independent mutable copy.
    const reportDigest = digest({ recordId: context.recordId, ownerDid: context.owner.did,
      kind: context.kind, contentDigest: context.contentDigest, envelopeDigest: context.envelopeDigest, report });
    let callbackTimer: ReturnType<typeof setTimeout> | undefined;
    let callbackAbort: (() => void) | undefined;
    try {
      if (onReport) await Promise.race([
        Promise.resolve().then(() => {
          return onReport(context.recordId, structuredClone(signal.aborted ? errorReport('ABORTED') : report));
        }),
        new Promise<never>((_resolve, reject) => {
          callbackAbort = () => reject(new Error('ABORTED'));
          signal.addEventListener('abort', callbackAbort, { once: true });
          callbackTimer = setTimeout(() => reject(new Error('TIMEOUT')), Math.max(1, timeoutMs - (performance.now() - started)));
          if (signal.aborted) callbackAbort();
        }),
      ]);
    } catch { return { ...completion, status: 'error' }; }
    finally {
      clearTimeout(callbackTimer);
      if (callbackAbort) signal.removeEventListener('abort', callbackAbort);
    }
    if (signal.aborted || performance.now() - started >= timeoutMs) return { ...completion, status: 'error' };
    return { ...completion, status: report.status === 'ok' ? 'complete' : 'error', reportDigest };
  } };
}
