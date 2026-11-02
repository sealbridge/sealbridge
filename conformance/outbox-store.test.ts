// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { digest, generateKeyPair, signPayload, verifySigned } from '../packages/core/src/index.js';
import { DeliveryStore } from '../packages/runtime/src/delivery-store.js';
import { DELIVERY_RETENTION_MS, validateDeliveryRecord } from '../packages/runtime/src/delivery-records.js';
import { outboxFixture } from './outbox-fixture.js';

const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); cleanups.splice(0).forEach(f => f()); });
function fixture(...args: Parameters<typeof outboxFixture>) { const f = outboxFixture(...args); cleanups.push(f.cleanup); return f; }
function inventory(path: string): string[] { return fs.existsSync(path) ? fs.readdirSync(path, { recursive: true }).map(String).sort() : []; }

describe('persistent envelope store', () => {
  it('reads each record once per writer transaction and returns independent values', () => {
    const f = fixture(), p = f.prepare();
    const [id] = f.service.enqueue(p.frames, p.context);
    const open = vi.fn(fs.openSync);
    const store = new DeliveryStore(f.owner, { ...f.identityOptions, now: f.now, fs: { ...fs, openSync: open } });
    const path = store.path('outbox', id);
    store.transaction(() => {
      const first = store.read('outbox', id)!;
      first.attemptCount = 99;
      expect(store.read('outbox', id)?.attemptCount).toBe(0);
      store.committed(first.batchId);
      store.committed(first.batchId);
      expect(open.mock.calls.filter(args => args[0] === path)).toHaveLength(1);
      store.write('outbox', id, { ...first, attemptCount: 1 });
      expect(store.read('outbox', id)?.attemptCount).toBe(1);
    });
    expect(store.read('outbox', id)?.attemptCount).toBe(1);
    // The writer populated the verified cache; an unchanged file needs no reopen.
    expect(open.mock.calls.filter(args => args[0] === path)).toHaveLength(1);
  });
  it('observes changed and removed files after a transaction including an interrupted callback', () => {
    const f = fixture(), p = f.prepare(), [id] = f.service.enqueue(p.frames, p.context);
    const store = f.service.store, other = new DeliveryStore(f.owner, f.identityOptions);
    expect(() => store.transaction(() => { store.read('outbox', id); throw new Error('OUTBOX_INTERRUPTED'); })).toThrow('OUTBOX_INTERRUPTED');
    other.transaction(() => other.write('outbox', id, { ...other.read('outbox', id)!, attemptCount: 2 }));
    expect(store.read('outbox', id)?.attemptCount).toBe(2);
    other.transaction(() => other.remove('outbox', id));
    expect(store.read('outbox', id)).toBeUndefined();
  });
  it('checks bytes and file permissions again after validation was reused', () => {
    const f = fixture(), p = f.prepare(), [id] = f.service.enqueue(p.frames, p.context);
    const store = f.service.store, path = store.path('outbox', id);
    const record = store.read('outbox', id)!;
    if (process.platform !== 'win32') {
      fs.chmodSync(path, 0o644);
      expect(() => store.read('outbox', id)).toThrow('OUTBOX_STORE_INVALID');
      fs.chmodSync(path, 0o600);
    }
    const changed = JSON.parse(fs.readFileSync(path, 'utf8'));
    changed.payload.attemptCount++;
    fs.writeFileSync(path, JSON.stringify(changed) + '\n');
    expect(() => store.read('outbox', id)).toThrow('OUTBOX_STORE_INVALID');
    fs.writeFileSync(path, JSON.stringify(signPayload({ ...record, version: 2 }, f.owner)) + '\n');
    expect(() => store.read('outbox', id)).toThrow('OUTBOX_STORE_INVALID');
  });
  it('constructs and reads absent messages without creating a data root or key', () => {
    const f = fixture(), id = f.prepare().context.messageId;
    expect(f.service.store.getMessage(id)).toBeUndefined();
    expect(f.service.store.findTask('unknown')).toEqual([]);
    expect(f.service.store.snapshot('outbox')).toEqual([]);
    expect(fs.existsSync(join(f.root, 'data'))).toBe(false);
    expect(() => new DeliveryStore(undefined as never)).toThrow('OUTBOX_STORE_INVALID');
    expect(() => f.service.store.read('outbox', '../other')).toThrow('OUTBOX_STORE_INVALID');
  });
  it('writes signed UTF-8 records, private files and directories, with no task text in metadata', () => {
    const f = fixture(), p = f.prepare(true), ids = f.service.enqueue(p.frames, p.context), store = f.service.store;
    expect(store.committed(store.read('outbox', ids[0])!.batchId).map(r => r.envelopeId)).toEqual(ids);
    const text = fs.readFileSync(store.path('messages', ids[0]), 'utf8');
    expect(text.endsWith('\n')).toBe(true); expect(verifySigned(JSON.parse(text), f.owner.did)).toBe(true);
    expect(text).not.toContain('local ciphertext fixture');
    expect(JSON.stringify(store.snapshot('outbox'))).not.toContain('local ciphertext fixture');
    if (process.platform !== 'win32') {
      for (const kind of ['messages', 'outbox', 'batches'] as const) {
        expect(fs.statSync(join(store.root, kind)).mode & 0o777).toBe(0o700);
        for (const id of store.ids(kind)) expect(fs.statSync(store.path(kind, id)).mode & 0o777).toBe(0o600);
      }
      expect(fs.statSync(store.root).mode & 0o777).toBe(0o700);
    }
    expect(inventory(store.root).filter(n => /\.tmp$|\.lock$/.test(n))).toEqual([]);
  });
  it.each(['version', 'extra', 'signature', 'owner', 'extension', 'ciphertext'] as const)('isolates %s record errors without dispatch or replacement', async kind => {
    const f = fixture(), p = f.prepare(), errors = vi.fn();
    const [id] = f.service.enqueue(p.frames, p.context), path = f.service.store.path('outbox', id);
    const record = f.service.store.read('outbox', id)!;
    if (kind === 'version') (record as { version: number }).version = 2;
    if (kind === 'extra') Object.assign(record, { extra: true });
    if (kind === 'extension') Object.assign(record, { lease: { holderId: id, until: f.now(), extra: 1 } });
    if (kind === 'owner') record.localOwnerDid = generateKeyPair().did;
    if (kind === 'ciphertext') record.envelope.payload.payload = { text: 'plain' };
    const signed = signPayload(record, kind === 'signature' ? generateKeyPair() : f.owner);
    fs.writeFileSync(path, JSON.stringify(signed) + '\n', { mode: 0o600 });
    const before = fs.readFileSync(path);
    const restarted = f.restart(f.owner, { onError: errors });
    await restarted.start(); restarted.stop();
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: 'OUTBOX_STORE_INVALID' }));
    expect(f.posted).toEqual([]); expect(fs.readFileSync(path)).toEqual(before);
  });
  it('publishes no batch and sends nothing when an enqueue flush fails', async () => {
    const f = fixture(), p = f.prepare(), service = f.restart(f.owner, { identityOptions: { ...f.identityOptions,
      fs: { ...fs, fsyncSync: () => { throw Object.assign(new Error('fixture flush'), { code: 'EIO' }); } } } });
    expect(() => service.enqueue(p.frames, p.context)).toThrow('OUTBOX_STORE_UNWRITABLE');
    expect(service.store.ids('batches')).toEqual([]);
    expect(inventory(service.store.root).filter(n => /\.tmp$|\.lock$/.test(n))).toEqual([]);
    await service.drainDue();
    expect(f.posted).toEqual([]);
  });
  it('validates reserved operation, reply and recipient-status fields exactly', () => {
    const f = fixture(), p = f.prepare(); f.service.enqueue(p.frames, p.context);
    const record = f.service.store.getMessage(p.context.messageId)!;
    expect(() => validateDeliveryRecord('messages', { ...record, operationId: '../x' }, f.owner.did)).toThrow();
    const status = { type: 'DeliveryStatus' as const, version: 1 as const, messageId: record.messageId, taskId: record.taskId,
      senderDid: f.owner.did, recipientDid: f.peer.did, state: 'received_held' as const, revision: 1, occurredAt: f.now(), retainUntil: record.retainUntil };
    expect(() => validateDeliveryRecord('messages', { ...record, remoteStatus: signPayload(status, f.peer) }, f.owner.did)).not.toThrow();
    expect(() => validateDeliveryRecord('messages', { ...record, remoteStatus: signPayload({ ...status, detail: 'extra' }, f.peer) }, f.owner.did)).toThrow();
    expect(() => validateDeliveryRecord('messages', { ...record, remoteStatus: signPayload(status, f.owner) }, f.owner.did)).toThrow();
  });
  it('leaves an existing writer lock intact and serializes independent store instances', () => {
    const f = fixture(), p = f.prepare(), other = f.restart();
    f.service.store.transaction(() => {
      expect(() => other.enqueue(p.frames, p.context)).toThrow('OUTBOX_STORE_BUSY');
      expect(fs.existsSync(join(f.service.store.root, '.lock'))).toBe(true);
    });
    expect(fs.existsSync(join(f.service.store.root, '.lock'))).toBe(false);
    other.enqueue(p.frames, p.context);
    expect(() => f.service.enqueue(p.frames, p.context)).toThrow('DELIVERY_RECORD_CONFLICT');
    expect(other.store.snapshot('outbox')).toHaveLength(1);
  });
  it('does not dispatch members when batch publication is interrupted and cleans only uncommitted members', async () => {
    const f = fixture();
    const io = { ...fs, renameSync: vi.fn((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).includes(join('batches', ''))) throw Object.assign(new Error('fixture rename'), { code: 'EIO' });
      fs.renameSync(from, to);
    }) } as typeof fs;
    const service = f.restart(f.owner, { identityOptions: { ...f.identityOptions, fs: io } });
    const p = f.prepare(true);
    expect(() => service.enqueue(p.frames, p.context)).toThrow('OUTBOX_STORE_UNWRITABLE');
    expect(service.store.ids('outbox')).toHaveLength(2); expect(service.store.ids('batches')).toEqual([]);
    await service.drainDue(); expect(f.posted).toEqual([]);
    const restarted = f.restart(); await restarted.start(); restarted.stop();
    expect(restarted.store.ids('outbox')).toEqual([]); expect(f.posted).toEqual([]);
    expect(inventory(restarted.store.root).filter(n => /\.tmp$|\.lock$/.test(n))).toEqual([]);
  });
  it.each(['activeEnvelopes', 'envelopeBytes', 'wireBytes', 'messages', 'recordBytes'] as const)('reports %s capacity before transmission and retains existing work', key => {
    const f = fixture({ limits: { [key]: key === 'activeEnvelopes' || key === 'messages' ? 1 : 16 } });
    const p = f.prepare();
    if (key === 'activeEnvelopes' || key === 'messages') f.service.enqueue(p.frames, p.context);
    const next = f.prepare();
    expect(() => f.service.enqueue(next.frames, next.context)).toThrow('OUTBOX_FULL');
    expect(f.posted).toEqual([]);
    if (key === 'activeEnvelopes' || key === 'messages') expect(f.service.store.getMessage(p.context.messageId)?.status).toBe('queued');
  });
  it('retains receipt identity and times, rejects conflicts and enforces receipt bounds', () => {
    const f = fixture({ limits: { receipts: 1 } }), p = f.prepare();
    const a = f.service.store.receipt(p.first, p.context.deliveryDeadline, 'persisted');
    f.setNow(f.now() + 1000);
    const b = f.service.store.receipt(p.first, p.context.deliveryDeadline + 1000, 'processed');
    expect(b.receivedAt).toBe(a.receivedAt); expect(b.retainUntil).toBe(a.retainUntil);
    expect(() => f.service.store.receipt(f.frame(), p.context.deliveryDeadline, 'persisted')).toThrow('OUTBOX_FULL');
    const changed = signPayload({ ...p.first.payload, seq: 9 }, f.owner);
    expect(() => f.service.store.receipt(changed, p.context.deliveryDeadline, 'processed')).toThrow('DELIVERY_RECORD_CONFLICT');
  });
  it('retains non-UUID wire identifiers without using their text as a filename', () => {
    const f = fixture(), original = f.frame();
    const envelope = signPayload({ ...original.payload, envelopeId: 'legacy/../envelope' }, f.owner);
    const receipt = f.service.store.receipt(envelope, f.epoch + 86400_000, 'processed');
    expect(f.service.store.read('receipts', envelope.payload.envelopeId)).toEqual(receipt);
    expect(f.service.store.snapshot('receipts')).toEqual([receipt]);
    expect(f.service.store.ids('receipts')).toHaveLength(1);
    expect(f.service.store.path('receipts', envelope.payload.envelopeId)).not.toContain('legacy');
    const ids = f.service.store.ids('receipts');
    f.service.store.receipt(envelope, f.epoch + 86400_000, 'terminal', 'TASK_INTERRUPTED');
    expect(f.service.store.ids('receipts')).toEqual(ids);
    expect(f.service.store.snapshot('receipts')).toHaveLength(1);
    f.service.store.transaction(() => f.service.store.remove('receipts', envelope.payload.envelopeId));
    expect(f.service.store.ids('receipts')).toEqual([]);
  });
  it('keeps fixed retention and read hashes/mtime unchanged at deadline and retention boundaries', () => {
    const f = fixture(), p = f.prepare(); f.service.enqueue(p.frames, p.context);
    const path = f.service.store.path('messages', p.context.messageId), before = fs.readFileSync(path), mtime = fs.statSync(path).mtimeMs;
    f.setNow(p.context.deliveryDeadline - 1); expect(f.service.store.getMessage(p.context.messageId)?.status).toBe('queued');
    f.setNow(p.context.deliveryDeadline); expect(f.service.store.getMessage(p.context.messageId)?.status).toBe('closed');
    f.setNow(p.context.deliveryDeadline + DELIVERY_RETENTION_MS - 1); expect(f.service.store.getMessage(p.context.messageId)).toBeDefined();
    f.setNow(f.now() + 1); expect(f.service.store.getMessage(p.context.messageId)).toBeUndefined();
    expect(digest(fs.readFileSync(path).toString())).toBe(digest(before.toString())); expect(fs.statSync(path).mtimeMs).toBe(mtime);
    expect(fs.existsSync(path)).toBe(true);
    f.service.store.maintain(); expect(fs.existsSync(path)).toBe(false);
  });
  it('removes the commit marker before member cleanup and recovers an interrupted member unlink', async () => {
    const f = fixture(), p = f.prepare(true); f.service.enqueue(p.frames, p.context);
    await f.service.drainDue();
    const batchId = f.service.store.read('outbox', p.first.payload.envelopeId)!.batchId;
    let interrupted = false;
    const io = { ...fs, unlinkSync: (path: fs.PathLike) => {
      if (!interrupted && String(path) === f.service.store.path('outbox', p.first.payload.envelopeId)) {
        interrupted = true;
        expect(fs.existsSync(f.service.store.path('batches', batchId))).toBe(false);
        throw Object.assign(new Error('fixture unlink'), { code: 'EIO' });
      }
      fs.unlinkSync(path);
    } } as typeof fs;
    const other = f.restart(f.owner, { identityOptions: { ...f.identityOptions, fs: io } });
    other.store.maintain(); expect(interrupted).toBe(true);
    const restarted = f.restart(); await restarted.start(); restarted.stop();
    expect(restarted.store.ids('outbox')).toEqual([]); expect(f.posted).toHaveLength(2);
  });
  it.each([0, DELIVERY_RETENTION_MS])('closes expired pending batches before pruning metadata after %s extra milliseconds offline', async extra => {
    const f = fixture(), p = f.prepare(true);
    f.service.enqueue(p.frames, p.context);
    f.setNow(p.context.deliveryDeadline + extra);
    const restarted = f.restart();
    await restarted.start(); restarted.stop();
    expect(f.posted).toEqual([]);
    expect(restarted.store.ids('batches')).toEqual([]);
    expect(restarted.store.ids('outbox')).toEqual([]);
    expect(restarted.store.getMessage(p.context.messageId)?.status).toBe(extra ? undefined : 'closed');
  });
  it.skipIf(process.platform === 'win32')('rejects linked paths and non-private record files', () => {
    const f = fixture(), p = f.prepare(); f.service.enqueue(p.frames, p.context);
    const path = f.service.store.path('messages', p.context.messageId);
    fs.chmodSync(path, 0o644); expect(() => f.service.store.getMessage(p.context.messageId)).toThrow('OUTBOX_STORE_INVALID');
    fs.chmodSync(path, 0o600); fs.renameSync(path, path + '.saved'); fs.symlinkSync(path + '.saved', path);
    expect(() => f.service.store.getMessage(p.context.messageId)).toThrow('OUTBOX_STORE_INVALID');
  });
});
