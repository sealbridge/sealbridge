// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContract, generateKeyPair, signApproval, signEnvelope, signPayload, validateManifest } from '../packages/core/src/index.js';
import type { Json } from '../packages/core/src/index.js';
import { ApprovalGate, buildTaskManifest, createDelivery, VerificationEngine } from '../packages/runtime/src/index.js';

const owner = generateKeyPair(), worker = generateKeyPair();

async function verifyIsolation(required: string, effective?: string, attestationRequired = true, fallback = false) {
  const manifest = buildTaskManifest({ ownerDid: owner.did, workerDid: worker.did,
    title: 'Isolation regression', description: 'Verify the signed execution level' });
  manifest.sandboxPolicy.isolationLevel = required;
  manifest.sandboxPolicy.allowSubprocessFallback = fallback;
  manifest.verification.requireExecutionAttestation = attestationRequired;
  validateManifest(manifest);
  const contract = createContract(manifest, signPayload(manifest, owner), worker);
  const usage = signPayload({ type: 'UsageReceipt' as const, taskId: manifest.taskId,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, toolCalls: 0, wallTimeMs: 0, halted: false }, worker);
  const delivery = createDelivery(manifest.taskId, contract.contractDigest, {}, usage, worker,
    effective === undefined ? undefined : { effectiveIsolationLevel: effective });
  const envelope = signEnvelope({ taskId: manifest.taskId, recipientDid: owner.did, seq: 0,
    eventType: 'DELIVER', payload: delivery as unknown as Json }, worker);
  const approval = vi.fn(async () => signApproval(manifest.taskId, 'final_verification', delivery, owner));
  const result = await new VerificationEngine({ allowUnencryptedEnvelopes: true }).verify(
    contract, envelope, new ApprovalGate(owner.did, { requiredGates: [], autoApprove: [] }), approval);
  return { result, approval };
}

describe('R1 verifier isolation', () => {
  it.each(['0.1.0', '0.2.0'])('covers every isolation level in protocol %s (new levels need an explicit policy)', (version) => {
    const schema = JSON.parse(readFileSync(new URL(`../spec/task-manifest.${version}.schema.json`, import.meta.url), 'utf8'));
    expect(schema.properties.sandboxPolicy.properties.isolationLevel.enum.slice().sort()).toEqual(
      ['subprocess_restricted', 'wasm', 'oci_container', 'microvm'].sort());
  });

  it.each(['host_adapter', 'future_isolation', 'constructor', '__proto__'])('rejects unknown contract level %s at contract creation', (level) => {
    const manifest = buildTaskManifest({ ownerDid: owner.did, workerDid: worker.did, title: 'Unknown', description: 'Fail closed' });
    manifest.sandboxPolicy.isolationLevel = level;
    expect(() => createContract(manifest, signPayload(manifest, owner), worker)).toThrow();
  });

  it.each(['subprocess_restricted', 'wasm', 'oci_container', 'microvm'])('protocol accepts %s contracts', (level) => {
    const manifest = buildTaskManifest({ ownerDid: owner.did, workerDid: worker.did, title: 'Levels', description: 'Schema' });
    manifest.sandboxPolicy.isolationLevel = level;
    expect(() => validateManifest(manifest)).not.toThrow();
  });

  it.each([
    ['microvm', 'host_adapter'], ['microvm', 'subprocess_restricted'], ['microvm', 'oci_container'],
    ['microvm', 'wasm'], ['microvm', undefined], ['wasm', 'host_adapter'], ['oci_container', 'wasm'],
    ['wasm', 'subprocess_restricted'], ['wasm', undefined],
    ['subprocess_restricted', 'future_isolation'], ['microvm', 'future_isolation'],
    ['microvm', 'constructor'], ['microvm', '__proto__'],
  ])('rejects %s contract with %s execution before owner approval', async (required, effective) => {
    const { result, approval } = await verifyIsolation(required!, effective);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('Error: ISOLATION_LEVEL_MISMATCH');
    expect(approval).not.toHaveBeenCalled();
  });

  it.each(['wasm', 'microvm'])('does not let legacy OCI opt-outs weaken %s', async (required) => {
    for (const effective of [undefined, 'host_adapter', 'subprocess_restricted']) {
      const { result } = await verifyIsolation(required, effective, false, true);
      expect(result.accepted).toBe(false);
    }
  });

  it.each([false, true])('rejects unknown OCI execution even with opt-out=%s', async (optOut) => {
    expect((await verifyIsolation('oci_container', 'future_isolation', !optOut, optOut)).result.accepted).toBe(false);
  });

  it.each([
    ['subprocess_restricted', undefined], ['subprocess_restricted', 'host_adapter'],
    ['subprocess_restricted', 'workspace_process'], ['subprocess_restricted', 'host_http_adapter'],
    ['subprocess_restricted', 'mcp_proxy'],
    ['subprocess_restricted', 'subprocess_restricted'], ['wasm', 'wasm'],
    ['wasm', 'oci_container'], ['wasm', 'microvm'], ['oci_container', 'microvm'], ['microvm', 'microvm'],
  ])('accepts compatible %s contract with %s execution', async (required, effective) => {
    expect((await verifyIsolation(required!, effective)).result.accepted).toBe(true);
  });
});
