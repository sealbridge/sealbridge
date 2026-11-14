// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { generateKeyPair, parseAndVerifyInviteToken, signPayload, verifySigned, createRelayAuthToken } from '../packages/core/src/index.js';
import { parseJsonl, verifyAudit } from '../packages/ledger/src/index.js';
import { createRelayFetchHandler, HttpRelayClient } from '../packages/relay/src/index.js';
import { AcpMcpServer, RequesterClient, PolicyAutoApprovalProvider, migrateWorkerIdentity,
  delegatedWorkerIdentity, revokeWorkerIdentity, resolveStoredIdentity, inspectStoredIdentity,
  setApplicationAutoAccept, WorkerTrustStore, workerIntakePath } from '../packages/runtime/src/index.js';
import { networkCommand } from '../cli/src/network.js';
import { inviteShareCommand } from '../cli/src/invite-share.js';
import { createInviteCommand, inviteLinksCommand } from '../cli/src/invite-links.js';
import { protocolTestNow } from './protocol-test-clock.js';

let dir: string;
let identityOptions: { home: string; env: { SEALBRIDGE_DATA_DIR: string } };
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(protocolTestNow('2026-11-14T00:00:00Z'));
  dir = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'worker-delegation-'));
  identityOptions = { home: dir, env: { SEALBRIDGE_DATA_DIR: join(dir, 'data') } };
  await resolveStoredIdentity('requester', identityOptions);
  await resolveStoredIdentity('worker', identityOptions);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); });
