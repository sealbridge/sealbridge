import type { RelayTransport } from '../packages/relay/src/index.js';
// SPDX-License-Identifier: Apache-2.0
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it, vi } from 'vitest';
import {
  createSignedAgentCard,
  generateKeyPair,
  inviteRevocationId,
} from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import {
  AcpMcpServer,
  PolicyAutoApprovalProvider,
  WorkerNode,
} from '../packages/runtime/src/index.js';

const HINTS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
] as const;

const EXPECTED_HINTS: Record<
  string,
  { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
> = {
  acp_delegate_task: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  acp_delegate_multi: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  acp_verify_audit_bundle: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  acp_create_invite: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  acp_revoke_token: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  acp_discover_workers: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  acp_inspect_revocations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

interface ToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function walkSchemas(schema: unknown, path: string, problems: string[]): void {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema)) {
    schema.forEach((item, index) => walkSchemas(item, path + '[' + index + ']', problems));
    return;
  }
  const record = schema as Record<string, unknown>;
  if (record.type === 'object') {
    const properties = record.properties;
    const hasProperties =
      !!properties &&
      typeof properties === 'object' &&
      !Array.isArray(properties) &&
      Object.keys(properties as object).length > 0;
    const hasAdditional = Object.hasOwn(record, 'additionalProperties');
    if (!hasProperties && !hasAdditional)
      problems.push(path + ' is a bare object schema with no properties');
  }
  const properties = record.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      const propPath = path + '.' + key;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        problems.push(propPath + ' is not an object schema');
        continue;
      }
      const description = (value as Record<string, unknown>).description;
      if (typeof description !== 'string' || description.trim().length < 20)
        problems.push(propPath + ' is missing a description');
      walkSchemas(value, propPath, problems);
    }
  }
  if ('items' in record) walkSchemas(record.items, path + '.items', problems);
  for (const key of ['oneOf', 'anyOf', 'allOf', 'prefixItems']) {
    if (key in record) walkSchemas(record[key], path + '.' + key, problems);
  }
  const additional = record.additionalProperties;
  if (additional && typeof additional === 'object')
    walkSchemas(additional, path + '.additionalProperties', problems);
}

function assertSchema(schema: unknown, data: unknown, label: string): void {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema as object);
  if (!validate(data)) throw new Error(label + ': ' + ajv.errorsText(validate.errors));
}

