// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import type { PathLike } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { createRelayAuthToken, digest, generateKeyPair, signEnvelope, signPayload } from '../packages/core/src/index.js';
import type { KeyPair, SignedEnvelope } from '../packages/core/src/index.js';
import { HttpRelayClient, RelayDuplicateEnvelopeError } from '../packages/relay/src/index.js';
import type { RelayTransport } from '../packages/relay/src/index.js';
import { createRelayFetchHandler, InMemoryRelay } from '../packages/relay/src/fetch.js';
import { GatewayDeliveryService } from '../packages/runtime/src/outbox.js';
import { WorkerNode, RequesterClient, PolicyAutoApprovalProvider, HeldRequestReview, buildTaskManifest } from '../packages/runtime/src/index.js';
import { countDeliveryFs, outboxFixture, outboxOrigin } from './outbox-fixture.js';
import { completeInspection } from './connections-fixture.js';
import { SessionWire } from '../packages/runtime/src/session-audit.js';
import { AcpMcpServer } from '../packages/runtime/src/mcp-server.js';
import { TaskJournal } from '../packages/runtime/src/task-journal.js';

const cleanups: Array<() => void> = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function fixture(...args: Parameters<typeof outboxFixture>) { const f = outboxFixture(...args); cleanups.push(f.cleanup); return f; }
const reset = () => Object.assign(new Error('fixture transport reset'), { code: 'ECONNRESET' });

