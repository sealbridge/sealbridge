// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { digest, signApproval, signEnvelope, signPayload } from '../packages/core/src/index.js';
import { IdempotencyStore, idempotencyKeyHash, validateIdempotencyKey } from '../packages/runtime/src/idempotency-store.js';
import { DELIVERY_RETENTION_MS } from '../packages/runtime/src/delivery-records.js';
import { buildTaskManifest } from '../packages/runtime/src/session.js';
import { countDeliveryFs, outboxFixture } from './outbox-fixture.js';
import { deferred } from './mcp-approval-helpers.js';

const cleanups: Array<() => void> = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.UTC(2030, 0, 1)); });
afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.restoreAllMocks(); vi.useRealTimers(); });
function setup() {
  const f = outboxFixture(); cleanups.push(f.cleanup);
  const options = { ...f.identityOptions, now: f.now };
  const store = new IdempotencyStore(f.owner, options);
  const action = { input: { a: 1, b: 2 } };
  const run = vi.fn(async () => ({ isError: false, value: { status: 'SETTLED', taskId: 'task_first' } }));
  return { ...f, store, options, action, run };
}
const tool = 'acp_delegate_task';
// Hold actual writes so concurrent-publication checks do not depend on file flushes.
function interceptWrite(intercept: (fd: number, resume: () => void,
  fail: (error: NodeJS.ErrnoException) => void) => void): typeof fs.write {
  return Object.assign((fd: number, buffer: Buffer, offset: number, length: number, position: number | null,
    done: (error: NodeJS.ErrnoException | null, written: number, buffer: Buffer) => void) => {
    intercept(fd, () => fs.write(fd, buffer, offset, length, position, done), error => done(error, 0, buffer));
  }, fs.write) as typeof fs.write;
}

