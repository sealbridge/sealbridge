import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ProcessTimeline } from './installer-process-diagnostics.js';
const windows = process.platform === 'win32';
export const runningProcesses = new Set<Promise<ProcessResult>>();
export function runProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const done = new Promise<ProcessResult>((resolve, reject) => {
    const timeline = new ProcessTimeline();
    timeline.record('launch');
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !windows,
    });
    timeline.record('spawn-return', child.pid);
    child.once('spawn', () => timeline.record('spawn', child.pid));
    let stdout = '';
    let stderr = '';
    let error: Error | undefined;
    let timedOut = false;
    let stopping = false;
    let termination = Promise.resolve();
    const stop = () => {
      if (stopping) return;
      stopping = true;
      timeline.record('forced-termination', child.pid);
      if (windows && child.pid) {
        // Terminate Node queries as well as their PowerShell parent so their
        // inherited pipes close before fixtures are removed.
        termination = new Promise<void>((finish) => {
          const killer = spawn(
            join(process.env.SystemRoot!, 'System32/taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'],
            {
              stdio: 'ignore',
              timeout: 1000,
              killSignal: 'SIGKILL',
            },
          );
          killer.on('error', () => child.kill('SIGKILL'));
          killer.on('close', (code, signal) => {
            timeline.record('termination-close', killer.pid, code, signal);
            child.kill('SIGKILL');
            finish();
          });
        });
      } else if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    };
    const timer = setTimeout(() => {
      // The exit event and pipe-close event can be separated on a busy Windows
      // runner. A process that already exited has met its execution deadline.
      if (child.exitCode !== null || child.signalCode !== null) return;
      timeline.record('deadline', child.pid, child.exitCode, child.signalCode);
      timedOut = true;
      stop();
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      timeline.record('exit', child.pid, code, signal);
      clearTimeout(timer);
    });
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      if (!stdout) timeline.record('first-stdout', child.pid);
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      if (!stderr) timeline.record('first-stderr', child.pid);
      stderr += chunk;
    });
    child.on('error', (cause) => {
      timeline.record('spawn-error', child.pid);
      error = cause;
    });
    child.on('close', (status, exitSignal) => {
      timeline.record('close', child.pid, status, exitSignal);
      void (async () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        await termination;
        resolve({ status, signal: exitSignal, stdout, stderr, error, timedOut, timeline });
      })().catch((error: unknown) => {
        reject(error);
      });
    });
  });
  runningProcesses.add(done);
  const forget = () => {
    runningProcesses.delete(done);
  };
  void done.then(forget, forget);
  return done;
}

export type ProcessResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut: boolean;
  timeline: ProcessTimeline;
};
