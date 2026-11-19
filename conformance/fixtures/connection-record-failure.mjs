// Inject a local persistence failure after the real peer ACCEPT, without changing task execution.
import { WorkerTrustStore } from '../../packages/runtime/dist/worker-trust-store.js';
WorkerTrustStore.prototype.recordAcceptedInviteTask = function () {
  throw new Error('INTAKE_STORE_BUSY');
};
