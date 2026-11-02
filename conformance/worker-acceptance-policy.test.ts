// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '../packages/core/src/index.js';
import type { BudgetSpec, Json, KeyPair } from '../packages/core/src/index.js';
import { InMemoryRelay, HttpRelayClient, startLocalRelay } from '../packages/relay/src/index.js';
import {
  PolicyAutoApprovalProvider,
  RequesterClient,
  WorkerNode,
  buildTaskManifest,
} from '../packages/runtime/src/index.js';
import type { AgentAdapter, WorkerAcceptancePolicy } from '../packages/runtime/src/index.js';
import { networkCommand } from '../cli/src/network.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function echoAdapter(calls: Json[]): AgentAdapter {
  return {
    id: 'echo',
    name: 'echo',
    skills: [],
    executeTask: async (context) => {
      calls.push(context.input);
      return context.input;
    },
  };
}

function workerFor(
  owner: KeyPair,
  relay: InMemoryRelay,
  adapter: AgentAdapter,
  options: WorkerAcceptancePolicy = {},
) {
  return new WorkerNode({ checkPeer: () => 'trusted',
    owner,
    relay,
    adapter,
    timeoutMs: 8000,
    approvalProvider: new PolicyAutoApprovalProvider(owner, undefined, {
      acceptance: options,
    }),
    ...options,
  });
}

async function delegate(
  requester: KeyPair,
  relay: InMemoryRelay,
  worker: WorkerNode,
  budget?: Partial<BudgetSpec>,
  manifestPatch?: (manifest: ReturnType<typeof buildTaskManifest>) => void,
) {
  const client = new RequesterClient({
    owner: requester,
    relay,
    timeoutMs: 8000,
    approvalProvider: new PolicyAutoApprovalProvider(requester),
  });
  const manifest = buildTaskManifest({
    ownerDid: requester.did,
    workerDid: worker.options.owner.did,
    agentDid: worker.agentCard.payload.agentDid,
    title: 'Policy',
    description: 'Acceptance policy regression',
    budget,
  });
  manifestPatch?.(manifest);
  return client.delegate({
    to: worker.invite(),
    title: 'Policy',
    description: 'Acceptance policy regression',
    input: { ok: true },
    manifest,
  });
}

