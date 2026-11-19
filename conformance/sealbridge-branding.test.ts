// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createInviteToken,
  createSignedAgentCard,
  generateKeyPair,
  parseAndVerifyInviteToken,
} from '../packages/core/src/index.js';

const manifest = JSON.parse(readFileSync(new URL('../cli/package.json', import.meta.url), 'utf8'));
const run = (name: string, args: string[]) =>
  spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../cli/' + manifest.bin[name], import.meta.url)), ...args],
    { encoding: 'utf8', timeout: 15000 },
  );

it.each([{ args: ['validate', 'does-not-exist.json'] }, { args: [] }])(
  'both bins preserve errors and exit status (%j)',
  ({ args }) => {
    const current = run('sealbridge', args);
    const legacy = run('acp', args);
    expect(current.error).toBeUndefined();
    expect(legacy.error).toBeUndefined();
    expect(current.status).toBe(1);
    expect(legacy.status).toBe(current.status);
    expect(legacy.stdout).toBe(current.stdout);
    expect(legacy.stderr).toBe('acp is deprecated; use sealbridge instead.\n' + current.stderr);
  },
);

it('both bins execute the same successful command without polluting stdout', () => {
  const current = run('sealbridge', ['validate', 'spec/examples/sample-task-manifest.json']);
  const legacy = run('acp', ['validate', 'spec/examples/sample-task-manifest.json']);
  expect(current.status).toBe(0);
  expect(legacy.status).toBe(0);
  expect(current.stdout).toBe('VALID\n');
  expect(legacy.stdout).toBe(current.stdout);
  expect(current.stderr).toBe('');
  expect(legacy.stderr).toBe('acp is deprecated; use sealbridge instead.\n');
});

it.each(['acp-invite', 'acp'] as const)(
  'accepts legacy %s invites with the old product name',
  (format) => {
    const owner = generateKeyPair();
    const card = createSignedAgentCard(
      {
        name: 'ACP Worker',
        description: 'ACP worker',
        agentDid: owner.did,
        relayEndpoint: 'https://relay.example',
        skills: [{ id: 'json-task', name: 'JSON task' }],
      },
      owner,
    );
    const token = createInviteToken({ agentCard: card, format }, owner);
    const parsed = parseAndVerifyInviteToken(token);
    expect(parsed.ownerDid).toBe(owner.did);
    expect(parsed.agentCard.payload.name).toBe('ACP Worker');
    expect(token.startsWith(format === 'acp' ? 'acp://invite?' : 'acp-invite:')).toBe(true);
  },
);
