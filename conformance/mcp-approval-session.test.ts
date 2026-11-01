// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { generateKeyPair, signApproval } from '../packages/core/src/index.js';
import { verifyAudit } from '../packages/ledger/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { AcpMcpServer, PolicyAutoApprovalProvider, RequesterClient, WorkerNode } from '../packages/runtime/src/index.js';
import { body, deferred, form, harness, initialize, toolCall } from './mcp-approval-helpers.js';

function worker(relay: InMemoryRelay) {
  const owner = generateKeyPair();
  const policy = new PolicyAutoApprovalProvider(owner);
  const approve = vi.spyOn(policy, 'approve');
  const execute = vi.fn(async (context) => ({ echoed: context.input }));
  const node = new WorkerNode({ owner, relay, relayUrl: 'https://relay.example',
    approvalProvider: policy,
    adapter: { id: 'echo', name: 'Echo', skills: [], executeTask: execute },
  });
  return { node, approve, execute };
}
const accept = (id: string) => ({ jsonrpc: '2.0', id, result: { action: 'accept', content: { approved: true } } });
const review = (message: any) => JSON.parse(message.params.message.split('\n').slice(1).join('\n'));

describe('resolved MCP approval sessions', () => {
  it('waits for separate send and final decisions, then settles a valid bilateral audit', async () => {
    const relay = new InMemoryRelay();
    const owner = generateKeyPair();
    const remote = worker(relay);
    const send = vi.spyOn(relay, 'send');
    const running = remote.node.start();
    const h = harness({ owner, relay, requireInteractiveApproval: true });
    try {
      await initialize(h, { elicitation: { form: {} } });
      h.send(toolCall('task', { inviteToken: remote.node.invite(), title: 'Echo', description: 'Return the JSON', input: { n: 42 } }));
      const outbound = await form(h);
      const action = review(outbound);
      expect(action).toMatchObject({ gate: 'external_side_effect', target: {
        fanOut: 1, input: { n: 42 }, relay: 'injected transport',
        manifest: { taskId: action.taskId, requester: { ownerDid: owner.did }, worker: { ownerDid: remote.node.options.owner.did } },
      } });
      expect(action.target.manifest.budget.maxWallClockSeconds).toBe(60);
      expect(action.target.manifest.deadline).toBeDefined();
      expect(outbound.params.message).not.toContain('acp-invite:');
      expect(send).not.toHaveBeenCalled();
      expect(remote.approve).not.toHaveBeenCalled();
      h.send(accept(outbound.id));
      h.send(accept(outbound.id)); // Duplicate consent never starts another session.
      const final = await form(h, 1);
      expect(review(final)).toMatchObject({ taskId: action.taskId, gate: 'final_verification',
        target: { artifact: { payload: { data: { echoed: { n: 42 } } } } },
        details: { manifest: action.target.manifest },
      });
      const events = () => send.mock.calls.map(([envelope]) => envelope.payload.eventType);
      expect(events().filter((type) => type === 'PROPOSE')).toHaveLength(1);
      expect(events()).not.toContain('VERIFY_ACCEPT');
      expect(events()).not.toContain('SETTLED');
      expect(remote.approve).toHaveBeenCalledWith(expect.objectContaining({ gate: 'contract_acceptance' }));
      expect(remote.execute).toHaveBeenCalledTimes(1);
      h.send(accept(final.id));
      const result = body(await h.next((m) => m.id === 'task'));
      expect(result.status).toBe('SETTLED');
      expect(result.auditBundle.valid).toBe(true);
      expect(result.taskId).toBe(action.taskId);
      expect(events()).toContain('VERIFY_ACCEPT');
      expect(events()).toContain('SETTLED');
    } finally { await h.close(); remote.node.stop(); await running; }
  });

  it('requires distinct final consent after execution', async () => {
    const relay = new InMemoryRelay();
    const remote = worker(relay);
    const running = remote.node.start();
    const send = vi.spyOn(relay, 'send');
    const h = harness({ owner: generateKeyPair(), relay, requireInteractiveApproval: true });
    try {
      await initialize(h, { elicitation: {} });
      h.send(toolCall('denied-final', { inviteToken: remote.node.invite(), title: 'Echo', description: 'Review final result', input: {} }));
      h.send(accept((await form(h)).id));
      const final = await form(h, 1);
      h.send({ jsonrpc: '2.0', id: final.id, result: { action: 'accept', content: { approved: false } } });
      expect(body(await h.next((m) => m.id === 'denied-final')).error).toContain('APPROVAL_REJECTED');
      expect(remote.execute).toHaveBeenCalledTimes(1);
      const events = send.mock.calls.map(([envelope]) => envelope.payload.eventType);
      expect(events).not.toContain('VERIFY_ACCEPT');
      expect(events).not.toContain('SETTLED');
    } finally { await h.close(); remote.node.stop(); await running; }
  });

  it('checks a custom outbound receipt against the resolved owner and action', async () => {
    const relay = new InMemoryRelay();
    const owner = generateKeyPair();
    const other = generateKeyPair();
    const send = vi.spyOn(relay, 'send');
    const server = new AcpMcpServer({ owner, relay, approvalProvider: {
      async approve(request) { return signApproval(request.taskId, request.gate, request.target, other); },
    } });
    const response = await server.handle(toolCall('wrong-owner', {
      workerDid: other.did, title: 'Echo', description: 'Review this task', input: {},
    }));
    expect(body(response).error).toBe('APPROVAL_REJECTED');
    expect(send).not.toHaveBeenCalled();
  });

  it('freezes the reviewed input, schema and effective manifest through settlement', async () => {
    const relay = new InMemoryRelay();
    const owner = generateKeyPair();
    const remote = worker(relay);
    const running = remote.node.start();
    const entered = deferred<void>();
    const decision = deferred<void>();
    const input = { n: 1 };
    const budget = { maxOutputTokens: 30 };
    const outputSchema = { type: 'object' };
    const client = new RequesterClient({ owner, relay, approvalProvider: new PolicyAutoApprovalProvider(owner) });
    const result = client.delegate({
      to: remote.node.invite(), title: 'Frozen', description: 'Review exact values', input, budget, outputSchema,
      beforePropose: async (action) => {
        expect(Object.isFrozen(action.manifest.budget)).toBe(true);
        expect(Object.isFrozen(action.input)).toBe(true);
        expect(action.manifest.budget.maxOutputTokens).toBe(30);
        entered.resolve(); await decision.promise;
        expect(action.input).toEqual({ n: 1 });
      },
    });
    try {
      await entered.promise;
      input.n = 2; budget.maxOutputTokens = 99; outputSchema.type = 'string';
      decision.resolve();
      const settled = await result;
      expect(settled.deliverable).toEqual({ echoed: { n: 1 } });
      expect(verifyAudit(settled.bundle).valid).toBe(true);
    } finally { remote.node.stop(); await running; }
  });

  it('rechecks invite expiry after review without transmitting a proposal', async () => {
    const relay = new InMemoryRelay();
    const remote = worker(relay);
    const owner = generateKeyPair();
    const send = vi.spyOn(relay, 'send');
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const client = new RequesterClient({ owner, relay });
    try {
      await expect(client.delegate({
        to: remote.node.invite(3600), title: 'Expires', description: 'Wait for expiry', input: {},
        // The manifest remains valid longer than the one-hour invitation.
        taskTimeoutMs: 7200000,
        beforePropose: async () => { clock.mockReturnValue(now + 3600001); },
      })).rejects.toThrow(/INVITE_EXPIRED/);
      expect(send).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it('queues one approval per multi-worker recipient with total fan-out disclosed', async () => {
    const relay = new InMemoryRelay();
    const remotes = [worker(relay), worker(relay)];
    const send = vi.spyOn(relay, 'send');
    const h = harness({ owner: generateKeyPair(), relay, requireInteractiveApproval: true });
    try {
      await initialize(h, { elicitation: {} });
      h.send(toolCall('multi', {
        mode: 'race', title: 'Both', description: 'Review both recipients', input: {},
        workers: remotes.map((remote) => ({ workerDid: remote.node.options.owner.did, inviteToken: remote.node.invite() })),
      }, 'acp_delegate_multi'));
      for (let index = 0; index < 2; index++) {
        const pending = await form(h, index);
        expect(review(pending).target.fanOut).toBe(2);
        expect(h.messages.filter((m) => m.method === 'elicitation/create')).toHaveLength(index + 1);
        h.send({ jsonrpc: '2.0', id: pending.id, result: { action: 'decline' } });
      }
      expect(body(await h.next((m) => m.id === 'multi')).error).toBe('APPROVAL_REJECTED');
      expect(send).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it('rejects an oversized final review without accepting or settling the delivery', async () => {
    const relay = new InMemoryRelay();
    const remote = worker(relay);
    const running = remote.node.start();
    const send = vi.spyOn(relay, 'send');
    const h = harness({ owner: generateKeyPair(), relay, requireInteractiveApproval: true });
    // The send review fits, but the result plus signed delivery metadata does not.
    remote.execute.mockImplementation(async () => ({ echoed: 'x'.repeat(65536) }));
    try {
      await initialize(h, { elicitation: {} });
      h.send(toolCall('large', { inviteToken: remote.node.invite(), title: 'Large', description: 'Review result', input: {} }));
      h.send(accept((await form(h)).id));
      expect(body(await h.next((m) => m.id === 'large')).error).toContain('APPROVAL_REVIEW_TOO_LARGE');
      const events = send.mock.calls.map(([envelope]) => envelope.payload.eventType);
      expect(events).not.toContain('VERIFY_ACCEPT');
      expect(events).not.toContain('SETTLED');
    } finally { await h.close(); remote.node.stop(); await running; }
  });
});
