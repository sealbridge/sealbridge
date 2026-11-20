// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startLocalRelay } from '../packages/relay/src/index.js';
import {
  InviteStore,
  resolveStoredIdentity,
  WorkerTrustStore,
  workerIntakePath,
} from '../packages/runtime/src/index.js';
import {
  createInviteToken,
  createSignedAgentCard,
  generateKeyPair,
  signPayload,
  parseAndVerifyInviteToken,
} from '../packages/core/src/index.js';
import { parseJsonl, verifyAudit } from '../packages/ledger/src/index.js';
const roots: string[] = [],
  children: ChildProcess[] = [],
  clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(
    children.splice(0).map(
      (c) =>
        new Promise<void>((done) => {
          if (c.exitCode !== null || c.signalCode !== null) {
            done();
            return;
          }
          c.once('close', () => done());
          c.kill('SIGKILL');
        }),
    ),
  );
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const environment = (root: string) => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'),
  ),
  SEALBRIDGE_DATA_DIR: root,
  SEALBRIDGE_KEY_STORE: 'file',
  OPENAI_API_KEY: 'local-fixture-only',
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
  ALL_PROXY: '',
  http_proxy: '',
  https_proxy: '',
  all_proxy: '',
  NO_PROXY: '*',
});
async function oldAccept(root: string, token: string) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import { InviteStore } from './conformance/fixtures/pre-290-invite-store.ts';
    import { resolveStoredIdentity } from './packages/runtime/dist/index.js';
    const key = await resolveStoredIdentity('requester');
    let token = ''; for await (const chunk of process.stdin) token += chunk;
    new InviteStore(key).import(token, 'unrelated');
  `,
    ],
    { env: environment(root), stdio: ['pipe', 'ignore', 'pipe'] },
  );
  children.push(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const closed = once(child, 'close');
  child.stdin.end(token);
  expect((await closed)[0], stderr).toBe(0);
}
function cli(
  root: string,
  args: string[],
  stdin?: string,
  capture?: { stderr: string },
  failConnection = false,
  terminal = false,
) {
  const child = spawn(
    process.execPath,
    [
      ...(terminal ? ['--require', resolve('conformance/fixtures/cli-terminal.cjs')] : []),
      ...(failConnection
        ? [
            '--import',
            pathToFileURL(resolve('conformance/fixtures/connection-record-failure.mjs')).href,
          ]
        : []),
      resolve('cli/dist/index.js'),
      ...args,
    ],
    {
      env: { ...environment(root), ...(terminal ? { SEALBRIDGE_TEST_TERMINAL: '1' } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (b) => {
    stdout += b;
  });
  child.stderr.on('data', (b) => {
    stderr += b;
    if (capture) capture.stderr += b;
  });
  if (stdin !== undefined) child.stdin.end(stdin);
  return new Promise<string>((done, fail) => {
    child.once('error', fail);
    child.once('close', (code) =>
      code === 0
        ? done(stdout)
        : fail(new Error('CLI failed: ' + stderr.replace(/acp-invite:[\w-]+/g, '[invite]'))),
    );
  });
}
async function worker(
  root: string,
  url: string,
  audit: string,
  migrated: boolean,
  endpoint?: string,
) {
  const child = spawn(
    process.execPath,
    [
      '--require',
      resolve('conformance/fixtures/cli-terminal.cjs'),
      resolve('cli/dist/index.js'),
      'worker',
      'start',
      '--share',
      'token',
      '--relay',
      url,
      '--allow-private-relay',
      '--adapter',
      endpoint ? 'openai' : 'sandbox',
      ...(endpoint ? ['--endpoint', endpoint] : []),
      '--allow-local-pc',
      '--auto-accept',
      '--audit',
      audit,
      ...(!migrated ? ['--also-requester', '--requester-auto-accept', 'write'] : []),
    ],
    { env: environment(root), stdio: ['pipe', 'ignore', 'pipe', 'ipc'] },
  );
  children.push(child);
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('worker readiness timeout')), 30000);
    let stderr = '';
    child.stderr!.on('data', (b) => {
      stderr += b;
      if (stderr.includes('invite_ready')) {
        clearTimeout(timer);
        done();
      }
    });
    child.once('error', fail);
    child.once('close', () => {
      clearTimeout(timer);
      fail(new Error('worker exited before readiness'));
    });
  });
  return child;
}
async function stop(child: ChildProcess) {
  const closed = once(child, 'close');
  // Windows kill(SIGTERM) is forcible: the existing fixture dispatches the real
  // signal handler over IPC there. Unix sends the OS signal. Both must exit 0.
  if (process.platform === 'win32') child.send('SIGTERM');
  else child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    expect((await closed)[0]).toBe(0);
  } finally {
    clearTimeout(timer);
  }
}

async function mcp(root: string, url: string, key?: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve('cli/dist/index.js'),
      'mcp-server',
      '--relay',
      url,
      '--allow-private-relay',
      ...(key ? ['--key', key] : []),
    ],
    env: environment(root),
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'MCP regression host', version: '1' },
    { capabilities: { elicitation: { form: {} } } },
  );
  let prompts = 0;
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    // Fixture owner's explicit connection decision, independently of task approval.
    expect(request.params.message).toContain('Separate connection consent');
    prompts++;
    return { action: 'accept', content: { connect: true } };
  });
  clients.push(client);
  await client.connect(transport);
  return { client, prompts: () => prompts };
}
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
  error?: string,
) {
  const value = await client.callTool({ name, arguments: args });
  const payload = JSON.parse((value.content as Array<{ text: string }>)[0].text);
  expect(value.isError, JSON.stringify(payload)).toBe(!!error);
  if (error) expect(payload.error).toBe(error);
  if (!error) expect(value.structuredContent).toEqual(payload);
  return payload;
}
// Model HTTP is a fixture; the failure case also injects a connection-write exception.
// MCP, CLI, keys, relay, task execution and audits are real.
it.each([
  [false, false, false],
  [true, false, false],
  [false, true, false],
  [true, true, false],
  [false, true, true],
  [true, true, true],
])(
  'Muse <-> Grok Bot over stdio: creator/name send, importer hold/read-only/write/disallow, name errors and expiry, VALID audits, SIGTERM; migrated=%s CLI=%s TTY=%s',
  async (migrated, cliFirst, ttyFirst) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'muse-grok-e2e-'));
    roots.push(root);
    const a = join(root, 'muse'),
      b = join(root, 'grok-bot');
    for (const folder of [a, b]) {
      const options = {
        home: folder,
        env: { SEALBRIDGE_DATA_DIR: folder, SEALBRIDGE_KEY_STORE: 'file' },
      };
      await resolveStoredIdentity('requester', options);
      await resolveStoredIdentity('worker', options);
      if (migrated) await cli(folder, ['worker', 'migrate', '--apply']);
      await cli(folder, ['config', 'auto-accept', 'anyone', 'write']);
    }
    let modelCalls = 0;
    const model = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        modelCalls++;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '{"ok":true}' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      });
    });
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    const endpoint = `http://127.0.0.1:${(model.address() as import('node:net').AddressInfo).port}/v1/chat/completions`;
    const relay = await startLocalRelay({ port: 0 });
    try {
      const am = await mcp(
        a,
        relay.url,
        migrated ? undefined : join(a, 'identities', 'requester.private.json'),
      );
      const bm = await mcp(b, relay.url);
      const invite = cliFirst
        ? {
            inviteToken: (
              await cli(a, [
                'invite',
                'create',
                '--share',
                'token',
                '--relay',
                relay.url,
                '--name',
                'Alpha Muse',
                '--allow-private-relay',
              ])
            )
              .trim()
              .split(/\r?\n/)[0],
          }
        : await call(am.client, 'acp_create_invite', { share: 'token', name: 'Alpha Muse' });
      const saved = JSON.parse(
        await cli(
          b,
          ['accept', '--stdin', '--alias', 'buddy', '--allow-private-relay'],
          invite.inviteToken + '\n',
        ),
      );
      const aw = await worker(a, relay.url, join(root, 'muse.jsonl'), migrated);
      const ttyCapture = { stderr: '' };
      const cliSend = (extra: string[] = []) =>
        cli(
          b,
          [
            'delegate',
            '--to',
            'buddy',
            '--title',
            'Connect',
            '--description',
            'Return JSON',
            '--input',
            '{"ok":true}',
            '--auto-approve',
            '--allow-private-relay',
            '--task-timeout-ms',
            '10000',
            ...extra,
          ],
          ttyFirst ? 'y\n' : undefined,
          ttyCapture,
          false,
          ttyFirst,
        ).then(JSON.parse);
      if (cliFirst && !ttyFirst) {
        expect(await cliSend(['--no-connect'])).toMatchObject({ state: 'SETTLED', audit: 'VALID' });
        expect(JSON.parse(await cli(b, ['connections', 'list'])).connections).toEqual([]);
      }
      const first = cliFirst
        ? await cliSend(['--audit', join(root, 'grok-first.jsonl')])
        : await call(bm.client, 'acp_delegate_task', {
            to: 'buddy',
            title: 'Connect',
            input: { ok: true },
            taskTimeoutMs: 10000,
          });
      if (cliFirst) {
        expect(first).toMatchObject({
          state: 'SETTLED',
          audit: 'VALID',
          connectionRecorded: {
            message: expect.stringContaining('Work from this peer is not allowed'),
          },
        });
        expect(first.connectionRecorded.message).toContain('sealbridge connections allow buddy\n');
        expect(first.connectionRecorded.message).toMatch(
          /読み取り専用.*sealbridge connections allow buddy$/,
        );
        expect(first.connectionRecordWarning).toBeUndefined();
        expect(JSON.parse(await cli(b, ['connections', 'list'])).connections).toContainEqual(
          expect.objectContaining({ alias: 'buddy', state: 'connected', acceptance: 'off' }),
        );
        expect(
          verifyAudit(parseJsonl(readFileSync(join(root, 'grok-first.jsonl'), 'utf8'))).status,
        ).toBe('VALID');
        expect(
          verifyAudit(
            parseJsonl(
              readFileSync(
                join(root, ttyFirst ? 'muse.jsonl' : `muse.${first.taskId}.jsonl`),
                'utf8',
              ),
            ),
          ).status,
        ).toBe('VALID');
      } else
        expect(first).toMatchObject({
          status: 'SETTLED',
          auditBundle: { valid: true, status: 'VALID' },
        });
      if (ttyFirst) expect(ttyCapture.stderr.match(/Confirm owner decision/g)).toHaveLength(1);
      expect(bm.prompts()).toBe(cliFirst ? 0 : 1);
      const list = await call(bm.client, 'acp_list_connections');
      expect(list.connections).toContainEqual(
        expect.objectContaining({
          alias: 'buddy',
          acceptance: 'off',
          inviteCreator: 'peer',
          allowsWork: false,
        }),
      );
      await cli(b, ['connections', 'allow', 'buddy']);
      await cli(b, ['connections', 'disallow', 'buddy']);
      await cli(b, ['connections', 'alias', 'buddy', 'muse-connected', '--role', 'requester']);
      const named = await call(bm.client, 'acp_delegate_task', {
        to: 'muse-connected',
        title: 'Name',
        input: { ok: true },
        taskTimeoutMs: 10000,
      });
      expect(named).toMatchObject({
        status: 'SETTLED',
        deliverable: { ok: true },
        auditBundle: { status: 'VALID' },
        acceptanceWarning: { code: 'PEER_APPROVAL_MAY_BE_REQUIRED' },
      });
      expect(bm.prompts()).toBe(cliFirst ? 0 : 1);
      const aList = cliFirst
        ? JSON.parse(await cli(a, ['connections', 'list']))
        : await call(am.client, 'acp_list_connections');
      const peer = aList.connections.find((c: { state: string }) => c.state === 'connected');
      const bw = await worker(b, relay.url, join(root, 'grok.jsonl'), migrated, endpoint);
      let returnAttempt = 0;
      const send = async (error?: string) => {
        if (!cliFirst)
          return call(
            am.client,
            'acp_delegate_task',
            { to: peer.alias, title: 'Return', input: { ok: true }, taskTimeoutMs: 10000 },
            error,
          );
        const requesterAudit = join(root, `muse-return-${++returnAttempt}.jsonl`);
        try {
          const result = JSON.parse(
            await cli(a, [
              'delegate',
              '--to',
              peer.alias,
              '--title',
              'Return',
              '--description',
              'Return JSON',
              '--input',
              '{"ok":true}',
              '--auto-approve',
              '--allow-private-relay',
              '--task-timeout-ms',
              '10000',
              '--audit',
              requesterAudit,
            ]),
          );
          expect(error).toBeUndefined();
          expect(verifyAudit(parseJsonl(readFileSync(requesterAudit, 'utf8'))).status).toBe(
            'VALID',
          );
          return { ...result, status: result.state, auditBundle: { status: result.audit } };
        } catch (e) {
          if (!error) throw e;
          expect(String(e)).toContain(error);
          return { retryable: false, acceptanceWarning: { code: 'PEER_APPROVAL_MAY_BE_REQUIRED' } };
        }
      };
      const held = await send('PENDING_OWNER_APPROVAL');
      expect(held).toMatchObject({
        retryable: false,
        acceptanceWarning: { code: 'PEER_APPROVAL_MAY_BE_REQUIRED' },
      });
      expect(modelCalls).toBe(0);
      await cli(b, ['connections', 'allow', 'muse-connected']);
      expect((await call(bm.client, 'acp_list_connections')).connections[0]).toMatchObject({
        acceptance: 'read-only',
        allowedWork: 'read-only',
      });
      const readResult = await send();
      expect(readResult).toMatchObject({
        status: 'SETTLED',
        deliverable: { ok: true },
        auditBundle: { status: 'VALID' },
      });
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
      expect(writeResult).toMatchObject({
        status: 'SETTLED',
        deliverable: { ok: true },
        auditBundle: { status: 'VALID' },
      });
      await cli(b, ['connections', 'disallow', 'muse-connected']);
      await send('PENDING_OWNER_APPROVAL');
      expect(am.prompts()).toBe(0);

      await call(
        bm.client,
        'acp_delegate_task',
        { to: 'missing', title: 'Unknown' },
        'CONNECTION_NOT_FOUND',
      );
      // Establish a second real connection in B's other key scope, with the same local name.
      // Unmigrated A has separate worker/requester keys; migrated A retains its legacy worker.
      const alternate = (
        await cli(a, [
          'invite',
          'create',
          '--share',
          'token',
          '--key',
          join(
            a,
            'identities',
            cliFirst && !migrated ? 'requester.private.json' : 'worker.private.json',
          ),
          '--relay',
          relay.url,
          '--name',
          'Other Muse',
          '--allow-private-relay',
        ])
      )
        .trim()
        .split(/\r?\n/)[0];
      const legacy = await mcp(b, relay.url, join(b, 'identities', 'worker.private.json'));
      await call(legacy.client, 'acp_delegate_task', {
        inviteToken: alternate,
        title: 'Other connection',
        taskTimeoutMs: 10000,
      });
      await cli(b, ['connections', 'alias', 'other-muse', 'muse-connected', '--role', 'worker']);
      await call(
        bm.client,
        'acp_delegate_task',
        { to: 'muse-connected', title: 'Ambiguous' },
        'CONNECTION_ALIAS_AMBIGUOUS',
      );
      await cli(
        b,
        ['accept', '--stdin', '--alias', 'muse-connected', '--allow-private-relay'],
        alternate + '\n',
      );
      await call(
        bm.client,
        'acp_delegate_task',
        { to: 'muse-connected', title: 'Conflict' },
        'CONNECTION_TARGET_CONFLICT',
      );
      if (cliFirst) {
        const before = JSON.parse(await cli(b, ['connections', 'list']));
        await expect(
          cli(b, [
            'delegate',
            '--to',
            'muse-connected',
            '--title',
            'Conflict',
            '--description',
            'No send',
            '--input',
            '{}',
            '--auto-approve',
            '--allow-private-relay',
          ]),
        ).rejects.toThrow('CONNECTION_TARGET_CONFLICT');
        expect(JSON.parse(await cli(b, ['connections', 'list']))).toEqual(before);
      }
      await cli(b, ['invites', 'remove', 'muse-connected']);
      const otherList = await call(bm.client, 'acp_list_connections');
      const otherPeer = otherList.connections.find(
        (c: { peerOwnerDid: string }) => c.peerOwnerDid !== list.connections[0].peerOwnerDid,
      );
      await cli(b, [
        'connections',
        'alias',
        otherPeer.peerOwnerDid,
        'other-connected',
        '--role',
        'worker',
      ]);
      // Real wall-clock expiry, never fake timers in subprocesses. Import before expiry.
      const short = cliFirst
        ? {
            inviteToken: (
              await cli(a, [
                'invite',
                'create',
                '--share',
                'token',
                '--relay',
                relay.url,
                '--name',
                'Alpha Muse',
                '--expires-in',
                '3',
                '--allow-private-relay',
              ])
            )
              .trim()
              .split(/\r?\n/)[0],
          }
        : await call(am.client, 'acp_create_invite', {
            share: 'token',
            name: 'Muse',
            expiresInSeconds: 3,
          });
      await cli(
        b,
        ['accept', '--stdin', '--alias', 'muse-connected', '--allow-private-relay'],
        short.inviteToken + '\n',
      );
      // Use the verified invitation parser rather than depending on its serialized layout.
      const expiry = parseAndVerifyInviteToken(short.inviteToken, Date.now(), {
        allowPrivateRelay: true,
      }).expiresAt;
      await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(expiry) - Date.now() + 30)));
      await call(
        bm.client,
        'acp_delegate_task',
        { peerRef: 'muse-connected', title: 'Expired explicit' },
        'INVITE_EXPIRED',
      );
      expect(
        await call(bm.client, 'acp_delegate_task', {
          to: 'muse-connected',
          title: 'Expired fallback',
          taskTimeoutMs: 10000,
        }),
      ).toMatchObject({ status: 'SETTLED', auditBundle: { status: 'VALID' } });
      expect(saved.workerRef).toBeDefined();
      await stop(writeWorker);
      await stop(aw);
      const suffix = migrated ? '' : '.requester';
      for (const path of [
        join(root, `muse${cliFirst && !migrated ? '' : suffix}.jsonl`),
        join(root, `grok${suffix}.${readResult.taskId}.jsonl`),
        join(root, `grok-write${suffix}.${writeResult.taskId}.jsonl`),
      ]) {
        expect(verifyAudit(parseJsonl(readFileSync(path, 'utf8'))).status, path).toBe('VALID');
        expect(
          await cli(path.startsWith(join(root, 'muse')) ? a : b, ['audit-verify', path]),
        ).toContain('VALID');
      }
    } finally {
      await Promise.all(clients.splice(0).map((c) => c.close()));
      for (const child of children.splice(0))
        if (child.exitCode === null && child.signalCode === null) await stop(child);
      await relay.close();
      await new Promise<void>((res, rej) => model.close((e) => (e ? rej(e) : res())));
    }
  },
  90000,
);

