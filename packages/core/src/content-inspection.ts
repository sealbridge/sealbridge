// SPDX-License-Identifier: Apache-2.0
import { digest } from './crypto.js';
import { validateManifest } from './schema.js';
import type { Json, TaskManifest } from './types.js';
import { CONTENT_INSPECTION_LIMITS, CONTENT_INSPECTION_RULES, CONTENT_INSPECTION_RULESET_DIGEST,
  CONTENT_INSPECTION_RULESET_VERSION } from './content-inspection-rules.js';
import type { RuleInspectionKind, RuleInspectionRule } from './content-inspection-rules.js';

export interface RuleInspectionInput { manifest: TaskManifest; input: Json; capabilityChains?: Json }
export interface RuleInspectionOptions {
  maxBytes?: number; maxDepth?: number; maxNodes?: number; maxStringLength?: number;
  maxFindings?: number; maxDecodedBytes?: number;
}
export interface RuleInspectionFinding {
  ruleId: string; kind: RuleInspectionKind; severity: 'info' | 'warn' | 'block';
  location?: { path: string; start?: number; end?: number }; noteCode: string;
}
export type RuleInspectionDiagnosticCode = 'LIMIT_EXCEEDED' | 'ABORTED' | 'TIMEOUT' | 'INVALID_CONTENT' | 'INSPECTOR_FAILED';
export interface RuleInspectionReport {
  inspectorId: 'rules'; inspectorVersion: string; rulesetDigest: string; contentDigest: string;
  sizeBytes: number; limits: Required<RuleInspectionOptions>; status: 'ok' | 'error';
  verdict: 'pass' | 'warn' | 'block' | 'error'; findings: RuleInspectionFinding[];
  diagnostics: { code: RuleInspectionDiagnosticCode }[];
}
const pointer = (segment: string) => segment.replace(/~/gu, '~0').replace(/\//gu, '~1');
// Ordinary pointer keys locate content; keys containing potential evidence use a fixed marker.
function pathSegment(key: string): string {
  const redact = key.length > 80 || /[\p{C}]|[a-z][a-z0-9+.-]*:|api.?key|token|password|secret|\.env|\.ssh|id_rsa|パスワード|トークン|秘密/iu.test(key) ||
    CONTENT_INSPECTION_RULES.some(rule => rule.pattern && new RegExp(rule.pattern, rule.flags).test(key));
  return pointer(redact ? '[redacted]' : key);
}
function binaryMagic(bytes: Buffer): boolean {
  const hex = bytes.subarray(0, 8).toString('hex');
  return ['4d5a', '7f454c46', 'cafebabe', 'cefaedfe', 'cffaedfe', 'feedface', 'feedfacf',
    '504b0304', '504b0506', '504b0708', '1f8b', '377abcaf271c', '526172211a07', '425a68', 'fd377a585a00', '0061736d']
    .some(magic => hex.startsWith(magic)) || bytes.subarray(257, 262).toString('ascii') === 'ustar';
}
/** Offline heuristic inspection. Limits are local and may only be lowered. Content is never executed. */
export async function inspectRuleContent(content: RuleInspectionInput, options: RuleInspectionOptions = {}, signal?: AbortSignal): Promise<RuleInspectionReport> {
  const limits: Required<RuleInspectionOptions> = { ...CONTENT_INSPECTION_LIMITS };
  const findings: RuleInspectionFinding[] = [];
  let sizeBytes = 0, nodes = 0, decodedBytes = 0;
  let contentDigest = digest(null);
  let failure: RuleInspectionDiagnosticCode | undefined;
  const stop = (code: RuleInspectionDiagnosticCode): never => { throw code; };
  const checkAbort = () => { if (signal?.aborted) stop('ABORTED'); };
  const addBytes = (bytes: number) => { sizeBytes += bytes; if (sizeBytes > limits.maxBytes) stop('LIMIT_EXCEEDED'); };
  const add = (rule: RuleInspectionRule, path?: string, start?: number, end?: number) => {
    if (findings.length >= limits.maxFindings) stop('LIMIT_EXCEEDED');
    findings.push({ ruleId: rule.id, kind: rule.kind, severity: rule.severity, noteCode: rule.noteCode,
      ...(path === undefined ? {} : { location: { path, ...(start === undefined ? {} : { start, end }) } }) });
  };
  const seen = new Set<object>();
  const strings: { value: string; path: string; order: string }[] = [];
  const count = async () => {
    checkAbort();
    if (++nodes > limits.maxNodes) stop('LIMIT_EXCEEDED');
    if (nodes % 256 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); checkAbort(); }
  };
  const string = (value: string, path: string, order: string) => {
    if (/[\uD800-\uDFFF]/u.test(value)) stop('INVALID_CONTENT');
    if (Buffer.byteLength(value) > limits.maxStringLength) stop('LIMIT_EXCEEDED');
    addBytes(Buffer.byteLength(JSON.stringify(value))); strings.push({ value, path, order });
  };
  // Validate JSON without invoking accessors/toJSON, then hash only the bounded snapshot.
  async function visit(value: unknown, path: string, depth: number, order = ''): Promise<Json> {
    await count();
    if (depth > limits.maxDepth) stop('LIMIT_EXCEEDED');
    if (typeof value === 'string') { string(value, path, order); return value; }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) {
      addBytes(Buffer.byteLength(JSON.stringify(value))); return value;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return stop('INVALID_CONTENT');
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      return stop('INVALID_CONTENT');
    seen.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) return stop('INVALID_CONTENT');
    if (keys.length > limits.maxNodes - nodes + (array ? 1 : 0)) return stop('LIMIT_EXCEEDED');
    const result: Json[] | { [key: string]: Json } = array ? [] : Object.create(null);
    const ordered = array ? keys.filter(key => key !== 'length') as string[] : (keys as string[]).sort((a, b) =>
      pointer(a) < pointer(b) ? -1 : pointer(a) > pointer(b) ? 1 : 0);
    if (array && ordered.length !== value.length) return stop('INVALID_CONTENT');
    addBytes(2);
    for (let i = 0; i < ordered.length; i++) {
      const key = ordered[i];
      if (array && key !== String(i)) return stop('INVALID_CONTENT');
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return stop('INVALID_CONTENT');
      if (i) addBytes(1);
      const nextPath = path + '/' + pathSegment(key);
      const nextOrder = order + '/' + pointer(key);
      if (!array) { await count(); string(key, nextPath, nextOrder); addBytes(1); }
      const item = await visit(descriptor.value, nextPath, depth + 1, nextOrder);
      if (array) (result as Json[]).push(item); else (result as { [key: string]: Json })[key] = item;
    }
    seen.delete(value);
    return result;
  }
  try {
    checkAbort();
    if (!options || typeof options !== 'object' || Object.keys(options).some(key => !Object.hasOwn(limits, key))) stop('INVALID_CONTENT');
    for (const key of Object.keys(limits) as (keyof RuleInspectionOptions)[]) {
      const value = options[key];
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || value < 1 || value > CONTENT_INSPECTION_LIMITS[key]) stop('INVALID_CONTENT');
        limits[key] = value;
      }
    }
    const snapshot = await visit(content, '', 0) as unknown as RuleInspectionInput;
    if (!snapshot || typeof snapshot !== 'object' || !Object.hasOwn(snapshot, 'manifest') || !Object.hasOwn(snapshot, 'input') ||
      Object.keys(snapshot).some(key => !['manifest', 'input', 'capabilityChains'].includes(key))) stop('INVALID_CONTENT');
    contentDigest = digest({ manifest: snapshot.manifest, input: snapshot.input });
    try { validateManifest(snapshot.manifest); } catch { stop('INVALID_CONTENT'); }
    // Arrays also follow lexical JSON Pointer order (10 precedes 2).
    strings.sort((a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 : 0);
    for (const { value, path } of strings) {
      await new Promise<void>(resolve => setImmediate(resolve)); checkAbort();
      for (const rule of CONTENT_INSPECTION_RULES) {
        if (!rule.pattern) continue;
        const regex = new RegExp(rule.pattern, rule.flags);
        for (const match of value.matchAll(regex)) {
          checkAbort();
          const start = match.index!, end = start + match[0].length;
          if (rule.detector === 'unicode' && match[0] === '\u200d' &&
            /\p{Extended_Pictographic}[\uFE0F\p{Emoji_Modifier}]*$/u.test(value.slice(0, start)) &&
            /^\p{Extended_Pictographic}/u.test(value.slice(end))) continue;
          if (rule.id === 'secret-request' && !rule.terms!.some(term => value.toLowerCase().includes(term))) continue;
          if (rule.detector === 'url') {
            try {
              const url = new URL(match[0].startsWith('www.') ? 'https://' + match[0] : match[0]);
              const host = url.hostname.toLowerCase();
              if (url.protocol === 'https:' && !host.includes('xn--') && !/^\[|^\d+(?:\.\d+){3}$/u.test(host) &&
                !rule.terms!.includes(host.replace(/^www\./u, ''))) continue;
            } catch { /* A recognized URL form that cannot be parsed is still a finding. */ }
          }
          add(rule, path, start, end);
          if (rule.id === 'base64') {
            const text = match[0];
            const length = Math.floor(text.replace(/=+$/u, '').length * 6 / 8);
            if (decodedBytes + length > limits.maxDecodedBytes) stop('LIMIT_EXCEEDED');
            const bytes = Buffer.from(text, 'base64'); decodedBytes += bytes.length;
            if (binaryMagic(bytes)) add(CONTENT_INSPECTION_RULES.find(rule => rule.id === 'binary-magic')!, path, start, end);
          }
        }
      }
    }
    checkAbort();
  } catch (code) {
    failure = ['LIMIT_EXCEEDED', 'ABORTED', 'INVALID_CONTENT'].includes(code as string)
      ? code as RuleInspectionDiagnosticCode : 'INSPECTOR_FAILED';
    if (failure === 'LIMIT_EXCEEDED' || failure === 'INVALID_CONTENT') {
      // Leave room for the failure finding even when the finding cap was reached.
      const rule = CONTENT_INSPECTION_RULES.find(rule => rule.id === (failure === 'LIMIT_EXCEEDED' ? 'bounds' : 'format'))!;
      if (findings.length >= limits.maxFindings) findings.pop();
      findings.push({ ruleId: rule.id, kind: rule.kind, severity: rule.severity, noteCode: rule.noteCode });
    }
  }
  return { inspectorId: 'rules', inspectorVersion: CONTENT_INSPECTION_RULESET_VERSION,
    rulesetDigest: CONTENT_INSPECTION_RULESET_DIGEST, contentDigest, sizeBytes, limits,
    status: failure ? 'error' : 'ok', verdict: failure ? 'error' : findings.some(f => f.severity === 'block') ? 'block' :
      findings.some(f => f.severity === 'warn') ? 'warn' : 'pass', findings, diagnostics: failure ? [{ code: failure }] : [] };
}
