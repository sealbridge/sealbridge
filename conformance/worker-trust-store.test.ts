// SPDX-License-Identifier: Apache-2.0
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPair, digest } from '../packages/core/src/index.js';
import { WorkerTrustStore, workerIntakePath, buildTaskManifest, resolveOrCreateIdentity } from '../packages/runtime/src/index.js';
import { requestsCommand } from '../cli/src/requests.js';
let root: string;
const now = Date.parse('2026-11-01T00:00:00Z');
beforeEach(() => { root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'sealbridge-trust-')); vi.stubEnv('SEALBRIDGE_DATA_DIR', root); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const owner = generateKeyPair(), peer = generateKeyPair(); let clock = now;
  const path = workerIntakePath(owner.did), options = { path, now: () => clock };
  const store = new WorkerTrustStore(owner, options);
  const manifest = buildTaskManifest({ ownerDid: peer.did, workerDid: owner.did, title: 'Request', description: 'Metadata' });
  manifest.deadline = new Date(now + 3600_000).toISOString();
  return { owner, peer, path, store, manifest, options, advance: (ms: number) => { clock += ms; } };
}
it('persists owner-signed metadata with private paths, deduplication and restart decisions', () => {
  const f = fixture(); f.store.enqueue(f.manifest, { hiddenInput: 'never retain' });
  const original = f.store.list()[0]; f.advance(1000); f.store.enqueue(f.manifest, {});
  expect(f.store.list()).toEqual([original]); expect(fs.readFileSync(f.path, 'utf8')).not.toContain('hiddenInput');
  if (process.platform !== 'win32') {
    expect(fs.statSync(f.path).mode & 0o777).toBe(0o600); expect(fs.statSync(dirname(f.path)).mode & 0o777).toBe(0o700);
  }
  const restart = new WorkerTrustStore(f.owner, f.options);
  restart.decide(original.id, 'approve'); expect(restart.level(f.peer.did)).toBe('limited');
  expect(restart.hasTrustedGrant()).toBe(false);
  restart.decide(original.id, 'approve');
  expect(() => restart.decide(original.id, 'approve', 'trusted')).toThrow('REQUEST_ALREADY_DECIDED');
  expect(restart.pendingTask(f.peer.did, f.manifest.taskId, digest({ manifest: f.manifest, input: { hiddenInput: 'never retain' } }))).toBe(true);
  restart.decide(original.id, 'deny'); restart.decide(original.id, 'deny');
  expect(restart.level(f.peer.did)).toBe('denied'); expect(() => restart.decide(original.id, 'approve')).toThrow('REQUEST_ALREADY_DECIDED');
});
it('computes expiry on reads without writes, rejects expired approval, and expires trusted grants', () => {
  const f = fixture(); f.store.enqueue(f.manifest, {}); const r = f.store.list()[0];
  const bytes = fs.readFileSync(f.path, 'utf8'); f.advance(60 * 60_000);
  expect(f.store.list()[0].state).toBe('expired'); expect(fs.readFileSync(f.path, 'utf8')).toBe(bytes);
  expect(() => f.store.decide(r.id, 'approve')).toThrow('REQUEST_EXPIRED');
  f.manifest.deadline = new Date(now + 2 * 3600_000).toISOString();
  f.manifest.taskId += '_new'; f.store.enqueue(f.manifest, {}); f.store.decide(f.store.list().at(-1)!.id, 'approve', 'trusted');
  expect(f.store.hasTrustedGrant()).toBe(true); f.advance(24 * 3600_000);
  expect(f.store.level(f.peer.did)).toBe('unknown'); expect(f.store.hasTrustedGrant()).toBe(false);
});
it('fails closed on corruption, foreign signatures, lock contention and failed publication', () => {
  const f = fixture(); f.store.enqueue(f.manifest, {}); const original = fs.readFileSync(f.path, 'utf8');
  fs.writeFileSync(f.path + '.lock', '', { mode: 0o600 });
  expect(() => f.store.decide(f.store.list()[0].id, 'approve')).toThrow('INTAKE_STORE_BUSY'); fs.unlinkSync(f.path + '.lock');
  const failing = new WorkerTrustStore(f.owner, { ...f.options, fs: { ...fs, renameSync: () => { throw new Error('injected'); } } });
  expect(() => failing.decide(f.store.list()[0].id, 'approve')).toThrow('INTAKE_STORE_UNWRITABLE');
  expect(fs.readFileSync(f.path, 'utf8')).toBe(original); expect(fs.existsSync(f.path + '.lock')).toBe(false);
  const other = new WorkerTrustStore(generateKeyPair(), f.options); expect(() => other.level(f.peer.did)).toThrow('INTAKE_STORE_INVALID');
  fs.writeFileSync(f.path, '{}'); expect(() => f.store.level(f.peer.did)).toThrow('INTAKE_STORE_INVALID');
});
it('bounds pending intake and per-peer rates without extending original expiry', () => {
  const f = fixture(); for (let i = 0; i < 5; i++) f.store.enqueue({ ...f.manifest, taskId: f.manifest.taskId + '_' + i }, {});
  expect(f.store.list()).toHaveLength(1); expect(() => f.store.enqueue({ ...f.manifest, taskId: f.manifest.taskId + '_six' }, {})).toThrow('INTAKE_RATE_LIMITED');
  f.advance(60_000);
  for (let i = 0; i < 60; i++) f.store.enqueue({ ...f.manifest, requester: { ...f.manifest.requester, ownerDid: 'did:key:' + i } }, {});
  expect(() => f.store.enqueue({ ...f.manifest, requester: { ...f.manifest.requester, ownerDid: 'did:key:extra' } }, {})).toThrow('INTAKE_RATE_LIMITED');
  f.advance(60_000);
  for (let i = 60; i < 99; i++) f.store.enqueue({ ...f.manifest, requester: { ...f.manifest.requester, ownerDid: 'did:key:' + i } }, {});
  expect(f.store.list()).toHaveLength(100);
  expect(() => f.store.enqueue({ ...f.manifest, requester: { ...f.manifest.requester, ownerDid: 'did:key:full' } }, {})).toThrow('INTAKE_QUEUE_FULL');
});
it('owner CLI reviews locally, defaults to limited, requires explicit trusted choice and supports deny after approval', async () => {
  const identityOptions = { env: { SEALBRIDGE_DATA_DIR: root }, home: root };
  const owner = resolveOrCreateIdentity('worker', identityOptions), peer = generateKeyPair();
  const store = new WorkerTrustStore(owner, { path: workerIntakePath(owner.did) });
  const m = buildTaskManifest({ ownerDid: peer.did, workerDid: owner.did, title: 'Review', description: 'Owner review' });
  store.enqueue(m, { secretInput: 'not listed' }); const id = store.list()[0].id;
  const output = vi.fn(), review = vi.fn(async (_summary: string) => true), opts = { identityOptions, output, review };
  await requestsCommand(['list'], opts); expect(output.mock.calls[0][0]).not.toContain('secretInput');
  await expect(requestsCommand(['approve', id], opts)).rejects.toThrow('INSPECTION_INCOMPLETE');
  expect(review).not.toHaveBeenCalled();
  await requestsCommand(['approve', id, '--trust', 'trusted'], opts); expect(store.level(peer.did)).toBe('trusted');
  expect(review.mock.calls[0][0]).toContain('Legacy explicit trusted grant');
  await requestsCommand(['deny', id], opts); expect(store.level(peer.did)).toBe('denied');
  await expect(requestsCommand(['approve', id, '--yes'], opts)).rejects.toThrow('INVALID_REQUEST_OPTION');
  await expect(requestsCommand(['deny', id], { ...opts, review: async () => false })).rejects.toThrow('APPROVAL_REJECTED');
});
it('checks private file types/modes and preserves data when the lock is occupied', () => {
  const f = fixture(); f.store.enqueue(f.manifest, {});
  if (process.platform !== 'win32') {
    fs.chmodSync(f.path, 0o644); expect(() => f.store.list()).toThrow('INTAKE_STORE_INVALID'); fs.chmodSync(f.path, 0o600);
    fs.chmodSync(dirname(f.path), 0o755); expect(() => f.store.list()).toThrow('INTAKE_STORE_INVALID'); fs.chmodSync(dirname(f.path), 0o700);
  }
  fs.unlinkSync(f.path); fs.mkdirSync(f.path, { mode: 0o700 });
  expect(() => f.store.list()).toThrow('INTAKE_STORE_INVALID');
});
it('prevents concurrent owner updates from losing an earlier decision', () => {
  const f = fixture(); f.store.enqueue(f.manifest, {}); const id = f.store.list()[0].id;
  const competing = new WorkerTrustStore(f.owner, f.options);
  let observed = false;
  const io = { ...fs, renameSync: ((...args: Parameters<typeof fs.renameSync>) => {
    expect(() => competing.decide(id, 'deny')).toThrow('INTAKE_STORE_BUSY'); observed = true;
    return fs.renameSync(...args);
  }) as typeof fs.renameSync };
  new WorkerTrustStore(f.owner, { ...f.options, fs: io }).decide(id, 'approve', 'trusted');
  expect(observed).toBe(true); expect(competing.level(f.peer.did)).toBe('trusted');
  competing.decide(id, 'deny'); expect(f.store.level(f.peer.did)).toBe('denied');
});
it('does not recreate keys during empty queue inspection and refuses unattended decisions', async () => {
  const identityOptions = { env: { SEALBRIDGE_DATA_DIR: root }, home: root };
  await requestsCommand(['list'], { identityOptions, output: () => {} });
  expect(fs.readdirSync(root)).toEqual([]);
  const owner = resolveOrCreateIdentity('worker', identityOptions), peer = generateKeyPair();
  const store = new WorkerTrustStore(owner, { path: workerIntakePath(owner.did) });
  store.enqueue(buildTaskManifest({ ownerDid: peer.did, workerDid: owner.did, title: 'Review', description: 'Review' }), {});
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    await expect(requestsCommand(['approve', store.list()[0].id, '--trust', 'trusted'], { identityOptions })).rejects.toThrow('APPROVAL_CHANNEL_UNAVAILABLE');
  expect(store.level(peer.did)).toBe('unknown');
});
it('accepts CRLF signed JSON without rewriting it on list', () => {
  const f = fixture(); f.store.enqueue(f.manifest, {});
  const bytes = JSON.stringify(JSON.parse(fs.readFileSync(f.path, 'utf8')), null, 2).replace(/\n/g, '\r\n') + '\r\n';
  fs.writeFileSync(f.path, bytes); expect(f.store.list()).toHaveLength(1); expect(fs.readFileSync(f.path, 'utf8')).toBe(bytes);
});
it('only a current trusted grant satisfies CLI LLM automatic-start eligibility', async () => {
  const { networkCommand } = await import('../cli/src/network.js');
  const identityOptions = { env: { SEALBRIDGE_DATA_DIR: root }, home: root };
  const owner = resolveOrCreateIdentity('worker', identityOptions), peer = generateKeyPair();
  const path = workerIntakePath(owner.did), store = new WorkerTrustStore(owner, { path });
  const start = () => networkCommand('worker', ['start', '--adapter', 'openai', '--auto-accept', '--preview',
    '--contacts', join(root, 'contacts.json')], { identityOptions, fetch: async () => { throw new Error('NO_NETWORK'); } });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await expect(start()).rejects.toThrow('LLM_AUTO_ACCEPT_REQUIRES_ALLOWLIST');
  store.enqueue(buildTaskManifest({ ownerDid: peer.did, workerDid: owner.did, title: 'Limited', description: 'Limited' }), {});
  store.decide(store.list()[0].id, 'approve');
  await expect(start()).rejects.toThrow('LLM_AUTO_ACCEPT_REQUIRES_ALLOWLIST');
  store.enqueue(buildTaskManifest({ ownerDid: generateKeyPair().did, workerDid: owner.did, title: 'Trusted', description: 'Trusted' }), {});
  store.decide(store.list().at(-1)!.id, 'approve', 'trusted');
  await expect(start()).resolves.toBeUndefined();
});