describe('gateway envelope retry', () => {
  it('flushes concurrent same-URL sends independently with closed handles and no signer lock at flush time', async () => {
    const f = fixture(), io = f.service.store.io, sleep = vi.fn(async () => { throw new Error('UNEXPECTED_RETRY_SLEEP'); });
    const handles = new Map<number, string>(), staged = new Map<number, number>();
    const flushes: Array<{ fd: number; batch: number; done: (error: NodeJS.ErrnoException | null) => void }> = [];
    let opened = 0, ready!: () => void;
    const bothFlushing = new Promise<void>(resolve => { ready = resolve; });
    const windowsError = (code: string) => Object.assign(new Error(code), { code });
    const service = f.restart(f.owner, { sleep, identityOptions: { ...f.identityOptions, fs: { ...io,
      openSync: (path: PathLike, flags: string | number, mode?: Parameters<typeof io.openSync>[2]) => {
        const fd = io.openSync(path, flags, mode), name = String(path);
        handles.set(fd, name);
        if (name.endsWith('.tmp')) staged.set(fd, Math.floor(opened++ / 2));
        return fd;
      },
      closeSync: fd => { io.closeSync(fd); handles.delete(fd); },
      fsyncSync: fd => {
        // Model a flush that cannot finish while another writer needs the signer lock.
        if (existsSync(join(service.store.root, '.lock'))) throw windowsError('EBUSY');
        io.fsyncSync(fd);
      },
      fsync: Object.assign((fd: number, done: (error: NodeJS.ErrnoException | null) => void) => {
        expect(existsSync(join(service.store.root, '.lock'))).toBe(false);
        flushes.push({ fd, batch: staged.get(fd)!, done });
        if (flushes.length === 4) ready();
      }, { __promisify__: io.fsync.__promisify__ }),
      renameSync: (from, to) => {
        // Windows replacement fails if either pathname still has an open handle.
        if ([...handles.values()].some(path => path === String(from) || path === String(to))) throw windowsError('EPERM');
        io.renameSync(from, to);
      },
    } } });
    const wires = [0, 1].map(index => new SessionWire(f.relay, f.owner, f.peer.did, 'task_concurrent_' + index,
      [f.owner.did, f.peer.did], new AbortController().signal, undefined, false, false,
      { service, context: { ...f.prepare().context, message: undefined } }));
    const sending = wires.map(wire => wire.rawSend('ERROR', { code: 'FIXTURE' }));
    // Observe rejection immediately as well as awaiting the sends below.
    const settled = Promise.allSettled(sending);
    const release = async (batch: number) => {
      await Promise.all(flushes.filter(f => f.batch === batch).map(flush => new Promise<void>(resolve => {
        const done = flush.done; flush.done = () => {};
        io.fsync(flush.fd, error => { done(error); resolve(); });
      })));
    };
    try {
      await Promise.race([bothFlushing, settled.then(() => { throw new Error('SENDS_FINISHED_BEFORE_CONCURRENT_FLUSH'); })]);
      expect(f.posted).toEqual([]);
      expect(service.store.ids('batches')).toEqual([]);
      await release(1);
      await sending[1];
      expect(f.posted.map(e => (e as SignedEnvelope).payload.taskId)).toEqual(['task_concurrent_1']);
      // The first flush is still held; its independent peer has already completed.
      await release(0); await sending[0];
      expect(f.posted.map(e => (e as SignedEnvelope).payload.taskId)).toEqual(['task_concurrent_1', 'task_concurrent_0']);
      expect(sleep).not.toHaveBeenCalled();
      expect(service.store.ids('outbox')).toEqual([]);
      expect(handles.size).toBe(0);
    } finally {
      for (const flush of flushes) flush.done(windowsError('EBUSY'));
      await settled;
      wires.forEach(wire => wire.close());
    }
  });
  it.each(['EPERM', 'EBUSY'])('does not delay another same-URL send after a %s publication failure', async code => {
    const f = fixture(), io = f.service.store.io, sleep = vi.fn();
    let fail = true;
    const service = f.restart(f.owner, { sleep, identityOptions: { ...f.identityOptions, fs: { ...io,
      renameSync: (from, to) => {
        if (fail && basename(dirname(String(to))) === 'batches') {
          fail = false; throw Object.assign(new Error(code), { code });
        }
        io.renameSync(from, to);
      },
    } } });
    const p = f.prepare(true), q = f.prepare(true);
    await expect(service.enqueuePrepared(p.frames, p.context)).rejects.toThrow('OUTBOX_STORE_UNWRITABLE');
    expect(service.store.ids('batches')).toEqual([]);
    expect(f.posted).toEqual([]);
    const ids = await service.enqueuePrepared(q.frames, q.context);
    for (const id of ids) await service.sendPrepared(id);
    expect(f.posted).toEqual(q.frames);
    expect(sleep).not.toHaveBeenCalled();
    expect(existsSync(join(service.store.root, '.lock'))).toBe(false);
  });
  it('keeps one wire in sequence while its asynchronous publication yields', async () => {
    const f = fixture(), io = f.service.store.io, sleep = vi.fn();
    const held: Array<() => void> = [];
    let opened = 0, released = false, ready!: () => void;
    const flushing = new Promise<void>(resolve => { ready = resolve; });
    const service = f.restart(f.owner, { sleep, identityOptions: { ...f.identityOptions, fs: { ...io,
      openSync: (path: PathLike, flags: string | number, mode?: Parameters<typeof io.openSync>[2]) => {
        if (String(path).endsWith('.tmp')) opened++;
        return io.openSync(path, flags, mode);
      },
      fsync: Object.assign((fd: number, done: (error: NodeJS.ErrnoException | null) => void) => {
        if (!released && held.length < 2) {
          held.push(() => io.fsync(fd, done));
          if (held.length === 2) ready();
        } else io.fsync(fd, done);
      }, { __promisify__: io.fsync.__promisify__ }),
    } } });
    const wire = new SessionWire(f.relay, f.owner, f.peer.did, 'task_ordered', [f.owner.did, f.peer.did],
      new AbortController().signal, undefined, false, false,
      { service, context: { ...f.prepare().context, message: undefined } });
    const sending = Promise.all([wire.rawSend('ERROR', { code: 'FIRST' }), wire.rawSend('ERROR', { code: 'SECOND' })]);
    const release = () => { if (!released) { released = true; held.forEach(resume => resume()); } };
    try {
      await flushing;
      expect(opened).toBe(2);
      expect(f.posted).toEqual([]);
      release();
      await sending;
      expect(f.posted.map(e => (e as SignedEnvelope).payload.seq)).toEqual([0, 1]);
      expect(sleep).not.toHaveBeenCalled();
    } finally { release(); await Promise.allSettled([sending]); wire.close(); }
  });
  it('publishes neither a batch nor a receipt after an asynchronous flush failure', async () => {
    const f = fixture(), p = f.prepare(true), io = f.service.store.io;
    const service = f.restart(f.owner, { identityOptions: { ...f.identityOptions, fs: { ...io,
      fsync: Object.assign((_fd: number, done: (error: NodeJS.ErrnoException | null) => void) => {
        done(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
      }, { __promisify__: io.fsync.__promisify__ }),
    } } });
    await expect(service.enqueuePrepared(p.frames, p.context)).rejects.toThrow('OUTBOX_STORE_UNWRITABLE');
    await expect(service.store.receiptPrepared(p.first, p.context.deliveryDeadline, 'processed')).rejects.toThrow('OUTBOX_STORE_UNWRITABLE');
    expect(service.store.ids('batches')).toEqual([]);
    expect(service.store.ids('outbox')).toEqual([]);
    expect(service.store.ids('receipts')).toEqual([]);
    expect(f.posted).toEqual([]);
    expect(io.readdirSync(service.store.root, { recursive: true }).map(String).filter(path => path.endsWith('.tmp'))).toEqual([]);
    expect(existsSync(join(service.store.root, '.lock'))).toBe(false);
  });
  it('rechecks a receipt after its flush without replacing a concurrent terminal checkpoint', async () => {
    const f = fixture(), p = f.prepare(), io = f.service.store.io;
    let concurrent = false;
    const service = f.restart(f.owner, { identityOptions: { ...f.identityOptions, fs: { ...io,
      fsync: Object.assign((fd: number, done: (error: NodeJS.ErrnoException | null) => void) => {
        if (!concurrent) {
          concurrent = true;
          f.service.store.receipt(p.first, p.context.deliveryDeadline, 'terminal');
        }
        io.fsync(fd, done);
      }, { __promisify__: io.fsync.__promisify__ }),
    } } });
    await service.store.receiptPrepared(p.first, p.context.deliveryDeadline, 'processed');
    expect(service.store.read('receipts', p.first.payload.envelopeId)?.state).toBe('terminal');
    expect(io.readdirSync(service.store.root, { recursive: true }).map(String).filter(path => path.endsWith('.tmp'))).toEqual([]);
  });
  it('rechecks capacity when concurrently flushed batches publish', async () => {
    const f = fixture({ limits: { activeEnvelopes: 2 } });
    const batches = [f.prepare(true), f.prepare(true)];
    const results = await Promise.allSettled(batches.map(p => f.service.enqueuePrepared(p.frames, p.context)));
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { message: 'OUTBOX_FULL' } });
    expect(f.service.store.ids('outbox')).toHaveLength(2);
    expect(f.service.store.ids('batches')).toHaveLength(1);
    expect(f.posted).toEqual([]);
  });
  it('discards flushed preparation after cancellation without publication or transmission', async () => {
    const f = fixture(), p = f.prepare(), io = f.service.store.io;
    let controller = new AbortController();
    const service = f.restart(f.owner, { identityOptions: { ...f.identityOptions, fs: { ...io,
      fsync: Object.assign((fd: number, done: (error: NodeJS.ErrnoException | null) => void) => {
        io.fsync(fd, error => { controller.abort(new Error('FIXTURE_CANCEL')); done(error); });
      }, { __promisify__: io.fsync.__promisify__ }),
    } } });
    await expect(service.enqueuePrepared(p.frames, p.context, controller.signal)).rejects.toThrow('FIXTURE_CANCEL');
    controller = new AbortController();
    await expect(service.store.receiptPrepared(p.first, p.context.deliveryDeadline, 'processed', controller.signal)).rejects.toThrow('FIXTURE_CANCEL');
    for (const kind of ['outbox', 'batches', 'messages', 'receipts'] as const) expect(service.store.ids(kind)).toEqual([]);
    expect(f.posted).toEqual([]);
    expect(io.readdirSync(service.store.root, { recursive: true }).map(String).filter(path => path.endsWith('.tmp'))).toEqual([]);
  });
  it('bounds enqueue, send and receipt work independently of an unrelated pending backlog', async () => {
    const f = fixture(), counted = countDeliveryFs(f.service.store.io);
    const service = f.restart(f.owner, { identityOptions: { ...f.identityOptions, fs: counted.fs } });
    // Exceed the verified-record cache so this also detects rereading unrelated ciphertext.
    for (let i = 0; i < 100; i++) {
      const p = f.prepare(true); service.enqueue(p.frames, p.context);
    }
    const p = f.prepare(true);
    counted.reset();
    const ids = service.enqueue(p.frames, p.context);
    expect(counted.total()).toBeLessThanOrEqual(24);
    expect(counted.counts.fsyncSync).toBe(4); // two envelopes, message and publication marker
    expect(counted.counts.readdirSync).toBe(0);
    const batchId = service.store.read('outbox', ids[0])!.batchId;
    for (const id of ids) {
      counted.reset();
      await service.sendPrepared(id);
      expect(counted.total()).toBeLessThanOrEqual(14);
      expect(counted.counts.fsyncSync).toBe(0);
      expect(counted.counts.readdirSync).toBe(0);
    }
    counted.reset();
    service.finishBatch(batchId);
    expect(counted.total()).toBeLessThanOrEqual(8);
    counted.reset();
    service.store.receipt(p.first, p.context.deliveryDeadline, 'processed');
    expect(counted.total()).toBeLessThanOrEqual(10);
    expect(counted.counts.fsyncSync).toBe(1);
    // An already recorded acknowledgement does not rewrite or flush its receipt.
    counted.reset();
    service.store.receipt(p.first, p.context.deliveryDeadline, 'processed');
    expect(counted.counts.writeSync).toBe(0);
    expect(counted.counts.fsyncSync).toBe(0);
  });
  it('yields while preparing a recovered index and performs no transport work', async () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) { const p = f.prepare(true); f.service.enqueue(p.frames, p.context); }
    const counted = countDeliveryFs(f.service.store.io), resolveTransport = vi.fn(f.service.options.resolveTransport);
    const restarted = f.restart(f.owner, { identityOptions: { ...f.identityOptions, fs: counted.fs }, resolveTransport });
    const controller = new AbortController();
    let completed = false;
    const preparing = restarted.prepare(controller.signal).then(() => { completed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(completed).toBe(false);
    expect(counted.counts.readSync).toBeLessThanOrEqual(2);
    controller.abort(new Error('FIXTURE_STOP'));
    await expect(preparing).rejects.toThrow('FIXTURE_STOP');
    expect(resolveTransport).not.toHaveBeenCalled();
    expect(f.posted).toEqual([]);
  });
  it('yields between maintenance records and stops a maintenance pass on shutdown', async () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) { const p = f.prepare(true); f.service.enqueue(p.frames, p.context); }
    f.setNow(f.epoch + 86400_000);
    const controller = new AbortController(), errors = vi.fn();
    const maintenance = f.service.store.maintainInBackground(errors, controller.signal);
    await new Promise<void>(resolve => setImmediate(resolve));
    controller.abort();
    await maintenance;
    expect(f.service.store.ids('batches').length).toBeGreaterThan(0);
    expect(f.service.store.ids('batches').length).toBeLessThan(8);
    expect(errors).not.toHaveBeenCalled();
    expect(f.posted).toEqual([]);
    f.service.store.maintain();
    expect(f.service.store.ids('batches')).toEqual([]);
  });
  it('recovers an unflushed admission update by replaying the original envelope only', async () => {
    const f = fixture(), p = f.prepare(), base = new InMemoryRelay({ now: f.now });
    const handler = createRelayFetchHandler({ relay: base });
    const client = new HttpRelayClient(outboxOrigin, (input, init) => handler(new Request(input, init)), f.owner);
    f.relay.send = e => client.send(e);
    f.service.enqueue(p.frames, p.context);
    const path = f.service.store.path('outbox', p.first.payload.envelopeId), original = readFileSync(path);
    await f.service.sendPrepared(p.first.payload.envelopeId);
    // Model loss of bookkeeping after durable enqueue while the relay retained admission.
    f.service.store.io.writeFileSync(path, original);
    const restarted = f.restart();
    await restarted.drainDue();
    expect(base.snapshot().queues.flatMap(q => q[1])).toHaveLength(1);
    expect(restarted.store.read('outbox', p.first.payload.envelopeId)).toMatchObject({ state: 'admitted', envelope: p.first });
  });
  it('defers batch cleanup after a temporary unlink failure without changing admission', async () => {
    const f = fixture(), p = f.prepare(), errors = vi.fn(), io = f.service.store.io;
    let refuseUnlink = true;
    const service = f.restart(f.owner, { identityOptions: { ...f.identityOptions, fs: {
      ...io, unlinkSync: (path: PathLike) => {
        if (refuseUnlink && dirname(String(path)) === join(service.store.root, 'batches'))
          throw Object.assign(new Error('fixture unlink'), { code: 'EPERM' });
        io.unlinkSync(path);
      },
    } }, onError: errors });
    const wire = new SessionWire(f.relay, f.owner, f.peer.did, 'task_cleanup', [f.owner.did, f.peer.did],
      new AbortController().signal, undefined, false, false,
      { service, context: { ...p.context, message: undefined } });
    try {
      await expect(wire.rawSend('ERROR', { code: 'TASK_INTERRUPTED' })).resolves.toBeUndefined();
      expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: 'OUTBOX_STORE_UNWRITABLE' }));
      expect(service.store.snapshot('outbox')).toMatchObject([{ state: 'admitted' }]);
      expect(f.posted).toHaveLength(1);
      refuseUnlink = false;
      service.store.maintain();
      expect(service.store.ids('outbox')).toEqual([]);
      expect(service.store.ids('batches')).toEqual([]);
      expect(f.posted).toHaveLength(1);
    } finally { wire.close(); }
  });
  it('recovers an outage at exact spaced intervals with unchanged signed bytes and one relay entry', async () => {
    const f = fixture(), p = f.prepare(), times: number[] = [], sent: SignedEnvelope[] = [];
    const base = new InMemoryRelay({ now: f.now, envelopeTtlMs: 86400_000 });
    const handler = createRelayFetchHandler({ relay: base });
    const client = new HttpRelayClient(outboxOrigin, async (input, init) => {
      times.push(f.now() - f.epoch); sent.push(JSON.parse(String(init?.body)) as SignedEnvelope);
      if (sent.length <= 5) throw reset(); return handler(new Request(input, init));
    }, f.owner);
    f.relay.send = e => client.send(e);
    f.service.enqueue(p.frames, p.context);
    await f.service.sendPrepared(p.first.payload.envelopeId);
    expect(times).toEqual([0, 60_000, 360_000, 1260_000, 4860_000, 8460_000]);
    expect(f.sleeps).toEqual([60_000, 300_000, 900_000, 3600_000, 3600_000]);
    expect(sent.every(e => digest(e) === digest(p.first) && JSON.stringify(e) === JSON.stringify(p.first))).toBe(true);
    expect(base.snapshot().queues.flatMap(q => q[1])).toHaveLength(1);
    expect(f.service.store.getMessage(p.context.messageId)?.status).toBe('relayed');
    await f.service.drainDue(); expect(sent).toHaveLength(6);
  });
  it.each(['contract', 'older', 'malformed', 'oversized', 'extra'] as const)('retains the same envelope on a %s 429 response and admits once', async variant => {
    const f = fixture(), p = f.prepare(), base = new InMemoryRelay({ now: f.now });
    const handler = createRelayFetchHandler({ relay: base }); let count = 0;
    const bodies: Record<typeof variant, string> = {
      contract: JSON.stringify({ error: 'RELAY_RETRY_LATER', retryable: true, retryAfterMs: 60_000 }),
      older: '', malformed: 'unparsed response', oversized: 'x'.repeat(2048),
      extra: JSON.stringify({ error: 'RELAY_RETRY_LATER', retryable: true, retryAfterMs: 300_000, extra: true }),
    };
    const fetcher: typeof fetch = async (input, init) => {
      count++;
      if (count === 1) return new Response(bodies[variant], { status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '60', 'cache-control': 'no-store' } });
      return handler(new Request(input, init));
    };
    const client = new HttpRelayClient(outboxOrigin, fetcher, f.owner);
    f.relay.send = e => client.send(e);
    f.service.enqueue(p.frames, p.context);
    await f.service.drainDue();
    const retained = f.service.store.read('outbox', p.first.payload.envelopeId)!;
    expect(retained.state).toBe('pending'); expect(retained.deliveryDeadline).toBe(p.context.deliveryDeadline);
    expect(retained.envelope).toEqual(p.first); expect(base.snapshot().queues).toEqual([]);
    expect(retained.nextAttemptAt - f.epoch).toBe(60_000);
    await f.service.sendPrepared(p.first.payload.envelopeId);
    expect(count).toBe(2); expect(base.snapshot().queues.flatMap(q => q[1])).toHaveLength(1);
    if (variant === 'contract') {
      const next = f.prepare(); let hintedCalls = 0;
      const hinted = new HttpRelayClient(outboxOrigin, async (input, init) => ++hintedCalls === 1
        ? new Response(JSON.stringify({ error: 'RELAY_RETRY_LATER', retryable: true, retryAfterMs: 300_000 }), {
          status: 429, headers: { 'content-type': 'application/json', 'retry-after': '300', 'cache-control': 'no-store' } })
        : handler(new Request(input, init)), f.owner);
      f.relay.send = e => hinted.send(e);
      f.service.enqueue(next.frames, next.context); await f.service.drainDue();
      expect(f.service.store.read('outbox', next.first.payload.envelopeId)?.nextAttemptAt).toBe(f.now() + 300_000);
      await f.service.sendPrepared(next.first.payload.envelopeId);
      expect(hintedCalls).toBe(2); expect(f.sleeps.at(-1)).toBe(300_000);
    }
  });
  it('normalizes exact admission diagnostics and bounds hints without copying response text', async () => {
    const f = fixture(), frame = f.frame();
    for (const hint of [60_000, 3600_000, 0, -1, 3600_001, 1.5]) {
      const client = new HttpRelayClient(outboxOrigin, async () => new Response(JSON.stringify({ error: 'RELAY_RETRY_LATER', retryable: true, retryAfterMs: hint }), { status: 429 }), f.owner);
      await expect(client.send(frame)).rejects.toMatchObject({ message: 'RELAY_REJECTED: 429', status: 429,
        code: 'RELAY_RETRY_LATER', retryAfterMs: hint >= 1 && hint <= 3600_000 && Number.isInteger(hint) ? hint : undefined });
    }
  });
  it('recognizes lost admission only through the exact replay response and never reposts after admission', async () => {
    const f = fixture(), p = f.prepare(), base = new InMemoryRelay({ now: f.now });
    const handler = createRelayFetchHandler({ relay: base }); let calls = 0;
    const client = new HttpRelayClient(outboxOrigin, async (input, init) => {
      const result = await handler(new Request(input, init)); if (++calls === 1) throw reset(); return result;
    }, f.owner);
    f.relay.send = e => client.send(e);
    f.service.enqueue(p.frames, p.context);
    await f.service.sendPrepared(p.first.payload.envelopeId);
    expect(calls).toBe(2); expect(base.snapshot().queues.flatMap(q => q[1])).toHaveLength(1);
    await expect(client.send(p.first)).rejects.toBeInstanceOf(RelayDuplicateEnvelopeError);
    const admitted = f.service.store.read('outbox', p.first.payload.envelopeId)!;
    expect(admitted).toMatchObject({ state: 'admitted', attemptCount: 2 });
    const before = calls; f.setNow(f.now() + 100_000); await f.service.drainDue(); expect(calls).toBe(before);
    expect(admitted.relayDid).toBeUndefined();
  });
  it('retains the admission identity for verified relay expiry observations across transport instances', async () => {
    const f = fixture(), base = new InMemoryRelay({ now: f.now });
    const handler = createRelayFetchHandler({ relay: base });
    const fetcher: typeof fetch = (input, init) => handler(new Request(input, init));
    const sender = new HttpRelayClient(outboxOrigin, fetcher, f.owner), observer = new HttpRelayClient(outboxOrigin, fetcher, f.owner);
    const posted: SignedEnvelope[] = [];
    const service = f.restart(f.owner, { resolveTransport: () => ({
      send: envelope => { posted.push(envelope); return sender.send(envelope); },
      receive: () => undefined, getDeliveryStatusPin: id => sender.getDeliveryStatusPin(id),
    }) });
    const sent: SignedEnvelope[] = [];
    const wire = new SessionWire({ send: e => { sent.push(e); }, receive: () => undefined,
      restoreDeliveryStatusPin: (id, did) => observer.restoreDeliveryStatusPin(id, did) }, f.owner, f.peer.did,
      'task_pin', [f.owner.did, f.peer.did], new AbortController().signal, undefined, false, false,
      { service, context: { messageId: f.frame().payload.envelopeId, peerOwnerDid: f.peer.did, relayUrl: outboxOrigin, deliveryDeadline: f.epoch + 86400_000 } });
    try {
      await wire.rawSend('ERROR', { code: 'TASK_INTERRUPTED' });
      const envelope = posted[0];
      expect(observer.getDeliveryStatusPin(envelope.payload.envelopeId)).toBeTruthy();
      expect((await observer.deliveryStatus(envelope))?.payload.state).toBe('pending'); expect(sent).toEqual([]);
      expect(service.store.snapshot('outbox')).toEqual([]);
    } finally { wire.close(); }
  });
  it.each(['plain', 'extra', 'large'] as const)('keeps %s HTTP 400 terminal', async variant => {
    const f = fixture(), p = f.prepare(); let count = 0;
    const client = new HttpRelayClient(outboxOrigin, async () => {
      count++; return new Response(variant === 'plain' ? '{"error":"INVALID_ENVELOPE"}' : variant === 'extra'
        ? '{"error":"REPLAYED_ENVELOPE","extra":true}' : 'x'.repeat(2048), { status: 400 });
    }, f.owner);
    f.relay.send = e => client.send(e); f.service.enqueue(p.frames, p.context);
    await expect(f.service.sendPrepared(p.first.payload.envelopeId)).rejects.toThrow('RELAY_REJECTED: 400');
    expect(count).toBe(1); expect(f.service.store.getMessage(p.context.messageId)?.status).toBe('closed');
  });
  it('resumes attempt count and immutable bytes under the same signer and data root', async () => {
    const f = fixture(), p = f.prepare(); f.relay.send = () => { throw reset(); };
    f.service.enqueue(p.frames, p.context); await f.service.drainDue(); f.service.stop();
    expect(f.service.store.getMessage(p.context.messageId)?.status).toBe('queued');
    f.relay.send = e => { f.posted.push(e); };
    const other = f.restart(generateKeyPair()); await other.start(); other.stop(); expect(f.posted).toEqual([]);
    const restarted = f.restart(); await restarted.start(); expect(f.posted).toEqual([]);
    f.setNow(f.epoch + 60_000); await restarted.drainDue(); restarted.stop();
    expect(f.posted).toEqual(p.frames);
    expect(restarted.store.read('outbox', p.first.payload.envelopeId)).toMatchObject({ state: 'admitted', attemptCount: 2, deliveryDeadline: p.context.deliveryDeadline });
  });
  it('respects outstanding attempt leases, recovers expiry, and ignores late holder completion', async () => {
    const f = fixture(), p = f.prepare();
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.relay.send = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); throw new Error('PERMANENT_FIXTURE'); };
    f.service.enqueue(p.frames, p.context);
    const first = f.service.drainDue(); await started;
    const second = f.restart(f.owner, { resolveTransport: () => ({ send: e => { f.posted.push(e); }, receive: () => undefined }) });
    await second.drainDue(); expect(f.posted).toEqual([]);
    f.setNow(f.epoch + 60_000); await second.drainDue();
    expect(f.posted).toEqual([p.first]);
    release(); await first;
    expect(f.service.store.read('outbox', p.first.payload.envelopeId)).toMatchObject({ state: 'admitted', attemptCount: 2 });
    expect(f.service.store.getMessage(p.context.messageId)?.status).toBe('relayed');
  });
  it.each([-1, 0, 1])('enforces original deadline at offset %i without renewing it at restart', async offset => {
    const f = fixture(), p = f.prepare(); f.service.enqueue(p.frames, p.context); f.service.stop();
    f.setNow(p.context.deliveryDeadline + offset);
    const restarted = f.restart(); await restarted.start(); restarted.stop();
    expect(f.posted).toHaveLength(offset < 0 ? 1 : 0);
    expect(restarted.store.getMessage(p.context.messageId)?.status).toBe(offset < 0 ? 'relayed' : 'closed');
    expect(restarted.store.getMessage(p.context.messageId)?.deliveryDeadline).toBe(p.context.deliveryDeadline);
  });
  it('preserves the session task-timeout outcome when its durable transport reaches the deadline first', async () => {
    const f = fixture(), p = f.prepare(); f.setNow(p.context.deliveryDeadline);
    const wire = new SessionWire(f.relay, f.owner, f.peer.did, 'task_timeout', [f.owner.did, f.peer.did],
      new AbortController().signal, undefined, false, false, { service: f.service, context: { ...p.context, message: undefined } });
    try { await expect(wire.rawSend('ERROR', { code: 'TASK_INTERRUPTED' })).rejects.toThrow('TASK_TIMEOUT'); expect(f.posted).toEqual([]); }
    finally { wire.close(); }
  });
  it('keeps ordered audit members together and honors changed outbound policy before retry', async () => {
    const f = fixture(), p = f.prepare(true), policy = vi.fn(); let allowed = true;
    const service = f.restart(f.owner, { assertSendAllowed: () => { policy(); if (!allowed) throw new Error('PEER_NOT_ALLOWED'); } });
    let calls = 0; f.relay.send = e => { if (++calls === 1) throw reset(); f.posted.push(e); };
    service.enqueue(p.frames, p.context); await service.drainDue();
    expect(calls).toBe(1); expect(f.posted).toEqual([]);
    allowed = false; f.setNow(f.epoch + 60_000); await service.drainDue();
    expect(calls).toBe(1); expect(policy).toHaveBeenCalledTimes(2);
    expect(service.store.snapshot('outbox').every(r => r.state === 'closed')).toBe(true);
  });
  it('stops retrying at authenticated persistence or explicit cancellation while stop alone preserves work', async () => {
    const f = fixture(), p = f.prepare(); f.service.enqueue(p.frames, p.context);
    f.service.markPeerObserved(p.context.messageId, { status: 'received_held', envelopeId: p.context.messageId });
    await f.service.drainDue(); expect(f.posted).toEqual([]);
    expect(f.service.store.getMessage(p.context.messageId)?.status).toBe('received_held');
    const q = f.prepare(); f.service.enqueue(q.frames, q.context); f.service.closeMessage(q.context.messageId);
    await f.service.drainDue(); expect(f.posted).toEqual([]);
    expect(f.service.store.getMessage(q.context.messageId)?.status).toBe('closed');
    f.setNow(p.context.deliveryDeadline + 1); expect(f.service.store.getMessage(p.context.messageId)?.status).toBe('received_held');
  });
  it('suppresses processed duplicates before wire counters and replays the prior audit acknowledgement', async () => {
    const f = fixture(), taskId = 'task_receipt', queue: SignedEnvelope[] = [], posted: SignedEnvelope[] = [];
    const relay: RelayTransport = { send: e => { posted.push(e); }, receive: () => queue.shift() };
    const service = f.restart(f.owner, { resolveTransport: () => relay });
    const event = signEnvelope({ taskId, recipientDid: f.owner.did, seq: 0, eventType: 'START', payload: {} }, f.peer, { encrypt: true });
    const body = { taskId, seq: 0, prevEntryHash: null, actorDid: f.peer.did, receiverDid: f.owner.did, eventType: 'START', payload: {} };
    const audit = signEnvelope({ taskId, recipientDid: f.owner.did, seq: 1, eventType: 'AUDIT_ENTRY', payload: signPayload(body, f.peer) as never }, f.peer, { encrypt: true });
    queue.push(event, audit);
    const wire = new SessionWire(relay, f.owner, f.peer.did, taskId, [f.peer.did, f.owner.did], new AbortController().signal,
      undefined, false, false, { service, context: { messageId: event.payload.envelopeId, peerOwnerDid: f.peer.did,
        relayUrl: outboxOrigin, deliveryDeadline: f.epoch + 86400_000 } });
    try {
      await wire.receiveEvent('START');
      expect(service.store.read('receipts', event.payload.envelopeId)?.state).toBe('processed');
      queue.push(event, audit, signEnvelope({ taskId, recipientDid: f.owner.did, seq: 2, eventType: 'ERROR', payload: { code: 'REQUEST_DENIED' } }, f.peer, { encrypt: true }));
      await expect(wire.rawReceive('DELIVER')).rejects.toMatchObject({ code: 'REQUEST_DENIED' });
      expect(posted).toHaveLength(3); expect(posted[1]).toEqual(posted[0]); expect(posted[2]).toEqual(posted[0]);
    } finally { wire.close(); }
  });
});

