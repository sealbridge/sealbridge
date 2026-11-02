// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, createSignedAgentCard, createInviteToken, signPayload } from '../packages/core/src/index.js';
import { BilateralLedger } from '../packages/ledger/src/index.js';
import { addContact, loadContacts, updateContacts, contactsApproval, contactsCommand } from '../cli/src/contacts.js';
import { createReceipt, receiptHtml } from '../cli/src/receipt.js';
import type { Json } from '../packages/core/src/index.js';

const dirs: string[] = [];
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'acp-ux1-')); dirs.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function contactFixture() {
  const key = generateKeyPair(), peer = generateKeyPair();
  const path = join(directory(), 'contacts.json');
  const card = createSignedAgentCard({ name: 'Friend', agentDid: peer.did, relayEndpoint: 'https://relay.example', skills: [{ id: 'json', name: 'JSON' }] }, peer);
  const token = createInviteToken({ agentCard: card }, peer);
  return { key, peer, path, token };
}
describe('UX-1 contacts', () => {
  it('saves verified identity without granting permission or retaining invitation/private key', () => {
    const { key, peer, path, token } = contactFixture();
    addContact(path, key, token);
    expect(loadContacts(path, key.did)[0]).toMatchObject({ ownerDid: peer.did, allow: false, saved: true });
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(key.privateKey);
    expect(raw).not.toContain(token);
  });
  it.each(['allow', 'ownerDid', 'relay', 'version'])('rejects tampered %s', field => {
    const { key, path, token } = contactFixture();
    addContact(path, key, token);
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    if (field === 'version') doc.payload.version = 2;
    else doc.payload.contacts[0][field] = field === 'allow' ? true : 'spoof';
    writeFileSync(path, JSON.stringify(doc));
    expect(() => loadContacts(path, key.did)).toThrow('CONTACTS_INVALID');
  });
  it('rejects spoofed invitation and a different local owner', () => {
    const { key, path, token } = contactFixture();
    const doc = JSON.parse(Buffer.from(token.slice(11), 'base64url').toString());
    doc.payload.ownerDid = key.did;
    expect(() => addContact(path, key, 'acp-invite:' + Buffer.from(JSON.stringify(doc)).toString('base64url'))).toThrow();
    addContact(path, key, token);
    expect(() => loadContacts(path, generateKeyPair().did)).toThrow('CONTACTS_INVALID');
  });
  it('persists explicit contact permission across restarts and propagates revoke to an existing provider', async () => {
    const { key, peer, path, token } = contactFixture();
    addContact(path, key, token);
    const interactive = { approve: vi.fn() };
    const provider = contactsApproval(path, key, true, {}, interactive);
    const request = { taskId: 'task_ux1', gate: 'contract_acceptance' as const, target: {}, details: { manifest: { requester: { ownerDid: peer.did } }, from: peer.did } };
    await expect(provider.approve(request)).rejects.toThrow('CONTACT_NOT_ALLOWED');
    updateContacts(path, key, contacts => { contacts[0].allow = true; });
    expect(loadContacts(path, key.did)[0].allow).toBe(true);
    expect((await provider.approve(request)).payload.decision).toBe('APPROVED');
    updateContacts(path, key, contacts => { contacts[0].allow = false; contacts[0].revoked = true; });
    await expect(provider.approve(request)).rejects.toThrow('CONTACT_REVOKED');
    addContact(path, key, token);
    await expect(provider.approve(request)).rejects.toThrow('CONTACT_REVOKED');
  });
  it('never auto-approves a spoofed envelope or bypasses budget caps', async () => {
    const { key, peer, path, token } = contactFixture();
    addContact(path, key, token);
    updateContacts(path, key, contacts => { contacts[0].allow = true; });
    const provider = contactsApproval(path, key, true, {}, { approve: vi.fn() });
    await expect(provider.approve({ taskId: 'task_ux1', gate: 'contract_acceptance', target: {}, details: {
      manifest: { requester: { ownerDid: peer.did } }, from: generateKeyPair().did,
    } })).rejects.toThrow();
    const capped = contactsApproval(path, key, true, { maxInputTokens: 1 }, { approve: vi.fn() });
    await expect(capped.approve({ taskId: 'task_ux1', gate: 'contract_acceptance', target: {}, details: {
      manifest: { requester: { ownerDid: peer.did }, budget: { maxInputTokens: 2 } }, from: peer.did,
    } })).rejects.toThrow();
  });
  it('remove hides the contact but preserves a deny record', () => {
    const { key, peer, path, token } = contactFixture();
    addContact(path, key, token);
    const keyFile = join(directory(), 'test.private.json');
    writeFileSync(keyFile, JSON.stringify(key));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    contactsCommand(['remove', peer.did, '--key', keyFile, '--file', path]);
    expect(loadContacts(path, key.did)[0]).toMatchObject({ allow: false, revoked: true, saved: false });
    expect(JSON.parse(output.mock.calls[0][0]).contacts).toEqual([]);
  });
  it('fails closed on unknown version, malformed signed state and concurrent mutation', () => {
    const { key, path, token } = contactFixture();
    addContact(path, key, token);
    writeFileSync(path + '.lock', '');
    expect(() => updateContacts(path, key, () => {})).toThrow();
    const signed = signPayload({ version: 2, ownerDid: key.did, contacts: [] }, key);
    writeFileSync(path, JSON.stringify(signed));
    expect(() => loadContacts(path, key.did)).toThrow();
  });
});

