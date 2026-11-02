// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, createInviteToken, openEnvelope, digest, verifySigned } from '../packages/core/src/index.js';
import { SessionWire } from '../packages/runtime/src/session-audit.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { WorkerNode, RequesterClient, PolicyAutoApprovalProvider, buildTaskManifest,
  type ErrorDiagnostic } from '../packages/runtime/src/index.js';

function setup(auditPath?: string) {
  const owner = generateKeyPair(), requester = generateKeyPair(), relay = new InMemoryRelay();
  const events: { event: string; taskId: string; error?: ErrorDiagnostic }[] = [];
  const frames: unknown[] = [];
  let calls = 0;
  const worker = new WorkerNode({ checkPeer: () => 'trusted', owner, relay, auditPath, timeoutMs: 3000,
    approvalProvider: new PolicyAutoApprovalProvider(owner),
    onEvent: (event, taskId, error) => events.push({ event, taskId, error }),
    adapter: { id: 'echo', name: 'Echo', skills: [{ id: 'echo', name: 'Echo', taskTypes: ['json'] }],
      executeTask: async (ctx) => { calls++; return ctx.input; } } });
  void worker.register();
  const client = new RequesterClient({ owner: requester, relay, timeoutMs: 3000,
    approvalProvider: new PolicyAutoApprovalProvider(requester) });
  const send = relay.send.bind(relay);

  relay.send = (envelope) => {
    if (envelope.payload.eventType === 'ERROR' && envelope.payload.senderDid === owner.did)
      frames.push(openEnvelope(envelope, requester));
    return send(envelope);
  };
  const manifest = (scope = {}) => buildTaskManifest({ ownerDid: requester.did, workerDid: owner.did,
    title: 'Diagnostic test', description: 'Private payload must not appear in diagnostics', ...scope });
  return { owner, requester, worker, client, events, frames, manifest, calls: () => calls,
    setInvite: (value: string) => {
      const original = SessionWire.prototype.sendEvent;
      vi.spyOn(SessionWire.prototype, 'sendEvent').mockImplementation(function (this: SessionWire, event, payload) {
        return original.call(this, event, event === 'PROPOSE' ? { ...(payload as object), inviteToken: value } : payload);
      });
    } };
}

describe('Direct compatibility and signed ERROR diagnostics', () => {
  it('accepts direct proposals with neither skillId nor taskType', async () => {
    const s = setup();
    s.worker.acceptance.allowedRequesterDids = [s.requester.did];
    const m = s.manifest();
    expect(m.task.skillId).toBeUndefined();
    expect(m.task.taskType).toBeUndefined();
    const done = s.worker.start({ once: true });
    try {
      const [result] = await Promise.all([s.client.delegate({ title: 'Test', description: 'Test', to: s.owner.did, manifest: m, input: { ok: true } }), done]);
      expect(result.state).toBe('SETTLED');
      expect(s.calls()).toBe(1);
    } finally { vi.restoreAllMocks(); s.worker.stop(); }
  });
  it.each(['missing-type', 'unknown-skill', 'unknown-type'])('preserves scope rejection: %s, with private end-to-end detail', async (kind) => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-detail-'));
    const audit = join(dir, 'worker.jsonl');
    const s = setup(audit);
    const scope = kind === 'missing-type' ? { skillId: 'echo' } : kind === 'unknown-skill'
      ? { skillId: 'PRIVATE_SCOPE_VALUE', taskType: 'json' } : { taskType: 'PRIVATE_SCOPE_VALUE' };
    const m = s.manifest(scope);
    const done = s.worker.start({ once: true }).catch((error: Error) => error);
    try {
      const error = await s.client.delegate({ title: 'Test', description: 'Test', to: s.owner.did, manifest: m, input: { secret: 'PRIVATE_INPUT' } }).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect(await done).toMatchObject({ message: 'TASK_SCOPE_REJECTED' });
      const diagnostic = { code: 'TASK_SCOPE_REJECTED', detail: {
        field: 'task.scope', expected: digest(s.worker.agentCard.payload.skills), actual: digest(m.task),
        hint: expect.any(String) } };
      expect(s.frames[0]).toEqual(diagnostic);
      expect(error).toMatchObject(diagnostic);
      expect((error as Error).message).toContain(JSON.stringify(s.frames[0]));
      expect(s.events.filter((e) => e.event === 'REJECTED')).toEqual([{ event: 'REJECTED', taskId: m.taskId, error: diagnostic }]);
      const record = JSON.parse(readFileSync(audit + '.errors.jsonl', 'utf8'));
      expect(verifySigned(record, s.owner.did)).toBe(true);
      expect(record.payload).toMatchObject({ taskId: m.taskId, ...diagnostic });
      expect(JSON.stringify([record, s.frames, s.events])).not.toMatch(/PRIVATE_SCOPE_VALUE|PRIVATE_INPUT/);
      expect(s.calls()).toBe(0);
    } finally { vi.restoreAllMocks(); s.worker.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects valid expired invites before holding content', async () => {
    const s = setup();
    s.setInvite(createInviteToken({ agentCard: s.worker.agentCard,
      issuedAt: new Date(Date.now() - 10000).toISOString(), expiresInSeconds: 1 }, s.owner));
    const done = s.worker.start({ once: true }).catch((e: Error) => e);
    try {
      const result = await s.client.delegate({ title: 'Test', description: 'Test', to: s.owner.did, manifest: s.manifest(), input: {} }).catch((e: Error) => e);
      expect(result).toMatchObject({ code: 'INVITE_EXPIRED' });
      expect(s.frames[0]).toEqual({ code: 'INVITE_EXPIRED' }); expect(s.calls()).toBe(0);
      await done;
    } finally { vi.restoreAllMocks(); s.worker.stop(); }
  });
  it.each(['malformed', 'mismatch'] as const)('does not ignore %s invites before holding content', async (kind) => {
    const s = setup(), other = setup();
    s.setInvite(kind === 'malformed' ? 'acp-invite:invalid' : other.worker.invite());
    const done = s.worker.start({ once: true }).catch((e: Error) => e);
    try {
      await expect(s.client.delegate({ title: 'Test', description: 'Test', to: s.owner.did, manifest: s.manifest(), input: {} })).rejects.toThrow('PEER_REJECTED');
      await done;
      expect(s.frames[0]).toEqual({ code: kind === 'mismatch' ? 'INVITE_WORKER_MISMATCH' : 'INVALID' });
      expect(s.calls()).toBe(0);
    } finally { vi.restoreAllMocks(); s.worker.stop(); other.worker.stop(); }
  });
});

