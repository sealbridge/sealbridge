// SPDX-License-Identifier: Apache-2.0
import {
  AgentCard, Task, Message, Artifact, TaskState, Role, A2A_PROTOCOL_VERSION,
} from '@a2a-js/sdk';
import { signEnvelope, verifyEnvelope } from '@acp/core';
import type { Json, KeyPair, SignedEnvelope, State } from '@acp/core';
export type { AgentCard, Task, Message, Artifact } from '@a2a-js/sdk';
// SDK-native helper; the relay's discovery projection is core.toA2AAgentCard.
export function agentCard(name: string, url: string): AgentCard {
  return AgentCard.fromJSON({
    name,
    description: 'Sealbridge owner gateway',
    supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION }],
    version: '0.5.0',
    capabilities: { streaming: false },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'acp-task',
        name: 'Contract-bound collaboration',
        description: 'Signed contracts and capability-constrained execution',
        tags: ['acp'],
      },
    ],
  });
}
const states: Record<State, TaskState> = {
  PROPOSED: TaskState.TASK_STATE_SUBMITTED,
  ACCEPTED: TaskState.TASK_STATE_SUBMITTED,
  IN_PROGRESS: TaskState.TASK_STATE_WORKING,
  DELIVERED: TaskState.TASK_STATE_INPUT_REQUIRED,
  VERIFY_ACCEPT: TaskState.TASK_STATE_INPUT_REQUIRED,
  VERIFY_REJECT: TaskState.TASK_STATE_REJECTED,
  SETTLED: TaskState.TASK_STATE_COMPLETED,
  CANCELLED: TaskState.TASK_STATE_CANCELED,
  DISPUTED: TaskState.TASK_STATE_INPUT_REQUIRED,
};
export function a2aTask(taskId: string, state: State, data?: Record<string, unknown>): Task {
  // The SDK codecs supply the 1.x model defaults without inventing a status message or time.
  return Task.fromJSON({
    id: taskId,
    contextId: taskId,
    status: { state: states[state] },
    ...(data
      ? { artifacts: [{ artifactId: taskId + '-report', parts: [{ data }] }] }
      : {}),
  });
}
export function a2aMessage(
  taskId: string,
  messageId: string,
  data: Record<string, unknown>,
): Message {
  return Message.fromJSON({
    messageId,
    taskId,
    contextId: taskId,
    role: Role.ROLE_AGENT,
    parts: [{ data }],
  });
}
export function wrapA2A(
  wire: Task | Message | Artifact,
  taskId: string,
  recipientDid: string,
  seq: number,
  key: KeyPair,
): SignedEnvelope {
  // Sign protocol JSON, not the protobuf model (numeric enums, oneofs and undefined fields).
  const payload = 'id' in wire
    ? Task.toJSON(wire)
    : 'messageId' in wire ? Message.toJSON(wire) : Artifact.toJSON(wire);
  return signEnvelope(
    { taskId, recipientDid, seq, eventType: 'A2A', payload: payload as Json },
    key,
  );
}
export function unwrapA2A(
  envelope: SignedEnvelope,
  recipientDid: string,
): Task | Message | Artifact {
  if (!verifyEnvelope(envelope, recipientDid) || envelope.payload.eventType !== 'A2A')
    throw new Error('INVALID_A2A_ENVELOPE');
  const p = envelope.payload.payload;
  if (!p || typeof p !== 'object' || Array.isArray(p))
    throw new Error('INVALID_A2A_WIRE');
  // A2A 1.0 removes the top-level kind discriminator.
  if ('id' in p) {
    if (p.id !== envelope.payload.taskId || !p.status) throw new Error('INVALID_A2A_TASK');
    return Task.fromJSON(p);
  }
  if ('messageId' in p) {
    if (p.taskId !== envelope.payload.taskId) throw new Error('INVALID_A2A_MESSAGE');
    return Message.fromJSON(p);
  }
  if ('artifactId' in p) return Artifact.fromJSON(p);
  throw new Error('INVALID_A2A_WIRE');
}
