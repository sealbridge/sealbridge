// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { createServer, Server, type IncomingMessage } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexCliAdapter, resolveCommand, runCommand } from '../packages/adapters/src/command.js';
import { generateKeyPair } from '../packages/core/src/index.js';
import { buildTaskManifest } from '../packages/runtime/src/index.js';
import type { AgentTaskContext } from '../packages/runtime/src/index.js';

// An explicit path is required to work in CI; only automatic PATH discovery may skip.
const configuredBinary = process.env.SEALBRIDGE_CODEX_BIN;
const binary = configuredBinary
  ? await resolveCommand(configuredBinary)
  : await resolveCommand('codex').catch(() => undefined);
afterEach(() => vi.restoreAllMocks());

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('LOCAL_ENDPOINT_REQUIRED');
  return 'http://127.0.0.1:' + address.port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function completionStream(): string {
  const text = '{"ok":true}';
  const part = { type: 'output_text', text, annotations: [] };
  const message = {
    id: 'msg_local',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [part],
  };
  const response = {
    id: 'resp_local',
    object: 'response',
    created_at: 1,
    model: 'fixture-model',
    status: 'completed',
    output: [message],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  };
  return [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...message, status: 'in_progress', content: [] },
    },
    {
      type: 'response.content_part.added',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part: { ...part, text: '' },
    },
    {
      type: 'response.output_text.delta',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: 'response.output_text.done',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: 'response.content_part.done',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part,
    },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response },
  ]
    .map(
      (event, sequence_number) =>
        'event: ' +
        event.type +
        '\ndata: ' +
        JSON.stringify({ ...event, sequence_number }) +
        '\n\n',
    )
    .join('');
}

it.skipIf(!binary)(
  binary
    ? 'routes real Codex HTTP Responses through the task proxy and completes a JSON deliverable'
    : 'real Codex unavailable: install codex on PATH or set SEALBRIDGE_CODEX_BIN (skipped)',
  async () => {
    const upstreamKey = 'synthetic-upstream-credential';
    const upstreamRequests: Array<{ path?: string; authorization?: string; body: string }> = [];
    const directRequests: string[] = [];
    const proxyRequests: Array<{ path?: string; authorization?: string }> = [];
    let proxyOrigin = '';
    let proxyToken = '';
    let home = '';
    let authenticatedRequests = 0;
    class ObservedCodexAdapter extends CodexCliAdapter {
      protected override decode(stdout: string, context: AgentTaskContext) {
        authenticatedRequests = this.activeProxy?.authenticatedRequests ?? 0;
        return super.decode(stdout, context);
      }
    }
    const originalEmit = Server.prototype.emit;
    vi.spyOn(Server.prototype, 'emit').mockImplementation(function (
      this: Server,
      event: string | symbol,
      ...args: unknown[]
    ) {
      if (event === 'request') {
        const request = args[0] as IncomingMessage;
        const address = this.address();
        if (
          address &&
          typeof address !== 'string' &&
          proxyOrigin === 'http://127.0.0.1:' + address.port
        )
          proxyRequests.push({ path: request.url, authorization: request.headers.authorization });
      }
      return Reflect.apply(originalEmit, this, [event, ...args]) as boolean;
    });
    const upstream = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        upstreamRequests.push({
          path: request.url,
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(completionStream());
      })().catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    const externalProxy = createServer((request, response) => {
      directRequests.push(request.url ?? 'HTTP');
      response.writeHead(502).end();
    });
    externalProxy.on('connect', (request, socket) => {
      directRequests.push(request.url ?? 'CONNECT');
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n', () => socket.destroy());
    });
    const cwd = await mkdtemp(join(tmpdir(), 'sealbridge-codex-real-'));
    try {
      const upstreamUrl = await listen(upstream);
      const externalProxyUrl = await listen(externalProxy);
      const adapter = new ObservedCodexAdapter({
        binaryPath: binary,
        apiKey: upstreamKey,
        baseUrl: upstreamUrl + '/v1',
        runner: async (request) => {
          home = request.env.CODEX_HOME!;
          proxyToken = request.env.SEALBRIDGE_CODEX_PROXY_TOKEN!;
          expect(proxyToken).toBeTruthy();
          expect(proxyToken).not.toBe(upstreamKey);
          expect(Object.values(request.env)).not.toContain(upstreamKey);
          const setting = request.args.find((arg) =>
            arg.startsWith('model_providers.sealbridge-proxy.base_url'),
          );
          if (setting) proxyOrigin = new URL(JSON.parse(setting.split(' = ')[1]) as string).origin;
          return runCommand({
            ...request,
            env: {
              ...request.env,
              HTTP_PROXY: externalProxyUrl,
              HTTPS_PROXY: externalProxyUrl,
              ALL_PROXY: externalProxyUrl,
              NO_PROXY: '127.0.0.1,localhost',
            },
          });
        },
      });
      const manifest = buildTaskManifest({
        ownerDid: generateKeyPair().did,
        workerDid: generateKeyPair().did,
        title: 'Local response fixture',
        description: 'Return a JSON object. Do not use tools.',
        budget: {
          maxWallClockSeconds: 30,
          maxInputTokens: 100000,
          maxOutputTokens: 10000,
          maxToolInvocations: 4,
        },
      });
      const context: AgentTaskContext = {
        manifest,
        taskId: manifest.taskId,
        workspaceDir: cwd,
        input: {},
        signal: new AbortController().signal,
        reportUsage: () => {},
        callTool: async () => {
          throw new Error('TOOL_DENIED');
        },
      };
      expect(await adapter.executeTask(context)).toEqual({ ok: true });
      expect(authenticatedRequests).toBeGreaterThanOrEqual(1);
      expect(proxyRequests).toEqual([
        { path: '/v1/responses', authorization: 'Bearer ' + proxyToken },
      ]);
      expect(proxyRequests[0].authorization).not.toContain(upstreamKey);
      expect(upstreamRequests).toHaveLength(1);
      expect(upstreamRequests[0]).toMatchObject({
        path: '/v1/responses',
        authorization: 'Bearer ' + upstreamKey,
      });
      expect(JSON.parse(upstreamRequests[0].body)).toMatchObject({ stream: true });
      expect(directRequests).toEqual([]);
    } finally {
      await close(upstream);
      await close(externalProxy);
      await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      if (home) await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
  45000,
);
