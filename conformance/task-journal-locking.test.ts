// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, signEnvelope, signPayload, verifySigned } from '../packages/core/src/index.js';
import type { SignedEnvelope } from '../packages/core/src/index.js';
import { DeliveryStore } from '../packages/runtime/src/delivery-store.js';
import { GatewayDeliveryService } from '../packages/runtime/src/outbox.js';
import { WorkerNode, buildTaskManifest } from '../packages/runtime/src/session.js';
import { TaskJournal } from '../packages/runtime/src/task-journal.js';
import type { TaskCheckpoint } from '../packages/runtime/src/task-journal.js';

const original = { ...fs }, promises = { ...fs.promises };
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const name of ['openSync', 'closeSync', 'lstatSync', 'fstatSync', 'writeSync', 'readFileSync', 'renameSync'] as const)
    Object.assign(fs, { [name]: original[name] });
  fs.promises.lstat = promises.lstat; fs.promises.open = promises.open; syncBuiltinESMExports();
  cleanups.splice(0).reverse().forEach(cleanup => cleanup());
});
function fixture(durability: 'process' | 'file-sync') {
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'task-journal-lock-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = generateKeyPair(), identityOptions = { env: { SEALBRIDGE_DATA_DIR: join(root, 'data') } };
  const store = new DeliveryStore(owner, identityOptions), otherStore = new DeliveryStore(owner, identityOptions);
  store.transaction(() => {});
  const path = join(store.root, 'tasks.jsonl');
  const record: TaskCheckpoint = { version: 1, taskId: 'task_one', requesterDid: owner.did,
    envelopeId: 'envelope_one', proposalDigest: 'fixture_digest', phase: 'received', invocations: [] };
  const journal = () => {
    const result = new TaskJournal(path, owner, Infinity, durability);
    cleanups.push(() => result.close()); return result;
  };
  const records = () => original.readFileSync(path, 'utf8').trim().split('\n').map(line => {
    const signed = JSON.parse(line); expect(verifySigned(signed, owner.did)).toBe(true);
    return signed.payload as TaskCheckpoint;
  });
  return { root, path, owner, identityOptions, store, otherStore, record, journal, records };
}
type Fixture = ReturnType<typeof fixture>;

// Keep real bytes, size, inode, ownership and permissions; only the timestamp tick is injected.
function freezeTimes(path: string) {
  const descriptors = new Set<number>();
  const freeze = <T extends fs.Stats | fs.BigIntStats>(stat: T): T => {
    if (typeof stat.size === 'bigint') Object.assign(stat, { mtimeNs: 1n, ctimeNs: 1n });
    return stat;
  };
  fs.openSync = (...args) => {
    const fd = original.openSync(...args); if (String(args[0]) === path) descriptors.add(fd); return fd;
  };
  fs.closeSync = fd => { descriptors.delete(fd); original.closeSync(fd); };
  Object.assign(fs, { lstatSync: ((...args: Parameters<typeof fs.lstatSync>) => {
    const stat = original.lstatSync(...args); return String(args[0]) === path && stat ? freeze(stat) : stat;
  }) as typeof fs.lstatSync });
  fs.fstatSync = ((...args: Parameters<typeof fs.fstatSync>) => {
    const stat = original.fstatSync(...args); return descriptors.has(args[0]) ? freeze(stat) : stat;
  }) as typeof fs.fstatSync;
  fs.promises.lstat = (async (...args: Parameters<typeof fs.promises.lstat>) => {
    const stat = await promises.lstat(...args); return String(args[0]) === path ? freeze(stat) : stat;
  }) as typeof fs.promises.lstat;
  fs.promises.open = async (...args) => {
    const handle = await promises.open(...args);
    if (String(args[0]) === path) {
      const stat = handle.stat.bind(handle);
      handle.stat = (async (...options: Parameters<typeof handle.stat>) => freeze(await stat(...options))) as typeof handle.stat;
    }
    return handle;
  };
  syncBuiltinESMExports();
}
function fingerprint(path: string) {
  const s = fs.lstatSync(path, { bigint: true });
  return [s.dev, s.ino, s.size, s.mode, s.uid, s.mtimeNs, s.ctimeNs].join(':');
}
function tornAppend(f: Fixture) {
  const seed = f.journal(); f.store.transaction(() => seed.save(f.record));
  const inode = original.statSync(f.path);
  let shortened = false;
  fs.writeSync = ((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
    const s = original.fstatSync(fd);
    if (s.dev === inode.dev && s.ino === inode.ino) {
      if (shortened) throw new Error('FIXTURE_INTERRUPTED');
      shortened = true; return original.writeSync(fd, buffer, offset, length - 1, position);
    }
    return original.writeSync(fd, buffer, offset, length, position);
  }) as typeof fs.writeSync;
  syncBuiltinESMExports();
  try {
    expect(() => f.store.transaction(() => seed.save({ ...f.record, phase: 'delivered' }))).toThrow('OUTBOX_STORE_UNWRITABLE');
    expect(shortened).toBe(true);
  } finally { fs.writeSync = original.writeSync; syncBuiltinESMExports(); }
  return seed;
}
function repair(f: Fixture) {
  const before = fingerprint(f.path), other = f.journal();
  f.otherStore.transaction(() => { other.reload(); other.save({ ...f.record, phase: 'accepted' }); });
  other.close();
  expect(fingerprint(f.path)).toBe(before);
  expect(f.records().map(r => r.phase)).toEqual(['received', 'accepted']);
}

