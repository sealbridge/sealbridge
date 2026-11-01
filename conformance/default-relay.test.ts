import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, createSignedAgentCard, createInviteToken, parseAndVerifyInviteToken, signApproval } from '../packages/core/src/index.js';
import type { Json, KeyPair } from '../packages/core/src/index.js';
import { InMemoryRelay, HttpRelayClient, createRelayFetchHandler } from '../packages/relay/src/index.js';
import type { RelayTransport } from '../packages/relay/src/index.js';
import { AcpMcpServer, WorkerNode, resolveOrCreateIdentity, selectApplicationRelay, DEFAULT_PUBLIC_RELAY, createApplicationConfig } from '../packages/runtime/src/index.js';
import type { ApprovalProvider } from '../packages/runtime/src/index.js';
import { parseJsonl, verifyAudit } from '../packages/ledger/src/index.js';
import { networkCommand } from '../cli/src/network.js';
import { mcpServerOptionsFromArgs, parseMcpServerArgs } from '../cli/src/mcp.js';

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function call(server: AcpMcpServer, name: string, args: Record<string, unknown> = {}) {
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) as {
    result: { isError: boolean; content: { text: string }[]; structuredContent?: Record<string, Json> };
  };
  return { error: response.result.isError, value: JSON.parse(response.result.content[0].text) };
}
function invite(url: string) {
  const owner = generateKeyPair();
  const card = createSignedAgentCard({ name: 'Echo', agentDid: owner.did, relayEndpoint: url,
    skills: [{ id: 'echo', name: 'Echo' }] }, owner);
  return createInviteToken({ agentCard: card }, owner);
}
function approving(key: () => KeyPair): ApprovalProvider {
  return { approve: async request => signApproval(request.taskId, request.gate, request.target, key(), 'APPROVED') };
}

