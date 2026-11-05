// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { WorkerNodeOptions } from '../packages/runtime/src/session.js';
const captured = vi.hoisted(() => ({ worker: undefined as WorkerNodeOptions | undefined,
  input: undefined as PassThrough | undefined, answers: [] as string[], displays: [] as string[] }));
vi.mock('../packages/runtime/dist/index.js', async original => {
  const runtime = await original<typeof import('../packages/runtime/src/index.js')>();
  return { ...runtime,
    WorkerNode: class extends runtime.WorkerNode {
      constructor(options: WorkerNodeOptions) { super(options); captured.worker = options; }
      override async start() { return undefined; }
    },
    InteractiveCliApprovalProvider: class extends runtime.InteractiveCliApprovalProvider {
      constructor(owner: ConstructorParameters<typeof runtime.InteractiveCliApprovalProvider>[0],
        options: ConstructorParameters<typeof runtime.InteractiveCliApprovalProvider>[1]) {
        super(owner, captured.input ? { ...options, input: captured.input, output: new Writable({ write(chunk, _encoding, callback) {
          captured.displays.push(String(chunk)); callback();
          if (String(chunk).includes('Approve [y/N]?')) setImmediate(() => captured.input!.write((captured.answers.shift() ?? 'n') + '\n'));
        } }) } : options);
      }
    },
  };
});
import { WorkerNode, RequesterClient, PolicyAutoApprovalProvider, HeldRequestReview } from '../packages/runtime/src/index.js';
import { digest, signEnvelope, signPayload } from '../packages/core/src/index.js';
import { tasksCommand } from '../cli/src/tasks.js';
import { networkCommand } from '../cli/src/network.js';
import { cliTaskInspection } from '../cli/src/task-review.js';
import { formatCliError } from '../cli/src/error-messages.js';
import { connectionsCommand } from '../cli/src/connections.js';
import { admissionFixture } from './connections-fixture.js';

