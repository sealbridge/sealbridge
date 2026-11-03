// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { digest, signPayload } from '../packages/core/src/index.js';
import { DeliveryStore } from '../packages/runtime/src/delivery-store.js';
import type { DeliveryWrite } from '../packages/runtime/src/delivery-store.js';
import { IdempotencyStore, idempotencyKeyHash } from '../packages/runtime/src/idempotency-store.js';
import { countDeliveryFs, outboxFixture } from './outbox-fixture.js';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.restoreAllMocks(); });
const tool = 'acp_delegate_task', action = { input: 1 }, now = Date.UTC(2030, 0, 1);
const response = { isError: false, value: { taskId: 'task_generation' } };
function setup() {
  const f = outboxFixture(); cleanups.push(f.cleanup);
  return { ...f, options: { ...f.identityOptions, now: () => now, limits: { operations: 3 } } };
}
/** Keep directory metadata fixed while retaining actual identity and permissions. */
function directoryIo(frozen: string[] = ['operations', 'idempotency']) {
  let revision = 1n;
  const io: typeof fs = { ...fs, lstatSync: Object.assign((path: fs.PathLike, options?: { bigint?: boolean }) => {
    const stat = fs.lstatSync(path, options as { bigint: true });
    if (options?.bigint && frozen.includes(basename(String(path))) && stat.isDirectory())
      return Object.assign(stat, { size: 4096n, mtimeNs: revision, ctimeNs: revision });
    return stat;
  }, fs.lstatSync) as typeof fs.lstatSync };
  return { io, advance: () => { revision++; } };
}
function records(f: ReturnType<typeof setup>, io: typeof fs = fs) {
  return new DeliveryStore(f.owner, { ...f.options, fs: io });
}
function writes(store: DeliveryStore, key: string): DeliveryWrite[] {
  const operationId = randomUUID(), keyHash = idempotencyKeyHash(store.owner.did, tool, key);
  const common = { version: 1 as const, localOwnerDid: store.owner.did, tool,
    requestDigest: digest({ version: 1, tool, action }), operationId, createdAt: now, retainUntil: now + 86400_000 };
  return [
    { kind: 'operations', id: operationId, record: { ...common, phase: 'finished',
      preparedActions: [], messageIds: [], taskIds: [], response } },
    { kind: 'idempotency', id: keyHash, record: { ...common, keyHash } },
  ];
}
async function initialize(store: DeliveryStore) {
  await store.prepareIdempotency();
  // First reservation creates the internal file, then requests refreshed indexes.
  try { store.transaction(() => store.reserveIdempotencyCapacity(now)); }
  catch (error) { if (!(error instanceof Error) || error.message !== 'IDEMPOTENCY_STORE_BUSY') throw error; }
  for (const kind of ['operations', 'idempotency']) fs.mkdirSync(join(store.root, kind), { recursive: true, mode: 0o700 });
  await store.prepareIdempotency();
}
function publish(store: DeliveryStore, key: string) {
  const pending = store.prepareWritesSync(writes(store, key));
  try {
    store.transaction(() => {
      store.reserveIdempotencyCapacity(now);
      for (const write of pending) store.publishWrite(write);
    });
  } finally { store.discardWrites(pending); }
}
function jsonFiles(store: DeliveryStore, kind: 'operations' | 'idempotency') {
  return fs.readdirSync(join(store.root, kind)).filter(name => name.endsWith('.json')).sort();
}
function generation(store: DeliveryStore) { return join(store.root, '.idempotency-gen'); }