describe('worker acceptance policy', () => {
  it('rejects over-budget and unlisted requesters without sending ACCEPT', async () => {
    const relay = new InMemoryRelay();
    const bob = generateKeyPair();
    const alice = generateKeyPair();
    const eve = generateKeyPair();
    const calls: Json[] = [];
    const events: string[] = [];
    const limits = {
      allowedRequesterDids: [alice.did],
      maxInputTokens: 50000,
      maxOutputTokens: 10000,
      maxToolInvocations: 10,
      maxWallClockSeconds: 60,
    };
    const worker = workerFor(bob, relay, echoAdapter(calls), limits);
    worker.options.onEvent = (event) => events.push(event);
    const cases: Array<{ requester: KeyPair; budget?: Partial<BudgetSpec>; reason: string }> = [
      { requester: alice, budget: { maxInputTokens: 50001 }, reason: 'maxInputTokens' },
      { requester: alice, budget: { maxOutputTokens: 10001 }, reason: 'maxOutputTokens' },
      { requester: alice, budget: { maxToolInvocations: 11 }, reason: 'maxToolInvocations' },
      { requester: alice, budget: { maxWallClockSeconds: 61 }, reason: 'maxWallClockSeconds' },
      { requester: eve, reason: 'not allowed' },
    ];
    for (const item of cases) {
      const pending = worker.start({ once: true });
      const [requesterResult, workerResult] = await Promise.allSettled([
        delegate(item.requester, relay, worker, item.budget),
        pending,
      ]);
      expect(requesterResult.status, String(requesterResult.status === 'rejected' ? requesterResult.reason : requesterResult.value)).toBe('rejected');
      expect(workerResult.status, String(workerResult.status === 'rejected' ? workerResult.reason : workerResult.value)).toBe('rejected');
      if (requesterResult.status === 'rejected') {
        const workerText =
          workerResult.status === 'rejected' ? String(workerResult.reason) : 'worker fulfilled';
        expect(String(requesterResult.reason) + ' || ' + workerText).toContain('PROPOSAL_REJECTED');
        expect(String(requesterResult.reason)).toContain(item.reason);
      }
      expect(events).not.toContain('ACCEPT');
      expect(calls).toEqual([]);
      events.length = 0;
    }
    const pending = worker.start({ once: true });
    const [ok, done] = await Promise.all([
      delegate(alice, relay, worker),
      pending,
    ]);
    worker.stop();
    expect(ok.state).toBe('SETTLED');
    expect(done?.state).toBe('SETTLED');
    expect(calls).toEqual([{ ok: true }]);
    expect(events).toContain('ACCEPT');
  });

  it('rejects a manifest timeoutSeconds above maxWallClockSeconds in auto-accept', async () => {
    const owner = generateKeyPair();
    const requester = generateKeyPair();
    const provider = new PolicyAutoApprovalProvider(owner, undefined, {
      acceptance: { maxWallClockSeconds: 30, allowedRequesterDids: [requester.did] },
    });
    const manifest = {
      timeoutSeconds: 31,
      requester: { ownerDid: requester.did, agentDid: requester.did },
      budget: {
        maxInputTokens: 10,
        maxOutputTokens: 10,
        maxToolInvocations: 1,
        maxWallClockSeconds: 30,
      },
    };
    await expect(
      provider.approve({
        taskId: 'task_policytimeout',
        gate: 'contract_acceptance',
        target: 'digest',
        details: { manifest },
      }),
    ).rejects.toMatchObject({ approved: false, reason: expect.stringContaining('timeoutSeconds') });
    const allowed = await provider.approve({
      taskId: 'task_policytimeoutok',
      gate: 'contract_acceptance',
      target: 'digest',
      details: { manifest: { ...manifest, timeoutSeconds: 30 } },
    });
    expect(allowed.payload.decision).toBe('APPROVED');
  });

  it('rejects a spoofed requester agentDid that is not the signed owner', async () => {
    const relay = new InMemoryRelay();
    const bob = generateKeyPair();
    const alice = generateKeyPair();
    const eve = generateKeyPair();
    const calls: Json[] = [];
    const worker = workerFor(bob, relay, echoAdapter(calls), {
      allowedRequesterDids: [alice.did],
    });
    const pending = worker.start({ once: true });
    const [result] = await Promise.allSettled([
      delegate(eve, relay, worker, undefined, (manifest) => {
        manifest.requester.agentDid = alice.did;
      }),
      pending,
    ]);
    worker.stop();
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(String(result.reason)).toContain('not allowed');
    expect(calls).toEqual([]);
  });

  it('rejects proposals once maxConcurrentTasks is reached', async () => {
    const relay = new InMemoryRelay();
    const bob = generateKeyPair();
    const alice = generateKeyPair();
    const carol = generateKeyPair();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const worker = workerFor(
      bob,
      relay,
      {
        id: 'hold',
        name: 'hold',
        skills: [],
        executeTask: async (context) => {
          calls += 1;
          if (calls === 1) await hold;
          return context.input;
        },
      },
      { maxConcurrentTasks: 1 },
    );
    const running = worker.start();
    cleanup.push(async () => {
      release();
      worker.stop();
      await running.catch(() => undefined);
    });
    const first = delegate(alice, relay, worker);
    void first.catch(() => undefined);
    await vi.waitFor(() => {
      if (calls < 1) throw new Error('waiting for the first task');
    });
    await expect(delegate(carol, relay, worker)).rejects.toThrow(/maxConcurrentTasks/);
    expect(calls).toBe(1);
    release();
    await expect(first).resolves.toMatchObject({ state: 'SETTLED' });
  });

  it('rate-limits proposals per requester DID', async () => {
    const relay = new InMemoryRelay();
    const bob = generateKeyPair();
    const alice = generateKeyPair();
    const carol = generateKeyPair();
    const calls: Json[] = [];
    const worker = workerFor(bob, relay, echoAdapter(calls), {
      maxTasksPerRequesterPerMinute: 1,
      requesterRateLimit: { maxRequests: 1, windowMs: 60_000 },
    });
    const running = worker.start();
    cleanup.push(async () => {
      worker.stop();
      await running.catch(() => undefined);
    });
    await expect(delegate(alice, relay, worker)).resolves.toMatchObject({ state: 'SETTLED' });
    await expect(delegate(alice, relay, worker)).rejects.toThrow(/rate limit/);
    await expect(delegate(carol, relay, worker)).resolves.toMatchObject({ state: 'SETTLED' });
    expect(calls).toHaveLength(2);
  });

  it('does not register in the public directory unless publishToRegistry is set', async () => {
    const hiddenRelay = new InMemoryRelay();
    const hidden = workerFor(
      generateKeyPair(),
      hiddenRelay,
      echoAdapter([]),
      {},
    );
    const hiddenRun = hidden.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(hiddenRelay.discover()).toEqual([]);
    hidden.stop();
    await hiddenRun.catch(() => undefined);

    const relay = new InMemoryRelay();
    const owner = generateKeyPair();
    const published = workerFor(owner, relay, echoAdapter([]), { publishToRegistry: true });
    const publishedRun = published.start();
    await vi.waitFor(() => {
      if (relay.discover().length === 0) throw new Error('waiting for registration');
    });
    expect(relay.discover()[0]?.payload.ownerDid).toBe(owner.did);
    published.stop();
    await publishedRun.catch(() => undefined);
  });
});

