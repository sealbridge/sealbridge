// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import type { SignedRelayWake } from '@acp/relay';

/** Operator-owned command; signed routing metadata is passed only on stdin. */
export function createWakeHook(command: string): (wake: SignedRelayWake, signal: AbortSignal) => Promise<void> {
  if (!command.trim()) throw new Error('Missing --wake-command');
  return (wake, signal) => new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(command, { shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'ignore', 'ignore'] });
    const stop = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* The hook may have already exited. */ }
    };
    signal.addEventListener('abort', stop, { once: true });
    const finish = (ok: boolean) => {
      signal.removeEventListener('abort', stop);
      ok ? resolve() : reject(new Error('RELAY_WAKE_FAILED'));
    };
    child.once('error', () => finish(false));
    child.once('close', code => finish(code === 0 && !signal.aborted));
    child.stdin!.on('error', () => { /* Process exit determines retry. */ });
    child.stdin!.end(JSON.stringify(wake) + '\n');
    if (signal.aborted) stop();
  });
}
