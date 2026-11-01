// SPDX-License-Identifier: Apache-2.0
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  createRevocationNotice,
  digest,
  generateKeyPair,
  inviteRevocationId,
  parseAndVerifyInviteToken,
  verifyRevocationNotice,
} from '../packages/core/src/index.js';
import { RevocationRegistry } from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import {
  AcpMcpServer,
  PolicyAutoApprovalProvider,
  RequesterClient,
  WorkerNode,
} from '../packages/runtime/src/index.js';
import type { Json } from '../packages/core/src/index.js';

function echoWorker(
  ownerDidKey: ReturnType<typeof generateKeyPair>,
  relay: InMemoryRelay,
  tag: string,
  delayMs = 0,
) {
  return new WorkerNode({
    owner: ownerDidKey,
    relay,
    adapter: {
      id: tag,
      name: tag,
      skills: [],
      executeTask: async (context) => {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { tag, input: context.input };
      },
    },
    approvalProvider: new PolicyAutoApprovalProvider(ownerDidKey),
    timeoutMs: 10000,
  });
}

describe('revocation registry', () => {
  it('round-trips notices and rejects a non-issuer', () => {
    const issuer = generateKeyPair();
    const other = generateKeyPair();
    const registry = new RevocationRegistry();
    const notice = createRevocationNotice(
      { targetType: 'capability', targetId: 'cap-1', reason: 'rotated' },
      issuer,
    );
    expect(verifyRevocationNotice(notice, issuer.did)).toBe(true);
    registry.revoke(notice);
    const copy = new RevocationRegistry();
    copy.importNotices(registry.exportNotices());
    expect(() => copy.assertNotRevoked('capability', 'cap-1')).toThrow('TOKEN_REVOKED');
    const forged = createRevocationNotice(
      { targetType: 'capability', targetId: 'cap-1', reason: 'stolen' },
      other,
    );
    expect(verifyRevocationNotice(forged, issuer.did)).toBe(false);
    expect(() => copy.revoke(forged, issuer.did)).toThrow('INVALID_REVOCATION');
    expect(copy.isRevoked('capability', 'other')).toBe(false);
  });
});