describe('acp worker CLI acceptance guard', () => {
  async function keyFile(name: string, key = generateKeyPair()) {
    const dir = await mkdtemp(join(realpathSync(tmpdir()), 'acp-p0-1-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, name);
    await writeFile(path, JSON.stringify(key), { mode: 0o600 });
    return { path, key, dir };
  }

  async function relay() {
    const server = await startLocalRelay();
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      // Network outages are now retried. Terminate CLI readers with a permanent auth error.
      server.relay.openInbox = () => { throw new Error('RELAY_UNAUTHORIZED'); };
      await new Promise(resolve => setTimeout(resolve, 1100));
      await server.close();
    };
    cleanup.push(() => close());
    return { url: server.url, close };
  }

  it.each(['claude', 'codex', 'openai'])(
    'refuses --adapter %s --auto-accept without an allowlist',
    async (adapter) => {
      const bob = await keyFile('bob.private.json');
      const server = await relay();
      const pending = networkCommand('worker', [
        'start',
        '--key',
        bob.path,
        '--relay',
        server.url,
        '--allow-private-relay',
        '--adapter',
        adapter,
        '--auto-accept',
        '--once',
      ]);
      cleanup.push(() => pending.catch(() => undefined));
      await expect(pending).rejects.toThrow(/allow-requester/);
    },
    8000,
  );

  it.each(['claude', 'codex', 'openai'])(
    'starts --adapter %s --auto-accept when --allow-requester is set',
    async (adapter) => {
      // This startup-only test configures authentication without executing a task.
      if (adapter === 'claude') vi.stubEnv('ANTHROPIC_API_KEY', 'local-startup-fixture');
      if (adapter === 'codex') vi.stubEnv('OPENAI_API_KEY', 'local-startup-fixture');
      const bob = await keyFile('bob.private.json');
      const alice = generateKeyPair();
      const server = await relay();
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((line) => {
        lines.push(String(line));
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let failure: unknown;
      const pending = networkCommand('worker', [
        'start',
        '--key',
        bob.path,
        '--relay',
        server.url,
        '--allow-private-relay',
        '--adapter',
        adapter,
        '--auto-accept',
        '--allow-requester',
        alice.did,
        '--once',
      ]).catch((error) => {
        failure = error;
      });
      cleanup.push(async () => {
        await server.close().catch(() => undefined);
        await pending.catch(() => undefined);
      });
      await vi.waitFor(() => {
        if (failure) throw failure;
        if (!lines.some((line) => line.startsWith('acp-invite:'))) throw new Error('waiting');
      });
      expect(lines.find((line) => line.startsWith('acp-invite:'))).toBeTruthy();
      await server.close();
      await pending.catch(() => undefined);
    },
  );

  it('parses repeated and comma-separated --allow-requester values without granting execution', async () => {
    const server = await relay();
    const bob = await keyFile('bob.private.json');
    const alice = await keyFile('alice.private.json');
    const carol = await keyFile('carol.private.json');
    const eve = await keyFile('eve.private.json');
    const lines: string[] = [];
    let workerError: unknown;
    vi.spyOn(console, 'log').mockImplementation((line) => {
      lines.push(String(line));
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const audit = join(bob.dir, 'worker.jsonl');
    const pending = networkCommand('worker', [
      'start',
      '--key',
      bob.path,
      '--contacts',
      join(bob.dir, 'contacts.json'),
      '--relay',
      server.url,
      '--allow-private-relay',
      '--adapter',
      'sandbox',
      '--auto-accept',
      '--allow-requester',
      alice.key.did,
      '--allow-requester',
      carol.key.did,
      '--audit',
      audit,
    ]).catch((error) => {
      workerError = error;
    });
    cleanup.push(async () => {
      await server.close().catch(() => undefined);
      await pending.catch(() => undefined);
    });
    await vi.waitFor(() => {
      if (workerError) throw workerError;
      if (!lines.some((line) => line.startsWith('acp-invite:'))) throw new Error('waiting');
    });
    const invite = lines.find((line) => line.startsWith('acp-invite:'))!;
    await expect(
      networkCommand('delegate', [
        '--key',
        eve.path,
        '--to',
        invite,
        '--allow-private-relay',
        '--title',
        'Denied',
        '--description',
        'Unlisted requester',
        '--input',
        '{"ok":true}',
        '--auto-approve',
        '--audit',
        join(eve.dir, 'eve.jsonl'),
      ]),
    ).rejects.toThrow(/not allowed/);
    // The allowlist admits proposals to review; it supplies no inspection or owner opening.
    for (const requester of [alice, carol]) await expect(networkCommand('delegate', [
      '--key',
      requester.path,
      '--to',
      invite,
      '--allow-private-relay',
      '--title',
      'Review',
      '--description',
      'Repeated allow-requester DID',
      '--input',
      '{"ok":true}',
      '--auto-approve',
      '--audit',
      join(requester.dir, 'review.jsonl'),
    ])).rejects.toMatchObject({ code: 'PENDING_OWNER_APPROVAL' });
    const commaBob = await keyFile('comma-bob.private.json');
    const commaAlice = await keyFile('comma-alice.private.json');
    const commaCarol = await keyFile('comma-carol.private.json');
    const commaLines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => {
      commaLines.push(String(line));
    });
    const comma = networkCommand('worker', [
      'start',
      '--key',
      commaBob.path,
      '--contacts',
      join(commaBob.dir, 'contacts.json'),
      '--relay',
      server.url,
      '--allow-private-relay',
      '--adapter',
      'sandbox',
      '--auto-accept',
      '--allow-requester',
      commaAlice.key.did + ',' + commaCarol.key.did,
      '--audit',
      join(commaBob.dir, 'worker.jsonl'),
    ]);
    void comma.catch(() => undefined);
    cleanup.push(async () => {
      await server.close().catch(() => undefined);
      await comma.catch(() => undefined);
    });
    await vi.waitFor(() => {
      if (!commaLines.some((line) => line.startsWith('acp-invite:'))) throw new Error('waiting');
    });
    const commaInvite = commaLines.find((line) => line.startsWith('acp-invite:'))!;
    for (const requester of [commaAlice, commaCarol]) await expect(networkCommand('delegate', [
      '--key',
      requester.path,
      '--to',
      commaInvite,
      '--allow-private-relay',
      '--title',
      'Comma',
      '--description',
      'Comma-separated allowlist',
      '--input',
      '{"ok":true}',
      '--auto-approve',
      '--audit',
      join(requester.dir, 'review.jsonl'),
    ])).rejects.toMatchObject({ code: 'PENDING_OWNER_APPROVAL' });
    expect(workerError).toBeUndefined();
  });

  it('registers only when --publish is set', async () => {
    const server = await relay();
    const bob = await keyFile('bob.private.json');
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => {
      lines.push(String(line));
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const hidden = networkCommand('worker', [
      'start',
      '--key',
      bob.path,
      '--relay',
      server.url,
      '--allow-private-relay',
      '--adapter',
      'sandbox',
      '--once',
    ]).catch(() => undefined);
    cleanup.push(async () => {
      await server.close().catch(() => undefined);
      await hidden.catch(() => undefined);
    });
    await vi.waitFor(() => {
      if (!lines.some((line) => line.startsWith('acp-invite:'))) throw new Error('waiting');
    });
    expect(await new HttpRelayClient(server.url, { allowPrivateRelay: true }).discover()).toEqual(
      [],
    );
    await server.close();
    await hidden.catch(() => undefined);

    const publishedServer = await relay();
    const publishedLines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => {
      publishedLines.push(String(line));
    });
    const published = networkCommand('worker', [
      'start',
      '--key',
      bob.path,
      '--relay',
      publishedServer.url,
      '--allow-private-relay',
      '--adapter',
      'sandbox',
      '--publish',
      '--once',
    ]).catch(() => undefined);
    cleanup.push(async () => {
      await publishedServer.close().catch(() => undefined);
      await published.catch(() => undefined);
    });
    await vi.waitFor(() => {
      if (!publishedLines.some((line) => line.startsWith('acp-invite:')))
        throw new Error('waiting');
    });
    const cards = await new HttpRelayClient(publishedServer.url, { allowPrivateRelay: true }).discover();
    expect(cards.map((card) => card.payload.ownerDid)).toContain(bob.key.did);
  });
});
