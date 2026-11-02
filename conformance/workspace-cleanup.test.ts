// SPDX-License-Identifier: Apache-2.0
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair } from '../packages/core/src/index.js';
import { verifyAudit } from '../packages/ledger/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { PolicyAutoApprovalProvider, RequesterClient, WorkerNode } from '../packages/runtime/src/index.js';
import type { WorkspaceCleanupFailure } from '../packages/runtime/src/index.js';

const removal = vi.hoisted(() => ({ code: '', paths: [] as string[], options: [] as unknown[] }));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    rm: async (path: Parameters<typeof actual.rm>[0], options: Parameters<typeof actual.rm>[1]) => {
      if (String(path).includes('acp-adapter-')) {
        removal.paths.push(String(path));
        removal.options.push(options);
        if (removal.code) throw Object.assign(new Error('workspace is busy'), { code: removal.code });
      }
      return actual.rm(path, options);
    },
  };
});

afterEach(async () => {
  removal.code = '';
  for (const path of removal.paths.splice(0)) await rm(path, { recursive: true, force: true });
  removal.paths.length = 0;
  removal.options.length = 0;
});

describe('worker workspace cleanup', () => {
  it.each(['EBUSY', 'EPERM'])(
    'retains settlement, cancellation, and execution errors when removal fails with %s',
    async (code) => {
      removal.code = code;
      for (const outcome of ['settled', 'cancelled', 'failed'] as const) {
        const alice = generateKeyPair();
        const bob = generateKeyPair();
        const relay = new InMemoryRelay();
        const controller = new AbortController();
        const executionError = new Error('adapter execution failed');
        const reports: WorkspaceCleanupFailure[] = [];
        let started!: () => void;
        const ready = new Promise<void>((resolve) => { started = resolve; });
        const worker = new WorkerNode({ checkPeer: () => 'trusted',
          owner: bob, relay, timeoutMs: 5000,
          approvalProvider: new PolicyAutoApprovalProvider(bob),
          onWorkspaceCleanupError: (failure) => {
            reports.push(failure);
            // Both synchronous and asynchronous reporting failures are isolated.
            if (outcome === 'failed') return Promise.reject(new Error('reporter failed'));
            throw new Error('reporter failed');
          },
          adapter: {
            id: 'cleanup', name: 'cleanup', skills: [],
            executeTask: async (context) => {
              started();
              if (outcome === 'failed') throw executionError;
              if (outcome === 'cancelled') await new Promise<never>((_, reject) => {
                context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
              });
              return { ok: true };
            },
          },
        });
        const requester = new RequesterClient({ owner: alice, relay, timeoutMs: 5000,
          approvalProvider: new PolicyAutoApprovalProvider(alice) });
        const workerPending = Promise.allSettled([worker.start({ once: true })]);
        const requesterPending = Promise.allSettled([requester.delegate({
          to: worker.invite(), title: 'Cleanup', description: 'Preserve the task outcome', input: {},
          signal: controller.signal,
        })]);
        try {
          await ready;
          if (outcome === 'cancelled') controller.abort('owner cancelled');
          const [workerResult] = await workerPending;
          const [requesterResult] = await requesterPending;
          expect(reports).toEqual([{ taskId: expect.any(String), workspaceDir: expect.any(String), code }]);
          expect(removal.options.at(-1)).toEqual({ recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
          if (outcome === 'failed') {
            expect(workerResult).toMatchObject({ status: 'rejected', reason: executionError });
            if (workerResult.status === 'rejected') expect(workerResult.reason).toBe(executionError);
            expect(worker.lastResult).toBeUndefined();
            expect(requesterResult.status).toBe('rejected');
          } else {
            expect(workerResult.status).toBe('fulfilled');
            if (workerResult.status === 'fulfilled') {
              expect(workerResult.value?.state).toBe(outcome === 'settled' ? 'SETTLED' : 'CANCELLED');
              expect(worker.lastResult).toBe(workerResult.value);
              expect(verifyAudit(workerResult.value!.bundle).valid).toBe(true);
            }
            if (outcome === 'settled') expect(requesterResult.status).toBe('fulfilled');
            else expect(requesterResult).toMatchObject({ status: 'rejected', reason: { message: 'CANCELLED' } });
          }
        } finally {
          controller.abort('test finished');
          worker.stop();
          await Promise.all([workerPending, requesterPending]);
        }
      }
    },
  );
});
