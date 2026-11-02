// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createContract, createSignedAgentCard, generateKeyPair, loadSchema, schemaRegistry,
  signPayload, validateManifest, validateSchema, verifyContract, verifySignedAgentCard,
} from '../packages/core/src/index.js';
import { buildTaskManifest } from '../packages/runtime/src/index.js';
import { BilateralLedger, verifyAudit } from '../packages/ledger/src/index.js';

const instant = Date.parse('2030-01-01T00:00:00.000Z');
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(instant); });
afterEach(() => vi.useRealTimers());
it.each(['0.1.0', '0.2.0'])('validates and contracts a %s manifest through both registry paths', protocolVersion => {
  const requester = generateKeyPair(), worker = generateKeyPair();
  const manifest = { ...buildTaskManifest({ ownerDid: requester.did, workerDid: worker.did, title: 'Transform', description: 'Return JSON' }), protocolVersion };
  expect(() => validateManifest(manifest)).not.toThrow();
  expect(() => validateSchema('task-manifest', manifest)).not.toThrow();
  expect(() => validateSchema('task-manifest.' + protocolVersion, manifest)).not.toThrow();
  expect(verifyContract(createContract(manifest, signPayload(manifest, requester), worker))).toBe(true);
  expect(() => validateManifest({ ...manifest, channel: {} })).toThrow('SCHEMA_VIOLATION');
  expect(() => validateManifest({ ...manifest, taskId: 'incorrect' })).toThrow('SCHEMA_VIOLATION');
  vi.setSystemTime(instant + 181 * 86_400_000);
  expect(() => validateManifest(manifest)).not.toThrow();
});
it('preserves the 0.1.0 schema ID and default sends while selecting explicit versions', () => {
  const key = generateKeyPair();
  expect(buildTaskManifest({ ownerDid: key.did, workerDid: key.did, title: 'Default', description: 'Default' }).protocolVersion).toBe('0.1.0');
  expect(loadSchema('task-manifest.0.1.0').$id).toBe('https://acp-spec.local/schemas/v0.1/task-manifest.schema.json');
  expect(schemaRegistry().getSchema('https://acp-spec.local/schemas/v0.1/task-manifest.schema.json')).toBe(schemaRegistry().getSchema('task-manifest.0.1.0'));
  for (const value of [{ protocolVersion: '0.3.0' }, { protocolVersion: null }, { protocolVersion: 2 }])
    expect(() => validateManifest(value)).toThrow('PROTOCOL_VERSION_UNSUPPORTED');
  for (const value of [{}, null, [], { protocolVersion: '0.2.0' }])
    expect(() => validateManifest(value)).toThrow('SCHEMA_VIOLATION');
});
it.each(['../task-manifest', 'task-manifest/0.2.0', 'task-manifest.0.3.0', 'unknown', 'task-manifest\\0.2.0'])('rejects unregistered schema name %s', name => {
  expect(() => loadSchema(name)).toThrow('INVALID_SCHEMA_NAME');
  expect(() => validateSchema(name, {})).toThrow('INVALID_SCHEMA_NAME');
});
it('covers signed receive capabilities and task types in the published card schema', () => {
  const owner = generateKeyPair(), agent = generateKeyPair();
  const options = { agentDid: agent.did, agentKey: agent, name: 'Worker', relayEndpoint: 'https://relay.example',
    skills: [{ id: 'json', name: 'JSON', taskTypes: ['transform'] }], accessMode: 'open' as const,
    openPolicy: { maxInputTokens: 10 }, protocolVersions: ['0.2.0', '0.1.0', '3.0.0-preview.1'] };
  const card = createSignedAgentCard(options, owner);
  expect(verifySignedAgentCard(card, instant)).toBe(true);
  expect(() => validateSchema('agent-card', card)).not.toThrow();
  card.payload.protocolVersions!.pop();
  expect(verifySignedAgentCard(card, instant)).toBe(false);
  const legacy = createSignedAgentCard({ ...options, protocolVersions: undefined }, owner);
  expect(legacy.payload).not.toHaveProperty('protocolVersions');
  expect(() => validateSchema('agent-card', legacy)).not.toThrow();
  const example = JSON.parse(readFileSync('spec/examples/protocol-versions/sample-agent-card.json', 'utf8'));
  expect(verifySignedAgentCard(example, instant)).toBe(true);
  expect(() => validateSchema('agent-card', example)).not.toThrow();
});
it.each([[], ['0.2.0', '0.2.0'], [''], ['current'], ['0.2.0\n'], ['1'.repeat(65) + '.0.0'], Array.from({ length: 17 }, (_, i) => `${i}.0.0`)]
  .map(protocolVersions => ({ protocolVersions })))('rejects malformed card version declarations $protocolVersions', ({ protocolVersions }) => {
  const owner = generateKeyPair();
  const card = createSignedAgentCard({ agentDid: owner.did, name: 'Worker', relayEndpoint: 'https://relay.example', skills: [] }, owner);
  const invalid = signPayload({ ...card.payload, protocolVersions }, owner);
  expect(verifySignedAgentCard(invalid, instant)).toBe(false);
  expect(() => validateSchema('agent-card', invalid)).toThrow('SCHEMA_VIOLATION');
  expect(() => createSignedAgentCard({ ...card.payload, protocolVersions }, owner)).toThrow('INVALID_AGENT_CARD');
});
it('verifies unchanged legacy audit evidence at simulated day 181', () => {
  const requester = generateKeyPair(), worker = generateKeyPair();
  const manifest = buildTaskManifest({ ownerDid: requester.did, workerDid: worker.did, title: 'Historical', description: 'Historical' });
  const ledger = new BilateralLedger(manifest.taskId, [requester.did, worker.did]);
  ledger.append('PROPOSE', JSON.parse(JSON.stringify({ manifest })), requester, worker);
  const bundle = ledger.bundle(requester, worker), bytes = JSON.stringify(bundle);
  vi.setSystemTime(instant + 181 * 86_400_000);
  expect(verifyAudit(JSON.parse(bytes)).valid).toBe(true);
  expect(JSON.stringify(bundle)).toBe(bytes);
});