// All identities, receivers, CLI sends and relay traffic below use temporary data only.
it.each(['unreachable', 'DID mismatch'] as const)(
  'non-TTY CLI leaves no importer record on %s',
  async (failure) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'non-tty-failure-'));
    roots.push(root);
    const a = join(root, 'a'),
      b = join(root, 'b');
    const impostor = generateKeyPair();
    let mismatched = false;
    const relay = await startLocalRelay({
      port: 0,
      tamper: (envelope) => {
        if (failure === 'DID mismatch' && envelope.payload.eventType === 'ACCEPT') {
          mismatched = true;
          return signPayload({ ...envelope.payload, senderDid: impostor.did }, impostor);
        }
        return envelope;
      },
    });
    let receiver: ChildProcess | undefined;
    try {
      await resolveStoredIdentity('requester', {
        env: { SEALBRIDGE_DATA_DIR: a, SEALBRIDGE_KEY_STORE: 'file' },
      });
      await cli(a, ['config', 'auto-accept', 'invited', 'write']);
      const token = (
        await cli(a, [
          'invite',
          'create',
          '--share',
          'token',
          '--relay',
          relay.url,
          '--name',
          'A',
          '--allow-private-relay',
        ])
      )
        .trim()
        .split(/\r?\n/)[0];
      await cli(b, ['accept', '--stdin', '--alias', 'a', '--allow-private-relay'], token + '\n');
      expect(JSON.parse(await cli(b, ['connections', 'list'])).connections).toEqual([]);
      if (failure === 'DID mismatch')
        receiver = await worker(a, relay.url, join(root, 'a.jsonl'), false);
      await expect(
        cli(b, [
          'delegate',
          '--to',
          'a',
          '--title',
          'Failure',
          '--description',
          'No connection',
          '--input',
          '{}',
          '--auto-approve',
          '--allow-private-relay',
          '--task-timeout-ms',
          '3000',
          '--wait-timeout-ms',
          '1500',
        ]),
      ).rejects.toThrow(
        failure === 'DID mismatch' ? 'INVALID_OR_REPLAYED_SESSION_ENVELOPE' : /TIMEOUT/,
      );
      expect(mismatched).toBe(failure === 'DID mismatch');
      expect(JSON.parse(await cli(b, ['connections', 'list'])).connections).toEqual([]);
    } finally {
      if (receiver) await stop(receiver);
      await relay.close();
    }
  },
  20000,
);

