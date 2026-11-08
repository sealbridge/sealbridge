// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { SignedEnvelope } from '../packages/core/src/index.js';
import { generateKeyPair } from '../packages/core/src/index.js';
import { parseJsonl, verifyAudit } from '../packages/ledger/src/index.js';
import { HeldRequestReview, InteractiveCliApprovalProvider, PeerRejectedError, PolicyAutoApprovalProvider, RequesterClient, WorkerNode } from '../packages/runtime/src/index.js';
import { DeliveryStore } from '../packages/runtime/src/delivery-store.js';
import type { TaskCheckpoint } from '../packages/runtime/src/task-journal.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { formatCliError, japaneseErrorReason } from '../cli/src/error-messages.js';
import { cliTaskInspection } from '../cli/src/task-review.js';
import { tasksCommand } from '../cli/src/tasks.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function directory() { const dir = mkdtempSync(join(tmpdir(), 'outbox-busy-after-interrupt-')); dirs.push(dir); return dir; }
function journal(path: string): TaskCheckpoint[] {
  try { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).payload); }
  catch { return []; }
}
function queued(relay: InMemoryRelay, did: string): SignedEnvelope[] {
  const queues = (relay as unknown as { queues: Map<string, { envelope: SignedEnvelope }[]> }).queues;
  return [...(queues.get(did) ?? [])].map(item => item.envelope);
}
async function waitFor(label: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('WAIT_TIMEOUT: ' + label);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
function liveFixture(auditInterruptionFormat?: 1) {
  const dir = directory(), path = join(dir, 'worker.jsonl'), inbox = join(dir, 'inbox.jsonl');
  const owner = generateKeyPair(), requester = generateKeyPair(), relay = new InMemoryRelay();
  const input = new PassThrough();
  let pending: (() => void) | undefined, queuedPrompts = 0;
  const human = new InteractiveCliApprovalProvider(owner, { input, output: new Writable({ write(chunk, _enc, cb) {
    if (String(chunk).includes('Approve [y/N]?')) {
      if (pending) { const resolve = pending; pending = undefined; resolve(); }
      else queuedPrompts += 1;
    }
    cb();
  } }) });
  const identityOptions = { env: { SEALBRIDGE_DATA_DIR: join(dir, 'identity') } };
  const review = new HeldRequestReview(owner, { ...identityOptions, provider: cliTaskInspection(() => {}) });
  const events: { event: string; taskId: string; code?: string }[] = [];
  const worker = new WorkerNode({ owner, relay, relayUrl: 'https://relay.example', auditPath: path, inboxPath: inbox,
    ...(auditInterruptionFormat ? { auditInterruptionFormat } : {}),
    taskTimeoutMs: 120_000, waitTimeoutMs: 120_000, identityOptions, heldReview: review,
    deliveryOptions: { identityOptions, resolveTransport: () => relay },
    approvalProvider: new PolicyAutoApprovalProvider(owner), ownerApprovalProvider: human,
    onEvent: (name, taskId, error) => { events.push({ event: name, taskId, code: error?.code }); },
    adapter: { id: 'echo', name: 'echo', skills: [], executeTask: async ctx => ctx.input } });
  const client = new RequesterClient({ owner: requester, relay, taskTimeoutMs: 30_000, waitTimeoutMs: 30_000,
    executionTimeoutMs: 20_000, approvalProvider: new PolicyAutoApprovalProvider(requester) });
  return { dir, path, journalPath: inbox + '.tasks.jsonl', owner, requester, relay, input, review, identityOptions, worker, client, events,
    prompt: () => {
      if (queuedPrompts > 0) { queuedPrompts -= 1; return Promise.resolve(); }
      return new Promise<void>(resolve => { pending = resolve; });
    } };
}

describe('outbox busy after an interrupted approval (#210)', () => {
  it('names OUTBOX_STORE_BUSY for the owner and the requester', () => {
    const reason = japaneseErrorReason('OUTBOX_STORE_BUSY');
    expect(reason).toContain('outbox');
    expect(reason).toContain('ください');
    const rendered = formatCliError(new PeerRejectedError({ code: 'OUTBOX_STORE_BUSY' }));
    expect(rendered).toContain('OUTBOX_STORE_BUSY');
    expect(rendered).toContain('proposal envelope is not invalid');
    expect(rendered).toContain(reason);
  });

  it.each([undefined, 1] as const)('settles the next task in the same session after tasks approve (auditInterruptionFormat=%s)', async format => {
    const f = liveFixture(format), controller = new AbortController();
    await f.worker.startDelivery();
    const running = f.worker.start();
    const task = { to: f.worker.invite(), title: 'Echo test', description: 'hello world', input: { hello: 'world' } };
    const first = f.client.delegate({ ...task, signal: controller.signal }).then(() => 'unexpected', error => String(error));
    try {
      await f.prompt();
      controller.abort(new Error('REQUESTER_EXITED_TEST'));
      expect(await first).toContain('REQUESTER_EXITED_TEST');
      f.input.write('y\n');
      const taskId = JSON.parse(readFileSync(f.path, 'utf8').trim().split('\n')[0]).entry.body.taskId as string;
      await waitFor('accepted', () => journal(f.journalPath).some(record => record.taskId === taskId && record.phase === 'accepted'));
      await waitFor('accept-frame', () => queued(f.relay, f.requester.did).some(envelope => envelope.payload.eventType === 'ACCEPT' && envelope.payload.taskId === taskId));
      const acceptId = queued(f.relay, f.requester.did).find(envelope => envelope.payload.eventType === 'ACCEPT' && envelope.payload.taskId === taskId)!.payload.envelopeId;
      await waitFor('accept-released', () => !f.worker.deliveryService!.store.ids('outbox').includes(acceptId));
      await f.worker.deliveryService!.prepare();
      const before = f.worker.deliveryService!.store.ids('outbox');
      const key = join(f.dir, 'worker.private.json');
      writeFileSync(key, JSON.stringify(f.owner), { mode: 0o600 });
      const output: string[] = [];
      const heldId = f.review.list().find(record => record.taskId === taskId)!.id;
      await tasksCommand(['approve', heldId, '--key', key], { identityOptions: f.identityOptions, review: async () => true, output: line => output.push(line) });
      expect(JSON.parse(output.at(-1)!)).toMatchObject({ decision: 'approve', executed: false, requiresFreshTask: true });
      expect(f.worker.deliveryService!.store.ids('outbox').some(id => !before.includes(id))).toBe(true);
      const fresh = f.client.delegate(task);
      await f.prompt();
      f.input.write('y\n');
      const settled = await fresh;
      expect(settled.state).toBe('SETTLED');
      expect(settled.deliverable).toEqual({ hello: 'world' });
      expect(f.events.filter(event => event.taskId === settled.taskId && (event.code === 'INVALID_PROPOSAL_ENVELOPE' || event.code === 'OUTBOX_STORE_BUSY'))).toEqual([]);
      expect(journal(f.journalPath).some(record => record.taskId === settled.taskId && record.outcome?.code === 'OUTBOX_STORE_BUSY')).toBe(false);
      // #194 remains: tasks approve does not seal the interrupted PROPOSE, and the next chain stays on its sidecar.
      const main = readFileSync(f.path, 'utf8');
      expect(main.trim().split('\n')).toHaveLength(1);
      const sidecar = f.path.replace(/(?:\.jsonl)?$/, '.' + settled.taskId + '.jsonl');
      expect(verifyAudit(parseJsonl(readFileSync(sidecar, 'utf8'))).valid).toBe(true);
      expect(readFileSync(f.path, 'utf8')).toBe(main);
    } finally {
      controller.abort();
      f.input.end();
      f.worker.stopDelivery();
      f.worker.stop();
      await Promise.allSettled([running, first]);
      f.input.destroy();
    }
  }, 60_000);

  it('returns OUTBOX_STORE_BUSY to the owner and the requester when the outbox stays busy', async () => {
    const f = liveFixture();
    await f.worker.startDelivery();
    const running = f.worker.start();
    const summaries = vi.spyOn(DeliveryStore.prototype as unknown as { summaries(): unknown }, 'summaries')
      .mockImplementation(() => { throw Object.assign(new Error('OUTBOX_STORE_BUSY'), { code: 'OUTBOX_STORE_BUSY' }); });
    const attempt = f.client.delegate({ to: f.worker.invite(), title: 'Echo test', description: 'wedged outbox', input: { hello: 'world' } })
      .then(() => 'unexpected', error => String(error));
    try {
      const text = await attempt;
      expect(text).toContain('OUTBOX_STORE_BUSY');
      expect(text).not.toContain('INVALID_PROPOSAL_ENVELOPE');
      expect(f.events.some(event => event.code === 'OUTBOX_STORE_BUSY')).toBe(true);
      expect(f.events.some(event => event.code === 'INVALID_PROPOSAL_ENVELOPE')).toBe(false);
    } finally {
      summaries.mockRestore();
      f.input.end();
      f.worker.stopDelivery();
      f.worker.stop();
      await Promise.allSettled([running, attempt]);
      f.input.destroy();
    }
  }, 60_000);
});
