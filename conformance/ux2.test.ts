// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { realpathSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { generateKeyPair, createSignedAgentCard, createInviteToken, signPayload, digest } from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { WorkerNode, RequesterClient, PolicyAutoApprovalProvider } from '../packages/runtime/src/index.js';
import { consumeDailyTask } from '../packages/runtime/src/daily-limit.js';
import { openInvite, shareLink, renderInviteQr, reissueInvite, inviteShareCommand } from '../cli/src/invite-share.js';
import { createPost, verifyPost, candidateFit, boardCandidates, claimPost, consumeLease, boardHost, boardCommand } from '../cli/src/board.js';
import { publicSettingsFlags } from '../cli/src/public-settings.js';
import { networkCommand } from '../cli/src/network.js';
const dirs: string[] = [];
function dir() { const d = mkdtempSync(join(realpathSync(tmpdir()), 'acp-ux2-')); dirs.push(d); return d; }
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const relayUrl = 'https://relay.example.com';
function fixture() {
  const owner = generateKeyPair(), worker = generateKeyPair();
  const budget = { maxInputTokens: 100, maxOutputTokens: 100, maxToolInvocations: 2, maxWallClockSeconds: 30 };
  const card = createSignedAgentCard({ name: 'Worker', agentDid: worker.did, relayEndpoint: relayUrl,
    accessMode: 'open', openPolicy: budget, skills: [{ id: 'echo', name: 'Echo', taskTypes: ['json'] }] }, worker);
  const input = { privateTask: 'not on the board' };
  const post = createPost(owner, { what: 'JSON task', skillId: 'echo', taskType: 'json', relay: relayUrl,
    budget, deadline: new Date(Date.now() + 3600000).toISOString() }, input);
  return { owner, worker, card, post, input, path: join(dir(), 'lease.json') };
}
describe('UX-2 invite share', () => {
  it('renders a real signed invite locally in all three formats', async () => {
    const { worker, card } = fixture();
    const token = createInviteToken({ agentCard: card }, worker);
    const link = shareLink(token, 'https://example.com/invite');
    expect(new URL(link).search).toBe('');
    expect(openInvite(link).ownerDid).toBe(worker.did);
    expect(await renderInviteQr(link, 'svg')).toContain('<svg');
    expect(await renderInviteQr(link, 'terminal')).toEqual(expect.any(String));
    expect((await renderInviteQr(link, 'png') as Buffer).subarray(1, 4).toString()).toBe('PNG');
  });
  it.each(['ownerDid', 'relayUrl', 'expiresAt', 'agentDid'])('rejects tampered QR/link %s', field => {
    const { worker, card } = fixture();
    const token = createInviteToken({ agentCard: card }, worker);
    const signed = JSON.parse(Buffer.from(token.slice(11), 'base64url').toString());
    signed.payload[field] = 'forged';
    const link = 'https://example.com/invite#acp-invite:' + Buffer.from(JSON.stringify(signed)).toString('base64url');
    expect(() => openInvite(link)).toThrow();
  });
  it('rejects expiry and refuses QR overflow without truncating', async () => {
    const { worker, card } = fixture();
    const token = createInviteToken({ agentCard: card, expiresInSeconds: 1 }, worker);
    expect(() => openInvite(shareLink(token, 'https://example.com/invite'), Date.now() + 2000)).toThrow('INVITE_EXPIRED');
    const large = createSignedAgentCard({ ...card.payload, description: 'x'.repeat(5000) }, worker);
    await expect(renderInviteQr(shareLink(createInviteToken({ agentCard: large }, worker), 'https://example.com/invite'), 'svg'))
      .rejects.toThrow('QR_CAPACITY_EXCEEDED');
  });
  it.each(['http://example.com/invite', 'https://u:p@example.com/invite', 'https://example.com/invite?autoApprove=true', 'https://example.com/invite#other'])('rejects unsafe share host %s', host => {
    const { worker, card } = fixture();
    expect(() => shareLink(createInviteToken({ agentCard: card }, worker), host)).toThrow();
  });
  it('requires issuer key and re-signs both objects with a fresh TTL', () => {
    const { owner, worker, card } = fixture();
    const token = createInviteToken({ agentCard: card, expiresInSeconds: 1 }, worker);
    expect(() => reissueInvite(token, owner)).toThrow('ISSUER_KEY');
    const updated = openInvite(reissueInvite(token, worker));
    expect(updated.ownerDid).toBe(worker.did);
    expect(Date.parse(updated.expiresAt) - Date.parse(updated.issuedAt)).toBe(86400000);
    expect(Date.parse(updated.agentCard.payload.expiresAt)).toBeGreaterThan(Date.now() + 86000000);
  });
  it.each(['--yes', '--auto-approve', '--auto-accept'])('rejects automatic invite approval %s', flag => {
    return expect(inviteShareCommand('open', [flag, 'true'])).rejects.toThrow('INVALID_INVITE_OPTION');
  });
});
describe('UX-2 board', () => {
  it('publishes only allowlisted signed metadata', () => {
    const { post, input } = fixture();
    expect(verifyPost(post).inputDigest).toBe(digest(input));
    expect(JSON.stringify(post)).not.toContain(input.privateTask);
  });
  it.each(['what', 'ownerDid', 'budget', 'deadline'])('rejects post spoofing: %s', field => {
    const { post } = fixture();
    const bad = structuredClone(post);
    Object.assign(bad.payload, { [field]: 'spoof' });
    expect(() => verifyPost(bad)).toThrow('INVALID_BOARD_POST');
  });
  it('rejects even signed extra plaintext fields and expired posts', () => {
    const { post, owner } = fixture();
    expect(() => verifyPost(signPayload({ ...post.payload, input: 'secret' }, owner))).toThrow();
    expect(() => verifyPost(post, Date.parse(post.payload.deadline))).toThrow();
  });
  it('pre-validates signed policies and hides forged discovery cards', () => {
    const { post, card, worker } = fixture();
    expect(candidateFit(post, card)).toEqual([]);
    const small = createSignedAgentCard({ ...card.payload, openPolicy: { maxInputTokens: 1 } }, worker);
    expect(candidateFit(post, small)).toContain('maxInputTokens: job asks for 100, worker allows 1');
    const bad = structuredClone(card); bad.payload.openPolicy = {};
    expect(boardCandidates(post, [bad])).toEqual([]);
  });
  it('binds claims to authenticated owner, post and candidate policy', () => {
    const { path, owner, worker, post, card } = fixture();
    expect(() => claimPost(path, owner, post, card, owner.did, 'claim')).toThrow();
    const lease = claimPost(path, owner, post, card, worker.did, 'claim');
    expect(lease.accepted).toBe(false);
    expect(() => claimPost(path, owner, post, card, worker.did, 'second')).toThrow('CLAIM_LOST');
  });
  it('does not release input before approval or permit wrong input / replay', () => {
    const { path, owner, worker, post, card, input } = fixture();
    const lease = claimPost(path, owner, post, card, worker.did, 'claim');
    expect(() => consumeLease(path, owner, post, input)).toThrow('CLAIM_LOST');
    writeFileSync(path, JSON.stringify(signPayload({ ...lease, accepted: true }, owner)));
    expect(() => consumeLease(path, owner, post, { different: true })).toThrow('INVALID_BOARD_INPUT');
    expect(consumeLease(path, owner, post, input).consumed).toBe(true);
    expect(() => consumeLease(path, owner, post, input)).toThrow('CLAIM_LOST');
    expect(() => claimPost(path, owner, post, card, worker.did, 'again', Date.now() + 400000)).toThrow('CLAIM_LOST');
  });
  it('allows a new lease after expiry but rejects stale dispatch', () => {
    const { path, owner, worker, post, card, input } = fixture();
    const lease = claimPost(path, owner, post, card, worker.did, 'claim');
    expect(() => consumeLease(path, owner, post, input, Date.now() + 400000)).toThrow('CLAIM_LOST');
    expect(claimPost(path, owner, post, card, worker.did, 'new', Date.now() + 400000).nonce).not.toBe(lease.nonce);
  });
  it.each(['--yes', '--auto-approve'])('refuses board auto approval %s', flag =>
    expect(boardCommand(['claim', flag, 'true'])).rejects.toThrow('INVALID_BOARD_OPTION'));
  it('settles a normal encrypted metadata claim before permitting dispatch', async () => {
    const { owner, worker, post, card, path, input } = fixture();
    const relay = new InMemoryRelay();
    const host = boardHost(post, owner, path, new PolicyAutoApprovalProvider(owner));
    const node = new WorkerNode({ owner, relay, relayUrl, accessMode: 'open', ...host, timeoutMs: 4000 });
    await node.register();
    const client = new RequesterClient({ owner: worker, relay, timeoutMs: 4000, approvalProvider: new PolicyAutoApprovalProvider(worker) });
    const done = node.start({ once: true });
    try {
      const [result] = await Promise.all([client.delegate({ to: owner.did,
        discover: { skillId: 'board-claim', taskType: 'board-claim' }, title: 'Claim',
        description: JSON.stringify({ postId: post.payload.id, card }), input: { postId: post.payload.id } }), done]);
      expect(result.state).toBe('SETTLED');
      expect(JSON.stringify(result.deliverable)).not.toContain(input.privateTask);
      expect(consumeLease(path, owner, post, input).workerDid).toBe(worker.did);
    } finally { node.stop(); }
  });
});
function child(code: string): Promise<number> {
  return new Promise((resolve, reject) => { const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore', shell: false });
    p.once('error', reject); p.once('close', n => resolve(n ?? -1)); });
}
describe('UX-2 persistent daily limit', () => {
  it('enforces the cap on real workers after both owner and requester rotate', async () => {
    const path = join(dir(), 'daily.json');
    for (let attempt = 0; attempt < 2; attempt++) {
      const owner = generateKeyPair(), requester = generateKeyPair(), relay = new InMemoryRelay();
      let calls = 0;
      const worker = new WorkerNode({ owner, relay, accessMode: 'open', timeoutMs: 3000,
        dailyLimit: { path, maxTasks: 1 }, approvalProvider: new PolicyAutoApprovalProvider(owner),
        adapter: { id: 'echo', name: 'Echo', skills: [{ id: 'echo', name: 'Echo' }],
          async executeTask(ctx) { calls++; return ctx.input; } } });
      await worker.register();
      const client = new RequesterClient({ owner: requester, relay, timeoutMs: 3000,
        approvalProvider: new PolicyAutoApprovalProvider(requester) });
      const done = worker.start({ once: true }).catch(e => e);
      try {
        const task = client.delegate({ to: owner.did, title: 'Test', description: 'Daily admission', input: {} });
        if (attempt === 0) expect((await task).state).toBe('SETTLED');
        else await expect(task).rejects.toMatchObject({ code: 'DAILY_LIMIT_REACHED' });
        await done;
        expect(calls).toBe(attempt === 0 ? 1 : 0);
      } finally { worker.stop(); }
    }
  });
  it('persists across restarts and DID rotation and resets only at UTC midnight', () => {
    const path = join(dir(), 'daily.json'), now = Date.parse('2026-10-29T23:59:59Z');
    consumeDailyTask(path, 1, generateKeyPair().did, now);
    expect(() => consumeDailyTask(path, 1, generateKeyPair().did, now)).toThrow('DAILY_LIMIT_REACHED');
    consumeDailyTask(path, 1, 'new-day', now + 1000);
    expect(() => consumeDailyTask(path, 1, 'rollback', now)).toThrow('CLOCK_ROLLBACK');
  });
  it('rejects replay, corrupt state and stale lock without resetting count', () => {
    const path = join(dir(), 'daily.json');
    consumeDailyTask(path, 2, 'one');
    expect(() => consumeDailyTask(path, 2, 'one')).toThrow('DAILY_TASK_REPLAY');
    writeFileSync(path, '{}');
    expect(() => consumeDailyTask(path, 2, 'two')).toThrow('DAILY_LIMIT_INVALID');
    writeFileSync(path + '.lock', '');
    expect(() => consumeDailyTask(path, 2, 'two')).toThrow('DAILY_LIMIT_BUSY');
  });
  it('never exceeds the host cap with simultaneous processes', async () => {
    const path = join(dir(), 'daily.json');
    const url = pathToFileURL(resolve('packages/runtime/dist/daily-limit.js')).href;
    const outcomes = await Promise.all(Array.from({ length: 12 }, (_, i) => child(
      `import {consumeDailyTask} from ${JSON.stringify(url)}; try { consumeDailyTask(${JSON.stringify(path)}, 3, 'task-${i}'); } catch { process.exitCode = 2; }`)));
    expect(outcomes.filter(n => n === 0).length).toBeGreaterThan(0);
    expect(outcomes.filter(n => n === 0).length).toBeLessThanOrEqual(3);
    expect(JSON.parse(readFileSync(path, 'utf8')).tasks).toHaveLength(outcomes.filter(n => n === 0).length);
  });
  it('reserves exactly one lease across concurrent processes', async () => {
    const { owner, worker, card, post, path } = fixture();
    // Generated fixture keys are test-only and never printed or transmitted.
    const dataPath = join(dirnameForTest(path), 'fixture.json');
    writeFileSync(dataPath, JSON.stringify({ owner, worker, card, post }), { mode: 0o600 });
    const url = pathToFileURL(resolve('cli/dist/board.js')).href;
    const outcomes = await Promise.all(Array.from({ length: 8 }, (_, i) => child(
      `import {readFileSync} from 'node:fs'; import {claimPost} from ${JSON.stringify(url)};
       const f = JSON.parse(readFileSync(${JSON.stringify(dataPath)},'utf8'));
       try { claimPost(${JSON.stringify(path)}, f.owner, f.post, f.card, f.worker.did, 'claim-${i}'); } catch { process.exitCode=2; }`)));
    expect(outcomes.filter(n => n === 0)).toHaveLength(1);
  });
});
function dirnameForTest(path: string) { return resolve(path, '..'); }
describe('UX-2 public settings', () => {
  const settings = { public: true, taskTypes: ['json'], maxInputTokens: 500, maxOutputTokens: 200,
    maxToolCalls: 2, maxWallSeconds: 30, maxJobsPerPersonPerMinute: 4, maxJobsPerDay: 20, alwaysAsk: true };
  it('maps settings to existing flags without implicit automatic acceptance', () => {
    const flags = publicSettingsFlags(settings);
    expect(flags).toContain('--open-rate-limit-per-did');
    expect(flags).toContain('--max-tasks-per-day');
    expect(flags).not.toContain('--auto-accept');
    expect(publicSettingsFlags({ ...settings, alwaysAsk: false })).toContain('--allow-any-requester');
    expect(publicSettingsFlags({ ...settings, public: false })).not.toContain('--publish');
  });
  it('previews actual signed policy without registering', async () => {
    const d = dir(), key = generateKeyPair();
    writeFileSync(join(d, 'key.json'), JSON.stringify(key), { mode: 0o600 });
    writeFileSync(join(d, 'settings.json'), JSON.stringify(settings));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await networkCommand('worker', ['public', '--key', join(d, 'key.json'), '--settings', join(d, 'settings.json'),
      '--relay', relayUrl, '--contacts', join(d, 'contacts.json'), '--preview', '--max-input-tokens', '50']);
    const profile = JSON.parse(String(log.mock.calls[0][0]));
    expect(profile.perJob.maxInputTokens).toBe(50);
    expect(profile.hostLimits).toMatchObject({ perPersonPerMinute: 4, perDay: 20, dayReset: '00:00 UTC' });
    expect(profile.approval).toBe('Owner approval required');
  });
});
