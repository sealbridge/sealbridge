// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  chmodSync,
  mkdirSync,
  symlinkSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkedChildOutput } from './child-process-result.js';
import {
  createInviteToken,
  createSignedAgentCard,
  generateKeyPair,
  signPayload,
} from '../packages/core/src/index.js';
import { InviteStore, resolveStoredIdentity } from '../packages/runtime/src/index.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('keeps the Japanese compatibility paragraphs in valid UTF-8 without question-mark runs', () => {
  for (const file of ['README.ja.md', 'docs/connections/invite-lifecycle.ja.md', 'CHANGELOG.md']) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(resolve(file)));
    expect(text).not.toMatch(/\?{3,}/);
    if (file.endsWith('.ja.md')) expect(text).toContain('明示的な招待別名の指定は');
  }
});
async function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'invite-downgrade-'));
  roots.push(root);
  const env = { ...process.env, SEALBRIDGE_DATA_DIR: root, SEALBRIDGE_KEY_STORE: 'file' };
  const identity = await resolveStoredIdentity('requester', { env });
  const peer = generateKeyPair();
  const card = createSignedAgentCard(
    { name: 'Gamma Bot', agentDid: peer.did, relayEndpoint: 'https://relay.example', skills: [] },
    peer,
  );
  const token = createInviteToken({ agentCard: card, expiresInSeconds: 3600 }, peer);
  const store = new InviteStore(identity, { env });
  function cli(args: string[], input?: string, capture?: { stderr: string }) {
    const result = spawnSync(process.execPath, [resolve('cli/dist/index.js'), ...args], {
      env,
      input,
      encoding: 'utf8',
      timeout: 30000,
    });
    const stdout = checkedChildOutput(result);
    if (capture) capture.stderr = result.stderr;
    return JSON.parse(stdout);
  }
  function oldRead(token?: string) {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import { InviteStore } from './conformance/fixtures/pre-290-invite-store.ts';
      import { resolveStoredIdentity } from './packages/runtime/dist/index.js';
      const identity = await resolveStoredIdentity('requester');
      const store = new InviteStore(identity);
      let token = ''; for await (const chunk of process.stdin) token += chunk;
      if (token) store.import(token, 'unrelated');
      console.log(JSON.stringify(store.list()));
    `,
      ],
      { env, input: token ?? '', encoding: 'utf8', timeout: 30000 },
    );
    const stdout = checkedChildOutput(result);
    return JSON.parse(stdout);
  }
  return { env, identity, token, store, cli, oldRead };
}
it('new CLI accept remains readable by a separate frozen old reader; duplicate accepts and removal track intent', async () => {
  const f = await fixture();
  const saved = f.cli(['accept', '--stdin', '--alias', 'chosen'], f.token + '\n');
  expect(saved.aliasExplicit).toBe(true);
  expect(f.oldRead()).toMatchObject([{ alias: 'chosen' }]);
  expect(JSON.parse(readFileSync(f.store.path, 'utf8')).payload.entries[0]).not.toHaveProperty(
    'aliasExplicit',
  );
  unlinkSync(f.store.aliasPath);
  expect(f.cli(['invites', 'list']).invites[0].aliasExplicit).toBeUndefined();
  expect(f.cli(['accept', '--stdin', '--alias', 'chosen'], f.token + '\n').aliasExplicit).toBe(
    true,
  );
  expect(f.oldRead()).toHaveLength(1);
  f.cli(['invites', 'remove', 'chosen']);
  expect(JSON.parse(readFileSync(f.store.aliasPath, 'utf8')).payload.marks).toEqual([]);
  expect(f.oldRead()).toEqual([]);
  expect(f.cli(['accept', '--stdin', '--alias', 'renamed'], f.token + '\n').aliasExplicit).toBe(
    true,
  );
  expect(f.oldRead()).toMatchObject([{ alias: 'renamed' }]);
}, 60000);
it('preserves a per-record explicit mark after a real old process accepts an unrelated invite', async () => {
  const f = await fixture();
  f.cli(['accept', '--stdin', '--alias', 'buddy'], f.token + '\n');
  const peer = generateKeyPair();
  const card = createSignedAgentCard(
    { name: 'Other', agentDid: peer.did, relayEndpoint: 'https://relay.example', skills: [] },
    peer,
  );
  expect(
    f.oldRead(createInviteToken({ agentCard: card, expiresInSeconds: 3600 }, peer)),
  ).toHaveLength(2);
  expect(f.cli(['invites', 'list']).invites).toContainEqual(
    expect.objectContaining({ alias: 'buddy', aliasExplicit: true }),
  );
  expect(JSON.parse(readFileSync(f.store.aliasPath, 'utf8')).payload).not.toHaveProperty(
    'recordsDigest',
  );
}, 60000);
it.each(['directory', ...(process.platform === 'win32' ? [] : ['permissions', 'symlink'])])(
  'prints one bilingual stderr notice for a real %s sidecar and keeps stdout valid JSON',
  async (kind) => {
    const f = await fixture();
    f.cli(['accept', '--stdin', '--alias', 'buddy'], f.token + '\n');
    if (kind === 'permissions') chmodSync(f.store.aliasPath, 0o644);
    else {
      const target = f.store.aliasPath + '.target';
      writeFileSync(target, readFileSync(f.store.aliasPath), { mode: 0o600 });
      unlinkSync(f.store.aliasPath);
      if (kind === 'directory') mkdirSync(f.store.aliasPath, { mode: 0o700 });
      else symlinkSync(target, f.store.aliasPath);
    }
    const capture = { stderr: '' };
    expect(f.cli(['accept', '--stdin', '--alias', 'buddy'], f.token + '\n', capture)).toMatchObject(
      { alias: 'buddy', aliasExplicit: kind === 'permissions' },
    );
    expect(capture.stderr.match(/INVITE_ALIAS_METADATA_UNAVAILABLE/g) ?? []).toHaveLength(
      kind === 'permissions' ? 0 : 1,
    );
    if (kind === 'permissions') {
      expect(statSync(f.store.aliasPath).mode & 0o777).toBe(0o600);
      expect(f.cli(['invites', 'list']).invites[0].aliasExplicit).toBe(true);
      return;
    }
    expect(capture.stderr).toContain('招待別名の明示指定を読み取り・保存できませんでした');
    expect(f.cli(['invites', 'list']).invites[0].aliasExplicit).toBeUndefined();
  },
  60000,
);
it.each(['list', 'accept'] as const)(
  'a new CLI %s process migrates a signed inline main marker before the frozen old reader opens it',
  async (action) => {
    const f = await fixture();
    f.cli(['accept', '--stdin', '--alias', 'chosen'], f.token + '\n');
    unlinkSync(f.store.aliasPath);
    const signed = JSON.parse(readFileSync(f.store.path, 'utf8'));
    signed.payload.entries[0].aliasExplicit = true;
    writeFileSync(f.store.path, JSON.stringify(signPayload(signed.payload, f.identity)));
    expect(
      action === 'list'
        ? f.cli(['invites', 'list']).invites[0].aliasExplicit
        : f.cli(['accept', '--stdin', '--alias', 'chosen'], f.token + '\n').aliasExplicit,
    ).toBe(true);
    expect(f.oldRead()).toMatchObject([{ alias: 'chosen' }]);
    expect(JSON.parse(readFileSync(f.store.path, 'utf8')).payload.entries[0]).not.toHaveProperty(
      'aliasExplicit',
    );
  },
  60000,
);
it.each(['missing', 'corrupt', 'wrong-signature'] as const)(
  'new processes ignore %s sidecar without breaking accept or old validation',
  async (kind) => {
    const f = await fixture();
    f.cli(['accept', '--stdin', '--alias', 'chosen'], f.token + '\n');
    if (kind === 'missing') unlinkSync(f.store.aliasPath);
    else if (kind === 'corrupt') writeFileSync(f.store.aliasPath, '{broken');
    else {
      const signed = JSON.parse(readFileSync(f.store.aliasPath, 'utf8'));
      writeFileSync(
        f.store.aliasPath,
        JSON.stringify(signPayload(signed.payload, generateKeyPair())),
      );
    }
    expect(f.cli(['invites', 'list']).invites[0].aliasExplicit).toBeUndefined();
    expect(f.cli(['accept', '--stdin'], f.token + '\n').aliasExplicit).toBeUndefined();
    expect(f.oldRead()).toMatchObject([{ alias: 'chosen' }]);
  },
  60000,
);
