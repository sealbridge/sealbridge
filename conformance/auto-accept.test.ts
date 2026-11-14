// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { autoAcceptPolicy, createInviteToken, digest, signPayload, verifySigned, verifySignedAgentCard } from '../packages/core/src/index.js';
import type { ApprovalReceipt, AutoAcceptPolicy } from '../packages/core/src/index.js';
import { matchesAutoAccept, readOnlyTask } from '../packages/runtime/src/auto-accept.js';
import { workerIntakePath } from '../packages/runtime/src/index.js';
import { readApplicationConfig, setApplicationAutoAccept } from '../packages/runtime/src/application-config.js';
import { configCommand } from '../cli/src/config.js';
import { admissionFixture } from './connections-fixture.js';
const fixtures: ReturnType<typeof admissionFixture>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) f.cleanup(); });
function fixture(policy?: AutoAcceptPolicy) {
  const f = admissionFixture(policy ? { autoAccept: policy } : {});
  Object.assign(f.worker.options.adapter, { taskAccess: 'read-only' });
  // The standard fixture uses a host-owned private data root for all durable state.
  f.worker.options.identityOptions = f.identityOptions;
  fixtures.push(f); return f;
}
const policy = (patch: Partial<AutoAcceptPolicy> = {}) => ({ ...autoAcceptPolicy(), ...patch });

