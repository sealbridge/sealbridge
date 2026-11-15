// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startLocalRelay } from '../packages/relay/src/index.js';
import { migrateWorkerIdentity, resolveStoredIdentity, setApplicationAutoAccept } from '../packages/runtime/src/index.js';
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
  SEALBRIDGE_DATA_DIR: root, SEALBRIDGE_KEY_STORE: 'file' });
function cli(root: string, args: string[], stdin?: string) {
  const child = spawn(process.execPath, [resolve('cli/dist/index.js'), ...args], { env: environment(root), stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  if (stdin !== undefined) child.stdin.end(stdin);
  return new Promise<string>((done, fail) => {
    child.once('error', fail); child.once('close', code => code === 0 ? done(stdout) : fail(new Error('CLI failed: ' + stderr.replace(/acp-invite:[\w-]+/g, '[invite]'))));
  });
}
async function worker(root: string, url: string, audit: string, migrated: boolean) {
  const child = spawn(process.execPath, [resolve('cli/dist/index.js'), 'worker', 'start', '--relay', url, '--allow-private-relay',
    '--adapter', 'sandbox', '--allow-local-pc', '--auto-accept', '--audit', audit,
    ...(!migrated ? ['--also-requester', '--requester-auto-accept', 'write'] : [])], { env: environment(root), stdio: ['pipe', 'ignore', 'pipe'] });
  children.push(child);
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('worker readiness timeout')), 10000);
    let stderr = '';
    child.stderr!.on('data', b => { stderr += b; if (stderr.includes('invite_ready')) { clearTimeout(timer); done(); } });
    child.once('error', fail); child.once('close', () => { clearTimeout(timer); fail(new Error('worker exited before readiness')); });
  });
  return child;
}
async function mcp(root: string, url: string) {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('cli/dist/index.js'), 'mcp-server', '--relay', url, '--allow-private-relay'], env: environment(root), stderr: 'pipe' });
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
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const value = await client.callTool({ name, arguments: args });
  const payload = JSON.parse((value.content as Array<{ text: string }>)[0].text);
  expect(value.isError, JSON.stringify(payload)).toBe(false);
  expect(value.structuredContent).toEqual(payload);
  return payload;
}
it.each([false, true])('real MCP/CLI processes: A creates, B accepts/lists/delegates by name, reverse send settles, bilateral audits VALID; migrated=%s', async migrated => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mcp-peer-process-')); roots.push(root);
  const a = join(root, 'a'), b = join(root, 'b');
  for (const folder of [a, b]) {
    const options = { env: { SEALBRIDGE_DATA_DIR: folder, SEALBRIDGE_KEY_STORE: 'file' } };
    await resolveStoredIdentity('requester', options); await resolveStoredIdentity('worker', options);
    if (migrated) await migrateWorkerIdentity(options, false);
    setApplicationAutoAccept({ version: 1, enabled: true, from: 'anyone', work: 'write', limits: {} }, options);
  }
  const relay = await startLocalRelay({ port: 0 });
  try {
    const am = await mcp(a, relay.url), bm = await mcp(b, relay.url);
    const invite = await call(am.client, 'acp_create_invite', { name: 'Alpha' });
    await cli(b, ['accept', '--stdin', '--alias', 'alpha', '--allow-private-relay'], invite.inviteToken + '\n');
    await worker(a, relay.url, join(root, 'a-worker.jsonl'), migrated);
    const first = await call(bm.client, 'acp_delegate_task', { peerRef: 'alpha', title: 'Initial connection', input: { direction: 'B to A' }, taskTimeoutMs: 10000 });
    expect(first).toMatchObject({ status: 'SETTLED', auditBundle: { valid: true, status: 'VALID' } });
    const list = await call(bm.client, 'acp_list_connections');
    expect(list.connections).toContainEqual(expect.objectContaining({ alias: 'alpha', state: 'connected', acceptance: 'off',
      inviteCreator: 'peer', allowsWork: false, allowedWork: 'off', acceptanceWarning: { code: 'PEER_APPROVAL_MAY_BE_REQUIRED', message: expect.any(String) } }));
    await cli(b, ['connections', 'alias', 'alpha', 'alpha-connected', '--role', 'requester']);
    const prompts = bm.prompts();
    const named = await call(bm.client, 'acp_delegate_task', { to: 'alpha-connected', title: 'Name target', input: { direction: 'B to A' }, taskTimeoutMs: 10000 });
    expect(named).toMatchObject({ status: 'SETTLED', deliverable: { direction: 'B to A' }, auditBundle: { valid: true, status: 'VALID' }, acceptanceWarning: { code: 'PEER_APPROVAL_MAY_BE_REQUIRED' } });
    expect(bm.prompts()).toBe(prompts);
    await cli(b, ['connections', 'allow', 'alpha-connected', 'write']);
    await worker(b, relay.url, join(root, 'b-worker.jsonl'), migrated);
    const aList = await call(am.client, 'acp_list_connections');
    const peer = aList.connections.find((c: any) => c.state === 'connected');
    expect(peer).toMatchObject({ inviteCreator: 'local', allowsWork: true, allowedWork: 'write' });
    const reverse = await call(am.client, 'acp_delegate_task', { to: peer.alias, title: 'Return by name', input: { direction: 'A to B' }, taskTimeoutMs: 10000 });
    expect(reverse).toMatchObject({ status: 'SETTLED', deliverable: { direction: 'A to B' }, auditBundle: { valid: true, status: 'VALID' } });
    await Promise.all([am.client.close(), bm.client.close()]);
    const aAudit = join(root, migrated ? 'a-worker.jsonl' : 'a-worker.requester.jsonl');
    const bAudit = join(root, migrated ? 'b-worker.jsonl' : 'b-worker.requester.jsonl');
    for (const path of [aAudit, bAudit]) expect(verifyAudit(parseJsonl(readFileSync(path, 'utf8'))).status, path).toBe('VALID');
  } finally {
    await Promise.all(clients.splice(0).map(c => c.close()));
    await Promise.all(children.splice(0).map(c => new Promise<void>(done => {
      if (c.exitCode !== null || c.signalCode !== null) { done(); return; }
      c.once('close', () => done()); c.kill('SIGKILL');
    })));
    await relay.close();
  }
}, 60000);
