// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { parseJsonl, verifyAudit } from '../packages/ledger/src/index.js';
import { PolicyAutoApprovalProvider, RequesterClient, WorkerNode } from '../packages/runtime/src/index.js';
import { WorkerTrustStore, workerIntakePath } from '../packages/runtime/src/worker-trust-store.js';
import { ProtocolPeerStore } from '../packages/runtime/src/protocol-peer-store.js';
import { DeliveryStore } from '../packages/runtime/src/delivery-store.js';
import { retryDeliveryBusy } from '../packages/runtime/src/delivery-retry.js';
import { outboxFixture } from './outbox-fixture.js';

const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); cleanups.splice(0).forEach(fn => fn()); });
function fixture() { const f = outboxFixture(); cleanups.push(f.cleanup); return f; }

it('retries an atomic replacement between private-file stat and open without treating valid bytes as corruption', () => {
  const f = fixture(), p = f.prepare(), [id] = f.service.enqueue(p.frames, p.context);
  const path = f.service.store.path('outbox', id), original = f.service.store.read('outbox', id)!;
  let replace = true;
  const store = new DeliveryStore(f.owner, { ...f.identityOptions, fs: { ...fs,
    openSync: ((file, ...args) => {
      if (String(file) === path && replace) {
        replace = false;
        f.service.store.transaction(() => f.service.store.write('outbox', id, { ...original, attemptCount: 2 }));
      }
      return fs.openSync(file, ...args);
    }) as typeof fs.openSync,
  } });
  expect(store.read('outbox', id)?.attemptCount).toBe(2);
  expect(replace).toBe(false);
  // A stable malformed signature still fails closed.
  fs.writeFileSync(path, '{}');
  expect(() => store.read('outbox', id)).toThrow('OUTBOX_STORE_INVALID');
});

it('treats batch marker removal during an unlocked snapshot as completed cleanup', () => {
  const f = fixture(), p = f.prepare(true), ids = f.service.enqueue(p.frames, p.context);
  const batch = f.service.store.read('outbox', ids[0])!.batchId;
  const reader = new DeliveryStore(f.owner, f.identityOptions), read = reader.read.bind(reader);
  let prune = true;
  vi.spyOn(reader, 'read').mockImplementation(((kind: Parameters<typeof reader.read>[0], id: string) => {
    const result = read(kind, id);
    if (kind === 'batches' && prune) {
      prune = false;
      f.service.store.transaction(() => {
        for (const envelopeId of ids) f.service.store.write('outbox', envelopeId, { ...f.service.store.read('outbox', envelopeId)!, state: 'admitted', admittedAt: f.now() });
        f.service.store.finishBatch(batch);
      });
    }
    return result;
  }) as typeof reader.read);
  expect(reader.committed(batch)).toEqual([]);
});

it.each(['OUTBOX_STORE_BUSY', 'OUTBOX_STORE_INVALID'])('contains %s from status enumeration and retries on the next drain', async code => {
  const f = fixture(), errors: Error[] = [];
  const service = f.restart(f.owner, { onError: error => errors.push(error) });
  await service.start();
  const status = vi.spyOn(service.store, 'statusOutbox').mockImplementationOnce(() => { throw new Error(code); });
  await expect(service.drainStatuses()).resolves.toBeUndefined();
  expect(errors.map(e => e.message)).toEqual([code]);
  await expect(service.drainStatuses()).resolves.toBeUndefined();
  expect(status).toHaveBeenCalledTimes(2);
});

it('waits asynchronously for a busy publication lock without repeating relay sends', async () => {
  const f = fixture(), p = f.prepare(), lock = join(f.service.store.root, '.lock');
  f.service.store.transaction(() => {});
  fs.writeFileSync(lock, '', { mode: 0o600 });
  const pending = f.service.enqueuePrepared(p.frames, p.context);
  const timer = setTimeout(() => fs.unlinkSync(lock), 150);
  try {
    const ids = await pending;
    expect(ids).toEqual([p.first.payload.envelopeId]);
    expect(f.posted).toEqual([]);
    await f.service.sendPrepared(ids[0]);
    expect(f.posted).toHaveLength(1);
  } finally { clearTimeout(timer); }
});

it('aborts a busy lock wait immediately on delivery shutdown and preserves the other writer lock', async () => {
  const f = fixture(), p = f.prepare(), lock = join(f.service.store.root, '.lock');
  f.service.store.transaction(() => {});
  fs.writeFileSync(lock, '', { mode: 0o600 });
  const attempt = f.service.enqueuePrepared(p.frames, p.context);
  const rejection = expect(attempt).rejects.toThrow('OUTBOX_STOPPED');
  await new Promise(resolve => setTimeout(resolve, 30));
  const start = performance.now();
  f.service.stop();
  await rejection;
  expect(performance.now() - start).toBeLessThan(100);
  expect(fs.existsSync(lock)).toBe(true);
  fs.unlinkSync(lock);
});

