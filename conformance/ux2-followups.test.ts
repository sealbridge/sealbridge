// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInviteToken, createSignedAgentCard, generateKeyPair, signPayload } from '../packages/core/src/index.js';
import { friendlyExpiry, inviteShareCommand, openInvite, reissueInvite, setupInvite } from '../cli/src/invite-share.js';
import { loadContacts } from '../cli/src/contacts.js';
import { boardCommand, createPost } from '../cli/src/board.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { WorkerNode, RequesterClient, PolicyAutoApprovalProvider } from '../packages/runtime/src/index.js';
const dirs: string[] = [];
function paths() {
  const dir = mkdtempSync(join(tmpdir(), 'acp-followups-')); dirs.push(dir);
  return { dir, key: join(dir, 'identity.json'), contacts: join(dir, 'contacts.json'), out: join(dir, 'reply.txt') };
}
function fixture(split = false) {
  const owner = generateKeyPair(), agent = split ? generateKeyPair() : owner;
  const card = createSignedAgentCard({ name: 'Friend', agentDid: agent.did, relayEndpoint: 'https://relay.example.com',
    skills: [], expiresAt: new Date(Date.now() + 3600000).toISOString() }, owner, agent);
  return { owner, agent, token: createInviteToken({ agentCard: card }, owner) };
}
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
describe('UX-2 follow-ups', () => {
  it('documents per-minute host limits rather than a nonexistent signed hourly field (#77)', () => {
    for (const file of ['UX_LAYER.md', 'UX_LAYER.ja.md']) {
      const doc = readFileSync(file, 'utf8');
      expect(doc).not.toContain('maxTasksPerRequesterPerHour');
      expect(doc).toContain('--max-requests-per-minute');
      expect(doc).not.toMatch(/jobs\/hour|1人あたり1時間/);
    }
  });
  it('creates a local identity, unapproved contact and reciprocal invite without inheriting remote capabilities (#78)', () => {
    const f = fixture(), p = paths();
    const result = setupInvite(f.token, p.key, p.contacts, p.out);
    const reply = openInvite(readFileSync(p.out, 'utf8'));
    expect(reply.ownerDid).toBe(result.ownerDid);
    expect(reply.ownerDid).not.toBe(f.owner.did);
    expect(reply.agentCard.payload).toMatchObject({ skills: [{ id: 'json-task', name: 'JSON task' }], protocolVersions: ['0.2.0', '0.1.0'] });
    expect(loadContacts(p.contacts, result.ownerDid)).toMatchObject([{ ownerDid: f.owner.did, allow: false }]);
    const original = readFileSync(p.key, 'utf8');
    setupInvite(f.token, p.key, p.contacts, join(p.dir, 'second.txt'));
    expect(readFileSync(p.key, 'utf8') === original).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
  });
  it.each(['forged', 'expired', 'private-relay'])('rejects %s invites before creating any local files (#78)', kind => {
    const f = fixture(), p = paths();
    const signed = JSON.parse(Buffer.from(f.token.slice(11), 'base64url').toString());
    if (kind === 'forged') signed.payload.agentDid = generateKeyPair().did;
    if (kind === 'expired') { signed.payload.expiresAt = new Date(Date.now() - 1000).toISOString(); }
    if (kind === 'private-relay') {
      signed.payload.relayUrl = 'http://127.0.0.1:8787';
      signed.payload.agentCard = createSignedAgentCard({ name: 'Private', agentDid: f.owner.did,
        relayEndpoint: signed.payload.relayUrl, skills: [] }, f.owner);
    }
    const data = kind === 'forged' ? signed : signPayload(signed.payload, f.owner);
    const token = 'acp-invite:' + Buffer.from(JSON.stringify(data)).toString('base64url');
    expect(() => setupInvite(token, p.key, p.contacts, p.out)).toThrow();
    expect(existsSync(p.key)).toBe(false);
    expect(existsSync(p.contacts)).toBe(false);
    expect(existsSync(p.out)).toBe(false);
  });
  it('lets the original inviter delegate through the reciprocal invite once a worker is started (#78)', async () => {
    const f = fixture(), p = paths();
    setupInvite(f.token, p.key, p.contacts, p.out);
    const owner = JSON.parse(readFileSync(p.key, 'utf8')), relay = new InMemoryRelay();
    const worker = new WorkerNode({ checkPeer: () => 'trusted', owner, relay, relayUrl: 'https://relay.example.com', timeoutMs: 4000,
      approvalProvider: new PolicyAutoApprovalProvider(owner),
      adapter: { id: 'json-task', name: 'JSON task', skills: [{ id: 'json-task', name: 'JSON task' }],
        async executeTask(context) { return context.input; } } });
    await worker.register();
    const client = new RequesterClient({ owner: f.owner, relay, timeoutMs: 4000,
      approvalProvider: new PolicyAutoApprovalProvider(f.owner) });
    const done = worker.start({ once: true });
    try {
      const [result] = await Promise.all([client.delegate({ to: readFileSync(p.out, 'utf8'), title: 'Reply',
        description: 'Reciprocal invitation', input: { hello: true } }), done]);
      expect(result.state).toBe('SETTLED');
      expect(result.deliverable).toEqual({ hello: true });
    } finally { worker.stop(); }
  });
  it('fails closed on corrupt, mismatched, self-owned keys and output collisions (#78)', () => {
    const f = fixture(), p = paths();
    for (const data of ['{}', JSON.stringify({ ...f.owner, did: generateKeyPair().did }), JSON.stringify(f.owner)]) {
      writeFileSync(p.key, data);
      expect(() => setupInvite(f.token, p.key, p.contacts, p.out)).toThrow();
      expect(readFileSync(p.key, 'utf8') === data).toBe(true);
      expect(existsSync(p.out)).toBe(false);
    }
    writeFileSync(p.key, JSON.stringify(generateKeyPair()));
    writeFileSync(p.out, 'preserve');
    expect(() => setupInvite(f.token, p.key, p.contacts, p.out)).toThrow();
    expect(readFileSync(p.out, 'utf8')).toBe('preserve');
    expect(existsSync(p.contacts)).toBe(false);
  });
  it('opens using default first-time paths and retains machine-readable effective expiry (#78, #79)', async () => {
    const f = fixture(), p = paths();
    vi.stubEnv('ACP_DATA_DIR', p.dir);
    const file = join(p.dir, 'incoming.txt'); writeFileSync(file, f.token);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await inviteShareCommand('open', ['--file', file]);
      const result = JSON.parse(String(log.mock.calls[0][0]));
      expect(result.expiresAt).toBe(openInvite(f.token).agentCard.payload.expiresAt);
      expect(result.expires).toContain('Expires in');
      expect(existsSync(result.local.keyFile)).toBe(true);
      expect(existsSync(result.local.reciprocalInviteFile)).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });
  it('formats local dates across day boundaries with explicit zones and expired wording (#79)', () => {
    const now = Date.parse('2026-10-29T14:30:00Z'), expiry = '2026-10-29T15:30:00Z';
    expect(friendlyExpiry(expiry, now, 'en-US', 'Asia/Tokyo')).toMatch(/Expires in 1 hour.*Oct 30.*(?:JST|GMT\+9)/);
    expect(friendlyExpiry(expiry, now, 'en-US', 'America/Los_Angeles')).toMatch(/Oct 29.*(?:PDT|GMT-7)/);
    expect(friendlyExpiry(expiry, now + 7200000, 'en-US', 'UTC')).toContain('Expired 1 hour ago');
    expect(() => friendlyExpiry('invalid')).toThrow('INVALID_INVITE_EXPIRY');
  });
  it('renews a split-key card with owner signature and fresh agent authorization (#80)', () => {
    const f = fixture(true);
    const renewed = openInvite(reissueInvite(f.token, f.owner, 86400, f.agent));
    expect(renewed.ownerDid).toBe(f.owner.did);
    expect(renewed.agentDid).toBe(f.agent.did);
    expect(renewed.agentCard.signature.signerDid).toBe(f.owner.did);
    expect(renewed.agentCard.payload.agentDelegation?.signerDid).toBe(f.agent.did);
  });
  it('rejects missing, wrong, forged agent keys and wrong owner keys during re-issue (#80)', () => {
    const f = fixture(true), stranger = generateKeyPair();
    expect(() => reissueInvite(f.token, f.agent, 86400, f.owner)).toThrow('ISSUER_KEY');
    expect(() => reissueInvite(f.token, f.owner)).toThrow('AGENT_DELEGATION_REQUIRED');
    expect(() => reissueInvite(f.token, f.owner, 86400, stranger)).toThrow('AGENT_DELEGATION_REQUIRED');
    expect(() => reissueInvite(f.token, f.owner, 86400, { ...stranger, did: f.agent.did })).toThrow();
    const signed = JSON.parse(Buffer.from(f.token.slice(11), 'base64url').toString());
    signed.payload.agentCard.payload.agentDid = stranger.did;
    const forged = 'acp-invite:' + Buffer.from(JSON.stringify(signPayload(signed.payload, f.owner))).toString('base64url');
    expect(() => reissueInvite(forged, f.owner, 86400, stranger)).toThrow();
  });
  it('counts malformed, forged and expired jobs while preserving stdout JSON (#81)', async () => {
    const p = paths(), owner = generateKeyPair();
    const post = createPost(owner, { what: 'Test', relay: 'https://relay.example.com', skillId: 'json', taskType: 'json',
      budget: { maxInputTokens: 1, maxOutputTokens: 1, maxToolInvocations: 1, maxWallClockSeconds: 1 },
      deadline: new Date(Date.now() + 60000).toISOString() }, {});
    writeFileSync(join(p.dir, 'valid.json'), JSON.stringify(post));
    writeFileSync(join(p.dir, 'malformed.json'), '{');
    writeFileSync(join(p.dir, 'forged.json'), JSON.stringify({ ...post, payload: { ...post.payload, what: 'forged' } }));
    writeFileSync(join(p.dir, 'expired.json'), JSON.stringify(signPayload({ ...post.payload, deadline: new Date(0).toISOString() }, owner)));
    writeFileSync(join(p.dir, 'ignored.txt'), '{}');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await boardCommand(['list', '--dir', p.dir]);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual([post.payload]);
    expect(warn).toHaveBeenCalledWith('3 invalid jobs skipped');
    warn.mockClear();
    await boardCommand(['list', '--dir', paths().dir]);
    expect(warn).not.toHaveBeenCalled();
  });
});
