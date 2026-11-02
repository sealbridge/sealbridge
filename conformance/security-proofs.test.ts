// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCapability,
  createContract,
  createInviteToken,
  createRelayAuthToken,
  createRevocationNotice,
  createSignedAgentCard,
  CapabilityGuard,
  inviteRevocationId,
  RevocationRegistry,
  verifyRevocationNotice,
  decryptEnvelopePayload,
  digest,
  generateKeyPair,
  isEncryptedEnvelopePayload,
  openEnvelope,
  parseAndVerifyInviteToken,
  signApproval,
  signEnvelope,
  signPayload,
  signUsage,
  validateOutput,
  validateRelayEndpointUrl,
  verifyContract,
  verifyEnvelope,
  verifyRelayAuthToken,
  verifySigned,
} from '../packages/core/src/index.js';
import type {
  Json,
  KeyPair,
  Signed,
  SignedEnvelope,
  TaskManifest,
} from '../packages/core/src/index.js';
import { verifyAudit } from '../packages/ledger/src/index.js';
import { InMemoryRelay, createRelayFetchHandler } from '../packages/relay/src/index.js';
import {
  ApprovalGate,
  PolicyAutoApprovalProvider,
  RequesterClient,
  IncompleteSettlementError,
  VerificationEngine,
  WorkerNode,
  buildTaskManifest,
  createDelivery,
} from '../packages/runtime/src/index.js';
import type { Delivery } from '../packages/runtime/src/index.js';
import {
  ClaudeCodeAdapter,
  CommandAgentAdapter,
  SandboxAgentAdapter,
  parseJsonDeliverable,
  resolveCommand,
  runCommand,
} from '../packages/adapters/src/index.js';
import { startCredentialProxy } from '../packages/adapters/src/credential-proxy.js';
import type { AgentTaskContext, CommandRequest } from '../packages/adapters/src/index.js';
import {
  runContainerOrSubprocessSandbox,
  runSandbox,
  sanitizedEnvironment,
} from '../packages/sandbox/src/index.js';

const secretNames = [
  'OPENAI_API_KEY',
  'GITHUB_TOKEN',
  'ANTHROPIC_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
] as const;
const secretValues = Object.fromEntries(secretNames.map((name) => [name, `proof-secret-${name}`]));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function remember<T>(value: T, close: () => Promise<unknown>): T {
  cleanup.push(close);
  return value;
}

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'acp-proof-'));
  return remember(dir, () => rm(dir, { recursive: true, force: true }));
}

function manifestFor(
  owner: KeyPair,
  worker: KeyPair,
  outputSchema: TaskManifest['io']['outputSchema'] = {},
): TaskManifest {
  return buildTaskManifest({
    ownerDid: owner.did,
    workerDid: worker.did,
    title: 'Security proof',
    description: 'Adversarial task',
    outputSchema,
  });
}

async function taskContext(
  input: Json,
  manifest: TaskManifest,
  reportIsolation?: (level: string) => void,
): Promise<AgentTaskContext> {
  return {
    taskId: manifest.taskId,
    manifest,
    input,
    workspaceDir: await workspace(),
    signal: AbortSignal.timeout(15000),
    callTool: async () => {
      throw new Error('TOOL_DENIED');
    },
    reportUsage: () => {},
    reportIsolation,
  };
}

