// SPDX-License-Identifier: Apache-2.0
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { SandboxAgentAdapter } from '../packages/adapters/src/index.js';
import {
  AcpMcpServer,
  WorkerNode,
  RequesterClient,
  PolicyAutoApprovalProvider,
} from '../packages/runtime/src/index.js';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createContract,
  generateKeyPair,
  signApproval,
  signEnvelope,
  signPayload,
  validateManifest,
} from '../packages/core/src/index.js';
import type { Json } from '../packages/core/src/index.js';
import {
  ApprovalGate,
  buildTaskManifest,
  createDelivery,
  VerificationEngine,
} from '../packages/runtime/src/index.js';

const owner = generateKeyPair(),
  worker = generateKeyPair();

async function verifyIsolation(
  required: string,
  effective?: string,
  attestationRequired = true,
  fallback = false,
  omitAttestation = false,
  requireIsolatedExecution = false,
) {
  const manifest = buildTaskManifest({
    ownerDid: owner.did,
    workerDid: worker.did,
    title: 'Isolation regression',
    description: 'Verify the signed execution level',
  });
  manifest.sandboxPolicy.isolationLevel = required;
  manifest.sandboxPolicy.allowSubprocessFallback = fallback;
  manifest.verification.requireExecutionAttestation = attestationRequired;
  validateManifest(manifest);
  const contract = createContract(manifest, signPayload(manifest, owner), worker);
  const usage = signPayload(
    {
      type: 'UsageReceipt' as const,
      taskId: manifest.taskId,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCalls: 0,
      wallTimeMs: 0,
      halted: false,
    },
    worker,
  );
  const delivery = createDelivery(
    manifest.taskId,
    contract.contractDigest,
    {},
    usage,
    worker,
    effective === undefined ? undefined : { effectiveIsolationLevel: effective },
  );
  if (omitAttestation) Reflect.deleteProperty(delivery, 'attestation');
  const envelope = signEnvelope(
    {
      taskId: manifest.taskId,
      recipientDid: owner.did,
      seq: 0,
      eventType: 'DELIVER',
      payload: delivery as unknown as Json,
    },
    worker,
  );
  const approval = vi.fn(async () =>
    signApproval(manifest.taskId, 'final_verification', delivery, owner),
  );
  const result = await new VerificationEngine({
    allowUnencryptedEnvelopes: true,
    requireIsolatedExecution,
  }).verify(
    contract,
    envelope,
    new ApprovalGate(owner.did, { requiredGates: [], autoApprove: [] }),
    approval,
  );
  return { result, approval };
}

describe('R1 verifier isolation', () => {
  it.each(['0.1.0', '0.2.0'])(
    'covers every isolation level in protocol %s (new levels need an explicit policy)',
    (version) => {
      const schema = JSON.parse(
        readFileSync(
          new URL(`../spec/task-manifest.${version}.schema.json`, import.meta.url),
          'utf8',
        ),
      );
      expect(schema.properties.sandboxPolicy.properties.isolationLevel.enum.slice().sort()).toEqual(
        ['subprocess_restricted', 'wasm', 'oci_container', 'microvm'].sort(),
      );
    },
  );

  it.each(['host_adapter', 'future_isolation', 'constructor', '__proto__'])(
    'rejects unknown contract level %s at contract creation',
    (level) => {
      const manifest = buildTaskManifest({
        ownerDid: owner.did,
        workerDid: worker.did,
        title: 'Unknown',
        description: 'Fail closed',
      });
      manifest.sandboxPolicy.isolationLevel = level;
      expect(() => createContract(manifest, signPayload(manifest, owner), worker)).toThrow();
    },
  );

  it.each(['subprocess_restricted', 'wasm', 'oci_container', 'microvm'])(
    'protocol accepts %s contracts',
    (level) => {
      const manifest = buildTaskManifest({
        ownerDid: owner.did,
        workerDid: worker.did,
        title: 'Levels',
        description: 'Schema',
      });
      manifest.sandboxPolicy.isolationLevel = level;
      expect(() => validateManifest(manifest)).not.toThrow();
    },
  );

  it.each([
    ['microvm', 'host_adapter'],
    ['microvm', 'subprocess_restricted'],
    ['microvm', 'oci_container'],
    ['microvm', 'wasm'],
    ['microvm', undefined],
    ['wasm', 'host_adapter'],
    ['oci_container', 'wasm'],
    ['wasm', 'subprocess_restricted'],
    ['wasm', undefined],
    ['subprocess_restricted', 'future_isolation'],
    ['microvm', 'future_isolation'],
    ['microvm', 'constructor'],
    ['microvm', '__proto__'],
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
    expect(
      (await verifyIsolation('oci_container', 'future_isolation', !optOut, optOut)).result.accepted,
    ).toBe(false);
  });

  it.each([undefined, 'host_adapter', 'workspace_process', 'host_http_adapter', 'mcp_proxy'])(
    'requires an explicit non-host level: %s',
    async (effective) => {
      const strict = await verifyIsolation(
        'subprocess_restricted',
        effective,
        true,
        false,
        false,
        true,
      );
      expect(strict.result.reason).toBe('Error: ISOLATION_LEVEL_MISMATCH');
      expect(strict.approval).not.toHaveBeenCalled();
      for (const attestationRequired of [true, false])
        expect(
          (await verifyIsolation('subprocess_restricted', effective, attestationRequired)).result
            .accepted,
        ).toBe(true);
    },
  );
  it('enforces the minimum despite explicit fallback only when isolation is opted in', async () => {
    expect(
      (await verifyIsolation('oci_container', 'subprocess_restricted', true, true, false, true))
        .result.reason,
    ).toBe('Error: ISOLATION_LEVEL_MISMATCH');
    expect(
      (await verifyIsolation('oci_container', 'subprocess_restricted', true, true)).result.accepted,
    ).toBe(true);
  });
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])(
    'always rejects a missing attestation (isolation opt-in=%s, attestation flag=%s)',
    async (isolated, attestationRequired) => {
      const { result, approval } = await verifyIsolation(
        'subprocess_restricted',
        'subprocess_restricted',
        attestationRequired,
        false,
        true,
        isolated,
      );
      expect(result.accepted).toBe(false);
      expect(approval).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['subprocess_restricted', undefined],
    ['subprocess_restricted', 'host_adapter'],
    ['subprocess_restricted', 'workspace_process'],
    ['subprocess_restricted', 'host_http_adapter'],
    ['subprocess_restricted', 'mcp_proxy'],
    ['subprocess_restricted', 'subprocess_restricted'],
    ['wasm', 'wasm'],
    ['wasm', 'oci_container'],
    ['wasm', 'microvm'],
    ['oci_container', 'microvm'],
    ['microvm', 'microvm'],
  ])('accepts compatible %s contract with %s execution', async (required, effective) => {
    expect((await verifyIsolation(required!, effective)).result.accepted).toBe(true);
  });
});

