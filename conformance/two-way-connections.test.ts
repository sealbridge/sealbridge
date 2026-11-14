// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInviteToken, createSignedAgentCard } from '../packages/core/src/index.js';
import { parseJsonl, verifyAudit } from '../packages/ledger/src/index.js';
import { createRelayFetchHandler, HttpRelayClient } from '../packages/relay/src/index.js';
import { delegatedWorkerIdentity, HeldRequestReview, InviteStore, migrateWorkerIdentity, PolicyAutoApprovalProvider,
  resolveStoredIdentity, setApplicationAutoAccept, WorkerNode, WorkerTrustStore, workerIntakePath } from '../packages/runtime/src/index.js';
import { networkCommand } from '../cli/src/network.js';
import { connectionTarget, localConnections } from '../cli/src/connection-target.js';
import { completeInspection } from './connections-fixture.js';
import { protocolTestNow } from './protocol-test-clock.js';

let root: string;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(protocolTestNow('2026-11-14T00:00:00Z'));
  root = mkdtempSync(join(tmpdir(), 'two-way-connections-'));
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

it.each([
  ['--requester-auto-accept', 'write'],
  ['--also-requester', '--requester-auto-accept', 'anyone'],
  ['--also-requester', 'yes'],
  ['--also-requester', '--key', 'unused'],
])('rejects invalid requester-listener options before starting workers: %j', async (...flags) => {
  await expect(networkCommand('worker', ['start', '--allow-local-pc', ...flags], {
    identityOptions: { home: root, env: { SEALBRIDGE_DATA_DIR: join(root, 'invalid') } },
  })).rejects.toThrow(/INVALID_|CONFLICTING_REQUESTER_LISTENER_OPTIONS/);
});

it.each(['unmigrated', 'worker-key-only', 'migrated', 'pre-migration invite'] as const)(
  '%s: one invite supports B to A and A to B with four VALID audits and no directory publishing', async mode => {
    const aOptions = { home: root, env: { SEALBRIDGE_DATA_DIR: join(root, 'a') } };
    const bOptions = { home: root, env: { SEALBRIDGE_DATA_DIR: join(root, 'b') } };
    const legacyA = await resolveStoredIdentity('worker', aOptions);
    if (mode !== 'worker-key-only') await resolveStoredIdentity('requester', aOptions);
    const bOwner = await resolveStoredIdentity('requester', bOptions);
    await resolveStoredIdentity('worker', bOptions);
    const oldInvite = mode === 'pre-migration invite' ? createInviteToken({ agentCard: createSignedAgentCard({
      name: 'Alpha', agentDid: legacyA.did, relayEndpoint: 'https://relay.example', skills: [], protocolVersions: ['0.2.0'],
    }, legacyA) }, legacyA) : undefined;
    if (mode === 'migrated' || mode === 'pre-migration invite') {
      await migrateWorkerIdentity(aOptions, false); await migrateWorkerIdentity(bOptions, false);
    }
    const aDelegation = await delegatedWorkerIdentity(aOptions);
    const aOwner = mode === 'pre-migration invite' ? legacyA : aDelegation?.owner ?? legacyA;
    const agentKey = mode === 'pre-migration invite' ? undefined : aDelegation?.agentKey;
    const url = 'https://relay.example', handler = createRelayFetchHandler();
    const fetcher: typeof fetch = async (input, init) => handler(new Request(input, init));
    const worker = new WorkerNode({ owner: aOwner, agentKey, acceptOwnerAgent: !!agentKey,
      name: 'Alpha', relay: new HttpRelayClient(url, fetcher, aOwner), relayUrl: url, identityOptions: aOptions,
      heldReview: new HeldRequestReview(aOwner, { ...aOptions, provider: completeInspection }),
      autoAccept: { version: 1, enabled: true, from: 'invited', work: 'read-only', limits: {} },
      adapter: { id: 'echo', name: 'Alpha', taskAccess: 'read-only', skills: [], executeTask: async c => c.input },
      approvalProvider: new PolicyAutoApprovalProvider(aOwner), timeoutMs: 5000,
      auditPath: join(root, 'a-worker.jsonl') });
    const token = oldInvite ?? worker.invite();
    const saved = (await InviteStore.open(bOwner, bOptions)).import(token, 'old-reviewer');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let running: Promise<void> | undefined;
    try {
      const first = await Promise.allSettled([worker.start({ once: true }), networkCommand('delegate', [
        mode === 'unmigrated' || mode === 'migrated' ? '--to' : '--peer-ref', saved.workerRef, '--title', 'First', '--description', 'Echo', '--input', '{"direction":"B to A"}',
        '--auto-approve', '--audit', join(root, 'b-requester.jsonl'), '--wait-timeout-ms', '5000',
      ], { identityOptions: bOptions, fetch: fetcher, connectionReview: async () => true })]);
      for (const result of first) { if (result.status === 'rejected') throw result.reason; }
      expect(new WorkerTrustStore(aOwner, { path: workerIntakePath(aOwner.did, aOptions) }).connectionState(bOwner.did)).toBe('connected');
      expect(new WorkerTrustStore(bOwner, { path: workerIntakePath(bOwner.did, bOptions) }).connectionState(aOwner.did)).toBe('connected');
      expect(localConnections(bOwner, bOptions)[0].alias).toBe('alpha');
      const alias = localConnections(aOwner, aOptions)[0].alias;
      expect((await connectionTarget(alias, aOptions))?.key.did).toBe(aOwner.did);
      // Return routing uses the connection, independently of the original bearer invite's lifetime.
      vi.setSystemTime(Date.now() + 2 * 86400000);
      // Explicit test acceptance exercises routing; production defaults are unchanged.
      setApplicationAutoAccept({ version: 1, enabled: true, from: 'connected', work: 'write', limits: {} }, bOptions);
      let ready!: () => void;
      const started = new Promise<void>(resolve => { ready = resolve; });
      output.mockImplementation(value => { if (String(value).startsWith('acp-invite:')) ready(); });
      running = networkCommand('worker', ['start', '--relay', url, '--adapter', 'sandbox', '--allow-local-pc',
        '--once', '--auto-accept', ...(mode === 'unmigrated' || mode === 'worker-key-only'
          ? ['--also-requester', '--requester-auto-accept', 'write'] : []), '--audit', join(root, 'b-worker.jsonl')], { identityOptions: bOptions, fetch: fetcher });
      void running.catch(ready);
      await started;
      await networkCommand('delegate', ['--to', alias, '--title', 'Return', '--description', 'Echo',
        '--input', '{"direction":"A to B"}', '--auto-approve', '--audit', join(root, 'a-requester.jsonl'),
        '--wait-timeout-ms', '5000'], { identityOptions: aOptions, fetch: fetcher });
      await running;
      for (const path of ['a-worker.jsonl', 'b-requester.jsonl', 'a-requester.jsonl',
        mode === 'unmigrated' || mode === 'worker-key-only' ? 'b-worker.requester.jsonl' : 'b-worker.jsonl']) {
        expect(verifyAudit(parseJsonl(readFileSync(join(root, path), 'utf8'))).valid, path).toBe(true);
      }
    } finally {
      worker.stop();
      if (running) { process.emit('SIGINT'); await running.catch(() => {}); }
    }
  }, 30000);