function withHostSecrets<T>(run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(secretNames.map((name) => [name, process.env[name]]));
  for (const name of secretNames) process.env[name] = secretValues[name];
  return run().finally(() => {
    for (const name of secretNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
}

function assertNoSecrets(text: string): void {
  for (const value of Object.values(secretValues)) expect(text).not.toContain(value);
}

function flipSignature<T>(signed: Signed<T>): Signed<T> {
  const copy = structuredClone(signed);
  const body = copy.signature.signature;
  // Flip a character that carries signature bits. The final base64url character
  // can encode unused padding bits and is not a reliable one-byte mutation.
  const index = body.indexOf(':') + 2;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const replacement = alphabet[(alphabet.indexOf(body[index]) + 1) % alphabet.length];
  copy.signature.signature = body.slice(0, index) + replacement + body.slice(index + 1);
  return copy;
}

function envelopeFor(sender: KeyPair, recipientDid: string, taskId = 'task_proof'): SignedEnvelope {
  return signEnvelope(
    { taskId, recipientDid, seq: 0, eventType: 'PING', payload: { taskId } },
    sender,
  );
}

describe('Proof 1: memory and environment secret exfiltration', () => {
  it('keeps host secrets out of the command worker environment and task envelope', async () => {
    await withHostSecrets(async () => {
      const owner = generateKeyPair();
      const worker = generateKeyPair();
      const manifest = manifestFor(owner, worker);
      const script = [
        'let s="";',
        'process.stdin.on("data",b=>s+=b);',
        'process.stdin.on("end",()=>{',
        `const names=${JSON.stringify([...secretNames])};`,
        'const leaked=names.filter(name=>process.env[name]);',
        'console.log(JSON.stringify({leaked,stdin:s,nodeOptions:process.env.NODE_OPTIONS??null}));',
        '});',
      ].join('');
      const adapter = new CommandAgentAdapter({ command: [process.execPath, '-e', script] });
      const input = { note: 'env dump', token: secretValues.OPENAI_API_KEY };
      const context = await taskContext({ ...input, drop: secretValues.GITHUB_TOKEN }, manifest);
      delete (context.input as { token?: string }).token;
      context.input = { note: 'env dump' };
      const output = await adapter.executeTask(context);
      expect(output).toMatchObject({ leaked: [], nodeOptions: null });
      const printed = JSON.stringify(output);
      assertNoSecrets(printed);
      expect(printed).toContain('env dump');
      const env = sanitizedEnvironment(context.workspaceDir);
      for (const name of secretNames) expect(env).not.toHaveProperty(name);
      expect(env).not.toHaveProperty('NODE_OPTIONS');
      expect(env).not.toHaveProperty('PATH');
    });
  });

  it('does not expose process or host secrets to sandboxed guest code', async () => {
    await withHostSecrets(async () => {
      await expect(
        runSandbox({
          code: 'return process.env.OPENAI_API_KEY;',
          input: { who: 'guest' },
          timeoutMs: 2000,
          onTool: async () => null,
        }),
      ).rejects.toThrow(/process is not defined/);
      const echoed = await runSandbox({
        code: 'return input;',
        input: { who: 'guest' },
        timeoutMs: 2000,
        onTool: async () => null,
      });
      assertNoSecrets(JSON.stringify(echoed));
      expect(echoed).toEqual({ who: 'guest' });
    });
  });

  it('rejects forged, other-task, and closed credential handles', async () => {
    const realKey = secretValues.OPENAI_API_KEY;
    const otherKey = secretValues.GITHUB_TOKEN;
    const seen: { authorization: string | null; body: string }[] = [];
    const signal = AbortSignal.timeout(5000);
    const proxy = await startCredentialProxy({
      apiKey: realKey,
      baseUrl: 'https://api.openai.com/v1',
      style: 'openai',
      signal,
      fetch: async (_url, init) => {
        seen.push({
          authorization: new Headers(init?.headers).get('authorization'),
          body: String(init?.body ?? ''),
        });
        return Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    });
    const other = await startCredentialProxy({
      apiKey: otherKey,
      baseUrl: 'https://api.openai.com/v1',
      style: 'openai',
      signal,
      fetch: async () => Response.json({ ok: true }),
    });
    cleanup.push(
      () => proxy.close(),
      () => other.close(),
    );
    const redeem = (token: string) =>
      fetch(proxy.url + '/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'task' }),
      });
    expect((await redeem('forged-handle')).status).toBe(401);
    expect((await redeem(other.token)).status).toBe(401);
    expect(other.token).not.toContain(otherKey);
    expect(proxy.token).not.toContain(realKey);
    const accepted = await redeem(proxy.token);
    expect(accepted.status).toBe(200);
    assertNoSecrets(await accepted.text());
    expect(seen).toEqual([
      { authorization: 'Bearer ' + realKey, body: JSON.stringify({ prompt: 'task' }) },
    ]);
    expect(seen[0].body).not.toContain(realKey);
    await proxy.close();
    await expect(redeem(proxy.token)).rejects.toThrow();
  });

  it('forwards only the task-scoped handle into a Claude subprocess', async () => {
    await withHostSecrets(async () => {
      const realKey = secretValues.ANTHROPIC_API_KEY;
      const dir = await workspace();
      const script = join(dir, 'mock-claude.cjs');
      await writeFile(
        script,
        `#!${process.execPath}\n` +
          'let input="";process.stdin.on("data",b=>input+=b);process.stdin.on("end",async()=>{' +
          `const leaked=process.env.ANTHROPIC_API_KEY===${JSON.stringify(realKey)};` +
          'const response=await fetch(process.env.ANTHROPIC_BASE_URL+"/v1/messages",{method:"POST",headers:{"x-api-key":process.env.ANTHROPIC_API_KEY,"content-type":"application/json"},body:"{}"});' +
          'console.log(JSON.stringify({result:JSON.stringify({leaked,status:response.status}),usage:{input_tokens:1,output_tokens:1}}));' +
          '});\n',
        { mode: 0o700 },
      );
      let hostSaw = '';
      const adapter = new ClaudeCodeAdapter({
        binaryPath: script,
        apiKey: realKey,
        fetch: async (_url, init) => {
          hostSaw = new Headers(init?.headers).get('x-api-key') ?? '';
          return Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });
        },
      });
      const owner = generateKeyPair();
      const worker = generateKeyPair();
      const output = await adapter.executeTask(
        await taskContext({ prompt: 'report' }, manifestFor(owner, worker)),
      );
      expect(output).toEqual({ leaked: false, status: 200 });
      expect(hostSaw).toBe(realKey);
      assertNoSecrets(JSON.stringify(output));
    });
  });
});

describe('Proof 2: command injection and path traversal', () => {
  const payloads = [
    '$(touch /tmp/pwn)',
    '`id`',
    '; rm -rf /',
    '| cat /etc/passwd',
    '../../etc/passwd',
    '__proto__',
  ];

  it('passes adversarial argv through spawn without invoking a shell', async () => {
    const marker = join(tmpdir(), `acp-proof-${crypto.randomUUID()}`);
    const injected = [
      `$(touch ${marker})`,
      '`id`',
      '; rm -rf /',
      '| cat /etc/passwd',
      '../../etc/passwd',
    ];
    const result = await runCommand({
      command: process.execPath,
      args: [
        '-e',
        'let s="";process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>console.log(JSON.stringify({argv:process.argv.slice(1),stdin:s})));',
        ...injected,
      ],
      cwd: tmpdir(),
      env: sanitizedEnvironment(tmpdir()),
      input: injected.join('\n'),
      signal: AbortSignal.timeout(5000),
      timeoutMs: 5000,
    });
    expect(existsSync(marker)).toBe(false);
    const parsed = JSON.parse(result.stdout) as { argv: string[]; stdin: string };
    expect(parsed.argv).toEqual(injected);
    expect(parsed.stdin).toBe(injected.join('\n'));
    await expect(resolveCommand('../../etc/passwd')).rejects.toThrow(
      'COMMAND_MUST_BE_ABSOLUTE_OR_ON_PATH',
    );
    await expect(resolveCommand('$(touch /tmp/pwn)')).rejects.toThrow(
      'COMMAND_MUST_BE_ABSOLUTE_OR_ON_PATH',
    );
    await expect(resolveCommand('; rm -rf /')).rejects.toThrow(
      'COMMAND_MUST_BE_ABSOLUTE_OR_ON_PATH',
    );
    await expect(resolveCommand('`id`')).rejects.toThrow('COMMAND_NOT_FOUND');
  });

  it('keeps adversarial task input on stdin and inside the workspace file', async () => {
    const owner = generateKeyPair();
    const worker = generateKeyPair();
    const manifest = manifestFor(owner, worker);
    const input = {
      text: payloads.join(' '),
      path: '../../etc/passwd',
      __proto__: { admin: true },
    };
    const seen: CommandRequest[] = [];
    const adapter = new CommandAgentAdapter({
      command: [process.execPath, '-e', 'console.log(JSON.stringify({ok:true}))'],
      runner: async (request) => {
        seen.push(request);
        return { stdout: JSON.stringify({ ok: true }), exitCode: 0 };
      },
    });
    const context = await taskContext(input, manifest);
    expect(await adapter.executeTask(context)).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].command).toBe(process.execPath);
    expect(seen[0].command).not.toBe('/bin/sh');
    expect(seen[0].args.some((arg) => payloads.some((payload) => arg.includes(payload)))).toBe(
      false,
    );
    expect(seen[0].input).toContain('../../etc/passwd');
    expect(seen[0].input).toContain('$(touch /tmp/pwn)');
    const files = await readdir(context.workspaceDir);
    expect(files).toEqual(['input.json']);
    const stored = await readFile(join(context.workspaceDir, 'input.json'), 'utf8');
    expect(stored).toContain('../../etc/passwd');
    expect(stored).not.toContain('/bin/sh');
  });

  it('rejects traversal and prototype-pollution shapes that fail the output schema', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: { ok: { type: 'boolean' } },
    };
    expect(validateOutput(schema, { ok: true, path: '../../etc/passwd' })).toBe(false);
    expect(
      validateOutput({ type: 'string', pattern: '^[A-Za-z0-9._-]+$' }, '../../etc/passwd'),
    ).toBe(false);
    expect(
      validateOutput({ type: 'string', pattern: '^[A-Za-z0-9._-]+$' }, '$(touch /tmp/pwn)'),
    ).toBe(false);
    const parsed = JSON.parse('{"__proto__":{"admin":true},"ok":true}') as { ok: boolean };
    expect(parseJsonDeliverable(JSON.stringify(parsed))).toMatchObject({ ok: true });
    expect(({} as { admin?: boolean }).admin).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('admin');
    expect(validateOutput(schema, parsed)).toBe(false);
    expect(({} as { admin?: boolean }).admin).toBeUndefined();
  });
});