it.each([false, true])(
  'non-TTY connection-write failure warns, settles with VALID audits, and later delegate records; migrated=%s',
  async (migrated) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'connection-write-failure-'));
    roots.push(root);
    const a = join(root, 'muse'),
      b = join(root, 'grok-bot');
    for (const folder of [a, b]) {
      const options = {
        home: folder,
        env: { SEALBRIDGE_DATA_DIR: folder, SEALBRIDGE_KEY_STORE: 'file' },
      };
      await resolveStoredIdentity('requester', options);
      await resolveStoredIdentity('worker', options);
      if (migrated) await cli(folder, ['worker', 'migrate', '--apply']);
      await cli(folder, ['config', 'auto-accept', 'anyone', 'write']);
    }
    const relay = await startLocalRelay({ port: 0 });
    let receiver: ChildProcess | undefined;
    try {
      const invite = {
        inviteToken: (
          await cli(a, [
            'invite',
            'create',
            '--share',
            'token',
            '--relay',
            relay.url,
            '--name',
            'Muse',
            '--allow-private-relay',
          ])
        )
          .trim()
          .split(/\r?\n/)[0],
      };
      await cli(
        b,
        ['accept', '--stdin', '--alias', 'saved-muse', '--allow-private-relay'],
        invite.inviteToken + '\n',
      );
      receiver = await worker(a, relay.url, join(root, 'muse.jsonl'), migrated);
      const capture = { stderr: '' };
      const failed = JSON.parse(
        await cli(
          b,
          [
            'delegate',
            '--to',
            'saved-muse',
            '--title',
            'Record failure',
            '--description',
            'Return JSON',
            '--input',
            '{"ok":true}',
            '--auto-approve',
            '--allow-private-relay',
            '--task-timeout-ms',
            '10000',
            '--audit',
            join(root, 'record-failure.jsonl'),
          ],
          undefined,
          capture,
          true,
        ),
      );
      expect(failed).toMatchObject({
        state: 'SETTLED',
        audit: 'VALID',
        deliverable: { ok: true },
        connectionRecordWarning: {
          code: 'CONNECTION_RECORD_FAILED',
          peerOwnerDid: parseAndVerifyInviteToken(invite.inviteToken, Date.now(), {
            allowPrivateRelay: true,
          }).ownerDid,
          message: expect.stringContaining('Connection was not recorded'),
        },
      });
      expect(failed.connectionRecorded).toBeUndefined();
      expect(capture.stderr).toContain(failed.connectionRecordWarning.message);
      expect(capture.stderr).toContain('接続を記録できませんでした');
      expect(capture.stderr).toContain('Re-run delegate or use TTY/MCP');
      expect(JSON.parse(await cli(b, ['connections', 'list'])).connections).toEqual([]);
      expect(
        verifyAudit(parseJsonl(readFileSync(join(root, 'record-failure.jsonl'), 'utf8'))).status,
      ).toBe('VALID');
      expect(verifyAudit(parseJsonl(readFileSync(join(root, 'muse.jsonl'), 'utf8'))).status).toBe(
        'VALID',
      );
      // Send the raw invite on recovery: the notice must still use the connection's
      // saved invite alias, rather than the token, saved reference, or DID.
      const recovered = JSON.parse(
        await cli(b, [
          'delegate',
          '--to',
          invite.inviteToken,
          '--title',
          'Recover',
          '--description',
          'Return JSON',
          '--input',
          '{"ok":true}',
          '--auto-approve',
          '--allow-private-relay',
          '--task-timeout-ms',
          '10000',
          '--audit',
          join(root, 'recovered.jsonl'),
        ]),
      );
      expect(recovered).toMatchObject({
        state: 'SETTLED',
        audit: 'VALID',
        connectionRecorded: { peerOwnerDid: failed.connectionRecordWarning.peerOwnerDid },
      });
      expect(recovered.connectionRecordWarning).toBeUndefined();
      expect(recovered.connectionRecorded.message).toContain(
        'sealbridge connections allow saved-muse\n',
      );
      expect(recovered.connectionRecorded.message).toMatch(
        /読み取り専用.*sealbridge connections allow saved-muse$/,
      );
      expect(JSON.parse(await cli(b, ['connections', 'list'])).connections).toContainEqual(
        expect.objectContaining({ alias: 'saved-muse', acceptance: 'off' }),
      );
      expect(
        verifyAudit(parseJsonl(readFileSync(join(root, 'recovered.jsonl'), 'utf8'))).status,
      ).toBe('VALID');
      expect(
        verifyAudit(parseJsonl(readFileSync(join(root, `muse.${recovered.taskId}.jsonl`), 'utf8')))
          .status,
      ).toBe('VALID');
    } finally {
      if (receiver) await stop(receiver);
      await relay.close();
    }
  },
  30000,
);

