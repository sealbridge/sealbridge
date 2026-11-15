// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createInviteToken, createSignedAgentCard, generateKeyPair, parseAndVerifyInviteToken } from '../packages/core/src/index.js';
import { AcpMcpServer, connectionTarget, InviteStore, PolicyAutoApprovalProvider, resolveStoredIdentity, WorkerNode, WorkerTrustStore, workerIntakePath } from '../packages/runtime/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { formatCliError } from '../cli/src/error-messages.js';
import { networkCommand } from '../cli/src/network.js';
import { protocolTestNow } from './protocol-test-clock.js';
let root: string;
let options: { env: { SEALBRIDGE_DATA_DIR: string; SEALBRIDGE_KEY_STORE: string } };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(protocolTestNow('2026-11-14T00:00:00Z'));
  root = mkdtempSync(join(tmpdir(), 'mcp-connection-target-'));
  options = { env: { SEALBRIDGE_DATA_DIR: root, SEALBRIDGE_KEY_STORE: 'file' } };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
async function call(server: AcpMcpServer, name: string, args: object = {}) {
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) as any;
  return response.error ? { rpcError: response.error } : { isError: response.result.isError,
    ...JSON.parse(response.result.content[0].text) };
}
async function connect(role: 'requester' | 'worker', name: string) {
  const key = await resolveStoredIdentity(role, options), peer = generateKeyPair();
  const card = createSignedAgentCard({ name, agentDid: peer.did, relayEndpoint: 'https://relay.example', skills: [], protocolVersions: ['0.2.0'] }, peer);
  const token = createInviteToken({ agentCard: card, expiresInSeconds: 60 }, peer);
  const ownCard = createSignedAgentCard({ name: 'Local', agentDid: key.did, relayEndpoint: 'https://relay.example', skills: [] }, key);
  const store = new WorkerTrustStore(key, { path: workerIntakePath(key.did, options) });
  store.redeemTaskInvite(parseAndVerifyInviteToken(createInviteToken({ agentCard: ownCard }, key)),
    { peerOwnerDid: peer.did, peerAgentDid: peer.did, peerDisplayName: name, relayUrl: 'https://relay.example' }, 'test-' + peer.did);
  return { key, peer, store, token };
}
it('lists names, authoritative DIDs, creator, local allow kinds and warnings without rewriting stores or exposing keys', async () => {
  const f = await connect('requester', 'Review Bot'), server = new AcpMcpServer({ identityOptions: options });
  const path = workerIntakePath(f.key.did, options), bytes = readFileSync(path);
  const row = (await call(server, 'acp_list_connections')).connections[0];
  expect(row).toMatchObject({ alias: 'review-bot', localOwnerDid: f.key.did, peerOwnerDid: f.peer.did,
    peerDisplayName: 'Review Bot', state: 'connected', inviteCreator: 'local', acceptance: 'folder-policy',
    allowsWork: true, allowedWork: 'read-only', acceptanceWarning: { code: 'PEER_APPROVAL_MAY_BE_REQUIRED' } });
  expect(readFileSync(path)).toEqual(bytes);
  expect(JSON.stringify(row)).not.toContain('privateKey'); expect(JSON.stringify(row)).not.toContain('acp-invite:');
  for (const kind of ['off', 'read-only', 'write'] as const) {
    f.store.setConnectionAcceptance(f.peer.did, kind);
    expect((await call(server, 'acp_list_connections')).connections[0]).toMatchObject({ acceptance: kind, allowsWork: kind !== 'off', allowedWork: kind });
  }
  const definitions = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as any;
  const schema = definitions.result.tools.find((t: any) => t.name === 'acp_list_connections').outputSchema;
  const { isError, ...value } = await call(server, 'acp_list_connections');
  expect(new Ajv2020({ strict: false }).compile(schema)(value)).toBe(true);
});
it('shares CLI resolution: unknown/ambiguous names, different-DID conflict, same-DID expiry fallback and explicit old refs', async () => {
  const f = await connect('requester', 'Reviewer'), factory = vi.fn();
  const server = new AcpMcpServer({ identityOptions: options, transportFactory: factory });
  const missing = await call(server, 'acp_delegate_task', { to: 'missing', title: 'T' });
  expect(missing).toMatchObject({ isError: true, error: 'CONNECTION_NOT_FOUND' });
  expect(missing.nextStep).toContain('Connection name was not found');
  expect(missing.nextStep).toContain('acp_list_connections');
  expect(missing.nextStep).toContain('\u6307\u5b9a\u3057\u305f\u63a5\u7d9a\u540d\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093');
  const cli = formatCliError(new Error('CONNECTION_NOT_FOUND'));
  expect(cli).toContain('Connection name was not found'); expect(cli).toContain('connections list');
  expect(cli).not.toContain('\u4e2d\u7d99\u5668\u306b\u63a5\u7d9a\u3067\u304d\u307e\u305b\u3093');
  await expect(networkCommand('delegate', ['--to', 'missing', '--title', 'T', '--description', 'T', '--input', '{}', '--auto-approve'], { identityOptions: options })).rejects.toThrow('CONNECTION_NOT_FOUND');
  const other = await connect('worker', 'Reviewer');
  expect((await call(server, 'acp_delegate_task', { to: 'reviewer', title: 'T' })).error).toBe('CONNECTION_ALIAS_AMBIGUOUS');
  const invites = await InviteStore.open(f.key, options);
  const saved = invites.import(other.token, 'reviewer');
  expect((await call(server, 'acp_delegate_task', { to: 'reviewer', title: 'T' })).error).toBe('CONNECTION_TARGET_CONFLICT');
  invites.remove(saved.workerRef);
  other.store.disconnect(other.peer.did);
  const own = invites.import(f.token, 'reviewer');
  expect(await connectionTarget('reviewer', options)).toBeUndefined();
  vi.setSystemTime(Date.now() + 60001);
  expect((await connectionTarget('reviewer', options))?.connection.peerOwnerDid).toBe(f.peer.did);
  for (const selector of [{ workerRef: own.workerRef }, { peerRef: 'reviewer' }])
    expect((await call(server, 'acp_delegate_task', { ...selector, title: 'T' })).error).toBe('INVITE_EXPIRED');
  expect(factory).not.toHaveBeenCalled();
});
it.each(['requester', 'worker'] as const)('settles name and DID sends using the %s connection signer; warning is soft, idempotency uses that signer', async role => {
  const f = await connect(role, 'Reviewer'), relay = new InMemoryRelay();
  // Expired same-DID saved aliases must actually send over the live connection.
  (await InviteStore.open(f.key, options)).import(f.token, 'reviewer');
  vi.setSystemTime(Date.now() + 60001);
  const execute = vi.fn(async (ctx: any) => ctx.input);
  const worker = new WorkerNode({ owner: f.peer, relay, relayUrl: 'https://relay.example',
    identityOptions: { env: { SEALBRIDGE_DATA_DIR: join(root, 'remote') } }, checkPeer: () => 'trusted',
    autoAccept: { version: 1, enabled: true, from: 'anyone', work: 'write', limits: {} },
    approvalProvider: new PolicyAutoApprovalProvider(f.peer), adapter: { id: 'echo', name: 'Echo', skills: [], executeTask: execute } });
  const server = new AcpMcpServer({ identityOptions: options, relay, allowAnyRelay: true });
  const running = worker.start(), send = vi.spyOn(relay, 'send');
  try {
    for (const selector of [{ to: 'reviewer' }, { workerDid: f.peer.did }]) {
      const value = await call(server, 'acp_delegate_task', { ...selector, title: 'Echo', input: { ok: true }, taskTimeoutMs: 5000 });
      expect(value, JSON.stringify(value)).toMatchObject({ isError: false, status: 'SETTLED', deliverable: { ok: true }, auditBundle: { valid: true } });
      if ('to' in selector) {
        expect(value.acceptanceWarning.code).toBe('PEER_APPROVAL_MAY_BE_REQUIRED');
        expect(send.mock.calls.find(([e]) => e.payload.eventType === 'PROPOSE')![0].payload.senderDid).toBe(f.key.did);
      }
    }
    const args = { to: 'reviewer', title: 'Echo', idempotencyKey: 'named', taskTimeoutMs: 5000 };
    expect(await call(server, 'acp_delegate_task', args)).toEqual(await call(server, 'acp_delegate_task', args));
    expect(execute).toHaveBeenCalledTimes(3);
  } finally { server.stopDelivery(); worker.stop(); await running; }
});

