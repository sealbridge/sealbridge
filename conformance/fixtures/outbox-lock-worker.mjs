// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { join } from 'node:path';
import { WorkerNode } from '../../packages/runtime/src/index.ts';
import { waitForRelayRetry } from '../../packages/relay/src/index.ts';
import { outboxFixture, outboxOrigin } from '../outbox-fixture.ts';
const f = outboxFixture({ sleep: waitForRelayRetry });
const p = f.prepare();
f.service.enqueue(p.frames, p.context);
const lock = join(f.service.store.root, '.lock');
fs.writeFileSync(lock, '', { mode: 0o600 });
let waiting = false;
const service = f.restart(f.owner, {
  identityOptions: {
    ...f.identityOptions,
    fs: {
      ...fs,
      openSync: (...args) => {
        try {
          return fs.openSync(...args);
        } catch (error) {
          if (!waiting && String(args[0]) === lock && error.code === 'EEXIST') {
            waiting = true;
            process.send?.({ waiting: true });
          }
          throw error;
        }
      },
    },
  },
});
const worker = new WorkerNode({
  owner: f.owner,
  relay: f.relay,
  relayUrl: outboxOrigin,
  deliveryService: service,
  identityOptions: f.identityOptions,
  adapter: { id: 'echo', name: 'Echo', skills: [], executeTask: async () => ({ ok: true }) },
});
process.on('SIGTERM', () => worker.stop());
process.on('message', (message) => {
  if (message === 'SIGTERM' && process.platform === 'win32') process.emit('SIGTERM');
});
try {
  await worker.startDelivery();
  throw new Error('EXPECTED_LOCK_WAIT');
} catch (error) {
  if (error.message !== 'OUTBOX_STOPPED') throw error;
  process.send?.({ stopped: true, preservedLock: fs.existsSync(lock) });
} finally {
  f.cleanup();
  process.disconnect?.();
}
