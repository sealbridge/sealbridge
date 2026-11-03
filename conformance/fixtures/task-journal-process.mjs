// SPDX-License-Identifier: Apache-2.0
// JSON-line commands and acknowledgements let the parent order two independent writers.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { signPayload } from '../../packages/core/src/index.ts';
import { DeliveryStore } from '../../packages/runtime/src/delivery-store.ts';
import { TaskJournal } from '../../packages/runtime/src/task-journal.ts';

const original = { ...fs }, promises = { ...fs.promises }, descriptors = new Set();
let store, journal, record, path;
function freeze(stat) {
  if (typeof stat.size === 'bigint') { stat.mtimeNs = 1n; stat.ctimeNs = 1n; }
  return stat;
}
async function command(input) {
  if (input.command === 'init') {
    store = new DeliveryStore(input.owner, { env: { SEALBRIDGE_DATA_DIR: input.root } });
    store.transaction(() => {});
    path = join(store.root, 'tasks.jsonl');
    journal = new TaskJournal(path, input.owner, Infinity, input.durability);
    record = { version: 1, taskId: 'task_one', requesterDid: input.owner.did,
      envelopeId: 'envelope_one', proposalDigest: 'fixture_digest', phase: 'received', invocations: [] };
    fs.openSync = (...args) => {
      const fd = original.openSync(...args); if (String(args[0]) === path) descriptors.add(fd); return fd;
    };
    fs.closeSync = fd => { descriptors.delete(fd); return original.closeSync(fd); };
    fs.lstatSync = (...args) => {
      const stat = original.lstatSync(...args); return String(args[0]) === path ? freeze(stat) : stat;
    };
    fs.fstatSync = (...args) => {
      const stat = original.fstatSync(...args); return descriptors.has(args[0]) ? freeze(stat) : stat;
    };
    fs.promises.lstat = async (...args) => {
      const stat = await promises.lstat(...args); return String(args[0]) === path ? freeze(stat) : stat;
    };
    fs.promises.open = async (...args) => {
      const handle = await promises.open(...args);
      if (String(args[0]) === path) {
        const stat = handle.stat.bind(handle);
        handle.stat = async (...options) => freeze(await stat(...options));
      }
      return handle;
    };
    syncBuiltinESMExports();
  } else if (input.command === 'seed-tail') {
    store.transaction(() => {
      journal.save(record);
      // Model an append interrupted immediately before its newline.
      fs.appendFileSync(path, JSON.stringify(signPayload({ ...record, phase: 'delivered' }, input.owner)));
    });
  } else if (input.command === 'load') {
    store.transaction(() => journal.load());
  } else if (input.command === 'save') {
    store.transaction(() => { journal.reload(); journal.save({ ...record, ...input.record }); });
  } else if (input.command === 'compact') {
    await journal.compactInBackground(new Set(), change => store.transaction(change), new AbortController().signal);
  } else if (input.command === 'reload') {
    store.transaction(() => journal.reload());
  } else if (input.command === 'close') {
    journal.close();
  } else throw new Error('UNKNOWN_FIXTURE_COMMAND');
  return { command: input.command, pid: process.pid, tasks: journal ? [...journal.tasks.values()] : [],
    bytes: path && fs.existsSync(path) ? fs.statSync(path).size : 0 };
}
const lines = createInterface({ input: process.stdin });
let pending = Promise.resolve();
lines.on('line', line => {
  pending = pending.then(async () => {
    try { process.stdout.write(JSON.stringify(await command(JSON.parse(line))) + '\n'); }
    catch (error) { process.stdout.write(JSON.stringify({ error: error.message }) + '\n'); }
  });
});
lines.on('close', () => { void pending.finally(() => journal?.close()); });
