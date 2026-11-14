// SPDX-License-Identifier: Apache-2.0
import { performance } from 'node:perf_hooks';
import { waitForRelayRetry } from '@acp/relay';

/** Local contention only: never retry a send, corruption, or an owner decision. */
export async function retryDeliveryBusy<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  const until = performance.now() + 5_000;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'OUTBOX_STORE_BUSY' || performance.now() >= until) throw error;
      const delay = Math.min(100, 5 * 2 ** Math.min(attempt, 5));
      await waitForRelayRetry(Math.min(until - performance.now(), delay + Math.random() * delay / 2), signal);
    }
  }
}