function audit(events = ['PROPOSE', 'ACCEPT', 'START', 'DELIVER', 'VERIFY_ACCEPT', 'SETTLED']) {
  const a = generateKeyPair(), b = generateKeyPair();
  const ledger = new BilateralLedger('task_ux1', [a.did, b.did]);
  for (const event of events) {
    const payload: Json = event === 'PROPOSE' ? { proposal: { payload: { task: { title: 'secret@example.com <script>secret</script>' }, budget: { maxInputTokens: 100 } } }, input: { password: 'secret-value' } } :
      event === 'DELIVER' ? { usage: { payload: { inputTokens: 12, outputTokens: 3, toolCalls: 1, wallTimeMs: 25 } }, artifact: { payload: { data: 'private output' } } } : {};
    ledger.append(event, payload, a, b);
  }
  const bundle = ledger.bundle(a, b);
  const raw = [...bundle.entries.map(entry => JSON.stringify({ entry })), JSON.stringify({ checkpoint: bundle.checkpoint })].join('\n');
  return { bundle, raw, head: bundle.checkpoint.actor.payload.head! };
}
describe('UX-1 receipts', () => {
  it('requires an independent head before showing completion', () => {
    const { raw, head } = audit();
    expect(createReceipt(raw).status).toBe('UNCONFIRMED');
    expect(createReceipt(raw, { expectedFinalState: 'SETTLED' }).status).toBe('UNCONFIRMED');
    const receipt = createReceipt(raw, { head });
    expect(receipt.status).toBe('COMPLETED');
    expect(receipt.usage).toMatchObject({ inputTokens: 12, outputTokens: 3, toolCalls: 1, elapsedMs: 25 });
    expect(receipt.when.timezone).toBe('UTC');
    expect(receipt.paymentNotice).toContain('not proof of payment');
    expect(createReceipt(raw, { head: 'sha256:' + '0'.repeat(64) }).status).toBe('INVALID');
  });
  it('redacts arbitrary inputs, outputs and prose in both formats', () => {
    const receipt = createReceipt(audit().raw);
    const output = JSON.stringify(receipt) + receiptHtml(receipt);
    for (const secret of ['secret@example.com', 'secret-value', 'private output', '<script>']) expect(output).not.toContain(secret);
    expect(receiptHtml({ ...receipt, message: '<script>"&\'</script>' })).toContain('&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;');
  });
  it.each(['tampered', 'truncated', 'unsealed', 'malformed'])('never succeeds for %s logs', kind => {
    const { raw, head } = audit();
    let input = raw;
    if (kind === 'tampered') input = raw.replace('secret-value', 'changed');
    if (kind === 'truncated') input = raw.split('\n').filter((_, i) => i !== 4).join('\n');
    if (kind === 'unsealed') input = raw.split('\n').slice(0, -1).join('\n');
    if (kind === 'malformed') input = '{not json';
    const receipt = createReceipt(input, { head });
    expect(receipt.status).toBe('INVALID');
    expect(receipt.who).toEqual([]);
    expect(receipt.taskId).toBeNull();
  });
  it('rejects a correctly signed incomplete prefix and an isolated SETTLED event', () => {
    for (const events of [['PROPOSE', 'ACCEPT'], ['SETTLED']]) {
      const { raw, head } = audit(events);
      expect(createReceipt(raw, { head }).status).toBe('INCOMPLETE');
    }
  });
  it('CLI produces static HTML and JSON, refuses overwrite, and returns failure for malformed logs', () => {
    const dir = directory(), path = join(dir, 'audit.jsonl');
    writeFileSync(path, audit().raw);
    const run = () => spawnSync(process.execPath, ['cli/dist/index.js', 'receipt', path], { encoding: 'utf8' });
    expect(run().status).toBe(0);
    expect(JSON.parse(readFileSync(path + '.receipt.json', 'utf8')).status).toBe('UNCONFIRMED');
    expect(readFileSync(path + '.receipt.html', 'utf8')).toContain('Content-Security-Policy');
    expect(run().status).toBe(1);
    const bad = join(dir, 'bad.jsonl'); writeFileSync(bad, 'broken');
    expect(spawnSync(process.execPath, ['cli/dist/index.js', 'receipt', bad]).status).toBe(1);
  });
});
