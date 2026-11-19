// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  existsSync,
  writeFileSync,
  unlinkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startLocalRelay } from '../packages/relay/src/index.js';
import { generateKeyPair, signEnvelope } from '../packages/core/src/index.js';
import {
  resolveStoredIdentity,
  migrateWorkerIdentity,
  setApplicationAutoAccept,
} from '../packages/runtime/src/index.js';
import { GatewayDeliveryService } from '../packages/runtime/src/outbox.js';
import { parseJsonl, verifyAudit } from '../packages/ledger/src/index.js';

const roots: string[] = [];
interface CliActor {
  child: ChildProcess;
  closed: Promise<number | null>;
  exited: boolean;
  stdout: string;
  stderr: string;
  answered: boolean;
  waitFor(predicate: () => boolean, timeout?: number): Promise<void>;
  success(): Promise<string>;
  stop(): Promise<void>;
}
const actors: CliActor[] = [];
afterEach(async () => {
  for (const a of actors.splice(0)) {
    if (!a.exited) a.child.kill('SIGKILL');
    await a.closed;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function actor(root: string, args: string[], terminal = false, observeLock = false): CliActor {
  const child = spawn(
    process.execPath,
    [
      '--require',
      resolve('conformance/fixtures/cli-terminal.cjs'),
      ...(observeLock
        ? ['--require', resolve('conformance/fixtures/outbox-lock-terminal.cjs')]
        : []),
      resolve('cli/dist/index.js'),
      ...args,
    ],
    {
      env: {
        ...process.env,
        SEALBRIDGE_DATA_DIR: root,
        SEALBRIDGE_KEY_STORE: 'file',
        SEALBRIDGE_TEST_TERMINAL: terminal ? '1' : '0',
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    },
  );
  let stdout = '',
    stderr = '',
    exited = false,
    answered = false;
  const changed = new Set<() => void>();
  child.stdout!.on('data', (chunk) => {
    stdout += chunk;
    for (const fn of changed) fn();
  });
  child.stderr!.on('data', (chunk) => {
    stderr += chunk;
    if (terminal && !answered && stderr.includes('Confirm owner decision [y/N]?')) {
      answered = true;
      child.stdin!.write('y\n');
    }
    for (const fn of changed) fn();
  });
  const closed = new Promise<number | null>((res, rej) => {
    child.once('error', rej);
    child.once('close', (code) => {
      exited = true;
      res(code);
      for (const fn of changed) fn();
    });
  });
  const diagnostic = () => (stderr + stdout).replace(/acp-invite:[A-Za-z0-9_-]+/g, '[invitation]');
  function waitFor(predicate: () => boolean, timeout = 10000): Promise<void> {
    return new Promise((res, rej) => {
      const done = (error?: Error) => {
        clearTimeout(timer);
        changed.delete(check);
        error ? rej(error) : res();
      };
      const check = () => {
        if (predicate()) done();
        else if (exited) done(new Error('CLI exited: ' + diagnostic()));
      };
      const timer = setTimeout(() => done(new Error('CLI timeout: ' + diagnostic())), timeout);
      changed.add(check);
      check();
    });
  }
  const value = {
    child,
    closed,
    get exited() {
      return exited;
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    get answered() {
      return answered;
    },
    waitFor,
    async success() {
      await waitFor(() => exited, 15000);
      expect(await closed, diagnostic()).toBe(0);
      return stdout;
    },
    async stop() {
      if (!exited) {
        if (process.platform === 'win32') child.send('SIGTERM');
        else child.kill('SIGTERM');
      }
      await waitFor(() => exited, 5000);
      expect(await closed, stderr).toBe(0);
      expect(stderr).toContain('stopped');
    },
  };
  actors.push(value);
  return value;
}
async function folder(root: string) {
  const options = { home: root, env: { SEALBRIDGE_DATA_DIR: root, SEALBRIDGE_KEY_STORE: 'file' } };
  await resolveStoredIdentity('worker', options);
  await resolveStoredIdentity('requester', options);
  return options;
}
const workerArgs = (url: string, audit: string) => [
  'worker',
  'start',
  '--relay',
  url,
  '--allow-private-relay',
  '--adapter',
  'sandbox',
  '--allow-local-pc',
  '--auto-accept',
  '--audit',
  audit,
];
const delegateArgs = (target: string, audit: string) => [
  'delegate',
  '--to',
  target,
  '--allow-private-relay',
  '--title',
  'Echo',
  '--description',
  'Echo JSON',
  '--input',
  '{"ok":true}',
  '--auto-approve',
  '--audit',
  audit,
  '--wait-timeout-ms',
  '5000',
];

it.each([false, true])(
  'same-folder worker and bidirectional CLI sends remain concurrent with VALID audits; migrated=%s',
  async (migrated) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'outbox-concurrent-'));
    roots.push(root);
    const a = join(root, 'a'),
      b = join(root, 'b');
    const aOptions = await folder(a),
      bOptions = await folder(b);
    if (migrated) {
      await migrateWorkerIdentity(aOptions, false);
      await migrateWorkerIdentity(bOptions, false);
    }
    for (const options of [aOptions, bOptions])
      setApplicationAutoAccept(
        { version: 1, enabled: true, from: 'anyone', work: 'write', limits: {} },
        options,
      );
    const relay = await startLocalRelay({ port: 0 });
    try {
      const created = await actor(a, [
        'invite',
        'create',
        '--relay',
        relay.url,
        '--allow-private-relay',
        '--name',
        'Alpha',
      ]).success();
      const token = created.trim().split(/\r?\n/)[0];
      const aWorker = actor(a, [
        ...workerArgs(relay.url, join(root, 'a-worker.jsonl')),
        '--max-requests-per-minute',
        '10000',
      ]);
      await aWorker.waitFor(() => aWorker.stderr.includes('invite_ready'));
      await actor(b, ['accept', token, '--alias', 'alpha', '--allow-private-relay']).success();
      await actor(b, delegateArgs('alpha', join(root, 'initial.jsonl')), true).success();
      const listA = JSON.parse(await actor(a, ['connections', 'list']).success());
      const reverse = listA.connections.find(
        (c: { state: string }) => c.state === 'connected',
      ).alias;
      await actor(b, ['connections', 'allow', 'alpha', 'write']).success();
      const bWorker = actor(b, [
        ...workerArgs(relay.url, join(root, 'b-worker.jsonl')),
        '--max-requests-per-minute',
        '10000',
        ...(!migrated ? ['--also-requester', '--requester-auto-accept', 'write'] : []),
      ]);
      await bWorker.waitFor(() => bWorker.stderr.includes('invite_ready'));
      const audits: Array<{ path: string; taskId: string }> = [];
      const taskIds = new Set<string>();
      let index = 0,
        settled = 0,
        limited = 0;
      const send = async (forward: boolean) => {
        const path = join(root, `send-${index++}.jsonl`);
        const attempt = actor(
          forward ? b : a,
          delegateArgs(forward ? 'alpha' : reverse, path),
          true,
        );
        await attempt.waitFor(() => attempt.exited, 20000);
        if ((await attempt.closed) !== 0) {
          expect(attempt.stderr, (aWorker.stderr + bWorker.stderr).slice(-12000)).toContain(
            'INTAKE_RATE_LIMITED',
          );
          expect(attempt.stderr).not.toMatch(
            /OUTBOX_STORE_INVALID|Error: OUTBOX_STORE_(?:BUSY|UNWRITABLE)/,
          );
          limited++;
          return; // Expected intake limit; never resubmit a proposal.
        }
        settled++;
        const result = JSON.parse(attempt.stdout.trim().split(/\r?\n/).at(-1)!);
        expect(result).toMatchObject({
          state: 'SETTLED',
          audit: 'VALID',
          deliverable: { ok: true },
        });
        expect(taskIds.has(result.taskId)).toBe(false);
        taskIds.add(result.taskId);
        audits.push({ path, taskId: result.taskId });
        const receiver = forward ? 'a-worker' : migrated ? 'b-worker' : 'b-worker.requester';
        audits.push({
          path: join(root, receiver + '.' + result.taskId + '.jsonl'),
          taskId: result.taskId,
        });
      };
      for (let round = 0; round < 12; round++) {
        await Promise.all(Array.from({ length: 4 }, (_, i) => send(i % 2 === 0)));
        for (let i = 0; i < 4; i++) await send(i % 2 === 0);
        expect(aWorker.exited, aWorker.stderr).toBe(false);
        expect(bWorker.exited, bWorker.stderr).toBe(false);
      }
      console.info(
        `outbox concurrent migrated=${migrated}: ${settled} settled, ${limited} intake-limited, ${index} total; no resubmissions`,
      );
      expect(settled).toBeGreaterThanOrEqual(4);
      expect(settled + limited).toBe(96);
      await bWorker.stop();
      await aWorker.stop();
      for (const { path, taskId } of audits) {
        // The first task uses the base audit; subsequent tasks get task suffixes.
        const base = path.replace(/\.task_[^.]+\.jsonl$/, '.jsonl');
        const actual = existsSync(path) ? path : base;
        try {
          expect(
            verifyAudit(parseJsonl(readFileSync(actual, 'utf8')), { taskId }).valid,
            actual,
          ).toBe(true);
        } catch (error) {
          throw new Error(
            `audit=${actual}; expectedTask=${taskId}; ${String(error)}; worker diagnostics:\n${(aWorker.stderr + bWorker.stderr).slice(-12000)}`,
          );
        }
      }
      expect(aWorker.stderr + bWorker.stderr).not.toMatch(
        /OUTBOX_STORE_INVALID|unhandledRejection/,
      );
    } finally {
      for (const a of actors) if (!a.exited) a.child.kill('SIGKILL');
      await Promise.all(actors.map((a) => a.closed));
      await relay.close();
    }
  },
  300000,
);

it('CLI worker SIGTERM exits zero while startup is waiting on another writer lock', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'outbox-sigterm-cli-'));
  roots.push(root);
  const options = await folder(root),
    identity = await resolveStoredIdentity('worker', options),
    peer = generateKeyPair();
  const relay = await startLocalRelay({ port: 0 });
  const service = new GatewayDeliveryService(identity, {
    identityOptions: options,
    resolveTransport: () => {
      throw new Error('UNEXPECTED_SEND');
    },
  });
  const frame = signEnvelope(
    {
      taskId: 'task_shutdown_lock',
      recipientDid: peer.did,
      seq: 0,
      eventType: 'PROPOSE',
      payload: { test: true },
    },
    identity,
    { encrypt: true },
  );
  service.enqueue([frame], {
    messageId: frame.payload.envelopeId,
    peerOwnerDid: peer.did,
    relayUrl: relay.url,
    deliveryDeadline: Date.now() + 60000,
    message: { taskId: frame.payload.taskId, peerAgentDid: peer.did, protocolVersion: '0.2.0' },
  });
  const lock = join(service.store.root, '.lock');
  writeFileSync(lock, '', { mode: 0o600 });
  try {
    const worker = actor(root, workerArgs(relay.url, join(root, 'shutdown.jsonl')), false, true);
    await worker.waitFor(() => worker.stderr.includes('TEST_OUTBOX_LOCK_WAIT'));
    const start = performance.now();
    await worker.stop();
    expect(performance.now() - start).toBeLessThan(1500);
    expect(existsSync(lock)).toBe(true);
    expect(worker.stderr).not.toContain('WORKER_TERMINAL');
  } finally {
    unlinkSync(lock);
    service.stop();
    await relay.close();
  }
});
