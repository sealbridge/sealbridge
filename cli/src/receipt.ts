// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs';
import { parseJsonl, verifyAudit } from '@acp/ledger';
import type { AuditBundle, AuditVerificationOptions } from '@acp/ledger';

const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const safeId = (v: unknown) => typeof v === 'string' && /^(?:task_[a-zA-Z0-9_-]{1,100}|did:key:z[1-9A-HJ-NP-Za-km-z]{20,100})$/.test(v) ? v : '[redacted]';
const time = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
export function createReceipt(raw: string, anchor?: AuditVerificationOptions) {
  let bundle: AuditBundle | undefined;
  let verification: ReturnType<typeof verifyAudit>;
  try {
    bundle = parseJsonl(raw);
    verification = verifyAudit(bundle, anchor);
  } catch {
    verification = { valid: false, status: 'INVALID', statusLabel: 'INVALID', trustAnchorVerified: false, truncationChecked: false };
  }
  // Do not reflect verifier exception text or any payload from an invalid record.
  const { reason: _reason, ...checked } = verification;
  const entries = verification.valid ? bundle!.entries : [];
  const events = entries.map(e => e.body.eventType);
  const required = ['PROPOSE', 'ACCEPT', 'START', 'DELIVER', 'VERIFY_ACCEPT', 'SETTLED'];
  let position = -1;
  const complete = required.every(event => { position = events.indexOf(event, position + 1); return position >= 0; }) && events.at(-1) === 'SETTLED';
  // A locally reconstructed checkpoint cannot prove the log is the latest one.
  const anchored = !!(anchor?.head || anchor?.expectedLastEntryHash || anchor?.trustAnchor?.head || anchor?.trustAnchor?.expectedLastEntryHash);
  const status = !verification.valid ? 'INVALID' : !complete ? 'INCOMPLETE' : !anchored ? 'UNCONFIRMED' : 'COMPLETED';
  const proposal = object(entries.find(e => e.body.eventType === 'PROPOSE')?.body.payload);
  const manifest = object(object(proposal.proposal).payload);
  const delivery = object(entries.find(e => e.body.eventType === 'DELIVER')?.body.payload);
  const usage = object(object(delivery.usage).payload);
  const budget = object(manifest.budget);
  return {
    version: 1, status,
    message: status === 'COMPLETED' ? 'Completed. Both sides signed this record.' :
      status === 'UNCONFIRMED' ? 'Settlement recorded; completeness unconfirmed without an independent audit head.' :
      status === 'INCOMPLETE' ? 'Incomplete record; completion not established.' : 'Invalid record; completion not established.',
    paymentNotice: 'SETTLED is not proof of payment. Sealbridge settlement records work, not money.',
    verification: checked,
    taskId: entries.length ? safeId(entries[0].body.taskId) : null,
    who: entries.length ? bundle!.checkpoint.actor.payload.actors.map(safeId) : [],
    what: 'Task content redacted for privacy; inspect the original audit locally for details.',
    when: { firstSignedAt: time(entries[0]?.actorSignature.signedAt), lastSignedAt: time(entries.at(-1)?.actorSignature.signedAt),
      timeSource: 'Participant signing clocks; not an independent timestamp authority', timezone: 'UTC' },
    usage: { inputTokens: count(usage.inputTokens), outputTokens: count(usage.outputTokens),
      toolCalls: count(usage.toolCalls), elapsedMs: count(usage.wallTimeMs), source: 'Recorded delivery usage; null means unavailable' },
    budget: { inputTokens: count(budget.maxInputTokens), outputTokens: count(budget.maxOutputTokens),
      toolCalls: count(budget.maxToolInvocations), elapsedSeconds: count(budget.maxWallClockSeconds) },
    privacy: 'Inputs, outputs, names, titles, descriptions, paths and arbitrary error text are omitted. Public DIDs remain for accountability.',
  };
}
export function receiptHtml(receipt: ReturnType<typeof createReceipt>): string {
  const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const value = (v: string | number | null) => escape(v === null ? 'Not recorded' : String(v));
  const row = (label: string, v: string | number | null) => '<tr><th scope="row">' + escape(label) + '</th><td>' + value(v) + '</td></tr>';
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
    '<title>Sealbridge receipt</title><style>body{font:16px system-ui;max-width:56rem;margin:3rem auto;padding:1rem;line-height:1.6}pre,td{white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.5rem;border-bottom:1px solid #ccc}th{width:12rem}details{margin-top:2rem}</style>' +
    '<h1>Sealbridge receipt</h1><h2>' + escape(receipt.message) + '</h2><p>' + escape(receipt.paymentNotice) +
    '</p><table><caption>Recorded task summary</caption>' + row('Job', receipt.taskId) +
    row('Participants', receipt.who.join('\n') || null) + row('What', receipt.what) +
    row('First signed (UTC)', receipt.when.firstSignedAt) + row('Last signed (UTC)', receipt.when.lastSignedAt) +
    row('Input tokens used', receipt.usage.inputTokens) + row('Output tokens used', receipt.usage.outputTokens) +
    row('Tool calls used', receipt.usage.toolCalls) + row('Elapsed milliseconds', receipt.usage.elapsedMs) +
    row('Verification', receipt.verification.statusLabel) + '</table><p>' + escape(receipt.when.timeSource) +
    '</p><p>' + escape(receipt.privacy) + '</p><details><summary>Technical details</summary><pre>' +
    escape(JSON.stringify(receipt, null, 2)) + '</pre></details></html>\n';
}
export function receiptCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: sealbridge receipt <audit.jsonl> [--out <prefix>] [--trust-anchor <json>]');
    return;
  }
  const input = args.shift();
  if (!input || input.startsWith('--')) throw new Error('Usage: sealbridge receipt <audit.jsonl> [--out <prefix>] [--trust-anchor <json>]');
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--out', '--trust-anchor'].includes(args[i]) || options.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('INVALID_RECEIPT_OPTION');
    options.set(args[i], args[i + 1]);
  }
  const anchor = options.has('--trust-anchor') ? JSON.parse(readFileSync(options.get('--trust-anchor')!, 'utf8')) as AuditVerificationOptions : undefined;
  if (anchor !== undefined && (!anchor || typeof anchor !== 'object' || Array.isArray(anchor))) throw new Error('INVALID_TRUST_ANCHOR');
  const receipt = createReceipt(readFileSync(input, 'utf8'), anchor);
  const prefix = options.get('--out') ?? input + '.receipt';
  writeFileSync(prefix + '.json', JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(prefix + '.html', receiptHtml(receipt), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(receipt));
  if (receipt.status === 'INVALID' || receipt.status === 'INCOMPLETE') process.exitCode = 1;
}
