// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, createSignedAgentCard, createInviteToken } from '../packages/core/src/index.js';
import { InMemoryRelay, startLocalRelay } from '../packages/relay/src/index.js';
import { PolicyAutoApprovalProvider, RequesterClient, WorkerNode } from '../packages/runtime/src/index.js';
import type { AgentAdapter } from '../packages/runtime/src/index.js';
import { networkCommand } from '../cli/src/network.js';
import { addContact, updateContacts } from '../cli/src/contacts.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function directory() {
  const dir = await mkdtemp(join(realpathSync(tmpdir()), 'acp-inbox-'));
  dirs.push(dir);
  return dir;
}
async function fixture(inboxPath?: string, reject = false, onInboxRecord?: (record: string) => void | Promise<void>) {
  const relay = new InMemoryRelay();
  const owner = generateKeyPair(), requester = generateKeyPair();
  const calls: unknown[] = [];
  const adapter: AgentAdapter = {
    id: 'inbox-test', name: 'inbox-test', skills: [],
    executeTask: async (ctx) => {
      // The complete message must already be visible when execution begins.
      calls.push(inboxPath ? JSON.parse((await readFile(inboxPath, 'utf8')).trim().split('\n').at(-1)!) : ctx.input);
      return ctx.input;
    },
  };
  const acceptance = reject ? { allowedRequesterDids: [generateKeyPair().did] } : {};
  const worker = new WorkerNode({ checkPeer: () => 'trusted', owner, relay, adapter, inboxPath, onInboxRecord, ...acceptance,
    approvalProvider: new PolicyAutoApprovalProvider(owner, undefined, { acceptance }), timeoutMs: 3000 });
  const client = new RequesterClient({ owner: requester, relay,
    approvalProvider: new PolicyAutoApprovalProvider(requester), timeoutMs: 3000 });
  async function run(input: { message: string }) {
    const pending = worker.start({ once: true });
    return Promise.allSettled([client.delegate({ to: worker.invite(), title: 'Sprint 1',
      description: '仕様\n複数行', input }), pending]);
  }
  return { worker, requester, calls, run };
}

