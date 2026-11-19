// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import {
  generateKeyPair,
  signPayload,
  createContract,
  createCapability,
  signApproval,
  digest,
  signEnvelope,
  specDirectory,
} from '@acp/core';
import type { Json, TaskManifest, SignedEnvelope, CapabilityToken } from '@acp/core';
import { BilateralLedger, MemoryStore, JsonlStore, verifyAudit } from '@acp/ledger';
import type { AuditStore, AuditEntry, AuditBundle } from '@acp/ledger';
import {
  OwnerGateway,
  MCPProxy,
  VerificationEngine,
  createDelivery,
  connectMCPTools,
} from '@acp/runtime';
import type { OwnerPolicy } from '@acp/runtime';
import { InMemoryRelay } from '@acp/relay';

export async function createSession(auditDirectory?: string) {
  const alice = generateKeyPair(),
    bob = generateKeyPair();
  const manifest = JSON.parse(
    readFileSync(new URL('examples/sample-task-manifest.json', specDirectory), 'utf8'),
  ) as TaskManifest;
  delete manifest.signatures;
  manifest.requester = { ownerDid: alice.did, agentDid: alice.did, displayName: 'Alice' };
  manifest.worker = { ownerDid: bob.did, agentDid: bob.did, displayName: 'Bob' };
  manifest.createdAt = new Date().toISOString();
  manifest.deadline = new Date(Date.now() + 600000).toISOString();
  manifest.budget = {
    costBearer: 'worker_byok',
    maxInputTokens: 100,
    maxOutputTokens: 50,
    maxToolInvocations: 5,
    maxWallClockSeconds: 10,
    onOverrun: 'request_hitl_amendment',
  };
  manifest.sandboxPolicy = {
    isolationLevel: 'subprocess_restricted',
    networkAccess: 'none',
    filesystemScope: 'ephemeral_workspace_only',
  };
  manifest.verification.checks = [
    {
      checkId: 'chk_report',
      kind: 'deterministic_command',
      target: 'check://report',
      expectedExitCode: 0,
    },
  ];
  const argSchema = {
    type: 'object',
    required: ['uri'],
    additionalProperties: false,
    properties: { uri: { type: 'string', pattern: '^mcp://alice/docs/public/[a-z]+$' } },
  };
  manifest.permissions = {
    maxDelegationDepth: 1,
    grantedCapabilities: [
      {
        capabilityId: 'cap_read_docs_01',
        resource: 'mcp://alice/docs/public/*',
        allowedTools: ['docs/read'],
        argConstraints: argSchema,
        maxInvocations: 10,
        expiresAt: manifest.deadline,
      },
    ],
  };
  const proposal = signPayload(manifest, alice);
  const relay = new InMemoryRelay();
  relay.send(
    signEnvelope(
      {
        taskId: manifest.taskId,
        recipientDid: bob.did,
        seq: 0,
        eventType: 'PROPOSE',
        payload: proposal as unknown as Json,
      },
      alice,
    ),
  );
  const received = relay.receive(bob.did)!;
  const contract = createContract(
    manifest,
    received.payload.payload as unknown as typeof proposal,
    bob,
  );
  const alicePolicy = JSON.parse(
    readFileSync(new URL('../examples/two-owner-demo/alice-policy.json', specDirectory), 'utf8'),
  ) as OwnerPolicy;
  const bobPolicy = JSON.parse(
    readFileSync(new URL('../examples/two-owner-demo/bob-policy.json', specDirectory), 'utf8'),
  ) as OwnerPolicy;
  const requester = new OwnerGateway(alice, contract, alicePolicy),
    worker = new OwnerGateway(bob, contract, bobPolicy);
  worker.inbox.receive(received);
  const sendTransition = (
    event: string,
    transition: unknown,
    from: typeof requester,
    to: typeof requester,
    seq: number,
  ) => {
    relay.send(
      signEnvelope(
        {
          taskId: manifest.taskId,
          recipientDid: to.owner.did,
          seq,
          eventType: event,
          payload: transition as Json,
        },
        from.owner,
      ),
    );
    to.inbox.receive(relay.receive(to.owner.did)!);
  };
  const stores: AuditStore[] = auditDirectory
    ? [
        new JsonlStore(join(auditDirectory, 'alice.jsonl')),
        new JsonlStore(join(auditDirectory, 'bob.jsonl')),
      ]
    : [new MemoryStore(), new MemoryStore()];
  const mirror: AuditStore = {
    read: () => stores[0].read(),
    append: (e, c) => {
      for (const s of stores) s.append(e, c);
    },
    seal: (c) => {
      for (const s of stores) s.seal?.(c);
    },
  };
  const ledger = new BilateralLedger(manifest.taskId, [alice.did, bob.did], mirror);
  const record = (event: string, payload: Json) => ledger.append(event, payload, bob, alice);
  record('PROPOSE', proposal as unknown as Json);
  const acceptanceApproval = signApproval(
    manifest.taskId,
    'contract_acceptance',
    contract.contractDigest,
    bob,
  );
  const accepted = worker.accept(acceptanceApproval);
  sendTransition(
    'ACCEPT',
    { transition: accepted, approval: acceptanceApproval },
    worker,
    requester,
    0,
  );
  requester.machine.apply(accepted);
  record('ACCEPT', { transition: accepted, approval: acceptanceApproval } as unknown as Json);
  const started = worker.transition('START');
  sendTransition('START', started, worker, requester, 1);
  requester.machine.apply(started);
  record('START', started as unknown as Json);
  const root = createCapability(
    {
      audience: alice.did,
      taskId: manifest.taskId,
      resource: 'mcp://alice/docs/public/*',
      allowedTools: ['docs/read'],
      argConstraints: { 'docs/read': argSchema },
      maxCalls: 10,
      notBefore: manifest.createdAt,
      expiresAt: manifest.deadline,
      maxDepth: 1,
    },
    alice,
  );
  const token = createCapability(
    {
      ...root.payload,
      audience: bob.did,
      resource: 'mcp://alice/docs/public/architecture',
      argConstraints: {
        'docs/read': {
          allOf: [
            argSchema,
            { properties: { uri: { const: 'mcp://alice/docs/public/architecture' } } },
          ],
        },
      },
      maxCalls: 2,
      maxDepth: 0,
    },
    alice,
    root,
  );
  let executedTools = 0;
  const backend = await connectMCPTools(async (name, args) => {
    executedTools++;
    assert.equal(name, 'docs/read');
    assert.equal(args.uri, 'mcp://alice/docs/public/architecture');
    return {
      content: [
        {
          type: 'text',
          text: 'Owner gateways enforce signed contracts and restricted capabilities.',
        },
      ],
    };
  });
  const proxy = new MCPProxy({
    chain: [root, token],
    context: { rootDid: alice.did, audience: bob.did, taskId: manifest.taskId },
    backend: backend.client,
    guard: requester.capabilities,
    tools: { 'docs/read': { resource: (a) => String(a.uri), readOnly: true } },
    gate: requester.approvals,
    meter: worker.quota,
    isActive: () =>
      worker.machine.state === 'IN_PROGRESS' && requester.machine.state === 'IN_PROGRESS',
    onAudit: (event, details) => {
      record(event, details);
    },
  });
  // Gateway fixtures in this demo are cleartext. Network sessions reject those envelopes.
  const verifier = new VerificationEngine({ allowUnencryptedEnvelopes: true });
  verifier.registerIsolatedCheck(
    'check://report',
    'return input.artifact.summary.length > 0 && input.artifact.findings.length === 0 ? 0 : 1;',
  );
  const deliver = (data: Json, usage = worker.quota.receipt(bob)) => {
    const delivery = createDelivery(manifest.taskId, contract.contractDigest, data, usage, bob);
    return {
      delivery,
      envelope: signEnvelope(
        {
          taskId: manifest.taskId,
          recipientDid: alice.did,
          seq: 2,
          eventType: 'DELIVER',
          payload: delivery as unknown as Json,
        },
        bob,
      ),
    };
  };
  return {
    alice,
    bob,
    manifest,
    proposal,
    contract,
    requester,
    worker,
    root,
    token,
    relay,
    proxy,
    verifier,
    ledger,
    stores,
    record,
    deliver,
    sendTransition,
    get executedTools() {
      return executedTools;
    },
    close: async () => {
      requester.close();
      worker.close();
      await backend.close();
    },
  };
}