describe('Proof 3: cross-session state bleed and isolation downgrade', () => {
  it('rejects cross-session relay polls and does not mix concurrent inboxes', async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const eve = generateKeyPair();
    const relay = new InMemoryRelay({ requireAuth: true });
    const toBob = envelopeFor(alice, bob.did, 'task_bob');
    const toEve = envelopeFor(alice, eve.did, 'task_eve');
    await Promise.all([
      Promise.resolve().then(() => relay.send(toBob)),
      Promise.resolve().then(() => relay.send(toEve)),
    ]);
    expect(() => relay.receive(bob.did, createRelayAuthToken(eve))).toThrow('RELAY_UNAUTHORIZED');
    expect(() => relay.receive(eve.did, createRelayAuthToken(bob))).toThrow('RELAY_UNAUTHORIZED');
    const [bobMail, eveMail] = await Promise.all([
      Promise.resolve().then(() => relay.receive(bob.did, createRelayAuthToken(bob))),
      Promise.resolve().then(() => relay.receive(eve.did, createRelayAuthToken(eve))),
    ]);
    expect(bobMail).toEqual(toBob);
    expect(eveMail).toEqual(toEve);
    expect(relay.receive(bob.did, createRelayAuthToken(bob))).toBeUndefined();
    expect(relay.receive(eve.did, createRelayAuthToken(eve))).toBeUndefined();
    expect(() => relay.send(toBob)).toThrow('REPLAYED_ENVELOPE');
    const handler = createRelayFetchHandler({ relay });
    const later = envelopeFor(alice, bob.did, 'task_bob_later');
    relay.send(later);
    const denied = await handler(
      new Request('https://relay.example/envelopes?recipient=' + encodeURIComponent(bob.did), {
        headers: {
          authorization:
            'Bearer ' + createRelayAuthToken(eve, { origin: 'https://relay.example' }),
        },
      }),
    );
    expect(denied.status).toBe(401);
    const allowed = await handler(
      new Request('https://relay.example/envelopes?recipient=' + encodeURIComponent(bob.did), {
        headers: {
          authorization:
            'Bearer ' + createRelayAuthToken(bob, { origin: 'https://relay.example' }),
        },
      }),
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual(later);
  });

  it('reports the runtime isolation level instead of the task claim', async () => {
    const claimed = await runContainerOrSubprocessSandbox({
      isolationLevel: 'oci_container',
      runtime: null,
      timeoutMs: 2000,
      input: { value: 1 },
      code: 'return { effectiveIsolationLevel: "oci_container", claim: "container" };',
      onTool: async () => null,
    });
    expect(claimed.effectiveIsolationLevel).toBe('subprocess_restricted');
    expect(claimed.output).toEqual({
      effectiveIsolationLevel: 'oci_container',
      claim: 'container',
    });
    const owner = generateKeyPair();
    const worker = generateKeyPair();
    const manifest = manifestFor(owner, worker);
    manifest.sandboxPolicy.isolationLevel = 'subprocess_restricted';
    let reported = '';
    const output = await new SandboxAgentAdapter(
      'return { effectiveIsolationLevel: "container" };',
    ).executeTask(
      await taskContext({ n: 1 }, manifest, (level) => {
        reported = level;
      }),
    );
    expect(output).toEqual({ effectiveIsolationLevel: 'container' });
    expect(reported).toBe('subprocess_restricted');
  });

  it('rejects an attested isolation level below the contract requirement', async () => {
    const owner = generateKeyPair();
    const worker = generateKeyPair();
    const { contract, envelope, gate, approval } = await signedDelivery(owner, worker, {
      isolation: 'subprocess_restricted',
      requireOci: true,
    });
    const engine = new VerificationEngine({ allowUnencryptedEnvelopes: true });
    const downgraded = await engine.verify(contract, envelope, gate, approval);
    expect(downgraded.accepted).toBe(false);
    expect(downgraded.reason).toContain('ISOLATION_LEVEL_MISMATCH');
    for (const lie of ['container', 'subprocess', 'host_adapter']) {
      const forged = await signedDelivery(owner, worker, { isolation: lie, requireOci: true });
      const result = await engine.verify(
        forged.contract,
        forged.envelope,
        forged.gate,
        forged.approval,
      );
      expect(result.accepted).toBe(false);
      expect(result.reason).toContain('ISOLATION_LEVEL_MISMATCH');
    }
    const honest = await signedDelivery(owner, worker, {
      isolation: 'oci_container',
      requireOci: true,
    });
    expect(
      (await engine.verify(honest.contract, honest.envelope, honest.gate, honest.approval))
        .accepted,
    ).toBe(true);
    const flipped = structuredClone(honest.envelope);
    flipped.payload.payload = flipSignature(
      (flipped.payload.payload as unknown as Delivery).attestation,
    ) as unknown as Json;
    const broken = signEnvelope(
      {
        taskId: honest.contract.manifest.taskId,
        recipientDid: owner.did,
        seq: 1,
        eventType: 'DELIVER',
        payload: flipped.payload.payload as Json,
      },
      worker,
    );
    expect(
      (await engine.verify(honest.contract, broken, honest.gate, honest.approval)).accepted,
    ).toBe(false);
  });
});

