// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '../packages/core/src/index.js';
import { startLocalRelay, HttpRelayClient } from '../packages/relay/src/index.js';
import { networkCommand } from '../cli/src/network.js';
import { RequesterClient, PolicyAutoApprovalProvider, buildTaskManifest } from '../packages/runtime/src/index.js';

it.each([[false, false], [true, false], [false, true]])('CLI advertises limits and enforces scope (allowlisted=%s, rejected=%s)', async (allowlisted, rejected) => {
  const dir = await mkdtemp(join(realpathSync(tmpdir()), 'acp-open-cli-'));
  const server = await startLocalRelay({ port: 0, host: '127.0.0.1' });
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((value) => lines.push(String(value)));
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let pending: Promise<void> | undefined;
  try {
    const worker = generateKeyPair(), requester = generateKeyPair();
    await writeFile(join(dir, 'worker.private.json'), JSON.stringify(worker), { mode: 0o600 });
    await writeFile(join(dir, 'requester.private.json'), JSON.stringify(requester), { mode: 0o600 });
    const identityOptions = { env: { SEALBRIDGE_DATA_DIR: dir }, home: dir };
    const common = ['--relay', server.url, '--allow-private-relay'];
    pending = networkCommand('worker', ['start', '--key', join(dir, 'worker.private.json'), ...common,
      '--open', '--publish', '--skill', 'echo', '--task-type', 'json', '--yes', '--once',
      '--open-max-input-tokens', '1000', '--open-max-output-tokens', '500',
      '--open-max-tool-calls', '2', '--open-max-wall-seconds', '30',
      '--open-allow-task-type', 'json, text', '--open-allow-task-type', 'json',
      '--open-rate-limit-per-did', '10/min',
      ...(allowlisted ? ['--allow-requester', requester.did] : [])], { identityOptions });
    pending.catch(() => undefined);
    const relay = new HttpRelayClient(server.url, { allowPrivateRelay: true });
    await vi.waitFor(async () => expect((await relay.discover()).length).toBe(1));
    await networkCommand('discover', [...common, '--skill', 'echo', '--task-type', 'json', '--did', worker.did]);
    const cards = JSON.parse(lines.at(-1)!);
    expect(cards[0].payload.accessMode).toBe('open');
    expect(cards[0].payload.skills[0].taskTypes).toEqual(['json', 'text']);
    expect(cards[0].payload.openPolicy).toEqual({ maxInputTokens: 1000, maxOutputTokens: 500,
      maxToolInvocations: 2, maxWallClockSeconds: 30 });
    const warnings = error.mock.calls.filter(([line]) => String(line).startsWith('[Sealbridge WARNING]'));
    expect(warnings).toHaveLength(0);
    if (rejected) {
      const client = new RequesterClient({ owner: requester,
        relay: new HttpRelayClient(server.url, requester, { allowPrivateRelay: true }),
        allowPrivateRelay: true, approvalProvider: new PolicyAutoApprovalProvider(requester) });
      const task = { title: 'Echo', description: 'Echo', input: { ok: true } };
      const delegation = client.delegate({ ...task, to: lines[0], manifest: buildTaskManifest({ ...task,
        ownerDid: requester.did, workerDid: worker.did, taskType: 'unsupported',
        budget: { maxInputTokens: 1000, maxOutputTokens: 500, maxToolInvocations: 2, maxWallClockSeconds: 30 } }) });
      await expect(delegation).rejects.toMatchObject({ code: 'TASK_SCOPE_REJECTED',
        detail: { field: 'task.scope', expected: expect.any(String), actual: expect.any(String), hint: expect.any(String) } });
      await pending?.catch(() => undefined);
      return;
    }
    const delegation = networkCommand('delegate', ['--key', join(dir, 'requester.private.json'), ...common,
      '--discover', 'echo', '--task-type', 'json', '--title', 'Echo', '--description', 'Echo',
      '--input', '{"ok":true}', '--yes'], { identityOptions });
    if (!allowlisted) {
      await expect(delegation).rejects.toMatchObject({ code: 'PENDING_OWNER_APPROVAL' });
      await expect(pending).rejects.toThrow('PENDING_OWNER_APPROVAL');
    } else {
      await delegation;
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({ state: 'SETTLED', deliverable: { ok: true } });
      await pending;
    }
  } finally {
    await server.close();
    await pending?.catch(() => undefined);
    log.mockRestore(); error.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(['open-max-input-tokens', 'open-max-output-tokens', 'open-max-tool-calls', 'open-max-wall-seconds'])
  ('CLI rejects invalid %s and requires open mode', async (flag) => {
    const dir = await mkdtemp(join(realpathSync(tmpdir()), 'acp-policy-cli-'));
    try {
      const key = join(dir, 'worker.private.json');
      await writeFile(key, JSON.stringify(generateKeyPair()), { mode: 0o600 });
      for (const value of ['0', '-1', '1.5', 'Infinity', '9007199254740992', 'no']) {
        await expect(networkCommand('worker', ['start', '--key', key, '--open', '--' + flag, value]))
          .rejects.toThrow('INVALID_' + flag.toUpperCase().replaceAll('-', '_'));
      }
      await expect(networkCommand('worker', ['start', '--key', key, '--open', '--' + flag]))
        .rejects.toThrow('Missing --' + flag);
      await expect(networkCommand('worker', ['start', '--key', key, '--' + flag, '10']))
        .rejects.toThrow('OPEN_POLICY_REQUIRES_OPEN_MODE');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
