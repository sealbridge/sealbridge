// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { generateKeyPair, verifyApproval } from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { McpFormApprovalProvider } from '../packages/runtime/src/index.js';
import { body, deferred, form, harness, initialize, toolCall } from './mcp-approval-helpers.js';

const owner = generateKeyPair();
const worker = generateKeyPair();
const args = { workerDid: worker.did, title: 'Review', description: 'Review the exact task', input: { n: 1 } };
const options = () => ({ owner, relay: new InMemoryRelay(), requireInteractiveApproval: true });
afterEach(() => vi.useRealTimers());

describe('MCP form approval routing', () => {
  it.each([
    [{}, '2025-06-18'], [{ elicitation: { url: {} } }, '2025-06-18'],
    [{ elicitation: {} }, '2024-11-05'], [{ elicitation: { form: {} } }, '2024-11-05'],
  ])('fails immediately without advertised forms: %j / %s', async (capabilities, version) => {
    const opts = options();
    const send = vi.spyOn(opts.relay, 'send');
    const h = harness(opts);
    try {
      await initialize(h, capabilities, version as string);
      h.send(toolCall('task', args));
      expect(body(await h.next((m) => m.id === 'task')).error).toMatch(
        /APPROVAL_CHANNEL_UNAVAILABLE.*host.*elicitation.*--approval-webhook/,
      );
      h.send(toolCall('multi', { ...args, mode: 'race', workers: [{ workerDid: worker.did }] }, 'acp_delegate_multi'));
      expect(body(await h.next((m) => m.id === 'multi')).error).toContain('APPROVAL_CHANNEL_UNAVAILABLE');
      expect(send).not.toHaveBeenCalled();
      expect(h.messages.some((m) => m.method === 'elicitation/create')).toBe(false);
      expect(h.input.listenerCount('data')).toBe(0); // async iterator is the only reader
    } finally { await h.close(); }
  });

  it.each([{}, { form: {} }, { form: {}, url: {} }])('interoperates with SDK client capabilities %j', async (elicitation) => {
    const h = harness(options());
    const client = new Client({ name: 'test-host', version: '1' }, { capabilities: { elicitation } });
    const review = deferred<string>();
    const decision = deferred<{ action: 'decline' }>();
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      review.resolve(request.params.message);
      return decision.promise;
    });
    try {
      await client.connect(h.transport);
      const result = client.callTool({ name: 'acp_delegate_task', arguments: args });
      expect(await review.promise).toContain('external_side_effect');
      await expect(client.ping()).resolves.toEqual({});
      decision.resolve({ action: 'decline' });
      expect((await result).isError).toBe(true);
      expect(h.messages.find((m) => m.method === 'elicitation/create').params).toMatchObject({
        mode: 'form', requestedSchema: { required: ['approved'], properties: { approved: { default: false } } },
      });
    } finally { await client.close(); await h.close(); }
  });

  it.each([
    { action: 'accept', content: { approved: false } }, { action: 'decline', content: { approved: true } },
    { action: 'cancel' }, { action: 'accept' }, { action: 'accept', content: { approved: 'true' } },
    { action: 'accept', content: null }, null, {},
  ])('rejects non-consent %j with fragmented frames and unrelated replies', async (result) => {
    const opts = options();
    const send = vi.spyOn(opts.relay, 'send');
    const h = harness(opts, true);
    try {
      await initialize(h, { elicitation: {} });
      h.send(toolCall('task', args), true);
      const pending = await form(h);
      h.send({ jsonrpc: '2.0', id: 'unrelated', result: { action: 'accept', content: { approved: true } } });
      h.send({ jsonrpc: '2.0', id: 'ping', method: 'ping' }, true);
      expect(await h.next((m) => m.id === 'ping')).toMatchObject({ result: {} });
      expect(send).not.toHaveBeenCalled();
      h.send({ jsonrpc: '2.0', id: pending.id, result }, true);
      h.send({ jsonrpc: '2.0', id: pending.id, result: { action: 'accept', content: { approved: true } } });
      expect(body(await h.next((m) => m.id === 'task')).error).toBe('APPROVAL_REJECTED');
      expect(send).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it('times out without transmission and ignores late approval', async () => {
    vi.useFakeTimers();
    const opts = options();
    const send = vi.spyOn(opts.relay, 'send');
    const h = harness({ ...opts, approvalTimeoutMs: 100 });
    try {
      await initialize(h, { elicitation: { form: {} } });
      h.send(toolCall('task', args));
      const pending = await form(h);
      await vi.advanceTimersByTimeAsync(100);
      expect(body(await h.next((m) => m.id === 'task')).error).toBe('APPROVAL_TIMEOUT');
      h.send({ jsonrpc: '2.0', id: pending.id, result: { action: 'accept', content: { approved: true } } });
      expect(send).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it('aborts outstanding forms on cancellation or disconnect', async () => {
    for (const disconnect of ['cancel', 'input', 'output']) {
      const opts = options();
      const send = vi.spyOn(opts.relay, 'send');
      const h = harness(opts);
      await initialize(h, { elicitation: {} });
      h.send(toolCall('task', args));
      await form(h);
      if (disconnect === 'input') await h.close();
      else if (disconnect === 'output') { h.output.destroy(); await h.serving; await h.close(); }
      else {
        h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'task' } });
        expect(body(await h.next((m) => m.id === 'task')).error).toMatch(/ABORTED/);
        await h.close();
      }
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('isolates concurrent callers and serializes forms', async () => {
    const h = harness(options());
    try {
      await initialize(h, { elicitation: {} });
      h.send(toolCall('one', args));
      h.send(toolCall('two', { ...args, title: 'Second' }));
      const first = await form(h);
      h.send({ jsonrpc: '2.0', id: 'ping', method: 'ping' });
      await h.next((m) => m.id === 'ping');
      expect(h.messages.filter((m) => m.method === 'elicitation/create')).toHaveLength(1);
      h.send({ jsonrpc: '2.0', id: first.id, result: { action: 'decline' } });
      const second = await form(h, 1);
      expect(first.id).not.toBe(second.id);
      h.send({ jsonrpc: '2.0', id: first.id, result: { action: 'accept', content: { approved: true } } });
      h.send({ jsonrpc: '2.0', id: second.id, result: { action: 'decline' } });
      expect(body(await h.next((m) => m.id === 'one')).error).toBe('APPROVAL_REJECTED');
      expect(body(await h.next((m) => m.id === 'two')).error).toBe('APPROVAL_REJECTED');
    } finally { await h.close(); }
  });

  it('bounds input frames', async () => {
    const h = harness(options(), true);
    h.input.write('Content-Length: 1048577\r\n\r\n');
    await expect(h.serving).rejects.toThrow('MCP_MESSAGE_TOO_LARGE');
    h.input.destroy(); h.output.destroy();
  });
});

describe('form review bounds', () => {
  it('signs only strict consent and rejects oversized reviews', async () => {
    const request = { taskId: 'task_form', gate: 'external_side_effect' as const, target: { n: 1 } };
    const provider = new McpFormApprovalProvider(owner, {
      available: () => true,
      request: async () => ({ action: 'accept', content: { approved: true } }),
    });
    expect(verifyApproval(await provider.approve(request), owner.did, request.taskId, request.gate, request.target)).toBe(true);
    await expect(provider.approve({ ...request, target: 'x'.repeat(65536) })).rejects.toThrow('APPROVAL_REVIEW_TOO_LARGE');
  });

  it('bounds queued decisions by the task deadline with an injected clock', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2030-01-01T00:00:00Z');
    const provider = new McpFormApprovalProvider(owner, {
      available: () => true, now: () => now, request: () => new Promise(() => undefined),
    });
    const request = { taskId: 'task_form', gate: 'final_verification' as const, target: {}, deadline: new Date(now + 10).toISOString() };
    const first = expect(provider.approve(request)).rejects.toThrow('APPROVAL_TIMEOUT');
    const queued = expect(provider.approve(request)).rejects.toThrow('APPROVAL_TIMEOUT');
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all([first, queued]);
  });
});