describe('Proof 4: resource exhaustion and SSRF', () => {
  it('rejects oversized payloads, queue floods, and extra recipients', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const relay = new InMemoryRelay({ maxQueues: 1 });
    const oversized = signEnvelope(
      {
        taskId: 'task_big',
        recipientDid: bob.did,
        seq: 0,
        eventType: 'PING',
        payload: 'x'.repeat(1048576),
      },
      alice,
    );
    expect(relay.maxEnvelopeBytes).toBeLessThanOrEqual(256 * 1024);
    expect(relay.maxQueueSize).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(relay.maxEnvelopeBytes);
    expect(() => relay.send(oversized)).toThrow('RELAY_CAPACITY');
    expect(relay.snapshot().seen).toEqual([]);
    for (let i = 0; i < relay.maxQueueSize; i++)
      relay.send(envelopeFor(alice, bob.did, 'task_flood_' + i));
    expect(() => relay.send(envelopeFor(alice, bob.did, 'task_flood_extra'))).toThrow(
      'RELAY_CAPACITY',
    );
    expect(() => relay.send(envelopeFor(alice, generateKeyPair().did, 'task_other'))).toThrow(
      'RELAY_CAPACITY',
    );
  });

  it('rejects nonce replay inside the FIFO retention window and stays bounded', () => {
    const bob = generateKeyPair();
    const relay = new InMemoryRelay({ maxAuthSeenEntries: 2 });
    const first = createRelayAuthToken(bob, { nonce: 'nonce-1' });
    const second = createRelayAuthToken(bob, { nonce: 'nonce-2' });
    const third = createRelayAuthToken(bob, { nonce: 'nonce-3' });
    expect(relay.authenticate(bob.did, first)).toBe(true);
    expect(relay.authenticate(bob.did, first)).toBe(false);
    expect(relay.authenticate(bob.did, second)).toBe(true);
    expect(relay.authenticate(bob.did, second)).toBe(false);
    expect(relay.snapshot().authSeen).toHaveLength(2);
    expect(relay.authenticate(bob.did, third)).toBe(true);
    expect(relay.snapshot().authSeen).toHaveLength(2);
    expect(relay.authenticate(bob.did, third)).toBe(false);
    expect(relay.authenticate(bob.did, second)).toBe(false);
  });

  it('rejects metadata, loopback, file, and non-HTTP provider relay targets', async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    for (const url of ['http://169.254.169.254', 'http://169.254.169.254/latest/meta-data']) {
      expect(() => validateRelayEndpointUrl(url)).toThrow('SSRF_BLOCKED_RELAY_URL');
      expect(() => validateRelayEndpointUrl(url, { allowPrivateRelay: false })).toThrow(
        'SSRF_BLOCKED_RELAY_URL',
      );
    }
    expect(() =>
      validateRelayEndpointUrl('http://127.0.0.1', { allowPrivateRelay: false }),
    ).toThrow('SSRF_BLOCKED_RELAY_URL');
    expect(() => validateRelayEndpointUrl('file:///etc/passwd')).toThrow('SSRF_BLOCKED_RELAY_URL');
    const metadataCard = createSignedAgentCard(
      { name: 'Metadata', agentDid: bob.did, relayEndpoint: 'http://169.254.169.254', skills: [] },
      bob,
    );
    const loopbackCard = createSignedAgentCard(
      { name: 'Loopback', agentDid: bob.did, relayEndpoint: 'http://127.0.0.1', skills: [] },
      bob,
    );
    const metadataInvite = createInviteToken({ agentCard: metadataCard }, bob);
    const loopbackInvite = createInviteToken({ agentCard: loopbackCard }, bob);
    expect(() => parseAndVerifyInviteToken(metadataInvite)).toThrow('SSRF_BLOCKED_RELAY_URL');
    expect(() =>
      parseAndVerifyInviteToken(loopbackInvite, Date.now(), { allowPrivateRelay: false }),
    ).toThrow('SSRF_BLOCKED_RELAY_URL');
    const client = new RequesterClient({ owner: alice, allowPrivateRelay: false });
    await expect(
      client.delegate({
        to: metadataInvite,
        title: 'SSRF',
        description: 'metadata',
        input: {},
      }),
    ).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
    await expect(
      client.delegate({
        to: bob.did,
        relay: 'file:///etc/passwd',
        title: 'SSRF',
        description: 'file',
        input: {},
      }),
    ).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
    await expect(
      startCredentialProxy({
        apiKey: 'synthetic',
        baseUrl: 'file:///etc/passwd',
        style: 'openai',
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toThrow('INVALID_PROVIDER_URL');
  });
});

describe('Proof 5: cryptographic envelope and artifact tampering', () => {
  it('rejects one-field and one-byte edits to a signed contract', () => {
    const owner = generateKeyPair();
    const worker = generateKeyPair();
    const manifest = manifestFor(owner, worker);
    const proposal = signPayload(manifest, owner);
    const contract = createContract(manifest, proposal, worker);
    expect(verifyContract(contract)).toBe(true);
    expect(contract.proposal.signature.canonicalization).toBe('RFC8785-JCS');
    const budget = structuredClone(contract);
    budget.manifest.budget.maxInputTokens += 1;
    expect(verifyContract(budget)).toBe(false);
    const scope = structuredClone(contract);
    scope.manifest.sandboxPolicy.isolationLevel = 'oci_container';
    expect(verifyContract(scope)).toBe(false);
    const resigned = structuredClone(contract);
    resigned.proposal = flipSignature(resigned.proposal);
    expect(verifySigned(resigned.proposal, owner.did)).toBe(false);
    expect(verifyContract(resigned)).toBe(false);
    const edited = structuredClone(proposal);
    edited.payload.budget.maxWallClockSeconds += 1;
    expect(digest(edited.payload)).not.toBe(edited.signature.payloadDigest);
    expect(verifySigned(edited, owner.did)).toBe(false);
  });

  it('rejects artifact-hash and usage-receipt edits, and accepts the unmodified delivery', async () => {
    const owner = generateKeyPair();
    const worker = generateKeyPair();
    const honest = await signedDelivery(owner, worker, {
      isolation: 'subprocess_restricted',
      requireOci: false,
    });
    const engine = new VerificationEngine({ allowUnencryptedEnvelopes: true });
    expect(
      (await engine.verify(honest.contract, honest.envelope, honest.gate, honest.approval))
        .accepted,
    ).toBe(true);
    const delivery = honest.envelope.payload.payload as unknown as Delivery;
    const changedData = structuredClone(delivery);
    (changedData.artifact.payload.data as { ok: boolean }).ok = false;
    expect(
      (
        await engine.verify(
          honest.contract,
          rewrap(honest, changedData, worker, 1),
          new ApprovalGate(owner.did, { requiredGates: [], autoApprove: [] }),
          signApproval(honest.contract.manifest.taskId, 'final_verification', changedData, owner),
        )
      ).accepted,
    ).toBe(false);
    const changedDigest = structuredClone(delivery);
    changedDigest.artifact.payload.digest =
      changedDigest.artifact.payload.digest.slice(0, -1) +
      (changedDigest.artifact.payload.digest.endsWith('a') ? 'b' : 'a');
    expect(verifySigned(changedDigest.artifact, worker.did)).toBe(false);
    const changedUsage = structuredClone(delivery);
    changedUsage.usage.payload.inputTokens += 1;
    expect(verifySigned(changedUsage.usage, worker.did)).toBe(false);
    expect(
      (
        await engine.verify(
          honest.contract,
          rewrap(honest, changedUsage, worker, 2),
          honest.gate,
          honest.approval,
        )
      ).accepted,
    ).toBe(false);
  });

  it('rejects stale and one-byte-modified RelayAuth tokens', () => {
    const bob = generateKeyPair();
    const eve = generateKeyPair();
    const fresh = createRelayAuthToken(bob);
    expect(verifyRelayAuthToken(fresh, bob.did).valid).toBe(true);
    const stale = createRelayAuthToken(bob, {
      now: new Date(Date.now() - 300001).toISOString(),
    });
    expect(verifyRelayAuthToken(stale, bob.did)).toEqual({
      valid: false,
      error: 'RELAY_UNAUTHORIZED',
    });
    const future = createRelayAuthToken(bob, {
      now: new Date(Date.now() + 600000).toISOString(),
    });
    expect(verifyRelayAuthToken(future, bob.did).valid).toBe(false);
    const decoded = JSON.parse(Buffer.from(fresh, 'base64url').toString('utf8')) as Signed<{
      timestamp: string;
    }>;
    const flipped = Buffer.from(JSON.stringify(flipSignature(decoded))).toString('base64url');
    expect(verifyRelayAuthToken(flipped, bob.did).valid).toBe(false);
    expect(verifyRelayAuthToken(createRelayAuthToken(eve), bob.did).valid).toBe(false);
    const relay = new InMemoryRelay({ requireAuth: true });
    expect(relay.authenticate(bob.did, fresh)).toBe(true);
    expect(relay.authenticate(bob.did, fresh)).toBe(false);
    expect(relay.authenticate(bob.did, stale)).toBe(false);
  });
});

describe('Proof 9: end-to-end payload encryption', () => {
  it('rejects a third party and a ciphertext moved to another header', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const mallory = generateKeyPair();
    const secret = 'zk-blind-unit-secret';
    const envelope = signEnvelope(
      {
        taskId: 'task_blind_unit',
        recipientDid: bob.did,
        seq: 4,
        eventType: 'PING',
        payload: { secret, token: 'CapabilityToken' },
      },
      alice,
      { encrypt: true },
    );
    expect(verifyEnvelope(envelope, bob.did)).toBe(true);
    expect(isEncryptedEnvelopePayload(envelope.payload.payload)).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain(secret);
    const context = {
      taskId: envelope.payload.taskId,
      seq: envelope.payload.seq,
      eventType: envelope.payload.eventType,
      senderDid: envelope.payload.senderDid,
      recipientDid: envelope.payload.recipientDid,
    };
    expect(decryptEnvelopePayload(envelope.payload.payload, bob, context)).toEqual({
      secret,
      token: 'CapabilityToken',
    });
    expect(openEnvelope(envelope, bob)).toEqual({ secret, token: 'CapabilityToken' });
    expect(() => decryptEnvelopePayload(envelope.payload.payload, mallory, context)).toThrow(
      'ENVELOPE_DECRYPTION_FAILED',
    );
    expect(() =>
      decryptEnvelopePayload(envelope.payload.payload, bob, { ...context, taskId: 'task_other' }),
    ).toThrow('ENVELOPE_DECRYPTION_FAILED');
    expect(() =>
      decryptEnvelopePayload(envelope.payload.payload, bob, { ...context, seq: context.seq + 1 }),
    ).toThrow('ENVELOPE_DECRYPTION_FAILED');
    const legacy = signEnvelope(
      {
        taskId: 'task_blind_unit',
        recipientDid: bob.did,
        seq: 0,
        eventType: 'PING',
        payload: { secret },
      },
      alice,
    );
    expect(() => openEnvelope(legacy, bob)).toThrow('UNENCRYPTED_ENVELOPE_REJECTED');
    expect(() => openEnvelope(legacy, bob, { requireEncrypted: true })).toThrow(
      'UNENCRYPTED_ENVELOPE_REJECTED',
    );
    expect(openEnvelope(legacy, bob, { requireEncrypted: false })).toEqual({ secret });
  });

  it('hides task input, capability tokens, and results from the relay', async () => {
    const inputSecret = 'zk-blind-input-7c2e9a';
    const outputSecret = 'zk-blind-output-91bd04';
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const mallory = generateKeyPair();
    const traffic: SignedEnvelope[] = [];
    const snapshots: string[] = [];
    const relay = new InMemoryRelay();
    const send = relay.send.bind(relay);
    relay.send = (envelope) => {
      send(envelope);
      traffic.push(structuredClone(envelope));
      snapshots.push(JSON.stringify(relay.snapshot()));
    };
    const worker = new WorkerNode({ checkPeer: () => 'trusted',
      owner: bob,
      relay,
      adapter: {
        id: 'blind-echo',
        name: 'Blind echo',
        skills: [],
        executeTask: async (context) => ({ published: outputSecret, echoed: context.input }),
      },
      approvalProvider: new PolicyAutoApprovalProvider(bob),
      timeoutMs: 10000,
    });
    const requester = new RequesterClient({
      owner: alice,
      relay,
      approvalProvider: new PolicyAutoApprovalProvider(alice),
      timeoutMs: 10000,
    });
    const input = { secret: inputSecret, marker: 'CapabilityToken' };
    const [settled, result] = await Promise.all([
      worker.start({ once: true }),
      requester.delegate({
        to: worker.invite(),
        title: 'Blind relay',
        description: 'Return the supplied report',
        input,
        outputSchema: { type: 'object' },
        capabilities: [
          {
            capabilityId: 'cap_blind',
            resource: 'mcp://docs/public',
            allowedTools: ['docs/read'],
            argConstraints: { type: 'object' },
            maxInvocations: 1,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
        ],
      }),
    ]);
    worker.stop();
    expect(result.state).toBe('SETTLED');
    expect(settled?.state).toBe('SETTLED');
    expect(JSON.stringify(result.deliverable)).toContain(outputSecret);
    expect(JSON.stringify(result.deliverable)).toContain(inputSecret);
    snapshots.push(JSON.stringify(relay.snapshot()));
    const visible = traffic
      .map((envelope) => JSON.stringify(envelope))
      .concat(snapshots)
      .join('\n');
    expect(traffic.length).toBeGreaterThan(0);
    for (const envelope of traffic) {
      expect(envelope.payload.type).toBe('SignedEnvelope');
      expect(isEncryptedEnvelopePayload(envelope.payload.payload)).toBe(true);
    }
    for (const secret of [inputSecret, outputSecret, 'CapabilityToken'])
      expect(visible).not.toContain(secret);
    const propose = traffic.find(
      (envelope) =>
        envelope.payload.eventType === 'PROPOSE' && envelope.payload.recipientDid === bob.did,
    );
    expect(propose).toBeDefined();
    const context = {
      taskId: propose!.payload.taskId,
      seq: propose!.payload.seq,
      eventType: propose!.payload.eventType,
      senderDid: propose!.payload.senderDid,
      recipientDid: propose!.payload.recipientDid,
    };
    const opened = JSON.stringify(decryptEnvelopePayload(propose!.payload.payload, bob, context));
    expect(opened).toContain(inputSecret);
    expect(opened).toContain('CapabilityToken');
    expect(() => decryptEnvelopePayload(propose!.payload.payload, mallory, context)).toThrow(
      'ENVELOPE_DECRYPTION_FAILED',
    );
    expect(() =>
      decryptEnvelopePayload(propose!.payload.payload, bob, {
        ...context,
        taskId: 'task_transplanted',
      }),
    ).toThrow('ENVELOPE_DECRYPTION_FAILED');
    expect(() =>
      decryptEnvelopePayload(propose!.payload.payload, bob, { ...context, seq: context.seq + 1 }),
    ).toThrow('ENVELOPE_DECRYPTION_FAILED');
  });
});

describe('Proof 10: token revocation and live cancellation', () => {
  it('rejects revoked invites, revoked capabilities, and a forged notice', async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const mallory = generateKeyPair();
    const relay = new InMemoryRelay();
    const registry = new RevocationRegistry();
    const worker = new WorkerNode({ checkPeer: () => 'trusted',
      owner: bob,
      relay,
      adapter: {
        id: 'revoke-echo',
        name: 'Revoke echo',
        skills: [],
        executeTask: async (context) => context.input,
      },
      approvalProvider: new PolicyAutoApprovalProvider(bob),
      revocation: registry,
      timeoutMs: 10000,
    });
    const token = worker.invite();
    const targetId = inviteRevocationId(token);
    const notice = createRevocationNotice(
      { targetType: 'invite', targetId, reason: 'compromised' },
      bob,
    );
    registry.revoke(notice);
    expect(registry.isRevoked('invite', targetId)).toBe(true);
    const forged = createRevocationNotice(
      { targetType: 'invite', targetId, reason: 'forged' },
      mallory,
    );
    expect(verifyRevocationNotice(forged, bob.did)).toBe(false);
    expect(() => registry.revoke(forged, bob.did)).toThrow('INVALID_REVOCATION');
    const tampered = structuredClone(notice);
    tampered.signature.signature = forged.signature.signature;
    expect(verifyRevocationNotice(tampered, bob.did)).toBe(false);
    expect(() => registry.revoke(tampered)).toThrow('INVALID_REVOCATION');
    const requester = new RequesterClient({
      owner: alice,
      relay,
      approvalProvider: new PolicyAutoApprovalProvider(alice),
      timeoutMs: 10000,
    });
    const pending = worker.start({ once: true });
    const [settled, rejected] = await Promise.allSettled([
      pending,
      requester.delegate({
        to: token,
        title: 'Revoked invite',
        description: 'Must not run',
        input: { ok: true },
      }),
    ]);
    worker.stop();
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') expect(String(rejected.reason)).toContain('TOKEN_REVOKED');
    expect(settled.status).toBe('rejected');
    if (settled.status === 'rejected') expect(String(settled.reason)).toContain('TOKEN_REVOKED');

    const now = new Date().toISOString();
    const capability = createCapability(
      {
        audience: bob.did,
        taskId: 'task_revoke_cap',
        resource: 'mcp://docs/item',
        allowedTools: ['echo'],
        argConstraints: { echo: { type: 'object' } },
        maxCalls: 2,
        notBefore: now,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        maxDepth: 0,
      },
      alice,
    );
    const guard = new CapabilityGuard(registry);
    registry.revoke(
      createRevocationNotice(
        { targetType: 'capability', targetId: capability.payload.id, reason: 'retired' },
        alice,
      ),
    );
    const context = { rootDid: alice.did, audience: bob.did, taskId: 'task_revoke_cap' };
    let called = false;
    expect(() => {
      guard.authorize([capability], context, 'echo', {}, 'mcp://docs/item');
      called = true;
    }).toThrow('TOKEN_REVOKED');
    expect(called).toBe(false);
  });

  it('cancels a running sandbox and seals a CANCELLED audit trail', async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const relay = new InMemoryRelay();
    const abort = new AbortController();
    const worker = new WorkerNode({ checkPeer: () => 'trusted',
      owner: bob,
      relay,
      adapter: new SandboxAgentAdapter('while (true) {}'),
      approvalProvider: new PolicyAutoApprovalProvider(bob),
      timeoutMs: 10000,
      onEvent: (event) => {
        if (event === 'IN_PROGRESS') setTimeout(() => abort.abort('owner'), 150);
      },
    });
    const requester = new RequesterClient({
      owner: alice,
      relay,
      approvalProvider: new PolicyAutoApprovalProvider(alice),
      timeoutMs: 10000,
    });
    const pending = worker.start({ once: true });
    const delegation = requester.delegate({
      to: worker.invite(),
      title: 'Cancel me',
      description: 'Loop until cancelled',
      input: { ok: true },
      signal: abort.signal,
      budget: { maxWallClockSeconds: 30 },
    });
    const [settled, rejected] = await Promise.allSettled([pending, delegation]);
    worker.stop();
    expect(settled.status).toBe('fulfilled');
    if (settled.status !== 'fulfilled') return;
    expect(settled.value?.state).toBe('CANCELLED');
    expect(settled.value?.deliverable).toBeNull();
    const bundle = settled.value!.bundle;
    expect(
      verifyAudit(bundle, {
        taskId: bundle.checkpoint.actor.payload.taskId,
        actors: bundle.checkpoint.actor.payload.actors,
      }).valid,
    ).toBe(true);
    expect(bundle.entries.some((entry) => entry.body.eventType === 'CANCEL')).toBe(true);
    const tampered = structuredClone(bundle);
    tampered.entries[0].body.eventType = 'TAMPERED';
    expect(verifyAudit(tampered).valid).toBe(false);
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') expect(String(rejected.reason)).toContain('CANCELLED');
  });
});