it('defaults to read-only, connected work and advertises the signed rule', () => {
  const f = fixture();
  expect(f.worker.autoAccept).toEqual({ version: 1, enabled: true, from: 'connected', work: 'read-only', limits: {} });
  expect(f.worker.agentCard.payload.autoAccept).toEqual(f.worker.autoAccept);
  expect(verifySignedAgentCard(f.worker.agentCard)).toBe(true);
  const card = structuredClone(f.worker.agentCard); card.payload.autoAccept!.work = 'write';
  expect(verifySignedAgentCard(card)).toBe(false);
  const unsupported = signPayload({ ...card.payload, autoAccept: { ...policy(), limits: { perDay: 3 } } }, f.owner);
  expect(verifySignedAgentCard(unsupported as never)).toBe(false);
});
it('holds a non-connected read-only request until the owner opts in', async () => {
  const f = fixture(); await f.worker.register();
  expect((await f.attempt())[0]).toMatchObject({ status: 'rejected', reason: { code: 'PENDING_OWNER_APPROVAL' } });
  expect(f.execute).not.toHaveBeenCalled(); expect(f.human.approve).not.toHaveBeenCalled();
});
it.each(['connected', 'invited'] as const)('automatically runs %s read-only tasks without inspection or owner opening', async from => {
  const f = fixture(policy({ from }));
  const result = await f.attempt(f.worker.invite());
  expect(result[0]).toMatchObject({ status: 'fulfilled', value: { state: 'SETTLED' } });
  expect(f.execute).toHaveBeenCalledOnce(); expect(f.human.approve).not.toHaveBeenCalled(); expect(f.approve).not.toHaveBeenCalled();
});
it('anyone is explicit opt-in, grants no connection, and persists each signed decision', async () => {
  const f = fixture(policy({ from: 'anyone' })); await f.worker.register();
  let notice: unknown;
  const results = await f.attempt(f.owner.did, { beforePropose: async (action: unknown) => { notice = action; } });
  expect(results[0]).toMatchObject({ status: 'fulfilled', value: { state: 'SETTLED' } });
  expect(f.store.connectionState(f.requester.did)).not.toBe('connected');
  expect(notice).toMatchObject({ workerAutomation: { policy: { from: 'anyone' }, notice: expect.stringContaining('automatically') } });
  const result = (results[1] as PromiseFulfilledResult<Awaited<ReturnType<typeof f.worker.runOnce>>>).value;
  const accept = result!.bundle.entries.find(e => e.body.eventType === 'ACCEPT')!.body.payload as unknown as { approval: ApprovalReceipt };
  expect(verifySigned(accept.approval, f.owner.did)).toBe(true);
  expect(accept.approval.payload.authorization).toEqual({ kind: 'auto-policy', ruleVersion: 1, ruleDigest: digest(f.worker.autoAccept) });
  const tampered = structuredClone(accept.approval); tampered.payload.authorization!.ruleVersion++;
  expect(verifySigned(tampered, f.owner.did)).toBe(false);
  const directory = join(dirname(workerIntakePath(f.owner.did, f.identityOptions)), 'auto-accept-audit');
  expect(readdirSync(directory)).toHaveLength(1);
  expect(readFileSync(join(directory, readdirSync(directory)[0]), 'utf8')).toContain('auto-policy');
});
it('discloses actual automatic approval at final review even with an older card', async () => {
  const f = fixture(policy({ from: 'anyone' }));
  const { autoAccept: _oldPolicy, ...legacyCard } = f.worker.agentCard.payload;
  const token = createInviteToken({ agentCard: signPayload(legacyCard, f.owner) }, f.owner);
  const approve = vi.spyOn(f.client.approvalProvider, 'approve');
  expect((await f.attempt(token))[0].status).toBe('fulfilled');
  const final = approve.mock.calls.find(([request]) => request.gate === 'final_verification')![0];
  expect(final.details).toMatchObject({ workerAutomation: {
    notice: expect.stringContaining('automatically'), authorization: { kind: 'auto-policy' },
  } });
});
it.each([false, true])('write auto-accept needs an explicit write rule (enabled=%s)', async enabled => {
  const f = fixture(policy({ from: 'anyone', ...(enabled ? { work: 'write' as const } : {}) }));
  Object.assign(f.worker.options.adapter, { taskAccess: 'write' }); await f.worker.register();
  expect((await f.attempt())[0]).toMatchObject(enabled
    ? { status: 'fulfilled', value: { state: 'SETTLED' } }
    : { status: 'rejected', reason: { code: 'PENDING_OWNER_APPROVAL' } });
  expect(f.execute).toHaveBeenCalledTimes(enabled ? 1 : 0);
});
it.each(['throws', 'false'] as const)('fails closed when counting state %s', async failure => {
  const f = fixture(policy({ from: 'anyone' }));
  f.worker.options.autoAcceptStateGuard = vi.fn(async () => { if (failure === 'throws') throw new Error('unreadable'); return false; });
  await f.worker.register();
  expect((await f.attempt())[0]).toMatchObject({ status: 'rejected', reason: { code: 'PENDING_OWNER_APPROVAL' } });
  expect(f.execute).not.toHaveBeenCalled();
});
it('supplies consistent connection and invitation facts to the state guard', async () => {
  const f = fixture(policy({ from: 'anyone' }));
  const guard = vi.fn(async () => true);
  f.worker.options.autoAcceptStateGuard = guard;
  expect((await f.attempt(f.worker.invite()))[0].status).toBe('fulfilled');
  expect(guard).toHaveBeenCalledOnce();
  expect(guard).toHaveBeenCalledWith(expect.objectContaining({ connected: true, invited: true }), f.worker.autoAccept);
});
it('does not let a legacy policy provider bypass a failed rule or counting check', async () => {
  const f = fixture(policy({ from: 'anyone' }));
  f.worker.options.checkPeer = () => 'trusted';
  f.worker.options.autoAcceptStateGuard = async () => { throw new Error('unreadable'); };
  await f.worker.register();
  expect((await f.attempt())[0]).toMatchObject({ status: 'rejected', reason: { code: 'APPROVAL_CHANNEL_UNAVAILABLE' } });
  expect(f.approve).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
});
it('keeps a per-peer disallow pending even with a legacy trusted peer and anyone-write rule', async () => {
  const f = fixture(policy({ from: 'anyone', work: 'write' }));
  expect((await f.attempt(f.worker.invite()))[0].status).toBe('fulfilled');
  f.store.setConnectionAcceptance(f.requester.did, 'off');
  f.worker.options.checkPeer = () => 'trusted';
  f.execute.mockClear();
  expect((await f.attempt())[0]).toMatchObject({ status: 'rejected', reason: { code: 'PENDING_OWNER_APPROVAL' } });
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.human.approve).not.toHaveBeenCalled();
});
it('retains signed automatic provenance in privacy-preserving context audit', async () => {
  const f = fixture(policy({ from: 'anyone' }));
  const results = await f.attempt(f.worker.invite(), { contextGrant: {
    selectors: ['selection'], angle: 'private review angle', deliveryMode: 'view_only',
  } });
  expect(results[0]).toMatchObject({ status: 'fulfilled', value: { state: 'SETTLED' } });
  const result = (results[1] as PromiseFulfilledResult<Awaited<ReturnType<typeof f.worker.runOnce>>>).value!;
  const accept = result.bundle.entries.find(e => e.body.eventType === 'ACCEPT')!.body.payload as unknown as { approval: ApprovalReceipt };
  expect(verifySigned(accept.approval, f.owner.did)).toBe(true);
  expect(accept.approval.payload.authorization!.kind).toBe('auto-policy');
  expect(JSON.stringify(result.bundle)).not.toContain('private review angle');
});
it('does not execute if its per-task audit cannot be created', async () => {
  const f = fixture(policy({ from: 'anyone' })); await f.worker.register();
  f.worker.options.auditPath = join(f.root, 'missing-parent', 'audit.jsonl');
  await expect(f.raw()).rejects.toThrow(); expect(f.execute).not.toHaveBeenCalled();
});
it('does not reinterpret previously held attempts or override a block', async () => {
  const f = fixture(); const m = f.manifest();
  await expect(f.raw(m)).rejects.toThrow('PENDING_OWNER_APPROVAL');
  Object.assign(f.worker.autoAccept, { from: 'anyone' });
  await expect(f.raw(m)).rejects.toThrow('PENDING_OWNER_APPROVAL');
  f.store.block(f.requester.did);
  await expect(f.raw()).rejects.toThrow('REQUEST_DENIED'); expect(f.execute).not.toHaveBeenCalled();
});
it('treats unknown adapters, unknown tools, commands and redelegation as non-read-only', async () => {
  const f = fixture(); const manifest = f.manifest();
  const context = { manifest, adapter: f.worker.options.adapter, tools: {}, connected: true, invited: false };
  expect(readOnlyTask(context)).toBe(true);
  expect(readOnlyTask({ ...context, adapter: { ...context.adapter, taskAccess: undefined } })).toBe(false);
  manifest.permissions.grantedCapabilities.push({ capabilityId: 'test', resource: 'fs', allowedTools: ['read'], maxInvocations: 1, expiresAt: manifest.deadline });
  expect(readOnlyTask(context)).toBe(false);
  expect(await matchesAutoAccept(policy(), { ...context, tools: { read: { readOnly: true } as never } })).toBe(true);
  manifest.verification.checks = [{ checkId: 'cmd', kind: 'command', target: 'echo test' }];
  expect(readOnlyTask({ ...context, tools: { read: { readOnly: true } as never } })).toBe(false);
});
it('persists explicit owner settings atomically, preserves other fields and rejects unsupported limits', async () => {
  const f = fixture(); vi.spyOn(console, 'log').mockImplementation(() => {});
  await configCommand(['auto-accept', 'anyone', 'write'], f.identityOptions);
  expect(readApplicationConfig(f.identityOptions).autoAccept).toEqual(policy({ from: 'anyone', work: 'write' }));
  await configCommand(['auto-accept', 'off'], f.identityOptions);
  expect(readApplicationConfig(f.identityOptions).autoAccept!.enabled).toBe(false);
  expect(() => setApplicationAutoAccept({ ...policy(), limits: { monthlyUsd: 20 } } as never, f.identityOptions)).toThrow('AUTO_ACCEPT_POLICY_INVALID');
  expect(readApplicationConfig(f.identityOptions).relays).toEqual(['https://relay.sealbridge.dev']);
});