it('bounds a stuck lock retry and never retries stable invalid data', async () => {
  const operation = vi.fn(() => { throw new Error('OUTBOX_STORE_BUSY'); });
  const start = performance.now();
  await expect(retryDeliveryBusy(operation)).rejects.toThrow('OUTBOX_STORE_BUSY');
  expect(performance.now() - start).toBeGreaterThanOrEqual(4900);
  expect(performance.now() - start).toBeLessThan(6500);
  expect(operation.mock.calls.length).toBeLessThan(100);
  const invalid = vi.fn(() => { throw new Error('OUTBOX_STORE_INVALID'); });
  await expect(retryDeliveryBusy(invalid)).rejects.toThrow('OUTBOX_STORE_INVALID');
  expect(invalid).toHaveBeenCalledTimes(1);
});

it('SIGTERM stops a real worker during a busy lock wait with a clean exit', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/outbox-lock-worker.mjs', import.meta.url))],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  try {
    const [ready] = await Promise.race([once(child, 'message'), closed.then(() => { throw new Error(stderr); })]);
    expect(ready).toMatchObject({ waiting: true });
    const stopped = once(child, 'message'), start = performance.now();
    if (process.platform === 'win32') child.send('SIGTERM'); else child.kill('SIGTERM');
    expect((await stopped)[0]).toMatchObject({ stopped: true, preservedLock: true });
    expect((await closed)[0], stderr).toBe(0);
    // Includes OS scheduling and process teardown; in-process abort is checked at 100ms above.
    expect(performance.now() - start).toBeLessThan(1500);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); await closed; }
});

it('keeps a concurrent publication visible while opening unpublished temporary files', async () => {
  const f = fixture(), first = f.prepare();
  f.service.enqueue(first.frames, first.context);
  const other = f.restart(), next = f.prepare();
  await other.prepare();
  const io = other.store.io;
  // Use a separate injected store so the interception models another process's
  // publication between the before/after directory stamps of temporary creation.
  let publish = true;
  const reader = new DeliveryStore(f.owner, { ...f.identityOptions, fs: { ...io,
    openSync: ((file, ...args) => {
      if (publish && String(file).endsWith('.tmp')) {
        publish = false;
        f.service.enqueue(next.frames, next.context);
      }
      return io.openSync(file, ...args);
    }) as typeof fs.openSync,
  } });
  await reader.prepare();
  const record = reader.read('outbox', first.first.payload.envelopeId)!;
  const staged = await reader.prepareWrites([{ kind: 'outbox', id: record.envelopeId, record }]);
  try {
    await reader.prepare();
    expect(reader.pending(next.context.messageId).map(r => r.envelopeId)).toEqual([next.first.payload.envelopeId]);
  } finally { reader.discardWrites(staged); }
});

it('resumes a partially published batch after a Windows sharing violation without duplicate frames', async () => {
  const f = fixture(), p = f.prepare(true);
  let fail = true;
  const service = f.restart(f.owner, { identityOptions: { ...f.identityOptions, fs: { ...fs,
    renameSync: (from, to) => {
      if (fail && String(to).includes(join('messages', ''))) {
        fail = false;
        throw Object.assign(new Error('sharing violation'), { code: 'EPERM', syscall: 'rename' });
      }
      fs.renameSync(from, to);
    },
  } } });
  // Resolve real paths on the host OS, then simulate only the store's Windows
  // sharing-violation policy. Windows path normalization on POSIX escapes f.root.
  Object.defineProperty(service.store, 'platform', { value: 'win32' });
  expect(service.store.root).toBe(f.service.store.root);
  const ids = await service.enqueuePrepared(p.frames, p.context);
  expect(fail).toBe(false);
  expect(ids).toEqual(p.frames.map(frame => frame.payload.envelopeId));
  expect(service.store.committed(service.store.read('outbox', ids[0])!.batchId).map(r => r.envelopeId)).toEqual(ids);
  for (const id of ids) await service.sendPrepared(id);
  expect(f.posted).toEqual(p.frames);
});

it.each([false, true])('persists verified recovery after checkpoint ACK failure, preserving changed local prefixes; changed=%s', async changed => {
  const f = fixture(), relay = new InMemoryRelay(), send = relay.send.bind(relay);
  let fail = true, executions = 0, changedBytes = '';
  relay.send = envelope => {
    if (fail && envelope.payload.eventType === 'CHECKPOINT_ACK') {
      fail = false;
      if (changed) {
        const bytes = fs.readFileSync(requesterAudit, 'utf8');
        changedBytes = bytes + bytes.trim().split('\n').at(-1)! + '\n';
        fs.writeFileSync(requesterAudit, changedBytes);
      }
      throw new Error('TEST_LOST_CHECKPOINT_ACK');
    }
    return send(envelope);
  };
  const workerAudit = join(f.root, 'worker.jsonl'), requesterAudit = join(f.root, 'requester.jsonl');
  const worker = new WorkerNode({ owner: f.owner, relay, auditPath: workerAudit, timeoutMs: 5000,
    checkPeer: () => 'trusted', autoAccept: { version: 1, enabled: true, from: 'anyone', work: 'write', limits: {} },
    approvalProvider: new PolicyAutoApprovalProvider(f.owner),
    adapter: { id: 'echo', name: 'Echo', skills: [], executeTask: async context => { executions++; return context.input; } } });
  const client = new RequesterClient({ owner: f.peer, relay, auditPath: requesterAudit, timeoutMs: 5000,
    approvalProvider: new PolicyAutoApprovalProvider(f.peer) });
  const controller = new AbortController();
  const request = client.delegate({ to: worker.invite(), title: 'Echo', description: 'Recover a sealed checkpoint',
    input: { ok: true }, signal: controller.signal });
  const running = worker.start({ once: true });
  try {
    if (changed) {
      await expect(Promise.all([request, running])).rejects.toThrow('AUDIT_PREFIX_MISMATCH');
      expect(fs.readFileSync(requesterAudit, 'utf8')).toBe(changedBytes);
      expect(executions).toBe(1);
      return;
    }
    const [result] = await Promise.all([request, running]);
    expect(fail).toBe(false); expect(executions).toBe(1);
    expect(result.state).toBe('SETTLED');
    for (const path of [workerAudit, requesterAudit])
      expect(verifyAudit(parseJsonl(fs.readFileSync(path, 'utf8')), { taskId: result.taskId }).valid, path).toBe(true);
  } finally { controller.abort(); worker.stop(); client.stopDelivery(); await Promise.allSettled([request, running]); }
});