describe('Proof 11: encrypted progress and Byzantine quorum', () => {
  it('keeps PROGRESS plaintext off the relay and delivers it to the requester', async () => {
    const secret = 'zk-progress-secret-44aa';
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const traffic: SignedEnvelope[] = [];
    const relay = new InMemoryRelay();
    const send = relay.send.bind(relay);
    relay.send = (envelope) => {
      send(envelope);
      traffic.push(structuredClone(envelope));
    };
    const worker = new WorkerNode({ checkPeer: () => 'trusted',
      owner: bob,
      relay,
      adapter: {
        id: 'progress-echo',
        name: 'Progress echo',
        skills: [],
        executeTask: async (context) => {
          await context.reportProgress?.({
            step: 'draft',
            percent: 40,
            message: secret,
            metrics: { inputTokens: 3, outputTokens: 1, toolInvocations: 0, elapsedMs: 5 },
          });
          return { published: secret, echoed: context.input };
        },
      },
      approvalProvider: new PolicyAutoApprovalProvider(bob),
      timeoutMs: 10000,
    });
    const requester = new RequesterClient({
      owner: alice,
      relay,
      approvalProvider: new PolicyAutoApprovalProvider(alice),
      timeoutMs: 10000,
    });
    const seen: string[] = [];
    const [settled, result] = await Promise.all([
      worker.start({ once: true }),
      requester.delegate({
        to: worker.invite(),
        title: 'Progress',
        description: 'Report a step',
        input: { secret },
        onProgress: (progress, envelope) => {
          seen.push(progress.step + ':' + progress.message);
          expect(envelope.eventType).toBe('PROGRESS');
          expect(envelope.payload.message).toBe(secret);
        },
      }),
    ]);
    worker.stop();
    expect(result.state).toBe('SETTLED');
    expect(settled?.state).toBe('SETTLED');
    expect(seen).toEqual(['draft:' + secret]);
    const progress = traffic.filter((envelope) => envelope.payload.eventType === 'PROGRESS');
    expect(progress.length).toBeGreaterThan(0);
    const visible = traffic.map((envelope) => JSON.stringify(envelope)).join('\n');
    expect(visible).not.toContain(secret);
    for (const envelope of progress)
      expect(isEncryptedEnvelopePayload(envelope.payload.payload)).toBe(true);
    expect(verifyAudit(result.bundle).valid).toBe(true);
    expect(result.bundle.entries.some((entry) => entry.body.eventType === 'PROGRESS')).toBe(true);
  });

  it.each(['settled', 'delivered', 'running'] as const)(
    'outvotes a poisoned worker and keeps every verified receipt with a %s minority',
    async (ordering) => {
      const { result, outcomes, minorityDid } = await quorumWithBarrier(ordering);
      expect(result.status).toBe('SETTLED');
      expect(result.deliverable).toEqual({ tag: 'honest' });
      expect(result.outputDigest).toBe(digest({ tag: 'honest' }));
      expect(result.winners).toHaveLength(2);
      expect(result.winners.every((winner) => winner.workerDid !== minorityDid)).toBe(true);
      expect(result.incompleteReceipts).toEqual([]);
      for (const receipt of result.receipts) expect(verifyAudit(receipt.bundle).valid).toBe(true);
      expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
      expect(outcomes.map((outcome) => outcome.status === 'fulfilled' && outcome.value?.state))
        .toEqual(['SETTLED', 'SETTLED', ordering === 'running' ? 'CANCELLED' : 'SETTLED']);
      if (ordering !== 'running') {
        expect(result.receipts).toHaveLength(3);
        expect(result.receipts.map((receipt) => receipt.deliverable)).toEqual(
          expect.arrayContaining([{ tag: 'honest' }, { tag: 'poison' }]),
        );
        expect(result.cancelled).toEqual([]);
      } else {
        expect(result.receipts).toHaveLength(2);
        expect(result.cancelled).toEqual([minorityDid]);
      }
    },
  );

  it('rejects an invalid minority output without counting it as verified evidence', async () => {
    const { result, outcomes, minorityDid } = await quorumWithBarrier('settled', 'rejected');
    expect(result.deliverable).toEqual({ tag: 'honest' });
    expect(result.receipts).toHaveLength(2);
    expect(result.incompleteReceipts).toEqual([]);
    expect(result.winners.every((winner) => winner.workerDid !== minorityDid)).toBe(true);
    expect(outcomes[2].status).toBe('rejected');
    if (outcomes[2].status === 'rejected') expect(String(outcomes[2].reason)).toContain('VERIFICATION_REJECTED');
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648])(
    'rejects an invalid completion timeout (%s) before starting delegation', async (completionTimeoutMs) => {
      const alice = generateKeyPair();
      const requester = new RequesterClient({ owner: alice, relay: new InMemoryRelay() });
      await expect(requester.delegateMulti({
        workers: [{ workerDid: generateKeyPair().did }], mode: 'quorum', completionTimeoutMs,
        title: 'Quorum', description: 'Validate completion grace', input: {},
      })).rejects.toThrow('INVALID_COMPLETION_TIMEOUT');
    },
  );

  it.each(['missing', 'invalid'] as const)(
    'retains verified minority evidence separately when its checkpoint acknowledgement is %s',
    async (completion) => {
      const { result, outcomes, minorityDid, incompleteErrors } = await quorumWithBarrier('settled', completion);
      expect(result.deliverable).toEqual({ tag: 'honest' });
      expect(result.winners).toHaveLength(2);
      expect(result.receipts).toHaveLength(2);
      expect(result.incompleteReceipts).toHaveLength(1);
      const partial = result.incompleteReceipts[0];
      expect(incompleteErrors).toHaveLength(1);
      expect(incompleteErrors[0]).toBeInstanceOf(IncompleteSettlementError);
      expect(incompleteErrors[0].incompleteReceipt).toBe(partial);
      expect(incompleteErrors[0].cause).toBeInstanceOf(Error);
      expect(partial).toMatchObject({ workerDid: minorityDid, deliverable: { tag: 'poison' },
        outputDigest: digest({ tag: 'poison' }), accepted: true, checkpointComplete: false,
        verification: { accepted: true } });
      expect(partial).not.toHaveProperty('bundle');
      expect(partial.entries.at(-1)?.body.eventType).toBe('SETTLED');
      expect(verifyEnvelope(partial.delivery, partial.delivery.payload.recipientDid)).toBe(true);
      const minority = outcomes[2];
      expect(minority.status).toBe('fulfilled');
      if (minority.status === 'fulfilled') expect(partial.entries).toEqual(minority.value?.bundle.entries);
      expect(partial.completionError).toMatch(completion === 'missing' ? /COMPLETION_TIMEOUT/ : /INVALID/);
      expect(result.cancelled).toEqual([]);
      for (const receipt of result.receipts) expect(verifyAudit(receipt.bundle).valid).toBe(true);
    },
  );
});

