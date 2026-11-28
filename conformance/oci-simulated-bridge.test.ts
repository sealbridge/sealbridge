import { removeTestFixture } from './test-fixture-cleanup.mjs';
// SPDX-License-Identifier: Apache-2.0
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { execFile, spawn, type ChildProcess, type ExecFileOptions } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import {
  runContainerOrSubprocessSandbox,
  OCI_CONTAINER_BOUNDARY,
} from '../packages/sandbox/src/index.js';

// This fixture has no container. Only the CLI substitute is mocked; task and
// cleanup clients are native children whose close events must be observed.
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));

it('exercises the OCI JSON tool/usage bridge with a simulated container process', async () => {
  let usage = 0,
    toolCalls = 0;
  let closed = false;
  const native = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const clients: ChildProcess[] = [];
  const closures: Promise<unknown>[] = [];
  let workspace = '';
  let cleanupClosed = false;
  vi.mocked(execFile).mockImplementation((...params: unknown[]) => {
    expect(params[0]).toBe('docker');
    expect(params[1]).toEqual(['rm', '-f', expect.stringMatching(/^acp-/)]);
    const client = native.execFile(
      process.execPath,
      ['-e', ''],
      params[2] as ExecFileOptions,
      params[3] as (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void,
    );
    clients.push(client);
    closures.push(once(client, 'close'));
    client.once('close', () => {
      cleanupClosed = true;
    });
    return client;
  });
  try {
    const result = await runContainerOrSubprocessSandbox({
      isolationLevel: 'oci_container',
      runtime: 'docker',
      timeoutMs: 2000,
      input: { value: 7 },
      code: 'const v=await callTool("read",input);await reportUsage(2,3);return v;',
      containerSpawn: (_runtime, args, options) => {
        expect(args).toContain('--read-only');
        expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
        workspace = join(options.cwd, '..');
        // Translate the actual read-only bind and both trusted argv paths as a
        // container would; an unrelated cwd task file must never supply input.
        const mount = args.find((arg) => arg.endsWith(',dst=/input,readonly'))!;
        const hostInput = mount.slice('type=bind,src='.length, -',dst=/input,readonly'.length);
        const paths = args.slice(-2).map((arg) => join(hostInput, arg.slice('/input/'.length)));
        writeFileSync(join(options.cwd, '..', 'output', 'task.json'), '{"input":"wrong-cwd"}');
        const child = spawn(process.execPath, paths, {
          cwd: join(options.cwd, '..', 'output'),
          env: options.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        clients.push(child);
        closures.push(once(child, 'close'));
        child.once('close', () => {
          closed = true;
        });
        return child;
      },
      onTool: async (name, args) => {
        toolCalls++;
        expect(name).toBe('read');
        return args;
      },
      onUsage: (i, o) => {
        usage += i + o;
      },
    });
    expect(result).toEqual({
      output: { value: 7 },
      effectiveIsolationLevel: 'oci_container',
      sandboxBoundary: OCI_CONTAINER_BOUNDARY,
    });
    expect(toolCalls).toBe(1);
    expect(usage).toBe(5);
    expect(closed).toBe(true);
    expect(cleanupClosed).toBe(true);
    expect(execFile).toHaveBeenCalledTimes(1);
    for (const path of ['input/runner.cjs', 'input/task.json', 'input', 'cli'])
      expect(existsSync(join(workspace, path))).toBe(false);
  } finally {
    for (const child of clients)
      if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.all(closures);
    vi.restoreAllMocks();
    if (workspace) await removeTestFixture(workspace, 'acp-oci-');
  }
});
