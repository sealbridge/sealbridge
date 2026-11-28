// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { access } from 'node:fs/promises';
import { createOciWorkspace, warnOciWorkspace, warnRootOciLauncher } from './oci-workspace.js';
import type { OciCleanupWarning } from './oci-workspace.js';
export type { OciCleanupWarning } from './oci-workspace.js';
import type { Json } from '@acp/core';
import { runSandbox, createSandboxWrapper, sanitizedEnvironment } from './index.js';
import type { SandboxOptions } from './index.js';
import { OCI_CONTAINER_BOUNDARY, subprocessSandboxBoundary } from './permission.js';
import type { SandboxBoundaryMetadata } from './permission.js';
export type DockerRuntime = 'docker' | 'podman';
export type RuntimeProbe = (binary: string, args: string[]) => Promise<boolean>;
const containerInput = '/input';

// Prove absence without executing an unprotected CLI. Ambiguous lookup or
// filesystem errors use normal protected-state discovery, never assumed absence.
async function windowsRuntimeMayExist(): Promise<boolean> {
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  const paths = new Set([
    dirname(process.execPath),
    root,
    join(root, 'System32'),
    ...(process.env.PATH ?? '').split(';').map((path) => path.replace(/^"|"$/g, '')),
  ]);
  for (const directory of paths) {
    if (!directory) continue;
    // Relative entries may traverse outside the not-yet-created CLI cwd.
    if (!isAbsolute(directory)) return true;
    for (const binary of ['podman', 'docker'])
      for (const suffix of ['', '.com', '.exe']) {
        try {
          await access(join(directory, binary + suffix));
          return true;
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
            return true;
        }
      }
  }
  return false;
}

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
  const alreadyReleased =
    (child.exitCode !== null || child.signalCode != null) &&
    streams.every((stream) => stream.closed);
  const released = () =>
    closed || alreadyReleased || (spawnFailed && streams.every((stream) => stream.closed));
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
  probe?: RuntimeProbe,
  cliDirectory?: string,
): Promise<DockerRuntime | undefined> {
  // Standalone detection uses the same protected host state as task launch.
  if (!probe && !cliDirectory) {
    if (process.platform === 'win32' && !(await windowsRuntimeMayExist())) return undefined;
    const workspace = await createOciWorkspace();
    try {
      await workspace.write('config.json', '{}');
      return await detectDockerRuntime(undefined, workspace.cliDirectory);
    } finally {
      if (!(await workspace.cleanup(true, Date.now() + 3000)))
        warnOciWorkspace(workspace.directory);
    }
  }
  const runProbe: RuntimeProbe =
    probe ??
    ((binary, args) =>
      new Promise((resolve) => {
        execFile(
          binary,
          args,
          {
            timeout: 3000,
            maxBuffer: 65536,
            cwd: cliDirectory,
            env: hostCliEnvironment(cliDirectory!),
          },
          (error) => resolve(!error),
        );
      }));
  for (const binary of ['podman', 'docker'] as const)
    if (await runProbe(binary, ['info'])) return binary;
  return undefined;
}

function hostCliEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    ...sanitizedEnvironment(directory),
    // Preserve 0.10.1 executable discovery; inherited Windows PATH is not a new opt-in.
    PATH: '/usr/local/bin:/usr/bin:/bin',
    DOCKER_CONFIG: directory,
    ...(process.platform === 'win32'
      ? {
          SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
          USERPROFILE: directory,
          APPDATA: directory,
          LOCALAPPDATA: directory,
          TEMP: directory,
          TMP: directory,
        }
      : {}),
  };
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
    `type=bind,src=${join(directory, 'input')},dst=${containerInput},readonly`,
    '--mount',
    `type=bind,src=${join(directory, 'output')},dst=/work`,
    '--workdir',
    '/work',
    '-i',
    image,
    'node',
    '--no-addons',
    '--disable-proto=throw',
    '--max-old-space-size=64',
    `${containerInput}/runner.cjs`,
    `${containerInput}/task.json`,
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
  const fallback = async (): Promise<SandboxResult> => ({
    output: await runSandbox(options),
    effectiveIsolationLevel: 'subprocess_restricted',
    sandboxBoundary: subprocessSandboxBoundary(),
  });
  if (options.isolationLevel !== 'oci_container' || options.runtime === null) return fallback();
  if (
    process.platform === 'win32' &&
    options.runtime === undefined &&
    !options.probe &&
    !(await windowsRuntimeMayExist())
  )
    return fallback();
  const workspace = await createOciWorkspace();
  let runtime = options.runtime;
  const directory = workspace.directory,
    name = 'acp-' + randomUUID();
  let owned: ReturnType<typeof ownProcess> | undefined;
  let launchAttempted = false;
  let disposeExecution = () => {};
  try {
    // This directory is never mounted or owned by the guest identity.
    await workspace.write('config.json', '{}');
    runtime ??= await detectDockerRuntime(options.probe, workspace.cliDirectory);
    if (!runtime) return await fallback();
    const selectedRuntime = runtime;
    warnRootOciLauncher();
    await workspace.write('runner.cjs', createSandboxWrapper('jsonl'));
    await workspace.write(
      'task.json',
      JSON.stringify({
        code: options.code,
        input: options.input ?? null,
        timeoutMs: options.timeoutMs,
      }),
    );
    await workspace.seal();
    const output = await new Promise<Json>((resolve, reject) => {
      const environment = hostCliEnvironment(workspace.cliDirectory);
      // An injected launcher may have side effects before throwing. Only native
      // synchronous spawn failure, prelaunch setup, or a no-PID error prove no run.
      if (options.containerSpawn) launchAttempted = true;
      const child = options.containerSpawn
        ? options.containerSpawn(
            selectedRuntime,
            containerArguments(directory, options.image, name),
            {
              cwd: workspace.cliDirectory,
              env: environment,
            },
          )
        : spawn(selectedRuntime, containerArguments(directory, options.image, name), {
            cwd: workspace.cliDirectory,
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
    let queryTimer: ReturnType<typeof setTimeout> | undefined;
    let wakeQuery: (() => void) | undefined;
    let cleaned = false;
    let released = false;
    let cleanupStopped = false;
    const deadline = Date.now() + 3000;
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 3000);
    });
    try {
      const command = async (args: string[], commandDeadline = deadline) => {
        if (cleanupStopped || Date.now() >= commandDeadline) throw new Error('OCI_CLEANUP_STOPPED');
        if (!runtime) throw new Error('OCI_RUNTIME_UNAVAILABLE');
        const selectedRuntime = runtime;
        let processOwner: ReturnType<typeof ownProcess> | undefined;
        const result = await new Promise<{ ok: boolean; stdout: string }>((resolve) => {
          const process = execFile(
            selectedRuntime,
            args,
            {
              timeout: Math.max(1, commandDeadline - Date.now()),
              maxBuffer: 1048576,
              cwd: workspace.cliDirectory,
              env: hostCliEnvironment(workspace.cliDirectory),
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
        const closureDeadline = deadline - 1000;
        for (let query = 0; query < 10; query++) {
          if (query > 0) {
            if (cleanupStopped || Date.now() + 250 >= closureDeadline) return false;
            await new Promise<void>((resolve) => {
              wakeQuery = resolve;
              queryTimer = setTimeout(resolve, 250);
            });
            queryTimer = undefined;
            wakeQuery = undefined;
          }
          if (cleanupStopped || Date.now() >= closureDeadline) return false;
          const listed = await command(
            ['container', 'ls', '--all', '--format', '{{json .Names}}'],
            closureDeadline,
          );
          if (!listed.ok) return false;
          let present = false;
          for (const line of listed.stdout.split(/\r?\n/).filter((line) => line.trim())) {
            const value: unknown = JSON.parse(line);
            const names = typeof value === 'string' ? value.split(',') : value;
            if (!Array.isArray(names) || names.some((item) => typeof item !== 'string'))
              return false;
            present ||= names.some((item) => item.replace(/^\//, '') === name);
          }
          if (!present) return true;
        }
        return false;
      };
      released = await Promise.race([
        confirmAbsence(),
        new Promise<boolean>((resolve) => {
          closureTimer = setTimeout(() => resolve(false), 2000);
        }),
      ]);
      clearTimeout(closureTimer);
    } catch {
      // Includes synchronous spawn/setup/removal errors and filesystem failures.
    } finally {
      cleanupStopped = true;
      clearTimeout(queryTimer);
      wakeQuery?.();
      // A failed daemon query does not prevent fixed input removal. CLI state
      // remains until every owned host client has actually released its handles.
      const cliReleased =
        (!owned || owned.released()) && cleanupProcesses.every((p) => p.released());
      try {
        cleaned = await Promise.race([workspace.cleanup(released, deadline, cliReleased), expired]);
      } catch {
        // Preserve the original outcome and report residual state locally.
      }
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