describe('progress streaming and multi-worker delegation', () => {
  it('reports progress before delivery and enforces intermediate quota', async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const relay = new InMemoryRelay();
    const worker = new WorkerNode({
      owner: bob,
      relay,
      adapter: {
        id: 'progress',
        name: 'progress',
        skills: [],
        executeTask: async (context) => {
          await context.reportProgress?.({ step: 'half', percent: 50, message: 'working' });
          return { ok: true };
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
    const steps: string[] = [];
    const pending = worker.start({ once: true });
    const result = await requester.delegate(
      {
        to: worker.invite(),
        title: 'Progress',
        description: 'Step',
        input: { n: 1 },
      },
      {
        onProgress: (progress) => {
          steps.push(progress.step);
        },
      },
    );
    expect((await pending)?.state).toBe('SETTLED');
    worker.stop();
    expect(steps).toEqual(['half']);
    expect(result.deliverable).toEqual({ ok: true });
    expect(result.bundle.entries.some((entry) => entry.body.eventType === 'PROGRESS')).toBe(true);

    const limited = new WorkerNode({
      owner: bob,
      relay,
      adapter: {
        id: 'over',
        name: 'over',
        skills: [],
        executeTask: async (context) => {
          await context.reportProgress?.({ step: 'too-big', metrics: { inputTokens: 100000 } });
          return { ok: true };
        },
      },
      approvalProvider: new PolicyAutoApprovalProvider(bob),
      timeoutMs: 10000,
    });
    const again = limited.start({ once: true });
    const [workerResult, requesterResult] = await Promise.allSettled([
      again,
      requester.delegate({
        to: limited.invite(),
        title: 'Over budget',
        description: 'Stop',
        input: {},
        budget: { maxInputTokens: 10 },
      }),
    ]);
    limited.stop();
    expect(requesterResult.status).toBe('rejected');
    if (requesterResult.status === 'rejected')
      expect(String(requesterResult.reason)).toContain('BUDGET');
    expect(workerResult.status).toBe('rejected');
    if (workerResult.status === 'rejected') expect(String(workerResult.reason)).toContain('BUDGET');
  });

  it('races workers and cancels the slower session', async () => {
    const alice = generateKeyPair();
    const fastKey = generateKeyPair();
    const slowKey = generateKeyPair();
    const relay = new InMemoryRelay();
    const fast = echoWorker(fastKey, relay, 'fast', 0);
    const slow = echoWorker(slowKey, relay, 'slow', 400);
    const requester = new RequesterClient({
      owner: alice,
      relay,
      approvalProvider: new PolicyAutoApprovalProvider(alice),
      timeoutMs: 10000,
    });
    const pending = Promise.all([fast.start({ once: true }), slow.start({ once: true })]);
    const result = await requester.delegateMulti({
      workers: [
        { workerDid: fastKey.did, inviteToken: fast.invite() },
        { workerDid: slowKey.did, inviteToken: slow.invite() },
      ],
      mode: 'race',
      title: 'Race',
      description: 'First verified result',
      input: { n: 1 },
    });
    const settled = await pending;
    fast.stop();
    slow.stop();
    expect(result.mode).toBe('race');
    expect(result.deliverable).toEqual({ tag: 'fast', input: { n: 1 } });
    expect(result.winners).toEqual([
      {
        workerDid: fastKey.did,
        taskId: result.winners[0].taskId,
        outputDigest: digest({ tag: 'fast', input: { n: 1 } }),
      },
    ]);
    expect(settled[0]?.state).toBe('SETTLED');
    expect(settled[1]?.state).toBe('CANCELLED');
    expect(result.cancelled).toContain(slowKey.did);
  });

  it('returns QUORUM_NOT_REACHED when verified outputs disagree', async () => {
    const alice = generateKeyPair();
    const left = generateKeyPair();
    const right = generateKeyPair();
    const relay = new InMemoryRelay();
    const workers = [echoWorker(left, relay, 'left'), echoWorker(right, relay, 'right')];
    const requester = new RequesterClient({
      owner: alice,
      relay,
      approvalProvider: new PolicyAutoApprovalProvider(alice),
      timeoutMs: 10000,
    });
    const pending = Promise.all(workers.map((worker) => worker.start({ once: true })));
    await expect(
      requester.delegateMulti({
        workers: workers.map((worker) => ({
          workerDid: worker.options.owner.did,
          inviteToken: worker.invite(),
        })),
        mode: 'quorum',
        quorumSize: 2,
        title: 'Split',
        description: 'No majority',
        input: {},
      }),
    ).rejects.toThrow('QUORUM_NOT_REACHED');
    await pending;
    for (const worker of workers) worker.stop();
  });
});

describe('Sealbridge MCP server', () => {
  it('answers initialize, tools/list, invite, revoke, and audit verification', async () => {
    const owner = generateKeyPair();
    const server = new AcpMcpServer({ owner, relay: 'http://127.0.0.1:9' });
    const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(init).toMatchObject({
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'sealbridge-mcp-server', version: '0.2.2' },
      },
    });
    expect((init as { result: { instructions: string } }).result.instructions.length).toBeGreaterThan(
      0,
    );
    expect(
      await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ).toBeUndefined();
    const listed = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (listed as { result: { tools: Array<{
      name: string; inputSchema: { properties: Record<string, unknown> };
    }> } }).result.tools;
    const names = tools.map(
      (tool) => tool.name,
    );
    expect(names).toEqual([
      'acp_delegate_task',
      'acp_delegate_multi',
      'acp_verify_audit_bundle',
      'acp_create_invite',
      'acp_revoke_token',
      'acp_discover_workers',
      'acp_inspect_revocations',
      'acp_list_pending_requests',
      'acp_resubmit_pending_request',
    ]);
    expect(Object.keys(tools.find(tool => tool.name === 'acp_discover_workers')!.inputSchema.properties)).toEqual([
      'accessMode', 'skillId', 'taskType', 'relayUrl',
    ]);
    for (const tool of tools) expect(tool.inputSchema.properties).not.toHaveProperty('relays');
    const created = await server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'acp_create_invite',
        arguments: { relayUrl: 'https://acp-relay.agent-collab.workers.dev', name: 'MCP Worker' },
      },
    });
    const invite = JSON.parse(
      (created as { result: { content: Array<{ text: string }> } }).result.content[0].text,
    ) as { inviteToken: string };
    expect(parseAndVerifyInviteToken(invite.inviteToken).ownerDid).toBe(owner.did);
    const targetId = inviteRevocationId(invite.inviteToken);
    const revoked = await server.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'acp_revoke_token',
        arguments: { targetType: 'invite', targetId, reason: 'rotated' },
      },
    });
    const notice = JSON.parse(
      (revoked as { result: { content: Array<{ text: string }> } }).result.content[0].text,
    ).notice;
    expect(verifyRevocationNotice(notice, owner.did)).toBe(true);
    expect(server.revocation.isRevoked('invite', targetId)).toBe(true);
    const report = await server.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'acp_verify_audit_bundle', arguments: { bundle: { entries: [] } } },
    });
    expect(
      JSON.parse(
        (report as { result: { content: Array<{ text: string }> } }).result.content[0].text,
      ),
    ).toMatchObject({ valid: false, status: 'INVALID' });
    expect(await server.handle({ jsonrpc: '2.0', id: 6, method: 'nope' })).toMatchObject({
      error: { code: -32601 },
    });
  });

  it('speaks Content-Length and newline JSON-RPC frames', async () => {
    const owner = generateKeyPair();
    const framed = new AcpMcpServer({ owner });
    const input = new PassThrough();
    const output = new PassThrough();
    const serving = framed.serve(input, output);
    const request = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' });
    const framedResponse = new Promise<string>((resolve) => {
      let buffer = Buffer.alloc(0);
      output.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const length = Number(
          /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString())?.[1],
        );
        const start = headerEnd + 4;
        if (buffer.length < start + length) return;
        resolve(buffer.subarray(start, start + length).toString());
      });
    });
    input.write('Content-Length: ' + Buffer.byteLength(request) + '\r\n\r\n' + request);
    expect(JSON.parse(await framedResponse)).toMatchObject({ result: {}, id: 7 });
    input.end();
    await serving;

    const lines = new AcpMcpServer({ owner });
    const lineIn = new PassThrough();
    const lineOut = new PassThrough();
    const lineServing = lines.serve(lineIn, lineOut);
    const lineResponse = new Promise<string>((resolve) => {
      let buffer = Buffer.alloc(0);
      lineOut.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const newline = buffer.indexOf(0x0a);
        if (newline >= 0) resolve(buffer.subarray(0, newline).toString());
      });
    });
    lineIn.end(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping' }) + '\n');
    expect(JSON.parse(await lineResponse)).toMatchObject({ result: {}, id: 8 });
    await lineServing;
  });

  it('delegates through acp_delegate_task and acp_delegate_multi', async () => {
    const owner = generateKeyPair();
    const bob = generateKeyPair();
    const carol = generateKeyPair();
    const relay = new InMemoryRelay();
    const server = new AcpMcpServer({ owner, relay });
    const bobNode = echoWorker(bob, relay, 'bob');
    const carolNode = echoWorker(carol, relay, 'carol');
    const pending = Promise.all([bobNode.start(), carolNode.start()]);
    const single = await server.handle({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'acp_delegate_task',
        arguments: {
          inviteToken: bobNode.invite(),
          title: 'Echo',
          description: 'Return the input',
          input: { hello: 'mcp' },
        },
      },
    });
    const body = JSON.parse(
      (single as { result: { content: Array<{ text: string }> } }).result.content[0].text,
    ) as { status: string; deliverable: Json; auditBundle: { valid: boolean } };
    expect(body.status).toBe('SETTLED');
    expect(body.deliverable).toEqual({ tag: 'bob', input: { hello: 'mcp' } });
    expect(body.auditBundle.valid).toBe(true);
    const multi = await server.handle({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'acp_delegate_multi',
        arguments: {
          mode: 'race',
          title: 'Either',
          description: 'First echo',
          input: { n: 2 },
          workers: [
            { workerDid: bob.did, inviteToken: bobNode.invite() },
            { workerDid: carol.did, inviteToken: carolNode.invite() },
          ],
        },
      },
    });
    const raced = JSON.parse(
      (multi as { result: { content: Array<{ text: string }> } }).result.content[0].text,
    ) as { status: string; auditBundles: Array<{ valid: boolean }> };
    expect(raced.status).toBe('SETTLED');
    expect(raced.auditBundles.every((bundle) => bundle.valid)).toBe(true);
    bobNode.stop();
    carolNode.stop();
    await pending;
  });
});
