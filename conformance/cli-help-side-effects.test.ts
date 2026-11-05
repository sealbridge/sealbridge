// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import * as core from '../packages/core/src/index.js';
import * as ledger from '../packages/ledger/src/index.js';
import * as network from '../cli/src/network.js';
import * as mcp from '../cli/src/mcp.js';
import * as pending from '../cli/src/pending.js';
import * as connections from '../cli/src/connections.js';
import * as requests from '../cli/src/requests.js';
import * as tasks from '../cli/src/tasks.js';
import * as contacts from '../cli/src/contacts.js';
import * as receipt from '../cli/src/receipt.js';
import * as doctor from '../cli/src/doctor.js';
import * as setup from '../cli/src/setup.js';
import * as config from '../cli/src/config.js';
import * as board from '../cli/src/board.js';
import * as accept from '../cli/src/accept.js';
import * as invitesMigrate from '../cli/src/invites-migrate.js';
import * as errors from '../cli/src/error-messages.js';

// Like the #179 entry-point tests, run main in a VM so exit status and output
// are observable without a subprocess. Handlers use the real filesystem and
// runtime identity/store implementations, with every writable path isolated.
const sourceUrl = new URL('../cli/src/index.ts', import.meta.url);
const source = readFileSync(sourceUrl, 'utf8').replaceAll('import.meta.url', JSON.stringify(sourceUrl.href));
const script = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
}).outputText;
const modules: Record<string, unknown> = {
  'node:fs': fs, '@acp/core': core, '@acp/ledger': ledger,
  './network.js': network, './mcp.js': mcp, './pending.js': pending,
  './connections.js': connections, './requests.js': requests, './tasks.js': tasks,
  './contacts.js': contacts, './receipt.js': receipt, './doctor.js': doctor,
  './setup.js': setup, './config.js': config, './board.js': board, './accept.js': accept,
  './invites-migrate.js': invitesMigrate, './error-messages.js': errors,
};
const localNames = new Set(['invite.txt', 'reciprocal.txt', 'request.json', 'new-invite.txt', 'qr.png',
  'audit.jsonl', 'settings.json', 'post.json', 'contacts.json', 'output.private.json', 'key.json',
  'target.json', 'approval.json', 'receipt', 'audit', 'result.json', 'input.json', 'one', 'two']);

async function command(args: string[], initial: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sealbridge-cli-help-'));
  for (const [name, contents] of Object.entries(initial)) writeFileSync(join(root, name), contents);
  const before = readdirSync(root, { recursive: true }).sort();
  const previousExitCode = process.exitCode;
  let stdout = '', stderr = '';
  const runDemo = vi.fn(async () => { throw new Error('UNEXPECTED_DEMO_EXECUTION'); });
  const localArgs = args.map((arg, index) => index > 0 && localNames.has(arg) ? join(root, arg)
    : arg === 'file:invite.txt' ? 'file:' + join(root, 'invite.txt') : arg);
  const host = { argv: ['node', 'sealbridge', ...localArgs], exitCode: 0,
    stderr: { write: (value: string, callback?: () => void) => { stderr += value; callback?.(); } },
    exit: (code: number) => { host.exitCode = code; },
  };
  try {
    for (const [name, directory] of Object.entries({ HOME: 'home', USERPROFILE: 'home', XDG_DATA_HOME: 'xdg',
      XDG_CONFIG_HOME: 'config', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata',
      SEALBRIDGE_DATA_DIR: 'data', ACP_DATA_DIR: 'legacy' })) vi.stubEnv(name, join(root, directory));
    vi.stubEnv('SEALBRIDGE_KEY_STORE', 'file');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('UNEXPECTED_NETWORK_REQUEST'); }));
    vi.spyOn(console, 'log').mockImplementation((...values) => { stdout += values.join(' ') + '\n'; });
    vi.spyOn(console, 'error').mockImplementation((...values) => { stderr += values.join(' ') + '\n'; });
    vi.spyOn(process.stdout, 'write').mockImplementation((value,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      stdout += String(value);
      if (typeof encodingOrCallback === 'function') encodingOrCallback();
      else callback?.();
      return true;
    });
    process.exitCode = 0;
    await runInNewContext(script, { exports: {}, console, process: host,
      require: (name: string) => name === '@acp/two-owner-demo' ? { runDemo } : modules[name],
    }, { filename: sourceUrl.pathname });
    expect(runDemo).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
    for (const [name, contents] of Object.entries(initial))
      expect(readFileSync(join(root, name), 'utf8')).toBe(contents);
    return { status: host.exitCode || process.exitCode, stdout, stderr };
  } finally {
    process.exitCode = previousExitCode;
    vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  }
}