function snapshot() {
  return fs.readdirSync(dir, { recursive: true }).map(String).sort().map(name => {
    const path = join(dir, name);
    return [relative(dir, path), fs.statSync(path).isFile() ? fs.readFileSync(path).toString('base64') : null];
  });
}
async function mcpInvite() {
  const server = new AcpMcpServer({ identityOptions });
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'acp_create_invite', arguments: { relayUrl: 'https://relay.example' } } }) as any;
  expect(response.result.isError).toBe(false);
  return JSON.parse(response.result.content[0].text).inviteToken as string;
}
async function cliInvite() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await createInviteCommand(['--relay', 'https://relay.example'], { identityOptions });
  const token = String(log.mock.calls[0][0]); log.mockRestore(); return token;
}
it('migration dry run writes nothing, backs up original keys before activation, and is idempotent', async () => {
  const worker = await resolveStoredIdentity('worker', identityOptions);
  const peer = generateKeyPair();
  const store = new WorkerTrustStore(worker, { path: workerIntakePath(worker.did, identityOptions) });
  store.block(peer.did);
  const before = snapshot();
  expect(await migrateWorkerIdentity(identityOptions)).toMatchObject({ status: 'planned', dryRun: true });
  expect(snapshot()).toEqual(before);
  const result = await migrateWorkerIdentity(identityOptions, false);
  expect(result.status).toBe('migrated');
  for (const role of ['requester', 'worker'] as const) {
    const identity = await inspectStoredIdentity(role, identityOptions);
    expect(fs.readFileSync(join(result.backup!, role + '.private.json'))).toEqual(fs.readFileSync(identity.location));
  }
  expect(store.connectionState(peer.did)).toBe('blocked');
  for (const [path, bytes] of before) {
    if (bytes !== null) expect(fs.readFileSync(join(dir, path!)).toString('base64')).toBe(bytes);
  }
  const migrated = snapshot();
  expect(await migrateWorkerIdentity(identityOptions, false)).toMatchObject({ status: 'already-migrated', backup: result.backup });
  expect(await migrateWorkerIdentity(identityOptions, true)).toMatchObject({ status: 'already-migrated' });
  expect(snapshot()).toEqual(migrated);
});
it('a leaked delegate cannot sign as the owner, and explicit revocation is backed up and idempotent', async () => {
  await migrateWorkerIdentity(identityOptions, false);
  const identity = (await delegatedWorkerIdentity(identityOptions))!;
  expect(identity.agentKey.did).not.toBe(identity.owner.did);
  expect(verifySigned(signPayload({ type: 'OwnerImpersonation' }, identity.agentKey), identity.owner.did)).toBe(false);
  const before = snapshot();
  expect(await revokeWorkerIdentity(identityOptions)).toMatchObject({ status: 'would-revoke' });
  expect(snapshot()).toEqual(before);
  const result = await revokeWorkerIdentity(identityOptions, false);
  expect(fs.existsSync(join(result.backup!, 'active.json'))).toBe(true);
  await expect(delegatedWorkerIdentity(identityOptions)).rejects.toThrow('WORKER_DELEGATION_REVOKED');
  const revoked = snapshot();
  expect(await revokeWorkerIdentity(identityOptions, false)).toMatchObject({ status: 'already-revoked' });
  expect(snapshot()).toEqual(revoked);
  expect(() => identity.assertActive()).toThrow('WORKER_DELEGATION_REVOKED');
});
it('a delegate cannot authenticate to the owner relay inbox', async () => {
  await migrateWorkerIdentity(identityOptions, false);
  const identity = (await delegatedWorkerIdentity(identityOptions))!;
  const handler = createRelayFetchHandler();
  const response = await handler(new Request('https://relay.example/envelopes?recipient=' + encodeURIComponent(identity.owner.did), {
    headers: { authorization: 'Bearer ' + createRelayAuthToken(identity.agentKey, { origin: 'https://relay.example', action: 'receive' }) },
  }));
  expect(response.status).toBe(401);
});
it('backup failure leaves original keys and activation unchanged', async () => {
  const before = snapshot();
  const io = { ...fs, writeSync: vi.fn(() => { throw new Error('simulated backup failure'); }) } as unknown as typeof fs;
  await expect(migrateWorkerIdentity({ ...identityOptions, fs: io }, false)).rejects.toThrow('simulated backup failure');
  expect(fs.existsSync(join(identityOptions.env.SEALBRIDGE_DATA_DIR, 'worker-delegation', 'active.json'))).toBe(false);
  for (const [path, bytes] of before) {
    if (bytes !== null) expect(fs.readFileSync(join(dir, path!)).toString('base64')).toBe(bytes);
  }
  await expect(migrateWorkerIdentity(identityOptions, false)).resolves.toMatchObject({ status: 'migrated' });
});
it('corrupt activation or revocation never falls back to an unmigrated worker', async () => {
  await migrateWorkerIdentity(identityOptions, false);
  const root = join(identityOptions.env.SEALBRIDGE_DATA_DIR, 'worker-delegation');
  const active = fs.readFileSync(join(root, 'active.json'));
  fs.writeFileSync(join(root, 'active.json'), 'null', { mode: 0o600 });
  await expect(delegatedWorkerIdentity(identityOptions)).rejects.toThrow('WORKER_DELEGATION_INVALID');
  fs.writeFileSync(join(root, 'active.json'), active);
  fs.writeFileSync(join(root, 'revoked.json'), 'null', { mode: 0o600 });
  await expect(delegatedWorkerIdentity(identityOptions)).rejects.toThrow('WORKER_DELEGATION_INVALID');
});
it('reading a missing delegated key fails closed without creating or replacing keys', async () => {
  await migrateWorkerIdentity(identityOptions, false);
  const path = join(identityOptions.env.SEALBRIDGE_DATA_DIR, 'worker-delegation');
  const binding = JSON.parse(fs.readFileSync(join(path, 'active.json'), 'utf8'));
  fs.unlinkSync(join(path, binding.payload.delegateFile));
  const before = snapshot();
  await expect(delegatedWorkerIdentity(identityOptions)).rejects.toThrow('WORKER_DELEGATION_INVALID');
  expect(snapshot()).toEqual(before);
});