const cleanups: Array<() => void> = [];
function tty(enabled: boolean) {
  for (const stream of [process.stdin, process.stderr]) {
    const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY');
    Object.defineProperty(stream, 'isTTY', { configurable: true, value: enabled });
    cleanups.push(() => { if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor); else delete (stream as { isTTY?: boolean }).isTTY; });
  }
}
function fixture() {
  const f = admissionFixture(); cleanups.push(f.cleanup);
  const key = join(f.root, 'worker.private.json'); writeFileSync(key, JSON.stringify(f.owner), { mode: 0o600 });
  return { ...f, key };
}
beforeEach(() => {
  captured.worker = undefined; captured.input = undefined; captured.answers = []; captured.displays = [];
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network access'); }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

it('lists individual held IDs while intake coalesces per peer, and displays literal validated content', async () => {
  const f = fixture(); f.task.input.content = '\x1b[31m literal \u009b \u202e';
  await expect(f.raw()).rejects.toThrow('PENDING_OWNER_APPROVAL');
  await expect(f.raw()).rejects.toThrow('PENDING_OWNER_APPROVAL');
  expect(f.store.list()).toHaveLength(1);
  const output = vi.fn();
  const options = { identityOptions: f.identityOptions, output };
  await tasksCommand(['list', '--key', f.key], options);
  const rows = JSON.parse(output.mock.calls[0][0]).tasks;
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    output.mockClear();
    await tasksCommand(['show', row.taskId, '--key', f.key], options);
    const text = output.mock.calls[0][0];
    expect(text).toContain('\\u001b'); expect(text).toContain('\\u009b'); expect(text).toContain('\\u202e');
    expect(text).not.toMatch(/[\x1b\u009b\u202e]/);
    expect(JSON.parse(text)).toMatchObject({ heldId: row.id, manifest: { taskId: row.taskId }, input: f.task.input });
    expect(f.review.store.read(row.id)?.inspectionReceipt?.payload).toMatchObject({ status: 'complete', v: 1 });
  }
  expect(f.execute).not.toHaveBeenCalled(); expect(f.store.list()).toHaveLength(1);
});

it.each(['approve', 'reject'])('per-task %s closes only the selected attempt with explicit confirmation, without a durable grant', async action => {
  const f = fixture();
  await expect(f.raw()).rejects.toThrow('PENDING_OWNER_APPROVAL');
  await expect(f.raw()).rejects.toThrow('PENDING_OWNER_APPROVAL');
  const held = f.review.list(), intakeBefore = f.store.list();
  const output = vi.fn(), review = vi.fn(async () => true);
  await tasksCommand([action, held[1].id, '--key', f.key], { identityOptions: f.identityOptions, output, review });
  expect(review).toHaveBeenCalledOnce();
  expect(review.mock.invocationCallOrder[0]).toBeGreaterThan(output.mock.invocationCallOrder[0]);
  expect(f.review.list()).toMatchObject([{ id: held[0].id }]);
  expect(f.store.list()).toEqual(intakeBefore);
  expect(f.store.connectionLevel(f.requester.did)).toBe('unknown');
  expect(f.store.hasExplicitLegacyGrant(f.requester.did)).toBe(false);
  expect(JSON.parse(output.mock.calls.at(-1)![0])).toMatchObject({ decision: action, executed: false });
  expect(f.execute).not.toHaveBeenCalled();
});

it.each(['approve', 'reject'])('per-task %s refuses non-interactive decisions and rejected confirmation without closing content', async action => {
  tty(false); const f = fixture();
  await expect(f.raw()).rejects.toThrow('PENDING_OWNER_APPROVAL');
  const held = f.review.list()[0], options = { identityOptions: f.identityOptions, output: vi.fn() };
  await expect(tasksCommand([action, held.id, '--key', f.key], options)).rejects.toThrow('APPROVAL_CHANNEL_UNAVAILABLE');
  await expect(tasksCommand([action, held.id, '--key', f.key], { ...options, review: async () => false })).rejects.toThrow('APPROVAL_REJECTED');
  expect(f.review.list()).toHaveLength(1); expect(f.execute).not.toHaveBeenCalled();
  await expect(tasksCommand([action, held.id, '--key', f.key, '--yes'], options)).rejects.toThrow('INVALID_TASK_REVIEW_OPTION');
});

it('does not record display completion on output failure or invalid task content', async () => {
  const f = fixture(); await expect(f.raw()).rejects.toThrow('PENDING_OWNER_APPROVAL');
  const held = f.review.list()[0];
  const failed = new HeldRequestReview(f.owner, { ...f.identityOptions, provider: cliTaskInspection(() => { throw new Error('Output closed'); }) });
  expect((await failed.inspect(held.id)).inspectionStatus).toBe('error');
  const m = f.manifest(), body = { proposal: signPayload({ ...m, worker: { ownerDid: f.requester.did, agentDid: f.requester.did } }, f.requester), input: f.task.input };
  const envelope = signEnvelope({ taskId: m.taskId, recipientDid: f.owner.did, seq: 0, eventType: 'PROPOSE', payload: body as never }, f.requester, { encrypt: true });
  const output = vi.fn(), review = new HeldRequestReview(f.owner, { ...f.identityOptions, provider: cliTaskInspection(output) });
  const invalid = review.hold({ kind: 'task', taskId: m.taskId, senderOwnerDid: f.requester.did,
    contentDigest: digest({ manifest: body.proposal.payload, input: body.input }), deadline: Date.parse(m.deadline), envelope });
  expect((await review.inspect(invalid.id)).inspectionStatus).toBe('error'); expect(output).not.toHaveBeenCalled();
});

it('distinguishes an incomplete inspection gate from missing connection consent in requester errors', async () => {
  const f = fixture();
  const uninspected = await f.attempt(f.worker.invite());
  expect(uninspected[0].status).toBe('rejected');
  if (uninspected[0].status === 'rejected') expect(JSON.parse(formatCliError(uninspected[0].reason)).nextStep)
    .toContain('Task inspection is incomplete; connection consent alone does not approve execution.');
  const g = fixture();
  const review = new HeldRequestReview(g.owner, { ...g.identityOptions, provider: cliTaskInspection(() => {}) });
  const worker = new WorkerNode({ ...g.worker.options, heldReview: review });
  cleanups.push(() => worker.stop());
  const client = new RequesterClient({ owner: g.requester, relay: g.relay, approvalProvider: new PolicyAutoApprovalProvider(g.requester) });
  await worker.register();
  const [request] = await Promise.allSettled([client.delegate({ ...g.task, to: g.owner.did }), worker.runOnce()]);
  expect(request.status).toBe('rejected');
  if (request.status === 'rejected') expect(JSON.parse(formatCliError(request.reason)).nextStep)
    .toContain('Connection consent is missing; task inspection and live approval remain separate.');
});

async function cliWorker(f: ReturnType<typeof fixture>, interactive: boolean, answers = ['y']) {
  tty(interactive);
  captured.input = new PassThrough(); captured.answers = answers;
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown, callback?: unknown) => {
    captured.displays.push(String(chunk)); if (typeof callback === 'function') callback(); return true;
  }) as typeof process.stderr.write);
  await networkCommand('worker', ['start', '--key', f.key, '--adapter', 'sandbox', '--auto-accept',
    '--relay', 'https://relay.example', '--contacts', join(f.root, 'contacts.json')], { identityOptions: f.identityOptions });
  const worker = new WorkerNode({ ...captured.worker!, intakeStore: f.store, connectionStore: f.store, relay: f.relay, deliveryOptions: { identityOptions: f.identityOptions, resolveTransport: () => f.relay }, adapter: f.worker.options.adapter });
  cleanups.push(() => worker.stop()); return worker;
}

it('completes the first invite task through standalone CLI wiring and the existing live owner gate', async () => {
  const f = fixture(), worker = await cliWorker(f, true);
  const client = new RequesterClient({ owner: f.requester, relay: f.relay, approvalProvider: new PolicyAutoApprovalProvider(f.requester) });
  const [request, execution] = await Promise.allSettled([client.delegate({ ...f.task, to: worker.invite() }), worker.runOnce()]);
  expect(request.status === 'rejected' ? request.reason : request.value).toMatchObject({ state: 'SETTLED' });
  expect(execution.status).toBe('fulfilled'); expect(f.execute).toHaveBeenCalledOnce();
  expect(captured.displays.join('\n')).toContain('held content');
  expect(captured.displays.join('\n')).toContain('Approve [y/N]?');
});

