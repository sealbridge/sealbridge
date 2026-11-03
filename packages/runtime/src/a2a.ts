// SPDX-License-Identifier: Apache-2.0
import type { AgentCard, Task, Message, Artifact, TaskState } from '@a2a-js/sdk';
import { signEnvelope, verifyEnvelope } from '@acp/core';
import type { Json, KeyPair, SignedEnvelope, State } from '@acp/core';
export type { AgentCard, Task, Message, Artifact } from '@a2a-js/sdk';
export function agentCard(name: string, url: string): AgentCard {
  return {
    name,
    description: 'Sealbridge owner gateway',
    url,
    version: '0.3.0',
    protocolVersion: '0.3.0',
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
  };
}
const states: Record<State, TaskState> = {
  PROPOSED: 'submitted',
  ACCEPTED: 'submitted',
  IN_PROGRESS: 'working',
  DELIVERED: 'input-required',
  VERIFY_ACCEPT: 'input-required',
  VERIFY_REJECT: 'rejected',
  SETTLED: 'completed',
  CANCELLED: 'canceled',
  DISPUTED: 'input-required',
};
export function a2aTask(taskId: string, state: State, data?: Record<string, unknown>): Task {
  return {
    kind: 'task',
    id: taskId,
    contextId: taskId,
    status: { state: states[state] },
    ...(data
      ? { artifacts: [{ artifactId: taskId + '-report', parts: [{ kind: 'data', data }] }] }
      : {}),
  };
}
export function a2aMessage(
  taskId: string,
  messageId: string,
  data: Record<string, unknown>,
): Message {
  return {
    kind: 'message',
    messageId,
    taskId,
    contextId: taskId,
    role: 'agent',
    parts: [{ kind: 'data', data }],
  };
}
export function wrapA2A(
  wire: Task | Message | Artifact,
  taskId: string,
  recipientDid: string,
  seq: number,
  key: KeyPair,
): SignedEnvelope {
  return signEnvelope(
    { taskId, recipientDid, seq, eventType: 'A2A', payload: wire as unknown as Json },
    key,
  );
}
export function unwrapA2A(
  envelope: SignedEnvelope,
  recipientDid: string,
): Task | Message | Artifact {
  if (!verifyEnvelope(envelope, recipientDid) || envelope.payload.eventType !== 'A2A')
    throw new Error('INVALID_A2A_ENVELOPE');
  const p = envelope.payload.payload as unknown as Task | Message | Artifact;
  if (!p || typeof p !== 'object' || (!('kind' in p) && !('artifactId' in p)))
    throw new Error('INVALID_A2A_WIRE');
  if ('kind' in p && p.kind === 'task' && (p.id !== envelope.payload.taskId || !p.status))
    throw new Error('INVALID_A2A_TASK');
  if ('kind' in p && p.kind === 'message' && p.taskId !== envelope.payload.taskId)
    throw new Error('INVALID_A2A_MESSAGE');
  return p;
}