describe.each(['process', 'file-sync'] as const)('%s locked journal', durability => {
  it('releases the descriptor pin on close and background replacement', async () => {
    const f = fixture(durability), seed = f.journal();
    f.store.transaction(() => seed.save(f.record)); seed.close();
    const open = new Set<number>();
    fs.openSync = (...args) => {
      const fd = original.openSync(...args); if (String(args[0]) === f.path) open.add(fd); return fd;
    };
    fs.closeSync = fd => { open.delete(fd); original.closeSync(fd); };
    syncBuiltinESMExports();
    const reader = f.journal();
    f.store.transaction(() => reader.load());
    expect(open.size).toBe(durability === 'process' && process.platform !== 'win32' ? 1 : 0);
    reader.close(); expect(open.size).toBe(0);
    f.store.transaction(() => reader.reload());
    expect(open.size).toBe(durability === 'process' && process.platform !== 'win32' ? 1 : 0);
    await reader.compactInBackground(new Set(), change => f.store.transaction(change), new AbortController().signal);
    expect(open.size).toBe(0);
  });
  it('Windows closes readers and writers between operations so another instance can replace the journal', async () => {
    const f = fixture(durability);
    // Exercise the Windows descriptor policy on every CI platform, with real file I/O.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    cleanups.push(() => Object.defineProperty(process, 'platform', platform));
    const open = new Set<number>();
    let replacements = 0, reads = 0;
    fs.openSync = (...args) => {
      const fd = original.openSync(...args); if (String(args[0]) === f.path) open.add(fd); return fd;
    };
    fs.closeSync = fd => { open.delete(fd); original.closeSync(fd); };
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      if (typeof args[0] === 'number' && open.has(args[0])) reads++;
      return original.readFileSync(...args);
    }) as typeof fs.readFileSync;
    fs.promises.open = async (...args) => {
      const handle = await promises.open(...args);
      if (String(args[0]) === f.path) {
        open.add(handle.fd);
        const fd = handle.fd, close = handle.close.bind(handle);
        handle.close = async () => { await close(); open.delete(fd); };
      }
      return handle;
    };
    fs.renameSync = (from, to) => {
      if (String(to) === f.path) {
        expect(open.size).toBe(0); replacements++;
      }
      original.renameSync(from, to);
    };
    syncBuiltinESMExports();
    const writer = f.journal(), reader = f.journal();
    f.store.transaction(() => writer.save(f.record));
    expect(open.size).toBe(0);
    f.otherStore.transaction(() => reader.load());
    expect(open.size).toBe(0);
    const beforeReload = reads;
    f.otherStore.transaction(() => reader.reload());
    expect(reads).toBe(beforeReload + 1); // Matching stat fields alone cannot reuse an unpinned cache.
    expect(open.size).toBe(0);
    f.store.transaction(() => { writer.reload(); writer.save({ ...f.record, phase: 'accepted' }); });
    expect(open.size).toBe(0);
    f.otherStore.transaction(() => reader.compact(new Set()));
    expect(open.size).toBe(0);
    await reader.compactInBackground(new Set(), change => f.otherStore.transaction(change), new AbortController().signal);
    expect(open.size).toBe(0);
    expect(replacements).toBe(2);
    f.store.transaction(() => { writer.reload(); writer.save({ ...f.record, taskId: 'task_two' }); });
    expect(open.size).toBe(0);
    expect(f.records().map(r => r.phase)).toEqual(['accepted', 'received']);
  });
  it('A: reload preserves a same-size tail repair in one timestamp tick', () => {
    const f = fixture(durability); freezeTimes(f.path); tornAppend(f);
    const reader = f.journal(); f.store.transaction(() => reader.load());
    repair(f);
    f.store.transaction(() => { reader.reload(); reader.save({ ...f.record, taskId: 'task_two' }); });
    expect(reader.tasks.get('task_one')?.phase).toBe('accepted');
    expect(f.records().map(r => r.phase)).toEqual(['received', 'accepted', 'received']);
  });
  it('A: background compaction preserves a same-size tail repair before commit', async () => {
    const f = fixture(durability); freezeTimes(f.path); tornAppend(f);
    const reader = f.journal(); f.store.transaction(() => reader.load());
    await reader.compactInBackground(new Set(), change => {
      repair(f); f.store.transaction(change);
    }, new AbortController().signal);
    f.store.transaction(() => { reader.reload(); reader.save({ ...f.record, taskId: 'task_two' }); });
    expect(f.records().map(r => r.phase)).toEqual(['received', 'accepted', 'received']);
    expect(fs.readdirSync(f.store.root).filter(n => n.endsWith('.tmp'))).toEqual([]);
  });
  it('invalidates a failed append before the same instance observes another repair', () => {
    const f = fixture(durability); freezeTimes(f.path);
    const failed = tornAppend(f); repair(f);
    f.store.transaction(() => failed.save({ ...f.record, taskId: 'task_two' }));
    expect(f.records().map(r => r.phase)).toEqual(['received', 'accepted', 'received']);
  });
  it('does not reuse an incomplete load on the same instance', () => {
    const f = fixture(durability); freezeTimes(f.path); tornAppend(f);
    const reader = f.journal(); f.store.transaction(() => reader.load()); repair(f);
    f.store.transaction(() => reader.load());
    expect(reader.tasks.get('task_one')?.phase).toBe('accepted');
  });

  it.each(['reconcile', 'recover'] as const)('B: %s loads and commits its cache under the signer lock', async route => {
    const f = fixture(durability), seed = f.journal(), other = f.journal();
    f.store.transaction(() => seed.save({ ...f.record, phase: 'terminal', outcome: { code: 'TASK_INTERRUPTED' } }));
    seed.close();
    const service = new GatewayDeliveryService(f.owner, { identityOptions: f.identityOptions,
      resolveTransport: () => ({ send: () => {}, receive: () => undefined }) });
    const worker = new WorkerNode({ owner: f.owner, identityOptions: f.identityOptions, deliveryService: service,
      relay: { send: () => {}, receive: () => undefined }, relayUrl: 'https://relay.example', autoAccept: { version: 1, enabled: true, from: 'anyone', work: 'write', limits: {} }, checkPeer: () => 'trusted',
      adapter: { id: 'fixture', name: 'Fixture', skills: [], executeTask: async () => { throw new Error('UNEXPECTED_EXECUTION'); } } });
    cleanups.push(() => worker.stop());
    // Inspect existing internal entry points; no production test seam is needed.
    const internal = worker as unknown as { taskJournal: TaskJournal; reconcileTasks(): Promise<void>;
      recoverProposal(envelope: SignedEnvelope): Promise<boolean>; saveTaskCheckpoint(record: TaskCheckpoint): void };
    internal.taskJournal = new TaskJournal(f.path, f.owner, Infinity, durability);
    const append = () => f.otherStore.transaction(() => { other.reload(); other.save({ ...f.record, taskId: 'task_two' }); });
    const inode = original.statSync(f.path);
    let attempted = false, blocked = false;
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      const bytes = original.readFileSync(...args);
      if (typeof args[0] === 'number' && !attempted) {
        const stat = original.fstatSync(args[0]);
        if (stat.dev === inode.dev && stat.ino === inode.ino) {
          attempted = true;
          try { append(); } catch (error) {
            if (!(error instanceof Error) || error.message !== 'OUTBOX_STORE_BUSY') throw error;
            blocked = true;
          }
        }
      }
      return bytes;
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    try {
      if (route === 'reconcile') await internal.reconcileTasks();
      else {
        const manifest = buildTaskManifest({ ownerDid: f.owner.did, workerDid: f.owner.did, title: 'Fixture', description: 'Fixture' });
        const envelope = signEnvelope({ taskId: manifest.taskId, recipientDid: f.owner.did, seq: 0, eventType: 'PROPOSE',
          payload: { proposal: signPayload(manifest, f.owner), input: {} } as never }, f.owner, { encrypt: true });
        expect(await internal.recoverProposal(envelope)).toBe(false);
      }
    } finally { fs.readFileSync = original.readFileSync; syncBuiltinESMExports(); }
    expect(attempted).toBe(true);
    if (blocked) append(); // The competing owner explicitly retries after the lock is released.
    internal.saveTaskCheckpoint({ ...f.record, taskId: 'task_three' });
    expect(f.records().map(r => r.taskId)).toEqual(['task_one', 'task_two', 'task_three']);
    // file-sync is the content-preservation control on the previous implementation.
    if (durability === 'process') expect(blocked).toBe(true);
  });
});
