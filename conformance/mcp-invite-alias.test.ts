import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInviteToken, createRevocationNotice, createSignedAgentCard, digest, generateKeyPair, RevocationRegistry, parseAndVerifyInviteToken, signApproval } from '../packages/core/src/index.js';
import type { KeyPair } from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { AcpMcpServer, InviteStore, WorkerNode, resolveOrCreateIdentity } from '../packages/runtime/src/index.js';
import type { AcpMcpServerOptions, ApprovalProvider } from '../packages/runtime/src/index.js';
import { acceptCommand } from '../cli/src/accept.js';
import { Ajv2020 } from 'ajv/dist/2020.js';

let home: string;
let identityOptions: { home: string; env: { SEALBRIDGE_DATA_DIR: string } };
const NOW = Date.parse('2026-11-01T00:00:00.000Z');
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  home = mkdtempSync(join(realpathSync(tmpdir()), 'sealbridge-alias-'));
  identityOptions = { home, env: { SEALBRIDGE_DATA_DIR: join(home, 'data') } };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });
async function call(server: AcpMcpServer, name: string, args: Record<string, unknown> = {}) {
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) as {
    result: { isError: boolean; content: { text: string }[]; structuredContent?: unknown };
    error?: { code: number };
  };
  if (response.error) return { error: response.error.code, value: {} as any };
  return { error: response.result.isError, value: JSON.parse(response.result.content[0].text) };
}
function approving(owner: () => KeyPair): ApprovalProvider {
  return { approve: vi.fn(async r => signApproval(r.taskId, r.gate, r.target, owner(), 'APPROVED')) };
}
function invitation(ttl = 60) {
  const owner = generateKeyPair();
  const card = createSignedAgentCard({ name: 'Reviewer', agentDid: owner.did, relayEndpoint: 'https://relay.example', skills: [] }, owner);
  return { owner, token: createInviteToken({ agentCard: card, expiresInSeconds: ttl }, owner) };
}
it('sees CLI imports in a live MCP process and settles reference-only calls with explicit decisions and valid audit', async () => {
  const relay = new InMemoryRelay(), workerOwner = generateKeyPair();
  const approval = approving(() => resolveOrCreateIdentity('requester', identityOptions));
  const server = new AcpMcpServer({ identityOptions, relay, approvalProvider: approval });
  expect(await call(server, 'acp_list_invites')).toEqual({ error: false, value: { count: 0, invites: [] } });
  expect(existsSync(join(home, 'data'))).toBe(false);
  const workerApproval = approving(() => workerOwner);
  const execute = vi.fn(async (ctx: { input: unknown }) => ctx.input as { echo: string });
  const worker = new WorkerNode({ owner: workerOwner, relay, relayUrl: 'https://relay.example',
    adapter: { id: 'echo', name: 'Echo', skills: [], executeTask: execute }, approvalProvider: workerApproval });
  const token = worker.invite();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await acceptCommand('accept', ['https://sealbridge.app/i#' + token, '--alias', 'reviewer'], identityOptions);
  const imported = JSON.parse(log.mock.calls.at(-1)![0]);
  const listed = await call(server, 'acp_list_invites');
  expect(listed.value.invites).toEqual([imported]);
  expect(approval.approve).not.toHaveBeenCalled(); expect(workerApproval.approve).not.toHaveBeenCalled();
  const pending = worker.start();
  try {
    for (const workerRef of [imported.workerRef, 'reviewer']) {
      const args = { workerRef, title: 'Echo', description: 'Return JSON', input: { echo: 'hello' }, taskTimeoutMs: 5000 };
      expect(JSON.stringify(args)).not.toContain(token);
      const result = await call(server, 'acp_delegate_task', args);
      expect(result).toMatchObject({ error: false, value: { status: 'SETTLED', deliverable: { echo: 'hello' }, auditBundle: { valid: true } } });
      expect(JSON.stringify(result)).not.toContain(token);
    }
    expect(execute).toHaveBeenCalledTimes(2);
    expect(workerApproval.approve).toHaveBeenCalled();
    expect(JSON.stringify((approval.approve as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(token);
    const restart = new AcpMcpServer({ identityOptions, relay, approvalProvider: approval });
    expect((await call(restart, 'acp_list_invites')).value).toEqual(listed.value);
    const definitions = await restart.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as any;
    const ajv = new Ajv2020({ strict: false });
    expect(ajv.compile(definitions.result.tools.find((t: any) => t.name === 'acp_list_invites').outputSchema)(listed.value)).toBe(true);
    expect(await call(restart, 'acp_remove_invite', { workerRef: 'reviewer' })).toEqual({ error: false, value: { removed: true } });
    expect(await call(server, 'acp_remove_invite', { workerRef: imported.workerRef })).toEqual({ error: false, value: { removed: false } });
    expect((await call(server, 'acp_delegate_task', { workerRef: imported.workerRef, title: 'Echo' })).value.error).toBe('INVITE_NOT_FOUND');
    await acceptCommand('accept', [token, '--alias', 'reviewer'], identityOptions);
    expect((await call(server, 'acp_list_invites')).value.invites[0].workerRef).toBe(imported.workerRef);
  } finally { worker.stop(); await pending; }
});
it('enforces explicit worker/relay policies and conflicting selectors before transport construction', async () => {
  const { token, owner } = invitation(), local = resolveOrCreateIdentity('requester', identityOptions);
  const saved = new InviteStore(local, identityOptions).import(token, 'reviewer');
  const factory = vi.fn();
  const args = { workerRef: saved.workerRef, title: 'Echo', description: 'Return JSON', input: {} };
  const policies: [Partial<AcpMcpServerOptions>, string][] = [
    [{ allowedWorkerDids: [] }, 'MCP_WORKER_NOT_ALLOWED'],
    [{ allowedRelayUrls: [] }, 'MCP_RELAY_NOT_ALLOWED'],
    [{ relay: 'https://other.example' }, 'MCP_RELAY_NOT_ALLOWED'],
  ];
  for (const [policy, error] of policies) {
    const server = new AcpMcpServer({ identityOptions, transportFactory: factory, ...policy });
    expect((await call(server, 'acp_delegate_task', args)).value.error).toBe(error);
  }
  const server = new AcpMcpServer({ identityOptions, transportFactory: factory });
  for (const selector of [{ workerDid: owner.did }, { inviteToken: token }])
    expect((await call(server, 'acp_delegate_task', { ...args, ...selector })).value.error).toBe('CONFLICTING_WORKER_TARGET');
  expect((await call(server, 'acp_delegate_task', { inviteToken: token, workerDid: local.did, title: 'Echo' })).value.error).toBe('CONFLICTING_WORKER_TARGET');
  expect(factory).not.toHaveBeenCalled();
  // A permitted alias retains its invite relay instead of the public fallback.
  const stop = vi.fn(async () => { throw new Error('TEST_SEND_STOP'); });
  const accepted = new AcpMcpServer({ identityOptions, allowedWorkerDids: [owner.did], allowedRelayUrls: ['https://relay.example'],
    transportFactory: url => { expect(url).toBe('https://relay.example'); return { send: stop } as any; },
    approvalProvider: approving(() => local) });
  expect((await call(accepted, 'acp_delegate_task', args)).value.error).toBe('TEST_SEND_STOP');
});
it('keeps expired/revoked aliases as invite targets and never falls back to DID delegation', async () => {
  const { token, owner } = invitation(1), local = resolveOrCreateIdentity('requester', identityOptions);
  const saved = new InviteStore(local, identityOptions).import(token, 'reviewer');
  const factory = vi.fn(), server = new AcpMcpServer({ identityOptions, transportFactory: factory });
  const args = { workerRef: saved.workerRef, title: 'Echo', description: 'Return JSON' };
  server.revocation.revoke(createRevocationNotice({ targetType: 'invite', targetId: digest(parseAndVerifyInviteToken(token)), reason: 'Replaced' }, owner));
  expect((await call(server, 'acp_delegate_task', args)).value.error).toBe('TOKEN_REVOKED');
  vi.setSystemTime(NOW + 1000);
  expect((await call(server, 'acp_list_invites')).value.invites[0].status).toBe('expired');
  expect((await call(server, 'acp_delegate_task', args)).value.error).toBe('INVITE_EXPIRED');
  expect(factory).not.toHaveBeenCalled();
});
it('rechecks invitation expiry after outbound approval without sending a proposal', async () => {
  const { token } = invitation(1), local = resolveOrCreateIdentity('requester', identityOptions);
  const saved = new InviteStore(local, identityOptions).import(token, 'reviewer');
  const relay = new InMemoryRelay(), send = vi.spyOn(relay, 'send');
  const approvalProvider: ApprovalProvider = { approve: async r => {
    vi.setSystemTime(NOW + 1000);
    return signApproval(r.taskId, r.gate, r.target, local, 'APPROVED');
  } };
  const server = new AcpMcpServer({ identityOptions, relay, approvalProvider });
  const result = await call(server, 'acp_delegate_task', { workerRef: saved.workerRef, title: 'Echo', description: 'Return JSON' });
  expect(result.value.error).toBe('INVITE_EXPIRED');
  expect(JSON.stringify(result)).not.toContain(token); expect(send).not.toHaveBeenCalled();
});
it('retains worker-side invite admission and revocation checks after local import', async () => {
  const relay = new InMemoryRelay(), owner = generateKeyPair(), revocation = new RevocationRegistry();
  const local = resolveOrCreateIdentity('requester', identityOptions);
  const execute = vi.fn(async () => ({}));
  const worker = new WorkerNode({ owner, relay, revocation, relayUrl: 'https://relay.example',
    adapter: { id: 'echo', name: 'Echo', skills: [], executeTask: execute }, approvalProvider: approving(() => owner) });
  const token = worker.invite(), saved = new InviteStore(local, identityOptions).import(token, 'reviewer');
  revocation.revoke(createRevocationNotice({ targetType: 'invite', targetId: digest(parseAndVerifyInviteToken(token)), reason: 'Replaced' }, owner));
  const server = new AcpMcpServer({ identityOptions, relay, approvalProvider: approving(() => local) });
  const pending = worker.start();
  try {
    expect((await call(server, 'acp_delegate_task', { workerRef: saved.workerRef, title: 'Echo', description: 'Return JSON', taskTimeoutMs: 5000 })).value.error).toContain('TOKEN_REVOKED');
    expect((await call(server, 'acp_delegate_task', { workerDid: owner.did, title: 'Echo', description: 'Return JSON', taskTimeoutMs: 5000 })).value.error).toContain('INVITE_REQUIRED');
    expect(execute).not.toHaveBeenCalled();
  } finally { worker.stop(); await pending; }
});
