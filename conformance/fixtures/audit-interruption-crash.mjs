// SPDX-License-Identifier: Apache-2.0
// Test-only child: terminate at persistence boundaries with disposable fixture keys.
import { readFileSync } from 'node:fs';
import { TaskJournal } from '../../packages/runtime/dist/task-journal.js';
import { JsonlStore } from '../../packages/ledger/dist/index.js';
const [fixturePath, boundary] = process.argv.slice(2);
const { owner, record, entries, interruption } = JSON.parse(readFileSync(fixturePath, 'utf8'));
const journal = new TaskJournal(record.auditPath + '.tasks.jsonl', owner);
const terminate = () => process.kill(process.pid, 'SIGKILL');
if (boundary === 'before-intent') terminate();
new JsonlStore(record.auditPath).closeInterrupted({ entries, interruption }, () => {
  journal.save({ ...record, auditClosure: { state: 'pending', interruption } });
  if (boundary === 'after-intent') terminate();
});
if (boundary === 'after-append') terminate();
journal.save({ ...record, auditClosure: { state: 'written', interruption } });
terminate();