describe('application relay provenance', () => {
  it('selects public fallback, configured pin, explicit call, invite, or injected transport', () => {
    expect(selectApplicationRelay()).toEqual({ relay: DEFAULT_PUBLIC_RELAY, source: 'default' });
    expect(selectApplicationRelay({ configured: DEFAULT_PUBLIC_RELAY }).source).toBe('configured');
    expect(selectApplicationRelay({ inviteRelay: 'https://self.example' })).toEqual({ relay: 'https://self.example', source: 'invite' });
    expect(selectApplicationRelay({ explicit: 'https://self.example' }).source).toBe('explicit');
    const relay = new InMemoryRelay();
    expect(selectApplicationRelay({ configured: relay, inviteRelay: 'https://self.example' })).toEqual({ relay, source: 'transport' });
    expect(() => selectApplicationRelay({ configured: DEFAULT_PUBLIC_RELAY, inviteRelay: 'https://self.example' })).toThrow('CONFLICTING_RELAY');
    expect(() => selectApplicationRelay({ explicit: DEFAULT_PUBLIC_RELAY, inviteRelay: 'https://self.example' })).toThrow('CONFLICTING_RELAY');
    expect(() => selectApplicationRelay({ allowedRelayUrls: [] })).toThrow('CONFLICTING_RELAY');
    expect(selectApplicationRelay({ configured: 'https://one.example', explicit: 'https://two.example',
      inviteRelay: 'https://one.example', allowedRelayUrls: ['https://one.example', 'https://two.example'] }).relay).toBe('https://two.example');
  });
  it('retains loopback opt-in and metadata denial', () => {
    expect(() => selectApplicationRelay({ explicit: 'http://127.0.0.1:8787' })).toThrow('SSRF_BLOCKED_RELAY_URL');
    expect(selectApplicationRelay({ explicit: 'http://127.0.0.1:8787', allowPrivateRelay: true }).source).toBe('explicit');
    for (const explicit of ['http://169.254.169.254', 'http://0.0.0.0'])
      expect(() => selectApplicationRelay({ explicit, allowPrivateRelay: true })).toThrow('SSRF_BLOCKED_RELAY_URL');
  });
  it('applies DNS restrictions to injected fetches when lookup is supplied', async () => {
    const fetcher = vi.fn(async () => new Response('[]'));
    const client = new HttpRelayClient(DEFAULT_PUBLIC_RELAY, fetcher as typeof fetch, {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    await expect(client.discover()).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('discovers the default URL through an in-process HTTP handler with no identity or initialization traffic', async () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'sealbridge-default-'));
    roots.push(home);
    const handler = createRelayFetchHandler({ relay: new InMemoryRelay() });
    const fetcher = vi.fn((async (input, init) => handler(new Request(input, init))) as typeof fetch);
    const factory = vi.fn((url: string) => new HttpRelayClient(url, fetcher));
    const server = new AcpMcpServer({ ...mcpServerOptionsFromArgs(parseMcpServerArgs([])),
      identityOptions: { home, env: { SEALBRIDGE_DATA_DIR: join(home, 'data') } }, transportFactory: factory });
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(await call(server, 'acp_discover_workers')).toEqual({ error: false,
      value: { relayUrl: DEFAULT_PUBLIC_RELAY, count: 0, workers: [] } });
    expect(factory).toHaveBeenCalledWith(DEFAULT_PUBLIC_RELAY, undefined);
    expect(fetcher.mock.calls[0][0]).toBe(DEFAULT_PUBLIC_RELAY + '/agents');
    expect(existsSync(join(home, 'data'))).toBe(false);
  });
  it.each(['token', 'link'] as const)('resolves a verified %s relay before client construction and policy checks', async form => {
    const token = invite('https://self.example');
    const factory = vi.fn(() => ({ send: async () => { throw new Error('SELECTED_INVITE_RELAY'); } }) as unknown as RelayTransport);
    const server = new AcpMcpServer({ owner: generateKeyPair(), transportFactory: factory });
    const args = { inviteToken: form === 'link' ? 'https://sealbridge.app/i#' + token : token,
      title: 'Echo', description: 'Echo JSON', input: {} };
    const result = await call(server, 'acp_delegate_task', args);
    expect(result.value.error).toBe('SELECTED_INVITE_RELAY');
    expect(factory.mock.calls[0]).toEqual(['https://self.example', server.options.owner]);
    for (const options of [{ relay: DEFAULT_PUBLIC_RELAY }, { allowedRelayUrls: [] }, { allowedWorkerDids: [] }]) {
      factory.mockClear();
      const blocked = await call(new AcpMcpServer({ owner: generateKeyPair(), transportFactory: factory, ...options }), 'acp_delegate_task', args);
      expect(blocked.value.error).toMatch(/^MCP_(RELAY|WORKER)_NOT_ALLOWED$/);
      expect(factory).not.toHaveBeenCalled();
    }
    const conflict = await call(server, 'acp_delegate_task', { ...args, relayUrl: DEFAULT_PUBLIC_RELAY });
    expect(conflict.value.error).toBe('MCP_RELAY_NOT_ALLOWED');
  });
  it('does not apply the public fallback to an invite-only multi-worker relay allowlist', async () => {
    const token = invite('https://self.example');
    const workerDid = parseAndVerifyInviteToken(token).ownerDid;
    const factory = vi.fn(() => ({ send: async () => { throw new Error('TEST_SEND_STOP'); } }) as unknown as RelayTransport);
    const server = new AcpMcpServer({ owner: generateKeyPair(), transportFactory: factory,
      allowedRelayUrls: ['https://self.example'] });
    const result = await call(server, 'acp_delegate_multi', { mode: 'quorum', quorumSize: 1,
      title: 'Echo', description: 'Echo JSON', input: {}, workers: [{ workerDid, inviteToken: token }] });
    expect(result.value.error).not.toBe('MCP_RELAY_NOT_ALLOWED');
    expect(factory).toHaveBeenCalled();
    expect(factory.mock.calls.every(args => (args as unknown[])[0] === 'https://self.example')).toBe(true);
  });
  it.each(['did', 'invite', 'did-with-candidates', 'invite-with-candidates'])('settles a %s session and reuses both identities after restart', async target => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'sealbridge-session-'));
    roots.push(home);
    const identityOptions = { home, env: { SEALBRIDGE_DATA_DIR: join(home, 'data') } };
    if (target.endsWith('-with-candidates')) createApplicationConfig({ version: 1, relays: [DEFAULT_PUBLIC_RELAY, 'https://unused.example'] }, identityOptions);
    const relay = new InMemoryRelay();
    const handler = createRelayFetchHandler({ relay });
    const fetcher = (async (input, init) => handler(new Request(input, init))) as typeof fetch;
    const selected: string[] = [];
    const transportFactory = (url: string, key?: KeyPair) => {
      selected.push(url);
      return new HttpRelayClient(url, fetcher, key);
    };
    const server = new AcpMcpServer({ identityOptions, transportFactory,
      approvalProvider: approving(() => resolveOrCreateIdentity('requester', identityOptions)) });
    const owner = resolveOrCreateIdentity('worker', identityOptions);
    expect(selected).toEqual([]);
    const worker = new WorkerNode({ owner, relay: transportFactory(DEFAULT_PUBLIC_RELAY, owner),
      relayUrl: DEFAULT_PUBLIC_RELAY, accessMode: target.startsWith('did') ? 'open' : 'invite-only',
      allowedRequesterDids: [resolveOrCreateIdentity('requester', identityOptions).did],
      approvalProvider: approving(() => owner), timeoutMs: 3000,
      adapter: { id: 'echo', name: 'Echo', skills: [{ id: 'echo', name: 'Echo' }], executeTask: async ctx => ctx.input } });
    await worker.register();
    // Starting immediately begins the receive loop; no port or sleeps are needed.
    const done = worker.start({ once: true });
    try {
      const result = await call(server, 'acp_delegate_task', { ...(target.startsWith('did')
        ? { workerDid: owner.did } : { inviteToken: worker.invite() }),
        title: 'Echo', description: 'Echo JSON', input: { hello: 'world' }, taskTimeoutMs: 5000 });
      expect(result).toMatchObject({ error: false, value: { status: 'SETTLED', deliverable: { hello: 'world' }, auditBundle: { valid: true } } });
      await done;
      expect(new Set(selected)).toEqual(new Set([DEFAULT_PUBLIC_RELAY]));
      const requester = resolveOrCreateIdentity('requester', identityOptions);
      expect(requester.did).not.toBe(owner.did);
      const restarted = new AcpMcpServer({ identityOptions });
      const next = await call(restarted, 'acp_create_invite');
      expect(parseAndVerifyInviteToken(next.value.inviteToken).ownerDid).toBe(requester.did);
      expect(parseAndVerifyInviteToken(next.value.inviteToken).relayUrl).toBe(DEFAULT_PUBLIC_RELAY);
      expect(resolveOrCreateIdentity('requester', identityOptions).did).toBe(requester.did);
    } finally { worker.stop(); await done; }
  });
  it('uses the same defaults for CLI worker, invite, discover, and delegate', async () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'sealbridge-cli-'));
    roots.push(home);
    const identityOptions = { home, env: { SEALBRIDGE_DATA_DIR: join(home, 'data') } };
    const handler = createRelayFetchHandler({ relay: new InMemoryRelay() });
    const fetcher = vi.fn((async (input, init) => handler(new Request(input, init))) as typeof fetch);
    const application = { identityOptions, fetch: fetcher };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await networkCommand('worker', ['start', '--preview', '--contacts', join(home, 'contacts.json')], application);
    const owner = resolveOrCreateIdentity('worker', identityOptions);
    await networkCommand('invite', ['create'], application);
    const token = log.mock.calls.at(-1)![0] as string;
    expect(parseAndVerifyInviteToken(token)).toMatchObject({ ownerDid: owner.did, relayUrl: DEFAULT_PUBLIC_RELAY });
    expect(fetcher).not.toHaveBeenCalled();
    await networkCommand('discover', [], application);
    expect(fetcher.mock.calls[0][0]).toBe(DEFAULT_PUBLIC_RELAY + '/agents');
    const worker = new WorkerNode({ owner, relay: new HttpRelayClient(DEFAULT_PUBLIC_RELAY, fetcher, owner),
      relayUrl: DEFAULT_PUBLIC_RELAY, timeoutMs: 3000, approvalProvider: approving(() => owner),
      adapter: { id: 'echo', name: 'Echo', skills: [{ id: 'json-task', name: 'JSON task' }], executeTask: async ctx => ctx.input } });
    const done = worker.start({ once: true });
    try {
      await networkCommand('delegate', ['--to', token, '--title', 'Echo', '--description', 'Echo JSON',
        '--input', '{"ok":true}', '--auto-approve', '--task-timeout-ms', '5000'], application);
      await done;
      expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ state: 'SETTLED', deliverable: { ok: true } });
      expect(resolveOrCreateIdentity('requester', identityOptions).did).not.toBe(owner.did);
      expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(DEFAULT_PUBLIC_RELAY + '/'))).toBe(true);
    } finally { worker.stop(); await done; }
  });
  it('preserves an injected transport even when the invite embeds another public relay', async () => {
    const transport = { send: vi.fn(async () => { throw new Error('INJECTED_TRANSPORT'); }) } as unknown as RelayTransport;
    const factory = vi.fn();
    const result = await call(new AcpMcpServer({ owner: generateKeyPair(), relay: transport, transportFactory: factory }),
      'acp_delegate_task', { inviteToken: invite('https://self.example'), title: 'Echo', description: 'Echo JSON', input: {} });
    expect(result.value.error).toBe('INJECTED_TRANSPORT');
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('multiple local candidates, one active route', () => {
  const first = 'https://first.example';
  const unused = 'https://unused.example';
  function fixture(relays = [first, unused]) {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'sealbridge-candidates-'));
    roots.push(home);
    const identityOptions = { home, env: { SEALBRIDGE_DATA_DIR: join(home, 'data') } };
    createApplicationConfig({ version: 1, relays }, identityOptions);
    return { home, identityOptions };
  }
  it.each(['absent', 'candidates'])('signs an explicit loopback invite locally without connection opt-in with %s config', async form => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'sealbridge-loopback-invite-'));
    roots.push(home);
    const identityOptions = { home, env: { SEALBRIDGE_DATA_DIR: join(home, 'data') } };
    if (form === 'candidates') createApplicationConfig({ version: 1, relays: [first, unused] }, identityOptions);
    const owner = resolveOrCreateIdentity('worker', identityOptions);
    const keyPath = join(identityOptions.env.SEALBRIDGE_DATA_DIR, 'identities', 'worker.private.json');
    const loopback = 'http://127.0.0.1:8787';
    const handler = createRelayFetchHandler({ relay: new InMemoryRelay() });
    const fetcher = vi.fn((async (input, init) => {
      expect(String(input).startsWith(loopback + '/')).toBe(true);
      return handler(new Request(input, init));
    }) as typeof fetch);
    const application = { identityOptions, fetch: fetcher };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await networkCommand('invite', ['create', '--key', keyPath, '--relay', loopback], application);
    const token = log.mock.calls.at(-1)![0] as string;
    expect(parseAndVerifyInviteToken(token, Date.now(), { allowPrivateRelay: true }))
      .toMatchObject({ ownerDid: owner.did, relayUrl: loopback, agentCard: { payload: { relayEndpoint: loopback } } });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(networkCommand('discover', ['--relay', loopback], application)).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
    await expect(networkCommand('delegate', ['--to', token, '--title', 'Echo', '--description', 'Echo JSON', '--input', '{}'], application))
      .rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
    expect(fetcher).not.toHaveBeenCalled();
    await networkCommand('discover', ['--relay', loopback, '--allow-private-relay'], application);
    expect(log).toHaveBeenLastCalledWith('[]');
    expect(fetcher.mock.calls).toHaveLength(1);
    expect(fetcher.mock.calls[0][0]).toBe(loopback + '/agents');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const workerAudit = join(home, 'worker.jsonl');
    const requesterAudit = join(home, 'requester.jsonl');
    await Promise.all([
      networkCommand('worker', ['start', '--key', keyPath, '--relay', loopback, '--allow-private-relay',
        '--adapter', 'sandbox', '--auto-accept', '--once', '--contacts', join(home, 'contacts.json'),
        '--audit', workerAudit], application),
      networkCommand('delegate', ['--to', token, '--allow-private-relay', '--title', 'Echo',
        '--description', 'Echo JSON', '--input', '{"value":7}', '--auto-approve', '--task-timeout-ms', '5000',
        '--audit', requesterAudit], application),
    ]);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ state: 'SETTLED', deliverable: { value: 7 } });
    for (const path of [workerAudit, requesterAudit])
      expect(verifyAudit(parseJsonl(readFileSync(path, 'utf8')))).toMatchObject({ valid: true, status: 'VALID' });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(loopback + '/'))).toBe(true);
  });
  it.each(['success', 'failure', '401'])('never contacts another candidate after discovery %s in CLI or MCP', async outcome => {
    const { identityOptions } = fixture();
    const handler = createRelayFetchHandler({ relay: new InMemoryRelay() });
    const fetcher = vi.fn((async (input, init) => {
      expect(String(input)).toBe(first + '/agents');
      if (outcome === 'failure') throw new Error('REQUEST_FAILED');
      if (outcome === '401') return new Response('{}', { status: 401 });
      return handler(new Request(input, init));
    }) as typeof fetch);
    const factory = vi.fn((url: string) => new HttpRelayClient(url, fetcher));
    const server = new AcpMcpServer({ identityOptions, transportFactory: factory });
    const result = await call(server, 'acp_discover_workers');
    if (outcome === 'success') expect(result).toEqual({ error: false, value: { relayUrl: first, count: 0, workers: [] } });
    else expect(result.error).toBe(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cli = networkCommand('discover', [], { identityOptions, fetch: fetcher });
    if (outcome === 'success') {
      await cli;
      expect(log).toHaveBeenCalledExactlyOnceWith('[]');
    } else await expect(cli).rejects.toThrow();
    expect(factory.mock.calls).toEqual([[first, undefined]]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(existsSync(join(identityOptions.env.SEALBRIDGE_DATA_DIR, 'identities'))).toBe(false);
  });
  it.each(['did', 'invite', 'explicit', 'transport'])('keeps the %s selection independent of candidate membership', async target => {
    const { identityOptions } = fixture();
    const outside = 'https://outside.example';
    const transport = { send: vi.fn(async () => { throw new Error('SELECTED_ROUTE'); }) } as unknown as RelayTransport;
    const factory = vi.fn(() => transport);
    const server = new AcpMcpServer({ owner: generateKeyPair(), identityOptions, transportFactory: factory,
      ...(target === 'transport' ? { relay: transport } : {}) });
    const result = await call(server, 'acp_delegate_task', { title: 'Echo', description: 'Echo JSON', input: {},
      ...(target === 'invite' || target === 'transport' ? { inviteToken: invite(outside) } : { workerDid: generateKeyPair().did }),
      ...(target === 'explicit' ? { relayUrl: outside } : {}) });
    expect(result.value.error).toBe('SELECTED_ROUTE');
    expect(transport.send).toHaveBeenCalled();
    if (target === 'transport') expect(factory).not.toHaveBeenCalled();
    else expect(factory.mock.calls).toEqual([[target === 'did' ? first : outside, server.options.owner]]);
  });
  it.each(['did', 'invite', 'explicit'])('uses one scalar route for CLI %s delegation after a request failure', async target => {
    const { identityOptions } = fixture();
    const outside = 'https://outside.example';
    const selected = target === 'did' ? first : outside;
    const fetcher = vi.fn((async (input) => {
      expect(String(input).startsWith(selected + '/')).toBe(true);
      throw new Error('CLI_SELECTED_ROUTE');
    }) as typeof fetch);
    await expect(networkCommand('delegate', ['--to', target === 'invite' ? invite(outside) : generateKeyPair().did,
      '--title', 'Echo', '--description', 'Echo JSON', '--input', '{}', '--auto-approve',
      ...(target === 'explicit' ? ['--relay', outside] : [])], { identityOptions, fetch: fetcher }))
      .rejects.toThrow('CLI_SELECTED_ROUTE');
    expect(fetcher).toHaveBeenCalled();
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(selected + '/'))).toBe(true);
  });
  it('keeps MCP allowlists independent of stored candidates, including explicit empty lists', async () => {
    const { identityOptions } = fixture();
    const factory = vi.fn(() => ({ discover: async () => [] }) as unknown as RelayTransport);
    for (const allowedRelayUrls of [[], [unused]]) {
      const result = await call(new AcpMcpServer({ identityOptions, transportFactory: factory, allowedRelayUrls }), 'acp_discover_workers');
      expect(result.value.error).toBe('MCP_RELAY_NOT_ALLOWED');
      expect(factory).not.toHaveBeenCalled();
    }
    const allowed = await call(new AcpMcpServer({ identityOptions, transportFactory: factory, allowedRelayUrls: [first] }), 'acp_discover_workers');
    expect(allowed).toEqual({ error: false, value: { relayUrl: first, count: 0, workers: [] } });
    expect(factory.mock.calls).toEqual([[first, undefined]]);
  });
  it('fails on config corruption before a dial or identity creation, including with an explicit pin', async () => {
    const { identityOptions } = fixture();
    const path = join(identityOptions.env.SEALBRIDGE_DATA_DIR, 'config.json');
    writeFileSync(path, '{');
    const factory = vi.fn();
    const fetcher = vi.fn();
    const server = new AcpMcpServer({ identityOptions, transportFactory: factory, relay: first });
    for (const method of ['initialize', 'tools/list'])
      expect(await server.handle({ jsonrpc: '2.0', id: 1, method })).not.toHaveProperty('error');
    for (const name of ['acp_discover_workers', 'acp_create_invite', 'acp_delegate_task', 'acp_delegate_multi']) {
      const result = await call(server, name, { title: 'Echo', workerDid: generateKeyPair().did,
        mode: 'quorum', workers: [{ workerDid: generateKeyPair().did }] });
      expect(result.value.error).toBe('APP_CONFIG_INVALID');
    }
    for (const [command, args] of [
      ['discover', ['--relay', first]], ['invite', ['create']],
      ['worker', ['start', '--preview']], ['delegate', ['--relay', first]],
    ] as const) await expect(networkCommand(command, [...args], { identityOptions, fetch: fetcher })).rejects.toThrow('APP_CONFIG_INVALID');
    expect(factory).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(existsSync(join(identityOptions.env.SEALBRIDGE_DATA_DIR, 'identities'))).toBe(false);
  });
  it('keeps signed cards, invite serialization and CLI output identical when an unused candidate is added', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    const { home, identityOptions } = fixture([first]);
    const owner = resolveOrCreateIdentity('worker', identityOptions);
    const server = new AcpMcpServer({ owner, identityOptions });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi.fn(() => { throw new Error('UNEXPECTED_NETWORK'); });
    const capture = async () => {
      log.mockClear();
      await networkCommand('worker', ['start', '--preview', '--contacts', join(home, 'contacts.json')], { identityOptions, fetch: fetcher });
      const preview = JSON.parse(log.mock.calls.at(-1)![0] as string);
      await networkCommand('invite', ['create'], { identityOptions, fetch: fetcher });
      const token = log.mock.calls.at(-1)![0] as string;
      const minted = await call(server, 'acp_create_invite');
      return { preview, token, minted };
    };
    const single = await capture();
    unlinkSync(join(identityOptions.env.SEALBRIDGE_DATA_DIR, 'config.json'));
    createApplicationConfig({ version: 1, relays: [first, unused] }, identityOptions);
    expect(await capture()).toEqual(single);
    const parsed = parseAndVerifyInviteToken(single.token);
    expect(parsed.relayUrl).toBe(first);
    expect(parsed.agentCard.payload.relayEndpoint).toBe(first);
    expect(Object.keys(parsed).sort()).toEqual(['agentCard', 'agentDid', 'expiresAt', 'issuedAt', 'ownerDid', 'relayUrl', 'type']);
    expect(single.preview.signedCard.payload.relayEndpoint).toBe(first);
    expect(JSON.stringify(single)).not.toContain(unused);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
