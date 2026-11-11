// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, writeFile, rm, chown } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '@acp/core';
import { runSandbox, sandboxWrapper, sanitizedEnvironment, terminateSubprocess } from './index.js';
import type { SandboxOptions } from './index.js';
import { OCI_CONTAINER_BOUNDARY, subprocessSandboxBoundary } from './permission.js';
import type { SandboxBoundaryMetadata } from './permission.js';
export type DockerRuntime = 'docker' | 'podman';
export type RuntimeProbe = (binary: string, args: string[]) => Promise<boolean>;
export async function detectDockerRuntime(
  probe: RuntimeProbe = (binary, args) =>
    new Promise((resolve) => {
      execFile(
        binary,
        args,
        {
          timeout: 3000,
          maxBuffer: 65536,
          env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
        },
        (error) => resolve(!error),
      );
    }),
): Promise<DockerRuntime | undefined> {
  for (const binary of ['podman', 'docker'] as const)
    if (await probe(binary, ['info'])) return binary;
  return undefined;
}
export interface HybridSandboxOptions extends SandboxOptions {
  isolationLevel?: string;
  runtime?: DockerRuntime | null;
  probe?: RuntimeProbe;
  image?: string;
  containerSpawn?: (
    runtime: DockerRuntime,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => ChildProcessWithoutNullStreams;
}
export interface SandboxResult {
  output: Json;
  effectiveIsolationLevel: 'oci_container' | 'subprocess_restricted';
  /** Host-reported boundary. Task code cannot choose this object. */
  sandboxBoundary: SandboxBoundaryMetadata;
}
/**
 * OCI argv for untrusted code. Kernel isolation is `--network none`, a read-only
 * root filesystem, `--cap-drop ALL`, and `--security-opt no-new-privileges`, plus
 * PID and memory limits. Node's `--permission` model is not this boundary.
 */
export function containerArguments(
  directory: string,
  image = 'node:22-bookworm-slim',
  name?: string,
): string[] {
  return [
    'run',
    ...(name ? ['--name', name] : []),
    '--rm',
    '--pull=never',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '64',
    '--memory',
    '128m',
    '--cpus',
    '1',
    '--user',
    `${process.getuid?.() || 65534}:${process.getgid?.() || 65534}`,
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=16m',
    '--mount',
    `type=bind,src=${directory},dst=/work`,
    '--workdir',
    '/work',
    '-i',
    image,
    'node',
    '--no-addons',
    '--disable-proto=throw',
    '--max-old-space-size=64',
    '/work/runner.cjs',
  ];
}
export async function runContainerOrSubprocessSandbox(
  options: HybridSandboxOptions,
): Promise<SandboxResult> {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 604800000
  )
    throw new Error('INVALID_TIMEOUT');
  if (
    !['subprocess_restricted', 'oci_container'].includes(
      options.isolationLevel ?? 'subprocess_restricted',
    )
  )
    throw new Error('ISOLATION_LEVEL_UNSUPPORTED');
  const runtime =
    options.isolationLevel === 'oci_container'
      ? options.runtime === undefined
        ? await detectDockerRuntime(options.probe)
        : options.runtime
      : undefined;
  if (!runtime)
    return {
      output: await runSandbox(options),
      effectiveIsolationLevel: 'subprocess_restricted',
      // Same flag choice `runSandbox` passes. Network stays open at the kernel.
      sandboxBoundary: subprocessSandboxBoundary(),
    };
  const directory = await mkdtemp(join(tmpdir(), 'acp-oci-')),
    name = 'acp-' + randomUUID();
  try {
    if (process.getuid?.() === 0) await chown(directory, 65534, 65534);
    const bridge = `const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');process.disconnect=()=>{process.stdin.destroy();};require('node:readline').createInterface({input:process.stdin}).on('line',l=>process.emit('message',JSON.parse(l)));\n`;
    await writeFile(
      join(directory, 'runner.cjs'),
      bridge + sandboxWrapper.replaceAll('process.send(', 'send('),
    );
    await writeFile(
      join(directory, 'task.json'),
      JSON.stringify({
        code: options.code,
        input: options.input ?? null,
        timeoutMs: options.timeoutMs,
      }),
    );
    // An empty config avoids Docker CLI proxy defaults and registry credentials.
    await writeFile(join(directory, 'config.json'), '{}');
    const output = await new Promise<Json>((resolve, reject) => {
      const environment = {
        ...sanitizedEnvironment(directory),
        PATH: '/usr/local/bin:/usr/bin:/bin',
        DOCKER_CONFIG: directory,
      };
      const child = options.containerSpawn
        ? options.containerSpawn(runtime, containerArguments(directory, options.image, name), {
            cwd: directory,
            env: environment,
          })
        : spawn(runtime, containerArguments(directory, options.image, name), {
            env: environment,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
      child.stderr.resume();
      let done = false,
        buffer = '',
        calls = 0;
      let serial = Promise.resolve();
      const finish = (error?: Error, value?: Json) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        terminateSubprocess(child);
        error ? reject(error) : resolve(value ?? null);
      };
      const abort = () => finish(new Error('SANDBOX_HALTED'));
      const timer = setTimeout(() => finish(new Error('SANDBOX_TIMEOUT')), options.timeoutMs);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        if (buffer.length > 1048576) return finish(new Error('SANDBOX_MESSAGE_LIMIT'));
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          serial = serial
            .then(async () => {
              if (done) return;
              const m = JSON.parse(line) as {
                type: string;
                value?: Json;
                error?: string;
                id: number;
                name: string;
                args: Record<string, unknown>;
              };
              if (m.type === 'done')
                return finish(m.error ? new Error(m.error) : undefined, m.value);
              if (m.type !== 'tool' || ++calls > 10000) throw new Error('SANDBOX_PROTOCOL');
              let value: unknown = null;
              if (m.name === '$usage') {
                if (!options.onUsage) throw new Error('USAGE_ADAPTER_REQUIRED');
                options.onUsage(m.args.inputTokens as number, m.args.outputTokens as number);
              } else value = await options.onTool(m.name, m.args);
              if (!done) child.stdin.write(JSON.stringify({ id: m.id, value }) + '\n');
            })
            .catch((e) => finish(e instanceof Error ? e : new Error(String(e))));
        }
      });
      child.on('error', (e) => finish(e));
      child.stdin.on('error', () => {});
      child.on('close', (code) => {
        void serial.then(() => {
          if (!done) finish(new Error('CONTAINER_EXIT: ' + code));
        });
      });
    });
    return {
      output,
      effectiveIsolationLevel: 'oci_container',
      sandboxBoundary: OCI_CONTAINER_BOUNDARY,
    };
  } finally {
    await new Promise<void>((resolve) =>
      execFile(
        runtime,
        ['rm', '-f', name],
        {
          timeout: 3000,
          env: {
            ...sanitizedEnvironment(directory),
            PATH: '/usr/local/bin:/usr/bin:/bin',
            DOCKER_CONFIG: directory,
          },
        },
        () => resolve(),
      ),
    );
    await rm(directory, { recursive: true, force: true });
  }
}
export class SandboxRunner {
  run(options: HybridSandboxOptions): Promise<SandboxResult> {
    return runContainerOrSubprocessSandbox(options);
  }
}