it.each(['open', 'rename'])('retries a Windows %s sharing refusal after a slow initial flush without changing consent', syscall => {
  const f = fixture(), path = workerIntakePath(f.owner.did, f.identityOptions);
  let fail = true;
  const violation = () => { fail = false; throw Object.assign(new Error('sharing violation'), { code: 'EPERM', syscall }); };
  const store = new WorkerTrustStore(f.owner, { path, platform: 'win32', fs: { ...fs,
    fsyncSync: fd => {
      fs.fsyncSync(fd);
      // Model the slow first durability flush seen on Windows CI. It must not
      // consume a contention budget before the injected rename refusal occurs.
      if (fail && syscall === 'rename') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
    },
    writeFileSync: ((file, ...args) => {
      if (fail && syscall === 'open' && String(file) === path + '.lock') violation();
      return fs.writeFileSync(file, ...args);
    }) as typeof fs.writeFileSync,
    renameSync: (from, to) => {
      if (fail && syscall === 'rename' && String(to) === path) violation();
      fs.renameSync(from, to);
    },
  } });
  store.block(f.peer.did);
  expect(fail).toBe(false);
  expect(store.connectionState(f.peer.did)).toBe('blocked');
  expect(store.listConnections()).toEqual([{ peerOwnerDid: f.peer.did, state: 'blocked' }]);
  expect(fs.existsSync(path + '.lock')).toBe(false);
});

it('keeps unchanged protocol observations serialized without rewriting or flushing coordination locks', () => {
  const f = fixture(), fsync = vi.fn(fs.fsyncSync), rename = vi.fn(fs.renameSync);
  const store = new ProtocolPeerStore(f.owner, { ...f.identityOptions, now: f.now, fs: { ...fs, fsyncSync: fsync, renameSync: rename } });
  const policy = { releasedAt: '2026-11-03T12:22:18Z', sendLegacyUntilDays: 90, receiveLegacyUntilDays: 180 } as const;
  const initial = store.observePolicy(policy), before = fs.readFileSync(store.path, 'utf8');
  // Actual state still receives its original flushed atomic publication.
  expect(fsync).toHaveBeenCalledTimes(1); expect(rename).toHaveBeenCalledTimes(1);
  fsync.mockClear(); rename.mockClear();
  expect(store.observePolicy(policy)).toEqual(initial);
  expect(fs.readFileSync(store.path, 'utf8')).toBe(before);
  expect(fsync).not.toHaveBeenCalled(); expect(rename).not.toHaveBeenCalled();
  // A held lock still excludes even a no-op; no unlocked floor/policy bypass.
  fs.writeFileSync(store.path + '.lock', '', { mode: 0o600 });
  try { expect(() => store.observePolicy(policy)).toThrow('PROTOCOL_STORE_BUSY'); }
  finally { fs.unlinkSync(store.path + '.lock'); }
});

it('yields and retries a contended protocol observation without sending or losing the committed floor', async () => {
  const f = fixture(), store = new ProtocolPeerStore(f.owner, { ...f.identityOptions, now: f.now });
  const policy = { releasedAt: '2026-11-03T12:22:18Z', sendLegacyUntilDays: 90, receiveLegacyUntilDays: 180 } as const;
  const expected = store.observePolicy(policy), bytes = fs.readFileSync(store.path, 'utf8');
  fs.writeFileSync(store.path + '.lock', '', { mode: 0o600 });
  const pending = retryDeliveryBusy(() => store.observePolicy(policy), undefined, 'PROTOCOL_STORE_BUSY');
  const timer = setTimeout(() => fs.unlinkSync(store.path + '.lock'), 150);
  try {
    expect(await pending).toEqual(expected);
    expect(fs.readFileSync(store.path, 'utf8')).toBe(bytes);
    expect(f.posted).toEqual([]);
  } finally { clearTimeout(timer); if (fs.existsSync(store.path + '.lock')) fs.unlinkSync(store.path + '.lock'); }
});
