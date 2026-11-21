// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { generateKeyPair, verifySigned } from '../packages/core/src/index.js';
import { createRelayFetchHandler } from '../packages/relay/src/index.js';
import {
  PasskeyApprovalBroker,
  decryptApproval,
  encryptApproval,
  approvalChallenge,
} from '../packages/runtime/src/passkey-approval.js';
import type { ApprovalLink } from '../packages/runtime/src/passkey-approval.js';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { WorkerNode, RequesterClient, buildTaskManifest } from '../packages/runtime/src/session.js';
import {
  passkeyTaskReasons,
  DEFAULT_PASSKEY_INPUT_BYTES,
} from '../packages/runtime/src/auto-accept.js';
import { PasskeyApprovalProvider } from '../packages/runtime/src/passkey-approval.js';
import { PolicyAutoApprovalProvider } from '../packages/runtime/src/approval-providers.js';
import { InMemoryRelay, startLocalRelay } from '../packages/relay/src/index.js';
import { AcpMcpServer } from '../packages/runtime/src/mcp-server.js';
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest();
const b64 = (s: Uint8Array) => Buffer.from(s).toString('base64url');
const dirs: string[] = [];
const enrollmentBrokers: PasskeyApprovalBroker[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const broker of enrollmentBrokers.splice(0)) broker.stopWorkerEnrollment();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function authenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }),
    id = randomBytes(32);
  const rpHash = sha('sealbridge.app');
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]),
  );
  const client = (type: string, challenge: string) =>
    Buffer.from(
      JSON.stringify({ type, challenge, origin: 'https://sealbridge.app', crossOrigin: false }),
    );
  return {
    register(challenge: string): RegistrationResponseJSON {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(id.length);
      const authData = Buffer.concat([
        rpHash,
        Buffer.from([0x45]),
        Buffer.alloc(4),
        Buffer.alloc(16),
        length,
        id,
        Buffer.from(cose),
      ]);
      return {
        id: b64(id),
        rawId: b64(id),
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64(client('webauthn.create', challenge)),
          attestationObject: b64(
            isoCBOR.encode(
              new Map<string, string | Uint8Array | Map<string, string>>([
                ['fmt', 'none'],
                ['attStmt', new Map()],
                ['authData', authData],
              ]),
            ),
          ),
          transports: ['internal'],
        },
      };
    },
    assert(challenge: string, flags = 5): AuthenticationResponseJSON {
      const data = client('webauthn.get', challenge),
        authData = Buffer.concat([rpHash, Buffer.from([flags]), Buffer.alloc(4)]);
      return {
        id: b64(id),
        rawId: b64(id),
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64(data),
          authenticatorData: b64(authData),
          signature: b64(sign('sha256', Buffer.concat([authData, sha(data)]), privateKey)),
        },
      };
    },
  };
}
function fixture(extra: Partial<ConstructorParameters<typeof PasskeyApprovalBroker>[1]> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'sealbridge-passkey-'));
  dirs.push(home);
  const owner = generateKeyPair(),
    handler = createRelayFetchHandler();
  const fetcher = vi.fn((async (input, init) => handler(new Request(input, init))) as typeof fetch);
  const broker = new PasskeyApprovalBroker(owner, {
    env: { SEALBRIDGE_DATA_DIR: home },
    relay: 'https://relay.example',
    fetch: fetcher,
    ...extra,
  });
  broker.startWorkerEnrollment();
  enrollmentBrokers.push(broker);
  async function open(link: ApprovalLink) {
    const params = new URL(link.link).hash.slice(1),
      q = new URLSearchParams(params),
      key = Buffer.from(q.get('key')!, 'base64url');
    const access = b64(sha(Buffer.concat([key, Buffer.from('access')])));
    const response = await fetcher('https://relay.example/v1/approvals/' + link.id, {
      headers: { authorization: 'Bearer ' + access },
    });
    const request = decryptApproval(
      key,
      link.id,
      ((await response.json()) as { request: string }).request,
    ) as { challenge: string; details: unknown };
    return { request, key, access, seal: (value: unknown) => encryptApproval(key, link.id, value) };
  }
  async function register(auth = authenticator()) {
    const link = await broker.requestRegistration(),
      opened = await open(link);
    await broker.acceptResult(
      link.id,
      opened.seal({
        id: link.id,
        decision: 'approve',
        registration: auth.register(opened.request.challenge),
      }),
    );
    return auth;
  }
  const approval = (taskId = 'task-A', deadline = new Date(Date.now() + 60000).toISOString()) =>
    broker.requestApproval({
      taskId,
      gate: 'contract_acceptance',
      target: { taskId },
      deadline,
      details: {
        manifest: { deadline },
        input: { command: 'write reviewed file' },
        approvalReasons: ['write'],
      },
    });
  return { broker, owner, open, register, approval, fetcher };
}
describe('encrypted owner passkey approval', () => {
  it('accepts a first key inside the worker window and emits a registration notice once', async () => {
    const notice = vi.fn(),
      f = fixture({ onRegistered: notice });
    const state = f.broker.enrollmentStatus();
    expect(state).toMatchObject({ registered: false, open: true });
    vi.spyOn(Date, 'now').mockReturnValue(state.expiresAt! - 1);
    await f.register();
    f.broker.checkRegistrationNotices();
    expect(notice).toHaveBeenCalledTimes(1);
    expect(f.broker.enrollmentStatus()).toEqual({ registered: true, open: false });
  });
  it('rejects first registration outside the worker window, including MCP attempts to reopen it', async () => {
    const f = fixture(),
      state = f.broker.enrollmentStatus(),
      link = await f.broker.requestRegistration(),
      o = await f.open(link),
      auth = authenticator();
    expect(link.expiresAt).toBe(state.expiresAt);
    const response = o.seal({
      id: link.id,
      decision: 'approve',
      registration: auth.register(o.request.challenge),
    });
    vi.spyOn(Date, 'now').mockReturnValue(state.expiresAt! + 1);
    await expect(f.broker.acceptResult(link.id, response)).rejects.toThrow('APPROVAL_EXPIRED');
    await expect(f.broker.requestRegistration()).rejects.toThrow('PASSKEY_ENROLLMENT_CLOSED');
    const server = new AcpMcpServer({
      owner: f.owner,
      identityOptions: f.broker.options,
      relay: 'https://relay.example',
      fetch: f.fetcher,
      allowAnyRelay: true,
    });
    try {
      const before = f.fetcher.mock.calls.length;
      const result = (await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'acp_owner_approval', arguments: { action: 'register' } },
      })) as { result: { content: { text: string }[] } };
      expect(JSON.parse(result.result.content[0].text)).toMatchObject({
        status: 'registration_window_closed',
        enrollment: {
          open: false,
          message: expect.stringContaining('No passkey is registered yet'),
        },
      });
      expect(f.fetcher.mock.calls).toHaveLength(before);
      expect(f.broker.listCredentials()).toHaveLength(0);
    } finally {
      server.stopDelivery();
    }
  });
  it('only a worker restart reopens bootstrap with zero keys; it never opens after enrollment', async () => {
    const f = fixture(),
      first = f.broker.enrollmentStatus();
    vi.spyOn(Date, 'now').mockReturnValue(first.expiresAt! + 1);
    const standalone = new PasskeyApprovalBroker(f.owner, f.broker.options);
    expect(standalone.enrollmentStatus().open).toBe(false);
    f.broker.stopWorkerEnrollment();
    f.broker.startWorkerEnrollment();
    const next = f.broker.enrollmentStatus();
    expect(next.open).toBe(true);
    expect(next.id).not.toBe(first.id);
    await f.register();
    f.broker.stopWorkerEnrollment();
    f.broker.startWorkerEnrollment();
    expect(f.broker.enrollmentStatus()).toEqual({ registered: true, open: false });
    const saved = readFileSync(join(f.broker.directory, 'registry.json'));
    try {
      rmSync(join(f.broker.directory, 'registry.json'));
      expect(() => f.broker.startWorkerEnrollment()).toThrow('PASSKEY_STATE_INVALID');
    } finally {
      writeFileSync(join(f.broker.directory, 'registry.json'), saved);
    }
  });
  it('deduplicates concurrent registration requests instead of filling the pending cap', async () => {
    const f = fixture(),
      links = await Promise.all(Array.from({ length: 140 }, () => f.broker.requestRegistration()));
    expect(new Set(links.map((l) => l.id)).size).toBe(1);
    expect(f.broker.listPending()).toHaveLength(1);
  });

  it('drains junk candidates with a private worker capability and accepts a later valid decision', async () => {
    const f = fixture(),
      auth = await f.register(),
      link = await f.approval(),
      o = await f.open(link);
    const url = 'https://relay.example/v1/approvals/' + link.id + '/results',
      headers = { authorization: 'Bearer ' + o.access, 'content-type': 'application/json' };
    for (let i = 0; i < 40; i++)
      expect(
        (
          await f.fetcher(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ result: 'junk-' + i }),
          })
        ).status,
      ).toBe(200);
    expect(await f.broker.poll(link.id)).toBeUndefined();
    expect(await (await f.fetcher(url, { headers })).json()).toEqual({ results: [] });
    const result = o.seal({
      id: link.id,
      decision: 'approve',
      assertion: auth.assert(o.request.challenge),
    });
    expect(
      (await f.fetcher(url, { method: 'POST', headers, body: JSON.stringify({ result }) })).status,
    ).toBe(200);
    expect(await f.broker.poll(link.id)).toBe('approved');
  });
  it('continues automatic read-only work with no key after the enrollment window closes', async () => {
    const f = fixture(),
      relay = new InMemoryRelay(),
      provider = new PasskeyApprovalProvider(f.broker);
    f.broker.stopWorkerEnrollment();
    const worker = new WorkerNode({
      owner: f.owner,
      relay,
      relayUrl: 'https://relay.example',
      identityOptions: f.broker.options,
      approvalProvider: provider,
      ownerApprovalProvider: provider,
      adapter: {
        id: 'sandbox',
        name: 'read-only',
        skills: [],
        taskAccess: 'read-only',
        executeTask: async (ctx) => ctx.input,
      },
    });
    const running = worker.start();
    try {
      await vi.waitFor(() => expect(f.broker.enrollmentStatus().open).toBe(true));
      f.broker.stopWorkerEnrollment();
      expect(f.broker.enrollmentStatus().open).toBe(false);
      const owner = generateKeyPair(),
        client = new RequesterClient({
          owner,
          relay,
          identityOptions: f.broker.options,
          approvalProvider: new PolicyAutoApprovalProvider(owner),
          waitTimeoutMs: 10000,
        });
      expect(
        (
          await client.delegate({
            to: worker.invite(),
            title: 'Read',
            description: 'Read only with bootstrap closed',
            input: { ok: true },
          })
        ).state,
      ).toBe('SETTLED');
      expect(f.broker.listCredentials()).toHaveLength(0);
      expect(f.broker.enrollmentStatus().open).toBe(false);
    } finally {
      worker.stop();
      await running;
    }
  });
  it('MCP returns a registration link immediately, lists private pending links, and verifies results', async () => {
    const f = fixture(),
      server = new AcpMcpServer({
        owner: f.owner,
        identityOptions: f.broker.options,
        relay: 'https://relay.example',
        fetch: f.fetcher,
        allowAnyRelay: true,
      });
    const call = async (args: Record<string, unknown>) => {
      const rpc = (await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'acp_owner_approval', arguments: args },
      })) as { result: { isError?: boolean; content: { text: string }[] } };
      expect(rpc.result.isError).not.toBe(true);
      return JSON.parse(rpc.result.content[0].text);
    };
    try {
      const link = await call({ action: 'register' }),
        o = await f.open(link),
        auth = authenticator();
      expect((await call({ action: 'list' })).pending[0]).toMatchObject({
        id: link.id,
        link: link.link,
      });
      await f.broker.acceptResult(
        link.id,
        o.seal({
          id: link.id,
          decision: 'approve',
          registration: auth.register(o.request.challenge),
        }),
      );
      expect(await call({ action: 'poll', id: link.id })).toEqual({ status: 'registered' });
      const listed = await call({ action: 'list' });
      expect(listed.credentials).toHaveLength(1);
      expect(listed.pending).toHaveLength(0);
    } finally {
      server.stopDelivery();
    }
  });
  it('MCP relay restrictions apply before any approval request is sent', async () => {
    const f = fixture(),
      server = new AcpMcpServer({
        owner: f.owner,
        identityOptions: f.broker.options,
        relay: 'https://relay.example',
        fetch: f.fetcher,
        allowedRelayUrls: ['https://relay.example'],
      });
    try {
      const rpc = (await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'acp_owner_approval',
          arguments: { action: 'register', relayUrl: 'https://other.example' },
        },
      })) as { result: { isError?: boolean } };
      expect(rpc.result.isError).toBe(true);
      expect(f.fetcher).not.toHaveBeenCalled();
    } finally {
      server.stopDelivery();
    }
  });
  it('separates write, money, and the default size threshold from read-only automatic work', () => {
    const owner = generateKeyPair(),
      manifest = buildTaskManifest({
        ownerDid: owner.did,
        workerDid: owner.did,
        title: 'Read',
        description: 'Read JSON',
      });
    manifest.verification.checks = [];
    manifest.permissions.maxDelegationDepth = 0;
    manifest.permissions.grantedCapabilities = [];
    const context = {
      manifest,
      connected: true,
      invited: true,
      adapter: {
        id: 'sandbox',
        name: 'read',
        skills: [],
        taskAccess: 'read-only' as const,
        executeTask: async () => ({}),
      },
      tools: {},
    };
    expect(passkeyTaskReasons(context, {})).toEqual([]);
    expect(passkeyTaskReasons(context, 'x'.repeat(DEFAULT_PASSKEY_INPUT_BYTES - 2))).toEqual([]);
    expect(passkeyTaskReasons(context, 'x'.repeat(DEFAULT_PASSKEY_INPUT_BYTES - 1))).toEqual([
      'size',
    ]);
    expect(
      passkeyTaskReasons({ ...context, adapter: { ...context.adapter, id: 'openai' } }, {}),
    ).toEqual(['money']);
    expect(
      passkeyTaskReasons(
        { ...context, adapter: { ...context.adapter, id: 'codex', taskAccess: 'write' } },
        {},
      ),
    ).toEqual(['write']);
  });
  it('compiled non-TTY worker waits for the encrypted relay result, then executes once', async () => {
    const f = fixture(),
      local = await startLocalRelay();
    const notifications = join(f.broker.directory, 'notifications.jsonl'),
      script = join(f.broker.directory, 'notify.cjs');
    writeFileSync(
      script,
      `require('node:fs').appendFileSync(${JSON.stringify(notifications)},require('node:fs').readFileSync(0));`,
    );
    const key = join(f.broker.directory, 'worker.private.json');
    writeFileSync(key, JSON.stringify(f.owner), { mode: 0o600 });
    const child = spawn(
      process.execPath,
      [
        resolve('cli/dist/index.js'),
        'worker',
        'start',
        '--key',
        key,
        '--relay',
        local.url,
        '--share',
        'token',
        '--allow-private-relay',
        '--allow-local-pc',
        '--adapter',
        'command',
        '--cmd',
        `"${process.execPath}" "${resolve('conformance/fixtures/json-echo.cjs')}"`,
        '--notify',
        `"${process.execPath}" "${script}"`,
        '--once',
      ],
      { env: { ...process.env, ...f.broker.options.env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (b) => {
      stdout += b;
    });
    child.stderr.on('data', (b) => {
      stderr += b;
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const controller = new AbortController();
    let task: ReturnType<RequesterClient['delegate']> | undefined;
    try {
      await vi.waitFor(() => expect(stdout).toContain('acp-invite:'), { timeout: 10000 });
      await vi.waitFor(() => expect(stderr).toContain('No passkey is registered yet'), {
        timeout: 10000,
      });
      const auth = await f.register();
      await vi.waitFor(() => expect(stderr).toContain('passkey_registered'), { timeout: 10000 });
      await vi.waitFor(
        () => expect(readFileSync(notifications, 'utf8')).toContain('passkey_registered'),
        { timeout: 10000 },
      );
      const requester = generateKeyPair(),
        client = new RequesterClient({
          owner: requester,
          relay: local.relay,
          allowPrivateRelay: true,
          identityOptions: f.broker.options,
          approvalProvider: new PolicyAutoApprovalProvider(requester),
          taskTimeoutMs: 60000,
          waitTimeoutMs: 30000,
        });
      task = client.delegate({
        to: stdout.trim().split(/\r?\n/)[0],
        title: 'Reviewed write',
        description: 'Echo only after owner approval',
        input: { reviewed: true },
        signal: controller.signal,
      });
      void task.catch(() => {});
      await vi.waitFor(() => expect(stderr).toContain('approval_needed'), { timeout: 10000 });
      const link = f.broker.listPending().find((p) => p.kind === 'task')!;
      expect(link).toBeDefined();
      expect(stderr).not.toContain('Approve [y/N]');
      expect(stderr).not.toContain('"event":"IN_PROGRESS"');
      const pending = JSON.parse(
        readFileSync(join(f.broker.directory, link.id + '.json'), 'utf8'),
      ).payload;
      expect(stderr).not.toContain(pending.key);
      expect(stderr).not.toContain('/approve#');
      const headers = {
        authorization: 'Bearer ' + pending.access,
        'content-type': 'application/json',
      };
      const encrypted = (await (
        await fetch(local.url + '/v1/approvals/' + link.id, { headers })
      ).json()) as { request: string };
      const request = decryptApproval(
        Buffer.from(pending.key, 'base64url'),
        link.id,
        encrypted.request,
      ) as { challenge: string };
      const result = encryptApproval(Buffer.from(pending.key, 'base64url'), link.id, {
        id: link.id,
        decision: 'approve',
        assertion: auth.assert(request.challenge),
      });
      expect(
        (
          await fetch(local.url + '/v1/approvals/' + link.id + '/results', {
            method: 'POST',
            headers,
            body: JSON.stringify({ result }),
          })
        ).ok,
      ).toBe(true);
      expect((await task).state).toBe('SETTLED');
      expect(await closed).toBe(0);
    } finally {
      controller.abort();
      child.kill();
      await closed;
      await Promise.allSettled(task ? [task] : []);
      await local.close();
    }
  }, 40000);
  it('trusts first registration, and opening a task without a passkey approves nothing', async () => {
    const f = fixture(),
      auth = await f.register(),
      link = await f.approval(),
      opened = await f.open(link);
    expect(f.broker.listCredentials()).toHaveLength(1);
    expect(await f.broker.poll(link.id)).toBeUndefined();
    await expect(
      f.broker.acceptResult(link.id, opened.seal({ id: link.id, decision: 'approve' })),
    ).rejects.toThrow('PASSKEY_REQUIRED');
    const binding = (await import('../packages/core/src/owner-approval.js')).ownerApprovalBinding;
    const challenge = approvalChallenge(link.id, 'approve', binding(opened.request));
    await expect(
      f.broker.acceptResult(
        link.id,
        opened.seal({ id: link.id, decision: 'approve', assertion: auth.assert(challenge, 1) }),
      ),
    ).rejects.toThrow();
    const modified = { ...opened.request, details: { input: 'different task' } };
    await expect(
      f.broker.acceptResult(
        link.id,
        opened.seal({
          id: link.id,
          decision: 'approve',
          assertion: auth.assert(approvalChallenge(link.id, 'approve', binding(modified))),
        }),
      ),
    ).rejects.toThrow();
    const result = opened.seal({
      id: link.id,
      decision: 'approve',
      assertion: auth.assert(challenge),
    });
    expect(await f.broker.acceptResult(link.id, result)).toBe('approved');
    await expect(f.broker.acceptResult(link.id, result)).rejects.toThrow('APPROVAL_REPLAY');
    expect(
      f.fetcher.mock.calls.every(([url]) => String(url).startsWith('https://relay.example/')),
    ).toBe(true);
  });
  it('rejects forged signatures and task substitution, then accepts the exact original task', async () => {
    const f = fixture(),
      auth = await f.register(),
      a = await f.approval(),
      b = await f.approval('task-B');
    const oa = await f.open(a),
      ob = await f.open(b);
    const assertion = auth.assert(oa.request.challenge);
    await expect(
      f.broker.acceptResult(b.id, ob.seal({ id: b.id, decision: 'approve', assertion })),
    ).rejects.toThrow();
    const forged = authenticator().assert(oa.request.challenge);
    forged.id = assertion.id;
    await expect(
      f.broker.acceptResult(a.id, oa.seal({ id: a.id, decision: 'approve', assertion: forged })),
    ).rejects.toThrow();
    expect(
      await f.broker.acceptResult(a.id, oa.seal({ id: a.id, decision: 'approve', assertion })),
    ).toBe('approved');
    expect(await f.broker.poll(b.id)).toBeUndefined();
  });
  it('rejects expired tasks and fails closed on second registration without existing approval', async () => {
    const f = fixture();
    await f.register();
    const link = await f.broker.requestRegistration(),
      opened = await f.open(link),
      newAuth = authenticator();
    await expect(
      f.broker.acceptResult(
        link.id,
        opened.seal({
          id: link.id,
          decision: 'approve',
          registration: newAuth.register(opened.request.challenge),
        }),
      ),
    ).rejects.toThrow('EXISTING_PASSKEY_APPROVAL_REQUIRED');
    expect(f.broker.listCredentials()).toHaveLength(1);
    await expect(f.approval('expired', new Date(Date.now() - 1).toISOString())).rejects.toThrow(
      'APPROVAL_EXPIRED',
    );
    const task = await f.approval(),
      ot = await f.open(task);
    vi.spyOn(Date, 'now').mockReturnValue(task.expiresAt + 1);
    await expect(
      f.broker.acceptResult(task.id, ot.seal({ id: task.id, decision: 'approve' })),
    ).rejects.toThrow('APPROVAL_EXPIRED');
  });
  it('authorizes a second credential only with a signature committing to that new credential', async () => {
    const f = fixture(),
      existing = await f.register(),
      next = authenticator(),
      link = await f.broker.requestRegistration(),
      o = await f.open(link);
    const registration = next.register(o.request.challenge);
    const { ownerApprovalBinding } = await import('../packages/core/src/owner-approval.js');
    const assertion = existing.assert(
      approvalChallenge(
        link.id,
        'register:' + b64(sha(JSON.stringify(registration))),
        ownerApprovalBinding(o.request),
      ),
    );
    expect(
      await f.broker.acceptResult(
        link.id,
        o.seal({ id: link.id, decision: 'approve', registration, assertion }),
      ),
    ).toBe('registered');
    expect(f.broker.listCredentials()).toHaveLength(2);
  });
  it('returns owner signatures only after verified passkey approval', async () => {
    const f = fixture(),
      auth = await f.register();
    const pending = f.broker.approve({
      taskId: 'signed',
      gate: 'contract_acceptance',
      target: { write: true },
      deadline: new Date(Date.now() + 60000).toISOString(),
    });
    // Request creation awaits relay admission; wait only on the local in-memory fixture.
    await vi.waitFor(() => expect(f.broker.listPending()).toHaveLength(1));
    const link = f.broker.listPending()[0],
      o = await f.open(link);
    await f.broker.acceptResult(
      link.id,
      o.seal({ id: link.id, decision: 'approve', assertion: auth.assert(o.request.challenge) }),
    );
    expect(verifySigned(await pending, f.owner.did)).toBe(true);
  });
  it('holds a live invited write task without a terminal, then starts only after exact passkey approval', async () => {
    const f = fixture(),
      auth = await f.register(),
      relay = new InMemoryRelay();
    const provider = new PasskeyApprovalProvider(f.broker);
    let executions = 0;
    const worker = new WorkerNode({
      owner: f.owner,
      relay,
      relayUrl: 'https://relay.example',
      identityOptions: f.broker.options,
      ownerApprovalProvider: provider,
      approvalProvider: provider,
      taskTimeoutMs: 60000,
      waitTimeoutMs: 30000,
      adapter: {
        id: 'write-test',
        name: 'write',
        skills: [],
        taskAccess: 'write',
        executeTask: async () => {
          executions++;
          return { done: true };
        },
      },
    });
    const clientOwner = generateKeyPair(),
      client = new RequesterClient({
        owner: clientOwner,
        relay,
        identityOptions: f.broker.options,
        approvalProvider: new PolicyAutoApprovalProvider(clientOwner),
        taskTimeoutMs: 60000,
        waitTimeoutMs: 30000,
      });
    const running = worker.start();
    let task: ReturnType<RequesterClient['delegate']> | undefined;
    try {
      task = client.delegate({
        to: worker.invite(),
        title: 'Write one file',
        description: 'Owner reviews this write',
        input: { path: 'reviewed.txt' },
      });
      void task.catch(() => {});
      await vi.waitFor(() => expect(f.broker.listPending()).toHaveLength(1), { timeout: 10000 });
      expect(executions).toBe(0);
      const link = f.broker.listPending()[0],
        o = await f.open(link);
      expect((o.request.details as { approvalReasons: string[] }).approvalReasons).toContain(
        'write',
      );
      await f.broker.acceptResult(
        link.id,
        o.seal({ id: link.id, decision: 'approve', assertion: auth.assert(o.request.challenge) }),
      );
      expect((await task).state).toBe('SETTLED');
      expect(executions).toBe(1);
    } finally {
      worker.stop();
      await Promise.allSettled([running, ...(task ? [task] : [])]);
    }
  }, 40000);
  it('reserves paid-only maximum budgets atomically within the UTC monthly cap; missing caps and unknown prices ask the owner', async () => {
    const f = fixture({ paid: { model: 'gpt-6-luna', maxMonthlyUsd: 0.001 } });
    const request = {
      taskId: 'paid-one',
      gate: 'contract_acceptance' as const,
      target: { paid: true },
      details: {
        input: { text: 'hello' },
        manifest: {
          permissions: { maxDelegationDepth: 0, grantedCapabilities: [] },
          budget: { maxInputTokens: 1000, maxOutputTokens: 1000 },
        },
      },
    };
    expect(verifySigned(await f.broker.approve(request), f.owner.did)).toBe(true);
    await expect(f.broker.approve(request)).rejects.toThrow('PAID_TASK_REPLAY');
    // Another broker with the same owner/data root sees the same reservation.
    const other = new PasskeyApprovalBroker(f.owner, f.broker.options);
    const pending = other
      .approve({ ...request, taskId: 'paid-two', signal: AbortSignal.timeout(300) })
      .catch((e) => e);
    await vi.waitFor(() =>
      expect(other.listPending().some((l) => l.kind === 'registration')).toBe(true),
    );
    expect(await pending).toBeInstanceOf(Error);
    for (const paid of [{ model: 'gpt-6-luna' }, { model: 'unknown-model', maxMonthlyUsd: 10 }]) {
      const g = fixture({ paid });
      const held = g.broker
        .approve({ ...request, signal: AbortSignal.timeout(300) })
        .catch((e) => e);
      await vi.waitFor(() => expect(g.broker.listPending()).toHaveLength(1));
      expect(await held).toBeInstanceOf(Error);
    }
  });
});