describe('Sprint 1 accepted task inbox', () => {
  it.each(['pending', 'throw', 'reject'] as const)('settles independently of a %s notification', async (mode) => {
    const inbox = join(await directory(), 'notify.jsonl');
    const notify = vi.fn((record: string) => {
      expect(JSON.parse(record).input).toEqual({ message: 'notify' });
      if (mode === 'throw') throw new Error('hook failed');
      if (mode === 'reject') return Promise.reject(new Error('hook failed'));
      return new Promise<void>(() => undefined);
    });
    const f = await fixture(inbox, false, notify);
    expect((await f.run({ message: 'notify' })).map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(notify).toHaveBeenCalledExactlyOnceWith(await readFile(inbox, 'utf8'));
    f.worker.stop();
  });

  it('does not notify without a persisted inbox record', async () => {
    const notify = vi.fn();
    for (const [path, reject] of [[undefined, false], [join(await directory(), 'missing', 'inbox'), false], [join(await directory(), 'rejected'), true]] as const) {
      const f = await fixture(path, reject, notify);
      await f.run({ message: 'no notification' });
      f.worker.stop();
    }
    expect(notify).not.toHaveBeenCalled();
  });

  it('appends decrypted complete messages exactly once per accepted task before execution', async () => {
    const inbox = join(await directory(), 'inbox.jsonl');
    const f = await fixture(inbox);
    for (const message of ['hello\nworld', '次の仕様']) {
      const results = await f.run({ message });
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    }
    const lines = (await readFile(inbox, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((line) => line.taskId)).size).toBe(2);
    expect(lines[0]).toEqual({ envelopeId: expect.any(String), receivedAt: expect.any(String), taskId: expect.any(String),
      requesterOwnerDid: f.requester.did, requesterAgentDid: f.requester.did,
      title: 'Sprint 1', description: '仕様\n複数行', input: { message: 'hello\nworld' } });
    expect(Number.isFinite(Date.parse(lines[0].receivedAt))).toBe(true);
    expect(f.calls).toEqual(lines);
    if (process.platform !== 'win32') expect((await stat(inbox)).mode & 0o777).toBe(0o600);
    f.worker.stop();
  });

  it('sets owner-only permissions on an existing inbox and preserves its previous lines', async () => {
    const inbox = join(await directory(), 'inbox.jsonl');
    await writeFile(inbox, '{"previous":true}\n', { mode: 0o644 });
    const f = await fixture(inbox);
    expect((await f.run({ message: 'append' }))[0].status).toBe('fulfilled');
    expect((await readFile(inbox, 'utf8')).startsWith('{"previous":true}\n')).toBe(true);
    if (process.platform !== 'win32') expect((await stat(inbox)).mode & 0o777).toBe(0o600);
    f.worker.stop();
  });

  it('does not persist rejected proposals or invoke their adapter', async () => {
    const inbox = join(await directory(), 'rejected.jsonl');
    const f = await fixture(inbox, true);
    expect((await f.run({ message: 'rejected' })).map((r) => r.status)).toEqual(['rejected', 'rejected']);
    await expect(stat(inbox)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.calls).toEqual([]);
    f.worker.stop();
  });

  it('keeps inbox optional', async () => {
    const f = await fixture();
    expect((await f.run({ message: 'optional' }))[0].status).toBe('fulfilled');
    expect(f.calls).toEqual([{ message: 'optional' }]);
    f.worker.stop();
  });

  it('fails closed on inbox write failure before executing a task', async () => {
    const f = await fixture(join(await directory(), 'missing', 'inbox.jsonl'));
    expect((await f.run({ message: 'must not execute' })).map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(f.calls).toEqual([]);
    f.worker.stop();
  });

  it.skipIf(process.platform === 'win32')('refuses symlink inboxes without altering their targets', async () => {
    const dir = await directory(), target = join(dir, 'target'), inbox = join(dir, 'inbox');
    await writeFile(target, 'unchanged');
    await symlink(target, inbox);
    const f = await fixture(inbox);
    expect((await f.run({ message: 'must not append' }))[0].status).toBe('rejected');
    expect(await readFile(target, 'utf8')).toBe('unchanged');
    expect(f.calls).toEqual([]);
    f.worker.stop();
  });

  it('wires CLI worker start --inbox to the runtime over encrypted HTTP relay', async () => {
    const dir = await directory(), inbox = join(dir, 'cli.jsonl');
    const hook = join(dir, 'hook.cjs'), received = join(dir, 'received.json'), release = join(dir, 'release'), finished = join(dir, 'finished');
    await writeFile(hook, `const fs = require('fs'); let data = ''; process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => data += chunk);
      process.stdin.on('end', () => { fs.writeFileSync(process.argv[2], data);
        const timer = setInterval(() => { if (fs.existsSync(process.argv[3])) {
          clearInterval(timer); fs.writeFileSync(process.argv[4], 'done');
        } }, 20); setTimeout(() => process.exit(), 10000).unref(); });`);
    const owner = generateKeyPair(), requester = generateKeyPair();
    const key = join(dir, 'worker.private.json');
    await writeFile(key, JSON.stringify(owner), { mode: 0o600 });
    const relay = await startLocalRelay();
    // Inbox delivery is exercised after admission through an explicit allowed contact.
    const contacts = join(dir, 'contacts.json');
    const card = createSignedAgentCard({ name: 'Requester', agentDid: requester.did,
      relayEndpoint: relay.url, skills: [] }, requester);
    addContact(contacts, owner, createInviteToken({ agentCard: card }, requester), undefined, true);
    updateContacts(contacts, owner, items => { items[0].allow = true; });
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => { lines.push(String(line)); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pending = networkCommand('worker', ['start', '--key', key, '--relay', relay.url,
      '--allow-private-relay', '--contacts', contacts, '--yes', '--once', '--inbox', inbox,
      '--on-receive', [process.execPath, hook, received, release, finished].map((p) => '"' + p + '"').join(' ')]);
    // Attach a rejection handler immediately, including on test failure.
    const done = pending.catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(lines.some((line) => line.startsWith('acp-invite:'))).toBe(true));
      const client = new RequesterClient({ owner: requester, relay: relay.url, allowPrivateRelay: true,
        approvalProvider: new PolicyAutoApprovalProvider(requester), timeoutMs: 5000 });
      const result = await client.delegate({ to: lines.find((line) => line.startsWith('acp-invite:'))!,
        title: 'CLI inbox', description: 'CLI regression', input: { message: 'from CLI' } });
      expect(result.state).toBe('SETTLED');
      await vi.waitFor(async () => expect(await readFile(received, 'utf8')).toBe(await readFile(inbox, 'utf8')), { timeout: 5000 });
      await expect(stat(finished)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await done).toBeUndefined();
      expect(JSON.parse((await readFile(inbox, 'utf8')).trim())).toMatchObject({ taskId: result.taskId,
        title: 'CLI inbox', description: 'CLI regression', input: { message: 'from CLI' } });
    } finally {
      await writeFile(release, 'release');
      await relay.close();
      await done;
    }
    await vi.waitFor(async () => expect(await readFile(finished, 'utf8')).toBe('done'), { timeout: 5000 });
  });
});