function sessionFixture(inspection: boolean, loseResponse = false) {
  const f = fixture(), base = new InMemoryRelay({ now: f.now, seenTtlMs: 1, envelopeTtlMs: 86400_000 });
  const handler = createRelayFetchHandler({ relay: base });
  const frames: SignedEnvelope[] = [];
  const acknowledgements: string[] = [];
  let lost = false, calls = 0;
  function transport(key: KeyPair): RelayTransport {
    const http = new HttpRelayClient(outboxOrigin, async (input, init) => {
      const response = await handler(new Request(input, init));
      if (loseResponse && !lost && JSON.parse(String(init?.body)).payload.eventType === 'PROPOSE') { lost = true; throw reset(); }
      return response;
    }, key);
    return { send: e => { frames.push(structuredClone(e)); return http.send(e); },
      receive: (did, _ms, signal, filter) => base.receive(did, undefined, signal, undefined, filter),
      acknowledgeDelivery: (did, id) => { acknowledgements.push(id); base.acknowledge(did, id, createRelayAuthToken(key)); } };
  }
  const senderRelay = transport(f.owner), workerRelay = transport(f.peer);
  let persistedBeforeRetry = false;
  const senderService = f.restart(f.owner, { resolveTransport: () => senderRelay, sleep: async ms => {
    if (loseResponse && !persistedBeforeRetry) {
      await vi.waitFor(() => expect(workerService.store.read('receipts', frames.find(e => e.payload.eventType === 'PROPOSE')!.payload.envelopeId)).toBeDefined());
      persistedBeforeRetry = true;
    }
    f.sleeps.push(ms); f.setNow(f.now() + ms);
  } });
  const workerService = f.restart(f.peer, { resolveTransport: () => workerRelay });
  const approve = new PolicyAutoApprovalProvider(f.peer);
  function worker() {
    const node = new WorkerNode({ owner: f.peer, relay: workerRelay, relayUrl: outboxOrigin, deliveryService: workerService,
      identityOptions: f.identityOptions, now: f.now, taskTimeoutMs: 86400_000,
      heldReview: new HeldRequestReview(f.peer, { ...f.identityOptions, now: f.now, provider: inspection ? completeInspection : undefined }),
      approvalProvider: approve, ownerApprovalProvider: { approve: approve.approve.bind(approve) },
      adapter: { id: 'echo', name: 'Echo', skills: [], executeTask: async ctx => { calls++; return ctx.input; } } });
    cleanups.push(() => node.stop()); return node;
  }
  const client = new RequesterClient({ owner: f.owner, relay: senderRelay, pendingRelayUrl: outboxOrigin,
    deliveryService: senderService, identityOptions: f.identityOptions,
    taskTimeoutMs: 86400_000, approvalProvider: new PolicyAutoApprovalProvider(f.owner) });
  return { ...f, base, frames, acknowledgements, worker, client, senderService, workerService, calls: () => calls,
    persistedBeforeRetry: () => persistedBeforeRetry };
}

