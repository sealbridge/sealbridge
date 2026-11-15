// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInviteToken, createSignedAgentCard, generateKeyPair, signPayload } from '../packages/core/src/index.js';
import { InviteStore, resolveStoredIdentity } from '../packages/runtime/src/index.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'invite-downgrade-')); roots.push(root);
  const env = { ...process.env, SEALBRIDGE_DATA_DIR: root, SEALBRIDGE_KEY_STORE: 'file' };
  const identity = await resolveStoredIdentity('requester', { env });
  const peer = generateKeyPair();
  const card = createSignedAgentCard({ name: 'Gamma Bot', agentDid: peer.did, relayEndpoint: 'https://relay.example', skills: [] }, peer);
  const token = createInviteToken({ agentCard: card, expiresInSeconds: 3600 }, peer);
  const store = new InviteStore(identity, { env });
  function cli(args: string[], input?: string) {
    const result = spawnSync(process.execPath, [resolve('cli/dist/index.js'), ...args], { env, input, encoding: 'utf8', timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }
  function oldRead() {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { InviteStore } from './conformance/fixtures/pre-290-invite-store.ts';
      import { resolveStoredIdentity } from './packages/runtime/dist/index.js';
      const identity = await resolveStoredIdentity('requester');
      console.log(JSON.stringify(new InviteStore(identity).list()));
    `], { env, encoding: 'utf8', timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }
  return { env, identity, token, store, cli, oldRead };
}
it('new CLI accept remains readable by a separate frozen old reader; duplicate accepts and removal track intent', async () => {
  const f = await fixture();
  const saved = f.cli(['accept', '--stdin', '--alias', 'chosen'], f.token + '\n');
  expect(saved.aliasExplicit).toBe(true);
  expect(f.oldRead()).toMatchObject([{ alias: 'chosen' }]);
  expect(JSON.parse(readFileSync(f.store.path, 'utf8')).payload.entries[0]).not.toHaveProperty('aliasExplicit');
  unlinkSync(f.store.aliasPath);
  expect(f.cli(['invites', 'list']).invites[0].aliasExplicit).toBeUndefined();
  expect(f.cli(['accept', '--stdin', '--alias', 'chosen'], f.token + '\n').aliasExplicit).toBe(true);
  expect(f.oldRead()).toHaveLength(1);
  f.cli(['invites', 'remove', 'chosen']);
  expect(JSON.parse(readFileSync(f.store.aliasPath, 'utf8')).payload.marks).toEqual([]);
  expect(f.oldRead()).toEqual([]);
  expect(f.cli(['accept', '--stdin', '--alias', 'renamed'], f.token + '\n').aliasExplicit).toBe(true);
  expect(f.oldRead()).toMatchObject([{ alias: 'renamed' }]);
});
it.each(['list', 'accept'] as const)('a new CLI %s process migrates a signed inline main marker before the frozen old reader opens it', async action => {
  const f = await fixture();
  f.cli(['accept', '--stdin', '--alias', 'chosen'], f.token + '\n');
  unlinkSync(f.store.aliasPath);
  const signed = JSON.parse(readFileSync(f.store.path, 'utf8'));
  signed.payload.entries[0].aliasExplicit = true;
  writeFileSync(f.store.path, JSON.stringify(signPayload(signed.payload, f.identity)));
  expect(action === 'list' ? f.cli(['invites', 'list']).invites[0].aliasExplicit :
    f.cli(['accept', '--stdin', '--alias', 'chosen'], f.token + '\n').aliasExplicit).toBe(true);
  expect(f.oldRead()).toMatchObject([{ alias: 'chosen' }]);
  expect(JSON.parse(readFileSync(f.store.path, 'utf8')).payload.entries[0]).not.toHaveProperty('aliasExplicit');
});
it.each(['missing', 'corrupt', 'wrong-signature'] as const)('new processes ignore %s sidecar without breaking accept or old validation', async kind => {
  const f = await fixture();
  f.cli(['accept', '--stdin', '--alias', 'chosen'], f.token + '\n');
  if (kind === 'missing') unlinkSync(f.store.aliasPath);
  else if (kind === 'corrupt') writeFileSync(f.store.aliasPath, '{broken');
  else {
    const signed = JSON.parse(readFileSync(f.store.aliasPath, 'utf8'));
    writeFileSync(f.store.aliasPath, JSON.stringify(signPayload(signed.payload, generateKeyPair())));
  }
  expect(f.cli(['invites', 'list']).invites[0].aliasExplicit).toBeUndefined();
  expect(f.cli(['accept', '--stdin'], f.token + '\n').aliasExplicit).toBeUndefined();
  expect(f.oldRead()).toMatchObject([{ alias: 'chosen' }]);
});

