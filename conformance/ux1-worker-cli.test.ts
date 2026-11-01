// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { realpathSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, createSignedAgentCard, createInviteToken } from '../packages/core/src/index.js';
import type { WorkerNodeOptions } from '../packages/runtime/src/session.js';

const captured = vi.hoisted(() => ({ options: undefined as WorkerNodeOptions | undefined }));
vi.mock('../packages/runtime/dist/index.js', async original => {
  const runtime = await original<typeof import('../packages/runtime/src/index.js')>();
  return { ...runtime, WorkerNode: class extends runtime.WorkerNode {
    constructor(options: WorkerNodeOptions) { super(options); captured.options = options; }
    override async start() { return undefined; }
  } };
});
import { networkCommand } from '../cli/src/network.js';
import { addContact, updateContacts } from '../cli/src/contacts.js';
afterEach(() => vi.restoreAllMocks());

it('loads only explicitly allowed contacts at every worker startup and enforces live revoke', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'acp-ux1-worker-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const owner = generateKeyPair(), peer = generateKeyPair(), saved = generateKeyPair();
    const keyFile = join(dir, 'owner.private.json'), contacts = join(dir, 'contacts.json');
    writeFileSync(keyFile, JSON.stringify(owner), { mode: 0o600 });
    for (const key of [peer, saved]) {
      const card = createSignedAgentCard({ name: 'Friend', agentDid: key.did, relayEndpoint: 'https://relay.example', skills: [] }, key);
      addContact(contacts, owner, createInviteToken({ agentCard: card }, key));
    }
    updateContacts(contacts, owner, items => { items[0].allow = true; });
    const start = () => networkCommand('worker', ['start', '--key', keyFile, '--relay', 'https://relay.example', '--contacts', contacts, '--auto-accept']);
    await start();
    expect(captured.options?.allowedRequesterDids).toEqual([peer.did]);
    await start();
    expect(captured.options?.allowedRequesterDids).toEqual([peer.did]);
    const provider = captured.options!.approvalProvider!;
    updateContacts(contacts, owner, items => { items[0].allow = false; items[0].revoked = true; });
    await expect(provider.approve({ taskId: 'task_ux1', gate: 'contract_acceptance', target: {}, details: {
      manifest: { requester: { ownerDid: peer.did } }, from: peer.did,
    } })).rejects.toThrow('CONTACT_REVOKED');
    await start();
    expect(captured.options?.allowedRequesterDids).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

