// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, verifySigned } from '../packages/core/src/index.js';
import { DeliveryStore } from '../packages/runtime/src/delivery-store.js';
import type { TaskCheckpoint } from '../packages/runtime/src/task-journal.js';

function actor() {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/task-journal-process.mjs', import.meta.url))],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  return {
    async command(input: object) {
      const reply = once(lines, 'line');
      child.stdin.write(JSON.stringify(input) + '\n');
      const result = await Promise.race([
        reply.then(([line]) => JSON.parse(line) as { error?: string; pid: number; tasks: TaskCheckpoint[]; bytes: number }),
        closed.then(([code]) => { throw new Error(`FIXTURE_EXIT_${code}: ${stderr}`); }),
      ]);
      if (result.error) throw new Error(result.error);
      return result;
    },
    async stop() {
      child.stdin.end();
      if (child.exitCode === null) child.kill();
      await closed; lines.close();
    },
  };
}
describe.each(['process', 'file-sync'] as const)('%s journal across Node processes', durability => {
  it('retains checkpoints through interleaved load, same-size repair, append and compaction', async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'journal-process-'));
    const owner = generateKeyPair(), first = actor(), second = actor();
    try {
      const a = await first.command({ command: 'init', owner, root, durability });
      const b = await second.command({ command: 'init', owner, root, durability });
      expect(a.pid).not.toBe(b.pid); expect(a.pid).not.toBe(process.pid); expect(b.pid).not.toBe(process.pid);
      await first.command({ command: 'seed-tail', owner });
      const loaded = await second.command({ command: 'load' });
      expect(loaded.tasks[0].phase).toBe('received');
      const repaired = await first.command({ command: 'save', record: { phase: 'accepted' } });
      expect(repaired.bytes).toBe(loaded.bytes);
      const saved = await second.command({ command: 'save', record: { taskId: 'task_two' } });
      expect(saved.tasks.find(r => r.taskId === 'task_one')?.phase).toBe('accepted');
      await first.command({ command: 'save', record: { taskId: 'task_three' } });
      await second.command({ command: 'compact' });
      await first.command({ command: 'save', record: { taskId: 'task_four' } });
      const recovered = await second.command({ command: 'reload' });
      expect(recovered.tasks.map(r => r.taskId)).toEqual(['task_one', 'task_two', 'task_three', 'task_four']);
      expect(recovered.tasks[0].phase).toBe('accepted');
      const store = new DeliveryStore(owner, { env: { SEALBRIDGE_DATA_DIR: root } });
      const records = readFileSync(join(store.root, 'tasks.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(records.every(r => verifySigned(r, owner.did))).toBe(true);
      expect(records.map(r => r.payload.taskId)).toEqual(recovered.tasks.map(r => r.taskId));
      await first.command({ command: 'close' }); await second.command({ command: 'close' });
    } finally {
      await Promise.all([first.stop(), second.stop()]);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
