// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { relayDiagnostic } from '@acp/relay';
import { japaneseErrorReason } from './error-messages.js';

const REDACTED = '[redacted]';
const hints = new Set([
  'Use a budget within the advertised policy.',
  'Select an advertised skill and task type, or omit both for direct delegation.',
  'Reduce the execution budget or raise the worker execution timeout before accepting.',
  'Reduce the execution budget or raise the worker overall task timeout before accepting.',
  'Raise the requester idle timeout or shorten the worker heartbeat interval before accepting.',
]);
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function identifier(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,160}$/.test(value) ? value : REDACTED;
}
function reason(value: unknown): string {
  if (typeof value !== 'string') return REDACTED;
  const did = 'did:key:z[1-9A-HJ-NP-Za-km-z]{1,100}';
  const field = '(?:maxInputTokens|maxOutputTokens|maxToolInvocations|maxWallClockSeconds|timeoutSeconds)';
  const number = '-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?';
  if (value === 'The worker owner must review this requester. No task was accepted. Do not retry automatically.' ||
      /^(?:manifest|budget) is missing$/.test(value) ||
      new RegExp('^' + field + ' is missing or not a finite number$').test(value) ||
      new RegExp('^' + field + ' ' + number + ' exceeds worker limit ' + number + '$').test(value) ||
      /^maxConcurrentTasks \d+ reached$/.test(value) ||
      new RegExp('^per-requester rate limit exceeded for ' + did + ' \\(\\d+ requests / \\d+ms\\)$').test(value) ||
      new RegExp('^requester (?:' + did + '|unknown) is not allowed$').test(value) ||
      new RegExp('^requester ' + did + ' does not match envelope from ' + did + '$').test(value)) return value;
  return REDACTED;
}

/** Project machine events onto documented fields; free-form diagnostics are omitted. */
export function workerJson(value: unknown): string {
  const source = record(value), out: Record<string, unknown> = {};
  if (source.event !== undefined) out.event = identifier(source.event);
  if (source.taskId !== undefined) out.taskId = identifier(source.taskId);
  if (source.status !== undefined)
    out.status = ['connected', 'reconnecting', 'unavailable', 'stopped'].includes(String(source.status)) ? source.status : REDACTED;
  if (source.error !== undefined) {
    const message = relayDiagnostic(source.error).message;
    out.error = message;
    out.reasonJa = japaneseErrorReason(message);
  }
  if (source.code !== undefined) {
    out.code = typeof source.code === 'string' && /^[A-Z][A-Z0-9_]{0,100}$/.test(source.code) ? source.code : 'EXECUTION_FAILED';
    out.reasonJa = japaneseErrorReason(String(out.code));
  }
  if (source.reason !== undefined) out.reason = reason(source.reason);
  if (source.detail !== undefined) {
    const detail = record(source.detail);
    const hash = (v: unknown) => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v) ? v : REDACTED;
    out.detail = {
      field: typeof detail.field === 'string' && /^(?:task\.scope|peerIdleTimeoutMs|budget\.(?:maxInputTokens|maxOutputTokens|maxToolInvocations|maxWallClockSeconds))$/.test(detail.field) ? detail.field : REDACTED,
      expected: hash(detail.expected), actual: hash(detail.actual),
      hint: typeof detail.hint === 'string' && hints.has(detail.hint) ? detail.hint : REDACTED,
    };
  }
  if (source.event === 'invite_ready') {
    if (typeof source.inviteDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(source.inviteDigest)) out.inviteDigest = source.inviteDigest;
    if (typeof source.expiresAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(source.expiresAt)) out.expiresAt = source.expiresAt;
    if (typeof source.workerDid === 'string' && /^did:key:z[1-9A-HJ-NP-Za-km-z]{1,100}$/.test(source.workerDid)) out.workerDid = source.workerDid;
    if (typeof source.relay === 'string') {
      const url = new URL(source.relay);
      url.username = ''; url.password = ''; url.search = ''; url.hash = '';
      out.relay = /acp-invite:|acp:|bearer/i.test(url.pathname) ? url.origin : url.toString().replace(/\/$/, '');
    }
  }
  return JSON.stringify(out);
}

export function emitWorkerJson(value: unknown): void { console.error(workerJson(value)); }
export function inviteDigest(token: string): string {
  return 'sha256:' + createHash('sha256').update(token).digest('hex');
}
