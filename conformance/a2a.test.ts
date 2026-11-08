// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { AgentCard, Role, TaskState } from '@a2a-js/sdk';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
} from '@a2a-js/sdk/server';
import { agentCard, a2aTask, a2aMessage, wrapA2A, unwrapA2A } from '../packages/runtime/src/a2a.js';
import { createSignedAgentCard, generateKeyPair, signEnvelope } from '../packages/core/src/index.js';
import type { State } from '../packages/core/src/index.js';
import { createRelayFetchHandler, InMemoryRelay } from '../packages/relay/src/fetch.js';

const taskId = 'task_a2a00001';
const endpoint = 'https://gateway.example/a2a';

describe('A2A 1.0 SDK helpers', () => {
  it('advertises the native interface version and supplies SDK model defaults', () => {
    const card = agentCard('Alice', endpoint);
    expect(card.capabilities).toEqual({
      streaming: false, pushNotifications: undefined, extensions: [], extendedAgentCard: undefined,
    });
    expect(card.skills[0]).toEqual({
      id: 'acp-task', name: 'Contract-bound collaboration',
      description: 'Signed contracts and capability-constrained execution', tags: ['acp'],
      examples: [], inputModes: [], outputModes: [], securityRequirements: [],
    });
    expect(AgentCard.toJSON(card)).toEqual({
      name: 'Alice', description: 'Sealbridge owner gateway', version: '0.6.2',
      supportedInterfaces: [{ url: endpoint, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      capabilities: { streaming: false },
      defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
      skills: [{
        id: 'acp-task', name: 'Contract-bound collaboration',
        description: 'Signed contracts and capability-constrained execution', tags: ['acp'],
      }],
    });
  });

  it.each<[State, TaskState]>([
    ['PROPOSED', TaskState.TASK_STATE_SUBMITTED],
    ['ACCEPTED', TaskState.TASK_STATE_SUBMITTED],
    ['IN_PROGRESS', TaskState.TASK_STATE_WORKING],
    ['DELIVERED', TaskState.TASK_STATE_INPUT_REQUIRED],
    ['VERIFY_ACCEPT', TaskState.TASK_STATE_INPUT_REQUIRED],
    ['VERIFY_REJECT', TaskState.TASK_STATE_REJECTED],
    ['SETTLED', TaskState.TASK_STATE_COMPLETED],
    ['CANCELLED', TaskState.TASK_STATE_CANCELED],
    ['DISPUTED', TaskState.TASK_STATE_INPUT_REQUIRED],
  ])('preserves the meaning of Sealbridge state %s', (state, expected) => {
    const task = a2aTask(taskId, state);
    expect(task.status).toEqual({ state: expected, message: undefined, timestamp: undefined });
    expect(task.artifacts).toEqual([]);
  });

  it('signs protocol JSON and roundtrips SDK models across a JSON boundary', () => {
    const owner = generateKeyPair(), recipient = generateKeyPair();
    const task = a2aTask(taskId, 'SETTLED', { summary: 'done' });
    const message = a2aMessage(taskId, 'msg-1', { event: 'DELIVER' });
    expect(message.role).toBe(Role.ROLE_AGENT);
    const artifact = task.artifacts[0]!;
    const fixtures = [
      [task, {
        id: taskId, contextId: taskId, status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [{ artifactId: taskId + '-report', parts: [{ data: { summary: 'done' } }] }],
      }],
      [message, {
        messageId: 'msg-1', taskId, contextId: taskId, role: 'ROLE_AGENT',
        parts: [{ data: { event: 'DELIVER' } }],
      }],
      [artifact, { artifactId: taskId + '-report', parts: [{ data: { summary: 'done' } }] }],
    ] as const;
    for (const [model, json] of fixtures) {
      const envelope = wrapA2A(model, taskId, recipient.did, 0, owner);
      expect(envelope.payload.payload).toEqual(json);
      expect(unwrapA2A(JSON.parse(JSON.stringify(envelope)), recipient.did)).toEqual(model);
    }
    // Optional status details survive serialization when a caller supplies them.
    task.status!.message = message;
    task.status!.timestamp = '2026-11-04T00:00:00.000Z';
    expect(unwrapA2A(wrapA2A(task, taskId, recipient.did, 0, owner), recipient.did)).toEqual(task);
  });

  it('keeps signature, recipient and task bindings after removal of kind', () => {
    const owner = generateKeyPair(), recipient = generateKeyPair();
    for (const [model, error] of [
      [a2aTask('task_other001', 'SETTLED'), 'INVALID_A2A_TASK'],
      [a2aMessage('task_other001', 'msg-1', {}), 'INVALID_A2A_MESSAGE'],
    ] as const) {
      expect(() => unwrapA2A(wrapA2A(model, taskId, recipient.did, 0, owner), recipient.did))
        .toThrow(error);
    }
    const envelope = wrapA2A(a2aTask(taskId, 'SETTLED'), taskId, recipient.did, 0, owner);
    expect(() => unwrapA2A(envelope, owner.did)).toThrow('INVALID_A2A_ENVELOPE');
    envelope.payload.payload = {};
    expect(() => unwrapA2A(envelope, recipient.did)).toThrow('INVALID_A2A_ENVELOPE');
    for (const payload of [{}, [], null]) {
      const invalid = signEnvelope({ taskId, recipientDid: recipient.did, seq: 0, eventType: 'A2A', payload }, owner);
      expect(() => unwrapA2A(invalid, recipient.did)).toThrow('INVALID_A2A_WIRE');
    }
    const invalidTask = signEnvelope({ taskId, recipientDid: recipient.did, seq: 0,
      eventType: 'A2A', payload: { id: taskId } }, owner);
    expect(() => unwrapA2A(invalidTask, recipient.did)).toThrow('INVALID_A2A_TASK');
  });
});

describe('served relay discovery card (independent of SDK helpers)', () => {
  it('preserves the exact legacy card projection and existing well-known paths', async () => {
    const owner = generateKeyPair();
    const card = createSignedAgentCard({ name: 'Alice', agentDid: owner.did,
      relayEndpoint: 'https://relay.example', skills: [{ id: 'report', name: 'Report' }] }, owner);
    const relay = new InMemoryRelay();
    const handler = createRelayFetchHandler({ relay });
    expect((await handler(new Request('https://relay.example/.well-known/agent.json'))).status).toBe(404);
    relay.register(card);
    const response = await handler(new Request('https://relay.example/.well-known/agent.json'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      name: 'Alice', description: 'Sealbridge worker', url: 'https://relay.example', version: '0.2.0',
      protocolVersion: '0.3.0', capabilities: { streaming: true },
      defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
      skills: [{ id: 'report', name: 'Report', description: 'Report', tags: ['acp'] }],
      ownerDid: owner.did, agentDid: owner.did, relayEndpoint: 'https://relay.example',
      expiresAt: card.payload.expiresAt, costModes: ['worker_byok'], signedAgentCard: card,
    });
    for (const path of ['/.well-known/agent-card.json', '/.well-known/agent-card']) {
      expect((await handler(new Request('https://relay.example' + path))).status).toBe(404);
    }
    const rpcResponse = await handler(new Request('https://relay.example', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: taskId } }),
    }));
    expect(rpcResponse.status).toBe(404);
    expect(await rpcResponse.json()).toEqual({ error: 'NOT_FOUND' });
  });
});

