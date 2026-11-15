// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startLocalRelay } from '../packages/relay/src/index.js';
import { resolveStoredIdentity } from '../packages/runtime/src/index.js';
import { generateKeyPair, signPayload, parseAndVerifyInviteToken } from '../packages/core/src/index.js';
import { parseJsonl, verifyAudit } from '../packages/ledger/src/index.js';
const roots: string[] = [], children: ChildProcess[] = [], clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  await Promise.all(children.splice(0).map(c => new Promise<void>(done => {
    if (c.exitCode !== null || c.signalCode !== null) { done(); return; }
    c.once('close', () => done()); c.kill('SIGKILL');
  })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const environment = (root: string) => ({ ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string')),
  SEALBRIDGE_DATA_DIR: root, SEALBRIDGE_KEY_STORE: 'file', OPENAI_API_KEY: 'local-fixture-only',
  HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*'  });
function cli(root: string, args: string[], stdin?: string, capture?: { stderr: string }, failConnection = false) {
  const child = spawn(process.execPath, [...(failConnection ? ['--import', pathToFileURL(resolve('conformance/fixtures/connection-record-failure.mjs')).href] : []), resolve('cli/dist/index.js'), ...args], { env: environment(root), stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; if (capture) capture.stderr += b; });
  if (stdin !== undefined) child.stdin.end(stdin);
  return new Promise<string>((done, fail) => {
    child.once('error', fail); child.once('close', code => code === 0 ? done(stdout) : fail(new Error('CLI failed: ' + stderr.replace(/acp-invite:[\w-]+/g, '[invite]'))));
  });
}
async function worker(root: string, url: string, audit: string, migrated: boolean, endpoint?: string) {
  const child = spawn(process.execPath, ['--require', resolve('conformance/fixtures/cli-terminal.cjs'), resolve('cli/dist/index.js'), 'worker', 'start', '--relay', url, '--allow-private-relay',
    '--adapter', endpoint ? 'openai' : 'sandbox', ...(endpoint ? ['--endpoint', endpoint] : []), '--allow-local-pc', '--auto-accept', '--audit', audit,
    ...(!migrated ? ['--also-requester', '--requester-auto-accept', 'write'] : [])], { env: environment(root), stdio: ['pipe', 'ignore', 'pipe', 'ipc'] });
  children.push(child);
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('worker readiness timeout')), 10000);
    let stderr = '';
    child.stderr!.on('data', b => { stderr += b; if (stderr.includes('invite_ready')) { clearTimeout(timer); done(); } });
    child.once('error', fail); child.once('close', () => { clearTimeout(timer); fail(new Error('worker exited before readiness')); });
  });
  return child;
}
async function stop(child: ChildProcess) {
  const closed = once(child, 'close');
  // Windows kill(SIGTERM) is forcible: the existing fixture dispatches the real
  // signal handler over IPC there. Unix sends the OS signal. Both must exit 0.
  if (process.platform === 'win32') child.send('SIGTERM'); else child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { expect((await closed)[0]).toBe(0); } finally { clearTimeout(timer); }
}