/** Hold execution or the last checkpoint until two majority delegates have returned. */
async function quorumWithBarrier(
  ordering: 'settled' | 'delivered' | 'running',
  completion: 'release' | 'missing' | 'invalid' | 'rejected' = 'release',
) {
  const barrier = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  };
  const minorityReady = barrier();
  const majorityComplete = barrier();
  const checkpointReady = barrier();
  const alice = generateKeyPair();
  const keys = [generateKeyPair(), generateKeyPair(), generateKeyPair()];
  const minority = keys[2];
  const relay = new InMemoryRelay();
  const send = relay.send.bind(relay);
  let heldCheckpoint: SignedEnvelope | undefined;
  relay.send = (envelope) => {
    if (envelope.payload.eventType === 'CHECKPOINT_ACK' && envelope.payload.senderDid === minority.did) {
      heldCheckpoint = envelope;
      checkpointReady.resolve();
      minorityReady.resolve();
    } else send(envelope);
  };
  const releaseCheckpoint = majorityComplete.promise.then(async () => {
    if (ordering === 'running' || completion === 'rejected') return;
    await checkpointReady.promise;
    if (!heldCheckpoint || completion === 'missing') return;
    if (completion === 'invalid') {
      send(signEnvelope({ ...heldCheckpoint.payload, payload: {} }, minority, { encrypt: true }));
    } else send(heldCheckpoint);
  });
  const workers = keys.map((owner, index) => new WorkerNode({ checkPeer: () => 'trusted',
    owner, relay, timeoutMs: 10000,
    approvalProvider: new PolicyAutoApprovalProvider(owner),
    onEvent: (event) => {
      if (index === 2 && event === 'REJECTED') minorityReady.resolve();
    },
    adapter: {
      id: 'barrier', name: 'barrier', skills: [],
      executeTask: async (context) => {
        if (index < 2) await minorityReady.promise;
        else if (ordering === 'running') {
          minorityReady.resolve();
          await new Promise<never>((_, reject) => {
            const abort = () => reject(context.signal.reason);
            context.signal.addEventListener('abort', abort, { once: true });
            if (context.signal.aborted) abort();
          });
        }
        return { tag: index < 2 ? 'honest' : 'poison' };
      },
    },
  }));
  const approvals = new PolicyAutoApprovalProvider(alice);
  const requester = new RequesterClient({ owner: alice, relay, timeoutMs: 10000,
    approvalProvider: { approve: async (request) => {
      const delivery = request.target as Delivery;
      if (ordering === 'delivered' && request.gate === 'final_verification' &&
          (delivery.artifact.payload.data as { tag: string }).tag === 'poison') {
        minorityReady.resolve();
        await majorityComplete.promise;
      }
      return approvals.approve(request);
    } } });
  const delegate = requester.delegate.bind(requester);
  let majorityReceipts = 0;
  const incompleteErrors: IncompleteSettlementError[] = [];
  const spy = vi.spyOn(requester, 'delegate').mockImplementation((options, hooks) => {
    const pending = delegate(options, hooks);
    // Register before delegateMulti awaits pending. Resolving the barrier queues its
    // release after delegateMulti's receipt/selection continuation on the same promise.
    void pending.then((result) => {
      if (result.deliverable && (result.deliverable as { tag?: string }).tag === 'honest' &&
          ++majorityReceipts === 2) majorityComplete.resolve();
    }, (error) => {
      if (error instanceof IncompleteSettlementError) incompleteErrors.push(error);
    });
    return pending;
  });
  const pending = Promise.allSettled(workers.map((worker) => worker.start({ once: true })));
  try {
    const result = await requester.delegateMulti({
      workers: workers.map((worker) => ({ workerDid: worker.options.owner.did, inviteToken: worker.invite() })),
      mode: 'quorum', quorumSize: 2, completionTimeoutMs: 100,
      title: 'Quorum', description: 'Agree on the tag', input: { ok: true },
      outputSchema: completion === 'rejected' ? {
        type: 'object', required: ['tag'], properties: { tag: { const: 'honest' } },
      } : undefined,
    });
    await releaseCheckpoint;
    return { result, outcomes: await pending, minorityDid: minority.did, incompleteErrors };
  } finally {
    minorityReady.resolve();
    majorityComplete.resolve();
    checkpointReady.resolve();
    try {
      await releaseCheckpoint;
    } finally {
      for (const worker of workers) worker.stop();
      await pending;
      spy.mockRestore();
    }
  }
}