it.each(['cli', 'mcp'] as const)(
  'reports a saved-alias collision through %s without stealing the other DID name',
  async (mode) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'invite-name-collision-'));
    roots.push(root);
    const a = join(root, 'a'),
      b = join(root, 'b');
    const options = { env: environment(b) };
    const local = await resolveStoredIdentity('requester', options),
      other = generateKeyPair();
    const relay = await startLocalRelay({ port: 0 });
    let receiver: ChildProcess | undefined;
    try {
      const localCard = createSignedAgentCard(
        { name: 'Local', agentDid: local.did, relayEndpoint: relay.url, skills: [] },
        local,
      );
      const localInvite = parseAndVerifyInviteToken(
        createInviteToken({ agentCard: localCard }, local),
        Date.now(),
        { allowPrivateRelay: true },
      );
      const store = new WorkerTrustStore(local, { path: workerIntakePath(local.did, options) });
      store.redeemTaskInvite(
        localInvite,
        {
          peerOwnerDid: other.did,
          peerAgentDid: other.did,
          peerDisplayName: 'Buddy',
          relayUrl: relay.url,
        },
        'seed-existing-peer',
      );
      await resolveStoredIdentity('requester', { env: environment(a) });
      await resolveStoredIdentity('worker', { env: environment(a) });
      await cli(a, ['config', 'auto-accept', 'anyone', 'write']);
      const invite = (
        await cli(a, [
          'invite',
          'create',
          '--share',
          'token',
          '--relay',
          relay.url,
          '--name',
          'Alpha Muse',
          '--allow-private-relay',
        ])
      )
        .trim()
        .split(/\r?\n/)[0];
      await cli(
        b,
        ['accept', '--stdin', '--alias', 'buddy', '--allow-private-relay'],
        invite + '\n',
      );
      receiver = await worker(a, relay.url, join(root, 'worker.jsonl'), false);
      let recorded;
      if (mode === 'cli') {
        const capture = { stderr: '' };
        const result = JSON.parse(
          await cli(
            b,
            [
              'delegate',
              '--invite',
              'buddy',
              '--title',
              'Collision',
              '--description',
              'Return JSON',
              '--input',
              '{}',
              '--auto-approve',
              '--allow-private-relay',
              '--task-timeout-ms',
              '10000',
            ],
            undefined,
            capture,
          ),
        );
        expect(result).toMatchObject({ state: 'SETTLED', audit: 'VALID' });
        recorded = result.connectionRecorded;
        expect(capture.stderr).toContain('different peer');
        expect(recorded.message).toContain('connections allow alpha-muse');
      } else {
        const host = await mcp(b, relay.url);
        const result = await call(host.client, 'acp_delegate_task', {
          peerRef: 'buddy',
          title: 'Collision',
          input: {},
          taskTimeoutMs: 10000,
        });
        expect(result).toMatchObject({ status: 'SETTLED', auditBundle: { status: 'VALID' } });
        recorded = result.connectionRecorded;
      }
      expect(recorded.aliasWarning.message).toContain(
        '保存した招待名 "buddy" は別の相手が使用中のため、接続名は "alpha-muse" になりました。',
      );
      expect(recorded).toMatchObject({
        alias: 'alpha-muse',
        aliasWarning: { code: 'CONNECTION_ALIAS_EXISTS', savedAlias: 'buddy' },
      });
      const listed = JSON.parse(await cli(b, ['connections', 'list'])).connections;
      expect(listed).toContainEqual(
        expect.objectContaining({ alias: 'buddy', peerOwnerDid: other.did }),
      );
      expect(listed).toContainEqual(
        expect.objectContaining({ alias: 'alpha-muse', peerOwnerDid: recorded.peerOwnerDid }),
      );
      await cli(b, ['connections', 'allow', 'alpha-muse']);
    } finally {
      await Promise.all(clients.splice(0).map((c) => c.close()));
      if (receiver) await stop(receiver);
      await relay.close();
    }
  },
  30000,
);