// This is an SDK transport fixture, not a deployed Sealbridge JSON-RPC endpoint.
describe('A2A 1.0 JSON-RPC with Sealbridge task models', () => {
  async function fixture() {
    const context = new ServerCallContext({ requestedVersion: '1.0' });
    const store = new InMemoryTaskStore();
    await store.save(a2aTask(taskId, 'SETTLED', { summary: 'done' }), context);
    const unexpected = async () => { throw new Error('Unexpected executor call'); };
    const handler = new JsonRpcTransportHandler(new DefaultRequestHandler(
      agentCard('Alice', endpoint), store, { execute: unexpected, cancelTask: unexpected },
    ));
    return (method: string, params: unknown) => handler.handle({ jsonrpc: '2.0', id: 1, method, params }, context);
  }

  it('serializes a successful GetTask as native A2A JSON', async () => {
    const request = await fixture();
    expect(await request('GetTask', { id: taskId })).toEqual({ jsonrpc: '2.0', id: 1, result: {
      id: taskId, contextId: taskId, status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [{ artifactId: taskId + '-report', parts: [{ data: { summary: 'done' } }] }],
    } });
  });

  it('pins method, params and task-not-found errors including structured details', async () => {
    const request = await fixture();
    expect(await request('capture/unknown', {})).toEqual({ jsonrpc: '2.0', id: 1,
      error: { code: -32601, message: 'Invalid method.' } });
    for (const [params, code, message, reason] of [
      [null, -32602, 'Invalid method parameters.', 'INVALID_PARAMS'],
      [{ id: 'task_missing001' }, -32001, 'Task not found: task_missing001', 'TASK_NOT_FOUND'],
    ] as const) {
      expect(await request('GetTask', params)).toEqual({ jsonrpc: '2.0', id: 1, error: {
        code, message, data: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'a2a-protocol.org' }],
      } });
    }
  });
});
