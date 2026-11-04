// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { TaskState } from '@a2a-js/sdk';
import {
  ApprovalGate,
  QuotaMeter,
  MCPProxy,
  meteredProvider,
  a2aTask,
  a2aMessage,
  agentCard,
  wrapA2A,
  unwrapA2A,
  EnvelopeInbox,
} from '../packages/runtime/src/index.js';
import {
  generateKeyPair,
  signApproval,
  createCapability,
  signPayload,
  verifyContract,
  ContractMachine,
  signEnvelope,
} from '../packages/core/src/index.js';
import type { BudgetSpec, Gate, Json } from '../packages/core/src/index.js';
import { runSandbox, sanitizedEnvironment } from '../packages/sandbox/src/index.js';
import {
  InMemoryRelay,
  startLocalRelay,
  HttpRelayClient,
  WebSocketRelayClient,
} from '../packages/relay/src/index.js';
import { createSession } from '../examples/two-owner-demo/run-demo.js';
const owner = generateKeyPair(),
  other = generateKeyPair();
const budget: BudgetSpec = {
  costBearer: 'worker_byok',
  maxInputTokens: 3,
  maxOutputTokens: 2,
  maxToolInvocations: 1,
  maxWallClockSeconds: 1,
  onOverrun: 'request_hitl_amendment',
};
const policy = {
  requiredGates: [
    'contract_acceptance',
    'external_side_effect',
    'budget_increase',
    'redelegation',
    'final_verification',
  ] as Gate[],
  autoApprove: [],
};
describe('five explicit approval gates', () => {
  for (const gate of policy.requiredGates)
    it(gate + ' requires task, action and owner binding and rejects replay', () => {
      const engine = new ApprovalGate(owner.did, policy),
        task = 'task_approval1',
        target = { operation: gate };
      expect(() => engine.require(task, gate, target)).toThrow(/APPROVAL_REQUIRED/);
      expect(() =>
        engine.require(task, gate, target, signApproval(task, gate, target, other)),
      ).toThrow();
      expect(() =>
        engine.require(task, gate, target, signApproval(task, gate, target, owner, 'REJECTED')),
      ).toThrow();
      const receipt = signApproval(task, gate, target, owner);
      expect(engine.require(task, gate, target, receipt)).toEqual(receipt);
      expect(() => engine.require(task, gate, target, receipt)).toThrow();
    });
  it('forbids auto approval for side effects and budget increases', () => {
    expect(
      () =>
        new ApprovalGate(owner.did, { requiredGates: [], autoApprove: ['external_side_effect'] }),
    ).toThrow();
    expect(
      () => new ApprovalGate(owner.did, { requiredGates: [], autoApprove: ['budget_increase'] }),
    ).toThrow();
  });
});
describe('BYOK quota enforcement', () => {
  for (const [name, delta] of [
    ['input', [4, 0, 0]],
    ['output', [0, 3, 0]],
    ['tools', [0, 0, 2]],
  ] as const)
    it('halts immediately on ' + name, () => {
      const q = new QuotaMeter('task_quota001', budget, owner.did);
      try {
        expect(() => q.record(...delta)).toThrow(/BUDGET_EXCEEDED/);
        expect(q.controller.signal.aborted).toBe(true);
        const r = q.receipt(owner);
        expect(r.payload.halted).toBe(true);
        expect(r.payload.totalTokens).toBe(r.payload.inputTokens + r.payload.outputTokens);
        expect(() => q.record()).toThrow();
      } finally {
        q.close();
      }
    });
  it('tracks elapsed time and rejects negative accounting', () => {
    let now = 0;
    const q = new QuotaMeter('task_quota001', budget, owner.did, () => now);
    try {
      now = 1001;
      expect(() => q.record()).toThrow();
      expect(q.receipt(owner).payload.wallTimeMs).toBe(1001);
    } finally {
      q.close();
    }
    const r = new QuotaMeter('task_quota001', budget, owner.did);
    try {
      expect(() => r.record(-1)).toThrow(/INVALID_USAGE/);
    } finally {
      r.close();
    }
  });
  it('requires signed budget amendment for the exact old/new budget', () => {
    const q = new QuotaMeter('task_quota001', budget, owner.did);
    try {
      const next = { ...budget, maxInputTokens: 6 };
      const wrong = signApproval(q.taskId, 'budget_increase', {}, owner);
      expect(() => q.amend(next, wrong)).toThrow();
      const receipt = signApproval(q.taskId, 'budget_increase', q.amendmentTarget(next), owner);
      q.amend(next, receipt);
      q.record(5);
      expect(q.receipt(owner).payload.inputTokens).toBe(5);
      expect(() => q.amend(next, receipt)).toThrow();
    } finally {
      q.close();
    }
  });
  it('meters trusted provider deltas before releasing over-budget output', async () => {
    const q = new QuotaMeter('task_quota001', budget, owner.did);
    const seen: string[] = [];
    async function* provider() {
      yield { value: 'ok', inputTokens: 2, outputTokens: 1 };
      yield { value: 'over', inputTokens: 0, outputTokens: 2 };
    }
    try {
      await expect(
        (async () => {
          for await (const v of meteredProvider(q, provider())) seen.push(v);
        })(),
      ).rejects.toThrow(/BUDGET_EXCEEDED/);
      expect(seen).toEqual(['ok']);
    } finally {
      q.close();
    }
  });
});
describe('restricted subprocess and CapGuard', () => {
  const noTools = async () => {
    throw new Error('TOOL_DENIED');
  };
  it('omits host credentials and inherited runtime options', () => {
    expect(sanitizedEnvironment('/tmp/task')).toEqual({
      LANG: 'C.UTF-8',
      TZ: 'UTC',
      HOME: '/tmp/task',
      TMPDIR: '/tmp/task',
    });
  });
  it('does not expose Node, network or host functions', async () => {
    const r = await runSandbox({
      code: 'return [typeof process,typeof require,typeof fetch,typeof WebSocket,typeof global,typeof input];',
      timeoutMs: 2000,
      onTool: noTools,
    });
    expect(r).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'object']);
  });
  it('blocks constructor code generation escapes', async () => {
    await expect(
      runSandbox({
        code: "return callTool.constructor('return process')();",
        timeoutMs: 2000,
        onTool: noTools,
      }),
    ).rejects.toThrow(/Code generation/);
  });
  it('kills a non-cooperating infinite loop on timeout', async () => {
    await expect(
      runSandbox({ code: 'while(true){}', timeoutMs: 150, onTool: noTools }),
    ).rejects.toThrow(/TIMEOUT|timed out|EXIT/);
  });
  it('physically intercepts a subprocess tool call before executing a handler', async () => {
    let calls = 0;
    await expect(
      runSandbox({
        code: "return await callTool('docs/delete',{});",
        timeoutMs: 2000,
        onTool: async () => {
          calls++;
          throw new Error('CAPABILITY_VIOLATION');
        },
      }),
    ).rejects.toThrow(/CAPABILITY_VIOLATION/);
    expect(calls).toBe(1);
  });
  it('requires side-effect approval and quota before backend execution', async () => {
    const taskId = 'task_effect001',
      now = new Date().toISOString(),
      token = createCapability(
        {
          audience: other.did,
          taskId,
          resource: 'mcp://write/item',
          allowedTools: ['docs/write'],
          argConstraints: { 'docs/write': { type: 'object', additionalProperties: false } },
          maxCalls: 3,
          maxDepth: 0,
          notBefore: now,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
        owner,
      );
    const meter = new QuotaMeter(taskId, budget, other.did),
      gate = new ApprovalGate(owner.did, policy);
    let executed = 0;
    const proxy = new MCPProxy({
      chain: [token],
      context: { rootDid: owner.did, audience: other.did, taskId },
      backend: {
        callTool: async () => {
          executed++;
          return { content: [] };
        },
      },
      tools: { 'docs/write': { resource: () => token.payload.resource, readOnly: false } },
      gate,
      meter,
      isActive: () => true,
    });
    try {
      await expect(proxy.callTool('docs/write', {})).rejects.toThrow(/APPROVAL_REQUIRED/);
      expect(executed).toBe(0);
      await proxy.callTool(
        'docs/write',
        {},
        signApproval(taskId, 'external_side_effect', { name: 'docs/write', args: {} }, owner),
      );
      expect(executed).toBe(1);
      await expect(
        proxy.callTool(
          'docs/write',
          {},
          signApproval(taskId, 'external_side_effect', { name: 'docs/write', args: {} }, owner),
        ),
      ).rejects.toThrow(/BUDGET_EXCEEDED/);
      expect(executed).toBe(1);
    } finally {
      meter.close();
    }
  });
});
describe('contracts and three-stage requester verification', () => {
  it('checks bilateral contract signatures and rejects signed replay / wrong-role transition', async () => {
    const s = await createSession();
    try {
      expect(verifyContract(s.contract)).toBe(true);
      const bad = structuredClone(s.contract);
      bad.manifest.budget.maxOutputTokens++;
      expect(verifyContract(bad)).toBe(false);
      const machine = new ContractMachine(s.contract);
      const event = machine.event('ACCEPT', s.bob);
      machine.apply(event);
      expect(() => machine.apply(event)).toThrow();
      expect(() => machine.apply(machine.event('START', s.alice))).toThrow();
      expect(() => s.worker.transition('SETTLE')).toThrow(/GATED/);
    } finally {
      await s.close();
    }
  });
  it('stops at Stage 2 for schema and deterministic failures and at Stage 3 for missing approval', async () => {
    const s = await createSession();
    try {
      let d = s.deliver({ summary: 2 });
      let r = await s.verifier.verify(s.contract, d.envelope, s.requester.approvals);
      expect(r.stages).toEqual(['crypto_budget']);
      expect(r.reason).toContain('OUTPUT_SCHEMA');
      d = s.deliver({ summary: '', findings: [] });
      r = await s.verifier.verify(s.contract, d.envelope, s.requester.approvals);
      expect(r.reason).toContain('DETERMINISTIC_CHECK_FAILED');
      d = s.deliver({ summary: 'valid', findings: [] });
      r = await s.verifier.verify(s.contract, d.envelope, s.requester.approvals);
      expect(r.stages).toEqual(['crypto_budget', 'schema_isolated_check']);
      expect(r.reason).toContain('APPROVAL_REQUIRED');
      const approval = signApproval(s.manifest.taskId, 'final_verification', d.delivery, s.alice);
      r = await s.verifier.verify(s.contract, d.envelope, s.requester.approvals, approval);
      expect(r.accepted).toBe(true);
    } finally {
      await s.close();
    }
  });
  it('rejects unregistered checks and wrong worker signed delivery', async () => {
    const s = await createSession();
    try {
      const d = s.deliver({ summary: 'valid', findings: [] });
      const contract = structuredClone(s.contract);
      contract.manifest.verification.checks = [
        { checkId: 'chk_unknown', kind: 'deterministic_command', target: 'untrusted://command' },
      ];
      expect((await s.verifier.verify(contract, d.envelope, s.requester.approvals)).accepted).toBe(
        false,
      );
      const e = signEnvelope({ ...d.envelope.payload }, s.alice);
      expect((await s.verifier.verify(s.contract, e, s.requester.approvals)).accepted).toBe(false);
    } finally {
      await s.close();
    }
  });
});
describe('A2A and blind relay wire integration', () => {
  it('roundtrips AgentCard, Task, Message and Artifact SDK wire types in signed envelopes', () => {
    expect(agentCard('Alice', 'http://127.0.0.1:8080').skills[0].id).toBe('acp-task');
    const taskId = 'task_a2a00001';
    const task = a2aTask(taskId, 'SETTLED', { summary: 'done' }),
      message = a2aMessage(taskId, 'msg-1', { event: 'DELIVER' });
    for (const wire of [task, message, task.artifacts![0]])
      expect(unwrapA2A(wrapA2A(wire, taskId, other.did, 0, owner), other.did)).toEqual(wire);
    expect(task.status!.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });
  it('pins gateway sender, task and sequence independently of relay replay state', () => {
    const inbox = new EnvelopeInbox(other.did, owner.did, 'task_relay001');
    const e = signEnvelope(
      {
        taskId: 'task_relay001',
        recipientDid: other.did,
        seq: 0,
        eventType: 'PROPOSE',
        payload: {},
      },
      owner,
    );
    expect(inbox.receive(e)).toEqual(e);
    expect(() => inbox.receive(e)).toThrow(/REPLAYED/);
    expect(() => inbox.receive(signEnvelope({ ...e.payload, seq: 2 }, owner))).toThrow();
    expect(() => inbox.receive(signEnvelope({ ...e.payload, seq: 1 }, other))).toThrow();
    expect(() =>
      inbox.receive(signEnvelope({ ...e.payload, seq: 1, taskId: 'task_other000' }, owner)),
    ).toThrow();
  });
  it('rejects outer signature tampering and replay', () => {
    const relay = new InMemoryRelay(),
      e = signEnvelope(
        {
          taskId: 'task_relay001',
          recipientDid: other.did,
          seq: 0,
          eventType: 'PROPOSE',
          payload: {},
        },
        owner,
      );
    relay.send(e);
    expect(() => relay.send(e)).toThrow(/REPLAY/);
    expect(relay.receive(other.did)).toEqual(e);
    e.payload.seq++;
    expect(() => relay.send(e)).toThrow(/INVALID_ENVELOPE/);
  });
  for (const transport of ['http', 'websocket'] as const)
    it(transport + ' routes immutable envelopes and rejects corrupted signatures', async () => {
      const server = await startLocalRelay(),
        client =
          transport === 'http'
            ? new HttpRelayClient(server.url, other, { allowPrivateRelay: true })
            : new WebSocketRelayClient(server.wsUrl, other, { allowPrivateRelay: true });
      try {
        const e = signEnvelope(
          {
            taskId: 'task_relay001',
            recipientDid: other.did,
            seq: 0,
            eventType: 'PROPOSE',
            payload: { byte: 'x' },
          },
          owner,
        );
        await client.send(e);
        expect(await client.receive(other.did)).toEqual(e);
        expect(await client.receive(other.did)).toBeUndefined();
        e.payload.payload = { byte: 'y' };
        await expect(client.send(e)).rejects.toThrow();
      } finally {
        if (client instanceof WebSocketRelayClient) await client.close();
        await server.close();
      }
    });
});
