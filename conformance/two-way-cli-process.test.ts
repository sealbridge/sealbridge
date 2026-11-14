// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startLocalRelay } from '../packages/relay/src/index.js';
import { parseAndVerifyInviteToken } from '../packages/core/src/index.js';
import { resolveStoredIdentity, migrateWorkerIdentity, setApplicationAutoAccept } from '../packages/runtime/src/index.js';
import { parseJsonl, verifyAudit } from '../packages/ledger/src/index.js';

const roots: string[] = [];
interface CliActor {
  child: ChildProcess; closed: Promise<number | null>; exited: boolean; stdout: string; stderr: string; answered: boolean;
  waitFor(predicate: () => boolean, timeout?: number): Promise<void>;
  success(): Promise<string>; stop(): Promise<void>;
}
const actors: CliActor[] = [];
afterEach(async () => {
  for (const a of actors.splice(0)) {
    if (!a.exited) a.child.kill('SIGKILL');
    await a.closed;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function actor(root: string, args: string[], terminal = false): CliActor {
  const child = spawn(process.execPath, ['--require', resolve('conformance/fixtures/cli-terminal.cjs'),
    resolve('cli/dist/index.js'), ...args], { env: { ...process.env, SEALBRIDGE_DATA_DIR: root,
      SEALBRIDGE_KEY_STORE: 'file', SEALBRIDGE_TEST_TERMINAL: terminal ? '1' : '0' }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = '', exited = false, answered = false;
  const changed = new Set<() => void>();
  child.stdout!.on('data', chunk => { stdout += chunk; for (const fn of changed) fn(); });
  child.stderr!.on('data', chunk => {
    stderr += chunk;
    if (terminal && !answered && stderr.includes('Confirm owner decision [y/N]?')) {
      answered = true; child.stdin!.write('y\n');
    }
    for (const fn of changed) fn();
  });
  const closed = new Promise<number | null>((res, rej) => {
    child.once('error', rej); child.once('close', code => { exited = true; res(code); for (const fn of changed) fn(); });
  });
  const diagnostic = () => (stderr + stdout).replace(/acp-invite:[A-Za-z0-9_-]+/g, '[invitation]');
  function waitFor(predicate: () => boolean, timeout = 10000): Promise<void> {
    return new Promise((res, rej) => {
      const done = (error?: Error) => { clearTimeout(timer); changed.delete(check); error ? rej(error) : res(); };
      const check = () => { if (predicate()) done(); else if (exited) done(new Error('CLI exited: ' + diagnostic())); };
      const timer = setTimeout(() => done(new Error('CLI timeout: ' + diagnostic())), timeout);
      changed.add(check); check();
    });
  }
  const value = { child, closed, get exited() { return exited; }, get stdout() { return stdout; }, get stderr() { return stderr; },
    get answered() { return answered; }, waitFor,
    async success() { await waitFor(() => exited, 15000); expect(await closed, diagnostic()).toBe(0); return stdout; },
    async stop() {
      if (!exited) { if (process.platform === 'win32') child.send('SIGTERM'); else child.kill('SIGTERM'); }
      await waitFor(() => exited, 5000);
      expect(await closed, stderr).toBe(0);
      expect(stderr).toContain('stopped');
    } };
  actors.push(value); return value;
}
async function folder(root: string) {
  const options = { home: root, env: { SEALBRIDGE_DATA_DIR: root, SEALBRIDGE_KEY_STORE: 'file' } };
  await resolveStoredIdentity('worker', options); await resolveStoredIdentity('requester', options);
  return options;
}
const workerArgs = (url: string, audit: string) => ['worker', 'start', '--relay', url, '--allow-private-relay',
  '--adapter', 'sandbox', '--allow-local-pc', '--auto-accept', '--audit', audit];
const delegateArgs = (target: string, audit: string) => ['delegate', '--to', target, '--allow-private-relay',
  '--title', 'Echo', '--description', 'Echo JSON', '--input', '{"ok":true}', '--auto-approve', '--audit', audit,
  '--wait-timeout-ms', '5000'];

it.each([false, true])('real CLI processes: importer off/allow/disallow despite anyone-write, creator settles, warning/quiet JSON and VALID audits; migrated=%s; SIGTERM exits', async migrated => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'two-way-cli-')); roots.push(root);
  const a = join(root, 'a'), b = join(root, 'b');
  const aOptions = await folder(a), bOptions = await folder(b);
  if (migrated) { await migrateWorkerIdentity(aOptions, false); await migrateWorkerIdentity(bOptions, false); }
  setApplicationAutoAccept({ version: 1, enabled: true, from: 'anyone', work: 'write', limits: {} }, aOptions);
  // This permissive main-worker setting must not be inherited by the separate requester listener.
  setApplicationAutoAccept({ version: 1, enabled: true, from: 'anyone', work: 'write', limits: {} }, bOptions);
  const relay = await startLocalRelay({ port: 0 });
  try {
    const created = await actor(a, ['invite', 'create', '--relay', relay.url, '--allow-private-relay', '--name', 'Alpha']).success();
    const token = created.trim().split(/\r?\n/)[0];
    parseAndVerifyInviteToken(token, Date.now(), { allowPrivateRelay: true });
    const aWorker = actor(a, workerArgs(relay.url, join(root, 'a-worker.jsonl')));
    await aWorker.waitFor(() => aWorker.stderr.includes('invite_ready'));
    await actor(b, ['accept', token, '--alias', 'alpha', '--allow-private-relay']).success();
    const first = actor(b, delegateArgs('alpha', join(root, 'b-requester.jsonl')), true);
    await first.success(); expect(first.answered).toBe(true);
    const listB = JSON.parse(await actor(b, ['connections', 'list', '--role', 'requester']).success());
    expect(listB.connections).toContainEqual(expect.objectContaining({ alias: 'alpha', state: 'connected' }));
    const listA = JSON.parse(await actor(a, ['connections', 'list']).success());
    const connection = listA.connections.find((c: { state: string }) => c.state === 'connected');
    expect(connection).toBeDefined();
    // A second B->A uses the real connection alias while preserving same-peer saved alias resolution.
    await actor(b, delegateArgs('alpha', join(root, 'b-again.jsonl')), true).success();
    await actor(b, ['connections', 'alias', listB.connections[0].peerOwnerDid, 'alpha-connected', '--role', 'requester']).success();
    // Also exercise connection-list-only resolution, with no saved-invite alias overlap.
    await actor(b, delegateArgs('alpha-connected', join(root, 'b-connected.jsonl')), true).success();
    const bWorker = actor(b, [...workerArgs(relay.url, join(root, 'b-worker.jsonl')),
      ...(!migrated ? ['--also-requester', '--requester-auto-accept', 'write'] : [])]);
    await bWorker.waitFor(() => bWorker.stderr.includes('invite_ready'));
    const held = actor(a, delegateArgs(connection.alias, join(root, 'a-held.jsonl')));
    await held.waitFor(() => held.exited);
    expect(await held.closed).not.toBe(0);
    expect(held.stderr).toContain('PENDING_OWNER_APPROVAL');
    expect(held.stderr).toContain('may wait for the peer owner approval');
    expect(listB.connections[0].acceptance).toBe('off');
    await actor(b, ['connections', 'allow', 'alpha-connected']).success();
    const readOnly = actor(a, delegateArgs(connection.alias, join(root, 'a-readonly.jsonl')));
    await readOnly.waitFor(() => readOnly.exited);
    expect(await readOnly.closed).not.toBe(0);
    expect(readOnly.stderr).toContain('PENDING_OWNER_APPROVAL'); // sandbox adapter declares write access
    await actor(b, ['connections', 'allow', 'alpha-connected', 'write']).success();
    const allowed = actor(a, delegateArgs(connection.alias, join(root, 'a-requester.jsonl')), true);
    const result = JSON.parse((await allowed.success()).trim().split(/\r?\n/).at(-1)!);
    expect(result).toMatchObject({ state: 'SETTLED', audit: 'VALID', acceptanceWarning: { code: 'PEER_APPROVAL_MAY_BE_REQUIRED' } });
    expect(allowed.stderr).toContain('may wait for the peer owner approval');
    const quiet = actor(a, [...delegateArgs(connection.alias, join(root, 'a-quiet.jsonl')), '--quiet-approval-warning'], true);
    const quietResult = JSON.parse((await quiet.success()).trim().split(/\r?\n/).at(-1)!);
    expect(quiet.stderr).not.toContain('may wait for the peer owner approval');
    expect(quietResult.acceptanceWarning.code).toBe('PEER_APPROVAL_MAY_BE_REQUIRED');
    await actor(b, ['connections', 'disallow', 'alpha-connected']).success();
    const denied = actor(a, [...delegateArgs(connection.alias, join(root, 'a-disallowed.jsonl')), '--quiet-approval-warning']);
    await denied.waitFor(() => denied.exited);
    expect(await denied.closed).not.toBe(0);
    expect(denied.stderr).toContain('PENDING_OWNER_APPROVAL');
    // Creator admission remains unchanged after importer permission is revoked.
    await actor(b, delegateArgs('alpha-connected', join(root, 'b-final.jsonl')), true).success();
    await bWorker.stop(); await aWorker.stop();
    const bAudit = (migrated ? 'b-worker' : 'b-worker.requester') + '.' + result.taskId + '.jsonl';
    for (const path of ['a-worker.jsonl', 'b-requester.jsonl', 'a-requester.jsonl', bAudit, 'a-quiet.jsonl', 'b-final.jsonl'])
      expect(verifyAudit(parseJsonl(readFileSync(join(root, path), 'utf8'))).valid, path).toBe(true);
  } finally { for (const a of actors) if (!a.exited) a.child.kill('SIGKILL'); await Promise.all(actors.map(a => a.closed)); await relay.close(); }
}, 60000);

it.each([false, true])('requester receiving is opt-in and never inherits anyone-write / --auto-accept; opt-in=%s', async optIn => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'requester-opt-in-')); roots.push(root);
  const receiver = join(root, 'receiver'), stranger = join(root, 'stranger');
  const options = await folder(receiver); await folder(stranger);
  const requester = await resolveStoredIdentity('requester', options);
  setApplicationAutoAccept({ version: 1, enabled: true, from: 'anyone', work: 'write', limits: {} }, options);
  const relay = await startLocalRelay({ port: 0 });
  try {
    const worker = actor(receiver, [...workerArgs(relay.url, join(root, 'worker.jsonl')), ...(optIn ? ['--also-requester'] : [])]);
    await worker.waitFor(() => worker.stderr.includes('invite_ready'));
    const attempt = actor(stranger, [...delegateArgs(requester.did, join(root, 'stranger.jsonl')),
      '--relay', relay.url, '--task-timeout-ms', '2000', '--execution-timeout-ms', '1000', '--connect-timeout-ms', '1000']);
    await attempt.waitFor(() => attempt.exited, 10000);
    expect(await attempt.closed, attempt.stderr).not.toBe(0);
    const tasks = JSON.parse(await actor(receiver, ['tasks', 'list', '--role', 'requester']).success()).tasks;
    if (optIn) {
      expect(attempt.stderr).toContain('PENDING_OWNER_APPROVAL');
      expect(tasks).toHaveLength(1);
    } else {
      expect(attempt.stderr).not.toContain('PENDING_OWNER_APPROVAL');
      expect(tasks).toEqual([]);
    }
    await worker.stop();
  } finally { for (const a of actors) if (!a.exited) a.child.kill('SIGKILL'); await Promise.all(actors.map(a => a.closed)); await relay.close(); }
}, 30000);