async function outputSchema(server: AcpMcpServer, name: string): Promise<unknown> {
  const listed = (await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as unknown as {
    result: { tools: ToolDefinition[] };
  };
  const tool = listed.result.tools.find((item) => item.name === name);
  if (!tool?.outputSchema) throw new Error('missing output schema for ' + name);
  return tool.outputSchema;
}

async function callTool(server: AcpMcpServer, name: string, args: Record<string, unknown>) {
  const response = await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const result = (
    response as {
      result?: {
        isError?: boolean;
        content?: Array<{ text: string }>;
        structuredContent?: unknown;
      };
      error?: { code: number; message: string };
    }
  );
  return result;
}

describe('MCP tool definition quality', () => {
  it('publishes instructions and fully described tools', async () => {
    const server = new AcpMcpServer({ owner: generateKeyPair() });
    const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const instructions = (init as { result: { instructions?: string } }).result.instructions;
    expect(typeof instructions).toBe('string');
    expect(instructions && instructions.trim().length).toBeGreaterThan(200);
    for (const name of [
      'acp_discover_workers',
      'acp_create_invite',
      'acp_delegate_task',
      'acp_delegate_multi',
      'acp_verify_audit_bundle',
      'acp_revoke_token',
      'acp_inspect_revocations',
    ])
      expect(instructions).toContain(name);
    expect(instructions).toMatch(/allowedWorkerDids/);
    expect(instructions).toMatch(/transmitted externally/i);

    const listed = (await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as unknown as {
      result: { tools: ToolDefinition[] };
    };
    const tools = listed.result.tools;
    expect(tools.map((tool) => tool.name)).toEqual(Object.keys(EXPECTED_HINTS));
    const problems: string[] = [];
    for (const tool of tools) {
      const expected = EXPECTED_HINTS[tool.name];
      expect(expected, tool.name).toBeTruthy();
      expect(typeof tool.title).toBe('string');
      expect(tool.title && tool.title.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
      const description = tool.description ?? '';
      const parts = sentences(description);
      expect(parts.length, tool.name + ' sentences').toBeGreaterThanOrEqual(3);
      expect(parts.length, tool.name + ' sentences').toBeLessThanOrEqual(6);
      expect(description.length, tool.name + ' length').toBeGreaterThan(240);
      expect(description.length, tool.name + ' length').toBeLessThan(1100);
      expect(parts.every((part) => part.endsWith('.')), tool.name).toBe(true);
      expect(tool.annotations?.title).toBe(tool.title);
      for (const hint of HINTS) {
        expect(typeof tool.annotations?.[hint], tool.name + ' ' + hint).toBe('boolean');
        expect(tool.annotations?.[hint], tool.name + ' ' + hint).toBe(expected[hint]);
      }
      expect(tool.inputSchema?.type).toBe('object');
      expect(tool.outputSchema && typeof tool.outputSchema).toBe('object');
      walkSchemas(tool.inputSchema, tool.name + '.input', problems);
      walkSchemas(tool.outputSchema, tool.name + '.output', problems);
    }
    expect(problems).toEqual([]);
    const task = tools.find((tool) => tool.name === 'acp_delegate_task');
    const multi = tools.find((tool) => tool.name === 'acp_delegate_multi');
    expect(task?.description).toMatch(/transmitted externally/i);
    expect(task?.description).toMatch(/relay/i);
    expect(multi?.description).toMatch(/transmitted externally/i);
    expect(multi?.description).toMatch(/worker/i);
    expect(tools.find((tool) => tool.name === 'acp_create_invite')?.description).toMatch(/3600/);
    expect(tools.find((tool) => tool.name === 'acp_delegate_multi')?.description).toMatch(/quorum/);
    expect(tools.find((tool) => tool.name === 'acp_revoke_token')?.description).toMatch(
      /capability/,
    );
    const discovery = tools.find((tool) => tool.name === 'acp_discover_workers');
    const selectors = discovery?.inputSchema?.properties as Record<string, Record<string, unknown>>;
    expect(selectors.accessMode).toMatchObject({ enum: ['open', 'invite-only', 'all'], default: 'open' });
    expect(selectors.skillId).toMatchObject({ type: 'string', minLength: 1 });
    expect(selectors.taskType).toMatchObject({ type: 'string', minLength: 1 });
    assertSchema(discovery?.inputSchema, {}, 'default discovery');
    assertSchema(discovery?.inputSchema, { accessMode: 'all', skillId: 'echo', taskType: 'json' }, 'filtered discovery');
    expect(discovery?.description).toContain('workerDid and relayUrl unchanged');
    expect(task?.description).toContain('when that allowlist is configured');
    expect(task?.description).toContain('a failure may occur after input transmission');
    assertSchema(task?.inputSchema, { workerDid: 'did:key:example', relayUrl: 'https://relay.example',
      title: 'Echo', input: {} }, 'description omitted');
  });

  it('returns structuredContent that matches the text payload', async () => {
    const server = new AcpMcpServer({ owner: generateKeyPair() });
    const response = await callTool(server, 'acp_verify_audit_bundle', { bundle: { entries: [] } });
    const text = JSON.parse(response.result?.content?.[0].text ?? '') as {
      valid: boolean;
      status: string;
    };
    expect(text).toMatchObject({ valid: false, status: 'INVALID' });
    expect(response.result?.isError).not.toBe(true);
    expect(response.result?.structuredContent).toEqual(text);
    assertSchema(await outputSchema(server, 'acp_verify_audit_bundle'), text, 'verify');
  });

  it('lists registered workers locally and rejects a relay outside the allowlist', async () => {
    const owner = generateKeyPair();
    const worker = generateKeyPair();
    const relay = new InMemoryRelay();
    relay.register(
      createSignedAgentCard(
        {
          name: 'Listed Worker',
          accessMode: 'open',
          openPolicy: { maxInputTokens: 1000 },
          agentDid: worker.did,
          relayEndpoint: 'https://acp-relay.agent-collab.workers.dev',
          skills: [{ id: 'json-task', name: 'JSON task', description: 'Echo JSON', taskTypes: ['json'],
            inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }],
        },
        worker,
      ),
    );
    const server = new AcpMcpServer({ owner, relay });
    const listed = await callTool(server, 'acp_discover_workers', {});
    const body = JSON.parse(listed.result?.content?.[0].text ?? '') as {
      relayUrl: string | null;
      count: number;
      workers: Array<{ agentDid: string; skills: Array<{ description?: string }> }>;
    };
    expect(listed.result?.isError).not.toBe(true);
    expect(listed.result?.structuredContent).toEqual(body);
    expect(body.relayUrl).toBeNull();
    expect(body.count).toBe(1);
    expect(body.workers[0].agentDid).toBe(worker.did);
    expect(body.workers[0].skills[0].description).toBe('Echo JSON');
    assertSchema(await outputSchema(server, 'acp_discover_workers'), body, 'discover');

    const pinned = new AcpMcpServer({
      owner,
      relay: 'https://acp-relay.agent-collab.workers.dev',
      allowedRelayUrls: ['https://acp-relay.agent-collab.workers.dev'],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('UNEXPECTED_NETWORK');
    });
    try {
      const blocked = await callTool(pinned, 'acp_discover_workers', {
        relayUrl: 'https://evil.example/agents',
      });
      expect(blocked.result?.isError).toBe(true);
      expect(JSON.parse(blocked.result?.content?.[0].text ?? '')).toEqual({
        error: 'MCP_RELAY_NOT_ALLOWED',
      });
      expect(blocked.result?.structuredContent).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
      const loopback = await callTool(new AcpMcpServer({ owner }), 'acp_discover_workers', {
        relayUrl: 'http://127.0.0.1:9',
      });
      expect(JSON.parse(loopback.result?.content?.[0].text ?? '')).toEqual({
        error: 'SSRF_BLOCKED_RELAY_URL',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      const discover = vi.fn(async () => []);
      const factory = vi.fn(() => ({ discover }) as unknown as RelayTransport);
      const defaults = await callTool(new AcpMcpServer({ owner, transportFactory: factory }), 'acp_discover_workers', {});
      expect(defaults.result?.structuredContent).toMatchObject({ relayUrl: 'https://relay.sealbridge.dev', count: 0 });
      expect(factory).toHaveBeenCalledWith('https://relay.sealbridge.dev', undefined);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('reads the in-memory revocation registry without contacting a relay', async () => {
    const owner = generateKeyPair();
    const server = new AcpMcpServer({ owner, relay: 'https://acp-relay.agent-collab.workers.dev' });
    const empty = await callTool(server, 'acp_inspect_revocations', {});
    expect(JSON.parse(empty.result?.content?.[0].text ?? '')).toEqual({ count: 0, notices: [] });

    const created = await callTool(server, 'acp_create_invite', {
      relayUrl: 'https://acp-relay.agent-collab.workers.dev',
      name: 'Quality Worker',
    });
    const invite = JSON.parse(created.result?.content?.[0].text ?? '') as { inviteToken: string };
    const targetId = inviteRevocationId(invite.inviteToken);
    const revoked = await callTool(server, 'acp_revoke_token', {
      targetType: 'invite',
      targetId,
      reason: 'rotated',
    });
    expect(revoked.result?.isError).not.toBe(true);
    const filtered = JSON.parse(
      (await callTool(server, 'acp_inspect_revocations', { targetType: 'invite', targetId })).result
        ?.content?.[0].text ?? '',
    ) as { count: number; revoked?: boolean; notices: unknown[] };
    expect(filtered).toMatchObject({ count: 1, revoked: true });
    expect(filtered.notices).toHaveLength(1);
    assertSchema(await outputSchema(server, 'acp_inspect_revocations'), filtered, 'inspect');
    assertSchema(
      await outputSchema(server, 'acp_create_invite'),
      JSON.parse(created.result?.content?.[0].text ?? ''),
      'invite',
    );
    assertSchema(
      await outputSchema(server, 'acp_revoke_token'),
      JSON.parse(revoked.result?.content?.[0].text ?? ''),
      'revoke',
    );
    const otherType = JSON.parse(
      (await callTool(server, 'acp_inspect_revocations', { targetType: 'capability' })).result
        ?.content?.[0].text ?? '',
    ) as { count: number; revoked?: boolean };
    expect(otherType).toEqual({ count: 0, notices: [] });
    const unknown = JSON.parse(
      (
        await callTool(server, 'acp_inspect_revocations', {
          targetType: 'capability',
          targetId: 'cap-missing',
        })
      ).result?.content?.[0].text ?? '',
    );
    expect(unknown).toEqual({ count: 0, revoked: false, notices: [] });
    const invalid = await callTool(server, 'acp_inspect_revocations', { targetId: 'only-id' });
    expect(invalid.error).toMatchObject({ code: -32602 });
  });

  it('delegation results match their output schemas', async () => {
    const owner = generateKeyPair();
    const bob = generateKeyPair();
    const carol = generateKeyPair();
    const relay = new InMemoryRelay();
    const server = new AcpMcpServer({ owner, relay });
    const node = (key: ReturnType<typeof generateKeyPair>, tag: string) =>
      new WorkerNode({
        owner: key,
        relay,
        adapter: {
          id: tag,
          name: tag,
          skills: [],
          executeTask: async (context) => ({ tag, input: context.input }),
        },
        approvalProvider: new PolicyAutoApprovalProvider(key),
        timeoutMs: 10000,
      });
    const bobNode = node(bob, 'bob');
    const carolNode = node(carol, 'carol');
    const pending = Promise.all([bobNode.start(), carolNode.start()]);
    try {
      const single = await callTool(server, 'acp_delegate_task', {
        inviteToken: bobNode.invite(),
        title: 'Echo',
        description: 'Return the input',
        input: { hello: 'schema' },
      });
      const singleBody = JSON.parse(single.result?.content?.[0].text ?? '');
      expect(singleBody.status).toBe('SETTLED');
      assertSchema(await outputSchema(server, 'acp_delegate_task'), singleBody, 'delegate');
      const multi = await callTool(server, 'acp_delegate_multi', {
        mode: 'race',
        title: 'Either',
        description: 'First echo',
        input: { n: 1 },
        workers: [
          { workerDid: bob.did, inviteToken: bobNode.invite() },
          { workerDid: carol.did, inviteToken: carolNode.invite() },
        ],
      });
      const multiBody = JSON.parse(multi.result?.content?.[0].text ?? '');
      expect(multiBody.status).toBe('SETTLED');
      assertSchema(await outputSchema(server, 'acp_delegate_multi'), multiBody, 'multi');
    } finally {
      bobNode.stop();
      carolNode.stop();
      await pending;
    }
  });
});