export async function happyPath(auditDirectory?: string) {
  const s = await createSession(auditDirectory);
  try {
    const data = await s.worker.execute(
      `const doc = await callTool('docs/read', {uri:'mcp://alice/docs/public/architecture'}); await reportUsage(12, 8); return {summary: doc.content[0].text, findings: []};`,
      s.proxy,
    );
    const { delivery, envelope } = s.deliver(data);
    const delivered = s.worker.transition('DELIVER');
    s.requester.machine.apply(delivered);
    s.record('DELIVER', delivery as unknown as Json);
    s.relay.send(envelope);
    const incoming = s.requester.inbox.receive(s.relay.receive(s.alice.did)!);
    const approval = signApproval(s.manifest.taskId, 'final_verification', delivery, s.alice);
    const { result, verification, settlement } = await s.requester.verifyAndSettle(
      incoming,
      s.verifier,
      approval,
    );
    assert.equal(result.accepted, true, result.reason);
    s.sendTransition(result.event, verification, s.requester, s.worker, 1);
    s.worker.machine.apply(verification);
    s.record(result.event, { result, approval } as unknown as Json);
    assert.ok(settlement);
    s.sendTransition('SETTLED', settlement, s.requester, s.worker, 2);
    s.worker.machine.apply(settlement);
    s.record('SETTLED', settlement as unknown as Json);
    const bundle = s.ledger.bundle(s.alice, s.bob);
    const audit = verifyAudit(bundle, {
      taskId: s.manifest.taskId,
      actors: [s.alice.did, s.bob.did],
    });
    assert.equal(audit.status, 'VALID');
    assert.equal(s.executedTools, 1);
    return {
      scenario: 'happy_path',
      state: s.requester.machine.state,
      stages: result.stages,
      audit: audit.status,
      bundle,
    };
  } finally {
    await s.close();
  }
}
function expectBlock(fn: () => unknown, code: string) {
  assert.throws(fn, new RegExp(code));
}
export async function privilegeScenario() {
  const s = await createSession();
  let blocked = 0;
  try {
    for (const [tool, args] of [
      ['docs/delete', { uri: 'mcp://alice/docs/public/architecture' }],
      ['docs/read', { uri: 'mcp://alice/docs/private/keys' }],
      ['docs/read', { uri: 'mcp://alice/docs/public/architecture', extra: true }],
    ] as const) {
      await assert.rejects(s.proxy.callTool(tool, args), /CAPABILITY_VIOLATION/);
      blocked++;
    }
    await s.proxy.callTool('docs/read', { uri: 'mcp://alice/docs/public/architecture' });
    await s.proxy.callTool('docs/read', { uri: 'mcp://alice/docs/public/architecture' });
    await assert.rejects(
      s.proxy.callTool('docs/read', { uri: 'mcp://alice/docs/public/architecture' }),
      /CAPABILITY_VIOLATION/,
    );
    blocked++;
    const attacks = [
      { maxDepth: 1 },
      { allowedTools: ['docs/read', 'docs/delete'] },
      { maxCalls: 11 },
      { expiresAt: new Date(Date.parse(s.root.payload.expiresAt) + 1000).toISOString() },
      { taskId: 'task_other000' },
      { argConstraints: { 'docs/read': {} } },
      { resource: 'mcp://alice/*' },
    ];
    for (const patch of attacks) {
      expectBlock(
        () =>
          createCapability({ ...s.token.payload, ...patch, audience: s.bob.did }, s.alice, s.root),
        'CAPABILITY_VIOLATION',
      );
      s.record('CAPABILITY_VIOLATION', { attack: patch as unknown as Json });
      blocked++;
    }
    expectBlock(
      () => createCapability({ ...s.token.payload, audience: s.alice.did }, s.bob, s.token),
      'CAPABILITY_VIOLATION',
    );
    blocked++;
    assert.equal(s.executedTools, 2);
    assert.equal(verifyAudit(s.ledger.bundle(s.alice, s.bob)).valid, true);
    return { scenario: 'privilege_escalation', blocked, status: 'CAPABILITY_VIOLATION' };
  } finally {
    await s.close();
  }
}
export async function budgetScenario() {
  const s = await createSession();
  try {
    await assert.rejects(
      s.worker.execute(
        'await reportUsage(0, 51); return {summary:"unauthorized",findings:[]};',
        s.proxy,
      ),
      /BUDGET_EXCEEDED|SANDBOX_HALTED/,
    );
    assert.equal(s.worker.quota.controller.signal.aborted, true);
    const { envelope } = s.deliver({ summary: 'over budget', findings: [] });
    const delivered = s.worker.transition('DELIVER');
    s.requester.machine.apply(delivered);
    const { result, verification } = await s.requester.verifyAndSettle(envelope, s.verifier);
    s.worker.machine.apply(verification);
    assert.equal(s.requester.machine.state, 'VERIFY_REJECT');
    assert.equal(result.event, 'VERIFY_REJECT');
    s.record('BUDGET_EXCEEDED', { reason: result.reason ?? '' });
    return { scenario: 'budget_exceeded', halted: true, event: result.event };
  } finally {
    await s.close();
  }
}
export async function tamperScenario() {
  const s = await createSession();
  let detected = 0;
  try {
    const { delivery } = s.deliver({ summary: 'valid', findings: [] });
    const broken = structuredClone(delivery);
    broken.artifact.payload.data = { summary: 'changed', findings: [] };
    // Re-sign the enclosing delivery: artifact authenticity and digest still fail.
    for (const bad of [
      broken,
      {
        ...delivery,
        artifact: signPayload(
          { ...delivery.artifact.payload, digest: digest({ summary: 7 }), data: { summary: 7 } },
          s.bob,
        ),
      },
    ]) {
      const e = signEnvelope(
        {
          taskId: s.manifest.taskId,
          recipientDid: s.alice.did,
          seq: 1,
          eventType: 'DELIVER',
          payload: bad as unknown as Json,
        },
        s.bob,
      );
      const result = await s.verifier.verify(s.contract, e, s.requester.approvals);
      assert.equal(result.event, 'VERIFY_REJECT');
      detected++;
    }
    // Valid worker signatures and matching digest, but invalid output schema.
    const schema = s.deliver({ summary: 7 });
    const schemaResult = await s.verifier.verify(
      s.contract,
      schema.envelope,
      s.requester.approvals,
    );
    assert.equal(schemaResult.reason, 'Error: OUTPUT_SCHEMA');
    detected++;
    const relay = new InMemoryRelay((e) => {
      e.payload.eventType = 'CORRUPT';
      return e;
    });
    relay.send(s.deliver({ summary: 'valid', findings: [] }).envelope);
    expectBlock(() => relay.receive(s.alice.did), 'TAMPERING');
    detected++;
    // Record live rejections before sealing; audit tampering uses copies of the bundle.
    s.record('VERIFY_REJECT', { detected });
    const bundle = s.ledger.bundle(s.alice, s.bob);
    assert.equal(verifyAudit(bundle).valid, true);
    const variants: AuditBundle[] = [
      structuredClone(bundle),
      structuredClone(bundle),
      structuredClone(bundle),
      structuredClone(bundle),
    ];
    variants[0].entries[0].body.eventType += 'X';
    variants[1].entries.reverse();
    variants[2].entries.pop();
    variants[3].entries.splice(1, 1);
    for (const v of variants) {
      assert.equal(verifyAudit(v).status, 'INVALID');
      detected++;
    }
    return { scenario: 'tampering', detected, event: 'VERIFY_REJECT', audit: 'INVALID' };
  } finally {
    await s.close();
  }
}
export async function runDemo(auditDirectory?: string) {
  const happy = await happyPath(auditDirectory);
  const { bundle: _, ...summary } = happy;
  return [summary, await privilegeScenario(), await budgetScenario(), await tamperScenario()];
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runDemo()
    .then((results) => console.log(JSON.stringify(results, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
}