for (const scenario of ['MCP delegated', 'CLI unmigrated', 'CLI migrated', 'old CLI after migration', 'old MCP after migration', 'return invite after migration'] as const) {
  it(`${scenario} invite reaches the running CLI worker and both audits remain VALID`, async () => {
    const owner = await resolveStoredIdentity('requester', identityOptions);
    const legacy = await resolveStoredIdentity('worker', identityOptions);
    const oldToken = scenario === 'old CLI after migration' ? await cliInvite()
      : scenario === 'old MCP after migration' ? await mcpInvite() : undefined;
    if (scenario !== 'CLI unmigrated') await migrateWorkerIdentity(identityOptions, false);
    let reciprocal: string | undefined;
    if (scenario === 'return invite after migration') {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      // The retained legacy worker supplies a distinct issuer for this owner.
      await createInviteCommand(['--relay', 'https://relay.example', '--key',
        (await inspectStoredIdentity('worker', identityOptions)).location], { identityOptions });
      const legacyCardToken = String(log.mock.calls[0][0]);
      fs.writeFileSync(join(dir, 'incoming.txt'), legacyCardToken, { mode: 0o600 });
      await inviteShareCommand('open', ['--file', join(dir, 'incoming.txt'), '--out', join(dir, 'return.txt'),
        '--contacts', join(dir, 'contacts.json')], identityOptions);
      reciprocal = fs.readFileSync(join(dir, 'return.txt'), 'utf8');
      log.mockRestore();
      expect(parseAndVerifyInviteToken(reciprocal).agentDid).toBe(owner.did);
    }
    const token = reciprocal ?? oldToken ?? (scenario.startsWith('MCP') ? await mcpInvite() : await cliInvite());
    const invite = parseAndVerifyInviteToken(token);
    const usesLegacy = scenario === 'CLI unmigrated' || scenario === 'old CLI after migration';
    expect(invite.ownerDid).toBe(usesLegacy ? legacy.did : owner.did);
    if (scenario === 'MCP delegated' || scenario === 'CLI migrated') {
      expect(invite.agentDid).toBe((await delegatedWorkerIdentity(identityOptions))!.agentKey.did);
      expect(invite.agentDid).not.toBe(invite.ownerDid);
    }
    expect(invite).not.toHaveProperty('role');
    setApplicationAutoAccept({ version: 1, enabled: true, from: 'anyone', work: 'write', limits: {} }, identityOptions);
    const handler = createRelayFetchHandler();
    const recipients = new Set<string>();
    const fetcher: typeof fetch = async (input, init) => {
      if (init?.method === 'POST' && new URL(String(input)).pathname === '/envelopes') {
        const envelope = JSON.parse(String(init.body));
        if (envelope.payload.eventType === 'PROPOSE') recipients.add(envelope.payload.recipientDid);
      }
      return handler(new Request(input, init));
    };
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    vi.spyOn(console, 'log').mockImplementation(value => { if (String(value).startsWith('acp-invite:')) ready(); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const running = networkCommand('worker', ['start', '--relay', 'https://relay.example', '--adapter', 'sandbox',
      '--allow-local-pc', '--once', '--auto-accept', '--audit', join(dir, 'worker.jsonl')], { identityOptions, fetch: fetcher });
    void running.catch(ready);
    const sender = generateKeyPair();
    const client = new RequesterClient({ owner: sender,
      relay: new HttpRelayClient('https://relay.example', fetcher, sender),
      identityOptions: { home: dir, env: { SEALBRIDGE_DATA_DIR: join(dir, 'sender') } },
      approvalProvider: new PolicyAutoApprovalProvider(sender), timeoutMs: 5000 });
    try {
      await started;
      const result = await client.delegate({ to: token, title: 'Routing', description: 'Echo JSON', input: { ok: true },
        auditPath: join(dir, 'requester.jsonl') });
      await running;
      expect(result.state).toBe('SETTLED');
      expect(result.deliverable).toEqual({ ok: true });
      expect(recipients).toEqual(new Set([invite.ownerDid]));
      for (const path of [join(dir, 'requester.jsonl'), join(dir, 'worker.jsonl' + (scenario === 'old CLI after migration' ? '.legacy' : ''))])
        expect(verifyAudit(parseJsonl(fs.readFileSync(path, 'utf8'))).valid).toBe(true);
    } finally {
      process.emit('SIGINT');
      await running;
      client.stopDelivery();
    }
  });
}

it('lists and cancels both legacy and owner short links after migration', async () => {
  const handler = createRelayFetchHandler();
  const options = { identityOptions, fetch: ((input, init) => handler(new Request(input, init))) as typeof fetch };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const args = ['--share', 'link', '--relay', 'https://relay.example', '--qr', 'none'];
  await createInviteCommand(args, options);
  await migrateWorkerIdentity(identityOptions, false);
  await createInviteCommand(args, options);
  log.mockClear();
  await inviteLinksCommand(['list'], options);
  const links = JSON.parse(String(log.mock.calls[0][0])).links;
  expect(links).toHaveLength(2);
  for (const link of links) await inviteLinksCommand(['cancel', link.linkRef], options);
  log.mockClear();
  await inviteLinksCommand(['list'], options);
  expect(JSON.parse(String(log.mock.calls[0][0])).links.map((l: any) => l.status.status)).toEqual(['cancelled', 'cancelled']);
});
