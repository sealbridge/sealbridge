// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AcpMcpServer, InviteStore, inspectRuleContent, createRuleBasedContentReviewProvider, buildTaskManifest,
  CONTENT_INSPECTION_RULES, CONTENT_INSPECTION_LIMITS, CONTENT_INSPECTION_RULESET_VERSION, CONTENT_INSPECTION_RULESET_DIGEST, WorkerTrustStore, connectionsCommand, createInviteToken,
  createSignedAgentCard, discoverAgentCards, generateKeyPair, inviteTokenFromUri,
  keyStoreSelection, parseAndVerifyInviteToken, resolveDataRoot, resolveStoredIdentity, workerIntakePath,
} from '../cli/src/sdk.js';
import type { InviteStoreOptions, KeyringModule, RelayTransport, SavedInvite } from '../cli/src/sdk.js';

const NOW = Date.parse('2030-01-01T00:00:00.000Z');
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'sealbridge-sdk-'));
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network call'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });

it('supports invitation references, identity selection and owner-reviewed confirmation through the SDK', async () => {
  const secrets = new Map<string, string>();
  const keyring: KeyringModule = { Entry: class {
    private id: string;
    constructor(service: string, account: string) { this.id = service + '/' + account; }
    getPassword() { return secrets.get(this.id) ?? null; }
    setPassword(value: string) { secrets.set(this.id, value); }
    deletePassword() { return secrets.delete(this.id); }
  } };
  const options: InviteStoreOptions = { home: root, env: { SEALBRIDGE_DATA_DIR: join(root, 'data') },
    keyStore: 'keychain', keyringLoader: async () => keyring, now: () => NOW };
  expect(resolveDataRoot(options)).toBe(join(root, 'data'));
  expect(keyStoreSelection(options)).toMatchObject({ keyStore: 'keychain', source: 'option' });
  const owner = await resolveStoredIdentity('requester', options), peer = generateKeyPair();
  const card = createSignedAgentCard({ name: 'Reviewer', agentDid: peer.did,
    relayEndpoint: 'https://relay.example', skills: [], protocolVersions: ['0.2.0'], now: NOW }, peer);
  const token = createInviteToken({ agentCard: card, issuedAt: new Date(NOW).toISOString() }, peer);
  const link = 'https://sealbridge.app/i#' + token;
  expect(inviteTokenFromUri(link) === token).toBe(true);
  expect(parseAndVerifyInviteToken(link, NOW).ownerDid).toBe(peer.did);
  expect(discoverAgentCards([card], {}, NOW)).toEqual([card]);
  const invites = await InviteStore.open(owner, options);
  const saved: SavedInvite = invites.import(link, 'reviewer');
  expect((await InviteStore.open(owner, options)).list()).toEqual([saved]);
  expect(invites.resolve(saved.workerRef).inviteToken === token).toBe(true);
  expect(readFileSync(invites.path, 'utf8').includes(token)).toBe(false);
  expect([...secrets.values()].includes(token)).toBe(true);

  const store = new WorkerTrustStore(owner, { path: workerIntakePath(owner.did, options), now: () => NOW });
  expect(store.listConnections()).toEqual([]);
  const output = vi.fn(), send = vi.fn(async () => { expect(store.connectionState(peer.did)).toBe('pending'); });
  const relay: RelayTransport = { send, receive: vi.fn() };
  const review = vi.fn(async (summary: string) => {
    expect(JSON.parse(summary)).toMatchObject({ localRole: 'requester', localOwnerDid: owner.did, peerOwnerDid: peer.did });
    return false;
  });
  const commandOptions = { identityOptions: options, review, now: () => NOW, output, transportFactory: () => relay };
  await expect(connectionsCommand(['confirm-invite', saved.workerRef], commandOptions)).rejects.toThrow('APPROVAL_REJECTED');
  expect(send).not.toHaveBeenCalled(); expect(store.listConnections()).toEqual([]);
  review.mockImplementationOnce(async () => true);
  await connectionsCommand(['confirm-invite', saved.workerRef], commandOptions);
  expect(send).toHaveBeenCalledOnce();
  expect(store.listConnections()).toMatchObject([{ peerOwnerDid: peer.did, state: 'pending' }]);
  expect(store.connectionLevel(peer.did)).toBe('unknown');
  expect(JSON.stringify(output.mock.calls).includes(token)).toBe(false);

  const mcp = new AcpMcpServer({ identityOptions: options, now: () => NOW });
  const result = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'acp_list_invites', arguments: {} } });
  expect(JSON.stringify(result).includes(saved.workerRef)).toBe(true);
  expect(JSON.stringify(result).includes(token)).toBe(false);
  expect(invites.remove(saved.workerRef)).toBe(true);
  expect([...secrets.values()].includes(token)).toBe(false);
});

it('exports the opt-in scanner and provider without installing them or making network calls', async () => {
  const owner = generateKeyPair(), peer = generateKeyPair();
  const manifest = buildTaskManifest({ ownerDid: peer.did, workerDid: owner.did, title: 'Review', description: 'Read text' });
  const report = await inspectRuleContent({ manifest, input: 'system prompt' });
  expect(report).toMatchObject({ inspectorVersion: CONTENT_INSPECTION_RULESET_VERSION, rulesetDigest: CONTENT_INSPECTION_RULESET_DIGEST,
    limits: CONTENT_INSPECTION_LIMITS, status: 'ok', verdict: 'warn' });
  expect(CONTENT_INSPECTION_RULES.length).toBeGreaterThan(0);
  expect(typeof createRuleBasedContentReviewProvider().inspect).toBe('function');
  expect(fetch).not.toHaveBeenCalled();
});