describe('durable session integration', () => {
  it('settles sequential and concurrent delegates across two HTTP relay bindings without a listener', async () => {
    const f = fixture();
    const counted = countDeliveryFs(f.service.store.io);
    const io = counted.fs;
    let lockedRoot: string | undefined, repeatedReads = 0;
    const transactionReads = new Set<string>();
    const identityOptions = { ...f.identityOptions, fs: { ...io,
      openSync: (path: PathLike, flags: string | number, mode?: Parameters<typeof io.openSync>[2]) => {
        const fd = io.openSync(path, flags, mode);
        const name = String(path);
        if (basename(name) === '.lock' && basename(dirname(dirname(name))) === 'delivery') {
          lockedRoot = dirname(name); transactionReads.clear();
        } else if (lockedRoot && name.startsWith(lockedRoot + sep) && name.endsWith('.json')) {
          if (transactionReads.has(name)) repeatedReads++;
          transactionReads.add(name);
        }
        return fd;
      },
      unlinkSync: (path: PathLike) => {
        io.unlinkSync(path);
        if (lockedRoot && String(path) === join(lockedRoot, '.lock')) lockedRoot = undefined;
      },
    } };
    const origins = ['https://relay-0.example', 'https://relay-1.example'];
    const handlers = origins.map(() => createRelayFetchHandler({ relay: new InMemoryRelay({ now: f.now }) }));
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const index = origins.indexOf(new URL(request.url).origin);
      expect(index).toBeGreaterThanOrEqual(0);
      // HTTP requests yield to other sessions before the relay handles the request.
      await new Promise<void>(resolve => setImmediate(resolve));
      return handlers[index](request);
    });
    const workers = origins.map(relay => {
      const owner = generateKeyPair();
      const worker = new WorkerNode({ owner, relay, identityOptions, now: f.now,
        taskTimeoutMs: 86400_000, checkPeer: () => 'trusted',
        adapter: { id: 'echo', name: 'Echo', skills: [], executeTask: async context => context.input },
        approvalProvider: new PolicyAutoApprovalProvider(owner) });
      cleanups.push(() => worker.stop());
      return worker;
    });
    const client = new RequesterClient({ owner: f.owner, identityOptions, now: f.now,
      taskTimeoutMs: 86400_000, approvalProvider: new PolicyAutoApprovalProvider(f.owner) });
    cleanups.push(() => client.stopDelivery());
    const running = workers.map(worker => worker.start());
    const call = (index: number) => client.delegate({ to: workers[index].invite(), title: 'Relay binding',
      description: 'Synthetic relay fixture', input: { index } });
    try {
      const assertWork = (delegations: number) => {
        expect(counted.total()).toBeLessThanOrEqual(850 * delegations);
        expect(counted.counts.fsyncSync + counted.asyncCounts.fsync).toBeLessThanOrEqual(60 * delegations);
        expect(counted.asyncCounts.fsync).toBe(54 * delegations);
        expect(counted.counts.readdirSync).toBeLessThanOrEqual(12 * delegations);
        // Ancestor checks include the platform-specific temporary-directory depth.
        expect(counted.counts.lstatSync).toBeLessThanOrEqual(12000 * delegations);
        counted.reset();
      };
      counted.reset();
      expect((await call(0)).state).toBe('SETTLED');
      assertWork(1);
      expect((await call(1)).state).toBe('SETTLED');
      assertWork(1);
      const fresh = new RequesterClient({ ...client.options });
      cleanups.push(() => fresh.stopDelivery());
      expect((await fresh.delegate({ to: workers[1].invite(), title: 'Fresh client',
        description: 'Same signer and relay binding', input: { index: 1 } })).state).toBe('SETTLED');
      assertWork(1);
      // Completed history must not be revalidated by later sends under either binding.
      expect(client.deliveryService!.store.ids('outbox')).toEqual([]);
      expect(client.deliveryService!.store.ids('batches')).toEqual([]);
      expect((await Promise.all([call(0), call(1)])).map(r => r.state)).toEqual(['SETTLED', 'SETTLED']);
      assertWork(2);
      expect((await Promise.all([call(0), call(0)])).map(r => r.state)).toEqual(['SETTLED', 'SETTLED']);
      assertWork(2);
      expect(client.deliveryService!.store.ids('outbox')).toEqual([]);
      expect(workers.every(worker => worker.deliveryService!.store.ids('outbox').length === 0)).toBe(true);
      // Repeated synchronous reads under the same lock delay every concurrent session.
      // Count work instead of imposing a machine-dependent task deadline.
      expect(repeatedReads).toBe(0);
    } finally {
      workers.forEach(worker => worker.stop());
      await Promise.allSettled(running);
    }
  }, 60_000);
  it('holds one proposal after an outage without adapter or owner opening, and never resubmits a pending task', async () => {
    const f = sessionFixture(false), worker = f.worker();
    let attempts = 0;
    const send = f.senderService.options.resolveTransport;
    f.senderService.options.resolveTransport = async (...args) => { if (++attempts === 1) throw reset(); return send(...args); };
    const beforePropose = vi.fn(async () => {}), beforeTransmit = vi.fn();
    const [result] = await Promise.allSettled([f.client.delegate({ to: f.peer.did, title: 'Hold', description: 'Hold', input: { text: 'held' }, beforePropose, beforeTransmit }), worker.start({ once: true })]);
    expect(result).toMatchObject({ status: 'rejected', reason: { code: 'PENDING_OWNER_APPROVAL', retryable: false } });
    expect(worker.heldReview.list()).toHaveLength(1); expect(f.calls()).toBe(0);
    expect(beforePropose).toHaveBeenCalledOnce(); expect(beforeTransmit).toHaveBeenCalledOnce();
    const proposals = f.frames.filter(e => e.payload.eventType === 'PROPOSE'); expect(proposals).toHaveLength(1);
    expect(f.senderService.store.getMessage(proposals[0].payload.envelopeId)?.status).toBe('received_held');
    await f.senderService.drainDue(); expect(f.frames.filter(e => e.payload.eventType === 'PROPOSE')).toHaveLength(1);
  });
  it('executes once through a lost POST response, replay-record expiry and receiver restart with the default journal', async () => {
    const f = sessionFixture(true, true), first = f.worker();
    first.options.dailyLimit = { path: join(f.root, 'daily.json'), maxTasks: 1 };
    const beforePropose = vi.fn(async () => {}), beforeTransmit = vi.fn();
    const [settled] = await Promise.all([f.client.delegate({ to: first.invite(), title: 'Once', description: 'Once', input: { value: 1 }, beforePropose, beforeTransmit }), first.start({ once: true })]);
    expect(settled.state).toBe('SETTLED'); expect(f.calls()).toBe(1);
    expect(f.persistedBeforeRetry()).toBe(true);
    expect(beforePropose).toHaveBeenCalledOnce(); expect(beforeTransmit).toHaveBeenCalledOnce();
    const proposals = f.frames.filter(e => e.payload.eventType === 'PROPOSE'); expect(proposals).toHaveLength(2);
    expect(proposals[0]).toEqual(proposals[1]);
    const journal = join(f.workerService.store.root, 'tasks.jsonl'); expect(existsSync(journal)).toBe(true);
    expect(JSON.parse(readFileSync(journal, 'utf8').trim().split('\n').at(-1)!).payload.phase).toBe('terminal');
    first.stop(); f.setNow(f.now() + 60_000);
    f.base.send(proposals[0]);
    const restartedService = f.restart(f.peer, { resolveTransport: () => ({ send: e => f.base.send(e), receive: () => undefined }) });
    const restarted = new WorkerNode({ ...first.options, deliveryService: restartedService }); cleanups.push(() => restarted.stop());
    const recovered = await restarted.runOnce();
    expect(recovered).toMatchObject({ taskId: settled.taskId, state: 'SETTLED', deliverable: settled.deliverable, bundle: settled.bundle }); expect(f.calls()).toBe(1);
    expect(restartedService.store.read('receipts', proposals[0].payload.envelopeId)).toMatchObject({ envelopeDigest: digest(proposals[0]) });
    expect(JSON.parse(readFileSync(join(f.root, 'daily.json'), 'utf8')).tasks).toEqual([settled.taskId]);
    f.setNow(f.epoch + 86400_001);
    expect(f.senderService.store.getMessage(proposals[0].payload.envelopeId)?.status).toBe('replied');
  });
  it('completes a legacy encrypted session with a non-UUID proposal identifier', async () => {
    const f = sessionFixture(true), worker = f.worker(); worker.options.checkPeer = () => 'trusted';
    const relay: RelayTransport = { send: envelope => f.base.send(envelope.payload.eventType === 'PROPOSE'
      ? signPayload({ ...envelope.payload, envelopeId: 'legacy-proposal' }, f.owner) : envelope),
      receive: (did, _wait, signal, filter) => f.base.receive(did, undefined, signal, undefined, filter) };
    const legacy = new RequesterClient({ owner: f.owner, relay, taskTimeoutMs: 86400_000,
      approvalProvider: new PolicyAutoApprovalProvider(f.owner) });
    const [result] = await Promise.all([legacy.delegate({ to: f.peer.did, title: 'Legacy', description: 'Legacy', input: {} }), worker.start({ once: true })]);
    expect(result.state).toBe('SETTLED'); expect(f.calls()).toBe(1);
    expect(f.workerService.store.read('receipts', 'legacy-proposal')?.state).toBe('terminal');
  });
  it('reconciles a receipt-only interruption without executing an adapter', async () => {
    const f = sessionFixture(true), worker = f.worker();
    const manifest = buildTaskManifest({ ownerDid: f.owner.did, workerDid: f.peer.did, title: 'Interrupted', description: 'Interrupted', taskTimeoutMs: 86400_000 });
    const proposal = signEnvelope({ taskId: manifest.taskId, recipientDid: f.peer.did, seq: 0, eventType: 'PROPOSE',
      payload: { proposal: signPayload(manifest, f.owner), input: {}, capabilityChains: [] } as never }, f.owner, { encrypt: true });
    f.workerService.store.receipt(proposal, Date.parse(manifest.deadline), 'persisted'); f.base.send(proposal);
    await expect(worker.runOnce()).rejects.toThrow('TASK_INTERRUPTED'); expect(f.calls()).toBe(0);
  });
  it('records interruption from the default journal without repeating adapter invocation after restart', async () => {
    const f = sessionFixture(true), first = f.worker();
    let entered!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    const execute = vi.fn(async () => { entered(); return new Promise<never>(() => {}); });
    first.options.adapter.executeTask = execute;
    const stopped = Promise.allSettled([first.start({ once: true })]);
    const requested = f.client.delegate({ to: first.invite(), title: 'Interrupted', description: 'Interrupted', input: {} }).catch(error => error);
    await running; first.stop(); await stopped;
    const service = f.restart(f.peer, { resolveTransport: () => ({ send: e => f.base.send(e), receive: () => undefined }) });
    const restarted = new WorkerNode({ ...first.options, deliveryService: service }); cleanups.push(() => restarted.stop());
    const run = restarted.start();
    try {
      expect(await requested).toMatchObject({ code: 'TASK_INTERRUPTED' }); expect(execute).toHaveBeenCalledOnce();
      const journal = readFileSync(join(service.store.root, 'tasks.jsonl'), 'utf8').trim().split('\n');
      const record = JSON.parse(journal.at(-1)!).payload;
      expect(record.outcome.code).toBe('TASK_INTERRUPTED');
      if (record.workspace) cleanups.push(() => rmSync(record.workspace, { recursive: true, force: true }));
    } finally { restarted.stop(); await run; }
  });
  it.each(['APPROVAL_REJECTED', 'APPROVAL_TIMEOUT', 'APPROVAL_CHANNEL_UNAVAILABLE'])('queues and posts nothing on %s before-send failure', async code => {
    const f = sessionFixture(false);
    await expect(f.client.delegate({ to: f.peer.did, title: 'Approval', description: 'Approval', input: {}, beforePropose: async () => {
      expect(f.senderService.store.ids('outbox')).toEqual([]); throw new Error(code);
    } })).rejects.toThrow(code);
    expect(f.senderService.store.ids('outbox')).toEqual([]); expect(f.frames).toEqual([]);
  });
  it('publishes nothing when the final transmission reservation fails', async () => {
    const f = sessionFixture(false), beforeTransmit = vi.fn(() => { throw new Error('INVALID_LEASE'); });
    await expect(f.client.delegate({ to: f.peer.did, title: 'Lease', description: 'Lease', input: {}, beforeTransmit })).rejects.toThrow('INVALID_LEASE');
    expect(beforeTransmit).toHaveBeenCalledOnce(); expect(f.senderService.store.ids('outbox')).toEqual([]); expect(f.frames).toEqual([]);
  });
  it('rejects exhausted metadata capacity before another owner approval', async () => {
    const f = sessionFixture(false), p = f.prepare(), beforePropose = vi.fn(async () => {});
    f.senderService.store.limits.activeEnvelopes = 1;
    f.senderService.enqueue(p.frames, p.context);
    await expect(f.client.delegate({ to: f.peer.did, title: 'Full', description: 'Full', input: {}, beforePropose })).rejects.toThrow('OUTBOX_FULL');
    expect(beforePropose).not.toHaveBeenCalled(); expect(f.frames).toEqual([]);
    expect(f.senderService.store.snapshot('outbox')).toHaveLength(1);
  });
  it('leaves anonymous injected library transports ephemeral and lifecycle/list operations offline', async () => {
    const f = fixture(), send = vi.fn(), receive = vi.fn();
    const client = new RequesterClient({ owner: f.owner, relay: { send, receive } });
    await client.startDelivery(); client.stopDelivery(); expect(client.deliveryService).toBeUndefined();
    expect(send).not.toHaveBeenCalled(); expect(receive).not.toHaveBeenCalled();
    expect(existsSync(join(f.root, 'data'))).toBe(false);
  });
  it('keeps MCP initialization and tool listing offline with approved retry-due work until explicit lifecycle startup', async () => {
    const f = fixture(), p = f.prepare(), resolveTransport = vi.fn(f.service.options.resolveTransport);
    const service = f.restart(f.owner, { resolveTransport }); service.enqueue(p.frames, p.context);
    const server = new AcpMcpServer({ owner: f.owner, deliveryService: service, identityOptions: f.identityOptions });
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(resolveTransport).not.toHaveBeenCalled(); expect(f.posted).toEqual([]);
    try { await server.startDelivery(); expect(resolveTransport).toHaveBeenCalledOnce(); expect(f.posted).toEqual(p.frames); }
    finally { server.stopDelivery(); }
  });
  it('does not execute or acknowledge a proposal when durable receipt capacity is unavailable', async () => {
    const f = sessionFixture(true), worker = f.worker();
    f.workerService.store.limits.receipts = 1;
    const held = signEnvelope({ taskId: 'prior', recipientDid: f.peer.did, seq: 0, eventType: 'PROPOSE', payload: {} }, f.owner, { encrypt: true });
    f.workerService.store.receipt(held, f.epoch + 86400_000, 'persisted');
    const [result] = await Promise.allSettled([f.client.delegate({ to: worker.invite(), title: 'Full', description: 'Full', input: {} }), worker.start({ once: true })]);
    expect(result).toMatchObject({ status: 'rejected', reason: { code: 'OUTBOX_FULL' } });
    expect(f.calls()).toBe(0); expect(f.workerService.store.ids('receipts')).toEqual([held.payload.envelopeId]);
    const proposal = f.frames.find(e => e.payload.eventType === 'PROPOSE')!;
    expect(f.acknowledgements).not.toContain(proposal.payload.envelopeId);
  });
  it('compacts the default journal during active maintenance while retaining live and receipt-backed checkpoints', async () => {
    const f = sessionFixture(false); f.worker();
    const path = join(f.workerService.store.root, 'tasks.jsonl'), journal = new TaskJournal(path, f.peer);
    const envelope = signEnvelope({ taskId: 'retained', recipientDid: f.peer.did, seq: 0, eventType: 'PROPOSE', payload: {} }, f.owner, { encrypt: true });
    f.workerService.store.transaction(() => {
      for (const taskId of ['live', 'retained', 'old']) journal.save({ version: 1, taskId, requesterDid: f.owner.did,
        envelopeId: envelope.payload.envelopeId, proposalDigest: digest({ taskId }), phase: taskId === 'live' ? 'running' : 'terminal',
        invocations: [], ...(taskId === 'live' ? {} : { outcome: { code: 'TASK_INTERRUPTED' }, notificationPending: false }) });
    });
    f.workerService.store.receipt(envelope, f.epoch + 86400_000, 'processed');
    await f.workerService.start(); f.workerService.stop(); journal.reload();
    expect([...journal.tasks.keys()]).toEqual(['live', 'retained']);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(f.calls()).toBe(0);
  });
});
