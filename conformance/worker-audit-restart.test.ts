// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '../packages/core/src/index.js';
import { parseJsonl, verifyAudit } from '../packages/ledger/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { buildTaskManifest, PolicyAutoApprovalProvider, RequesterClient, WorkerNode } from '../packages/runtime/src/index.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(filename: string) {
  const dir = await mkdtemp(join(tmpdir(), 'acp-audit-restart-'));
  dirs.push(dir);
  const auditPath = join(dir, filename);
  const relay = new InMemoryRelay(), owner = generateKeyPair(), requester = generateKeyPair();
  let executions = 0;
  const createWorker = () => new WorkerNode({ checkPeer: () => 'trusted', owner, relay, auditPath, timeoutMs: 2000,
    approvalProvider: new PolicyAutoApprovalProvider(owner),
    adapter: { id: 'echo', name: 'echo', skills: [], executeTask: async (ctx) => {
      executions++; return ctx.input;
    } } });
  const client = new RequesterClient({ owner: requester, relay, timeoutMs: 2000,
    approvalProvider: new PolicyAutoApprovalProvider(requester) });
  const manifest = () => buildTaskManifest({ ownerDid: requester.did, workerDid: owner.did,
    title: 'Audit restart', description: 'Preserve earlier audit evidence after worker restart' });
  async function run(worker: WorkerNode, task = manifest()) {
    const pending = worker.start({ once: true });
    return Promise.allSettled([client.delegate({ to: worker.invite(), manifest: task,
      title: task.task.title, description: task.task.description, input: { ok: true } }), pending]);
  }
  return { auditPath, createWorker, run, manifest, executions: () => executions };
}

describe('worker audit paths after restart', () => {
  it.each(['worker.jsonl', 'worker-audit'])('preserves %s and settles new tasks into task-suffixed ledgers', async (filename) => {
    const f = await fixture(filename);
    const first = f.createWorker();
    const initial = await f.run(first);
    first.stop();
    expect(initial.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const original = await readFile(f.auditPath, 'utf8');
    expect(verifyAudit(parseJsonl(original)).valid).toBe(true);

    // A new WorkerNode resets its task counter, reproducing a process restart.
    const restarted = f.createWorker();
    try {
      for (let i = 0; i < 2; i++) {
        const task = f.manifest();
        const result = await f.run(restarted, task);
        expect(result.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
        const fallback = f.auditPath.replace(/(?:\.jsonl)?$/, '.' + task.taskId + '.jsonl');
        const bundle = parseJsonl(await readFile(fallback, 'utf8'));
        expect(verifyAudit(bundle, { taskId: task.taskId }).valid).toBe(true);
        expect(await readFile(f.auditPath, 'utf8')).toBe(original);
      }
      expect(f.executions()).toBe(3);
    } finally { restarted.stop(); }
  });

  it('still refuses an existing task-suffixed audit without overwriting either file', async () => {
    const f = await fixture('worker.jsonl');
    const task = f.manifest();
    const fallback = f.auditPath.replace(/(?:\.jsonl)?$/, '.' + task.taskId + '.jsonl');
    await writeFile(f.auditPath, 'original audit\n');
    await writeFile(fallback, 'existing task audit\n');
    const worker = f.createWorker();
    try {
      const result = await f.run(worker, task);
      expect(result.map((r) => r.status)).toEqual(['rejected', 'rejected']);
      if (result[1].status === 'rejected') expect(String(result[1].reason)).toContain('AUDIT_FILE_ALREADY_EXISTS');
      expect(await readFile(f.auditPath, 'utf8')).toBe('original audit\n');
      expect(await readFile(fallback, 'utf8')).toBe('existing task audit\n');
      expect(f.executions()).toBe(0);
    } finally { worker.stop(); }
  });
});
