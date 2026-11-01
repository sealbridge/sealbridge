// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, signPayload, verifySigned, verifySignedAgentCard, validateRelayEndpointUrl,
  discoverAgentCards, OPEN_POLICY_FIELDS } from '@acp/core';
import type { Json, KeyPair, OpenPolicy, Signed, SignedAgentCard, TaskManifest } from '@acp/core';
import { WorkerNode, RequesterClient, InteractiveCliApprovalProvider, buildTaskManifest } from '@acp/runtime';
import type { AgentAdapter, ApprovalProvider, IdentityStoreOptions } from '@acp/runtime';
import { commandIdentity } from './command-identity.js';
import { HttpRelayClient } from '@acp/relay';

export interface BoardPost {
  type: 'BoardPost'; id: string; ownerDid: string; relay: string; what: string;
  skillId: string; taskType: string; budget: Required<OpenPolicy>; inputDigest: string;
  createdAt: string; deadline: string;
}
export interface BoardLease {
  type: 'BoardLease'; postId: string; postDigest: string; ownerDid: string; workerDid: string;
  agentDid: string; claimTaskId: string; nonce: string; expiresAt: string; accepted: boolean; consumed: boolean;
}
function exactKeys(value: object, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === keys.sort().join(',');
}
export function verifyPost(value: Signed<BoardPost>, now = Date.now()): BoardPost {
  try {
    const p = value.payload;
    if (!verifySigned(value, p.ownerDid) || p.type !== 'BoardPost' ||
        !exactKeys(p, ['type','id','ownerDid','relay','what','skillId','taskType','budget','inputDigest','createdAt','deadline']) ||
        !/^[a-f0-9-]{36}$/.test(p.id) || !/^sha256:[a-f0-9]{64}$/.test(p.inputDigest) ||
        [p.what, p.skillId, p.taskType].some(s => typeof s !== 'string' || !s || s.length > 240 || /[\x00-\x1f\x7f]/.test(s)) ||
        !Number.isFinite(Date.parse(p.createdAt)) || Date.parse(p.createdAt) > now + 60000 ||
        !Number.isFinite(Date.parse(p.deadline)) || Date.parse(p.deadline) <= now || Date.parse(p.deadline) <= Date.parse(p.createdAt) ||
        !exactKeys(p.budget, [...OPEN_POLICY_FIELDS]) ||
        OPEN_POLICY_FIELDS.some(f => !Number.isSafeInteger(p.budget[f]) || p.budget[f] < 1)) throw new Error();
    validateRelayEndpointUrl(p.relay);
    return p;
  } catch { throw new Error('INVALID_BOARD_POST'); }
}
export function createPost(key: KeyPair, fields: Omit<BoardPost, 'type' | 'id' | 'ownerDid' | 'createdAt' | 'inputDigest'>, input: Json): Signed<BoardPost> {
  const post = signPayload<BoardPost>({ ...fields, type: 'BoardPost', id: randomUUID(), ownerDid: key.did,
    createdAt: new Date().toISOString(), inputDigest: digest(input) }, key);
  verifyPost(post);
  return post;
}
export function candidateFit(post: Signed<BoardPost>, card: SignedAgentCard): string[] {
  const p = verifyPost(post);
  if (!verifySignedAgentCard(card)) return ['Invalid or expired public profile'];
  const c = card.payload, reasons: string[] = [];
  if (c.accessMode !== 'open') reasons.push('Invite only');
  if (c.relayEndpoint !== p.relay) reasons.push('Different relay');
  if (!c.skills.some(s => s.id === p.skillId && s.taskTypes?.includes(p.taskType))) reasons.push('Job type is not accepted');
  for (const f of OPEN_POLICY_FIELDS) if (c.openPolicy?.[f] !== undefined && p.budget[f] > c.openPolicy[f]!)
    reasons.push(f + ': job asks for ' + p.budget[f] + ', worker allows ' + c.openPolicy[f]);
  return reasons;
}
export function boardCandidates(post: Signed<BoardPost>, raw: unknown) {
  return discoverAgentCards(raw).map(card => ({ name: card.payload.name, did: card.payload.agentDid,
    taskTypes: card.payload.skills.flatMap(s => s.taskTypes ?? []), limits: card.payload.openPolicy ?? {},
    reasons: candidateFit(post, card), card })).sort((a, b) => a.reasons.length - b.reasons.length ||
      Date.parse(b.card.signature.signedAt) - Date.parse(a.card.signature.signedAt));
}
function mutateLease<T>(path: string, key: KeyPair, change: (old?: BoardLease) => { lease: BoardLease; result: T }): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = path + '.lock', temp = path + '.' + randomUUID() + '.tmp';
  try { writeFileSync(lock, '', { flag: 'wx', mode: 0o600 }); } catch { throw new Error('CLAIM_LOST'); }
  try {
    let old: BoardLease | undefined;
    try {
      const signed = JSON.parse(readFileSync(path, 'utf8')) as Signed<BoardLease>;
      if (!verifySigned(signed, key.did) || signed.payload.ownerDid !== key.did || signed.payload.type !== 'BoardLease')
        throw new Error('INVALID_LEASE');
      old = signed.payload;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const { lease, result } = change(old);
    writeFileSync(temp, JSON.stringify(signPayload(lease, key)), { flag: 'wx', mode: 0o600, flush: true });
    renameSync(temp, path);
    return result;
  } finally {
    try { unlinkSync(temp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    unlinkSync(lock);
  }
}
export function claimPost(path: string, key: KeyPair, post: Signed<BoardPost>, card: SignedAgentCard,
  senderDid: string, claimTaskId: string, now = Date.now()): BoardLease {
  const p = verifyPost(post, now);
  if (p.ownerDid !== key.did || card.payload.ownerDid !== senderDid || candidateFit(post, card).length)
    throw new Error('INVALID_BOARD_CLAIM');
  return mutateLease(path, key, old => {
    if (old && (old.postId !== p.id || old.consumed || Date.parse(old.expiresAt) > now)) throw new Error('CLAIM_LOST');
    const lease: BoardLease = { type: 'BoardLease', postId: p.id, postDigest: digest(post), ownerDid: key.did,
      workerDid: senderDid, agentDid: card.payload.agentDid, claimTaskId, nonce: randomUUID(),
      expiresAt: new Date(Math.min(now + 300000, Date.parse(p.deadline))).toISOString(), accepted: false, consumed: false };
    return { lease, result: lease };
  });
}
export function consumeLease(path: string, key: KeyPair, post: Signed<BoardPost>, input: Json, now = Date.now()): BoardLease {
  const p = verifyPost(post, now);
  if (p.ownerDid !== key.did || digest(input) !== p.inputDigest) throw new Error('INVALID_BOARD_INPUT');
  return mutateLease(path, key, old => {
    if (!old || !old.accepted || old.postId !== p.id || old.postDigest !== digest(post) || old.consumed || Date.parse(old.expiresAt) <= now)
      throw new Error('CLAIM_LOST');
    const lease = { ...old, consumed: true };
    return { lease, result: lease };
  });
}

/** Metadata claim is a normal encrypted ACP job; the real input is a later job. */
export function boardHost(post: Signed<BoardPost>, key: KeyPair, path: string, interactive: ApprovalProvider) {
  const p = verifyPost(post);
  if (p.ownerDid !== key.did) throw new Error('INVALID_BOARD_OWNER');
  const approved = new Map<string, BoardLease>();
  const approvalProvider: ApprovalProvider = { async approve(request) {
    if (request.gate !== 'contract_acceptance') return interactive.approve(request);
    const details = request.details as { manifest: TaskManifest; from: string };
    let claim: { postId: string; card: SignedAgentCard };
    try { claim = JSON.parse(details.manifest.task.description); } catch { throw new Error('INVALID_BOARD_CLAIM'); }
    if (claim.postId !== p.id) throw new Error('INVALID_BOARD_CLAIM');
    const lease = claimPost(path, key, post, claim.card, details.from, request.taskId);
    const receipt = await interactive.approve(request);
    if (Date.parse(lease.expiresAt) <= Date.now()) throw new Error('CLAIM_LOST');
    approved.set(request.taskId, lease);
    return receipt;
  } };
  const adapter: AgentAdapter = { id: 'board-claims', name: 'Job board claims',
    skills: [{ id: 'board-claim', name: 'Claim a posted job', taskTypes: ['board-claim'] }],
    async executeTask(context) {
      const lease = approved.get(context.taskId);
      approved.delete(context.taskId);
      if (!lease) throw new Error('INVALID_BOARD_CLAIM');
      const accepted = mutateLease(path, key, old => {
        if (!old || old.nonce !== lease.nonce || old.consumed || Date.parse(old.expiresAt) <= Date.now()) throw new Error('CLAIM_LOST');
        const updated = { ...old, accepted: true };
        return { lease: updated, result: updated };
      });
      return JSON.parse(JSON.stringify(signPayload(accepted, key))) as Json;
    },
  };
  return { adapter, approvalProvider };
}

export async function boardCommand(args: string[], identityOptions: IdentityStoreOptions = {}): Promise<void> {
  const [action, ...rest] = args;
  const f = new Map<string, string>();
  const allowed = ['--key','--post','--dir','--input-file','--what','--skill','--task-type','--deadline','--relay',
    '--max-input-tokens','--max-output-tokens','--max-tool-calls','--max-wall-seconds','--card','--state','--out','--audit'];
  for (let i = 0; i < rest.length; i += 2) {
    if (!allowed.includes(rest[i]) || f.has(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith('--'))
      throw new Error('INVALID_BOARD_OPTION: owner approval cannot be bypassed');
    f.set(rest[i], rest[i + 1]);
  }
  const need = (n: string) => { const v = f.get('--' + n); if (!v) throw new Error('Missing --' + n); return v; };
  const read = <T>(n: string): T => JSON.parse(readFileSync(need(n), 'utf8')) as T;
  const save = (n: string, v: unknown) => writeFileSync(need(n), JSON.stringify(v, null, 2), { flag: 'wx', mode: 0o600 });
  if (action === 'list') {
    const dir = need('dir');
    let skipped = 0;
    const posts = readdirSync(dir).filter(n => n.endsWith('.json')).flatMap(n => {
      try { const signed = JSON.parse(readFileSync(join(dir, n), 'utf8')); return [verifyPost(signed)]; }
      catch { skipped++; return []; }
    });
    if (skipped) console.warn(`${skipped} invalid job${skipped === 1 ? '' : 's'} skipped`);
    console.log(JSON.stringify(posts)); return;
  }
  if (action === 'post') {
    const key = (await commandIdentity('requester', f.get('--key'), identityOptions))!;
    const post = createPost(key, { relay: need('relay'), what: need('what'), skillId: need('skill'), taskType: need('task-type'),
      deadline: need('deadline'), budget: { maxInputTokens: Number(need('max-input-tokens')),
        maxOutputTokens: Number(need('max-output-tokens')), maxToolInvocations: Number(need('max-tool-calls')),
        maxWallClockSeconds: Number(need('max-wall-seconds')) } }, read<Json>('input-file'));
    save('out', post); console.log(JSON.stringify({ postId: post.payload.id, saved: true })); return;
  }
  const post = read<Signed<BoardPost>>('post'), p = verifyPost(post);
  if (action === 'candidates') {
    console.log(JSON.stringify(boardCandidates(post, await new HttpRelayClient(p.relay).discover()))); return;
  }
  const key = (await commandIdentity(action === 'claim' ? 'worker' : 'requester', f.get('--key'), identityOptions))!;
  const approval = new InteractiveCliApprovalProvider(key);
  if (action === 'serve') {
    const host = boardHost(post, key, need('state'), approval);
    const worker = new WorkerNode({ owner: key, relay: p.relay, relayUrl: p.relay, accessMode: 'open',
      ...host, auditPath: need('audit'), maxConcurrentTasks: 8, maxTasksPerRequesterPerMinute: 5 });
    await worker.register();
    console.log('Waiting for claims. Owner approval is required; no task input is published.');
    const stop = () => worker.stop();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try { await worker.start(); } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  } else if (action === 'claim') {
    const card = read<SignedAgentCard>('card');
    if (card.payload.ownerDid !== key.did || candidateFit(post, card).length) throw new Error('INVALID_BOARD_CLAIM');
    const claim = { postId: p.id, card };
    const client = new RequesterClient({ owner: key, relay: p.relay, approvalProvider: approval, auditPath: need('audit') });
    const result = await client.delegate({ to: p.ownerDid, discover: { skillId: 'board-claim', taskType: 'board-claim' },
      title: 'Claim job ' + p.id, description: JSON.stringify(claim), input: { postId: p.id } });
    save('out', result.deliverable); console.log(JSON.stringify({ state: result.state, taskId: result.taskId }));
  } else if (action === 'dispatch') {
    const input = read<Json>('input-file');
    // Consume before transmission. Ambiguous network failures must never trigger a second dispatch.
    const lease = consumeLease(need('state'), key, post, input);
    const manifest = buildTaskManifest({ ownerDid: key.did, workerDid: lease.workerDid, agentDid: lease.agentDid,
      title: p.what, description: 'Job board entry ' + p.id, budget: p.budget, skillId: p.skillId, taskType: p.taskType });
    manifest.deadline = p.deadline;
    const client = new RequesterClient({ owner: key, relay: p.relay, approvalProvider: approval, auditPath: need('audit') });
    const result = await client.delegate({ to: lease.agentDid, title: p.what, description: manifest.task.description, input, manifest });
    save('out', result.deliverable); console.log(JSON.stringify({ state: result.state, taskId: result.taskId }));
  } else throw new Error('INVALID_BOARD_ACTION');
}
