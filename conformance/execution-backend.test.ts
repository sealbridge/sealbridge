// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { generateKeyPair } from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { PolicyAutoApprovalProvider, RequesterClient, WorkerNode } from '../packages/runtime/src/index.js';
import type { ExecutionBackend } from '../packages/runtime/src/index.js';
import type { Delivery } from '../packages/runtime/src/verifier.js';

it('uses the injected execution backend lifecycle and attests its isolation level', async () => {
  const alice = generateKeyPair(), bob = generateKeyPair(), relay = new InMemoryRelay();
  const calls: string[] = [];
  const backend: ExecutionBackend = {
    prepare: async () => { calls.push('prepare'); return 'fake-workspace'; },
    execute: async (adapter, context) => {
      calls.push('execute');
      expect(adapter.id).toBe('unused');
      expect(context.workspaceDir).toBe('fake-workspace');
      expect(context.signal.aborted).toBe(false);
      return { output: { backend: true }, effectiveIsolationLevel: 'microvm' };
    },
    cleanup: async workspace => { expect(workspace).toBe('fake-workspace'); calls.push('cleanup'); },
  };
  const executeTask = vi.fn(async () => null);
  const worker = new WorkerNode({ owner: bob, relay, checkPeer: () => 'trusted', timeoutMs: 5000,
    approvalProvider: new PolicyAutoApprovalProvider(bob), executionBackend: backend,
    adapter: { id: 'unused', name: 'unused', skills: [], executeTask } });
  const requester = new RequesterClient({ owner: alice, relay, timeoutMs: 5000,
    approvalProvider: new PolicyAutoApprovalProvider(alice) });
  const pending = worker.start({ once: true });
  try {
    const result = await requester.delegate({ to: worker.invite(), title: 'Backend',
      description: 'Exercise the injected execution backend', input: {} });
    const workerResult = await pending;
    expect(result.state).toBe('SETTLED');
    expect(result.deliverable).toEqual({ backend: true });
    const delivery = workerResult!.bundle.entries.find(entry => entry.body.eventType === 'DELIVER')!
      .body.payload as unknown as Delivery;
    expect(delivery.attestation.payload.effectiveIsolationLevel).toBe('microvm');
    expect(calls).toEqual(['prepare', 'execute', 'cleanup']);
    expect(executeTask).not.toHaveBeenCalled();
  } finally {
    worker.stop();
    await pending;
  }
});
