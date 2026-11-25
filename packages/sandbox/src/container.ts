// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import { chown } from 'node:fs/promises';
import { createOciWorkspace, warnOciWorkspace } from './oci-workspace.js';
import type { OciCleanupWarning } from './oci-workspace.js';
export type { OciCleanupWarning } from './oci-workspace.js';
import type { Json } from '@acp/core';
import { runSandbox, sandboxWrapper, sanitizedEnvironment } from './index.js';
import type { SandboxOptions } from './index.js';
import { OCI_CONTAINER_BOUNDARY, subprocessSandboxBoundary } from './permission.js';
import type { SandboxBoundaryMetadata } from './permission.js';
export type DockerRuntime = 'docker' | 'podman';
export type RuntimeProbe = (binary: string, args: string[]) => Promise<boolean>;

// A process exit alone does not release inherited pipes. Keep the workspace until
// close, or until a failed spawn (no PID) has released all of its local streams.
function ownProcess(child: ChildProcess) {
  let closed = false;
  let spawnFailed = false;
  let resolveClosed!: () => void;
  const completion = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const streams = [child.stdin, child.stdout, child.stderr].filter((s) => s != null);
  const released = () =>
    closed ||
    ((spawnFailed || child.exitCode !== null || child.signalCode != null) &&
      streams.every((stream) => stream.closed));
  const check = () => {
    if (released()) resolveClosed();
  };
  const onClose = () => {
    closed = true;
    resolveClosed();
  };
  const ignoreStreamError = () => {};
  const onError = () => {
    if (child.pid === undefined) {
      spawnFailed = true;
      for (const stream of streams) stream.destroy();
      check();
    }
  };
  child.on('close', onClose);
  child.on('error', onError);
  for (const stream of streams) {
    stream.on('close', check);
    stream.on('error', ignoreStreamError);
  }
  check();
  return {
    completion,
    released,
    neverStarted: () => spawnFailed && child.pid === undefined,
    stop() {
      if (
        !released() &&
        child.pid !== undefined &&
        child.exitCode === null &&
        child.signalCode == null
      ) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* Retain the workspace if termination fails. */
        }
      }
    },
    dispose() {
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
      for (const stream of streams) stream.removeListener('close', check);
      // Inherited pipes must not keep the caller alive after the cleanup budget.
      for (const stream of streams) {
        // Pending writes can report errors after destroy; keep the error sink
        // only until the stream's close event, including on budget expiry.
        const detach = () => stream.removeListener('error', ignoreStreamError);
        if (stream.closed) detach();
        else stream.once('close', detach);
        stream.destroy();
      }
      child.unref();
    },
  };
}
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
  /** Host-local log sink only; never forward to progress, audit, or peer errors. */
  onCleanupWarning?: (warning: OciCleanupWarning) => void | Promise<void>;
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
  const workspace = await createOciWorkspace();
  const directory = workspace.directory,
    name = 'acp-' + randomUUID();
  let owned: ReturnType<typeof ownProcess> | undefined;
  let launchAttempted = false;
  let disposeExecution = () => {};
  try {
    if (process.getuid?.() === 0) await chown(directory, 65534, 65534);
    const bridge = `const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');process.disconnect=()=>{process.stdin.destroy();};require('node:readline').createInterface({input:process.stdin}).on('line',l=>process.emit('message',JSON.parse(l)));\n`;
    await workspace.write(
      'runner.cjs',
      bridge + sandboxWrapper.replaceAll('process.send(', 'send('),
    );
    await workspace.write(
      'task.json',
      JSON.stringify({
        code: options.code,
        input: options.input ?? null,
        timeoutMs: options.timeoutMs,
      }),
    );
    // An empty config avoids Docker CLI proxy defaults and registry credentials.
    await workspace.write('config.json', '{}');
    const output = await new Promise<Json>((resolve, reject) => {
      const environment = {
        ...sanitizedEnvironment(directory),
        PATH: '/usr/local/bin:/usr/bin:/bin',
        DOCKER_CONFIG: directory,
      };
      // An injected launcher may have side effects before throwing. Only native
      // synchronous spawn failure, prelaunch setup, or a no-PID error prove no run.
      if (options.containerSpawn) launchAttempted = true;
      const child = options.containerSpawn
        ? options.containerSpawn(runtime, containerArguments(directory, options.image, name), {
            cwd: directory,
            env: environment,
          })
        : spawn(runtime, containerArguments(directory, options.image, name), {
            env: environment,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
      launchAttempted = true;
      // A result or a kill request does not release the process/stdio handles.
      // Register before any completion path (including an already-aborted signal).
      owned = ownProcess(child);
      let done = false,
        buffer = '',
        calls = 0;
      let serial = Promise.resolve();
      const finish = (error?: Error, value?: Json) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value ?? null);
      };
      const abort = () => finish(new Error('SANDBOX_HALTED'));
      const timer = setTimeout(() => finish(new Error('SANDBOX_TIMEOUT')), options.timeoutMs);
      const onData = (chunk: Buffer) => {
        if (done) return;
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
      };
      const onError = (e: Error) => finish(e);
      const onStdinError = () => {};
      const onClose = (code: number | null) => {
        void serial.then(() => {
          if (!done) finish(new Error('CONTAINER_EXIT: ' + code));
        });
      };
      disposeExecution = () => {
        done = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        child.stdout.removeListener('data', onData);
        child.removeListener('error', onError);
        child.stdin.removeListener('error', onStdinError);
        child.removeListener('close', onClose);
      };
      child.stdout.on('data', onData);
      child.on('error', onError);
      child.stdin.on('error', onStdinError);
      child.on('close', onClose);
      child.stderr.resume();
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      else if (owned.released()) onClose(child.exitCode);
    });
    return {
      output,
      effectiveIsolationLevel: 'oci_container',
      sandboxBoundary: OCI_CONTAINER_BOUNDARY,
    };
  } finally {
    // Share the existing 3-second container-removal budget with process closure.
    // A missing close never permits deletion, and cleanup must not replace the
    // task result/error. Unreleased workspaces are deliberately retained.
    disposeExecution();
    owned?.stop();
    const cleanupProcesses: ReturnType<typeof ownProcess>[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closureTimer: ReturnType<typeof setTimeout> | undefined;
    let cleaned = false;
    let cleanupStopped = false;
    const deadline = Date.now() + 3000;
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 3000);
    });
    try {
      const command = async (args: string[]) => {
        let processOwner: ReturnType<typeof ownProcess> | undefined;
        const result = await new Promise<{ ok: boolean; stdout: string }>((resolve) => {
          const process = execFile(
            runtime,
            args,
            {
              timeout: Math.max(1, deadline - Date.now()),
              maxBuffer: 1048576,
              env: {
                ...sanitizedEnvironment(directory),
                PATH: '/usr/local/bin:/usr/bin:/bin',
                DOCKER_CONFIG: directory,
              },
            },
            (error, stdout) => resolve({ ok: !error, stdout: String(stdout ?? '') }),
          );
          processOwner = ownProcess(process);
          cleanupProcesses.push(processOwner);
        });
        await processOwner?.completion;
        return result;
      };
      const confirmAbsence = async () => {
        if (!launchAttempted || owned?.neverStarted()) {
          await owned?.completion;
          return true;
        }
        const removed = await command(['rm', '-f', name]);
        await owned?.completion;
        if (removed.ok) return true;
        // --rm may already have removed the container. Only a successful daemon
        // listing after both processes release their handles establishes absence;
        // an error message, failed query, or pending removal is never evidence.
        if (cleanupStopped || Date.now() >= deadline - 1000) return false;
        const listed = await command(['container', 'ls', '--all', '--format', '{{json .Names}}']);
        if (!listed.ok) return false;
        for (const line of listed.stdout.split(/\r?\n/).filter((line) => line.trim())) {
          const value: unknown = JSON.parse(line);
          const names = typeof value === 'string' ? value.split(',') : value;
          if (!Array.isArray(names) || names.some((item) => typeof item !== 'string')) return false;
          if (names.some((item) => item.replace(/^\//, '') === name)) return false;
        }
        return true;
      };
      const released = await Promise.race([
        confirmAbsence(),
        new Promise<boolean>((resolve) => {
          closureTimer = setTimeout(() => resolve(false), 2000);
        }),
      ]);
      clearTimeout(closureTimer);
      cleaned = await Promise.race([workspace.cleanup(released, deadline), expired]);
    } catch {
      // Includes synchronous spawn/setup/removal errors and filesystem failures.
    } finally {
      cleanupStopped = true;
      clearTimeout(timer);
      clearTimeout(closureTimer);
      for (const process of cleanupProcesses) {
        process.stop();
        process.dispose();
      }
      owned?.dispose();
      if (!cleaned) warnOciWorkspace(directory, options.onCleanupWarning);
    }
  }
}
export class SandboxRunner {
  run(options: HybridSandboxOptions): Promise<SandboxResult> {
    return runContainerOrSubprocessSandbox(options);
  }
}