async function mcp(root: string, url: string, key?: string) {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('cli/dist/index.js'), 'mcp-server', '--relay', url, '--allow-private-relay', ...(key ? ['--key', key] : [])], env: environment(root), stderr: 'pipe' });
  const client = new Client({ name: 'MCP regression host', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  let prompts = 0;
  client.setRequestHandler(ElicitRequestSchema, async request => {
    // Fixture owner's explicit connection decision, independently of task approval.
    expect(request.params.message).toContain('Separate connection consent'); prompts++;
    return { action: 'accept', content: { connect: true } };
  });
  clients.push(client); await client.connect(transport);
  return { client, prompts: () => prompts };
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}, error?: string) {
  const value = await client.callTool({ name, arguments: args });
  const payload = JSON.parse((value.content as Array<{ text: string }>)[0].text);
  expect(value.isError, JSON.stringify(payload)).toBe(!!error);
  if (error) expect(payload.error).toBe(error);
  if (!error) expect(value.structuredContent).toEqual(payload);
  return payload;
}
// Model HTTP is a fixture; the failure case also injects a connection-write exception.
// MCP, CLI, keys, relay, task execution and audits are real.
it.each([[false, false], [true, false], [false, true], [true, true]])('Muse <-> Grok Bot over stdio: creator/name send, importer hold/read-only/write/disallow, name errors and expiry, VALID audits, SIGTERM; connection-write failure settles and later delegate records; migrated=%s non-TTY CLI=%s', async (migrated, cliFirst) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'muse-grok-e2e-')); roots.push(root);
  const a = join(root, 'muse'), b = join(root, 'grok-bot');
  for (const folder of [a, b]) {
    const options = { home: folder, env: { SEALBRIDGE_DATA_DIR: folder, SEALBRIDGE_KEY_STORE: 'file' } };
    await resolveStoredIdentity('requester', options); await resolveStoredIdentity('worker', options);
    if (migrated) await cli(folder, ['worker', 'migrate', '--apply']);
    await cli(folder, ['config', 'auto-accept', 'anyone', 'write']);
  }
  let modelCalls = 0;
  const model = createServer((req, res) => {
    req.resume(); req.on('end', () => {
      modelCalls++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const endpoint = `http://127.0.0.1:${(model.address() as import('node:net').AddressInfo).port}/v1/chat/completions`;
  const relay = await startLocalRelay({ port: 0 });
  try {
    const am = await mcp(a, relay.url), bm = await mcp(b, relay.url);
    const invite = cliFirst ? { inviteToken: (await cli(a, ['invite', 'create', '--relay', relay.url, '--name', 'Muse', '--allow-private-relay'])).trim().split(/\r?\n/)[0] } : await call(am.client, 'acp_create_invite', { name: 'Muse' });
    const saved = JSON.parse(await cli(b, ['accept', '--stdin', '--alias', 'muse', '--allow-private-relay'], invite.inviteToken + '\n'));
    const aw = await worker(a, relay.url, join(root, 'muse.jsonl'), migrated);
    const cliSend = (extra: string[] = []) => cli(b, ['delegate', ...(migrated && cliFirst ? ['--invite', 'muse'] : ['--to', 'muse']), '--title', 'Connect',
      '--description', 'Return JSON', '--input', '{"ok":true}', '--auto-approve', '--allow-private-relay',
      '--task-timeout-ms', '10000', ...extra]).then(JSON.parse);
    if (cliFirst) {
      expect(await cliSend(['--no-connect'])).toMatchObject({ state: 'SETTLED', audit: 'VALID' });
      expect(JSON.parse(await cli(b, ['connections', 'list'])).connections).toEqual([]);
      const capture = { stderr: '' };
      const failed = JSON.parse(await cli(b, ['delegate', '--to', 'muse', '--title', 'Record failure',
        '--description', 'Return JSON', '--input', '{"ok":true}', '--auto-approve', '--allow-private-relay',
        '--task-timeout-ms', '10000', '--audit', join(root, 'record-failure.jsonl')], undefined, capture, true));
      expect(failed).toMatchObject({ state: 'SETTLED', audit: 'VALID', deliverable: { ok: true },
        connectionRecordWarning: { code: 'CONNECTION_RECORD_FAILED', peerOwnerDid: parseAndVerifyInviteToken(invite.inviteToken, Date.now(), { allowPrivateRelay: true }).ownerDid,
          message: expect.stringContaining('Connection was not recorded') } });
      expect(failed.connectionRecorded).toBeUndefined();
      expect(capture.stderr).toContain(failed.connectionRecordWarning.message);
      expect(capture.stderr).toContain('接続を記録できませんでした');
      expect(capture.stderr).toContain('Re-run delegate or use TTY/MCP');
      expect(JSON.parse(await cli(b, ['connections', 'list'])).connections).toEqual([]);
      expect(verifyAudit(parseJsonl(readFileSync(join(root, 'record-failure.jsonl'), 'utf8'))).status).toBe('VALID');
      expect(verifyAudit(parseJsonl(readFileSync(join(root, `muse.${failed.taskId}.jsonl`), 'utf8'))).status).toBe('VALID');
    }
    const first = cliFirst ? await cliSend(['--audit', join(root, 'grok-first.jsonl')]) :
      await call(bm.client, 'acp_delegate_task', { peerRef: 'muse', title: 'Connect', input: { ok: true }, taskTimeoutMs: 10000 });
    if (cliFirst) {
      expect(first).toMatchObject({ state: 'SETTLED', audit: 'VALID', connectionRecorded: { message: expect.stringContaining('Work from this peer is not allowed') } });
      expect(first.connectionRecorded.message).toContain('sealbridge connections allow muse\n');
      expect(first.connectionRecorded.message).toMatch(/読み取り専用.*sealbridge connections allow muse$/);
      expect(first.connectionRecordWarning).toBeUndefined();
      expect(JSON.parse(await cli(b, ['connections', 'list'])).connections).toContainEqual(expect.objectContaining({ alias: 'muse', state: 'connected', acceptance: 'off' }));
      expect(verifyAudit(parseJsonl(readFileSync(join(root, 'grok-first.jsonl'), 'utf8'))).status).toBe('VALID');
      expect(verifyAudit(parseJsonl(readFileSync(join(root, `muse.${first.taskId}.jsonl`), 'utf8'))).status).toBe('VALID');
    } else expect(first).toMatchObject({ status: 'SETTLED', auditBundle: { valid: true, status: 'VALID' } });
    expect(bm.prompts()).toBe(cliFirst ? 0 : 1);
    const list = await call(bm.client, 'acp_list_connections');
    expect(list.connections).toContainEqual(expect.objectContaining({ alias: 'muse', acceptance: 'off', inviteCreator: 'peer', allowsWork: false }));
    await cli(b, ['connections', 'alias', 'muse', 'muse-connected', '--role', 'requester']);
    const named = await call(bm.client, 'acp_delegate_task', { to: 'muse-connected', title: 'Name', input: { ok: true }, taskTimeoutMs: 10000 });
    expect(named).toMatchObject({ status: 'SETTLED', deliverable: { ok: true }, auditBundle: { status: 'VALID' }, acceptanceWarning: { code: 'PEER_APPROVAL_MAY_BE_REQUIRED' } });
    expect(bm.prompts()).toBe(cliFirst ? 0 : 1);
    const aList = cliFirst ? JSON.parse(await cli(a, ['connections', 'list'])) : await call(am.client, 'acp_list_connections');
    const peer = aList.connections.find((c: { state: string }) => c.state === 'connected');
    const bw = await worker(b, relay.url, join(root, 'grok.jsonl'), migrated, endpoint);
    let returnAttempt = 0;
    const send = async (error?: string) => {
      if (!cliFirst) return call(am.client, 'acp_delegate_task', { to: peer.alias, title: 'Return', input: { ok: true }, taskTimeoutMs: 10000 }, error);
      const requesterAudit = join(root, `muse-return-${++returnAttempt}.jsonl`);
      try {
        const result = JSON.parse(await cli(a, ['delegate', '--to', peer.alias, '--title', 'Return', '--description', 'Return JSON',
          '--input', '{"ok":true}', '--auto-approve', '--allow-private-relay', '--task-timeout-ms', '10000', '--audit', requesterAudit]));
        expect(error).toBeUndefined();
        expect(verifyAudit(parseJsonl(readFileSync(requesterAudit, 'utf8'))).status).toBe('VALID');
        return { ...result, status: result.state, auditBundle: { status: result.audit } };
      } catch (e) {
        if (!error) throw e;
        expect(String(e)).toContain(error);
        return { retryable: false, acceptanceWarning: { code: 'PEER_APPROVAL_MAY_BE_REQUIRED' } };
      }
    };
    const held = await send('PENDING_OWNER_APPROVAL');
    expect(held).toMatchObject({ retryable: false, acceptanceWarning: { code: 'PEER_APPROVAL_MAY_BE_REQUIRED' } });
    expect(modelCalls).toBe(0);
    await cli(b, ['connections', 'allow', 'muse-connected']);
    expect((await call(bm.client, 'acp_list_connections')).connections[0]).toMatchObject({ acceptance: 'read-only', allowedWork: 'read-only' });
    const readResult = await send();
    expect(readResult).toMatchObject({ status: 'SETTLED', deliverable: { ok: true }, auditBundle: { status: 'VALID' } });
    expect(modelCalls).toBe(1);
    if (cliFirst) {
      const before = JSON.parse(await cli(b, ['connections', 'list'])).connections;
      const again = await cliSend();
      expect(again.connectionRecorded).toBeUndefined();
      expect(JSON.parse(await cli(b, ['connections', 'list'])).connections).toEqual(before);
    }
    // Restart with a write-capable adapter: read-only permission must not allow it.
    await stop(bw);
    const writeWorker = await worker(b, relay.url, join(root, 'grok-write.jsonl'), migrated);
    await send('PENDING_OWNER_APPROVAL');
    await cli(b, ['connections', 'allow', 'muse-connected', 'write']);
    const writeResult = await send();
    expect(writeResult).toMatchObject({ status: 'SETTLED', deliverable: { ok: true }, auditBundle: { status: 'VALID' } });
    await cli(b, ['connections', 'disallow', 'muse-connected']);
    await send('PENDING_OWNER_APPROVAL');
    expect(am.prompts()).toBe(0);

    await call(bm.client, 'acp_delegate_task', { to: 'missing', title: 'Unknown' }, 'CONNECTION_NOT_FOUND');
    // Establish a second real connection in B's other key scope, with the same local name.
    // Unmigrated A has separate worker/requester keys; migrated A retains its legacy worker.
    const alternate = (await cli(a, ['invite', 'create', '--key', join(a, 'identities', cliFirst && !migrated ? 'requester.private.json' : 'worker.private.json'), '--relay', relay.url, '--name', 'Other Muse', '--allow-private-relay'])).trim().split(/\r?\n/)[0];
    const legacy = await mcp(b, relay.url, join(b, 'identities', 'worker.private.json'));
    await call(legacy.client, 'acp_delegate_task', { inviteToken: alternate, title: 'Other connection', taskTimeoutMs: 10000 });
    await cli(b, ['connections', 'alias', 'other-muse', 'muse-connected', '--role', 'worker']);
    await call(bm.client, 'acp_delegate_task', { to: 'muse-connected', title: 'Ambiguous' }, 'CONNECTION_ALIAS_AMBIGUOUS');
    await cli(b, ['accept', '--stdin', '--alias', 'muse-connected', '--allow-private-relay'], alternate + '\n');
    await call(bm.client, 'acp_delegate_task', { to: 'muse-connected', title: 'Conflict' }, 'CONNECTION_TARGET_CONFLICT');
    if (cliFirst) {
      const before = JSON.parse(await cli(b, ['connections', 'list']));
      await expect(cli(b, ['delegate', '--to', 'muse-connected', '--title', 'Conflict', '--description', 'No send',
        '--input', '{}', '--auto-approve', '--allow-private-relay'])).rejects.toThrow('CONNECTION_TARGET_CONFLICT');
      expect(JSON.parse(await cli(b, ['connections', 'list']))).toEqual(before);
    }
    await cli(b, ['invites', 'remove', 'muse-connected']);
    const otherList = await call(bm.client, 'acp_list_connections');
    const otherPeer = otherList.connections.find((c: { peerOwnerDid: string }) => c.peerOwnerDid !== list.connections[0].peerOwnerDid);
    await cli(b, ['connections', 'alias', otherPeer.peerOwnerDid, 'other-connected', '--role', 'worker']);
    // Real wall-clock expiry, never fake timers in subprocesses. Import before expiry.
    const short = cliFirst ? { inviteToken: (await cli(a, ['invite', 'create', '--relay', relay.url, '--name', 'Muse', '--expires-in', '3', '--allow-private-relay'])).trim().split(/\r?\n/)[0] } : await call(am.client, 'acp_create_invite', { name: 'Muse', expiresInSeconds: 3 });
    await cli(b, ['accept', '--stdin', '--alias', 'muse-connected', '--allow-private-relay'], short.inviteToken + '\n');
    // Use the verified invitation parser rather than depending on its serialized layout.
    const expiry = parseAndVerifyInviteToken(short.inviteToken, Date.now(), { allowPrivateRelay: true }).expiresAt;
    await new Promise(r => setTimeout(r, Math.max(0, Date.parse(expiry) - Date.now() + 30)));
    await call(bm.client, 'acp_delegate_task', { peerRef: 'muse-connected', title: 'Expired explicit' }, 'INVITE_EXPIRED');
    expect(await call(bm.client, 'acp_delegate_task', { to: 'muse-connected', title: 'Expired fallback', taskTimeoutMs: 10000 })).toMatchObject({ status: 'SETTLED', auditBundle: { status: 'VALID' } });
    expect(saved.workerRef).toBeDefined();
    await stop(writeWorker); await stop(aw);
    const suffix = migrated ? '' : '.requester';
    for (const path of [join(root, `muse${cliFirst && !migrated ? '' : suffix}.jsonl`),
      join(root, `grok${suffix}.${readResult.taskId}.jsonl`),
      join(root, `grok-write${suffix}.${writeResult.taskId}.jsonl`)]) {
      expect(verifyAudit(parseJsonl(readFileSync(path, 'utf8'))).status, path).toBe('VALID');
      expect(await cli(path.startsWith(join(root, 'muse')) ? a : b, ['audit-verify', path])).toContain('VALID');
    }
  } finally {
    await Promise.all(clients.splice(0).map(c => c.close()));
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) await stop(child);
    await relay.close();
    await new Promise<void>((res, rej) => model.close(e => e ? rej(e) : res()));
  }
}, 90000);

// All identities, receivers, CLI sends and relay traffic below use temporary data only.
it.each(['unreachable', 'DID mismatch'] as const)('non-TTY CLI leaves no importer record on %s', async failure => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'non-tty-failure-')); roots.push(root);
  const a = join(root, 'a'), b = join(root, 'b');
  const impostor = generateKeyPair();
  let mismatched = false;
  const relay = await startLocalRelay({ port: 0, tamper: envelope => {
    if (failure === 'DID mismatch' && envelope.payload.eventType === 'ACCEPT') {
      mismatched = true;
      return signPayload({ ...envelope.payload, senderDid: impostor.did }, impostor);
    }
    return envelope;
  } });
  let receiver: ChildProcess | undefined;
  try {
    await resolveStoredIdentity('requester', { env: { SEALBRIDGE_DATA_DIR: a, SEALBRIDGE_KEY_STORE: 'file' } });
    await cli(a, ['config', 'auto-accept', 'invited', 'write']);
    const token = (await cli(a, ['invite', 'create', '--relay', relay.url, '--name', 'A', '--allow-private-relay'])).trim().split(/\r?\n/)[0];
    await cli(b, ['accept', '--stdin', '--alias', 'a', '--allow-private-relay'], token + '\n');
    expect(JSON.parse(await cli(b, ['connections', 'list'])).connections).toEqual([]);
    if (failure === 'DID mismatch') receiver = await worker(a, relay.url, join(root, 'a.jsonl'), false);
    await expect(cli(b, ['delegate', '--to', 'a', '--title', 'Failure', '--description', 'No connection', '--input', '{}',
      '--auto-approve', '--allow-private-relay', '--task-timeout-ms', '3000', '--wait-timeout-ms', '1500']))
      .rejects.toThrow(failure === 'DID mismatch' ? 'INVALID_OR_REPLAYED_SESSION_ENVELOPE' : /TIMEOUT/);
    expect(mismatched).toBe(failure === 'DID mismatch');
    expect(JSON.parse(await cli(b, ['connections', 'list'])).connections).toEqual([]);
  } finally {
    if (receiver) await stop(receiver);
    await relay.close();
  }
}, 20000);
