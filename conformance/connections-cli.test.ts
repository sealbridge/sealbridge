// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInviteToken, createSignedAgentCard, generateKeyPair } from '../packages/core/src/index.js';
import { resolveStoredIdentity, WorkerTrustStore, workerIntakePath, InviteStore } from '../packages/runtime/src/index.js';
import { connectionsCommand } from '../cli/src/connections.js';
import { requestsCommand } from '../cli/src/requests.js';
import { formatCliError } from '../cli/src/error-messages.js';
import { networkCommand } from '../cli/src/network.js';
import { publicSettingsFlags } from '../cli/src/public-settings.js';
import { admissionFixture, completeInspection } from './connections-fixture.js';
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), 'connections-cli-')); roots.push(root);
  return { root, identityOptions: { env: { SEALBRIDGE_DATA_DIR: root } }, output: vi.fn() }; }
async function cliError(command: Promise<void>): Promise<string> {
  try { await command; }
  catch (error) { return formatCliError(error); }
  throw new Error('Expected CLI command rejection');
}
function expectInspectionGuidance(text: string) {
  expect(text).toContain('embedding app configured with a task inspection provider');
  expect(text).toContain('standalone CLI cannot inspect tasks');
  expect(text).toContain('単体 CLI はタスクを検査でき');
}
function expectConfirmationGuidance(text: string) {
  expect(text).toContain('interactive TTY');
  expect(text).toContain('--auto-accept does not provide inspection or connection consent');
  expect(text).toContain('対話式 TTY');
  expect(text).toContain('--auto-accept は検査や接続同意を代替しません');
}
function expectOfferGuidance(text: string) {
  expect(text).toContain('plain task creates only a pending task-derived item, not a reviewable connection offer');
  expect(text).toContain('connections review list with the same role/key');
  expect(text).toContain('use a listed ID');
  expect(text).toContain('invitation/connect flow (connections confirm-invite)');
  expect(text).toContain('タスク由来の保留項目だけ');
  expect(text).toContain('招待・接続フロー');
}

it.each(['show', 'approve'])('CLI requests %s explains unavailable task inspection before human confirmation', async action => {
  const f = admissionFixture();
  try {
    await expect(f.raw()).rejects.toThrow('PENDING_OWNER_APPROVAL');
    const key = join(f.root, 'worker.private.json');
    writeFileSync(key, JSON.stringify(f.owner), { mode: 0o600 });
    const output = vi.fn(), review = vi.fn(async () => true);
    const rendered = await cliError(requestsCommand([action, f.store.list()[0].id, '--key', key], {
      identityOptions: f.identityOptions, output, review,
    }));
    expect(rendered).toContain('INSPECTION_INCOMPLETE: unavailable');
    expectInspectionGuidance(rendered);
    expectConfirmationGuidance(rendered);
    expect(rendered).toContain('requests list');
    expect(rendered).toContain('connections review list');
    expect(rendered).toContain('connection review does not inspect or open tasks');
    expect(rendered).not.toContain('held content');
    expect(output).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
    expect(f.review.list()[0].inspectionStatus).toBe('unavailable');
    expect(f.execute).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});

it('CLI connection review explains task-derived pending items and how to obtain a signed offer', async () => {
  const f = admissionFixture();
  try {
    await expect(f.raw()).rejects.toThrow('PENDING_OWNER_APPROVAL');
    const key = join(f.root, 'worker.private.json');
    writeFileSync(key, JSON.stringify(f.owner), { mode: 0o600 });
    expect(f.store.listConnections()).toHaveLength(1);
    const output = vi.fn(), review = vi.fn(async () => true), transportFactory = vi.fn(() => f.relay);
    const options = { identityOptions: f.identityOptions, output, review, transportFactory };
    await connectionsCommand(['review', 'list', '--key', key], options);
    expect(JSON.parse(output.mock.calls[0][0]).requests).toEqual([]);
    output.mockClear();
    // Neither the intake ID nor the task ID identifies a signed connection offer.
    for (const id of [f.store.list()[0].id, f.store.list()[0].taskId]) {
      const rendered = await cliError(connectionsCommand(['review', 'approve', id, '--key', key], options));
      expect(rendered).toContain('CONNECTION_NOT_PENDING');
      expectOfferGuidance(rendered);
      expectConfirmationGuidance(rendered);
      expect(rendered).toContain('Connection review does not inspect or open tasks');
      expect(rendered).not.toContain('中継器に接続できません');
    }
    expect(output).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
    expect(transportFactory).not.toHaveBeenCalled();
    expect(f.store.connectionState(f.requester.did)).toBe('pending');
    expect(f.review.list()[0].inspectionStatus).toBe('unavailable');
    expect(f.execute).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});

it.each(['requests', 'requests show', 'requests approve',
  'connections', 'connections review', 'connections review approve'])
  ('CLI %s help documents inspection, connection review and human confirmation prerequisites', async commandLine => {
    const command = commandLine.split(' '), f = fixture(), handler = command[0] === 'requests' ? requestsCommand : connectionsCommand;
    await handler([...command.slice(1), '--help'], f);
    const rendered = f.output.mock.calls[0][0];
    expectInspectionGuidance(rendered);
    expectConfirmationGuidance(rendered);
    expect(rendered).toContain('connections review list');
    expect(rendered).toContain('invitation/connect flow (connections confirm-invite)');
    if (command[0] === 'requests') {
      expect(rendered).toContain('INSPECTION_INCOMPLETE');
      expect(rendered).toContain('requests list');
    } else {
      expect(rendered).toContain('CONNECTION_NOT_PENDING');
      expectOfferGuidance(rendered);
    }
    expect(existsSync(join(f.root, 'identities'))).toBe(false);
  });

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
