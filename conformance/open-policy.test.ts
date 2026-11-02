// SPDX-License-Identifier: Apache-2.0
import { expect, it, afterEach } from 'vitest';
import { createSignedAgentCard, discoverAgentCards, signPayload, verifySignedAgentCard } from '../packages/core/src/index.js';
import { WorkerNode, RequesterClient, PolicyAutoApprovalProvider, evaluateContractAcceptance } from '../packages/runtime/src/index.js';
import { admissionFixture } from './connections-fixture.js';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
it.each(['maxInputTokens','maxOutputTokens','maxToolInvocations','maxWallClockSeconds'] as const)
  ('retains general host budget enforcement for %s before invite redemption', async field => {
    const f = admissionFixture({ [field]: 1 }); cleanups.push(f.cleanup);
    const m = f.manifest(); m.budget[field] = 2;
    await expect(f.raw(m, f.worker.invite())).rejects.toThrow('exceeds worker limit');
    expect(f.execute).not.toHaveBeenCalled(); expect(f.review.list()).toEqual([]);
    expect(f.store.connectionState(f.requester.did)).toBe('none');
  });
it.each(['accessMode','openPolicy','allowAnyRequester'] as const)('explicitly rejects retired JS option %s', key => {
  const f = admissionFixture(); cleanups.push(f.cleanup);
  expect(() => new WorkerNode({ ...f.worker.options, [key]: undefined })).toThrow('ACCESS_MODE_REMOVED');
  expect(() => createSignedAgentCard({ name: 'Peer', agentDid: f.owner.did, relayEndpoint: 'https://relay.example', skills: [], [key]: {} }, f.owner))
    .toThrow('ACCESS_MODE_REMOVED');
  expect(() => new RequesterClient({ ...f.client.options, [key]: undefined })).toThrow('ACCESS_MODE_REMOVED');
  const retired = { allowedRequesterDids: [f.requester.did], [key]: undefined };
  expect(() => evaluateContractAcceptance(retired, {})).toThrow('ACCESS_MODE_REMOVED');
  expect(() => new PolicyAutoApprovalProvider(f.owner, undefined, { acceptance: retired })).toThrow('ACCESS_MODE_REMOVED');
  expect(() => discoverAgentCards([], { [key]: undefined })).toThrow('ACCESS_MODE_REMOVED');
});
it('verifies historical policy bytes without applying retired validation', () => {
  const f = admissionFixture(); cleanups.push(f.cleanup);
  const old = signPayload({ ...f.worker.agentCard.payload, accessMode: 'open', openPolicy: { retired: -1 } }, f.owner);
  expect(verifySignedAgentCard(old)).toBe(true);
  expect(verifySignedAgentCard({ ...old, payload: Object.assign({}, old.payload, { openPolicy: {} }) })).toBe(false);
});
