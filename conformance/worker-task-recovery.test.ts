// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelayAuthToken, generateKeyPair, openEnvelope } from '../packages/core/src/index.js';
import type { SignedEnvelope } from '../packages/core/src/index.js';
import { verifyAudit } from '../packages/ledger/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import type { RelayTransport } from '../packages/relay/src/index.js';
import { buildTaskManifest, PolicyAutoApprovalProvider, RequesterClient, WorkerNode } from '../packages/runtime/src/index.js';
import type { AgentAdapter, WorkerNodeOptions } from '../packages/runtime/src/index.js';
import type { TaskCheckpoint } from '../packages/runtime/src/task-journal.js';

const dirs: string[] = [];
const workers: WorkerNode[] = [];
const runs: Promise<unknown>[] = [];
const requests: AbortController[] = [];
function track<T>(run: Promise<T>): Promise<T> {
  runs.push(run);
  void run.catch(() => undefined);
  return run;
}
function event() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function reason(error: unknown) {
  return { code: (error as { code?: unknown } | null)?.code,
    message: error instanceof Error ? error.message : String(error) };
}
function outcome<T>(run: Promise<T>) {
  return run.then(value => ({ status: 'fulfilled' as const, value }),
    error => ({ status: 'rejected' as const, reason: reason(error) }));
}
function untilEvent(ready: Promise<void>, worker: Promise<unknown>, requester: Promise<unknown>) {
  const ended = (side: string, run: Promise<unknown>) => outcome(run).then(result => {
    throw new Error(`${side} terminated before tool readiness: ${JSON.stringify(result)}`);
  });
  return Promise.race([ready, ended('worker', worker), ended('requester', requester)]);
}
afterEach(async () => {
  workers.splice(0).forEach((worker) => worker.stop());
  requests.splice(0).forEach(controller => controller.abort('TEST_CLEANUP'));
  await Promise.allSettled(runs.splice(0));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(persistence: 'both' | 'audit' | 'inbox' = 'both', holdTool = false) {
  const dir = await mkdtemp(join(tmpdir(), 'acp-task-recovery-'));
  dirs.push(dir);
  const owner = generateKeyPair(), requester = generateKeyPair();
  const base = new InMemoryRelay();
  const replay: SignedEnvelope[] = [];
  const frames: SignedEnvelope[] = [];
  const acknowledgements: string[] = [];
  const acknowledgedPhases: string[] = [];
  const relay: RelayTransport = {
    send: (envelope) => { frames.push(envelope); return base.send(envelope); },
    receive: (did, _waitMs, signal, filter) => {
      if (did === owner.did && replay.length) return replay.shift();
      return base.receive(did, undefined, signal, undefined, filter);
    },
    acknowledgeDelivery: async (did, id) => {
      if (did === owner.did && frames.some((frame) => frame.payload.envelopeId === id && frame.payload.eventType === 'PROPOSE')) {
        const text = readFileSync(journalPath, 'utf8');
        const last = text.slice(0, text.lastIndexOf('\n')).split('\n').at(-1)!;
        acknowledgedPhases.push(JSON.parse(last).payload.phase);
      }
      acknowledgements.push(id);
      base.acknowledge(did, id, createRelayAuthToken(did === owner.did ? owner : requester));
    },
  };
  const inboxPath = persistence === 'audit' ? undefined : join(dir, 'inbox.jsonl');
  const auditPath = persistence === 'inbox' ? undefined : join(dir, 'audit.jsonl');
  const journalPath = (inboxPath ?? auditPath)! + '.tasks.jsonl';
  const toolEntered = event();
  let executions = 0, toolCalls = 0;
  const adapter: AgentAdapter = { id: 'recovery', name: 'recovery', skills: [], executeTask: async (ctx) => {
    executions++;
    return ctx.input;
  } };
  function worker(executeTask = adapter.executeTask, onEvent?: WorkerNodeOptions['onEvent']) {
    const node = new WorkerNode({ checkPeer: () => 'trusted', owner, relay, inboxPath, auditPath, timeoutMs: 5000,
      approvalProvider: new PolicyAutoApprovalProvider(owner), adapter: { ...adapter, executeTask }, onEvent,
      tools: { echo: { resource: () => 'mcp://echo', readOnly: true } },
      toolBackend: { callTool: async () => {
        toolCalls++;
        toolEntered.resolve();
        if (holdTool) return new Promise(() => undefined);
        return { content: [{ type: 'text', text: 'called once' }] };
      } } });
    workers.push(node);
    return node;
  }
  const client = new RequesterClient({ owner: requester, relay, timeoutMs: 5000,
    approvalProvider: new PolicyAutoApprovalProvider(requester) });
  const manifest = buildTaskManifest({ ownerDid: requester.did, workerDid: owner.did,
    title: 'Recover task', description: 'Keep task outcomes visible across worker restarts',
    capabilities: [{ capabilityId: 'cap_echo', resource: 'mcp://echo', allowedTools: ['echo'],
      argConstraints: { type: 'object' }, maxInvocations: 1, expiresAt: new Date(Date.now() + 60000).toISOString() }] });
  const delegate = (node: WorkerNode, input = { ok: true }) => {
    const controller = new AbortController();
    requests.push(controller);
    return track(client.delegate({ to: node.invite(), signal: controller.signal,
      title: manifest.task.title, description: manifest.task.description, manifest, input }));
  };
  const start = (node: WorkerNode, options?: Parameters<WorkerNode['start']>[0]) => track(node.start(options));
  const runOnce = (node: WorkerNode) => track(node.runOnce());
  const checkpoints = async () => (await readFile(journalPath, 'utf8')).trim().split('\n')
    .map((line) => (JSON.parse(line) as { payload: TaskCheckpoint }).payload);
  return { dir, owner, requester, relay, frames, replay, acknowledgements, acknowledgedPhases, inboxPath, auditPath, journalPath,
    worker, start, runOnce, delegate, manifest, checkpoints, toolEntered, executions: () => executions, toolCalls: () => toolCalls };
}

describe('worker task recovery', () => {
  it.each(['both', 'audit', 'inbox'] as const)(
    'notifies the waiting requester after interrupted execution with %s persistence without repeating tool calls', async (persistence) => {
      const f = await fixture(persistence);
      const toolCompleted = event();
      let workspace = '';
      const first = f.worker(async (ctx) => {
        workspace = ctx.workspaceDir;
        dirs.push(workspace);
        await writeFile(join(workspace, 'partial.txt'), 'partial work');
        await ctx.callTool('echo', {});
        toolCompleted.resolve();
        return new Promise(() => undefined);
      });
      const firstRun = f.start(first, { once: true });
      const firstDone = outcome(firstRun);
      const requestRun = f.delegate(first);
      const requested = outcome(requestRun);
      await untilEvent(toolCompleted.promise, firstRun, requestRun);
      first.stop();
      await firstDone;
      const before = await f.checkpoints();
      expect(before.at(-1)?.phase).toBe('running');
      if (f.inboxPath) expect(f.acknowledgedPhases[0]).toBe('accepted');
      expect(before.at(-1)?.invocations).toEqual([{ id: f.manifest.taskId + ':0', tool: 'echo',
        argsDigest: expect.any(String), completed: true }]);
      expect(await readFile(join(workspace, 'partial.txt'), 'utf8')).toBe('partial work');
      const proposal = f.frames.find((frame) => frame.payload.eventType === 'PROPOSE')!;
      f.replay.push(proposal);
      const restarted = f.worker();
      const restartedDone = f.start(restarted, { once: true });
      const failure = await requested;
      expect(failure).toMatchObject({ status: 'rejected', reason: { code: 'TASK_INTERRUPTED' } });
      await restartedDone;
      expect(f.executions()).toBe(0);
      expect(f.toolCalls()).toBe(1);
      expect(f.acknowledgements).toContain(proposal.payload.envelopeId);
      const terminal = (await f.checkpoints()).at(-1)!;
      expect(terminal).toMatchObject({ phase: 'terminal', workspace, outcome: { code: 'TASK_INTERRUPTED' } });
      expect(await readFile(join(workspace, 'partial.txt'), 'utf8')).toBe('partial work');
      expect(f.frames.filter((frame) => frame.payload.senderDid === f.owner.did && frame.payload.eventType === 'ERROR')
        .map((frame) => openEnvelope(frame, f.requester))).toContainEqual(expect.objectContaining({ code: 'TASK_INTERRUPTED' }));
    });

  it('replays a settled outcome for a new proposal envelope with the same task id without executing again', async () => {
    const f = await fixture();
    const first = f.worker();
    const [result] = await Promise.all([f.delegate(first), f.start(first, { once: true })]);
    first.stop();
    const originalAudit = await readFile(f.auditPath!, 'utf8');
    // Default interruption stages add snapshots within a business phase.
    const phases = (await f.checkpoints()).map(record => record.phase);
    expect(phases.filter((phase, index) => index === 0 || phase !== phases[index - 1]))
      .toEqual(['received', 'accepted', 'running', 'delivered', 'terminal']);
    const workspace = (await f.checkpoints()).at(-1)!.workspace!;
    await expect(stat(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
    // A torn append must not hide the last complete terminal checkpoint.
    await appendFile(f.journalPath, '{"payload":');
    const restarted = f.worker();
    const [retried] = await Promise.all([f.delegate(restarted), f.runOnce(restarted)]);
    expect(retried.state).toBe('SETTLED');
    expect(retried.deliverable).toEqual(result.deliverable);
    expect(verifyAudit(retried.bundle).valid).toBe(true);
    expect(retried.bundle).toEqual(result.bundle);
    expect(f.executions()).toBe(1);
    expect(await readFile(f.auditPath!, 'utf8')).toBe(originalAudit);
    const proposals = f.frames.filter((frame) => frame.payload.eventType === 'PROPOSE');
    expect(proposals).toHaveLength(2);
    expect(proposals[0].payload.envelopeId).not.toBe(proposals[1].payload.envelopeId);
  });

  it('rejects changed input for a completed task id without returning its cached output', async () => {
    const f = await fixture();
    const first = f.worker();
    await Promise.all([f.delegate(first), f.start(first, { once: true })]);
    first.stop();
    const restarted = f.worker();
    const retried = f.delegate(restarted, { ok: false });
    const run = f.start(restarted, { once: true });
    await expect(retried).rejects.toMatchObject({ code: 'TASK_ID_CONFLICT' });
    await run;
    expect(f.executions()).toBe(1);
  });

  it('replays a cached audit larger than one relay envelope in signed parts', async () => {
    const f = await fixture();
    const output = { text: 'large cached deliverable '.repeat(5000) };
    const first = f.worker(async () => output);
    const [settled] = await Promise.all([f.delegate(first), f.start(first, { once: true })]);
    first.stop();
    const restarted = f.worker();
    const [replayed] = await Promise.all([f.delegate(restarted), f.start(restarted, { once: true })]);
    expect(replayed.deliverable).toEqual(output);
    expect(replayed.bundle).toEqual(settled.bundle);
    expect(verifyAudit(replayed.bundle).valid).toBe(true);
    expect(f.executions()).toBe(0);
    const parts = f.frames.filter((frame) => frame.payload.senderDid === f.owner.did && frame.payload.eventType === 'ERROR');
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((frame) => Buffer.byteLength(JSON.stringify(frame)) < 256 * 1024)).toBe(true);
  });

  it('reports an older intake-only inbox entry as interrupted instead of acknowledging and discarding it', async () => {
    const f = await fixture('inbox');
    await writeFile(f.inboxPath!, JSON.stringify({ taskId: f.manifest.taskId, requesterOwnerDid: f.requester.did }) + '\n');
    const worker = f.worker();
    const requested = f.delegate(worker);
    const run = f.start(worker, { once: true });
    await expect(requested).rejects.toMatchObject({ code: 'TASK_INTERRUPTED' });
    await run;
    expect(f.executions()).toBe(0);
  });

  it('notifies an already-acknowledged requester on startup without waiting for a proposal retry', async () => {
    const f = await fixture('both', true);
    let workspace = '';
    const first = f.worker(async (ctx) => {
      workspace = ctx.workspaceDir;
      dirs.push(workspace);
      return ctx.callTool('echo', {});
    });
    const firstRun = f.start(first, { once: true });
    const stopped = outcome(firstRun);
    const requestRun = f.delegate(first);
    const requested = outcome(requestRun);
    await untilEvent(f.toolEntered.promise, firstRun, requestRun);
    const proposal = f.frames.find((frame) => frame.payload.eventType === 'PROPOSE')!;
    expect(f.acknowledgements).toContain(proposal.payload.envelopeId);
    first.stop();
    await stopped;
    // Exercise repair of a torn append before writing the interrupted outcome.
    await appendFile(f.journalPath, '{"payload":');
    const restarted = f.worker();
    const run = f.start(restarted);
    try {
      expect(await requested).toMatchObject({ status: 'rejected', reason: { code: 'TASK_INTERRUPTED' } });
      const record = (await f.checkpoints()).at(-1)!;
      expect(record.invocations).toEqual([{ id: f.manifest.taskId + ':0', tool: 'echo',
        argsDigest: expect.any(String), completed: false }]);
      expect(record.outcome?.code).toBe('TASK_INTERRUPTED');
      expect(f.toolCalls()).toBe(1);
      expect(f.executions()).toBe(0);
      expect((await stat(workspace)).isDirectory()).toBe(true);
    } finally { restarted.stop(); await run; }
  });

  it('restores a sealed delivery when the final task checkpoint was interrupted', async () => {
    const f = await fixture();
    const first = f.worker();
    const [settled] = await Promise.all([f.delegate(first), f.start(first, { once: true })]);
    first.stop();
    const lines = (await readFile(f.journalPath, 'utf8')).trim().split('\n');
    const delivered = lines.findIndex((line) => JSON.parse(line).payload.phase === 'delivered');
    // Model a stop after the bilateral audit was sealed and before terminal journaling.
    await writeFile(f.journalPath, lines.slice(0, delivered + 1).join('\n') + '\n');
    const restarted = f.worker();
    const [recovered] = await Promise.all([f.delegate(restarted), f.start(restarted, { once: true })]);
    expect(recovered.state).toBe('SETTLED');
    expect(recovered.deliverable).toEqual(settled.deliverable);
    expect(verifyAudit(recovered.bundle).valid).toBe(true);
    expect(f.executions()).toBe(1);
    expect((await f.checkpoints()).at(-1)?.outcome?.code).toBe('TASK_SETTLED');
  });

  it.each(['ACCEPT', 'DELIVER'] as const)('reports an interruption after %s without repeating execution', async (event) => {
    const f = await fixture();
    const first = f.worker(undefined, (next) => { if (next === event) first.stop(); });
    const firstRun = f.start(first, { once: true });
    const stopped = outcome(firstRun);
    const requestRun = f.delegate(first);
    const requested = outcome(requestRun);
    await stopped;
    const record = (await f.checkpoints()).at(-1)!;
    expect(record.phase).toBe(event === 'ACCEPT' ? 'accepted' : 'delivered');
    if (record.workspace) dirs.push(record.workspace);
    const restarted = f.worker();
    const run = f.start(restarted);
    try {
      expect(await requested).toMatchObject({ status: 'rejected', reason: { code: 'TASK_INTERRUPTED' } });
      expect(f.executions()).toBe(event === 'ACCEPT' ? 0 : 1);
    } finally { restarted.stop(); await run; }
  });

  it('keeps a pending interrupted outcome when notification fails and retries it on the next startup', async () => {
    const f = await fixture();
    const toolCompleted = event();
    let workspace = '';
    const first = f.worker(async (ctx) => {
      workspace = ctx.workspaceDir;
      dirs.push(workspace);
      await ctx.callTool('echo', {});
      toolCompleted.resolve();
      return new Promise(() => undefined);
    });
    const firstRun = f.start(first, { once: true });
    const stopped = outcome(firstRun);
    const requestRun = f.delegate(first);
    const requested = outcome(requestRun);
    await untilEvent(toolCompleted.promise, firstRun, requestRun);
    first.stop();
    await stopped;
    const send = f.relay.send;
    let failOnce = true;
    f.relay.send = (envelope) => {
      if (failOnce && envelope.payload.senderDid === f.owner.did && envelope.payload.eventType === 'ERROR') {
        failOnce = false;
        throw new Error('LOCAL_RELAY_UNAVAILABLE');
      }
      return send(envelope);
    };
    const restarted = f.worker();
    await expect(f.start(restarted)).rejects.toThrow('LOCAL_RELAY_UNAVAILABLE');
    expect((await f.checkpoints()).at(-1)).toMatchObject({ notificationPending: true,
      outcome: { code: 'TASK_INTERRUPTED' } });
    const recovered = f.worker();
    const run = f.start(recovered);
    try {
      expect(await requested).toMatchObject({ status: 'rejected', reason: { code: 'TASK_INTERRUPTED' } });
      expect((await f.checkpoints()).at(-1)?.notificationPending).toBe(false);
      expect(f.toolCalls()).toBe(1);
      expect(f.executions()).toBe(0);
    } finally { recovered.stop(); await run; }
  });
});