it.each([
  [false, 'cli', 'automatic'],
  [true, 'cli', 'automatic'],
  [false, 'tty', 'automatic'],
  [true, 'tty', 'automatic'],
  [false, 'mcp', 'automatic'],
  [true, 'mcp', 'automatic'],
  [false, 'cli', 'missing'],
  [false, 'mcp', 'corrupt'],
] as const)(
  'accept without --alias keeps the derived connection name; migrated=%s mode=%s intent=%s',
  async (migrated, mode, intent) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'auto-alias-process-'));
    roots.push(root);
    const a = join(root, 'a'),
      b = join(root, 'b');
    for (const folder of [a, b]) {
      await resolveStoredIdentity('requester', { env: environment(folder) });
      await resolveStoredIdentity('worker', { env: environment(folder) });
      if (migrated) await cli(folder, ['worker', 'migrate', '--apply']);
      await cli(folder, ['config', 'auto-accept', 'anyone', 'write']);
    }
    const relay = await startLocalRelay({ port: 0 });
    let receiver: ChildProcess | undefined;
    try {
      const token = (
        await cli(a, [
          'invite',
          'create',
          '--share',
          'token',
          '--relay',
          relay.url,
          '--name',
          'Gamma Bot',
          '--allow-private-relay',
        ])
      )
        .trim()
        .split(/\r?\n/)[0];
      const saved = JSON.parse(
        await cli(b, ['accept', '--stdin', '--allow-private-relay'], token + '\n'),
      );
      if (intent !== 'automatic') {
        await cli(
          b,
          ['accept', '--stdin', '--allow-private-relay', '--alias', saved.alias],
          token + '\n',
        );
        const key = await resolveStoredIdentity('requester', { env: environment(b) });
        const path = new InviteStore(key, { env: environment(b) }).aliasPath;
        if (intent === 'missing') unlinkSync(path);
        else writeFileSync(path, '{corrupt');
      }
      expect(saved.alias).toMatch(/^gamma-bot-[a-f0-9]{12}$/);
      expect(saved.aliasExplicit).toBeUndefined();
      receiver = await worker(a, relay.url, join(root, 'worker.jsonl'), migrated);
      if (mode === 'mcp') {
        const host = await mcp(b, relay.url);
        expect(
          await call(host.client, 'acp_delegate_task', {
            to: saved.alias,
            title: 'Automatic alias',
            input: {},
            taskTimeoutMs: 10000,
          }),
        ).toMatchObject({
          status: 'SETTLED',
          auditBundle: { status: 'VALID' },
          connectionRecorded: { alias: 'gamma-bot' },
        });
        expect(host.prompts()).toBe(1);
      } else {
        const capture = { stderr: '' };
        const result = JSON.parse(
          await cli(
            b,
            [
              'delegate',
              '--to',
              saved.alias,
              '--title',
              'Automatic alias',
              '--description',
              'Return JSON',
              '--input',
              '{}',
              '--auto-approve',
              '--allow-private-relay',
              '--task-timeout-ms',
              '10000',
              '--audit',
              join(root, 'requester.jsonl'),
            ],
            mode === 'tty' ? 'y\n' : undefined,
            capture,
            false,
            mode === 'tty',
          ),
        );
        expect(result).toMatchObject({ state: 'SETTLED', audit: 'VALID' });
        expect(result.connectionRecorded.alias).toBe('gamma-bot');
        expect(result.connectionRecorded.message).toContain('connections allow gamma-bot\n');
        expect(
          verifyAudit(parseJsonl(readFileSync(join(root, 'requester.jsonl'), 'utf8'))).status,
        ).toBe('VALID');
        if (mode === 'tty') expect(capture.stderr).toContain('Confirm owner decision');
      }
      expect(JSON.parse(await cli(b, ['connections', 'list'])).connections).toContainEqual(
        expect.objectContaining({ alias: 'gamma-bot', state: 'connected', acceptance: 'off' }),
      );
      expect(verifyAudit(parseJsonl(readFileSync(join(root, 'worker.jsonl'), 'utf8'))).status).toBe(
        'VALID',
      );
      await cli(b, ['connections', 'allow', 'gamma-bot']);
    } finally {
      await Promise.all(clients.splice(0).map((c) => c.close()));
      if (receiver) await stop(receiver);
      await relay.close();
    }
  },
  60000,
);