const routes = [
  '', 'setup', 'config', 'config key-store', 'doctor', 'keygen', 'validate', 'approve', 'audit-verify',
  'receipt', 'contacts', 'contacts list', 'contacts add', 'contacts allow', 'contacts revoke', 'contacts remove',
  'connections', 'connections list', 'connections status', 'connections review', 'connections review list',
  'connections review approve', 'connections review reject', 'connections request', 'connections approve',
  'connections reject', 'connections withdraw', 'connections disconnect', 'connections block',
  'connections unblock', 'connections confirm-invite', 'connections prior-approved', 'connections connect-prior',
  'connections sync', 'requests', 'requests list', 'requests show', 'requests approve', 'requests discard',
  'requests deny', 'tasks', 'tasks list', 'tasks show', 'tasks approve', 'tasks reject',
  'pending', 'pending list', 'pending resubmit', 'pending remove', 'board', 'board list', 'board post',
  'board candidates', 'board serve', 'board claim', 'board dispatch', 'demo', 'relay', 'relay start',
  'worker', 'worker start', 'worker public', 'delegate', 'discover', 'invite', 'invite create', 'invite open',
  'invite share', 'invite request-reissue', 'invite reissue', 'accept', 'invites', 'invites list',
  'invites remove', 'invites migrate', 'mcp-server',
];
it.each(routes)('%s help prints usage and leaves no files or identities', async route => {
  for (const flag of ['--help', '-h']) {
    const result = await command([...(route ? route.split(' ') : []), flag]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(/^Usage: sealbridge /);
  }
});

const withOptions = [
  ['invite', 'create', '--name', 'Example'],
  ['invite', 'open', '--file', 'invite.txt', '--out', 'reciprocal.txt'],
  ['invite', 'request-reissue', '--file', 'invite.txt', '--out', 'request.json'],
  ['invite', 'reissue', '--file', 'invite.txt', '--out', 'new-invite.txt'],
  ['invite', 'share', '--file', 'invite.txt', '--host', 'https://example.test/i', '--png', 'qr.png'],
  ['worker', 'start', '--adapter', 'sandbox', '--invite-output', 'file:invite.txt', '--audit', 'audit.jsonl'],
  ['worker', 'public', '--settings', 'settings.json'],
  ['relay', 'start', '--port', '0'],
  ['discover', '--relay', 'https://relay.example'],
  ['config', 'key-store', 'file'],
  ['setup', '--host', 'cursor'],
  ['connections', 'request', '--to', 'did:key:test', '--relay', 'https://relay.example'],
  ['accept', '--stdin', '--alias', 'example'],
  ['invites', 'remove', 'example'],
  ['invites', 'migrate', '--to', 'keychain'],
  ['pending', 'resubmit', 'example'],
  ['requests', 'approve', 'example'],
  ['tasks', 'approve', 'example'],
  ['board', 'post', '--out', 'post.json'],
  ['contacts', 'remove', 'did:key:test', '--file', 'contacts.json'],
  ['keygen', 'output.private.json'],
  ['approve', 'key.json', 'contract_acceptance', 'task_test', 'target.json', 'approval.json'],
  ['receipt', 'audit.jsonl', '--out', 'receipt'],
  ['demo', '--audit-dir', 'audit'],
  ['delegate', '--input', '{}', '--save-contact', 'Example', '--out', 'result.json'],
];
it.each(withOptions.map(args => ({ label: args.join(' '), args })))
  ('$label honors either help flag before processing options', async ({ args }) => {
  for (const flag of ['--help', '-h']) {
    const result = await command([...args, flag], { 'contacts.json': 'existing contents', 'invite.txt': 'existing invite' });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Usage: sealbridge /);
    expect(result.stderr).toBe('');
  }
});

const usageErrors = [
  [], ['keygen'], ['keygen', '--unknown'], ['keygen', 'one', 'two'],
  ['demo', '--unknown'], ['demo', '--audit-dir'], ['demo', '--audit-dir', 'audit', '--unknown'],
  ['invite'], ['invite', 'unknown', '--file', 'input.json'],
  ['invite', 'create', '--name'], ['invite', 'create', '--unknown'],
  ['invite', 'create', '--expires-in', '0'], ['invite', 'create', '--expires-in', '2592001'],
  ['invite', 'request-reissue', '--file', 'input.json'], ['invite', 'reissue', '--file', 'input.json'],
  ['worker'], ['worker', 'start', '--adapter'], ['worker', 'start', '--adapter', 'command'],
  ['worker', 'start', '--adapter', 'unknown'], ['worker', 'start', '--name'],
  ['worker', 'start', '--connect-timeout-ms', '0'], ['worker', 'start', '--max-tasks-per-day', '0'],
  ['worker', 'public'], ['relay'], ['contacts', 'add'], ['accept'],
  ['config', 'key-store', 'unknown'], ['setup', '--host'], ['invites', 'migrate'],
  ['connections', 'request'], ['connections', 'request', '--to', 'did:key:test'],
  ['connections', 'request', '--relay', 'https://relay.example'], ['connections', 'sync'],
  ['connections', 'approve', 'example'], ['connections', 'connect-prior', 'did:key:test'],
  ['connections', 'review', 'approve'], ['requests', 'approve'], ['tasks', 'approve'], ['pending', 'resubmit'],
  ['board'], ['board', 'unknown', '--post', 'input.json'], ['board', 'post'],
  ['board', 'post', '--relay', 'https://relay.example', '--what', 'Example', '--skill', 'json-task',
    '--task-type', 'json', '--deadline', '2099-01-01T00:00:00Z', '--max-input-tokens', '1',
    '--max-output-tokens', '1', '--max-tool-calls', '1', '--max-wall-seconds', '1', '--input-file', 'input.json'],
  ['board', 'serve', '--post', 'input.json'], ['board', 'claim', '--post', 'input.json'],
  ['board', 'dispatch', '--post', 'input.json'],
  ['delegate'], ['delegate', '--input', '{}'],
  ['delegate', '--to', 'did:key:test', '--description', 'Example', '--input', '{}'],
  ['delegate', '--to', 'did:key:test', '--title', 'Example', '--input', '{}'],
  ['delegate', '--to', 'did:key:test', '--title', 'Example', '--description', 'Example'],
  ['delegate', '--title', 'Example', '--description', 'Example', '--input', '{}'],
  ['delegate', '--input', '{}', '--input-file', 'input.json'],
];
it.each(usageErrors.map(args => ({ label: args.join(' ') || '(no arguments)', args })))
  ('$label reports an argument error without creating files or identities', async ({ args }) => {
  const result = await command(args, { 'input.json': '{}' });
  expect(result.status).toBe(args[0] === 'setup' ? 2 : 1);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toBe('');
});
