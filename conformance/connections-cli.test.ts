// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInviteToken, createSignedAgentCard, generateKeyPair } from '../packages/core/src/index.js';
import { resolveStoredIdentity, WorkerTrustStore, workerIntakePath, InviteStore } from '../packages/runtime/src/index.js';
import { connectionsCommand } from '../cli/src/connections.js';
import { requestsCommand } from '../cli/src/requests.js';
import { networkCommand } from '../cli/src/network.js';
import { publicSettingsFlags } from '../cli/src/public-settings.js';
import { admissionFixture, completeInspection } from './connections-fixture.js';
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), 'connections-cli-')); roots.push(root);
  return { root, identityOptions: { env: { SEALBRIDGE_DATA_DIR: root } }, output: vi.fn() }; }
it('lists connections and held metadata without creating either role identity', async () => {
  const f = fixture(); await connectionsCommand(['list'], f); await requestsCommand(['list'], f);
  expect(existsSync(join(f.root, 'identities'))).toBe(false);
});
it('requires an explicit human channel and refuses unattended decision flags', async () => {
  const f = fixture(), peer = generateKeyPair();
  await expect(connectionsCommand(['block',peer.did,'--yes'], f)).rejects.toThrow('INVALID_CONNECTION_OPTION');
  await expect(connectionsCommand(['request','--to',peer.did,'--relay','https://relay.example'], {
    ...f, review: async () => false, transportFactory: () => ({ send: vi.fn(), receive: vi.fn() }) })).rejects.toThrow('APPROVAL_REJECTED');
});
it('keeps requester and worker decisions scoped to the selected role', async () => {
  const f = fixture(), peer = generateKeyPair();
  const worker = await resolveStoredIdentity('worker',f.identityOptions), requester = await resolveStoredIdentity('requester',f.identityOptions);
  await connectionsCommand(['block',peer.did,'--role','worker'], { ...f, review: async () => true });
  expect(new WorkerTrustStore(worker,{ path: workerIntakePath(worker.did,f.identityOptions) }).connectionState(peer.did)).toBe('blocked');
  expect(new WorkerTrustStore(requester,{ path: workerIntakePath(requester.did,f.identityOptions) }).connectionState(peer.did)).toBe('none');
});
it('import alone does not connect; confirm-invite asks once and persists outgoing consent before transmission', async () => {
  const f = fixture(), peer = generateKeyPair(), local = await resolveStoredIdentity('requester',f.identityOptions);
  const card = createSignedAgentCard({ name: 'Peer', agentDid: peer.did, relayEndpoint: 'https://relay.example', skills: [], protocolVersions: ['0.2.0'] },peer);
  const store = new WorkerTrustStore(local,{ path: workerIntakePath(local.did,f.identityOptions) });
  const invites = await InviteStore.open(local,f.identityOptions); invites.import(createInviteToken({ agentCard: card },peer), 'reviewer');
  expect(store.connectionState(peer.did)).toBe('none');
  const review = vi.fn(async (summary: string) => { expect(summary).toContain(local.did); expect(summary).toContain(peer.did); expect(JSON.parse(summary).localRole).toBe('requester'); return true; });
  const send = vi.fn(async () => { expect(store.connectionState(peer.did)).toBe('pending'); });
  await connectionsCommand(['confirm-invite','reviewer'], { ...f, review, transportFactory: () => ({ send, receive: vi.fn() }) });
  expect(review).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce();
  expect(store.connectionLevel(peer.did)).toBe('unknown'); expect(JSON.stringify(f.output.mock.calls)).not.toContain('acp-invite:');
});
it('rejects retired flags before creating identities and leaves public settings consent explicit', async () => {
  const f = fixture();
  await expect(networkCommand('worker',['start','--open'],f)).rejects.toThrow('ACCESS_MODE_REMOVED');
  expect(existsSync(join(f.root,'identities'))).toBe(false);
  const settings = { public:true, taskTypes:['json'],maxInputTokens:1,maxOutputTokens:1,maxToolCalls:1,maxWallSeconds:1,maxJobsPerPersonPerMinute:1,maxJobsPerDay:1,alwaysAsk:false };
  expect(() => publicSettingsFlags(settings)).toThrow('CONNECTION_OPENING_REQUIRED');
  expect(publicSettingsFlags({ ...settings,alwaysAsk:true })).toContain('--publish');
});
it('default request approval records limited intent without a trusted grant or reciprocal consent', async () => {
  const f = admissionFixture({}, true);
  try {
    await expect(f.raw()).rejects.toThrow('PENDING_OWNER_APPROVAL');
    const key = join(f.root, 'worker.private.json');
    writeFileSync(key, JSON.stringify(f.owner), { mode: 0o600 });
    const send = vi.fn(async () => {});
    await requestsCommand(['approve', f.store.list()[0].id, '--key', key], {
      identityOptions: f.identityOptions, review: async () => true, output: () => {},
      inspectionProvider: completeInspection, transportFactory: () => ({ send, receive: vi.fn() }),
    });
    expect(f.store.list()[0]).toMatchObject({ state: 'approved', trust: 'limited' });
    expect(f.store.connectionState(f.requester.did)).toBe('pending');
    expect(f.store.connectionLevel(f.requester.did)).toBe('unknown');
    expect(f.store.level(f.requester.did)).toBe('unknown');
    expect(f.store.hasExplicitLegacyGrant(f.requester.did)).toBe(false);
    expect(send).toHaveBeenCalledOnce();
    expect(f.execute).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});