it('applies existing allowlists and selector validation to names before sending', async () => {
  const f = await connect('requester', 'Reviewer'), factory = vi.fn();
  for (const [policy, error] of [
    [{ allowedWorkerDids: [] }, 'MCP_WORKER_NOT_ALLOWED'],
    [{ allowedRelayUrls: [] }, 'MCP_RELAY_NOT_ALLOWED'],
  ] as Array<[import('../packages/runtime/src/index.js').AcpMcpServerOptions, string]>) {
    const server = new AcpMcpServer({ identityOptions: options, transportFactory: factory, ...policy });
    expect((await call(server, 'acp_delegate_task', { to: 'reviewer', title: 'T' })).error).toBe(error);
  }
  const server = new AcpMcpServer({ identityOptions: options, transportFactory: factory });
  for (const selector of [{ workerRef: 'x' }, { peerRef: 'x' }, { workerDid: f.peer.did }, { inviteToken: f.token }])
    expect((await call(server, 'acp_delegate_task', { to: 'reviewer', ...selector, title: 'T' })).rpcError.code).toBe(-32602);
  const explicit = new AcpMcpServer({ owner: generateKeyPair(), identityOptions: options, transportFactory: factory });
  expect((await call(explicit, 'acp_list_connections')).count).toBe(0);
  expect((await call(explicit, 'acp_delegate_task', { to: 'reviewer', title: 'T' })).error).toBe('CONNECTION_NOT_FOUND');
  expect(factory).not.toHaveBeenCalled();
});
it('returns the advisory on terminal owner holds after a real send without retrying', async () => {
  const f = await connect('requester', 'Reviewer'), relay = new InMemoryRelay();
  const execute = vi.fn(async () => ({}));
  const worker = new WorkerNode({ owner: f.peer, relay, relayUrl: 'https://relay.example',
    identityOptions: { env: { SEALBRIDGE_DATA_DIR: join(root, 'remote') } },
    approvalProvider: new PolicyAutoApprovalProvider(f.peer),
    adapter: { id: 'echo', name: 'Echo', skills: [], executeTask: execute } });
  const server = new AcpMcpServer({ identityOptions: options, relay, allowAnyRelay: true });
  const running = worker.start(), send = vi.spyOn(relay, 'send');
  try {
    const value = await call(server, 'acp_delegate_task', { to: 'reviewer', title: 'Held', taskTimeoutMs: 5000 });
    expect(value).toMatchObject({ isError: true, error: 'PENDING_OWNER_APPROVAL', retryable: false,
      acceptanceWarning: { code: 'PEER_APPROVAL_MAY_BE_REQUIRED' } });
    expect(send.mock.calls.filter(([e]) => e.payload.eventType === 'PROPOSE')).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
  } finally { server.stopDelivery(); worker.stop(); await running; }
});