it.each([
  ['host', undefined, true],
  ['host', false, true],
  ['host', true, false],
  ['sandbox', true, true],
] as const)(
  'verifies a real %s backend with isolation opt-in=%s',
  async (kind, isolated, accepted) => {
    const relay = new InMemoryRelay();
    const workerNode = new WorkerNode({
      owner: worker,
      relay,
      timeoutMs: 5000,
      checkPeer: () => 'trusted',
      autoAccept: { version: 1, enabled: true, from: 'anyone', work: 'write', limits: {} },
      approvalProvider: new PolicyAutoApprovalProvider(worker),
      adapter:
        kind === 'sandbox'
          ? new SandboxAgentAdapter()
          : {
              id: 'host',
              name: 'Host',
              skills: [],
              executeTask: async (context) => context.input,
            },
    });
    const running = Promise.allSettled([workerNode.start({ once: true })]);
    const manifest = buildTaskManifest({
      ownerDid: owner.did,
      workerDid: worker.did,
      title: 'Runner',
      description: 'Real runner regression',
    });
    const requester = new RequesterClient({
      owner,
      relay,
      timeoutMs: 5000,
      approvalProvider: new PolicyAutoApprovalProvider(owner),
    });
    try {
      const pending = requester.delegate({
        to: workerNode.invite(),
        title: 'Runner',
        description: 'Real runner regression',
        input: { ok: true },
        manifest,
        ...(isolated === undefined ? {} : { requireIsolatedExecution: isolated }),
      });
      if (accepted) {
        expect((await pending).state).toBe('SETTLED');
        expect((await running)[0].status).toBe('fulfilled');
      } else {
        await expect(pending).rejects.toThrow('ISOLATION_LEVEL_MISMATCH');
        expect((await running)[0].status).toBe('rejected');
      }
    } finally {
      workerNode.stop();
      await running;
    }
  },
);

it.each([
  ['sdk', false],
  ['sdk', true],
  ['mcp', false],
  ['mcp', true],
] as const)('propagates %s fan-out requester isolation opt-in=%s', async (api, isolated) => {
  const relay = new InMemoryRelay();
  const node = new WorkerNode({
    owner: worker,
    relay,
    timeoutMs: 5000,
    checkPeer: () => 'trusted',
    autoAccept: { version: 1, enabled: true, from: 'anyone', work: 'write', limits: {} },
    approvalProvider: new PolicyAutoApprovalProvider(worker),
    adapter: {
      id: 'host',
      name: 'Host',
      skills: [],
      executeTask: async (context) => context.input,
    },
  });
  const running = Promise.allSettled([node.start({ once: true })]);
  const request = {
    workers: [{ workerDid: worker.did, inviteToken: node.invite() }],
    mode: 'race' as const,
    title: 'Host fan-out',
    description: 'Opt-in propagation',
    input: { ok: true },
    ...(isolated ? { requireIsolatedExecution: true } : {}),
  };
  const server = new AcpMcpServer({
    owner,
    relay,
    approvalProvider: new PolicyAutoApprovalProvider(owner),
  });
  try {
    if (api === 'sdk') {
      const client = new RequesterClient({
        owner,
        relay,
        timeoutMs: 5000,
        approvalProvider: new PolicyAutoApprovalProvider(owner),
      });
      const pending = client.delegateMulti(request);
      if (isolated) await expect(pending).rejects.toThrow('RACE_FAILED');
      else expect((await pending).status).toBe('SETTLED');
    } else {
      const response = await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'acp_delegate_multi', arguments: request },
      });
      expect(JSON.stringify(response)).toContain(isolated ? 'RACE_FAILED' : 'SETTLED');
    }
    expect((await running)[0].status).toBe(isolated ? 'rejected' : 'fulfilled');
  } finally {
    node.stop();
    server.stopDelivery();
    await running;
  }
});
