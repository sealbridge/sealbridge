// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
/** Same URL-versus-shell classification used by notification delivery. */
export function isLocalNotificationTarget(target: string | undefined): boolean {
  return target !== undefined && !/^[a-z][a-z0-9+.-]*:\/\//i.test(target);
}
export interface WorkerNotification {
  event:
    'task_received' | 'approval_needed' | 'completed' | 'new_connection' | 'passkey_registered';
  timestamp: string;
  workerDid: string;
  taskId?: string;
  peerOwnerDid?: string;
  status?: string;
  held?: boolean;
  code?: string;
}
/** Explicit owner target, independent of task inbox retention. No task contents or secrets. */
export function createEventNotifier(
  target: string | undefined,
  options: {
    fetch?: typeof fetch;
    timeoutMs?: number;
    onError?: (code: string) => void;
  } = {},
) {
  const pending = new Set<Promise<void>>();
  let webhook: URL | undefined;
  if (target !== undefined) {
    if (!target.trim()) throw new Error('INVALID_NOTIFY_TARGET');
    if (!isLocalNotificationTarget(target)) {
      try {
        webhook = new URL(target);
      } catch {
        throw new Error('INVALID_NOTIFY_TARGET');
      }
      if (
        !['http:', 'https:'].includes(webhook.protocol) ||
        webhook.username ||
        webhook.password ||
        webhook.hash
      )
        throw new Error('INVALID_NOTIFY_TARGET');
    }
  }
  const timeoutMs = options.timeoutMs ?? 10000;
  const report = (code: string) => {
    try {
      options.onError?.(code);
    } catch {
      /* Diagnostics cannot affect work. */
    }
  };
  async function deliver(event: WorkerNotification): Promise<void> {
    const body = JSON.stringify(event) + '\n';
    if (webhook) {
      const response = await (options.fetch ?? fetch)(webhook.href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error('NOTIFY_FAILED');
    } else
      await new Promise<void>((resolve, reject) => {
        // The owner selects this shell command via --notify. Event JSON is sent only
        // to stdin below, never interpolated into the command or its arguments.
        const child = spawn(target!, {
          shell: true,
          windowsHide: true,
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('NOTIFY_TIMEOUT'));
        }, timeoutMs);
        const finish = (error?: Error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        child.once('error', () => finish(new Error('NOTIFY_FAILED')));
        child.once('close', (code) => finish(code === 0 ? undefined : new Error('NOTIFY_FAILED')));
        child.stdin.on('error', () => finish(new Error('NOTIFY_FAILED')));
        child.stdin.end(body);
      });
  }
  return {
    emit(event: WorkerNotification): void {
      if (!target) return;
      if (pending.size >= 32) {
        report('NOTIFY_QUEUE_FULL');
        return;
      }
      const work = deliver(event)
        .catch(() => report('NOTIFY_FAILED'))
        .finally(() => pending.delete(work));
      pending.add(work);
    },
    async drain(): Promise<void> {
      await Promise.allSettled([...pending]);
    },
  };
}
