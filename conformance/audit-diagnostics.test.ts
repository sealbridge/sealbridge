// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPair } from '../packages/core/src/index.js';
import { BilateralLedger, JsonlStore, parseAuditJsonl, parseJsonl, verifyAudit } from '../packages/ledger/src/index.js';
import type { InterruptedAuditBundle } from '../packages/ledger/src/index.js';
import type { AuditBundle } from '../packages/ledger/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { HeldRequestReview, InteractiveCliApprovalProvider, PolicyAutoApprovalProvider, RequesterClient, WorkerNode } from '../packages/runtime/src/index.js';
import { cliTaskInspection } from '../cli/src/task-review.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'sealbridge-audit-diagnostics-'));
  dirs.push(dir);
  return dir;
}
function fixture() {
  const alice = generateKeyPair(), bob = generateKeyPair();
  const ledger = new BilateralLedger('task_diagnostics', [alice.did, bob.did]);
  ledger.append('PROPOSE', { content: 'body-must-not-be-printed' }, alice, bob);
  ledger.append('ACCEPT', {}, bob, alice);
  return ledger.bundle(alice, bob);
}
function jsonl(bundle: AuditBundle) {
  // Leading and interior blank LF lines, CRLF entry lines, and trailing whitespace.
  return '\r\n\n' + bundle.entries.map(entry => JSON.stringify({ entry }) + '\r\n\n').join('')
    + JSON.stringify({ checkpoint: bundle.checkpoint }) + '\r\n';
}
function parseError(text: string): Error {
  try { parseJsonl(text); } catch (error) { return error as Error; }
  throw new Error('Expected parsing to fail');
}
function location(message: string): Record<string, unknown> {
  return JSON.parse(message.split('; auditLocation=')[1]);
}
function cli(path: string, ...flags: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // File descriptors also capture output when the test host intercepts child-process pipes.
    const dir = directory(), stdout = join(dir, 'stdout'), stderr = join(dir, 'stderr');
    const out = openSync(stdout, 'w'), err = openSync(stderr, 'w');
    let child;
    try {
      child = spawn(process.execPath, ['cli/dist/index.js', 'audit-verify', path, ...flags], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', out, err],
      });
    } finally {
      closeSync(out);
      closeSync(err);
    }
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: readFileSync(stdout, 'utf8'), stderr: readFileSync(stderr, 'utf8') }));
  });
}

