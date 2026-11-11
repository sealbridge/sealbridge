// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

// Execute the CLI entry point with an in-memory host: no subprocess, filesystem
// mutation, or demo listener is needed, including when checking the old behavior.
const sourceUrl = new URL('../cli/src/index.ts', import.meta.url);
const source = readFileSync(sourceUrl, 'utf8').replaceAll('import.meta.url', JSON.stringify(sourceUrl.href));
const script = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
}).outputText;

async function command(...args: string[]) {
  const log = vi.fn();
  const stderr = vi.fn();
  const io = { readFileSync: vi.fn(() => 'not JSON'), writeFileSync: vi.fn(), mkdirSync: vi.fn() };
  const generateKeyPair = vi.fn(() => ({ did: 'did:key:test' }));
  const validateSchema = vi.fn();
  const runDemo = vi.fn(async () => ({ completed: true }));
  const hostProcess = { argv: ['node', 'sealbridge', ...args], exitCode: 0, stderr: { write: stderr } };
  const modules: Record<string, unknown> = {
    './distribution.js': { cliName: 'sealbridge', LOCAL_DISTRIBUTION: false },
    'node:fs': io,
    '@acp/core': { generateKeyPair, validateSchema },
    '@acp/two-owner-demo': { runDemo },
    './error-messages.js': { formatCliError: (error: unknown) => String(error) },
  };
  await runInNewContext(script, {
    exports: {}, require: (name: string) => modules[name] ?? {},
    console: { log, error: stderr }, process: hostProcess,
  }, { filename: sourceUrl.pathname });
  return { log, stderr, io, generateKeyPair, validateSchema, runDemo, status: hostProcess.exitCode };
}

it.each(['keygen', 'validate', 'demo'].flatMap(name =>
  ['--help', '-h'].map(flag => ({ name, flag }))))
  ('$name $flag prints usage without running the command', async ({ name, flag }) => {
  const result = await command(name, flag);
  const usages: Record<string, string> = {
    keygen: 'Usage: sealbridge keygen <owner.private.json>',
    validate: 'Usage: sealbridge validate [schema-name] <file.json>',
    demo: 'Usage: sealbridge demo [--audit-dir <directory>]',
  };
  expect(result.status).toBe(0);
  expect(result.log.mock.calls).toEqual([[usages[name]]]);
  expect(result.stderr).not.toHaveBeenCalled();
  expect(result.io.readFileSync).not.toHaveBeenCalled();
  expect(result.io.writeFileSync).not.toHaveBeenCalled();
  expect(result.io.mkdirSync).not.toHaveBeenCalled();
  expect(result.generateKeyPair).not.toHaveBeenCalled();
  expect(result.validateSchema).not.toHaveBeenCalled();
  expect(result.runDemo).not.toHaveBeenCalled();
});

it.each(['--unknown', '-x', '-', '--', '--help=key.json', '-output.json'])
  ('keygen rejects the flag-like output path %s without generating or writing a key', async flag => {
  const result = await command('keygen', flag);
  expect(result.status).toBe(1);
  expect(result.log).not.toHaveBeenCalled();
  expect(result.stderr.mock.calls[0][0]).toContain('Unknown option: ' + flag);
  expect(result.generateKeyPair).not.toHaveBeenCalled();
  expect(result.io.writeFileSync).not.toHaveBeenCalled();
  expect(result.io.mkdirSync).not.toHaveBeenCalled();
});

it.each([{ args: [] }, { args: ['one.json', 'two.json'] }])
  ('keygen rejects invalid argument counts: $args', async ({ args }) => {
  const result = await command('keygen', ...args);
  expect(result.status).toBe(1);
  expect(result.log).not.toHaveBeenCalled();
  expect(result.stderr.mock.calls[0][0]).toContain('Usage: sealbridge keygen <owner.private.json>');
  expect(result.generateKeyPair).not.toHaveBeenCalled();
  expect(result.io.writeFileSync).not.toHaveBeenCalled();
});

it('keygen retains explicit file creation and its exclusive write options', async () => {
  const result = await command('keygen', 'owner.private.json');
  expect(result.status).toBe(0);
  expect(result.stderr).not.toHaveBeenCalled();
  expect(result.generateKeyPair).toHaveBeenCalledTimes(1);
  expect(result.io.writeFileSync).toHaveBeenCalledExactlyOnceWith(
    'owner.private.json', expect.any(String), { mode: 0o600, flag: 'wx' },
  );
  expect(result.log.mock.calls).toEqual([[JSON.stringify({ did: 'did:key:test', keyFile: 'owner.private.json' })]]);
});