async function signedDelivery(
  owner: KeyPair,
  worker: KeyPair,
  options: { isolation: string; requireOci: boolean },
): Promise<{
  contract: ReturnType<typeof createContract>;
  envelope: SignedEnvelope;
  gate: ApprovalGate;
  approval: ReturnType<typeof signApproval>;
}> {
  const manifest = manifestFor(owner, worker, {
    type: 'object',
    additionalProperties: false,
    required: ['ok'],
    properties: { ok: { type: 'boolean' } },
  });
  if (options.requireOci) manifest.sandboxPolicy.isolationLevel = 'oci_container';
  const contract = createContract(manifest, signPayload(manifest, owner), worker);
  const usage = signUsage(
    {
      type: 'UsageReceipt',
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
    { ok: true },
    usage,
    worker,
    {
      effectiveIsolationLevel: options.isolation,
    },
  );
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
  return {
    contract,
    envelope,
    gate: new ApprovalGate(owner.did, { requiredGates: [], autoApprove: [] }),
    approval: signApproval(manifest.taskId, 'final_verification', delivery, owner),
  };
}

function rewrap(
  honest: { contract: ReturnType<typeof createContract> },
  delivery: Delivery,
  worker: KeyPair,
  seq: number,
): SignedEnvelope {
  return signEnvelope(
    {
      taskId: honest.contract.manifest.taskId,
      recipientDid: honest.contract.manifest.requester.ownerDid,
      seq,
      eventType: 'DELIVER',
      payload: delivery as unknown as Json,
    },
    worker,
  );
}