it('serializes live prompts so each owner answer decides only one task', async () => {
  const f = fixture(); await cliWorker(f, true, ['n', 'y']);
  const provider = captured.worker!.ownerApprovalProvider!;
  const request = { gate: 'contract_acceptance' as const, target: {}, details: {} };
  const [first, second] = await Promise.all([
    provider.approve({ ...request, taskId: 'task_first' }),
    provider.approve({ ...request, taskId: 'task_second' }),
  ]);
  expect(first.payload.decision).toBe('REJECTED'); expect(second.payload.decision).toBe('APPROVED');
  expect(first.payload.taskId).toBe('task_first'); expect(second.payload.taskId).toBe('task_second');
});

it('keeps terminal attempts pending after held review and inspects/approves each fresh resubmit at the live gate', async () => {
  const f = fixture(), original = f.manifest();
  await expect(f.raw(original, f.worker.invite())).rejects.toThrow('PENDING_OWNER_APPROVAL');
  const held = f.review.list()[0];
  await tasksCommand(['approve', held.id, '--key', f.key], { identityOptions: f.identityOptions, output: vi.fn(), review: async () => true });
  const worker = await cliWorker(f, true, ['n', 'y']);
  await worker.register();
  // Old attempt stays terminal even after inspection/approval of its archived content.
  await expect(f.raw(original)).rejects.toThrow('PENDING_OWNER_APPROVAL');
  const client = new RequesterClient({ owner: f.requester, relay: f.relay, approvalProvider: new PolicyAutoApprovalProvider(f.requester) });
  const run = () => Promise.allSettled([client.delegate({ ...f.task, to: f.owner.did }), worker.runOnce()]);
  const rejected = await run(); expect(rejected[0].status).toBe('rejected'); expect(f.execute).not.toHaveBeenCalled();
  const accepted = await run(); expect(accepted[0].status).toBe('fulfilled'); expect(f.execute).toHaveBeenCalledOnce();
  expect(captured.displays.filter(s => s.includes('Approve [y/N]?'))).toHaveLength(2);
});

it('connection offer approval never authorizes a task; non-TTY CLI worker does not auto-approve', async () => {
  const f = fixture();
  await expect(f.raw()).rejects.toThrow('PENDING_OWNER_APPROVAL');
  const requesterKey = join(f.root, 'requester.private.json'); writeFileSync(requesterKey, JSON.stringify(f.requester), { mode: 0o600 });
  const options = { identityOptions: f.identityOptions, review: async () => true, transportFactory: () => f.relay, output: vi.fn() };
  await connectionsCommand(['request', '--to', f.owner.did, '--relay', 'https://relay.example', '--key', requesterKey], options);
  await connectionsCommand(['sync', '--once', '--relay', 'https://relay.example', '--key', f.key], options);
  const id = f.store.controlSnapshot().find(c => c.direction === 'incoming')!.offer.requestId;
  await connectionsCommand(['review', 'approve', id, '--key', f.key], options);
  expect(f.store.connectionState(f.requester.did)).toBe('connected');
  const interactive = await cliWorker(f, true, ['n']);
  await interactive.register();
  const client = new RequesterClient({ owner: f.requester, relay: f.relay, approvalProvider: new PolicyAutoApprovalProvider(f.requester) });
  const [denied] = await Promise.allSettled([client.delegate({ ...f.task, to: f.owner.did }), interactive.runOnce()]);
  expect(denied.status).toBe('rejected'); expect(f.execute).not.toHaveBeenCalled();
  expect(captured.displays.filter(s => s.includes('Approve [y/N]?'))).toHaveLength(1);
  captured.displays = [];
  const worker = await cliWorker(f, false), m = f.manifest();
  f.relay.send(signEnvelope({ taskId: m.taskId, recipientDid: f.owner.did, seq: 0, eventType: 'PROPOSE',
    payload: { proposal: signPayload(m, f.requester), input: f.task.input, capabilityChains: [] } as never }, f.requester, { encrypt: true }));
  await expect(worker.runOnce()).rejects.toThrow('PENDING_OWNER_APPROVAL');
  expect(captured.worker?.ownerApprovalProvider).toBeUndefined();
  expect(f.execute).not.toHaveBeenCalled(); expect(captured.displays.join('')).not.toContain('Approve [y/N]?');
});

it('lists no tasks without creating an identity', async () => {
  const f = fixture(), root = join(f.root, 'unused'), output = vi.fn();
  await tasksCommand(['list'], { identityOptions: { env: { SEALBRIDGE_DATA_DIR: root } }, output });
  expect(JSON.parse(output.mock.calls[0][0])).toEqual({ tasks: [] }); expect(existsSync(root)).toBe(false);
});
