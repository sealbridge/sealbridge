// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join, relative, sep } from 'node:path';
import { digest, generateKeyPair, signEnvelope, signPayload, verifySigned } from '../packages/core/src/index.js';
import { HELD_CONTENT_BOUNDS, HeldRequestStore, heldRequestDirectory } from '../packages/runtime/src/index.js';
import { heldFixture } from './held-request-fixture.js';
let f: ReturnType<typeof heldFixture>;
beforeEach(() => { f = heldFixture(); });
afterEach(() => { vi.restoreAllMocks(); f.cleanup(); });
const path = (id: string) => join(f.store.directory, id + '.json');

it('reads an empty store without creating a directory or identity', () => {
  expect(f.store.list()).toEqual([]);
  expect(f.store.read(f.request().id)).toBeUndefined();
  expect(fs.readdirSync(f.root)).toEqual([]);
});
it('persists the original ciphertext with owner-signed metadata and bounded summaries', () => {
  const request = f.request(); const summary = f.store.hold(request);
  expect(relative(f.root, f.store.directory).split(sep)).toEqual(['quarantine', f.store.directory.split(sep).at(-1)]);
  const raw = fs.readFileSync(path(summary.id), 'utf8'), signed = JSON.parse(raw);
  expect(verifySigned(signed, f.owner.did)).toBe(true);
  expect(signed.payload.envelope).toEqual(request.envelope);
  expect(summary).toMatchObject({ state: 'held', inspectionStatus: 'pending', contentDigest: request.contentDigest });
  for (const text of ['original input marker', 'original title marker', 'original description marker', 'privateKey']) {
    expect(raw).not.toContain(text); expect(JSON.stringify(f.store.list())).not.toContain(text);
  }
  expect(JSON.stringify(f.store.list())).not.toContain('ciphertext');
  expect(Object.keys(signed.payload)).not.toContain('content');
  if (process.platform !== 'win32') {
    expect(fs.statSync(path(summary.id)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(f.store.directory).mode & 0o777).toBe(0o700);
  }
  const restart = new HeldRequestStore(f.owner, f.options);
  expect(restart.read(summary.id)).toEqual(signed.payload);
  expect(restart.list()).toEqual([summary]);
});
it('leaves CRLF files intact on reads and isolates local owner identities', () => {
  const request = f.request(); f.store.hold(request);
  const raw = JSON.stringify(JSON.parse(fs.readFileSync(path(request.id), 'utf8')), null, 2).replace(/\n/g, '\r\n') + '\r\n';
  fs.writeFileSync(path(request.id), raw);
  expect(f.store.list()).toHaveLength(1); expect(fs.readFileSync(path(request.id), 'utf8')).toBe(raw);
  const other = generateKeyPair(); expect(new HeldRequestStore(other, f.options).list()).toEqual([]);
  expect(fs.existsSync(heldRequestDirectory(other.did, f.options))).toBe(false);
});
it('rejects unencrypted, foreign-recipient, altered and extended envelope bodies', () => {
  const request = f.request();
  const plain = signEnvelope({ taskId: request.taskId, seq: 0, eventType: 'PROPOSE', recipientDid: f.owner.did, payload: {} }, f.peer);
  expect(() => f.store.hold({ ...request, envelope: plain })).toThrow('UNENCRYPTED_ENVELOPE_REJECTED');
  const foreign = signEnvelope({ ...request.envelope.payload, recipientDid: generateKeyPair().did }, f.peer, { encrypt: true });
  expect(() => f.store.hold({ ...request, envelope: foreign })).toThrow('QUARANTINE_INVALID');
  const changed = structuredClone(request.envelope); changed.payload.taskId += '_changed';
  expect(() => f.store.hold({ ...request, envelope: changed })).toThrow('QUARANTINE_INVALID');
  const extended = signPayload({ ...request.envelope.payload, payload: { ...request.envelope.payload.payload as object, text: 'extra plaintext' } }, f.peer);
  expect(() => f.store.hold({ ...request, envelope: extended })).toThrow('QUARANTINE_INVALID');
  expect(fs.readdirSync(f.root)).toEqual([]);
});
it('deduplicates a stable ID without extending retention and rejects changed content', () => {
  const request = f.request(), original = f.store.hold(request), raw = fs.readFileSync(path(request.id), 'utf8');
  f.advance(1000); expect(f.store.hold(request)).toEqual(original);
  expect(fs.readFileSync(path(request.id), 'utf8')).toBe(raw);
  expect(() => f.store.hold({ ...request, contentDigest: digest('changed') })).toThrow('QUARANTINE_INVALID');
  expect(() => f.store.hold({ ...request, id: '../entry' })).toThrow('QUARANTINE_INVALID');
  expect(() => f.store.hold({ ...request, taskId: 'text with spaces' })).toThrow('QUARANTINE_INVALID');
});
it('caps retention at the deadline or 24 hours and deletes expired ciphertext on explicit expiry', () => {
  const first = f.request(), second = f.request('connection');
  const a = f.store.hold({ ...first, deadline: f.options.now() + 1000 }), b = f.store.hold(second);
  expect(b.expiresAt - b.receivedAt).toBe(HELD_CONTENT_BOUNDS.retentionMs);
  f.advance(1000); expect(f.store.list().find(r => r.id === a.id)?.state).toBe('expired');
  expect(fs.existsSync(path(a.id))).toBe(true);
  expect(f.store.expire()).toBe(1); expect(fs.existsSync(path(a.id))).toBe(false);
  f.advance(HELD_CONTENT_BOUNDS.retentionMs - 1000);
  expect(f.store.expire()).toBe(1); expect(f.store.list()).toEqual([]);
});
it('keeps live records when record or aggregate bounds reject new holds, and reclaims expired records', () => {
  const request = f.request(), size = Buffer.byteLength(JSON.stringify(request.envelope));
  const aggregate = new HeldRequestStore(f.owner, { ...f.options, limits: { totalEnvelopeBytes: size } });
  aggregate.hold(request);
  expect(() => aggregate.hold(f.request())).toThrow('QUARANTINE_FULL'); expect(aggregate.list()).toHaveLength(1);
  const count = new HeldRequestStore(f.owner, { ...f.options, limits: { records: 1 } });
  expect(() => count.hold(f.request())).toThrow('QUARANTINE_FULL');
  f.advance(HELD_CONTENT_BOUNDS.retentionMs);
  const replacement = count.hold(f.request()); expect(count.list()).toEqual([replacement]);
  expect(fs.existsSync(path(request.id))).toBe(false);
});
it('enforces the envelope byte bound before publication', () => {
  const large = f.request('task', 'x'.repeat(200 * 1024));
  expect(() => f.store.hold(large)).toThrow('QUARANTINE_FULL'); expect(f.store.list()).toEqual([]);
  const request = f.request(), size = Buffer.byteLength(JSON.stringify(request.envelope));
  new HeldRequestStore(f.owner, { ...f.options, limits: { envelopeBytes: size } }).hold(request);
  expect(() => new HeldRequestStore(f.owner, { ...f.options, limits: { envelopeBytes: size - 1 } }).hold(request)).toThrow('QUARANTINE_FULL');
});
it('accepts 100 live records and refuses the next without removing existing ciphertext', () => {
  for (let i = 0; i < 100; i++) f.store.hold(f.request());
  const ids = f.store.list().map(r => r.id);
  expect(() => f.store.hold(f.request())).toThrow('QUARANTINE_FULL');
  expect(f.store.list().map(r => r.id)).toEqual(ids);
}, 60_000);
it('reports write failures before a host can acknowledge a hold and removes temporary files', () => {
  const ack = vi.fn(), request = f.request();
  const broken = new HeldRequestStore(f.owner, { ...f.options, fs: { ...fs, renameSync: () => { throw new Error('fixture'); } } });
  expect(() => { broken.hold(request); ack(); }).toThrow('QUARANTINE_UNWRITABLE');
  expect(ack).not.toHaveBeenCalled(); expect(f.store.list()).toEqual([]);
  expect(fs.readdirSync(f.store.directory)).toEqual([]);
  f.store.hold(request); const raw = fs.readFileSync(path(request.id), 'utf8');
  const unflushed = new HeldRequestStore(f.owner, { ...f.options, fs: { ...fs, fsyncSync: () => { throw new Error('fixture'); } } });
  expect(() => unflushed.hold(f.request())).toThrow('QUARANTINE_UNWRITABLE');
  expect(fs.readFileSync(path(request.id), 'utf8')).toBe(raw);
});
it('retains occupied locks and serializes competing store instances', () => {
  const request = f.request(); f.store.hold(request);
  const lock = join(f.store.directory, '.lock'); fs.writeFileSync(lock, '', { mode: 0o600 });
  expect(() => f.store.discard(request.id)).toThrow('QUARANTINE_BUSY'); expect(fs.existsSync(lock)).toBe(true); fs.unlinkSync(lock);
  let competed = false;
  const competing = new HeldRequestStore(f.owner, { ...f.options, fs: { ...fs, renameSync: (...args) => {
    expect(() => f.store.discard(request.id)).toThrow('QUARANTINE_BUSY'); competed = true; fs.renameSync(...args);
  } } });
  competing.hold(f.request()); expect(competed).toBe(true); expect(f.store.list()).toHaveLength(2);
});
it('rejects changed signatures, metadata and file types without replacing their bytes', () => {
  const request = f.request(); f.store.hold(request); const file = path(request.id), raw = fs.readFileSync(file, 'utf8');
  const signed = JSON.parse(raw); signed.payload.contentDigest = digest('changed'); fs.writeFileSync(file, JSON.stringify(signed));
  expect(() => f.store.list()).toThrow('QUARANTINE_INVALID');
  const foreign = signPayload(signed.payload, generateKeyPair()); fs.writeFileSync(file, JSON.stringify(foreign));
  expect(() => f.store.read(request.id)).toThrow('QUARANTINE_INVALID');
  fs.writeFileSync(file, raw);
  const invalid = signPayload({ ...JSON.parse(raw).payload, expiresAt: f.options.now() + HELD_CONTENT_BOUNDS.retentionMs + 1 }, f.owner);
  fs.writeFileSync(file, JSON.stringify(invalid)); expect(() => f.store.read(request.id)).toThrow('QUARANTINE_INVALID');
  expect(() => f.store.hold(f.request())).toThrow('QUARANTINE_INVALID'); expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify(invalid));
  fs.unlinkSync(file); fs.mkdirSync(file, { mode: 0o700 }); expect(() => f.store.list()).toThrow('QUARANTINE_INVALID');
});
it('checks private paths and keeps quarantine outside a declared adapter workspace', () => {
  const request = f.request(); f.store.hold(request);
  expect(() => new HeldRequestStore(f.owner, { ...f.options, workspaceDir: f.root })).toThrow('QUARANTINE_INVALID');
  const workspace = join(f.root, 'adapter');
  expect(new HeldRequestStore(f.owner, { ...f.options, workspaceDir: workspace }).directory).toBe(f.store.directory);
  if (process.platform !== 'win32') {
    fs.chmodSync(path(request.id), 0o644); expect(() => f.store.list()).toThrow('QUARANTINE_INVALID'); fs.chmodSync(path(request.id), 0o600);
    fs.chmodSync(f.store.directory, 0o755); expect(() => f.store.list()).toThrow('QUARANTINE_INVALID'); fs.chmodSync(f.store.directory, 0o700);
    const moved = path(request.id) + '.moved'; fs.renameSync(path(request.id), moved); fs.symlinkSync(moved, path(request.id));
    expect(() => f.store.read(request.id)).toThrow('QUARANTINE_INVALID');
  }
});
it('removes a peer’s ciphertext on explicit cleanup without deleting other peers', () => {
  const request = f.request(), a = f.store.hold(request);
  const b = f.store.hold({ ...f.request('connection'), senderOwnerDid: generateKeyPair().did });
  expect(f.store.discardPeer(f.peer.did)).toBe(1); expect(fs.existsSync(path(a.id))).toBe(false);
  expect(f.store.list().map(r => r.id)).toEqual([b.id]);
  expect(f.store.clear()).toBe(1); expect(f.store.discard(b.id)).toBe(false);
});