async function legacyAliasProcessCase(kind: 'old-write' | 'held-lock' | 'read-only') {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'alias-maintenance-'));
  roots.push(root);
  const a = join(root, 'a'),
    b = join(root, 'b');
  for (const folder of [a, b]) {
    await resolveStoredIdentity('requester', { env: environment(folder) });
    await resolveStoredIdentity('worker', { env: environment(folder) });
    await cli(folder, ['config', 'auto-accept', 'anyone', 'write']);
  }
  const relay = await startLocalRelay({ port: 0 });
  let receiver: ChildProcess | undefined,
    holder: ChildProcess | undefined,
    directory: string | undefined;
  try {
    const token = (
      await cli(a, [
        'invite',
        'create',
        '--share',
        'token',
        '--relay',
        relay.url,
        '--name',
        'Gamma Bot',
        '--allow-private-relay',
      ])
    )
      .trim()
      .split(/\r?\n/)[0];
    await cli(b, ['accept', '--stdin', '--alias', 'buddy', '--allow-private-relay'], token + '\n');
    const key = await resolveStoredIdentity('requester', { env: environment(b) });
    const store = new InviteStore(key, { env: environment(b) });
    if (kind === 'old-write') {
      const other = generateKeyPair();
      const card = createSignedAgentCard(
        {
          name: 'Unrelated',
          agentDid: other.did,
          relayEndpoint: 'https://relay.example',
          skills: [],
        },
        other,
      );
      await oldAccept(b, createInviteToken({ agentCard: card, expiresInSeconds: 3600 }, other));
    } else {
      const signed = JSON.parse(readFileSync(store.path, 'utf8'));
      signed.payload.entries[0].aliasExplicit = true;
      writeFileSync(store.path, JSON.stringify(signPayload(signed.payload, key)));
      unlinkSync(store.aliasPath);
      if (kind === 'read-only') {
        directory = dirname(store.path);
        chmodSync(directory, 0o500);
      } else {
        holder = spawn(
          process.execPath,
          [
            '-e',
            `
          const fs = require('node:fs'), path = process.argv[1];
          fs.writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 });
          process.stdout.write('locked'); process.stdin.resume();
          process.stdin.on('end', () => { fs.unlinkSync(path); process.exit(0); });
        `,
            store.path + '.lock',
          ],
          { stdio: ['pipe', 'pipe', 'pipe'] },
        );
        children.push(holder);
        await once(holder.stdout!, 'data');
      }
    }
    expect(JSON.parse(await cli(b, ['invites', 'list'])).invites).toContainEqual(
      expect.objectContaining({ alias: 'buddy', aliasExplicit: true }),
    );
    receiver = await worker(a, relay.url, join(root, 'worker.jsonl'), false);
    const result = JSON.parse(
      await cli(b, [
        'delegate',
        '--to',
        'buddy',
        '--title',
        'Alias maintenance',
        '--description',
        'Return JSON',
        '--input',
        '{}',
        '--auto-approve',
        '--allow-private-relay',
        '--task-timeout-ms',
        '10000',
        '--audit',
        join(root, 'requester.jsonl'),
      ]),
    );
    expect(result).toMatchObject({
      state: 'SETTLED',
      audit: 'VALID',
      connectionRecorded: { alias: 'buddy' },
    });
    expect(JSON.parse(await cli(b, ['connections', 'list'])).connections).toContainEqual(
      expect.objectContaining({ alias: 'buddy', state: 'connected', acceptance: 'off' }),
    );
    expect(
      verifyAudit(parseJsonl(readFileSync(join(root, 'requester.jsonl'), 'utf8'))).status,
    ).toBe('VALID');
    expect(verifyAudit(parseJsonl(readFileSync(join(root, 'worker.jsonl'), 'utf8'))).status).toBe(
      'VALID',
    );
    if (kind !== 'old-write')
      expect(JSON.parse(readFileSync(store.path, 'utf8')).payload.entries[0].aliasExplicit).toBe(
        true,
      );
    if (holder) {
      const closed = once(holder, 'close');
      holder.stdin!.end();
      expect((await closed)[0]).toBe(0);
      holder = undefined;
    }
    if (directory) {
      chmodSync(directory, 0o700);
      directory = undefined;
    }
    // A later write completes the deferred migration without losing the name.
    await cli(b, ['accept', '--stdin', '--alias', 'buddy', '--allow-private-relay'], token + '\n');
    expect(JSON.parse(readFileSync(store.path, 'utf8')).payload.entries[0]).not.toHaveProperty(
      'aliasExplicit',
    );
  } finally {
    if (directory) chmodSync(directory, 0o700);
    if (holder) {
      const closed = once(holder, 'close');
      holder.stdin!.end();
      await closed;
    }
    if (receiver) await stop(receiver);
    await relay.close();
  }
}
it.each(['old-write', 'held-lock'] as const)(
  'keeps buddy through real-process %s and delegate --to buddy',
  legacyAliasProcessCase,
  60000,
);
it.skipIf(process.platform === 'win32')(
  'keeps buddy through a read-only invites directory and delegate --to buddy',
  () => legacyAliasProcessCase('read-only'),
  60000,
);
