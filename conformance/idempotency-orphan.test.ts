// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdempotencyStore } from '../packages/runtime/src/idempotency-store.js';
import { outboxFixture } from './outbox-fixture.js';

const cleanups: Array<() => void> = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.UTC(2030, 0, 1)); });
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.useRealTimers(); });
const tool = 'acp_delegate_task', action = { input: 1 };
const result = async () => ({ isError: false, value: { status: 'SETTLED' } });
const leaseAges = [120_000, 300_000].flatMap(leaseMs => [0, leaseMs - 1, leaseMs, leaseMs + 1].map(age => ({ leaseMs, age })));

describe('idempotency orphan cleanup', () => {
  it.each([0, 300_000])('retains all operations after a fourth run with an unchanged binding directory stamp at age %i', async age => {
    const f = outboxFixture(); cleanups.push(f.cleanup);
    const operations = join(f.service.store.root, 'operations'), bindings = join(f.service.store.root, 'idempotency');
    let generation = 0n, bindingStamp: Pick<fs.BigIntStats, 'mtimeNs' | 'ctimeNs' | 'size'> | undefined;
    // Only the binding stamp repeats; operation publications have distinct stamps.
    const io: typeof fs = { ...fs,
      openSync: (path, flags, mode) => {
        const fd = fs.openSync(path, flags, mode);
        if (dirname(String(path)) === operations && String(path).endsWith('.tmp')) generation++;
        return fd;
      },
      renameSync: (from, to) => { fs.renameSync(from, to); if (dirname(String(to)) === operations) generation++; },
      unlinkSync: path => { fs.unlinkSync(path); if (dirname(String(path)) === operations) generation++; },
      lstatSync: ((path, options) => {
        if (!options?.bigint) return fs.lstatSync(path, options);
        const stat = fs.lstatSync(path, { ...options, bigint: true });
        if (!stat) return stat;
        if (String(path) === bindings) {
          bindingStamp ??= { mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, size: stat.size };
          Object.assign(stat, bindingStamp);
        }
        if (String(path) === operations) Object.assign(stat, { mtimeNs: generation, ctimeNs: generation });
        return stat;
      }) as typeof fs.lstatSync,
    };
    const options = { ...f.identityOptions, now: f.now, fs: io, leaseMs: 300_000, limits: { operations: 3 } };
    const first = new IdempotencyStore(f.owner, options);
    await first.run(tool, 'one', action, result);
    const second = new IdempotencyStore(f.owner, options);
    await second.run(tool, 'two', action, result);
    await first.run(tool, 'three', action, result);
    const before = fs.readdirSync(operations).filter(name => name.endsWith('.json')).sort();
    f.setNow(f.epoch + age);
    const fourth = await Promise.allSettled([second.run(tool, 'four', action, result)]);
    const after = fs.readdirSync(operations).filter(name => name.endsWith('.json')).sort();
    expect(after).toHaveLength(3);
    expect(after).toEqual(before);
    expect(fourth).toMatchObject([{ status: 'rejected', reason: { message: 'IDEMPOTENCY_STORE_FULL' } }]);
  });

  it.each(leaseAges)('reconsiders an unbound operation at age $age with lease $leaseMs', async ({ leaseMs, age }) => {
    const f = outboxFixture(); cleanups.push(f.cleanup);
    const options = { ...f.identityOptions, now: f.now, ...(leaseMs === 120_000 ? {} : { leaseMs }) };
    const store = new IdempotencyStore(f.owner, options);
    await store.run(tool, 'one', action, result);
    const [operation] = store.records.snapshot('operations'), [binding] = store.records.snapshot('idempotency');
    store.records.transaction(() => store.records.remove('idempotency', binding.keyHash));
    f.setNow(operation.createdAt + age);
    const scans: string[] = [], lock = join(store.records.root, '.lock');
    let observing = false;
    // Observe the actual inventory reads used for this locked cleanup decision.
    const io: typeof fs = { ...fs, readdirSync: ((path: fs.PathLike) => {
      if (observing) { expect(fs.existsSync(lock)).toBe(true); scans.push(String(path)); }
      return fs.readdirSync(path);
    }) as typeof fs.readdirSync };
    const reader = new IdempotencyStore(f.owner, { ...options, fs: io });
    await reader.records.prepareIdempotency();
    observing = true;
    reader.records.transaction(() => reader.records.reserveIdempotencyCapacity(f.now()));
    expect(fs.existsSync(reader.records.path('operations', operation.operationId))).toBe(age < store.leaseMs);
    if (age >= store.leaseMs) expect(scans).toEqual([
      join(store.records.root, 'operations'), join(store.records.root, 'idempotency'),
    ]);
    else expect(scans).toEqual([]);
    // A deferred operation is reconsidered by a later reservation without a restart.
    f.setNow(operation.createdAt + Math.max(age, store.leaseMs));
    reader.records.transaction(() => reader.records.reserveIdempotencyCapacity(f.now()));
    expect(fs.existsSync(reader.records.path('operations', operation.operationId))).toBe(false);
  });
});