describe('signer-scoped idempotency records', () => {
  it.each(['sync', 'async'])('writes C2 preparation, authorization, results and %s enqueue without file flushes or preparation locks', async mode => {
    const f = setup(), handles = new Map<number, string>();
    const lock = join(f.store.records.root, '.lock');
    const unexpectedSync = vi.fn(() => { throw new Error('UNEXPECTED_FILE_SYNC'); });
    const io: typeof fs = { ...fs,
      openSync: (path, flags, mode) => {
        if (String(path).endsWith('.tmp')) expect(fs.existsSync(lock)).toBe(false);
        const fd = fs.openSync(path, flags, mode); handles.set(fd, String(path)); return fd;
      },
      closeSync: fd => { fs.closeSync(fd); handles.delete(fd); },
      fsyncSync: unexpectedSync,
      fsync: Object.assign(unexpectedSync, fs.fsync),
      write: interceptWrite((_fd, resume) => { expect(fs.existsSync(lock)).toBe(false); resume(); }),
      renameSync: (from, to) => {
        expect([...handles.values()]).not.toContain(String(from));
        expect([...handles.values()]).not.toContain(String(to));
        fs.renameSync(from, to);
      },
    };
    const store = new IdempotencyStore(f.owner, { ...f.options, fs: io });
    const service = f.restart(f.owner, { identityOptions: { ...f.identityOptions, fs: io } });
    const manifest = buildTaskManifest({ ownerDid: f.owner.did, workerDid: f.peer.did,
      title: 'Example', description: 'Example', now: f.now });
    const frame = signEnvelope({ taskId: manifest.taskId, recipientDid: f.peer.did, seq: 0,
      eventType: 'PROPOSE', payload: {} }, f.owner, { encrypt: true });
    const context = { ...f.prepare().context, messageId: frame.payload.envelopeId,
      deliveryDeadline: Date.parse(manifest.deadline), message: { taskId: manifest.taskId,
        peerAgentDid: f.peer.did, protocolVersion: '0.2.0' as const } };
    const targetDigest = digest({ manifest });
    await store.run(tool, 'key', f.action, async operation => {
      await operation.prepare({ childIndex: 0, manifest, input: null, relayUrl: context.relayUrl,
        peerOwnerDid: f.peer.did, peerAgentDid: f.peer.did, approvalTargetDigest: targetDigest });
      await operation.authorize(0, { targetDigest, policy: 'configured-auto', approvedAt: f.epoch });
      await operation.renew(); await operation.sending();
      const keyedContext = { ...context, message: { ...context.message, operationId: operation.operationId } };
      if (mode === 'sync') service.enqueue([frame], keyedContext);
      else await service.enqueuePrepared([frame], keyedContext);
      expect(store.records.read('operations', operation.operationId)?.messageIds).toEqual([frame.payload.envelopeId]);
      return f.run();
    });
    expect(await new IdempotencyStore(f.owner, f.options).run(tool, 'key', f.action, f.run)).toMatchObject({ isError: false });
    expect(f.run).toHaveBeenCalledOnce(); expect(handles.size).toBe(0);
    expect(unexpectedSync).not.toHaveBeenCalled();
  });
  it('reprepares a keyed batch operation when lease renewal publishes during its write', async () => {
    const f = setup(), paths = new Map<number, string>();
    let renew: (() => Promise<void>) | undefined;
    const service = f.restart(f.owner, { identityOptions: { ...f.identityOptions, fs: { ...fs,
      openSync: (path, flags, mode) => { const fd = fs.openSync(path, flags, mode); paths.set(fd, String(path)); return fd; },
      closeSync: fd => { fs.closeSync(fd); paths.delete(fd); },
      write: interceptWrite((fd, resume, fail) => {
        expect(fs.existsSync(join(f.store.records.root, '.lock'))).toBe(false);
        const concurrent = paths.get(fd) && dirname(paths.get(fd)!) === join(f.store.records.root, 'operations') ? renew : undefined;
        if (concurrent) renew = undefined;
        if (concurrent) void concurrent().then(resume, fail);
        else resume();
      }),
    } } });
    const manifest = buildTaskManifest({ ownerDid: f.owner.did, workerDid: f.peer.did,
      title: 'Example', description: 'Example', now: f.now });
    const frame = signEnvelope({ taskId: manifest.taskId, recipientDid: f.peer.did, seq: 0,
      eventType: 'PROPOSE', payload: {} }, f.owner, { encrypt: true });
    const context = { ...f.prepare().context, messageId: frame.payload.envelopeId,
      deliveryDeadline: Date.parse(manifest.deadline), message: { taskId: manifest.taskId,
        peerAgentDid: f.peer.did, protocolVersion: '0.2.0' as const } };
    await f.store.run(tool, 'key', f.action, async operation => {
      const targetDigest = digest({ manifest });
      await operation.prepare({ childIndex: 0, manifest, input: null, relayUrl: context.relayUrl,
        peerOwnerDid: f.peer.did, peerAgentDid: f.peer.did, approvalTargetDigest: targetDigest });
      await operation.authorize(0, { targetDigest, policy: 'configured-auto', approvedAt: f.epoch });
      renew = async () => { f.setNow(f.epoch + 5000); await operation.renew(); };
      await service.enqueuePrepared([frame], { ...context, message: { ...context.message, operationId: operation.operationId } });
      expect(renew).toBeUndefined();
      const record = f.store.records.read('operations', operation.operationId)!;
      expect(record.lease?.until).toBe(f.now() + f.store.leaseMs);
      expect(record.messageIds).toEqual([frame.payload.envelopeId]);
      expect(service.store.ids('batches')).toHaveLength(1);
      return f.run();
    });
  });
  it('lets another key finish while a same-signer reservation write is held', async () => {
    const f = setup(), writing = deferred<void>(), release = deferred<void>();
    let hold = true, held = 0;
    const store = new IdempotencyStore(f.owner, { ...f.options, fs: { ...fs,
      write: interceptWrite((_fd, resume) => {
        expect(fs.existsSync(join(f.store.records.root, '.lock'))).toBe(false);
        if (hold) {
          if (++held === 2) { hold = false; writing.resolve(); }
          void release.promise.then(resume);
        } else resume();
      }),
    } });
    const pending = store.run(tool, 'held', f.action, f.run);
    const settled = Promise.allSettled([pending]);
    try {
      await writing.promise;
      expect(await store.run(tool, 'independent', f.action, f.run)).toMatchObject({ isError: false });
      expect(f.run).toHaveBeenCalledOnce();
      release.resolve(); await pending;
      expect(f.run).toHaveBeenCalledTimes(2);
    } finally { release.resolve(); await settled; }
  });
  it('rechecks a shared key and result capacity after concurrent reservation writes', async () => {
    const f = setup(), entered = deferred<void>(), release = deferred<void>();
    const options = { ...f.options, limits: { operations: 1 } };
    const stores = [new IdempotencyStore(f.owner, options), new IdempotencyStore(f.owner, options)];
    const run = vi.fn(async () => { entered.resolve(); await release.promise; return f.run(); });
    const sends = stores.map(store => store.run(tool, 'key', f.action, run));
    const settled = Promise.allSettled(sends);
    try {
      await entered.promise; release.resolve();
      const responses = await Promise.all(sends);
      expect(responses.filter(r => !r.isError).length).toBeGreaterThanOrEqual(1);
      expect(responses.every(r => !r.isError || (r.value as { error: string }).error === 'IDEMPOTENCY_IN_PROGRESS')).toBe(true);
      expect(run).toHaveBeenCalledOnce();
      await expect(stores[0].run(tool, 'other', f.action, run)).rejects.toThrow('IDEMPOTENCY_STORE_FULL');
    } finally { release.resolve(); await settled; }
  });
  it('reserves new keys without reopening unrelated results beyond the verified cache', async () => {
    const f = setup(), counted = countDeliveryFs();
    const store = new IdempotencyStore(f.owner, { ...f.options, fs: counted.fs });
    for (let i = 0; i < 140; i++) await store.run(tool, 'retained-' + i, f.action, f.run);
    for (let i = 0; i < 2; i++) {
      counted.reset();
      expect(await store.run(tool, 'new-' + i, f.action, f.run)).toMatchObject({ isError: false });
      expect(counted.counts.readdirSync).toBe(0);
      expect(counted.counts.readSync).toBe(0);
      // Reservation and result publication each plan and publish under short locks; staging needs no lock.
      expect(counted.counts.openSync).toBeLessThanOrEqual(7);
      expect(counted.counts.fsyncSync).toBe(0);
      expect(counted.asyncCounts.fsync).toBe(0);
    }
  });
  it('joins calls during yielding index recovery and reconciles another store before capacity checks', async () => {
    const f = setup(), options = { ...f.options, limits: { operations: 3 } };
    const first = new IdempotencyStore(f.owner, options);
    await first.run(tool, 'one', f.action, f.run);
    const second = new IdempotencyStore(f.owner, options);
    const run = vi.fn(async () => f.run());
    const pending = second.run(tool, 'two', f.action, run);
    const duplicate = second.run(tool, 'two', f.action, run);
    await expect(second.run(tool, 'two', { input: 3 }, run)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(await duplicate).toEqual(await pending);
    expect(run).toHaveBeenCalledOnce();
    await first.run(tool, 'three', f.action, f.run);
    await expect(second.run(tool, 'four', f.action, f.run)).rejects.toThrow('IDEMPOTENCY_STORE_FULL');
    expect(f.run).toHaveBeenCalledTimes(3);
  });
  it.each(['a', 'x'.repeat(200), 'é'.repeat(100), '😀'.repeat(50), ' ', 'e\u0301'])('accepts the exact UTF-8 key bytes (%#)', key => {
    expect(() => validateIdempotencyKey(key)).not.toThrow();
  });
  it.each(['', 'x'.repeat(201), 'é'.repeat(101), '😀'.repeat(51), '\ud800', '\udc00', 'x\ud800x', 1, null])('rejects invalid keys (%#)', key => {
    expect(() => validateIdempotencyKey(key)).toThrow('INVALID_IDEMPOTENCY_KEY');
  });
  it('joins one live promise, persists the first response, and reads it after restart', async () => {
    const f = setup(), entered = deferred<void>(), release = deferred<void>();
    const run = vi.fn(async () => { entered.resolve(); await release.promise; return f.run(); });
    const first = f.store.run(tool, 'key', f.action, run); await entered.promise;
    const duplicate = f.store.run(tool, 'key', { input: { b: 2, a: 1 } }, run);
    const foreign = new IdempotencyStore(f.owner, f.options);
    expect(await foreign.run(tool, 'key', f.action, run)).toMatchObject({ isError: true, value: { error: 'IDEMPOTENCY_IN_PROGRESS' } });
    await expect(foreign.run(tool, 'key', { input: 3 }, run)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    release.resolve(); const response = await first;
    expect(await duplicate).toEqual(response); expect(run).toHaveBeenCalledOnce();
    expect(await foreign.run(tool, 'key', f.action, run)).toEqual(response);
    const r = foreign.records.snapshot('operations')[0];
    expect(r.response).toEqual(response); expect(r.lease).toBeUndefined();
    expect(JSON.stringify(foreign.records.snapshot('idempotency'))).not.toContain('"key"');
    expect(await f.store.run('acp_delegate_multi', 'key', f.action, f.run)).toEqual(response);
    expect(await f.store.run(tool, ' key', f.action, f.run)).toEqual(response);
    expect(idempotencyKeyHash(f.owner.did, tool, 'é')).not.toBe(idempotencyKeyHash(f.owner.did, tool, 'e\u0301'));
  });
  it.each(['reserved', 'awaiting_approval', 'approved', 'sending', 'finished'] as const)('recovers %s without another action', async phase => {
    const f = setup(); await f.store.run(tool, 'key', f.action, f.run);
    const r = f.store.records.snapshot('operations')[0];
    if (phase !== 'finished') {
      r.phase = phase; delete r.response; r.lease = { holderId: randomUUID(), until: f.epoch - 1 };
      f.store.records.transaction(() => f.store.records.write('operations', r.operationId, r));
    }
    const restarted = new IdempotencyStore(f.owner, f.options);
    const response = await restarted.run(tool, 'key', f.action, f.run);
    expect(response).toMatchObject(phase === 'finished' ? { isError: false } : { isError: true, value: {
      error: ['reserved', 'awaiting_approval'].includes(phase) ? 'APPROVAL_INTERRUPTED' : 'IDEMPOTENCY_RESULT_UNAVAILABLE',
      operationId: r.operationId,
    } });
    expect(f.run).toHaveBeenCalledOnce();
    expect(await restarted.run(tool, 'key', f.action, f.run)).toEqual(response);
  });
  it('commits prepared action and verified authorization before the outbox batch', async () => {
    const f = setup(), manifest = buildTaskManifest({ ownerDid: f.owner.did, workerDid: f.peer.did,
      title: 'Example', description: 'Example', now: f.now });
    const target = { manifest, input: null, relay: 'https://relay.example', fanOut: 1, description: manifest.task.description };
    await f.store.run(tool, 'key', f.action, async operation => {
      await operation.prepare({ childIndex: 0, manifest, input: null, relayUrl: 'https://relay.example',
        peerOwnerDid: f.peer.did, peerAgentDid: f.peer.did, approvalTargetDigest: digest(target) });
      await operation.authorize(0, { targetDigest: digest(target), receipt: signApproval(manifest.taskId, 'external_side_effect', target, f.owner), approvedAt: f.epoch });
      const r = f.store.records.read('operations', operation.operationId)!;
      expect(r.phase).toBe('approved'); expect(r.preparedActions[0].manifest).toEqual(manifest);
      expect(r.retainUntil).toBe(Date.parse(manifest.deadline) + DELIVERY_RETENTION_MS);
      return f.run();
    });
    const r = f.store.records.snapshot('operations')[0];
    const file = f.store.records.path('operations', r.operationId);
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dirname(file)).mode & 0o777).toBe(0o700);
    }
    const wrapped = JSON.parse(fs.readFileSync(file, 'utf8')); wrapped.payload.extra = true;
    fs.writeFileSync(file, JSON.stringify(signPayload(wrapped.payload, f.owner)));
    await expect(new IdempotencyStore(f.owner, f.options).run(tool, 'key', f.action, f.run)).rejects.toThrow('IDEMPOTENCY_STORE_INVALID');
  });
  it('uses a fixed retention boundary and reserves result capacity before running', async () => {
    const f = setup(), bounded = new IdempotencyStore(f.owner, { ...f.options, limits: { operations: 1 } });
    await bounded.run(tool, 'key', f.action, f.run, { deadline: f.epoch + 1000 });
    const r = bounded.records.snapshot('operations')[0];
    await expect(bounded.run(tool, 'other', f.action, f.run)).rejects.toThrow('IDEMPOTENCY_STORE_FULL');
    f.setNow(r.retainUntil - 1);
    expect(await bounded.run(tool, 'key', f.action, f.run)).toMatchObject({ isError: false });
    expect(bounded.records.read('operations', r.operationId)?.retainUntil).toBe(r.retainUntil);
    f.setNow(r.retainUntil);
    await bounded.run(tool, 'key', f.action, f.run); expect(f.run).toHaveBeenCalledTimes(2);
    const full = new IdempotencyStore(f.peer, { ...f.options, limits: { cachedResultBytes: 1 } });
    await expect(full.run(tool, 'key', f.action, f.run)).rejects.toThrow('IDEMPOTENCY_STORE_FULL');
    expect(f.run).toHaveBeenCalledTimes(2);
  });
  it('releases all prepared children on a preparation failure before any approval', async () => {
    const f = setup(), authorize = vi.fn();
    const manifest = buildTaskManifest({ ownerDid: f.owner.did, workerDid: f.peer.did,
      title: 'Example', description: 'Example', now: f.now });
    const response = await f.store.run('acp_delegate_multi', 'key', f.action, async operation => {
      const child = operation.prepare({ childIndex: 0, manifest, input: null, relayUrl: 'https://relay.example',
        peerOwnerDid: f.peer.did, peerAgentDid: f.peer.did, approvalTargetDigest: digest({ manifest }) }).then(authorize);
      await operation.childReady(1, new Error('IDEMPOTENCY_STORE_FULL'));
      await child; return f.run();
    }, { children: 2 });
    expect(response).toMatchObject({ isError: true, value: { error: 'IDEMPOTENCY_STORE_FULL' } });
    expect(authorize).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
    expect(f.store.records.snapshot('operations')[0].approvals).toBeUndefined();
  });
  it('retains committed envelope bytes when final-result publication is interrupted', async () => {
    const f = setup();
    const broken = new IdempotencyStore(f.owner, { ...f.options, fs: { ...fs, renameSync: (from, to) => {
      if (dirname(String(to)) === join(f.store.records.root, 'operations') &&
          JSON.parse(fs.readFileSync(from, 'utf8')).payload.phase === 'finished') throw new Error('fixture result publication');
      fs.renameSync(from, to);
    } } });
    const p = f.prepare();
    const manifest = buildTaskManifest({ ownerDid: f.owner.did, workerDid: f.peer.did,
      title: 'Example', description: 'Example', now: f.now });
    p.first = signEnvelope({ taskId: manifest.taskId, recipientDid: f.peer.did, seq: 0, eventType: 'PROPOSE', payload: {} }, f.owner, { encrypt: true });
    p.frames = [p.first]; p.context.messageId = p.first.payload.envelopeId; p.context.message.taskId = manifest.taskId;
    manifest.deadline = new Date(p.context.deliveryDeadline).toISOString();
    const target = { manifest, input: null, relay: p.context.relayUrl, fanOut: 1, description: manifest.task.description };
    const execute = vi.fn(async (operation: Parameters<Parameters<IdempotencyStore['run']>[3]>[0]) => {
      await operation.prepare({ childIndex: 0, manifest, input: null, relayUrl: p.context.relayUrl,
        peerOwnerDid: f.peer.did, peerAgentDid: f.peer.did, approvalTargetDigest: digest(target) });
      await operation.authorize(0, { targetDigest: digest(target), policy: 'configured-auto', approvedAt: f.epoch });
      await f.service.enqueuePrepared(p.frames, { ...p.context, message: { ...p.context.message, operationId: operation.operationId } });
      return f.run();
    });
    await expect(broken.run(tool, 'key', f.action, execute)).rejects.toThrow('IDEMPOTENCY_STORE_UNWRITABLE');
    const before = f.service.store.snapshot('outbox');
    expect(before).toHaveLength(1); expect(before[0].envelope).toEqual(p.first);
    const operation = f.store.records.snapshot('operations')[0];
    expect(operation.response).toBeUndefined();
    f.setNow(operation.lease!.until);
    const response = await new IdempotencyStore(f.owner, f.options).run(tool, 'key', f.action, execute);
    expect(response).toMatchObject({ isError: true, value: { error: 'IDEMPOTENCY_RESULT_UNAVAILABLE',
      messageIds: [p.first.payload.envelopeId], taskIds: [manifest.taskId] } });
    expect(execute).toHaveBeenCalledOnce();
    await f.restart().drainDue();
    expect(f.posted).toEqual([p.first]);
    expect(await f.store.run(tool, 'key', f.action, execute)).toEqual(response);
    expect(execute).toHaveBeenCalledOnce();
  });
  it('separates signer bindings and reconciles an interrupted horizon publication', async () => {
    const f = setup(); await f.store.run(tool, 'key', f.action, f.run);
    const other = new IdempotencyStore(f.peer, f.options);
    await other.run(tool, 'key', { input: 9 }, f.run);
    expect(f.run).toHaveBeenCalledTimes(2);
    const binding = f.store.records.snapshot('idempotency')[0];
    f.store.records.transaction(() => f.store.records.write('idempotency', binding.keyHash,
      { ...binding, retainUntil: binding.retainUntil + 1 }));
    expect(await new IdempotencyStore(f.owner, f.options).run(tool, 'key', f.action, f.run)).toMatchObject({ isError: false });
    expect(f.store.records.read('idempotency', binding.keyHash)?.retainUntil).toBe(binding.retainUntil);
    expect(f.run).toHaveBeenCalledTimes(2);
  });
  it('keeps bindings when busy and returns a fixed error on publication failure', async () => {
    const f = setup(); await f.store.run(tool, 'key', f.action, f.run);
    const lock = join(f.store.records.root, '.lock'); fs.writeFileSync(lock, '', { mode: 0o600 });
    await expect(f.store.run(tool, 'other', f.action, f.run)).rejects.toThrow('IDEMPOTENCY_STORE_BUSY');
    expect(fs.existsSync(lock)).toBe(true); fs.unlinkSync(lock);
    const io = { ...fs, renameSync: () => { throw new Error('fixture publication'); } };
    await expect(new IdempotencyStore(f.owner, { ...f.options, fs: io }).run(tool, 'other', f.action, f.run)).rejects.toThrow('IDEMPOTENCY_STORE_UNWRITABLE');
    expect(f.run).toHaveBeenCalledOnce();
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.readdirSync(join(f.store.records.root, 'operations')).some(n => n.endsWith('.tmp'))).toBe(false);
  });
});