describe('audit failure locations', () => {
  it('identifies the last entry for missing checkpoints without inventing a terminal line', () => {
    const entry = fixture().entries[0];
    const error = parseError('\r\n\n' + JSON.stringify({ entry }) + '\r\n\n');
    expect(error.message).toMatch(/^MISSING_OR_MISPLACED_CHECKPOINT;/);
    expect(location(error.message)).toEqual({ locationKind: 'last-entry', taskId: entry.body.taskId,
      seq: 0, entryHash: entry.entryHash, line: 3, verified: false });
    expect(error.message).not.toContain('body-must-not-be-printed');
    expect(location(parseError('').message)).not.toHaveProperty('line');
    const unknownTail = parseError(JSON.stringify({ entry }) + '\n{}\n');
    expect(location(unknownTail.message)).toMatchObject({ locationKind: 'record', line: 2,
      lastEntry: { locationKind: 'last-entry', taskId: entry.body.taskId, seq: 0,
        entryHash: entry.entryHash, line: 1, verified: false } });
  });

  it('identifies a misplaced checkpoint rather than blaming an entry', () => {
    const bundle = fixture();
    const error = parseError(JSON.stringify({ checkpoint: bundle.checkpoint }) + '\n'
      + bundle.entries.map(entry => JSON.stringify({ entry })).join('\n'));
    expect(location(error.message)).toEqual({ locationKind: 'checkpoint', taskId: 'task_diagnostics',
      head: bundle.checkpoint.actor.payload.head, line: 1, verified: false });
  });

  it.each(['payload', 'seq', 'signature', 'schema'] as const)('identifies the offending entry on %s failure', change => {
    const bundle = fixture();
    const entry = bundle.entries[0];
    if (change === 'payload') entry.body.payload = { changed: true };
    if (change === 'seq') entry.body.seq = 9;
    if (change === 'signature') entry.actorSignature.signature = 'ed25519:' + 'A'.repeat(86);
    if (change === 'schema') delete (entry as Partial<typeof entry>).actorSignature;
    const result = verifyAudit(parseJsonl(jsonl(bundle)));
    expect(result).toMatchObject({ valid: false, status: 'INVALID', statusLabel: 'INVALID' });
    expect(result.reason).toMatch(change === 'schema' ? /^Error: SCHEMA_VIOLATION:/ : /^Error: entry 0;/);
    expect(result.reason).not.toContain('body-must-not-be-printed');
    expect(location(result.reason!)).toEqual({ locationKind: 'entry', taskId: 'task_diagnostics',
      seq: change === 'seq' ? 9 : 0, entryHash: entry.entryHash, line: 3, index: 0, verified: false });
  });

  it('reports a presented hash and uses an array index without a fabricated line for JSON bundles', () => {
    const bundle = fixture();
    bundle.entries[0].entryHash = 'sha256:' + '0'.repeat(64);
    const result = verifyAudit(bundle);
    expect(location(result.reason!)).toEqual({ locationKind: 'entry', taskId: 'task_diagnostics',
      seq: 0, entryHash: bundle.entries[0].entryHash, index: 0, verified: false });
    expect(JSON.stringify(bundle)).not.toContain('line');
  });

  it('locates checkpoint and anchor failures separately from their last-entry context', () => {
    const bundle = fixture();
    const result = verifyAudit(parseJsonl(jsonl(bundle)), { expectedEntryCount: 99 });
    expect(result.reason).toMatch(/^Error: trust anchor;/);
    expect(location(result.reason!)).toEqual({ locationKind: 'checkpoint', taskId: 'task_diagnostics',
      head: bundle.entries[1].entryHash, line: 7, verified: false,
      lastEntry: { locationKind: 'last-entry', taskId: 'task_diagnostics', seq: 1,
        entryHash: bundle.entries[1].entryHash, line: 5, index: 1, verified: false } });
    bundle.checkpoint.actor.payload.count++;
    expect(verifyAudit(parseJsonl(jsonl(bundle))).reason).toMatch(/^Error: checkpoint;/);
  });

  it('reports only the physical line for unreadable JSON, also through JsonlStore', () => {
    const text = '\n' + JSON.stringify({ entry: fixture().entries[0] })
      + '\n\n{"entry":{"body":{"taskId":"do-not-infer","payload":"acp-invite:do-not-print"';
    const error = parseError(text);
    expect(error).toBeInstanceOf(SyntaxError);
    expect(location(error.message)).toEqual({ line: 4, verified: false });
    expect(error.message).not.toMatch(/do-not-infer|do-not-print|acp-invite/);
    const path = join(directory(), 'broken.jsonl');
    writeFileSync(path, text);
    expect(() => new JsonlStore(path).read()).toThrow(error.message);
  });

  it('bounds and escapes identifiers, redacts invitation material, and omits non-scalar fields', () => {
    const entry = fixture().entries[0];
    entry.body.taskId = 'task_\x1b\n\u009b\u202e' + 'x'.repeat(1000);
    entry.entryHash = 'https://example.test/#acp-invite:do-not-print';
    const error = parseError(JSON.stringify({ entry }));
    expect(error.message).not.toMatch(/[\x1b\n\u009b\u202e]/);
    expect(error.message).toContain('\\u202e');
    expect(error.message.length).toBeLessThan(500);
    expect(location(error.message)).toMatchObject({ entryHash: '[redacted]' });
    expect(error.message).not.toContain('do-not-print');
    const malformed = { entry: { body: { taskId: { payload: 'do-not-print' }, seq: 'do-not-print' }, entryHash: [] } };
    expect(location(parseError(JSON.stringify(malformed)).message)).toEqual({
      locationKind: 'last-entry', line: 1, verified: false,
    });
    expect(verifyAudit({ entries: [null], checkpoint: fixture().checkpoint } as unknown as AuditBundle).valid).toBe(false);
  });

  it('keeps the physical line even when an entry value has no object fields', () => {
    const bundle = fixture();
    bundle.checkpoint.actor.payload.count = 1;
    // A primitive entry cannot supply identifiers; verification still knows its source line.
    const text = '\n{"entry":true}\n' + JSON.stringify({ checkpoint: bundle.checkpoint });
    const parsed = parseJsonl(text);
    // The unchanged checkpoint checks run before entry schema checks.
    const result = verifyAudit(parsed);
    expect(result.valid).toBe(false);
    expect(location(result.reason!)).toMatchObject({ locationKind: 'checkpoint', line: 3,
      lastEntry: { locationKind: 'last-entry', line: 2, index: 0, verified: false } });
  });

  it('keeps valid JSONL and JSON bundle output and serialization unchanged', async () => {
    const bundle = fixture(), text = jsonl(bundle), parsed = parseJsonl(text);
    expect(parsed).toEqual(bundle);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(bundle));
    const dir = directory();
    for (const [filename, content] of [['audit.jsonl', text], ['bundle.json', JSON.stringify(bundle)]]) {
      const path = join(dir, filename);
      writeFileSync(path, content);
      const result = await cli(path);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual(verifyAudit(bundle));
      const anchored = await cli(path, '--expect-entry-count', '2', '--expect-final-state', 'ACCEPT',
        '--expect-last-hash', bundle.entries[1].entryHash);
      expect(anchored.code).toBe(0);
      expect(JSON.parse(anchored.stdout)).toMatchObject({ valid: true, status: 'VALID',
        trustAnchorVerified: true, truncationChecked: true });
    }
  });

  it('keeps CLI invalid status/exit codes while including locations and suppressing unreadable input', async () => {
    const dir = directory(), bundle = fixture();
    bundle.entries[0].body.payload = { changed: true };
    const path = join(dir, 'invalid.jsonl');
    writeFileSync(path, jsonl(bundle));
    const result = await cli(path);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('');
    expect(location(JSON.parse(result.stdout).reason)).toMatchObject({ seq: 0, line: 3 });
    const anchorFailure = await cli(path, '--expect-entry-count', '99');
    expect(anchorFailure.code).toBe(1);
    const rejected = JSON.parse(anchorFailure.stdout);
    expect(rejected).toMatchObject({ valid: false, status: 'INVALID', truncationChecked: true });
    expect(rejected.reason).toMatch(/^Error: trust anchor;/);
    expect(location(rejected.reason)).toMatchObject({ locationKind: 'checkpoint', line: 7 });
    for (const extension of ['jsonl', 'json']) {
      const broken = join(dir, 'broken.' + extension);
      writeFileSync(broken, '{"payload":"acp-invite:do-not-print"');
      const invalid = await cli(broken);
      expect(invalid.code).toBe(1);
      expect(invalid.stdout).toBe('');
      expect(invalid.stderr).toContain('SyntaxError: Invalid JSON');
      expect(invalid.stderr).not.toMatch(/acp-invite|do-not-print/);
    }
    const anchor = join(dir, 'anchor.json');
    writeFileSync(anchor, '{"payload":"acp-invite:do-not-print"');
    const malformedAnchor = await cli(path, anchor);
    expect(malformedAnchor.code).toBe(1);
    expect(malformedAnchor.stderr).toContain('SyntaxError: Invalid JSON');
    expect(malformedAnchor.stderr).not.toMatch(/acp-invite|do-not-print/);
  });

  it('seals the default interrupted approval while retaining diagnostics for legacy PROPOSE-only evidence (#194)', async () => {
    // In-process relay and simulated owner input; no remote relay or real owner prompt.
    const dir = directory(), path = join(dir, 'worker.jsonl');
    const owner = generateKeyPair(), requester = generateKeyPair(), relay = new InMemoryRelay();
    const input = new PassThrough();
    let prompted!: () => void, rejected!: () => void, executions = 0;
    const prompt = new Promise<void>(resolve => { prompted = resolve; });
    const rejection = new Promise<void>(resolve => { rejected = resolve; });
    const human = new InteractiveCliApprovalProvider(owner, { input, output: new Writable({
      write(chunk, _encoding, callback) {
        if (String(chunk).includes('Approve [y/N]?')) prompted();
        callback();
      },
    }) });
    const worker = new WorkerNode({ owner, relay, relayUrl: 'https://relay.example', auditPath: path,
      inboxPath: join(dir, 'inbox.jsonl'), identityOptions: { env: { SEALBRIDGE_DATA_DIR: join(dir, 'identity') } },
      heldReview: new HeldRequestReview(owner, { env: { SEALBRIDGE_DATA_DIR: join(dir, 'identity') },
        provider: cliTaskInspection(() => {}) }),
      timeoutMs: 2000, approvalProvider: new PolicyAutoApprovalProvider(owner), ownerApprovalProvider: human,
      onEvent: event => { if (event === 'INTERRUPTED') rejected(); },
      adapter: { id: 'echo', name: 'echo', skills: [], executeTask: async context => { executions++; return context.input; } },
    });
    const client = new RequesterClient({ owner: requester, relay, timeoutMs: 5000,
      approvalProvider: new PolicyAutoApprovalProvider(requester) });
    const controller = new AbortController(), running = worker.start();
    const attempt = client.delegate({ to: worker.invite(), title: 'Interrupted audit test',
      description: 'Requester leaves during approval', input: {}, signal: controller.signal })
      .then(() => 'unexpected completion', error => String(error));
    try {
      await prompt;
      const prefix = readFileSync(path, 'utf8');
      const entry = JSON.parse(prefix.trim()).entry;
      expect(entry.body).toMatchObject({ eventType: 'PROPOSE', seq: 0 });
      controller.abort(new Error('REQUESTER_EXITED_TEST'));
      expect(await attempt).toContain('REQUESTER_EXITED_TEST');
      input.write('y\n');
      await rejection;
      expect(executions).toBe(0);
      const sealed = readFileSync(path, 'utf8');
      expect(sealed.startsWith(prefix)).toBe(true);
      const bundle = parseAuditJsonl(sealed) as InterruptedAuditBundle;
      expect(bundle.interruption.payload).toMatchObject({ taskId: entry.body.taskId,
        phase: 'ACCEPT_ACK_WAIT', reason: 'SESSION_TIMEOUT' });
      // Historical unsealed evidence still identifies its last entry without backfill.
      const error = parseError(prefix);
      expect(error.message).toMatch(/^MISSING_OR_MISPLACED_CHECKPOINT;/);
      expect(location(error.message)).toEqual({ locationKind: 'last-entry', taskId: entry.body.taskId,
        seq: 0, entryHash: entry.entryHash, line: 1, verified: false });
      const result = await cli(path);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ valid: false, status: 'UNILATERALLY_CLOSED',
        reason: 'WORKER_ONLY_INTERRUPTION', prefixVerified: true, terminalSignatureVerified: true });
      expect(result.stderr).toBe('');
    } finally {
      controller.abort();
      input.end();
      worker.stop();
      await Promise.allSettled([running, attempt]);
      input.destroy();
    }
  });
});