describe('idempotency index generation', () => {
  it('counts three retained operations across two stores with frozen directory stamps', async () => {
    const f = setup(), { io } = directoryIo();
    const first = new IdempotencyStore(f.owner, { ...f.options, fs: io });
    const second = new IdempotencyStore(f.owner, { ...f.options, fs: io });
    const run = vi.fn(async () => response);
    await first.run(tool, 'one', action, run);
    await second.run(tool, 'two', action, run);
    await first.run(tool, 'three', action, run);
    await expect(second.run(tool, 'four', action, run)).rejects.toThrow('IDEMPOTENCY_STORE_FULL');
    expect(run).toHaveBeenCalledTimes(3);
    expect(jsonFiles(first.records, 'operations')).toHaveLength(3);
  });

  it('refreshes both indexes when only the binding directory stamp is frozen', async () => {
    const f = setup(), { io } = directoryIo(['idempotency']);
    let revision = 1n;
    const injected: typeof fs = { ...io, lstatSync: Object.assign((path: fs.PathLike, options?: { bigint?: boolean }) => {
      const stat = io.lstatSync(path, options as { bigint: true });
      if (options?.bigint && basename(String(path)) === 'operations' && stat.isDirectory())
        Object.assign(stat, { mtimeNs: revision, ctimeNs: revision });
      return stat;
    }, fs.lstatSync) as typeof fs.lstatSync };
    const first = new IdempotencyStore(f.owner, { ...f.options, fs: injected });
    const second = new IdempotencyStore(f.owner, { ...f.options, fs: injected });
    await first.run(tool, 'one', action, async () => response); revision++;
    await second.run(tool, 'two', action, async () => response); revision++;
    await first.run(tool, 'three', action, async () => response); revision++;
    const before = jsonFiles(first.records, 'operations');
    await expect(second.run(tool, 'four', action, async () => response)).rejects.toThrow('IDEMPOTENCY_STORE_FULL');
    expect(jsonFiles(first.records, 'operations')).toEqual(before);
    expect(before).toHaveLength(3);
    for (const key of ['one', 'two', 'three'])
      expect(await second.run(tool, key, action, async () => { throw new Error('UNEXPECTED_EXECUTION'); })).toEqual(response);
  });

  it('retains a concurrent publication during temporary-file creation', async () => {
    const f = setup(), { io, advance } = directoryIo();
    let interleave: (() => void) | undefined;
    const injected: typeof fs = { ...io, openSync: (path, flags, mode) => {
      if (String(path).endsWith('.tmp') && interleave) {
        const change = interleave; interleave = undefined; change();
      }
      return fs.openSync(path, flags, mode);
    } };
    const first = records(f, injected), second = records(f, io);
    await initialize(first); publish(first, 'one');
    await initialize(second); publish(second, 'two');
    await first.prepareIdempotency();
    await second.prepareIdempotency();
    const before = jsonFiles(first, 'operations');
    interleave = () => { publish(second, 'three'); advance(); };
    const pending = first.prepareWritesSync(writes(first, 'four'));
    try {
      expect(interleave).toBeUndefined();
      await first.prepareIdempotency();
      expect(() => first.transaction(() => first.reserveIdempotencyCapacity(now))).toThrow('IDEMPOTENCY_STORE_FULL');
      expect(jsonFiles(first, 'operations')).toHaveLength(3);
      expect(jsonFiles(first, 'operations')).toEqual(expect.arrayContaining(before));
    } finally { first.discardWrites(pending); }
  });

  it('rebuilds after an interruption between generation increment and rename', async () => {
    const f = setup(), { io } = directoryIo(), counted = countDeliveryFs(io);
    let fail = false;
    const store = records(f, { ...counted.fs, renameSync: (from, to) => {
      if (fail) { fail = false; throw new Error('FIXTURE_INTERRUPTION'); }
      fs.renameSync(from, to);
    } });
    await initialize(store); publish(store, 'one');
    const before = fs.statSync(generation(store)).size;
    fail = true;
    expect(() => publish(store, 'two')).toThrow('OUTBOX_STORE_UNWRITABLE');
    expect(fs.statSync(generation(store)).size).toBe(before + 1);
    counted.reset(); await store.prepareIdempotency();
    expect(counted.counts.readdirSync).toBe(2);
    expect(jsonFiles(store, 'operations')).toHaveLength(1);
    publish(store, 'two'); publish(store, 'three');
    expect(() => publish(store, 'four')).toThrow('IDEMPOTENCY_STORE_FULL');
  });

  it('rebuilds both indexes after record publication interrupts local bookkeeping', async () => {
    const f = setup(), { io } = directoryIo(), counted = countDeliveryFs(io);
    let interrupt = false, publishedPath: string | undefined;
    const store = records(f, { ...counted.fs,
      renameSync: (from, to) => {
        fs.renameSync(from, to);
        if (interrupt && basename(dirname(String(to))) === 'operations') {
          interrupt = false; publishedPath = String(to);
        }
      },
      lstatSync: Object.assign((path: fs.PathLike, options?: { bigint?: boolean }) => {
        if (String(path) === publishedPath) {
          publishedPath = undefined; throw Object.assign(new Error('FIXTURE_METADATA'), { code: 'EIO' });
        }
        return counted.fs.lstatSync(path, options as { bigint: true });
      }, fs.lstatSync) as typeof fs.lstatSync,
    });
    await initialize(store); publish(store, 'one');
    // Publish the binding first so this interruption leaves a complete retained pair.
    const pending = store.prepareWritesSync(writes(store, 'two').reverse());
    interrupt = true;
    try {
      expect(() => store.transaction(() => {
        store.reserveIdempotencyCapacity(now);
        for (const write of pending) store.publishWrite(write);
      })).toThrow('OUTBOX_STORE_UNWRITABLE');
    } finally { store.discardWrites(pending); }
    counted.reset(); await store.prepareIdempotency();
    expect(counted.counts.readdirSync).toBe(2);
    expect(jsonFiles(store, 'operations')).toHaveLength(2);
    publish(store, 'three');
    expect(() => publish(store, 'four')).toThrow('IDEMPOTENCY_STORE_FULL');
  });

  it.each(['missing', 'replaced'])('rebuilds both indexes when the generation file is %s', async change => {
    const f = setup(), { io } = directoryIo(), counted = countDeliveryFs(io), store = records(f, counted.fs);
    await initialize(store); publish(store, 'one');
    const path = generation(store), original = fs.statSync(path, { bigint: true });
    if (change === 'missing') fs.unlinkSync(path);
    else {
      const replacement = join(store.root, '.generation-fixture');
      const fd = fs.openSync(replacement, 'wx', 0o600);
      try { fs.ftruncateSync(fd, Number(original.size)); } finally { fs.closeSync(fd); }
      fs.renameSync(replacement, path);
      expect(fs.statSync(path, { bigint: true }).ino).not.toBe(original.ino);
    }
    counted.reset(); await store.prepareIdempotency();
    expect(counted.counts.readdirSync).toBe(2);
    await initialize(store);
    expect(fs.existsSync(path)).toBe(true);
    publish(store, 'two'); publish(store, 'three');
    expect(() => publish(store, 'four')).toThrow('IDEMPOTENCY_STORE_FULL');
    expect(jsonFiles(store, 'operations')).toHaveLength(3);
  });

  it('observes a signed older-version write through the directory stamp', async () => {
    const f = setup(), { io, advance } = directoryIo(), counted = countDeliveryFs(io), store = records(f, counted.fs);
    await initialize(store); publish(store, 'one');
    const before = fs.statSync(generation(store)).size, legacy = writes(store, 'two');
    // Emulate publication by a writer that does not know the internal generation file.
    for (const write of legacy) fs.writeFileSync(store.path(write.kind, write.id),
      JSON.stringify(signPayload(write.record, f.owner)) + '\n', { mode: 0o600 });
    advance(); counted.reset(); await store.prepareIdempotency();
    expect(counted.counts.readdirSync).toBe(2);
    expect(fs.statSync(generation(store)).size).toBe(before);
    expect(store.read('operations', legacy[0].id)?.operationId).toBe(legacy[0].id);
    publish(store, 'three');
    expect(() => publish(store, 'four')).toThrow('IDEMPOTENCY_STORE_FULL');
    expect(jsonFiles(store, 'operations')).toHaveLength(3);
  });

  it('increments once before each record replacement and removal under the signer lock', async () => {
    const f = setup(), increments: number[] = [], handles = new Set<number>();
    let store: DeliveryStore;
    const io: typeof fs = { ...fs,
      openSync: (path, flags, mode) => {
        const fd = fs.openSync(path, flags, mode);
        if (basename(String(path)) === '.idempotency-gen') handles.add(fd);
        return fd;
      },
      closeSync: fd => { handles.delete(fd); fs.closeSync(fd); },
      ftruncateSync: (fd, length) => {
        expect(fs.existsSync(join(store.root, '.lock'))).toBe(true);
        expect(handles.has(fd)).toBe(true);
        expect(length).toBe(fs.fstatSync(fd).size + 1);
        fs.ftruncateSync(fd, length); increments.push(length!);
      },
      renameSync: (from, to) => {
        expect(fs.statSync(generation(store)).size).toBe(increments.at(-1));
        fs.renameSync(from, to);
      },
      unlinkSync: path => {
        if (String(path).endsWith('.json') && ['operations', 'idempotency'].includes(basename(dirname(String(path)))))
          expect(fs.statSync(generation(store)).size).toBe(increments.at(-1));
        fs.unlinkSync(path);
      },
    };
    store = records(f, io); await initialize(store);
    const retained = writes(store, 'one');
    store.transaction(() => { for (const w of retained) store.write(w.kind, w.id, w.record); });
    expect(increments).toEqual([1, 2]); expect(handles.size).toBe(0);
    await store.prepareIdempotency();
    store.transaction(() => { for (const w of [...retained].reverse()) store.remove(w.kind, w.id); });
    expect(increments).toEqual([1, 2, 3, 4]); expect(handles.size).toBe(0);
    expect(jsonFiles(store, 'operations')).toHaveLength(0);
    expect(jsonFiles(store, 'idempotency')).toHaveLength(0);
  });

  it('does not adopt a generation while its publisher still holds the signer lock', async () => {
    const f = setup(), { io } = directoryIo(), reader = records(f, io);
    let duringIncrement: Promise<void> | undefined, inspect = false;
    const writer = records(f, { ...io, ftruncateSync: (fd, length) => {
      fs.ftruncateSync(fd, length);
      if (inspect) {
        inspect = false;
        duringIncrement = expect(reader.prepareIdempotency()).rejects.toThrow('OUTBOX_STORE_BUSY');
      }
    } });
    await initialize(writer); publish(writer, 'one');
    await reader.prepareIdempotency();
    inspect = true; publish(writer, 'two');
    expect(duringIncrement).toBeDefined(); await duringIncrement;
    await reader.prepareIdempotency(); publish(reader, 'three');
    expect(() => publish(reader, 'four')).toThrow('IDEMPOTENCY_STORE_FULL');
    expect(jsonFiles(reader, 'operations')).toHaveLength(3);
  });

  it('maps an occupied signer lock to the existing idempotency busy error', async () => {
    const f = setup(), store = new IdempotencyStore(f.owner, f.options);
    await store.run(tool, 'one', action, async () => response);
    const lock = join(store.records.root, '.lock');
    fs.writeFileSync(lock, '', { mode: 0o600 });
    try { await expect(store.run(tool, 'two', action, async () => response)).rejects.toThrow('IDEMPOTENCY_STORE_BUSY'); }
    finally { fs.unlinkSync(lock); }
  });

  it.each(['open', 'truncate', 'rename'] as const)('maps generation publication errors at %s', async stage => {
    for (const code of ['EBUSY', 'EPERM']) {
      const f = setup();
      let fail = false;
      const raise = () => { throw Object.assign(new Error('FIXTURE_IO'), { code }); };
      const io: typeof fs = { ...fs,
        openSync: (path, flags, mode) => {
          if (fail && stage === 'open' && basename(String(path)) === '.idempotency-gen') raise();
          return fs.openSync(path, flags, mode);
        },
        ftruncateSync: (fd, length) => { if (fail && stage === 'truncate') raise(); fs.ftruncateSync(fd, length); },
        renameSync: (from, to) => { if (fail && stage === 'rename') raise(); fs.renameSync(from, to); },
      };
      const store = new IdempotencyStore(f.owner, { ...f.options, fs: io });
      await store.run(tool, 'one', action, async () => response);
      fail = true;
      await expect(store.run(tool, 'two', action, async () => response)).rejects.toThrow('IDEMPOTENCY_STORE_UNWRITABLE');
      expect(fs.existsSync(join(store.records.root, '.lock'))).toBe(false);
      expect(jsonFiles(store.records, 'operations')).toHaveLength(1);
      fail = false;
      expect(await store.run(tool, 'two', action, async () => response)).toEqual(response);
    }
  });
});
