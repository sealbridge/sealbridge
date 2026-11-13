// SPDX-License-Identifier: Apache-2.0
import { checkInputSize, measureInput, type PreCallSizeLimits, autoAcceptPolicy, type AutoAcceptPolicy } from '@acp/core';
import { matchesAutoAccept, WorkerAutoApprovalProvider, type AutoAcceptStateGuard } from './auto-accept.js';
import { privateDirectory } from './local-identity.js';
import * as autoAcceptFs from 'node:fs';
import { dirname } from 'node:path';
import { readApplicationConfig } from './application-config.js';
import { ApprovalGate } from './policy.js';
import { requiresStrongIsolation } from './isolation.js';
import { assembleDelegation, redelegationTarget, requireOwnerDecision, verifyRecoveredDelegation, verifyDelegationAttachment } from './delegation.js';
import type { ChildDelegationAttempt, TaskDelegationState } from './delegation.js';
import { IdempotencyStore, runtimeIdempotencyAction, unwrapIdempotency, validateIdempotencyKey } from './idempotency-store.js';
import type { IdempotencyOperation, IdempotencyStoreOptions } from './idempotency-store.js';
import type { IdempotencyAuthorization } from './delivery-records.js';
import { RecipientDeliveryCoordinator } from './delivery-status.js';
import { setDeliveryStatusReaderFactory } from './delivery-status-router.js';
import { PENDING_NEXT_STEP, pendingErrorCode } from './requester-pending-store.js';
import type { RequesterPendingStore } from './requester-pending-store.js';
import { HostBackend } from './execution-backend.js';
import type { ExecutionBackend } from './execution-backend.js';
import { consumeDailyTask } from './daily-limit.js';
import { MonthlyCostCounter, monthlyResetAt } from './monthly-limit.js';
import {
  existsSync, openSync, closeSync, fstatSync, fchmodSync, appendFileSync, constants, fsyncSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createContract,
  assertDelegationAttenuation,
  createDelegationLink,
  createCapability,
  createSignedAgentCard,
  createInviteToken,
  parseAndVerifyInviteToken,
  isInviteTarget,
  validateRelayEndpointUrl,
  signPayload,
  verifySigned,
  verifyEnvelope,
  verifyContract,
  verifyApproval,
  validateManifest,
  validateOutput,
  verifyCapabilityChain,
  capabilityIssuerControls,
  findDiscoveredAgentCard,
  discoverAgentCards,
  schemaNarrows,
  digest,
  openEnvelope,
  resolveDid,
  createRevocationNotice,
  verifyRevocationNotice,
  RevocationRegistry,
  signEnvelope,
  DEFAULT_CLOCK_SKEW_MS,
  assertConnectionsOptions,
  isConnectionEvent,
  buildContextGrant,
  validateContextGrantUse,
} from '@acp/core';
import type {
  Json,
  KeyPair,
  Schema,
  TaskManifest,
  Signed,
  SignedAgentCard,
  SignedEnvelope,
  TaskContract,
  Transition,
  CapabilityToken,
  CapabilityContext,
  BudgetSpec,
  RevocationList,
  Invite,
  SignedRevocationNotice,
  ContextGrantOptions,
  ApprovalReceipt,
} from '@acp/core';
import { CONTEXT_GRANT_AUDIT_EVENTS, proposalAuditDigest, verifyContextAcceptanceAudit } from './context-grant-audit.js';
import { parseJsonl, verifyAudit, createAuditInterruption, JsonlStore,
  type AuditInterruption, type AuditBundle, type AuditEntry } from '@acp/ledger';
import { HttpRelayClient, waitForRelayRetry, relayDiagnostic, relayDeadline, validateRelayAuthRecoveryOptions, isTransientRelayError } from '@acp/relay';
import type { RelayAuthRecoveryOptions, RelayClientSecurityOptions, RelayTransport, RelayConnectionStatus } from '@acp/relay';
import type {
  AgentAdapter,
  AgentTaskContext,
  ProgressPayload,
  ProtocolEnvelope,
} from './adapter.js';
import {
  InteractiveCliApprovalProvider,
  ProposalRejectedError,
  evaluateContractAcceptance,
} from './approval-providers.js';
import type { ApprovalProvider, WorkerAcceptancePolicy } from './approval-providers.js';
import { OwnerGateway } from './gateway.js';
import { MCPProxy } from './mcp.js';
import type { ToolBackend, ToolDefinition } from './mcp.js';
import { VerificationEngine, createDelivery } from './verifier.js';
import type { Delivery, VerificationResult } from './verifier.js';
import { asJson, receiveRelay, acknowledgeRelay, PeerRejectedError, SessionWire } from './session-audit.js';
import { SessionTimeouts, validateSessionTimeouts, resolveSessionTimeouts } from './session-timeouts.js';
import type { SessionTimeoutOptions } from './session-timeouts.js';
export type { SessionTimeoutOptions } from './session-timeouts.js';
import { WorkerTrustStore, workerIntakePath, PENDING_MESSAGE } from './worker-trust-store.js';
import type { WorkerIntakeStore } from './worker-trust-store.js';
import { LiveProtocol } from './protocol-release.js';
import type { ProtocolReleaseOptions } from './protocol-release.js';
import type { HeldSummary } from './held-request-store.js';
import { HeldRequestReview } from './held-request-review.js';
import { ConnectionRouter } from './connection-router.js';
import type { ConnectedEvent } from './connection-router.js';
import type { ConnectionHumanReviewProvider } from './connection-service.js';
import { connectionIdFor } from './connection-service.js';
import { openConnectionFrame } from './connection-transport.js';
import type { IdentityStoreOptions } from './key-store.js';
import { TaskJournal } from './task-journal.js';
import type { TaskCheckpoint, TaskOutcome } from './task-journal.js';
import { GatewayDeliveryService } from './outbox.js';
import type { GatewayDeliveryOptions } from './outbox.js';
import type { WireDelivery } from './session-audit.js';
import { deliveryError, receiptFileId } from './delivery-records.js';
export interface WorkspaceCleanupFailure {
  taskId: string;
  workspaceDir: string;
  code: string;
}
export interface SessionResult {
  taskId: string;
  state: 'SETTLED' | 'CANCELLED';
  deliverable: Json | null;
  bundle: AuditBundle;
  verification?: VerificationResult;
}
const policy = { requiredGates: [], autoApprove: [] };
/** Daemon workers stay finite unless the owner raises the cap. */
export const DEFAULT_MAX_CONCURRENT_TASKS = 8;
function acceptanceFrom(options: WorkerNodeOptions): WorkerAcceptancePolicy {
  return {
    allowedRequesterDids: options.allowedRequesterDids,
    maxInputTokens: options.maxInputTokens,
    maxOutputTokens: options.maxOutputTokens,
    maxToolInvocations: options.maxToolInvocations,
    maxWallClockSeconds: options.maxWallClockSeconds,
    maxConcurrentTasks: options.maxConcurrentTasks,
    maxTasksPerRequesterPerMinute: options.maxTasksPerRequesterPerMinute,
    requesterRateLimit: options.requesterRateLimit,
    publishToRegistry: options.publishToRegistry,
  };
}
function assertPositive(name: string, value: number | undefined, minimum = 1): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error('INVALID_' + name);
}
function validateAcceptance(acceptance: WorkerAcceptancePolicy): void {
  assertPositive('MAX_INPUT_TOKENS', acceptance.maxInputTokens);
  assertPositive('MAX_OUTPUT_TOKENS', acceptance.maxOutputTokens);
  assertPositive('MAX_TOOL_INVOCATIONS', acceptance.maxToolInvocations);
  assertPositive('MAX_WALL_CLOCK_SECONDS', acceptance.maxWallClockSeconds);
  assertPositive('MAX_CONCURRENT_TASKS', acceptance.maxConcurrentTasks);
  assertPositive('MAX_TASKS_PER_REQUESTER', acceptance.maxTasksPerRequesterPerMinute);
  const rate = acceptance.requesterRateLimit;
  if (
    rate &&
    (!Number.isSafeInteger(rate.maxRequests) ||
      rate.maxRequests < 1 ||
      !Number.isSafeInteger(rate.windowMs) ||
      rate.windowMs < 1)
  )
    throw new Error('INVALID_REQUESTER_RATE_LIMIT');
  if (acceptance.allowedRequesterDids?.some((did) => typeof did !== 'string' || did.trim() === ''))
    throw new Error('INVALID_REQUESTER_DID');
}
function deliveryPins(relay: RelayTransport): Pick<RelayTransport, 'getDeliveryStatusPin' | 'restoreDeliveryStatusPin'> {
  return {
    ...(relay.getDeliveryStatusPin ? { getDeliveryStatusPin: (id: string) => relay.getDeliveryStatusPin!(id) } : {}),
    ...(relay.restoreDeliveryStatusPin ? { restoreDeliveryStatusPin: (id: string, did: string) => relay.restoreDeliveryStatusPin!(id, did) } : {}),
  };
}
function transport(
  relay: RelayTransport | string,
  owner: KeyPair,
  security?: RelayClientSecurityOptions,
): RelayTransport {
  const client: RelayTransport =
    typeof relay === 'string'
      ? new HttpRelayClient(relay.replace(/\/$/, ''), owner, security)
      : relay;
  client.setRecipientKey?.(owner);
  const bound = client.withRecipient?.(owner) ?? client;
  return {
    ...deliveryPins(bound),
    get connectionStatus() { return bound.connectionStatus; },
    send: (envelope) => relayDeadline(Promise.resolve(bound.send(envelope)), security?.requestTimeoutMs ?? 45_000),
    receive: async (did, waitMs, signal, filter) => {
      if (bound.managesRequestDeadlines) return bound.receive(did, waitMs, signal, filter);
      const controller = new AbortController();
      const readSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
      try {
        return await relayDeadline(Promise.resolve(bound.receive(did, waitMs, readSignal, filter)),
          security?.requestTimeoutMs ?? 45_000, readSignal);
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    },
    ...(bound.acknowledgeDelivery ? { acknowledgeDelivery: (did: string, id: string, signal?: AbortSignal) =>
      bound.managesRequestDeadlines ? bound.acknowledgeDelivery!(did, id, signal) :
        relayDeadline(Promise.resolve(bound.acknowledgeDelivery!(did, id, signal)), security?.requestTimeoutMs ?? 45_000, signal) } : {}),
    ...(bound.deliveryStatus ? { deliveryStatus: (envelope: SignedEnvelope, signal?: AbortSignal) => bound.managesRequestDeadlines
      ? bound.deliveryStatus!(envelope, signal) : relayDeadline(Promise.resolve(bound.deliveryStatus!(envelope, signal)), security?.requestTimeoutMs ?? 45_000, signal) } : {}),
    ...(bound.register ? { register: (card: SignedAgentCard) => bound.register!(card) } : {}),
    ...(bound.discover ? { discover: () => relayDeadline(Promise.resolve(bound.discover!()), security?.requestTimeoutMs ?? 45_000) } : {}),
  };
}
function freshAudit(path?: string): void {
  if (path && existsSync(path)) throw new Error('AUDIT_FILE_ALREADY_EXISTS');
}
/** Cleartext is rejected unless the owner explicitly opts out for a legacy fixture. */
function sessionDecryptOptions(allowUnencryptedEnvelopes?: boolean): { requireEncrypted: boolean } {
  return { requireEncrypted: allowUnencryptedEnvelopes !== true };
}
/** Per-task queue so one session cannot dequeue another task's envelopes. */
class TaskMailbox {
  private queue: SignedEnvelope[] = [];
  private error?: Error;
  close(error: Error): void {
    this.error ??= error;
    for (const wake of this.waiters.splice(0)) wake();
  }
  private waiters: Array<() => void> = [];
  push(envelope: SignedEnvelope): void {
    this.queue.push(envelope);
    this.waiters.shift()?.();
  }
  async take(signal?: AbortSignal): Promise<SignedEnvelope> {
    for (;;) {
      if (this.error) throw this.error;
      signal?.throwIfAborted();
      const next = this.queue.shift();
      if (next) return next;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          this.waiters = this.waiters.filter((waiter) => waiter !== onWake);
          error ? reject(error) : resolve();
        };
        const onAbort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error('SESSION_ABORTED'));
        const onWake = () => finish();
        this.waiters.push(onWake);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        else if (this.queue.length) onWake();
      });
    }
  }
}
function mailboxRelay(relay: RelayTransport, mailbox: TaskMailbox): RelayTransport {
  return {
    ...deliveryPins(relay),
    send: (envelope) => relay.send(envelope),
    ...(relay.deliveryStatus ? { deliveryStatus: (envelope: SignedEnvelope, signal?: AbortSignal) => relay.deliveryStatus!(envelope, signal) } : {}),
    ...(relay.acknowledgeDelivery ? { acknowledgeDelivery: (did: string, id: string, signal?: AbortSignal) => relay.acknowledgeDelivery!(did, id, signal) } : {}),
    receive: (_recipientDid, _waitMs, signal) => mailbox.take(signal),
  };
}
const WORKER_BOUND_EVENTS: ReadonlySet<string> = new Set([
  'PROPOSE',
  'REVOKE',
  'VERIFY_ACCEPT',
  'VERIFY_REJECT',
  'SETTLE',
  'SETTLED',
  'CANCEL',
  'CHECKPOINT',
]);
const REQUESTER_BOUND_EVENTS: ReadonlySet<string> = new Set([
  ...CONTEXT_GRANT_AUDIT_EVENTS,
  'ACCEPT',
  'ATTEST',
  'START',
  'PROGRESS',
  'DELIVER',
  'HEARTBEAT',
  'CHECKPOINT_ACK',
]);
const activeRequesterInboxes = new Map<string, Set<RecipientInbox>>();
const activeWorkerListeners = new Map<string, Set<(envelope: SignedEnvelope) => boolean>>();
function registerRequesterInbox(did: string, inbox: RecipientInbox): void {
  const set = activeRequesterInboxes.get(did) ?? new Set();
  set.add(inbox);
  activeRequesterInboxes.set(did, set);
}
function unregisterRequesterInbox(did: string, inbox: RecipientInbox): void {
  const set = activeRequesterInboxes.get(did);
  if (!set) return;
  set.delete(inbox);
  if (set.size === 0) activeRequesterInboxes.delete(did);
}
function forwardToRequesterInbox(did: string, envelope: SignedEnvelope): boolean {
  const inboxes = activeRequesterInboxes.get(did);
  if (!inboxes) return false;
  for (const inbox of inboxes) {
    if (inbox.deliverFromPeerRole(envelope)) return true;
  }
  return false;
}
function registerWorkerListener(
  did: string,
  fn: (envelope: SignedEnvelope) => boolean,
): () => void {
  const set = activeWorkerListeners.get(did) ?? new Set();
  set.add(fn);
  activeWorkerListeners.set(did, set);
  return () => {
    set.delete(fn);
    if (set.size === 0) activeWorkerListeners.delete(did);
  };
}
function forwardToWorkerListener(did: string, envelope: SignedEnvelope): boolean {
  const listeners = activeWorkerListeners.get(did);
  if (!listeners) return false;
  for (const fn of listeners) {
    if (fn(envelope)) return true;
  }
  return false;
}
/**
 * One reader for a recipient DID. Concurrent delegate() calls share this inbox
 * and only see envelopes for their own taskId.
 */
class RecipientInbox {
  private readonly mailboxes = new Map<string, TaskMailbox>();
  private wake?: () => void;
  private readAbort?: AbortController;
  private started = false;
  private error?: Error;
  private connections?: ConnectionRouter;
  private delivery?: { service: GatewayDeliveryService; url: string; active: boolean };
  setDelivery(service: GatewayDeliveryService, url: string, active: boolean): void {
    this.delivery = { service, url, active };
    // Refresh may finish while an HTTP receive has already leased a task frame.
    // Cancelling that response discards the frame and exposes the next sequence.
    // The bounded poll picks up status IDs on its next iteration; wake idle readers.
    this.wake?.(); this.wake = undefined;
    if (active && !this.started) { this.started = true; registerRequesterInbox(this.did, this); void this.pump(); }
  }
  private statusIds(): string[] {
    return this.delivery && (this.delivery.active || this.mailboxes.size > 0) ? this.delivery.service.statusRouter.ids(this.delivery.url) : [];
  }
  setConnections(router: ConnectionRouter): void { this.connections = router; this.readAbort?.abort(); }
  constructor(
    private readonly relay: RelayTransport,
    private readonly did: string,
  ) {}
  hasTask(taskId: string): boolean {
    return this.mailboxes.has(taskId);
  }
  deliverFromPeerRole(envelope: SignedEnvelope): boolean {
    if (envelope.payload.eventType === 'DELIVERY_STATUS' && this.delivery) {
      void this.delivery.service.statusRouter.route(envelope, this.relay).catch(e => this.delivery?.service.options.onError?.(e)); return true;
    }
    const mailbox = this.mailboxes.get(envelope.payload.taskId);
    if (!mailbox) return false;
    mailbox.push(envelope);
    return true;
  }
  attach(taskId: string): TaskMailbox {
    if (this.error) throw this.error;
    const existing = this.mailboxes.get(taskId);
    if (existing) return existing;
    const mailbox = new TaskMailbox();
    this.mailboxes.set(taskId, mailbox);
    if (this.delivery || this.connections) this.readAbort?.abort();
    registerRequesterInbox(this.did, this);
    this.wake?.();
    this.wake = undefined;
    if (!this.started) {
      this.started = true;
      void this.pump();
    }
    return mailbox;
  }
  /** Drop the task mailbox. The shared reader stops dequeuing once none remain. */
  detach(taskId: string): void {
    this.mailboxes.delete(taskId);
    if (this.mailboxes.size === 0) {
      unregisterRequesterInbox(this.did, this);
      this.readAbort?.abort();
    }
  }
  private isWorkerBoundFrame(envelope: SignedEnvelope): boolean {
    const { eventType, seq } = envelope.payload;
    if (WORKER_BOUND_EVENTS.has(eventType)) return true;
    if (eventType === 'AUDIT_ENTRY' && seq === 1) return true;
    return false;
  }
  private async pump(): Promise<void> {
    for (;;) {
      if (this.mailboxes.size === 0 && this.statusIds().length === 0) {
        await new Promise<void>((resolve) => {
          if (this.mailboxes.size > 0 || this.statusIds().length > 0) {
            resolve();
            return;
          }
          this.wake = resolve;
        });
        continue;
      }
      const controller = new AbortController();
      this.readAbort = controller;
      try {
        const statusIds = this.statusIds();
        const readStatus = async () => statusIds.length ? await this.relay.receive(this.did, 0, controller.signal,
          { taskId: statusIds, lease: this.relay.acknowledgeDelivery !== undefined }) : undefined;
        // Read the independent status namespace without a role filter so existing relays
        // can forward it. Task reads retain bilateral role inference, including self-delegation.
        const envelope = await readStatus() ?? await receiveRelay(this.relay, this.did, controller.signal,
          this.mailboxes.size === 0 ? { taskId: statusIds } : this.connections ? {
            taskId: [...this.mailboxes.keys(), ...this.connections.options.store.controlSnapshot()
              .filter(r => r.active).map(r => 'conn_' + r.offer.requestId)],
          } : this.delivery ? { role: 'requester', taskId: [...this.mailboxes.keys()] } : { role: 'requester' },
          undefined, readStatus);
        if (envelope.payload.eventType === 'DELIVERY_STATUS' && this.delivery) {
          try { await this.delivery.service.statusRouter.route(envelope, this.relay); }
          catch (error) { this.delivery.service.options.onError?.(error as Error); }
          continue;
        }
        if (isConnectionEvent(envelope.payload.eventType) && this.connections) { await this.connections.route(envelope); continue; }
        if (!this.mailboxes.has(envelope.payload.taskId) || this.isWorkerBoundFrame(envelope)) {
          if (forwardToWorkerListener(this.did, envelope)) continue;
        }
        this.mailboxes.get(envelope.payload.taskId)?.push(envelope);
      } catch (error) {
        if (controller.signal.aborted) continue;
        this.error = relayDiagnostic(error);
        controller.abort(this.error);
        for (const mailbox of this.mailboxes.values()) mailbox.close(this.error);
        unregisterRequesterInbox(this.did, this);
        return;
      }
    }
  }
}
const recipientInboxes = new WeakMap<object, Map<string, RecipientInbox>>();
function recipientInbox(
  source: object,
  relay: RelayTransport,
  did: string,
  relayUrl?: string,
): RecipientInbox {
  // String relays include the URL so one client can switch servers. The same URL still shares
  // one inbox. Object relays stay keyed only by owner DID.
  const key = relayUrl === undefined ? did : did + '\0' + relayUrl;
  let byDid = recipientInboxes.get(source);
  if (!byDid) {
    byDid = new Map();
    recipientInboxes.set(source, byDid);
  }
  let inbox = byDid.get(key);
  if (!inbox) {
    inbox = new RecipientInbox(relay, did);
    byDid.set(key, inbox);
  }
  return inbox;
}
setDeliveryStatusReaderFactory((service, relay, url, active) => {
  recipientInbox(service, relay, service.owner.did, url.replace(/\/$/, '')).setDelivery(service, url, active);
});
export interface WorkerNodeOptions extends WorkerAcceptancePolicy, SessionTimeoutOptions, RelayAuthRecoveryOptions, ProtocolReleaseOptions {
  redelegation?: { requester: RequesterClient; ownerApprovalProvider: ApprovalProvider };
  deliveryService?: GatewayDeliveryService;
  deliveryOptions?: GatewayDeliveryOptions;
  intakeStore?: WorkerIntakeStore;
  /** Hard owner-DID perimeter. An explicit empty array denies all peers. */
  allowedPeerDids?: readonly string[];
  /** Label custom LLM adapters explicitly. Built-in LLM IDs are also recognized. */
  adapterKind?: 'llm' | 'non-llm';
  automaticApproval?: boolean;
  /** Owner policy; omission enables read-only work from connected peers. */
  autoAccept?: AutoAcceptPolicy;
  /** Atomically check/reserve future limits. Failure never grants automatic admission. */
  autoAcceptStateGuard?: AutoAcceptStateGuard;
  /** Separate human decision channel for limited peers; never the automatic provider. */
  ownerApprovalProvider?: ApprovalProvider;
  /** Reread host contact decisions at admission, execution and each outbound frame. */
  checkPeer?: (did: string) => 'trusted' | void;
  /** Startup invite and signed card lifetime in seconds. Default 86400 (24 hours). */
  inviteTtlSeconds?: number;
  /** Shared host state, independent of requester and worker identity. */
  dailyLimit?: { path: string; maxTasks: number };
  requireConnection?: boolean;
  identityOptions?: IdentityStoreOptions;
  connectionStore?: WorkerTrustStore;
  heldReview?: HeldRequestReview;
  connectionReview?: ConnectionHumanReviewProvider;
  onConnectionEvent?: (event: ConnectedEvent) => void;
  owner: KeyPair;
  relay: RelayTransport | string;
  relayUrl?: string;
  adapter: AgentAdapter;
  /** Worker execution lifecycle; defaults to HostBackend. */
  executionBackend?: ExecutionBackend;
  name?: string;
  agentDid?: string;
  /** Controls agentDid when it is not owner.did. Required to sign the delegation. */
  agentKey?: KeyPair;
  approvalProvider?: ApprovalProvider;
  /** Bilateral audit path; enables adjacent task checkpoints when inboxPath is absent. */
  auditPath?: string;
  /** Local worker-only PROPOSE interruption terminal format (default: 1). Requires format-aware readers. */
  auditInterruptionFormat?: 1;
  /** Append accepted messages as private JSONL; also enables adjacent task checkpoints. */
  inboxPath?: string;
  /** Best-effort notification after a successful inbox append; never awaited. */
  onInboxRecord?: (record: string) => void | Promise<void>;
  tools?: Record<string, ToolDefinition>;
  toolBackend?: ToolBackend;
  revocation?: RevocationList;
  /** Residual workspace after bounded cleanup retries. Defaults to a console warning. */
  onWorkspaceCleanupError?: (failure: WorkspaceCleanupFailure) => void | Promise<void>;
  onStatus?: (status: RelayConnectionStatus, error?: Error) => void;
  onEvent?: (event: string, taskId: string, error?: ErrorDiagnostic) => void;
  /** Opt in to loopback and RFC1918 relays. Network invites stay blocked by default. */
  allowPrivateRelay?: boolean;
  lookup?: RelayClientSecurityOptions['lookup'];
  /**
   * Accept cleartext session envelopes. Default false: PROPOSE and later frames
   * throw UNENCRYPTED_ENVELOPE_REJECTED unless they were encrypted to this owner.
   */
  allowUnencryptedEnvelopes?: boolean;
}
interface Proposal {
  proposal: Signed<TaskManifest>;
  input: Json;
  capabilityChains: CapabilityToken[][];
  inviteToken?: string;
  connectionRequest?: SignedEnvelope;
  /** Optional liveness requirement, independent of the contractual execution budget. */
  peerIdleTimeoutMs?: number;
}
/** Checks every backing list. Inbox notices and an owner-supplied registry both apply. */
class CompositeRevocation implements RevocationList {
  constructor(private readonly layers: readonly RevocationList[]) {}
  isRevoked(targetType: 'invite' | 'capability', targetId: string): boolean {
    return this.layers.some((layer) => layer.isRevoked(targetType, targetId));
  }
  assertNotRevoked(targetType: 'invite' | 'capability', targetId: string): void {
    for (const layer of this.layers) layer.assertNotRevoked(targetType, targetId);
  }
  noticesFor(targetType: 'invite' | 'capability', targetId: string): SignedRevocationNotice[] {
    const notices: SignedRevocationNotice[] = [];
    for (const layer of this.layers) {
      if (typeof layer.noticesFor !== 'function') continue;
      notices.push(...layer.noticesFor(targetType, targetId));
    }
    return notices;
  }
  /** A layer that cannot show issuers and still reports the id revoked. */
  unexplainedRevocation(targetType: 'invite' | 'capability', targetId: string): boolean {
    return this.layers.some(
      (layer) => typeof layer.noticesFor !== 'function' && layer.isRevoked(targetType, targetId),
    );
  }
}
interface VerifiedCapabilityChain {
  chain: CapabilityToken[];
  context: CapabilityContext;
}
function asRevocationRegistry(list: RevocationList | undefined): RevocationRegistry | undefined {
  if (!list) return undefined;
  const candidate = list as RevocationRegistry;
  if (typeof candidate.revoke !== 'function' || typeof candidate.isRevoked !== 'function')
    return undefined;
  return candidate;
}
export class WorkerNode {
  readonly deliveryService?: GatewayDeliveryService;
  readonly relay: RelayTransport;
  agentCard: SignedAgentCard;
  readonly approvalProvider: ApprovalProvider;
  readonly acceptance: WorkerAcceptancePolicy;
  readonly intakeStore: WorkerIntakeStore;
  readonly connectionStore: WorkerTrustStore;
  readonly heldReview: HeldRequestReview;
  readonly connections: ConnectionRouter;
  readonly protocol: LiveProtocol;
  private readonly acceptedPeers = new Map<string, string>();
  readonly autoAccept: AutoAcceptPolicy;
  private registered = false;
  private completed = 0;
  private activeTasks = 0;
  private readonly taskJournal?: TaskJournal;
  private reconciled = false;
  private readonly proposalTimes = new Map<string, number[]>();
  private readonly mailboxes = new Map<string, TaskMailbox>();
  private readonly forwardedQueue: SignedEnvelope[] = [];
  private readonly forwardedWaiters: Array<() => void> = [];
  readonly controller = new AbortController();
  lastResult?: SessionResult;
  /** Notices learned from the relay inbox. Always present, even without options.revocation. */
  private readonly inboxRevocations = new RevocationRegistry();
  /** Capability notices whose issuer is not yet matched to a verified chain. */
  private readonly pendingCapabilities = new Map<string, SignedRevocationNotice[]>();
  /** Chains that passed verifyCapabilityChain, so a later REVOKE can hit callTool. */
  private readonly liveChains = new Map<string, VerifiedCapabilityChain[]>();
  /** Inbox registry composed with options.revocation when the caller passed one. */
  readonly revocation: RevocationList;
  constructor(readonly options: WorkerNodeOptions) {
    assertConnectionsOptions(options);
    this.autoAccept = autoAcceptPolicy(options.autoAccept ?? readApplicationConfig({ ...options.identityOptions, allowPrivateRelay: true }).autoAccept);
    validateRelayAuthRecoveryOptions(options);
    validateSessionTimeouts(options);
    if (options.auditInterruptionFormat !== undefined && options.auditInterruptionFormat !== 1)
      throw new Error('UNSUPPORTED_AUDIT_INTERRUPTION_FORMAT');
    this.protocol = new LiveProtocol(options);
    this.intakeStore = options.intakeStore ?? new WorkerTrustStore(options.owner, {
      path: options.identityOptions ? workerIntakePath(options.owner.did, options.identityOptions) : undefined,
      fs: options.identityOptions?.fs, platform: options.identityOptions?.platform, now: options.now });
    this.connectionStore = options.connectionStore ?? (this.intakeStore instanceof WorkerTrustStore ? this.intakeStore : new WorkerTrustStore(options.owner, { now: options.now }));
    if (this.connectionStore.ownerDid !== options.owner.did) throw new Error('CONNECTION_OWNER_MISMATCH');
    this.heldReview = options.heldReview ?? new HeldRequestReview(options.owner, { ...options.identityOptions, now: options.now });
    if (options.inviteTtlSeconds !== undefined && (!Number.isSafeInteger(options.inviteTtlSeconds) ||
        options.inviteTtlSeconds < 1 || options.inviteTtlSeconds > 2592000))
      throw new Error('INVALID_INVITE_TTL');
    const persistencePath = options.inboxPath ?? options.auditPath;
    if (persistencePath) this.taskJournal = new TaskJournal(persistencePath + '.tasks.jsonl', options.owner);
    if (options.dailyLimit && (!options.dailyLimit.path || !Number.isSafeInteger(options.dailyLimit.maxTasks) || options.dailyLimit.maxTasks < 1))
      throw new Error('INVALID_DAILY_LIMIT');
    this.acceptance = acceptanceFrom(options);
    validateAcceptance(this.acceptance);
    this.revocation = options.revocation
      ? new CompositeRevocation([this.inboxRevocations, options.revocation])
      : this.inboxRevocations;
    // Every start, runOnce, and pumpUntil read goes through this wrapper, so a
    // leading REVOKE is ingested before the next PROPOSE is returned.
    this.relay = this.revocationAwareRelay(
      transport(options.relay, options.owner, {
        allowPrivateRelay: options.allowPrivateRelay,
        lookup: options.lookup,
        requestTimeoutMs: options.connectTimeoutMs,
        maxAuthRecoveryAttempts: options.maxAuthRecoveryAttempts,
        authRecoveryTimeoutMs: options.authRecoveryTimeoutMs,
      }),
    );
    this.deliveryService = (typeof options.relay === 'string' || options.relayUrl)
      ? options.deliveryService ?? (typeof options.relay === 'string' || options.deliveryOptions
      ? new GatewayDeliveryService(options.owner, { ...options.deliveryOptions,
        identityOptions: options.deliveryOptions?.identityOptions ?? options.identityOptions,
        now: options.deliveryOptions?.now ?? options.now, requestTimeoutMs: options.connectTimeoutMs,
        resolveTransport: options.deliveryOptions?.resolveTransport ?? ((url, owner) => transport(url, owner, options)),
        assertSendAllowed: async context => {
          this.assertPeer(context.peerOwnerDid, context.envelope.payload.taskId);
          await options.deliveryOptions?.assertSendAllowed?.(context);
        } }) : undefined) : undefined;
    if (this.deliveryService && this.deliveryService.owner.did !== options.owner.did) throw deliveryError('OUTBOX_STORE_INVALID');
    if (this.deliveryService) {
      this.deliveryService.recipientStatus = new RecipientDeliveryCoordinator(this.deliveryService, {
        relayUrl: typeof options.relay === 'string' ? options.relay : options.relayUrl,
        connectionState: peer => this.connectionStore.connectionState(peer),
        onPublish: () => { void this.deliveryService!.drainStatuses(); },
      });
      this.heldReview.store.setTransitionSink(this.deliveryService.recipientStatus.transition);
      this.deliveryService.onMaintenance(() => {
        this.deliveryService!.recipientStatus.reconcile(this.heldReview.store.records());
        if (this.heldReview.list().some(r => r.state === 'expired')) this.heldReview.expire();
      });
    }
    if (!persistencePath && this.deliveryService) {
      this.taskJournal = new TaskJournal(join(this.deliveryService.store.root, 'tasks.jsonl'), options.owner, this.deliveryService.store.limits.recordBytes, 'process');
      this.deliveryService.onMaintenance(async signal => {
        if (!existsSync(this.taskJournal!.path)) return;
        const store = this.deliveryService!.store, retained = new Set<string>();
        for await (const r of store.scan('receipts', signal)) if (r.retainUntil > store.now()) retained.add(r.taskId);
        await this.taskJournal!.compactInBackground(retained, change => store.transaction(change), signal);
      });
    }
    this.approvalProvider =
      options.approvalProvider ?? new InteractiveCliApprovalProvider(options.owner);
    const agentDid = options.agentDid ?? options.agentKey?.did ?? options.owner.did;
    const now = this.protocol.now();
    this.agentCard = createSignedAgentCard(
      {
        name: options.name ?? options.adapter.name, now,
        agentDid,
        relayEndpoint:
          typeof options.relay === 'string'
            ? options.relay
            : (options.relayUrl ?? 'http://in-memory.invalid'),
        skills: options.adapter.skills,
        autoAccept: this.autoAccept,
        ...(options.inviteTtlSeconds !== undefined ? {
          expiresAt: new Date(now + options.inviteTtlSeconds * 1000).toISOString(),
        } : {}),
        protocolVersions: this.protocol.receiveVersions(),
      },
      options.owner,
      agentDid === options.owner.did ? undefined : options.agentKey,
    );
    this.connections = new ConnectionRouter({ owner: options.owner, agentCard: this.agentCard,
      relayUrl: this.agentCard.payload.relayEndpoint, relay: this.relay, store: this.connectionStore,
      review: this.heldReview, now: options.now, humanReview: options.connectionReview,
      revocations: this.revocation, allowPrivateRelay: options.allowPrivateRelay,
      assertPeer: did => { this.assertPeer(did); }, onConnectionEvent: options.onConnectionEvent });
  }
  invite(expiresInSeconds = this.options.inviteTtlSeconds ?? 86400): string {
    this.refreshMonthlyCard();
    return createInviteToken({ agentCard: this.agentCard, expiresInSeconds, issuedAt: new Date(this.protocol.now()).toISOString() }, this.options.owner);
  }
  private monthlyCounter(): MonthlyCostCounter {
    return new MonthlyCostCounter(join(dirname(workerIntakePath(this.options.owner.did, this.options.identityOptions)),
      'auto-accept-monthly.jsonl'), this.options.owner, () => this.protocol.now());
  }
  private refreshMonthlyCard(): void {
    const limit = this.autoAccept.limits.maxMonthlyUsd;
    if (limit === undefined) return;
    let description = 'Sealbridge worker';
    try { this.monthlyCounter().check(limit); }
    catch (e) {
      description = e instanceof Error && e.message === 'MONTHLY_LIMIT_REACHED'
        ? 'Monthly intake closed. 今月の受付は終了'
        : 'Monthly counting state unavailable. 月次の使用量状態を利用できません';
    }
    if (description !== this.agentCard.payload.description)
      this.agentCard = createSignedAgentCard({ ...this.agentCard.payload, description, now: this.protocol.now(),
        expiresAt: new Date(this.protocol.now() + (this.options.inviteTtlSeconds ?? 86400) * 1000).toISOString() },
        this.options.owner, this.options.agentKey);
  }
  async register(): Promise<void> {
    this.refreshMonthlyCard();
    const protocolVersions = this.protocol.receiveVersions();
    if (JSON.stringify(protocolVersions) !== JSON.stringify(this.agentCard.payload.protocolVersions) || Date.parse(this.agentCard.payload.expiresAt) <= this.protocol.now() ||
        this.autoAccept.limits.maxMonthlyUsd !== undefined &&
        this.agentCard.signature.signedAt.slice(0, 7) !== new Date(this.protocol.now()).toISOString().slice(0, 7)) {
      const now = this.protocol.now();
      this.agentCard = createSignedAgentCard({ ...this.agentCard.payload, protocolVersions, now,
        expiresAt: new Date(now + (this.options.inviteTtlSeconds ?? 86400) * 1000).toISOString() }, this.options.owner, this.options.agentKey);
    }
    this.connections.service.setAgentCard(this.agentCard);
    await this.relay.register?.(this.agentCard);
    this.registered = true;
  }
  stop(): void {
    this.stopDelivery();
    this.controller.abort('WORKER_STOPPED');
    this.taskJournal?.close();
    this.listenerStatus('stopped');
  }
  async startDelivery(): Promise<void> { await this.deliveryService?.start(); }
  stopDelivery(): void { this.deliveryService?.stop(); }
  /** Public registration is opt-in, including for PolicyAutoApprovalProvider. */
  private publishes(): boolean {
    return this.options.publishToRegistry === true;
  }
  private get concurrentLimit(): number {
    return this.acceptance.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS;
  }
  private rateBudget(): { maxRequests: number; windowMs: number } | undefined {
    if (this.acceptance.requesterRateLimit) return this.acceptance.requesterRateLimit;
    if (this.acceptance.maxTasksPerRequesterPerMinute === undefined) return undefined;
    return { maxRequests: this.acceptance.maxTasksPerRequesterPerMinute, windowMs: 60_000 };
  }
  /** Count a PROPOSE from this requester. Returns a reason when the window is full. */
  private consumeRate(requesterDid: string): string | undefined {
    const budget = this.rateBudget();
    if (!budget) return undefined;
    const now = Date.now();
    const recent = (this.proposalTimes.get(requesterDid) ?? []).filter(
      (at) => now - at < budget.windowMs,
    );
    if (recent.length >= budget.maxRequests) {
      this.proposalTimes.set(requesterDid, recent);
      return (
        'per-requester rate limit exceeded for ' +
        requesterDid +
        ' (' +
        budget.maxRequests +
        ' requests / ' +
        budget.windowMs +
        'ms)'
      );
    }
    recent.push(now);
    this.proposalTimes.set(requesterDid, recent);
    return undefined;
  }
  /** Pure validation shared by capacity admission and execution. */
  private validateProposal(first: SignedEnvelope): Proposal {
    const data = openEnvelope(
      first,
      this.options.owner,
      sessionDecryptOptions(this.options.allowUnencryptedEnvelopes),
    ) as unknown as Proposal;
    const manifest = data?.proposal?.payload;
    if (
      !manifest ||
      first.payload.senderDid !== manifest.requester.ownerDid ||
      first.payload.taskId !== manifest.taskId
    )
      throw new Error('INVALID_PROPOSAL');
    if (
      !verifySigned(data.proposal, manifest.requester.ownerDid) ||
      manifest.worker?.ownerDid !== this.options.owner.did ||
      manifest.worker.agentDid !== this.agentCard.payload.agentDid ||
      Date.parse(manifest.deadline) <= this.protocol.now() ||
      Date.parse(manifest.createdAt) > this.protocol.now() + DEFAULT_CLOCK_SKEW_MS
    )
      throw new Error('INVALID_PROPOSAL');
    validateManifest(manifest);
    validateContextGrantUse(manifest, data.input, this.protocol.now());
    if (!validateOutput(manifest.io.inputSchema, data.input)) throw new Error('INVALID_PROPOSAL');
    return data;
  }
  /** Budget, allowlist, and rate checks that can be decided before execution starts. */
  private intakeRejection(first: SignedEnvelope): string | undefined {
    try {
      const data = openEnvelope(
        first,
        this.options.owner,
        sessionDecryptOptions(this.options.allowUnencryptedEnvelopes),
      ) as unknown as Proposal;
      const manifest = data.proposal?.payload;
      const ownerDid = manifest?.requester?.ownerDid;
      if (!manifest || ownerDid !== first.payload.senderDid) return undefined;
      const limited = this.consumeRate(ownerDid);
      if (limited) return limited;
      const decision = evaluateContractAcceptance(
        this.acceptance,
        { manifest, from: first.payload.senderDid },
        first.payload.senderDid,
      );
      return decision.approved ? undefined : decision.reason;
    } catch {
      return undefined;
    }
  }
  private continuous = false;
  private workerRelayCauses(error: unknown): Error[] {
    const causes: Error[] = [];
    for (let current = error; current instanceof Error && !causes.includes(current) && causes.length < 16;
      current = current.cause) causes.push(current);
    return causes;
  }
  private permanentWorkerRelayCause(causes: readonly Error[]): Error | undefined {
    return causes.find(cause => {
      const status = /^RELAY_(?:REGISTRATION_)?REJECTED:\s*(\d{3})\b/.exec(cause.message)?.[1];
      return (status !== undefined && Number(status) < 500 && ![401, 408, 429].includes(Number(status))) ||
        /^(?:SSRF_BLOCKED_RELAY_URL\b|RELAY_(?:AUTH_REQUIRED|TAMPERING_DETECTED|PROXY_(?:AUTH_FAILED|REFUSED|TLS_FAILED|UNSUPPORTED)|BIND)\b|SSE_(?:BUFFER_OVERFLOW|CAPACITY)\b)/.test(cause.message) ||
        /^(?:CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID)$/.test((cause as NodeJS.ErrnoException).code ?? '');
    });
  }
  private retryableWorkerRelayError(error: unknown): boolean {
    const causes = this.workerRelayCauses(error);
    // A permanent cause wins over an outer transport wrapper or retryable cause.
    if (this.permanentWorkerRelayCause(causes)) return false;
    // Persistent workers retry raw 401s even when a bounded auth episode (or
    // explicitly disabled transport-level recovery) has already ended. Unlike
    // 403, 401 is not evidence of a permanent authorization policy refusal.
    return isTransientRelayError(error) || causes.some(cause =>
      'code' in cause && cause.code === 'RELAY_AUTH_RECOVERY_EXHAUSTED' ||
      /^(?:RELAY_|SSE_)/.test(cause.message));
  }
  private status?: RelayConnectionStatus;
  private listenerStatus(status: RelayConnectionStatus, error?: Error): void {
    if (this.status === status && !error) return;
    this.status = status;
    this.options.onStatus?.(status, error);
  }
  private listen(signal: AbortSignal): Promise<SignedEnvelope> {
    return receiveRelay(this.relay, this.options.owner.did, signal, { role: 'worker' },
      (status) => this.listenerStatus(status === 'connected' ? this.relay.connectionStatus ?? status : status))
      .catch((error: unknown) => {
        if (signal.aborted || this.continuous) throw error;
        throw relayDiagnostic(error);
      });
  }
  async start(
    options: { once?: boolean; signal?: AbortSignal } = {},
  ): Promise<SessionResult | undefined> {
    // Register first so immediate discovery can resolve owner and agent aliases.
    this.refreshMonthlyCard(); // Also settles orphaned accounting on unpublished workers.
    if (options.once) {
      // Preserve the one-shot startup/failure contract, including raw send errors.
      if (this.publishes()) await this.register();
      await this.reconcileTasks();
    }
    const idleSignal = AbortSignal.any([
      this.controller.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    const jobs = new Set<Promise<void>>();
    let generation = new AbortController();
    let pendingEnvelope: SignedEnvelope | undefined;
    const unregister = registerWorkerListener(this.options.owner.did, (env) => {
      this.forwardedQueue.push(env);
      this.forwardedWaiters.shift()?.();
      return true;
    });
    this.continuous = !options.once;
    let initialize = true;
    try {
      while (initialize || !idleSignal.aborted) {
        initialize = false;
        try {
          if (this.publishes() && !this.registered) await this.register();
          await this.reconcileTasks();
          // Startup recovery also runs for an already-aborted caller, as before.
          // It seals durable interrupted audits without starting a new task.
          if (idleSignal.aborted) break;
          // revocationAwareRelay ingests a leading REVOKE before this read returns.
          const envelope = pendingEnvelope ?? await this.listen(idleSignal);
          pendingEnvelope = envelope;
          if (await this.recoverProposal(envelope)) {
            pendingEnvelope = undefined;
            if (options.once) return this.lastResult;
            continue;
          }
          if (this.deliver(envelope)) { pendingEnvelope = undefined; continue; }
          const job = this.beginTask(envelope, AbortSignal.any([idleSignal, generation.signal]), options.once === true);
          pendingEnvelope = undefined;
          if (!job) continue;
          jobs.add(job);
          void job.finally(() => jobs.delete(job)).catch(() => undefined);
          if (options.once) {
            await this.pumpUntil(job, idleSignal);
            return this.lastResult;
          }
        } catch (error) {
          if (options.once || idleSignal.aborted || !this.retryableWorkerRelayError(error)) throw error;
          const diagnostic = relayDiagnostic(error);
          this.listenerStatus('unavailable', diagnostic);
          // Quiesce the failed generation before reconciling durable outcomes.
          generation.abort(diagnostic);
          for (const mailbox of this.mailboxes.values()) mailbox.close(diagnostic);
          await Promise.allSettled([...jobs]);
          await waitForRelayRetry(60_000, idleSignal);
          this.reconciled = false;
          generation = new AbortController();
        }
      }
    } catch (error) {
      if (!idleSignal.aborted) {
        // A rejected one-shot task may be followed by another start on this node.
        // Only a terminal listener failure shuts down the worker and all of its tasks.
        if (error instanceof Error && ((!options.once &&
            (this.workerRelayCauses(error).some(cause => /^RELAY_|^SSE_|^SSRF_BLOCKED_RELAY_URL/.test(cause.message)) || isTransientRelayError(error))) ||
            'code' in error && ['RELAY_TERMINAL', 'RELAY_AUTH_RECOVERY_EXHAUSTED'].includes(String(error.code)))) {
          const diagnostic = relayDiagnostic(options.once ? error :
            this.permanentWorkerRelayCause(this.workerRelayCauses(error)) ?? error);
          this.listenerStatus('unavailable', diagnostic);
          for (const mailbox of this.mailboxes.values()) mailbox.close(diagnostic);
          this.controller.abort(diagnostic);
          throw diagnostic;
        }
        throw error;
      }
    } finally {
      this.continuous = false;
      if (this.status !== 'unavailable') this.listenerStatus('stopped');
      unregister();
      await Promise.allSettled([...jobs]);
      this.taskJournal?.close();
    }
    return this.lastResult;
  }
  private assertPeer(did: string, taskId?: string): 'trusted' | void {
    if (this.options.allowedPeerDids !== undefined && !this.options.allowedPeerDids.includes(did))
      throw new Error('PEER_NOT_ALLOWED');
    if ((this.intakeStore.level(did) === 'denied' || this.connectionStore.connectionState(did) === 'blocked') && (!taskId || this.acceptedPeers.get(taskId) !== did))
      throw new Error('REQUEST_DENIED');
    return this.options.checkPeer?.(did);
  }
  private trust(did: string, protocolVersion: string): 'unknown' | 'limited' | 'trusted' {
    const contactTrust = this.assertPeer(did);
    if (contactTrust === 'trusted' || this.connectionStore.hasExplicitLegacyGrant(did)) return 'trusted';
    return protocolVersion === '0.2.0' && this.connectionStore.connectionState(did) === 'connected' ? 'limited' : 'unknown';
  }
  private async notifyOutcome(record: TaskCheckpoint, outcome = record.outcome!): Promise<void> {
    if (outcome.result?.state === 'SETTLED') {
      const entries = outcome.result.bundle.entries;
      const proposal = entries.find(e => e.body.eventType === 'PROPOSE')?.body.payload;
      const accepted = entries.find(e => e.body.eventType === 'ACCEPT')?.body.payload;
      const delivered = entries.find(e => e.body.eventType === 'DELIVER')?.body.payload as unknown as Delivery;
      const retainedManifest = (accepted as unknown as { contract?: TaskContract })?.contract?.manifest ??
        (proposal as unknown as { proposal?: { payload: TaskManifest } })?.proposal?.payload;
      const grantBearing = record.delegation || (retainedManifest ? !!retainedManifest.contextGrant :
        !!(proposal as { grantDigest?: string })?.grantDigest);
      if (grantBearing) {
        if (!delivered || proposalAuditDigest(proposal) !== record.proposalDigest) throw new Error('DELEGATION_INVALID');
        verifyRecoveredDelegation(delivered, proposal, accepted, record.delegation?.parentContract);
        if (record.delegation && digest(assembleDelegation(record.delegation)) !== digest(delivered.delegation))
          throw new Error('DELEGATION_INVALID');
      }
    }
    const send = (recovery: unknown) => this.relay.send(signEnvelope({ taskId: record.taskId,
      recipientDid: record.requesterDid, seq: 0, eventType: 'ERROR',
      payload: asJson({ code: outcome.code, recovery }),
    }, this.options.owner, { encrypt: true }));
    const bytes = outcome.result ? Buffer.from(JSON.stringify(outcome.result)) : undefined;
    // Cached audits can exceed a single relay envelope even when every original event fitted.
    if (bytes && bytes.length > 48 * 1024) {
      const size = 24 * 1024, count = Math.ceil(bytes.length / size), resultDigest = digest(outcome.result);
      for (let index = 0; index < count; index++) {
        await send({ proposalDigest: record.proposalDigest, part: { index, count, resultDigest,
          data: bytes.subarray(index * size, (index + 1) * size).toString('base64') } });
        // Yield to inbox readers so a cached audit does not fill the bounded relay queue.
        if (index + 1 < count) await waitForRelayRetry(10, this.controller.signal);
      }
    } else {
      await send({ proposalDigest: record.proposalDigest, ...(outcome.result ? { result: outcome.result } : {}) });
    }
  }
  /** Another publisher invalidated the prepared index. Rebuild outside the signer lock, then retry. */
  private async withDelivery<T>(operation: () => T, signal?: AbortSignal): Promise<T> {
    const service = this.deliveryService;
    if (!service) return operation();
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      await service.prepare(signal);
      try { return operation(); }
      catch (error) {
        last = error;
        if (attempt === 2 || !(error instanceof Error) || error.message !== 'OUTBOX_STORE_BUSY') throw error;
      }
    }
    throw last;
  }
  private saveTaskCheckpoint(record: TaskCheckpoint): void {
    if (!this.taskJournal) return;
    if (this.deliveryService && !this.options.inboxPath && !this.options.auditPath) {
      this.deliveryService.store.transaction(() => { this.taskJournal!.reload(); this.taskJournal!.save(record); });
    } else this.taskJournal.save(record);
  }
  /** Intent is durable before audit append; retries reuse the entire original signed record. */
  private closeInterruptedAudit(record: TaskCheckpoint, reason: AuditInterruption['reason'], expectedEntries?: AuditEntry[],
    save: (record: TaskCheckpoint) => void = record => this.saveTaskCheckpoint(record)): TaskCheckpoint {
    if (!record.auditPath || !record.auditStage || record.auditStage === 'OUT_OF_SCOPE') return record;
    const store = new JsonlStore(record.auditPath);
    const entries = store.read();
    if (expectedEntries && digest(entries) !== digest(expectedEntries)) throw new Error('AUDIT_PREFIX_MISMATCH');
    const proposal = entries[0]?.body.payload as unknown as Proposal | undefined;
    if (!proposal || digest({ manifest: proposal.proposal.payload, input: proposal.input }) !== record.proposalDigest)
      throw new Error('AUDIT_PREFIX_MISMATCH');
    if (!record.auditClosure) {
      const interruption = createAuditInterruption(entries, this.options.owner, record.auditStage, reason);
      record = { ...record, auditClosure: { state: 'pending', interruption } };
    }
    store.closeInterrupted({ entries, interruption: record.auditClosure!.interruption }, () => save(record));
    const written: TaskCheckpoint = { ...record, auditClosure: { ...record.auditClosure!, state: 'written' } };
    save(written);
    return written;
  }
  private reportInterruptionFailure(taskId: string): void {
    // Keep the original task outcome separately; never expose arbitrary I/O exception text.
    try { this.reportRejection(taskId, new Error('AUDIT_INTERRUPTION_WRITE_FAILED')); }
    catch { try { this.options.onEvent?.('REJECTED', taskId, { code: 'AUDIT_INTERRUPTION_WRITE_FAILED' }); } catch {} }
  }
  private async reconcileTasks(): Promise<void> {
    if (this.reconciled || !this.taskJournal) return;
    if (this.deliveryService && !this.options.inboxPath && !this.options.auditPath)
      this.deliveryService.store.transaction(() => this.taskJournal!.reload());
    else this.taskJournal.load();
    for (const saved of [...this.taskJournal.tasks.values()]) {
      let record = saved;
      // Pending intents are retried even if the business outcome was already made terminal.
      // Old files have no explicit auditStage and are never backfilled, even with interruption closure enabled.
      if (record.auditStage && record.auditStage !== 'OUT_OF_SCOPE' &&
          !record.outcome?.result && record.auditClosure?.state !== 'written' &&
          (record.phase !== 'terminal' || record.outcome?.code === 'TASK_INTERRUPTED' || record.auditClosure?.state === 'pending')) {
        try { record = this.closeInterruptedAudit(record, 'WORKER_RESTART_OBSERVED'); }
        catch { record = this.taskJournal.tasks.get(record.taskId) ?? record; this.reportInterruptionFailure(record.taskId); }
      }
      const pending = !record.auditClosure && this.intakeStore.pendingTask(record.requesterDid, record.taskId, record.proposalDigest);
      if (record.phase !== 'terminal') {
        const result = this.sealedTaskResult(record);
        // Adapters expose executeTask only. Unknown execution/tool results cannot be retried safely.
        record = { ...record, phase: 'terminal', outcome: pending ? { code: 'PENDING_OWNER_APPROVAL' } : result
          ? { code: result.state === 'SETTLED' ? 'TASK_SETTLED' : 'TASK_CANCELLED', result }
          : { code: 'TASK_INTERRUPTED' }, notificationPending: true };
        this.saveTaskCheckpoint(record);
        if (!result && !pending) this.options.onEvent?.('INTERRUPTED', record.taskId, { code: 'TASK_INTERRUPTED' });
      }
      if (record.notificationPending) {
        try { this.assertPeer(record.requesterDid); } catch { continue; }
        if (pending) {
          record = { ...record, phase: 'terminal', outcome: { code: 'PENDING_OWNER_APPROVAL' } };
          this.saveTaskCheckpoint(record);
        }
        await this.notifyOutcome(record);
        this.saveTaskCheckpoint({ ...record, notificationPending: false });
      }
    }
    this.reconciled = true;
  }
  private sealedTaskResult(record: TaskCheckpoint): SessionResult | undefined {
    if (!record.auditPath) return;
    try {
      const bundle = parseJsonl(readFileSync(record.auditPath, 'utf8'));
      if (!verifyAudit(bundle, { taskId: record.taskId, actors: [record.requesterDid, this.options.owner.did] }).valid)
        return;
      const proposal = bundle.entries.find((entry) => entry.body.eventType === 'PROPOSE')?.body.payload as unknown as Proposal;
      if (proposalAuditDigest(proposal) !== record.proposalDigest) return;
      const last = bundle.entries.at(-1)?.body.eventType;
      if (last === 'CANCEL') return { taskId: record.taskId, state: 'CANCELLED', deliverable: null, bundle };
      const delivery = bundle.entries.find((entry) => entry.body.eventType === 'DELIVER')?.body.payload as unknown as Delivery;
      if (last === 'SETTLED' && delivery) {
        const accepted = bundle.entries.find(entry => entry.body.eventType === 'ACCEPT')?.body.payload;
        verifyRecoveredDelegation(delivery, proposal, accepted, record.delegation?.parentContract);
        if (record.delegation && digest(assembleDelegation(record.delegation)) !== digest(delivery.delegation)) return;
        return { taskId: record.taskId, state: 'SETTLED', deliverable: delivery.artifact.payload.data, bundle };
      }
    } catch { /* An unsealed or partial audit is evidence to preserve, not authorization to rerun. */ }
    return undefined;
  }
  private async recoverProposal(envelope: SignedEnvelope): Promise<boolean> {
    if (!this.taskJournal || envelope.payload.eventType !== 'PROPOSE' || envelope.payload.seq !== 0 ||
        !verifyEnvelope(envelope, this.options.owner.did)) return false;
    try { this.assertPeer(envelope.payload.senderDid); } catch (error) {
      this.reportRejection(envelope.payload.taskId, error);
      await acknowledgeRelay(this.relay, envelope);
      return true;
    }
    let data: Proposal;
    try {
      data = openEnvelope(envelope, this.options.owner,
        sessionDecryptOptions(this.options.allowUnencryptedEnvelopes)) as unknown as Proposal;
    } catch { return false; }
    const manifest = data?.proposal?.payload;
    if (!manifest || !verifySigned(data.proposal, envelope.payload.senderDid) ||
        manifest.taskId !== envelope.payload.taskId || manifest.requester?.ownerDid !== envelope.payload.senderDid)
      return false;
    const proposalDigest = digest({ manifest, input: data.input });
    if (this.deliveryService && !this.options.inboxPath && !this.options.auditPath)
      this.deliveryService.store.transaction(() => this.taskJournal!.reload());
    let record = this.taskJournal.tasks.get(manifest.taskId);
    const exactReceipt = this.deliveryService?.store.read('receipts', envelope.payload.envelopeId);
    const receipt = exactReceipt ?? this.deliveryService?.store.snapshot('receipts').find(r => r.taskId === manifest.taskId);
    if (receipt && (receipt.senderDid !== envelope.payload.senderDid || exactReceipt && receipt.envelopeDigest !== digest(envelope) || receipt.taskId !== manifest.taskId))
      throw deliveryError('DELIVERY_RECORD_CONFLICT');
    if (!record && receipt) {
      record = { version: 1, taskId: manifest.taskId, requesterDid: envelope.payload.senderDid,
        envelopeId: envelope.payload.envelopeId, proposalDigest, phase: 'terminal', invocations: [], outcome: { code: 'TASK_INTERRUPTED' } };
      this.saveTaskCheckpoint(record);
    }
    // Older inboxes have intake evidence but no execution checkpoint. Never execute those tasks again.
    if (!record && this.options.inboxPath && existsSync(this.options.inboxPath)) {
      for (const line of readFileSync(this.options.inboxPath, 'utf8').split('\n')) {
        let old: { taskId?: string; requesterOwnerDid?: string };
        try { old = JSON.parse(line); } catch { continue; }
        if (old?.taskId === manifest.taskId && old.requesterOwnerDid === envelope.payload.senderDid) {
          record = { version: 1, taskId: manifest.taskId, requesterDid: envelope.payload.senderDid,
            envelopeId: envelope.payload.envelopeId, proposalDigest, phase: 'terminal', invocations: [],
            outcome: { code: 'TASK_INTERRUPTED' } };
          this.taskJournal.save(record);
          break;
        }
      }
    }
    if (!record) return false;
    this.lastResult = undefined;
    if (record.requesterDid !== envelope.payload.senderDid || record.proposalDigest !== proposalDigest) {
      await this.notifyOutcome({ ...record, requesterDid: envelope.payload.senderDid, proposalDigest }, { code: 'TASK_ID_CONFLICT' });
    } else if (record.outcome) {
      await this.notifyOutcome(record);
      this.lastResult = record.outcome.result;
    } else if (!this.mailboxes.has(record.taskId)) {
      throw new Error('TASK_RECOVERY_REQUIRED');
    }
    // The outcome must be sent successfully before a retried intake is removed.
    await acknowledgeRelay(this.relay, envelope);
    return true;
  }
  private deliver(envelope: SignedEnvelope): boolean {
    const mailbox = this.mailboxes.get(envelope.payload.taskId);
    if (!mailbox) return false;
    mailbox.push(envelope);
    return true;
  }
  /** Local signed diagnostics are separate from the bilateral hash-chain ledger. */
  private reportRejection(taskId: string, error: unknown, contextGrant = false): void {
    const diagnostic = rejectionBody(error, contextGrant);
    if (this.options.auditPath) {
      const fd = openSync(this.options.auditPath + '.errors.jsonl',
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        if (!fstatSync(fd).isFile()) throw new Error('INVALID_AUDIT_FILE');
        fchmodSync(fd, 0o600);
        appendFileSync(fd, JSON.stringify(signPayload({ event: 'REJECTED', taskId,
          timestamp: new Date().toISOString(), ...diagnostic }, this.options.owner)) + '\n');
      } finally { closeSync(fd); }
    }
    this.options.onEvent?.('REJECTED', taskId, diagnostic);
  }
  private beginTask(
    first: SignedEnvelope,
    idleSignal: AbortSignal,
    once: boolean,
  ): Promise<void> | undefined {
    const verified = verifyEnvelope(first, this.options.owner.did);
    const proposal = verified && first.payload.eventType === 'PROPOSE' && first.payload.seq === 0;
    if (!proposal) {
      // A rejected proposal is answered with ERROR, and the requester echoes ERROR.
      // That trailing frame must not be treated as the next task, including after
      // a --once worker restarts and reads the relay queue again. Unsigned or
      // non-zero PROPOSE frames still fail a one-shot session immediately.
      if (once && (!verified || (first.payload.eventType === 'PROPOSE' && first.payload.seq !== 0)))
        throw new Error('INVALID_PROPOSAL_ENVELOPE');
      // AUDIT_ENTRY and other session frames are not proposals. Reporting them as
      // INVALID_PROPOSAL_ENVELOPE hides an outbox failure on the task that just ended.
      if (verified && first.payload.eventType === 'PROPOSE')
        this.options.onEvent?.('REJECTED', first.payload.taskId, { code: 'INVALID_PROPOSAL_ENVELOPE' });
      return;
    }
    let invalid = false;
    try { this.validateProposal(first); } catch { invalid = true; }
    let rejection = invalid ? undefined : this.intakeRejection(first);
    let reserved = false;
    if (!invalid && !rejection && this.activeTasks >= this.concurrentLimit)
      rejection = 'maxConcurrentTasks ' + this.concurrentLimit + ' reached';
    else if (!invalid && !rejection) {
      this.activeTasks += 1;
      reserved = true;
    }
    const mailbox = new TaskMailbox();
    this.mailboxes.set(first.payload.taskId, mailbox);
    const job = this.executeTask(first, idleSignal, mailboxRelay(this.relay, mailbox), rejection)
      .then((result) => {
        this.lastResult = result;
      })
      .catch((error) => {
        if (once) throw error;
      })
      .finally(() => {
        if (reserved) this.activeTasks -= 1;
        this.mailboxes.delete(first.payload.taskId);
      });
    return job;
  }
  /** Keep reading the shared inbox until a single task finishes, without dropping its peer's mail. */
  private async pumpUntil(job: Promise<void>, idleSignal: AbortSignal): Promise<void> {
    const wait = new AbortController();
    let failure: unknown;
    const finished = job.then(
      () => undefined,
      (error: unknown) => {
        failure = error;
      },
    );
    try {
      while (!idleSignal.aborted && failure === undefined) {
        const incoming = this.listen(AbortSignal.any([idleSignal, wait.signal])).then(
          (envelope) => envelope,
          (error: unknown) => {
            if (!idleSignal.aborted && !wait.signal.aborted) failure = error;
            return undefined;
          },
        );
        const envelope = await Promise.race([finished, incoming]);
        if (failure !== undefined) break;
        // A REVOKE queued behind the proposal is ingested inside receive and is
        // not delivered here. The next session envelope is what remains.
        if (!envelope) return;
        if (await this.recoverProposal(envelope)) continue;
        if (!this.deliver(envelope) && verifyEnvelope(envelope, this.options.owner.did))
          this.options.onEvent?.('REJECTED', envelope.payload.taskId, { code: 'INVALID_SESSION_ENVELOPE' });
      }
    } finally {
      wait.abort();
    }
    if (failure !== undefined) throw failure;
  }
  async runOnce(signal?: AbortSignal): Promise<SessionResult> {
    try {
      this.refreshMonthlyCard();
      await this.reconcileTasks();
      const idleSignal = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
      // One or more leading REVOKE envelopes are consumed before the task PROPOSE.
      const first = await receiveRelay(this.relay, this.options.owner.did, idleSignal, {
        role: 'worker',
      });
      if (await this.recoverProposal(first)) {
        if (this.lastResult?.taskId === first.payload.taskId) return this.lastResult;
        throw new Error(this.taskJournal?.tasks.get(first.payload.taskId)?.outcome?.code ?? 'TASK_INTERRUPTED');
      }
      return await this.executeTask(first, idleSignal, this.relay);
    } finally { this.taskJournal?.close(); }
  }

  private async holdTask(first: SignedEnvelope, manifest: TaskManifest, input: Json): Promise<HeldSummary> {
    const contentDigest = digest({ manifest, input });
    this.connectionStore.consumeAdmission(manifest.requester.ownerDid, manifest.taskId);
    const previous = this.heldReview.list().find(r => r.taskId === manifest.taskId && r.senderOwnerDid === manifest.requester.ownerDid);
    const held = previous ?? this.heldReview.hold({ kind: 'task', senderOwnerDid: manifest.requester.ownerDid,
      taskId: manifest.taskId, contentDigest, deadline: Date.parse(manifest.deadline), envelope: first,
      ...(manifest.contextGrant ? { grantExpiresAt: Date.parse(manifest.contextGrant.expiresAt) } : {}) });
    if (held.contentDigest !== contentDigest) throw new Error('INVALID_PROPOSAL');
    return this.heldReview.inspect(held.id);
  }
  private async executeTask(
    first: SignedEnvelope,
    idleSignal: AbortSignal,
    relay: RelayTransport,
    earlyRejection?: string,
  ): Promise<SessionResult> {
    if (
      !verifyEnvelope(first, this.options.owner.did) ||
      first.payload.eventType !== 'PROPOSE' ||
      first.payload.seq !== 0
    )
      throw new Error('INVALID_PROPOSAL_ENVELOPE');
    this.assertPeer(first.payload.senderDid);
    // PROPOSE arrives before the session wire is constructed. Open it with the same rule,
    // and return an encrypted ERROR frame if pre-wire validation fails so the requester does not hang.
    let data!: Proposal;
    let m!: TaskManifest;
    let monthlyCounter: MonthlyCostCounter | undefined;
    let monthlySettled = false;
    let monthlyAccepted = false;
    let auditPath: string | undefined;
    let checkpoint: TaskCheckpoint | undefined;
    let auditStage: TaskCheckpoint['auditStage'];
    const saveCheckpoint = (patch: Partial<TaskCheckpoint>): void => {
      if (!checkpoint || !this.taskJournal) return;
      checkpoint = { ...checkpoint, ...patch };
      this.saveTaskCheckpoint(checkpoint);
    };
    const saveOutcome = (outcome: TaskOutcome): void => {
      saveCheckpoint({ phase: 'terminal', outcome, notificationPending: true });
      this.deliveryService?.store.receipt(first, Date.parse(m.deadline), 'terminal', outcome.code);
    };
    const watchHeldAttempt = (): void => {
      stopHeldWatch();
      const heldId = heldRecordId;
      if (m.contextGrant || !heldId || heldClose.signal.aborted) return;
      if (auditStage !== 'OWNER_APPROVAL' && auditStage !== 'ACCEPT_ACK_WAIT') return;
      const tick = (): void => {
        if (heldClose.signal.aborted || (auditStage !== 'OWNER_APPROVAL' && auditStage !== 'ACCEPT_ACK_WAIT')) {
          stopHeldWatch();
          return;
        }
        try {
          if (!this.heldReview.list().some(record => record.id === heldId))
            heldClose.abort(new Error('HELD_ATTEMPT_CLOSED'));
        } catch { /* A locked or unreadable quarantine is not proof the attempt was closed. */ }
      };
      tick();
      if (!heldClose.signal.aborted) {
        heldWatch = setInterval(tick, 250);
        heldWatch.unref?.();
      }
    };
    const setAuditStage = (stage: NonNullable<TaskCheckpoint['auditStage']>): void => {
      if (!auditPath) return;
      // Format 1 requires a full, PROPOSE-only prefix. Grant audits use compact
      // proposal evidence and bilateral lifecycle entries, outside that scope.
      if (m.contextGrant) return;
      auditStage = stage;
      saveCheckpoint({ auditStage: stage });
      watchHeldAttempt();
    };
    const acknowledgeProposal = async (signal?: AbortSignal): Promise<void> => {
      this.deliveryService?.store.receipt(first, Date.parse(m.deadline), 'processed');
      await acknowledgeRelay(relay, first, signal);
    };
    let invalidProposal = false;
    try {
      try { data = this.validateProposal(first); }
      catch (error) { invalidProposal = true; throw error; }
      const manifest = data.proposal.payload;
      this.assertPeer(first.payload.senderDid);
      validateManifest(manifest);
      validateContextGrantUse(manifest, data.input, this.protocol.now());
      if (manifest.contextGrant?.deliveryMode === 'approval_redelegation') {
        const facility = this.options.redelegation;
        if (!facility || !this.options.auditPath || !this.taskJournal) throw new Error('DELEGATION_INVALID');
        requireOwnerDecision(facility.ownerApprovalProvider);
        requireOwnerDecision(facility.requester.approvalProvider);
        if (facility.requester.options.owner.did !== this.options.owner.did) throw new Error('DELEGATION_INVALID');
      }
      if (manifest.contextGrant && this.options.inboxPath) throw new Error('CONTEXT_GRANT_INPUT_RETENTION_CONFLICT');
      m = manifest;
      auditPath = this.options.auditPath
        ? this.completed++ === 0 && !existsSync(this.options.auditPath)
          ? this.options.auditPath
          : this.options.auditPath.replace(/(?:\.jsonl)?$/, '.' + m.taskId + '.jsonl')
        : undefined;
      if (!auditPath && this.autoAccept.enabled) {
        const directory = join(dirname(workerIntakePath(this.options.owner.did, this.options.identityOptions)), 'auto-accept-audit');
        privateDirectory(directory, autoAcceptFs);
        auditPath = join(directory, digest(m.taskId).slice(7) + '.' + randomUUID() + '.jsonl');
      }
      freshAudit(auditPath);
      // Provision the automatic ledger before the wire handshake. An unavailable
      // audit destination must fail before acceptance, not strand an owner gate.
      if (this.autoAccept.enabled && auditPath) {
        const fd = openSync(auditPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0), 0o600);
        closeSync(fd);
      }
      if (this.taskJournal) {
        checkpoint = { version: 1, taskId: m.taskId, requesterDid: m.requester.ownerDid,
          envelopeId: first.payload.envelopeId, proposalDigest: digest({ manifest: m, input: data.input }),
          phase: 'received', auditPath, invocations: [] };
        if (this.deliveryService) {
          await this.withDelivery(() => {
            this.deliveryService!.store.transaction(() => {
              this.taskJournal!.reload();
              if (this.taskJournal!.tasks.has(m.taskId) || this.deliveryService!.store.snapshot('receipts').some(r => r.taskId === m.taskId))
                throw deliveryError('DELIVERY_RECORD_CONFLICT');
              this.deliveryService!.store.receiptLocked(first, Date.parse(m.deadline), 'persisted');
              this.taskJournal!.save(checkpoint!);
            });
          }, idleSignal);
        } else this.taskJournal.save(checkpoint);
      }
    } catch (e) {
      this.reportRejection(first.payload.taskId, e, !!data?.proposal?.payload?.contextGrant);
      try {
        await relay.send(
          signEnvelope(
            {
              taskId: first.payload.taskId,
              recipientDid: first.payload.senderDid,
              seq: 0,
              eventType: 'ERROR',
              payload: asJson(rejectionBody(e, !!data?.proposal?.payload?.contextGrant)),
            },
            this.options.owner,
            { encrypt: true },
          ),
        );
        // Wire error codes intentionally group several errors. Only proposal
        // validation, never a local journal/storage failure, authorizes removal.
        if (invalidProposal) await acknowledgeRelay(relay, first);
      } catch {
        // Ignore transport errors while reporting pre-wire rejection.
      }
      throw e;
    }
    const timeouts = new SessionTimeouts(this.options, m.deadline, idleSignal);
    const activeSignal = timeouts.signal;
    // tasks approve/reject discards the held record from another process. This
    // signal ends an eligible wait so the worker can seal without stopping.
    const heldClose = new AbortController();
    const attemptSignal = AbortSignal.any([activeSignal, heldClose.signal]);
    let heldWatch: ReturnType<typeof setInterval> | undefined;
    let heldRecordId: string | undefined;
    const stopHeldWatch = (): void => {
      if (heldWatch !== undefined) { clearInterval(heldWatch); heldWatch = undefined; }
    };
    const wire = new SessionWire(
      relay,
      this.options.owner,
      m.requester.ownerDid,
      m.taskId,
      [m.requester.ownerDid, this.options.owner.did],
      attemptSignal,
      auditPath,
      this.options.allowUnencryptedEnvelopes === true,
      true,
      this.deliveryService ? { service: this.deliveryService, context: {
        messageId: receiptFileId(first.payload.envelopeId), peerOwnerDid: m.requester.ownerDid,
        relayUrl: this.options.relayUrl ?? (typeof this.options.relay === 'string' ? this.options.relay : this.agentCard.payload.relayEndpoint),
        deliveryDeadline: Date.parse(m.deadline),
      } } : undefined,
      m.contextGrant,
    );
    const cancelController = new AbortController();
    wire.earlyCancel = () => cancelController.abort('CANCELLED');
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let heartbeatStopped = false;
    const sendHeartbeat = async () => {
      try { await wire.heartbeat(); } catch { /* The supervised reader reports relay availability. */ }
      if (!heartbeatStopped && !activeSignal.aborted) {
        heartbeat = setTimeout(() => void sendHeartbeat(), this.options.heartbeatIntervalMs ?? 15_000);
        heartbeat.unref();
      }
    };
    const executionBackend = this.options.executionBackend ?? new HostBackend();
    let gateway: OwnerGateway | undefined, workspace: string | undefined;
    let childHostOpen = true;
    let preserveWorkspace = false;
    let proposalAudited = false;
    const cleanupWorkspace = async (): Promise<void> => {
      if (!workspace) return;
      const path = workspace;
      try {
        await executionBackend.cleanup(path);
        workspace = undefined;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code ?? 'WORKSPACE_CLEANUP_FAILED';
        // Reporting residual files must not replace settlement or the execution error.
        try {
          if (this.options.onWorkspaceCleanupError)
            void Promise.resolve(this.options.onWorkspaceCleanupError({ taskId: m.taskId, workspaceDir: path, code }))
              .catch(() => {});
          else console.warn('Workspace cleanup incomplete (' + code + '): ' + path);
        } catch {}
      }
    };
    let trackedTaskId: string | undefined;
    // Progress metrics are applied synchronously. The tail only serializes wire frames.
    let progressTail: Promise<void> = Promise.resolve();
    let progressFailure: unknown;
    let wireFailureSent = false;
    try {
      this.assertInviteActive(data);
      let peerDisplayName: string | undefined;
      if (this.relay.discover) {
        const cards = await this.relay.discover();
        const sender = findDiscoveredAgentCard(cards, m.requester.agentDid, this.protocol.now());
        if (sender?.payload.ownerDid === m.requester.ownerDid && sender.payload.relayEndpoint === this.agentCard.payload.relayEndpoint) {
          this.protocol.observe(sender, cards); peerDisplayName = sender.payload.name;
        }
      }
      this.protocol.inbound(m.protocolVersion, m.requester.ownerDid, m.requester.agentDid);
      const skills = this.agentCard.payload.skills;
      const selected = m.task.skillId ? skills.filter(skill => skill.id === m.task.skillId) : skills;
      if ((m.task.skillId && selected.length === 0) ||
          (m.task.taskType && !selected.some(skill => skill.taskTypes?.includes(m.task.taskType!))) ||
          (m.task.skillId && !m.task.taskType && selected.some(skill => skill.taskTypes?.length)))
        throw diagnosticError('TASK_SCOPE_REJECTED', 'task.scope', skills, m.task, 'Select an advertised skill and task type, or omit both for direct delegation.');
      const capabilityContext: CapabilityContext = {
        rootDid: m.requester.ownerDid,
        audience: this.options.owner.did,
        taskId: m.taskId,
      };
      if (!Array.isArray(data.capabilityChains) || data.capabilityChains.length > 32) throw new Error('CAPABILITY_VIOLATION');
      for (const chain of data.capabilityChains) verifyCapabilityChain(chain, capabilityContext);
      this.assertCapabilitiesActive(data.capabilityChains, capabilityContext);
      this.rememberChains(m.taskId, data.capabilityChains, capabilityContext);
      trackedTaskId = m.taskId;
      const decision = evaluateContractAcceptance(
        this.acceptance,
        { manifest: m, from: first.payload.senderDid },
        first.payload.senderDid,
      );
      const reason = earlyRejection ?? (decision.approved ? undefined : decision.reason);
      if (reason) throw new ProposalRejectedError(reason);
      validateManifest(m);
      validateContextGrantUse(m, data.input, this.protocol.now());
      if (!validateOutput(m.io.inputSchema, data.input)) throw new Error('INVALID_PROPOSAL');
      if (this.options.executionTimeoutMs !== undefined && m.budget.maxWallClockSeconds * 1000 > this.options.executionTimeoutMs)
        throw diagnosticError('INCOMPATIBLE_TIMEOUTS', 'budget.maxWallClockSeconds',
          this.options.executionTimeoutMs / 1000, m.budget.maxWallClockSeconds,
          'Reduce the execution budget or raise the worker execution timeout before accepting.');
      if (this.options.taskTimeoutMs !== undefined && m.budget.maxWallClockSeconds * 1000 > this.options.taskTimeoutMs)
        throw diagnosticError('INCOMPATIBLE_TIMEOUTS', 'budget.maxWallClockSeconds',
          this.options.taskTimeoutMs / 1000, m.budget.maxWallClockSeconds,
          'Reduce the execution budget or raise the worker overall task timeout before accepting.');
      if (data.peerIdleTimeoutMs !== undefined &&
          (!Number.isSafeInteger(data.peerIdleTimeoutMs) || data.peerIdleTimeoutMs < 1 ||
            (this.options.heartbeatIntervalMs ?? 15_000) >= data.peerIdleTimeoutMs))
        throw diagnosticError('INCOMPATIBLE_TIMEOUTS', 'peerIdleTimeoutMs',
          { greaterThan: this.options.heartbeatIntervalMs ?? 15_000 }, data.peerIdleTimeoutMs,
          'Raise the requester idle timeout or shorten the worker heartbeat interval before accepting.');
      // Validate capability scope before the admission queue or an owner prompt.
      const scopedTools = new Set<string>();
      for (const chain of data.capabilityChains) {
        const leaf = verifyCapabilityChain(chain, capabilityContext).payload;
        const grant = m.permissions.grantedCapabilities.find(g => g.resource === leaf.resource &&
          leaf.allowedTools.every(t => g.allowedTools.includes(t)) && leaf.maxCalls <= g.maxInvocations &&
          Date.parse(leaf.expiresAt) <= Date.parse(g.expiresAt));
        if (!grant || leaf.maxDepth > m.permissions.maxDelegationDepth || leaf.allowedTools.some(t =>
          scopedTools.has(t) || !schemaNarrows(leaf.argConstraints[t], grant.argConstraints ?? { type: 'object' })))
          throw new Error('CAPABILITY_VIOLATION');
        leaf.allowedTools.forEach(t => scopedTools.add(t));
      }
      if (this.options.requireConnection && (m.protocolVersion !== '0.2.0' || this.connectionStore.connectionState(m.requester.ownerDid) !== 'connected'))
        throw new Error('CONNECTION_REQUIRED');
      const proposalDigest = digest({ manifest: m, input: data.input });
      if (data.connectionRequest) {
        if (m.protocolVersion !== '0.2.0') throw new Error('INVALID_CONNECTION_REQUEST');
        this.connections.service.validateRequest(data.connectionRequest);
        const frame = openConnectionFrame(data.connectionRequest, this.options.owner);
        if (frame.event.payload.type !== 'ConnectionRequest' || frame.event.payload.fromOwnerDid !== m.requester.ownerDid ||
            frame.event.payload.originProposalDigest !== proposalDigest) throw new Error('INVALID_CONNECTION_REQUEST');
      }
      const previouslyPending = this.intakeStore.pendingTask(m.requester.ownerDid, m.taskId, proposalDigest);
      let inspection: HeldSummary | undefined;
      this.deliveryService?.recipientStatus.begin(first.payload.envelopeId);
      // Persist the immutable ciphertext before any connection mutation or owner acknowledgement.
      if (this.trust(m.requester.ownerDid, m.protocolVersion) !== 'trusted') {
        inspection = await this.holdTask(first, m, data.input);
      }
      // All identity, schema, scope, capability and host checks precede durable consent.
      let inviteIneligible = false;
      if (data.inviteToken) {
        const invite = parseAndVerifyInviteToken(data.inviteToken, this.protocol.now(), { allowPrivateRelay: true });
        const outcome = this.connectionStore.redeemTaskInvite(invite, { peerOwnerDid: m.requester.ownerDid,
          peerAgentDid: m.requester.agentDid, ...(peerDisplayName !== undefined ? { peerDisplayName } : {}),
          relayUrl: this.agentCard.payload.relayEndpoint },
          connectionIdFor(this.options.owner.did, m.requester.ownerDid));
        inviteIneligible = outcome === 'other' || outcome === 'inactive';
        if (outcome === 'first') this.options.onConnectionEvent?.({ event: 'connected', peerOwnerDid: m.requester.ownerDid,
          peerAgentDid: m.requester.agentDid, connectionId: connectionIdFor(this.options.owner.did, m.requester.ownerDid),
          source: 'invite', connectedAt: this.protocol.now() });
      }
      if (data.connectionRequest) await this.connections.consume(data.connectionRequest);
      const peerTrust = inviteIneligible ? 'unknown' : this.trust(m.requester.ownerDid, m.protocolVersion);
      const automaticContext = () => {
        // One fresh, validated snapshot keeps the audience facts consistent and
        // avoids repeating the store's descriptor-based directory/file checks.
        const connection = this.connectionStore.listConnections().find(c => c.peerOwnerDid === m.requester.ownerDid);
        return { manifest: m, signal: attemptSignal,
          connected: m.protocolVersion === '0.2.0' && connection?.state === 'connected',
          invited: !inviteIneligible && connection?.state === 'connected' && 'source' in connection && connection.source === 'invite',
          adapter: this.options.adapter,
          tools: this.options.tools ?? (this.options.adapter as AgentAdapter & { tools?: Record<string, ToolDefinition> }).tools ?? {},
        };
      };
      const automatic = !previouslyPending && !inviteIneligible &&
        await abortable(matchesAutoAccept(this.autoAccept, automaticContext(), this.options.autoAcceptStateGuard), attemptSignal);
      // Host-owned preflight precedes counters, owner approval, and provider calls.
      const sizeLimits: PreCallSizeLimits = {};
      for (const key of ['maxDiffLines', 'maxDiffBytes', 'maxDiffFiles'] as const)
        if (this.autoAccept.limits[key] !== undefined) sizeLimits[key] = this.autoAccept.limits[key];
      let sizeCode = 'INPUT_SIZE_OK';
      let inputSize: ReturnType<typeof checkInputSize> | undefined;
      try {
        if (Object.keys(sizeLimits).length) {
          inputSize = measureInput(data.input);
          checkInputSize(data.input, sizeLimits);
        }
        this.options.adapter.validateInput?.(m, data.input);
      } catch (error) {
        sizeCode = error instanceof Error && ['INPUT_SIZE_LIMIT_REACHED', 'INPUT_BUDGET_EXCEEDED'].includes(error.message)
          ? error.message : 'INPUT_SIZE_UNAVAILABLE';
      }
      if (sizeCode !== 'INPUT_SIZE_OK') {
        // Only refusals write signed records; successful work has no size-audit dependency.
        // These records contain counts, never the input or peer prose.
        try {
          const directory = join(dirname(workerIntakePath(this.options.owner.did, this.options.identityOptions)), 'pre-call-audit');
          privateDirectory(directory, autoAcceptFs);
          const file = join(directory, digest(m.taskId).slice(7) + '.' + randomUUID() + '.json');
          const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
            (constants.O_NOFOLLOW ?? 0), 0o600);
          try {
            autoAcceptFs.writeFileSync(fd, JSON.stringify(signPayload({ version: 1, event: 'input_size_check',
              taskId: m.taskId, requesterDid: m.requester.ownerDid, at: new Date(this.protocol.now()).toISOString(),
              code: sizeCode, limits: sizeLimits, ...(inputSize ? { size: inputSize } : {}) }, this.options.owner)) + '\n');
            fsyncSync(fd);
          } finally { closeSync(fd); }
        } catch { throw new Error('INPUT_SIZE_UNAVAILABLE'); }
        throw new PreCallRejectedError(sizeCode, this.autoAccept.limits.monthlyLimitMessage ?? 'standard');
      }
      if (this.autoAccept.limits.maxMonthlyUsd !== undefined) {
        try {
          const counter = this.monthlyCounter();
          counter.begin(this.autoAccept.limits.maxMonthlyUsd, m.taskId, this.options.adapter.billingModel ?? '', m.budget);
          monthlyCounter = counter;
        }
        catch (error) {
          this.refreshMonthlyCard();
          if (this.registered) await this.register().catch(() => {});
          throw new AdmissionLimitError(error instanceof Error && error.message === 'MONTHLY_LIMIT_REACHED'
            ? 'MONTHLY_LIMIT_REACHED' : error instanceof Error && error.message === 'MONTHLY_MODEL_UNSUPPORTED'
              ? 'MONTHLY_MODEL_UNSUPPORTED' : 'MONTHLY_STATE_UNAVAILABLE', monthlyResetAt(this.protocol.now()),
            this.autoAccept.limits.monthlyLimitMessage ?? 'standard');
        }
      }
      // Reserve before issuing approval. State failures and exhaustion must never
      // fall through to human/legacy policy acceptance of this automatic attempt.
      if (automatic && this.autoAccept.limits.maxTasksPerDayPerDid !== undefined) {
        const path = join(dirname(workerIntakePath(this.options.owner.did, this.options.identityOptions)),
          'auto-accept-daily', digest(m.requester.ownerDid).slice(7) + '.json');
        try {
          consumeDailyTask(path, this.autoAccept.limits.maxTasksPerDayPerDid, m.taskId, this.protocol.now());
        } catch (error) {
          if (error instanceof Error && error.message === 'DAILY_TASK_REPLAY')
            throw new ProposalRejectedError(
              'This task ID already reserved a daily slot. Submit a new task ID. このタスク ID は日次枠を確保済みです。新しいタスク ID で依頼してください。', 'AUTO_ACCEPT_DAILY_TASK_REPLAY');
          if (error instanceof Error && error.message === 'DAILY_LIMIT_REACHED')
            throw new AdmissionLimitError('AUTO_ACCEPT_DAILY_LIMIT_REACHED',
              new Date(Math.floor(this.protocol.now() / 86400000) * 86400000 + 86400000).toISOString());
          throw new ProposalRejectedError(
            'Daily counting state is unavailable; task rejected. 日次の件数状態を利用できないため、依頼を拒否しました。', 'AUTO_ACCEPT_DAILY_STATE_UNAVAILABLE');
        }
      }
      const automaticProvider = automatic ? new WorkerAutoApprovalProvider(this.options.owner, this.autoAccept) : undefined;
      if (this.deliveryService) await this.withDelivery(() => {
        this.deliveryService!.recipientStatus.admit(first, m, !previouslyPending && peerTrust === 'limited', !!inspection, inspection?.receivedAt);
      }, activeSignal);
      this.deliveryService?.recipientStatus.end(first.payload.envelopeId);
      if (previouslyPending && peerTrust === 'trusted') throw new PendingTaskError('This task attempt is terminal pending. Explicitly submit a fresh task for inspection and live owner approval. Do not retry automatically.');
      if (!automatic && peerTrust !== 'trusted') {
        inspection ??= await this.holdTask(first, m, data.input);
        if (previouslyPending || peerTrust === 'unknown' || this.intakeStore.pendingTask(m.requester.ownerDid, m.taskId, proposalDigest) ||
            inspection.inspectionStatus !== 'complete') {
          this.intakeStore.enqueue(m, data.input);
          if (this.connectionStore.connectionState(m.requester.ownerDid) === 'none') {
            const receivedAt = this.protocol.now();
            try { this.connectionStore.recordIncoming({ peerOwnerDid: m.requester.ownerDid, peerAgentDid: m.requester.agentDid,
              ...(peerDisplayName !== undefined ? { peerDisplayName } : {}),
              relayUrl: this.agentCard.payload.relayEndpoint, incoming: { requestId: m.taskId, requestDigest: proposalDigest,
                receivedAt, expiresAt: receivedAt + 14 * 86400000 } }); }
            catch (error) { if (!(error instanceof Error) || error.message !== 'CONNECTION_REQUEST_COOLDOWN') throw error; }
          }
          throw new PendingTaskError(inspection.inspectionStatus !== 'complete'
            ? 'Task inspection is incomplete. Use tasks list/show, then explicitly submit a fresh task to an interactive worker for live owner approval. Connection consent is separate. Do not retry automatically.'
            : peerTrust === 'unknown' && this.connectionStore.connectionState(m.requester.ownerDid) !== 'connected'
              ? 'Connection consent is missing. Check connections review list or the invitation flow. A fresh task still needs inspection and live owner approval. Do not retry automatically.'
              : 'This task attempt is terminal pending. Explicitly submit a fresh task for inspection and live owner approval. Do not retry automatically.');
        }
      }
      const contractProvider = automaticProvider ?? (peerTrust === 'limited' ? this.options.ownerApprovalProvider : this.approvalProvider);
      if (!contractProvider || !automatic && peerTrust === 'limited' && (contractProvider.kind === 'policy' ||
          contractProvider === this.approvalProvider && contractProvider.kind !== 'human'))
        throw new Error('APPROVAL_CHANNEL_UNAVAILABLE');
      if (!automatic && contractProvider.kind === 'policy')
        throw new Error('APPROVAL_CHANNEL_UNAVAILABLE');
      if (m.contextGrant?.deliveryMode === 'approval_redelegation') requireOwnerDecision(contractProvider);
      await wire.receiveEvent('PROPOSE', first);
      proposalAudited = true;
      await wire.contextEvent('CONTEXT_GRANT');
      await wire.contextEvent('CONTEXT_MODE');
      heldRecordId = inspection?.id;
      setAuditStage('OWNER_APPROVAL');
      const contract = createContract(m, data.proposal, this.options.owner);
      const openingStarted = m.contextGrant?.deliveryMode === 'approval_redelegation' ? Date.now() : 0;
      const approval = await abortable(contractProvider.approve({
        taskId: m.taskId,
        gate: 'contract_acceptance',
        target: contract.contractDigest,
        details: {
          manifest: m.contextGrant?.deliveryMode === 'approval_redelegation' ? structuredClone(m) : m,
          input: m.contextGrant?.deliveryMode === 'approval_redelegation' ? structuredClone(data.input) : data.input,
          capabilities: data.capabilityChains,
          ...(inspection ? { inspection } : {}),
          from: first.payload.senderDid,
        },
        signal: attemptSignal,
      }), attemptSignal);
      if (m.contextGrant?.deliveryMode === 'approval_redelegation') assertFreshDecision(approval, openingStarted);
      setAuditStage('OUT_OF_SCOPE');
      if (automatic && !await matchesAutoAccept(this.autoAccept, automaticContext()))
        throw new Error('APPROVAL_CHANNEL_UNAVAILABLE');
      if (!automatic && this.trust(m.requester.ownerDid, m.protocolVersion) === 'unknown')
        throw new Error('APPROVAL_CHANNEL_UNAVAILABLE');
      this.assertCapabilitiesActive(data.capabilityChains, capabilityContext);
      this.assertPeer(m.requester.ownerDid);
      if (peerTrust === 'trusted' && this.trust(m.requester.ownerDid, m.protocolVersion) !== 'trusted')
        throw new Error('APPROVAL_CHANNEL_UNAVAILABLE');
      gateway = new OwnerGateway(this.options.owner, contract, policy, this.revocation);
      const accepted = gateway.accept(approval);
      monthlyAccepted = true;
      validateContextGrantUse(m, data.input, this.protocol.now());
      await wire.contextEvent('CONTEXT_OPENED');
      this.acceptedPeers.set(m.taskId, m.requester.ownerDid);
      saveCheckpoint({ phase: 'accepted', ...(m.contextGrant?.deliveryMode === 'approval_redelegation'
        ? { delegation: { parentContract: contract, attempts: [] } } : {}) });
      if (inspection?.inspectionStatus === 'complete' && this.deliveryService)
        await this.withDelivery(() => { this.deliveryService!.recipientStatus.observe(first.payload.envelopeId, 'opened'); }, activeSignal);
      if (this.options.dailyLimit)
        consumeDailyTask(this.options.dailyLimit.path, this.options.dailyLimit.maxTasks, m.taskId);
      if (this.options.inboxPath) {
        const record = JSON.stringify({
          envelopeId: first.payload.envelopeId,
          receivedAt: new Date().toISOString(),
          taskId: m.taskId,
          requesterOwnerDid: m.requester.ownerDid,
          requesterAgentDid: m.requester.agentDid,
          title: m.task.title,
          description: m.task.description,
          input: data.input,
        }) + '\n';
        const fd = openSync(
          this.options.inboxPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND |
            constants.O_NOFOLLOW | constants.O_NONBLOCK,
          0o600,
        );
        try {
          if (!fstatSync(fd).isFile()) throw new Error('INVALID_INBOX_FILE');
          fchmodSync(fd, 0o600);
          appendFileSync(fd, record);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        await acknowledgeProposal(activeSignal);
        // Notification errors must not fail a persisted task.
        try {
          void Promise.resolve(this.options.onInboxRecord?.(record)).catch(() => undefined);
        } catch {
          // Synchronous notification failures are also best effort.
        }
      }
      validateContextGrantUse(m, data.input, this.protocol.now());
      setAuditStage('ACCEPT_ACK_WAIT');
      await wire.sendEvent('ACCEPT', { contract, transition: accepted, approval });
      setAuditStage('OUT_OF_SCOPE');
      this.options.onEvent?.('ACCEPT', m.taskId);
      await wire.sendEvent('START', gateway.transition('START'));
      heartbeat = setTimeout(() => void sendHeartbeat(), this.options.heartbeatIntervalMs ?? 15_000);
      heartbeat.unref();
      timeouts.running();
      this.options.onEvent?.('IN_PROGRESS', m.taskId);
      const extra = this.options.adapter as AgentAdapter & {
        tools?: Record<string, ToolDefinition>;
        toolBackend?: ToolBackend;
      };
      const tools = this.options.tools ?? extra.tools ?? {},
        backend = this.options.toolBackend ?? extra.toolBackend;
      if (!Array.isArray(data.capabilityChains) || data.capabilityChains.length > 32)
        throw new Error('CAPABILITY_VIOLATION: invalid chains');
      const toolsSeen = new Set<string>();
      const proxies = data.capabilityChains.map((chain) => {
        const leaf = verifyCapabilityChain(chain, {
          rootDid: m.requester.ownerDid,
          audience: this.options.owner.did,
          taskId: m.taskId,
        });
        const grant = m.permissions.grantedCapabilities.find(
          (g) =>
            g.resource === leaf.payload.resource &&
            leaf.payload.allowedTools.every((t) => g.allowedTools.includes(t)) &&
            leaf.payload.maxCalls <= g.maxInvocations &&
            Date.parse(leaf.payload.expiresAt) <= Date.parse(g.expiresAt),
        );
        if (
          !grant ||
          leaf.payload.maxDepth > m.permissions.maxDelegationDepth ||
          leaf.payload.allowedTools.some(
            (t) =>
              toolsSeen.has(t) ||
              !schemaNarrows(
                leaf.payload.argConstraints[t],
                grant.argConstraints ?? { type: 'object' },
              ),
          )
        )
          throw new Error('CAPABILITY_VIOLATION: outside manifest');
        for (const tool of leaf.payload.allowedTools) toolsSeen.add(tool);
        return new MCPProxy({
          chain,
          context: {
            rootDid: m.requester.ownerDid,
            audience: this.options.owner.did,
            taskId: m.taskId,
          },
          tools,
          backend: backend ?? {
            callTool: async () => {
              throw new Error('MCP_BACKEND_REQUIRED');
            },
          },
          gate: gateway!.approvals,
          meter: gateway!.quota,
          guard: gateway!.capabilities,
          isActive: () => gateway!.machine.state === 'IN_PROGRESS',
        });
      });
      this.assertPeer(m.requester.ownerDid, m.taskId);
      workspace = await executionBackend.prepare();
      saveCheckpoint({ phase: 'running', workspace });
      let invocationCount = 0;
      const executionSignal = AbortSignal.any([
        activeSignal,
        gateway.quota.controller.signal,
        cancelController.signal,
      ]);
      // Concurrent reportProgress calls must not put two PROGRESS frames on the wire
      // before the first bilateral ACK. The queue also keeps DELIVER behind them.
      const enqueueProgress = (operation: () => Promise<void>, force = false): Promise<void> => {
        const run = progressTail.then(async () => {
          if (!force) {
            if (progressFailure) throw progressFailure;
            if (executionSignal.aborted)
              throw new Error('EXECUTION_ABORTED: ' + String(executionSignal.reason));
          }
          await operation();
        });
        progressTail = run.then(
          () => undefined,
          (error: unknown) => {
            progressFailure ??= error;
          },
        );
        void run.catch(() => undefined);
        return run;
      };
      const managedChildren = new Set<Promise<SessionResult>>();
      let childrenClosed = false;
      const delegationState: TaskDelegationState | undefined = m.contextGrant?.deliveryMode === 'approval_redelegation'
        ? { parentContract: structuredClone(contract), attempts: [] } : undefined;
      const persistChildren = () => saveCheckpoint({ delegation: structuredClone(delegationState!) });
      const checkParent = () => {
        executionSignal.throwIfAborted();
        if (!childHostOpen || gateway!.machine.state !== 'IN_PROGRESS' || wire.cancelHandled) throw new Error('DELEGATION_INVALID');
        this.assertPeer(m.requester.ownerDid, m.taskId);
        this.assertCapabilitiesActive(data.capabilityChains, capabilityContext);
        validateContextGrantUse(m, data.input, this.protocol.now());
        if (Date.parse(m.deadline) <= this.protocol.now()) throw new Error('DELEGATION_INVALID');
      };
      const dispatchChild = async (request: ChildDelegationRequest): Promise<SessionResult> => {
        if (childrenClosed || !delegationState) throw new Error('DELEGATION_INVALID');
        if (!request || Object.keys(request).some(k => !['to','relay','manifest','input','auditPath'].includes(k)))
          throw new Error('DELEGATION_INVALID');
        const child = structuredClone(request.manifest), input = structuredClone(request.input);
        if (Object.hasOwn(child, 'parentTaskId')) throw new Error('DELEGATION_INVALID');
        assertDelegationAttenuation(m, child);
        if (child.requester.ownerDid !== this.options.owner.did || child.taskId === m.taskId ||
            [m.requester.ownerDid, this.options.owner.did].includes(child.worker!.ownerDid) ||
            delegationState.attempts.some(a => a.childTaskId === child.taskId)) throw new Error('DELEGATION_INVALID');
        checkParent();
        validateContextGrantUse(child, input, this.protocol.now());
        const facility = this.options.redelegation!;
        requireOwnerDecision(facility.ownerApprovalProvider);
        requireOwnerDecision(facility.requester.approvalProvider);
        if (facility.requester.options.owner.did !== this.options.owner.did) throw new Error('DELEGATION_INVALID');
        let attempt: ChildDelegationAttempt | undefined;
        const options: DelegateOptions = { to: request.to, relay: request.relay, manifest: child, input,
          title: child.task.title, description: child.task.description, auditPath: request.auditPath,
          signal: executionSignal, capabilityChains: [] };
        managedChildHooks.set(options, {
          prepare: async (manifest, selectedInput, peer) => {
            checkParent();
            assertDelegationAttenuation(m, manifest);
            if (peer !== child.worker!.ownerDid || peer === m.requester.ownerDid || peer === this.options.owner.did)
              throw new Error('DELEGATION_INVALID');
            const values = { childManifestDigest: digest(manifest), childInputDigest: digest(selectedInput), delegateeOwnerDid: peer };
            const target = redelegationTarget(contract, values), started = Date.now();
            const receipt = await abortable(facility.ownerApprovalProvider.approve({ taskId: m.taskId, gate: 'redelegation',
              target: structuredClone(target), details: { parentManifest: structuredClone(m), childManifest: structuredClone(manifest),
                input: structuredClone(selectedInput), delegateeOwnerDid: peer, depthRemaining: 0,
                disclosure: 'The root owner receives the complete signed parent and child contracts, including declarations and owner DIDs. Confirm this input, angle and task serve the parent purpose.' },
              signal: executionSignal, deadline: m.deadline }), executionSignal);
            checkParent();
            validateContextGrantUse(manifest, selectedInput, this.protocol.now());
            assertFreshDecision(receipt, started);
            gateway!.approvals.require(m.taskId, 'redelegation', target, receipt);
            if (delegationState.attempts.some(a => a.childTaskId === child.taskId)) throw new Error('DELEGATION_INVALID');
            attempt = { childTaskId: child.taskId, ...values, approval: receipt, status: 'approved' };
            delegationState.attempts.push(attempt);
            persistChildren();
          },
          beforeTransmit: (manifest, selectedInput) => {
            checkParent();
            validateContextGrantUse(manifest, selectedInput, this.protocol.now());
            if (!attempt || digest(manifest) !== attempt.childManifestDigest || digest(selectedInput) !== attempt.childInputDigest ||
                !verifyApproval(attempt.approval, this.options.owner.did, m.taskId, 'redelegation', redelegationTarget(contract, attempt)))
              throw new Error('DELEGATION_APPROVAL_REQUIRED');
            attempt.status = 'dispatching'; persistChildren();
          },
          onAcceptedContract: acceptedChild => {
            if (!attempt) throw new Error('DELEGATION_INVALID');
            // Keep uncertainty durable if signing or publication fails after authenticated ACCEPT.
            attempt.status = 'unresolved'; persistChildren();
            checkParent();
            const link = createDelegationLink({ parentContract: contract, childContract: acceptedChild }, this.options.owner);
            attempt.proof = { link, childContract: structuredClone(acceptedChild) };
            attempt.status = 'accepted'; persistChildren();
          },
        });
        try {
          const result = await facility.requester.delegate(options);
          if (!attempt?.proof || result.state !== 'SETTLED') throw new Error('DELEGATION_INVALID');
          attempt.status = 'completed'; persistChildren();
          return result;
        } catch (error) {
          if (attempt) {
            attempt.status = attempt.proof || attempt.status === 'approved' || error instanceof PeerRejectedError && attempt.status !== 'unresolved'
              ? 'failed' : 'unresolved';
            persistChildren();
          }
          throw error;
        } finally { managedChildHooks.delete(options); }
      };
      const context: AgentTaskContext = {
        preCallSizeLimits: sizeLimits,
        taskId: m.taskId,
        manifest: structuredClone(m),
        input: structuredClone(data.input),
        workspaceDir: workspace,
        signal: executionSignal,
        reportUsage: (delta) => gateway!.quota.recordMetrics(delta),
        reportProgress: (progress) => {
          // An invalid payload poisons the session even when the adapter catches the rejection.
          // Its metrics are not charged.
          const invalidProgress = (): Promise<never> => {
            const error = new Error('INVALID_PROGRESS');
            progressFailure ??= error;
            return Promise.reject(error);
          };
          // Validate and charge quota before returning, so a later call on this turn
          // observes BUDGET_EXCEEDED without waiting for the wire queue.
          if (!progress || typeof progress.step !== 'string' || progress.step.length === 0)
            return invalidProgress();
          if (progress.percent !== undefined && typeof progress.percent !== 'number')
            return invalidProgress();
          let metricsError: unknown;
          if (progress.metrics) {
            const delta: {
              inputTokens?: number;
              outputTokens?: number;
              toolCalls?: number;
              wallTimeMs?: number;
            } = {};
            if (progress.metrics.inputTokens !== undefined)
              delta.inputTokens = progress.metrics.inputTokens;
            if (progress.metrics.outputTokens !== undefined)
              delta.outputTokens = progress.metrics.outputTokens;
            if (progress.metrics.toolInvocations !== undefined)
              delta.toolCalls = progress.metrics.toolInvocations;
            if (progress.metrics.elapsedMs !== undefined)
              delta.wallTimeMs = progress.metrics.elapsedMs;
            if (Object.keys(delta).length > 0) {
              try {
                context.reportUsage(delta);
              } catch (error) {
                metricsError = error;
              }
            }
          }
          if (metricsError) {
            progressFailure ??= metricsError;
            const code = safeError(metricsError, !!m.contextGrant);
            return enqueueProgress(async () => {
              // Wait until any in-flight PROGRESS handshake finishes, then reject the session.
              wireFailureSent = true;
              await wire.rawSend('ERROR', { code });
              throw metricsError;
            }, true);
          }
          return enqueueProgress(async () => {
            if (progressFailure) throw progressFailure;
            if (executionSignal.aborted)
              throw new Error('EXECUTION_ABORTED: ' + String(executionSignal.reason));
            await wire.sendEvent('PROGRESS', progress);
          });
        },
        callTool: async (tool, args) => {
          this.assertPeer(m.requester.ownerDid, m.taskId);
          executionSignal.throwIfAborted();
          if (!args || typeof args !== 'object' || Array.isArray(args))
            throw new Error('CAPABILITY_VIOLATION: arguments');
          const index = data.capabilityChains.findIndex((c) =>
            c.at(-1)!.payload.allowedTools.includes(tool),
          );
          if (index < 0) throw new Error('CAPABILITY_VIOLATION: unauthorized tool');
          const approval =
            tools[tool] && !tools[tool].readOnly
              ? await (automaticProvider ?? this.approvalProvider).approve({
                  taskId: m.taskId,
                  gate: 'external_side_effect',
                  target: { name: tool, args },
                  details: { manifest: m },
                  signal: executionSignal,
                })
              : undefined;
          executionSignal.throwIfAborted();
          const invocation = { id: m.taskId + ':' + invocationCount++, tool,
            argsDigest: digest(args), completed: false };
          saveCheckpoint({ invocations: [...(checkpoint?.invocations ?? []), invocation] });
          const result = asJson(await proxies[index].callTool(tool, args, approval));
          // A backend may finish after cancellation. Leave its uncertain result for inspection.
          if (!executionSignal.aborted)
            saveCheckpoint({ invocations: (checkpoint?.invocations ?? []).map((call) =>
              call.id === invocation.id ? { ...call, completed: true } : call) });
          return result;
        },
      };
      if (delegationState) context.redelegate = request => {
        const operation = dispatchChild(request);
        managedChildren.add(operation);
        void operation.finally(() => managedChildren.delete(operation)).catch(() => {});
        return operation;
      };
      this.assertPeer(m.requester.ownerDid, m.taskId);
      this.assertCapabilitiesActive(data.capabilityChains, capabilityContext);
      validateContextGrantUse(m, data.input, this.protocol.now());
      if (this.deliveryService) await this.withDelivery(() => {
        this.deliveryService!.recipientStatus.handoff(first, m);
      }, executionSignal);
      let accountingFailure: unknown;
      const counter = monthlyCounter;
      const model = this.options.adapter.billingModel ?? '';
      const originalReport = context.reportUsage;
      if (counter) {
        context.reportUsage = delta => {
          try {
            if (delta.inputTokens !== undefined || delta.outputTokens !== undefined) {
              counter.usage(m.taskId, model, delta.inputTokens ?? 0, delta.outputTokens ?? 0);
            }
          } catch (error) { accountingFailure ??= error; }
          originalReport(delta);
        };
      }
      let execution: Awaited<ReturnType<typeof executionBackend.execute>>;
      try {
        execution = await abortable(executionBackend.execute(this.options.adapter, context), executionSignal);
        if (accountingFailure) throw accountingFailure;
      } finally {
        if (counter) {
          counter.finish(m.taskId);
          monthlySettled = true;
          this.refreshMonthlyCard();
          if (this.registered) await this.register().catch(() => {});
        }
      }
      const output = execution.output;
      childrenClosed = true;
      if (delegationState) await abortable(Promise.allSettled([...managedChildren]), executionSignal);
      const delegation = delegationState ? assembleDelegation(delegationState) : undefined;
      if (!this.options.inboxPath) await acknowledgeProposal(executionSignal);
      // A task may return while a queued progress update is still waiting for its ACK.
      // Skip the drain once the task is already aborted, cancelled, or over budget.
      if (!executionSignal.aborted && !wire.cancelHandled) {
        await progressTail;
        if (progressFailure) throw progressFailure;
      }
      executionSignal.throwIfAborted();
      gateway.quota.record();
      const delivery = createDelivery(
        m.taskId,
        contract.contractDigest,
        output,
        gateway.quota.receipt(this.options.owner),
        this.options.owner,
        {
          effectiveIsolationLevel: execution.effectiveIsolationLevel,
          ...(execution.sandboxBoundary ? { sandboxBoundary: execution.sandboxBoundary } : {}),
        },
        delegation,
      );
      if (m.contextGrant && workspace) {
        await cleanupWorkspace();
        await wire.contextEvent('CONTEXT_DELETION_ATTEMPTED');
      }
      const transition = gateway.transition('DELIVER');
      saveCheckpoint({ phase: 'delivered' });
      await wire.sendEvent('DELIVER', { ...delivery, transition });
      this.options.onEvent?.('DELIVER', m.taskId);
      timeouts.wait();
      const verification = await wire.receiveEvent(['VERIFY_ACCEPT', 'VERIFY_REJECT']);
      gateway.machine.apply(verification.payload.payload as unknown as Signed<Transition>);
      if (verification.payload.eventType === 'VERIFY_REJECT')
        throw new Error('VERIFICATION_REJECTED');
      const settled = await wire.receiveEvent('SETTLED');
      gateway.machine.apply(settled.payload.payload as unknown as Signed<Transition>);
      const bundle = await wire.finishWorker((sealed) => {
        saveOutcome({ code: 'TASK_SETTLED', result: { taskId: m.taskId, state: 'SETTLED', deliverable: output, bundle: sealed } });
      });
      saveCheckpoint({ notificationPending: false });
      this.options.onEvent?.('SETTLED', m.taskId);
      return { taskId: m.taskId, state: 'SETTLED', deliverable: output, bundle };
    } catch (e) {
      childHostOpen = false;
      if (checkpoint?.outcome?.result) {
        // The bilateral checkpoint is already durable even if its final relay send failed.
        await this.notifyOutcome(checkpoint).then(() => saveCheckpoint({ notificationPending: false })).catch(() => {});
        return checkpoint.outcome.result;
      }
      if (
        gateway &&
        (wire.cancelHandled || cancelController.signal.aborted) &&
        ['ACCEPTED', 'IN_PROGRESS', 'CANCELLED'].includes(gateway.machine.state)
      ) {
        try {
          await wire.waitUntilCancelHandled();
          const body = wire.lastCancel?.payload.payload as unknown as CancelPayload | undefined;
          if (!body || body.cancelledBy !== m.requester.ownerDid || !body.transition)
            throw new Error('INVALID_CANCEL');
          if (gateway.machine.state !== 'CANCELLED') gateway.machine.apply(body.transition);
          const bundle = await wire.finishWorker((sealed) => {
            saveOutcome({ code: 'TASK_CANCELLED', result: { taskId: m.taskId, state: 'CANCELLED', deliverable: null, bundle: sealed } });
          });
          saveCheckpoint({ notificationPending: false });
          this.options.onEvent?.('CANCELLED', m.taskId);
          return { taskId: m.taskId, state: 'CANCELLED', deliverable: null, bundle };
        } catch (inner) {
          await wire.rawSend('ERROR', { code: safeError(inner, !!m.contextGrant) }).catch(() => {});
          throw inner;
        }
      }
      await progressTail;
      const heldAttemptClosed = heldClose.signal.aborted &&
        (auditStage === 'OWNER_APPROVAL' || auditStage === 'ACCEPT_ACK_WAIT');
      preserveWorkspace = activeSignal.aborted || idleSignal.aborted || heldAttemptClosed;
      const timeoutReason = activeSignal.reason instanceof Error ? activeSignal.reason.message : activeSignal.reason;
      const interruptionReason = idleSignal.aborted ? 'WORKER_STOPPED' :
        activeSignal.aborted && ['TASK_TIMEOUT', 'PEER_WAIT_TIMEOUT'].includes(String(timeoutReason)) ? 'SESSION_TIMEOUT' :
        heldAttemptClosed ? 'HELD_ATTEMPT_CLOSED' : undefined;
      if (interruptionReason && auditStage && auditStage !== 'OUT_OF_SCOPE' && auditPath) {
        const entries = await wire.quiesceAudit();
        try {
          // No journal is available only to embedders without persisted task checkpoints.
          const record = checkpoint ?? { version: 1, taskId: m.taskId, requesterDid: m.requester.ownerDid,
            envelopeId: first.payload.envelopeId, proposalDigest: digest({ manifest: m, input: data.input }),
            phase: 'received', auditPath, auditStage, invocations: [] } as TaskCheckpoint;
          this.closeInterruptedAudit(record, interruptionReason, entries, saved => {
            checkpoint = saved;
            this.saveTaskCheckpoint(saved);
          });
        } catch { this.reportInterruptionFailure(m.taskId); }
        saveOutcome({ code: 'TASK_INTERRUPTED' });
      } else if (auditStage && !preserveWorkspace) setAuditStage('OUT_OF_SCOPE');
      if (idleSignal.aborted) throw e;
      const diagnostic = preserveWorkspace ? { code: 'TASK_INTERRUPTED' } : rejectionBody(progressFailure ?? e, !!m.contextGrant);
      // Record the terminal code and tell the owner before any outbox write. A busy
      // receipt or held-review close must not skip the requester's terminal ERROR.
      try { saveCheckpoint({ phase: 'terminal', outcome: diagnostic, notificationPending: true }); } catch { /* The event below still names the code. */ }
      if (diagnostic.code === 'TASK_INTERRUPTED') {
        this.options.onEvent?.('INTERRUPTED', m.taskId, { ...diagnostic,
          ...(auditStage && auditStage !== 'OUT_OF_SCOPE' ? { phase: auditStage } : {}) });
      } else this.reportRejection(m.taskId, progressFailure ?? e, !!m.contextGrant);
      this.deliveryService?.recipientStatus.end(first.payload.envelopeId);
      if (this.deliveryService) {
        try {
          await this.withDelivery(() => {
            this.deliveryService!.store.receipt(first, Date.parse(m.deadline), 'terminal', diagnostic.code);
          }, activeSignal);
        } catch { /* The checkpoint already records the outcome. */ }
      }
      const refused = this.heldReview.list().find(r => r.taskId === m.taskId);
      if (refused && diagnostic.code !== 'PENDING_OWNER_APPROVAL' && !preserveWorkspace) {
        try { await this.withDelivery(() => { this.heldReview.discard(refused.id); }, activeSignal); }
        catch { /* Closing the held attempt must not hide the terminal error. */ }
      }
      if (!wireFailureSent) {
        wireFailureSent = true;
        if (proposalAudited && !preserveWorkspace && diagnostic.code !== 'PENDING_OWNER_APPROVAL')
          await wire.contextEvent('CONTEXT_DISCARDED').catch(() => {});
        let delivered = false;
        try {
          await wire.rawSend('ERROR', diagnostic);
          delivered = true;
        } catch {
          // A direct seq-0 ERROR is safe only before this wire has committed a send.
          if (!wire.hasCommittedSend) {
            try {
              await relay.send(signEnvelope({
                taskId: m.taskId, recipientDid: m.requester.ownerDid, seq: 0, eventType: 'ERROR',
                payload: asJson(diagnostic),
              }, this.options.owner, { encrypt: true }));
              delivered = true;
            } catch { /* The requester still has its own deadline. */ }
          }
        }
        if (delivered) {
          saveCheckpoint({ notificationPending: false });
          if (diagnostic.code === 'PENDING_OWNER_APPROVAL') {
            try { await acknowledgeProposal(); } catch { /* Receipt can wait for the next prepare. */ }
          }
        }
      }
      // A quota abort already surfaces as EXECUTION_ABORTED. Keep that error.
      // A caught INVALID_PROGRESS still fails the session with the sticky error.
      if (
        progressFailure instanceof Error &&
        !(e instanceof Error && e.message.startsWith('EXECUTION_ABORTED'))
      )
        throw progressFailure;
      throw e;
    } finally {
      try {
        stopHeldWatch();
        childHostOpen = false;
        this.deliveryService?.recipientStatus.end(first.payload.envelopeId);
        heartbeatStopped = true;
        clearTimeout(heartbeat);
        timeouts.close();
        wire.close();
        this.acceptedPeers.delete(m.taskId);
        const completedHeld = this.heldReview.list().find(r => r.taskId === m.taskId);
        if (completedHeld && gateway && ['SETTLED', 'CANCELLED'].includes(gateway.machine.state)) this.heldReview.discard(completedHeld.id, gateway.machine.state === 'SETTLED' ? 'completed' : 'closed');
        if (trackedTaskId) this.liveChains.delete(trackedTaskId);
        gateway?.close();
        if (idleSignal.aborted && checkpoint?.phase !== 'terminal') preserveWorkspace = true;
        if (workspace && !preserveWorkspace) await cleanupWorkspace();
      } finally {
        if (monthlyCounter && !monthlySettled) {
          monthlyCounter.finish(m.taskId, !monthlyAccepted);
          this.refreshMonthlyCard();
          if (this.registered) await this.register().catch(() => {});
        }
      }
    }
  }
  /**
   * Hide REVOKE envelopes from task reads. start, runOnce, and pumpUntil all
   * receive through this relay, so a FIFO head of one or more REVOKE messages
   * is applied before the following PROPOSE is observed.
   */
  private isRequesterBoundFrame(envelope: SignedEnvelope): boolean {
    const { eventType, seq, taskId } = envelope.payload;
    if (REQUESTER_BOUND_EVENTS.has(eventType)) return true;
    if (seq === 0 && (eventType === 'AUDIT_ACK' || eventType === 'ERROR')) return true;
    if (eventType !== 'PROPOSE' && eventType !== 'REVOKE' && !this.mailboxes.has(taskId))
      return true;
    return false;
  }
  private revocationAwareRelay(relay: RelayTransport): RelayTransport {
    const receive: RelayTransport['receive'] = async (recipientDid, waitMs, signal, filter) => {
      for (;;) {
        if (this.registered && (JSON.stringify(this.protocol.receiveVersions()) !== JSON.stringify(this.agentCard.payload.protocolVersions) ||
            this.autoAccept.limits.maxMonthlyUsd !== undefined &&
            this.agentCard.signature.signedAt.slice(0, 7) !== new Date(this.protocol.now()).toISOString().slice(0, 7))) await this.register();
        const forwarded = this.forwardedQueue.shift();
        if (forwarded) {
          if (this.consumeRevocation(forwarded)) continue;
          if (isConnectionEvent(forwarded.payload.eventType)) { await this.connections.route(forwarded); continue; }
          return forwarded;
        }
        const envelope = await relay.receive(
          recipientDid, waitMs, signal, filter ?? { role: 'worker' },
        );
        if (!envelope) {
          const afterWait = this.forwardedQueue.shift();
          if (afterWait) {
            if (this.consumeRevocation(afterWait)) continue;
            if (isConnectionEvent(afterWait.payload.eventType)) { await this.connections.route(afterWait); continue; }
            return afterWait;
          }
          return undefined;
        }
        if (envelope.payload.eventType === 'DELIVERY_STATUS' && this.deliveryService) {
          try { await this.deliveryService.statusRouter.route(envelope, relay); }
          catch (error) { this.deliveryService.options.onError?.(error as Error); }
          continue;
        }
        if (this.consumeRevocation(envelope)) { await acknowledgeRelay(relay, envelope); continue; }
        if (isConnectionEvent(envelope.payload.eventType)) { await this.connections.route(envelope); continue; }
        if (
          this.isRequesterBoundFrame(envelope) &&
          forwardToRequesterInbox(this.options.owner.did, envelope)
        )
          continue;
        return envelope;
      }
    };
    return {
      ...deliveryPins(relay),
      get connectionStatus() { return relay.connectionStatus; },
      send: async (envelope) => {
        this.assertPeer(envelope.payload.recipientDid, envelope.payload.taskId);
        try { await relay.send(envelope); }
        catch (error) {
          // Exact, decoded prior admission is success, never arbitrary HTTP 400.
          // Scope this to a running persistent worker; once/runOnce stay fail-fast.
          if (!this.continuous || !(error instanceof Error) || error.name !== 'RelayDuplicateEnvelopeError' ||
              !('code' in error) || error.code !== 'REPLAYED_ENVELOPE' ||
              !('status' in error) || error.status !== 400) throw error;
        }
      },
      ...(relay.acknowledgeDelivery ? { acknowledgeDelivery: (did: string, id: string, signal?: AbortSignal) => relay.acknowledgeDelivery!(did, id, AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])])) } : {}),
      receive,
      ...(relay.register ? { register: (card) => relay.register!(card) } : {}),
      ...(relay.discover ? { discover: () => relay.discover!() } : {}),
      ...(relay.setRecipientKey
        ? { setRecipientKey: (key: KeyPair) => relay.setRecipientKey!(key) }
        : {}),
      ...(relay.withRecipient
        ? {
            withRecipient: (key: KeyPair) => this.revocationAwareRelay(relay.withRecipient!(key)),
          }
        : {}),
    };
  }
  /** True when the envelope was a REVOKE and must not be treated as a proposal. */
  private consumeRevocation(envelope: SignedEnvelope): boolean {
    if (envelope.payload?.eventType !== 'REVOKE') return false;
    try {
      this.ingestRevocation(envelope);
    } catch {
      // Forged, undecryptable, or unauthorized notices are ignored. They must
      // not abort start or runOnce and must not be written into the registry.
    }
    return true;
  }
  private ingestRevocation(envelope: SignedEnvelope): void {
    if (!verifyEnvelope(envelope, this.options.owner.did)) return;
    const notice = openEnvelope<SignedRevocationNotice>(
      envelope,
      this.options.owner,
      sessionDecryptOptions(this.options.allowUnencryptedEnvelopes),
    );
    if (!verifyRevocationNotice(notice, envelope.payload.senderDid)) return;
    if (notice.payload.issuerDid !== envelope.payload.senderDid) return;
    if (notice.payload.targetType === 'invite') {
      // Invites are minted by the worker owner. Another DID cannot revoke them.
      if (notice.payload.issuerDid !== this.options.owner.did) return;
      this.recordNotice(notice);
      return;
    }
    if (notice.payload.targetType !== 'capability') return;
    // Only a chain that still verifies can promote a notice into the registry.
    const live = this.verifiedLiveEntries();
    if (this.capabilityNoticeAuthorized(notice, live)) {
      this.recordNotice(notice);
      return;
    }
    const pending = this.pendingCapabilities.get(notice.payload.targetId) ?? [];
    pending.push(structuredClone(notice));
    this.pendingCapabilities.set(notice.payload.targetId, pending);
  }
  private recordNotice(notice: SignedRevocationNotice): void {
    // Append even when another issuer already revoked this id. Replacing that
    // notice would let a colliding token erase a real issuer's revocation.
    this.inboxRevocations.revoke(notice);
    const external = asRevocationRegistry(this.options.revocation);
    if (!external || external === this.inboxRevocations) return;
    try {
      external.revoke(notice);
    } catch {
      // The caller registry can refuse a notice. The inbox copy still applies.
    }
  }
  private assertInviteActive(data: Proposal): boolean {
    const token = data.inviteToken;
    if (token === undefined) return false;
    if (typeof token !== 'string' || !token) throw new Error('INVALID_OR_EXPIRED_INVITE');
    const invite = parseAndVerifyInviteToken(token, this.protocol.now(), { allowPrivateRelay: true, allowExpired: true });
    if (invite.ownerDid !== this.options.owner.did ||
        invite.agentDid !== this.agentCard.payload.agentDid ||
        invite.relayUrl !== this.agentCard.payload.relayEndpoint)
      throw new Error('INVITE_WORKER_MISMATCH');
    this.revocation.assertNotRevoked('invite', digest(invite));
    this.revocation.assertNotRevoked('invite', token);
    if (Math.min(Date.parse(invite.expiresAt), Date.parse(invite.agentCard.payload.expiresAt)) <= this.protocol.now()) {
      throw new Error('INVITE_EXPIRED');
    }
    return true;
  }
  /**
   * Before ACCEPT, every verified capability chain is checked against revocation
   * notices. A notice is stored and applied only when its issuer signed that
   * token or an ancestor in a chain that has passed verifyCapabilityChain.
   * An unverified chain, including one whose payload.issuer was rewritten,
   * cannot promote a pending notice into the registry.
   */
  private assertCapabilitiesActive(chains: unknown, context: CapabilityContext): void {
    const verified = this.verifiedEntries(chains, context);
    this.promotePending(verified);
    for (const entry of verified) {
      if (this.verifiedChainRevoked(entry.chain)) throw new Error('TOKEN_REVOKED');
    }
  }
  private verifiedEntries(chains: unknown, context: CapabilityContext): VerifiedCapabilityChain[] {
    if (!Array.isArray(chains)) return [];
    const entries: VerifiedCapabilityChain[] = [];
    for (const chain of chains) {
      if (!Array.isArray(chain)) continue;
      try {
        verifyCapabilityChain(chain, context);
      } catch {
        // Signature, linkage, or root failures must not authorize a revocation.
        continue;
      }
      entries.push({ chain, context: { ...context } });
    }
    return entries;
  }
  private promotePending(entries: VerifiedCapabilityChain[]): void {
    for (const [targetId, notices] of [...this.pendingCapabilities.entries()]) {
      const keep: SignedRevocationNotice[] = [];
      for (const notice of notices) {
        if (this.capabilityNoticeAuthorized(notice, entries)) this.recordNotice(notice);
        else keep.push(notice);
      }
      if (keep.length === 0) this.pendingCapabilities.delete(targetId);
      else this.pendingCapabilities.set(targetId, keep);
    }
  }
  private verifiedChainRevoked(chain: CapabilityToken[]): boolean {
    for (let index = 0; index < chain.length; index++) {
      const token = chain[index];
      if (!token?.payload) continue;
      const targetIds = [token.payload.id];
      try {
        targetIds.push(digest(token));
      } catch {
        // An unhashable token is not a revocation target.
      }
      for (const targetId of targetIds) {
        if (typeof targetId !== 'string' || targetId.length === 0) continue;
        if (this.capabilityTargetRevoked(chain, index, targetId)) return true;
      }
    }
    return false;
  }
  /**
   * Pending and stored notices apply only when their issuer controls this
   * verified token. A bare target-id hit from another issuer does not.
   */
  private capabilityTargetRevoked(
    chain: CapabilityToken[],
    index: number,
    targetId: string,
  ): boolean {
    const pending = this.pendingCapabilities.get(targetId) ?? [];
    if (pending.some((notice) => capabilityIssuerControls(chain, index, notice.payload.issuerDid)))
      return true;
    const listed = [
      ...this.listedNotices(this.inboxRevocations, targetId),
      ...this.listedNotices(this.options.revocation, targetId),
    ];
    if (listed.some((notice) => capabilityIssuerControls(chain, index, notice.payload.issuerDid)))
      return true;
    const external = this.options.revocation;
    if (
      external &&
      typeof external.noticesFor !== 'function' &&
      external.isRevoked('capability', targetId)
    )
      return true;
    return false;
  }
  private listedNotices(
    list: RevocationList | undefined,
    targetId: string,
  ): SignedRevocationNotice[] {
    if (!list || typeof list.noticesFor !== 'function') return [];
    return list.noticesFor('capability', targetId);
  }
  private rememberChains(taskId: string, chains: unknown, context: CapabilityContext): void {
    const stored: VerifiedCapabilityChain[] = [];
    if (Array.isArray(chains)) {
      for (const chain of chains) {
        if (!Array.isArray(chain)) continue;
        try {
          verifyCapabilityChain(chain, context);
        } catch {
          continue;
        }
        stored.push({
          chain: chain.map((token) => structuredClone(token)),
          context: { ...context },
        });
      }
    }
    this.liveChains.set(taskId, stored);
  }
  private verifiedLiveEntries(): VerifiedCapabilityChain[] {
    const entries: VerifiedCapabilityChain[] = [];
    for (const group of this.liveChains.values()) {
      for (const entry of group) {
        try {
          verifyCapabilityChain(entry.chain, entry.context);
          entries.push(entry);
        } catch {
          // A chain that no longer verifies cannot authorize a revocation.
        }
      }
    }
    return entries;
  }
  private capabilityNoticeAuthorized(
    notice: SignedRevocationNotice,
    entries: VerifiedCapabilityChain[],
  ): boolean {
    if (notice.payload.targetType !== 'capability') return false;
    for (const entry of entries) {
      try {
        verifyCapabilityChain(entry.chain, entry.context);
      } catch {
        continue;
      }
      for (let index = 0; index < entry.chain.length; index++) {
        if (!this.sameCapabilityTarget(entry.chain[index], notice.payload.targetId)) continue;
        if (capabilityIssuerControls(entry.chain, index, notice.payload.issuerDid)) return true;
      }
    }
    return false;
  }
  private sameCapabilityTarget(token: CapabilityToken | undefined, targetId: string): boolean {
    if (!token?.payload || typeof token.payload !== 'object') return false;
    if (token.payload.id === targetId) return true;
    try {
      return digest(token) === targetId;
    } catch {
      return false;
    }
  }
}
interface CancelPayload {
  reason?: string;
  cancelledBy: string;
  transition: Signed<Transition>;
}
export interface ErrorDetail {
  field: string;
  expected: string;
  actual: string;
  hint: string;
}
export interface ErrorDiagnostic { code: string; detail?: ErrorDetail; phase?: 'OWNER_APPROVAL' | 'ACCEPT_ACK_WAIT' }
class DiagnosticError extends Error {
  constructor(code: string, readonly detail: ErrorDetail) { super(code); }
}
class PreCallRejectedError extends Error {
  constructor(readonly code: string, readonly messageKind: 'standard' | 'trial-reviewer') { super(code); }
}
class AdmissionLimitError extends Error {
  constructor(readonly code: 'MONTHLY_LIMIT_REACHED' | 'MONTHLY_STATE_UNAVAILABLE' | 'MONTHLY_MODEL_UNSUPPORTED' | 'AUTO_ACCEPT_DAILY_LIMIT_REACHED',
    readonly resetAt: string, readonly messageKind: 'standard' | 'trial-reviewer' = 'standard') { super(code); }
}
class PendingTaskError extends Error {
  constructor(readonly reason: string) { super('PENDING_OWNER_APPROVAL'); }
}
function diagnosticError(code: string, field: string, expected: unknown, actual: unknown, hint: string): Error {
  return new DiagnosticError(code, { field, expected: digest(expected), actual: digest(actual), hint });
}
function rejectionBody(error: unknown, contextGrant = false): ErrorDiagnostic & { reason?: string; resetAt?: string; messageKind?: 'standard' | 'trial-reviewer' } {
  if (error instanceof PreCallRejectedError) return { code: error.code,
    ...(error.code === 'INPUT_SIZE_LIMIT_REACHED' ? { messageKind: error.messageKind } : {}) };
  if (error instanceof AdmissionLimitError) return { code: error.code,
    ...(error.code.endsWith('LIMIT_REACHED') ? { resetAt: error.resetAt } : {}),
    ...(error.code === 'MONTHLY_LIMIT_REACHED' ? { messageKind: error.messageKind } : {}) };
  if (error instanceof PendingTaskError) return { code: 'PENDING_OWNER_APPROVAL', reason: error.reason };
  if (error instanceof DiagnosticError) return { code: safeError(error, contextGrant), detail: error.detail };
  if (error instanceof ProposalRejectedError) return { code: error.code, reason: error.reason };
  if (safeError(error, contextGrant) === 'PENDING_OWNER_APPROVAL') return { code: 'PENDING_OWNER_APPROVAL', reason: PENDING_MESSAGE };
  return { code: safeError(error, contextGrant) };
}
function safeError(e: unknown, contextGrant = false): string {
  const s = String(e);
  const exact = e instanceof Error ? e.message.split(':')[0] : '';
  if (['OUTBOX_STORE_INVALID', 'OUTBOX_STORE_BUSY', 'OUTBOX_STORE_UNWRITABLE', 'OUTBOX_FULL',
    'OUTBOX_DEADLINE_EXPIRED', 'DELIVERY_RECORD_CONFLICT', 'AUDIT_INTERRUPTION_WRITE_FAILED'].includes(exact)) return exact;
  if (['ISOLATION_LEVEL_UNSUPPORTED', 'ISOLATION_LEVEL_MISMATCH', 'MONTHLY_STATE_UNAVAILABLE', 'INPUT_SIZE_LIMIT_REACHED', 'INPUT_SIZE_UNAVAILABLE', 'INPUT_BUDGET_EXCEEDED'].includes(exact)) return exact;
  if (contextGrant && ['DELEGATION_PROOF_REQUIRED', 'DELEGATION_INVALID', 'DELEGATION_APPROVAL_REQUIRED'].includes(exact)) return exact;
  if (/^(CONTEXT_GRANT_|PROTOCOL_|CONNECTION_|INVALID_CONNECTION_|QUARANTINE_|INSPECTION_|ACCESS_MODE_REMOVED|INVITE_REFERENCE_UNAVAILABLE)/.test(exact)) return exact;
  for (const code of ['PENDING_OWNER_APPROVAL', 'PEER_NOT_ALLOWED', 'REQUEST_DENIED', 'INTAKE_QUEUE_FULL', 'INTAKE_RATE_LIMITED', 'INTAKE_STORE_INVALID', 'INTAKE_STORE_BUSY', 'INTAKE_STORE_UNWRITABLE', 'APPROVAL_CHANNEL_UNAVAILABLE', 'CONTACT_REVOKED', 'CONTACT_NOT_ALLOWED', 'INCOMPATIBLE_TIMEOUTS', 'CLAIM_LOST', 'DAILY_LIMIT_REACHED', 'DAILY_TASK_REPLAY', 'DAILY_LIMIT_CLOCK_ROLLBACK', 'DAILY_LIMIT_BUSY', 'DAILY_LIMIT_INVALID', 'UNENCRYPTED_ENVELOPE_REJECTED', 'INVITE_REQUIRED', 'INVITE_EXPIRED', 'INVITE_WORKER_MISMATCH', 'TASK_SCOPE_REJECTED'])
    if (s === 'Error: ' + code || s.startsWith('Error: ' + code + ':')) return code;
  if (s.includes('TOKEN_REVOKED')) return 'TOKEN_REVOKED';
  return (
    ['BUDGET', 'CAPABILITY', 'APPROVAL', 'HITL', 'INVALID', 'VERIFICATION', 'SCHEMA', 'ABORT'].find(
      (code) => s.includes(code),
    ) ?? 'EXECUTION_FAILED'
  );
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // Attach before throwIfAborted. A quota abort can reject the adapter in the same turn.
  promise.catch(() => undefined);
  signal.throwIfAborted();
  let listener = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        listener = () => reject(new Error('EXECUTION_ABORTED: ' + String(signal.reason)));
        signal.addEventListener('abort', listener, { once: true });
        if (signal.aborted) listener();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', listener);
  }
}
export interface RequesterClientOptions extends SessionTimeoutOptions, RelayAuthRecoveryOptions, ProtocolReleaseOptions {
  idempotencyOptions?: IdempotencyStoreOptions;
  deliveryService?: GatewayDeliveryService;
  deliveryOptions?: GatewayDeliveryOptions;
  connectionStore?: WorkerTrustStore;
  identityOptions?: IdentityStoreOptions;
  connectionReview?: ConnectionHumanReviewProvider;
  onConnectionEvent?: (event: ConnectedEvent) => void;
  /** Application-owned local records; omitted by library callers unless requested. */
  pendingStore?: RequesterPendingStore;
  /** Selected endpoint when the application injects a transport. */
  pendingRelayUrl?: string;
  owner: KeyPair;
  relay?: RelayTransport | string;
  approvalProvider?: ApprovalProvider;
  verificationEngine?: VerificationEngine;
  auditPath?: string;
  allowPrivateRelay?: boolean;
  /** DNS resolver used before a string relay URL is dialed. */
  lookup?: RelayClientSecurityOptions['lookup'];
  /**
   * Accept cleartext session envelopes. Default false: ACCEPT, PROGRESS, DELIVER,
   * and the other session frames throw UNENCRYPTED_ENVELOPE_REJECTED.
   */
  allowUnencryptedEnvelopes?: boolean;
}
/** Resolved action reviewed before any session envelope is transmitted. */
export interface BeforeProposeContext {
  workerAutomation?: { notice: string; policy: AutoAcceptPolicy };
  manifest: TaskManifest;
  input: Json;
  relay: string;
  signal: AbortSignal;
}
function freezeApprovalAction<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeApprovalAction(child);
    Object.freeze(value);
  }
  return value;
}
export interface ChildDelegationRequest {
  to: string;
  relay?: RelayTransport | string;
  manifest: TaskManifest;
  input: Json;
  auditPath?: string;
}
// Module-private hooks cannot be supplied by task output or arbitrary delegate options.
const managedChildHooks = new WeakMap<DelegateOptions, {
  prepare: (manifest: TaskManifest, input: Json, peer: string) => Promise<void>;
  beforeTransmit: (manifest: TaskManifest, input: Json) => void;
  onAcceptedContract: (contract: TaskContract) => void;
}>();
function assertFreshDecision(receipt: ApprovalReceipt, started: number): void {
  const approved = Date.parse(receipt?.payload?.approvedAt), signed = Date.parse(receipt?.signature?.signedAt);
  if (!Number.isFinite(approved) || !Number.isFinite(signed) || approved < started || signed < started ||
      approved > Date.now() || signed > Date.now()) throw new Error('DELEGATION_APPROVAL_REQUIRED');
}
export interface DelegateOptions extends SessionTimeoutOptions {
  contextGrant?: ContextGrantOptions;
  idempotencyKey?: string;
  /** @internal Host operation shared by prepared fan-out children. */
  idempotencyOperation?: IdempotencyOperation;
  /** @internal Stable ordered child index. */
  idempotencyChildIndex?: number;
  /** Saved target retained without its token; applications must resolve it into `to` on each attempt. */
  workerRef?: string;
  /** Existing requester-local record when explicitly resubmitting. */
  pendingId?: string;
  /** Selected endpoint when an application replaces a per-task transport. */
  pendingRelayUrl?: string;
  /** Explicit resubmission renegotiates the stored manifest version before signing. */
  renegotiateProtocol?: boolean;
  beforePropose?: (action: BeforeProposeContext) => Promise<void | IdempotencyAuthorization>;
  /** Local synchronous reservation after final protocol preflight and before transmission. */
  beforeTransmit?: () => void;
  to: string;
  discover?: { skillId?: string; taskType?: string };
  relay?: RelayTransport | string;
  title: string;
  description: string;
  input: Json;
  outputSchema?: Schema;
  budget?: Partial<BudgetSpec>;
  manifest?: TaskManifest;
  auditPath?: string;
  signal?: AbortSignal;
  capabilities?: TaskManifest['permissions']['grantedCapabilities'];
  /**
   * Chains to send on PROPOSE. When omitted, chains are minted from
   * grantedCapabilities. Supply them to revoke a known token id before send.
   */
  capabilityChains?: CapabilityToken[][];
  minimumIsolationLevel?: string;
  onProgress?: (
    progress: ProgressPayload,
    envelope: ProtocolEnvelope<ProgressPayload>,
  ) => void | Promise<void>;
}
export interface DelegateWorkerTarget {
  workerDid: string;
  inviteToken?: string | Signed<Invite>;
  relayUrl?: string;
}
export interface DelegateReceipt {
  workerDid: string;
  taskId: string;
  outputDigest: string;
  deliverable: Json;
  bundle: AuditBundle;
  accepted: boolean;
}
/** Locally verified delivery whose bilateral checkpoint did not finish. Never an audit bundle. */
export interface IncompleteDelegateReceipt extends Omit<DelegateReceipt, 'bundle'> {
  checkpointComplete: false;
  delivery: SignedEnvelope;
  verification: VerificationResult;
  entries: AuditEntry[];
  completionError: string;
}
/** Completion failure preserves local verification without claiming a sealed checkpoint. */
export class IncompleteSettlementError extends Error {
  readonly code?: string;
  readonly detail?: ErrorDetail;
  readonly recovery?: PeerRejectedError['recovery'];
  constructor(readonly incompleteReceipt: IncompleteDelegateReceipt, cause: unknown) {
    super(incompleteReceipt.completionError, { cause });
    this.name = 'IncompleteSettlementError';
    if (cause instanceof Error && 'code' in cause && typeof cause.code === 'string') this.code = cause.code;
    if (cause instanceof PeerRejectedError) {
      this.detail = cause.detail;
      this.recovery = cause.recovery;
    }
  }
}
export interface DelegateMultiResult {
  mode: 'race' | 'quorum';
  status: 'SETTLED';
  deliverable: Json;
  outputDigest: string;
  taskIds: string[];
  winners: Array<{ workerDid: string; taskId: string; outputDigest: string }>;
  receipts: DelegateReceipt[];
  incompleteReceipts: IncompleteDelegateReceipt[];
  cancelled: string[];
}
export interface DelegateMultiOptions extends SessionTimeoutOptions {
  contextGrant?: ContextGrantOptions;
  idempotencyKey?: string;
  /** @internal Host operation covering this ordered fan-out. */
  idempotencyOperation?: IdempotencyOperation;
  beforePropose?: DelegateOptions['beforePropose'];
  workers: DelegateWorkerTarget[];
  mode: 'race' | 'quorum';
  quorumSize?: number;
  /** Completion grace for delivered sessions after a winner is selected. Default 45000 ms. */
  completionTimeoutMs?: number;
  title: string;
  description: string;
  input: Json;
  outputSchema?: Schema;
  budget?: Partial<BudgetSpec>;
  capabilities?: DelegateOptions['capabilities'];
  minimumIsolationLevel?: string;
  signal?: AbortSignal;
  onProgress?: DelegateOptions['onProgress'];
  auditPath?: string;
}
export interface DeliverRevocationOptions {
  relay: RelayTransport | string;
  from: KeyPair;
  recipientDid: string;
  notice: SignedRevocationNotice;
  /** Routing id carried in the envelope header. Defaults to the revocation id. */
  taskId?: string;
  seq?: number;
  /** Encrypt the notice to recipientDid. Default true. */
  encrypt?: boolean;
  allowPrivateRelay?: boolean;
  lookup?: RelayClientSecurityOptions['lookup'];
}
/**
 * Queue a signed REVOKE envelope on a worker inbox.
 * The payload is a SignedRevocationNotice. Encryption is on unless encrypt is false,
 * so an offline worker reads the notice in FIFO order before a later PROPOSE.
 */
export async function deliverRevocation(
  options: DeliverRevocationOptions,
): Promise<SignedEnvelope> {
  const notice = options.notice;
  if (
    !verifyRevocationNotice(notice, options.from.did) ||
    notice.payload.issuerDid !== options.from.did
  )
    throw new Error('INVALID_REVOCATION');
  resolveDid(options.recipientDid);
  const relayOption = options.relay;
  if (!relayOption) throw new Error('RELAY_REQUIRED');
  if (typeof relayOption === 'string')
    validateRelayEndpointUrl(relayOption, { allowPrivateRelay: options.allowPrivateRelay });
  else if ('url' in relayOption && typeof relayOption.url === 'string')
    validateRelayEndpointUrl(relayOption.url, {
      allowPrivateRelay: options.allowPrivateRelay,
    });
  const relay = transport(relayOption, options.from, {
    allowPrivateRelay: options.allowPrivateRelay,
    lookup: options.lookup,
  });
  const taskId =
    options.taskId && options.taskId.length > 0
      ? options.taskId
      : 'revoke_' + notice.payload.revocationId;
  const envelope = signEnvelope(
    {
      taskId,
      recipientDid: options.recipientDid,
      seq: options.seq ?? 0,
      eventType: 'REVOKE',
      payload: asJson(notice),
    },
    options.from,
    { encrypt: options.encrypt !== false },
  );
  await relay.send(envelope);
  return envelope;
}
export class RequesterClient {
  private readonly contextApprovals: ApprovalGate;
  private idempotency?: IdempotencyStore;
  private keyedStore(): IdempotencyStore {
    return this.idempotency ??= new IdempotencyStore(this.options.owner, {
      ...this.options.identityOptions, now: this.options.now, ...this.options.idempotencyOptions,
    });
  }
  private keyedAction(options: DelegateOptions | DelegateMultiOptions): Json {
    const allowed = ['idempotencyKey', 'idempotencyOperation', 'idempotencyChildIndex', 'workerRef', 'pendingId', 'pendingRelayUrl',
      'renegotiateProtocol', 'beforePropose', 'beforeTransmit', 'to', 'discover', 'relay', 'title', 'description', 'input',
      'outputSchema', 'contextGrant', 'budget', 'manifest', 'auditPath', 'signal', 'capabilities', 'capabilityChains', 'minimumIsolationLevel',
      'onProgress', 'workers', 'mode', 'quorumSize', 'completionTimeoutMs', 'timeoutMs', 'executionTimeoutMs', 'taskTimeoutMs',
      'waitTimeoutMs', 'connectTimeoutMs', 'transportIdleTimeoutMs', 'heartbeatIntervalMs'];
    if (Object.keys(options).some(k => !allowed.includes(k))) throw new Error('INVALID_IDEMPOTENCY_ARGUMENT');
    const timeouts = resolveSessionTimeouts(this.options, options);
    const normalized = { ...options, ...timeouts, relay: ('relay' in options ? options.relay : undefined) ?? this.options.relay,
      outputSchema: options.outputSchema ?? {}, capabilities: options.capabilities ?? [],
      minimumIsolationLevel: options.minimumIsolationLevel ?? 'subprocess_restricted',
      budget: { costBearer: 'worker_byok', maxInputTokens: 50000, maxOutputTokens: 10000,
        maxToolInvocations: 10, maxWallClockSeconds: timeouts.executionTimeoutMs !== undefined
          ? Math.floor(timeouts.executionTimeoutMs / 1000) : 60, onOverrun: 'hard_stop', ...options.budget },
      taskTimeoutMs: timeouts.taskTimeoutMs ?? timeouts.timeoutMs ?? 600_000, timeoutMs: undefined,
      waitTimeoutMs: timeouts.waitTimeoutMs ?? 600_000, connectTimeoutMs: timeouts.connectTimeoutMs ?? 45_000,
      transportIdleTimeoutMs: timeouts.transportIdleTimeoutMs ?? 90_000, heartbeatIntervalMs: timeouts.heartbeatIntervalMs ?? 15_000,
      ...('workers' in options ? { workers: structuredClone(options.workers),
        completionTimeoutMs: options.completionTimeoutMs ?? 45_000,
        ...(options.mode === 'quorum' ? { quorumSize: options.quorumSize ?? Math.floor(options.workers.length / 2) + 1 } : {}) } : {}),
    };
    return runtimeIdempotencyAction(normalized);
  }
  deliveryService?: GatewayDeliveryService;
  private deliveryStarted = false;
  readonly approvalProvider: ApprovalProvider;
  readonly protocol: LiveProtocol;
  constructor(readonly options: RequesterClientOptions) {
    assertConnectionsOptions(options);
    this.protocol = new LiveProtocol(options);
    validateRelayAuthRecoveryOptions(options);
    validateSessionTimeouts(options);
    this.approvalProvider =
      options.approvalProvider ?? new InteractiveCliApprovalProvider(options.owner);
    this.contextApprovals = new ApprovalGate(options.owner.did, policy);
    this.deliveryService = options.deliveryService;
    if (this.deliveryService && this.deliveryService.owner.did !== options.owner.did) throw deliveryError('OUTBOX_STORE_INVALID');
    if (!this.deliveryService && (typeof options.relay === 'string' || options.deliveryOptions))
      this.deliveryService = this.createDelivery();
  }
  private createDelivery(): GatewayDeliveryService {
    return new GatewayDeliveryService(this.options.owner, { ...this.options.deliveryOptions,
      identityOptions: this.options.deliveryOptions?.identityOptions ?? this.options.identityOptions,
      now: this.options.deliveryOptions?.now ?? this.options.now, requestTimeoutMs: this.options.connectTimeoutMs,
      resolveTransport: this.options.deliveryOptions?.resolveTransport ?? ((url, owner) => transport(url, owner, this.options)),
      assertSendAllowed: async context => {
        const store = this.options.connectionStore ?? new WorkerTrustStore(this.options.owner, {
          path: workerIntakePath(this.options.owner.did, this.options.identityOptions),
          fs: this.options.identityOptions?.fs, platform: this.options.identityOptions?.platform, now: this.options.now });
        if (store.connectionState(context.peerOwnerDid) === 'blocked') throw new Error('REQUEST_DENIED');
        await this.options.deliveryOptions?.assertSendAllowed?.(context);
      } });
  }
  async startDelivery(): Promise<void> { this.deliveryStarted = true; await this.deliveryService?.start(); }
  stopDelivery(): void { this.deliveryStarted = false; this.deliveryService?.stop(); }
  /**
   * Send an encrypted REVOKE for an invite or capability to a worker inbox.
   * `to` is a worker DID or an acp-invite token. The notice is signed by this client.
   */
  async sendRevocation(options: {
    to: string;
    relay?: RelayTransport | string;
    targetType?: 'invite' | 'capability';
    targetId?: string;
    reason?: string;
    notice?: SignedRevocationNotice;
    taskId?: string;
    encrypt?: boolean;
  }): Promise<SignedEnvelope> {
    const invite = isInviteTarget(options.to)
      ? parseAndVerifyInviteToken(options.to, Date.now(), {
          allowPrivateRelay: this.options.allowPrivateRelay,
        })
      : undefined;
    const relayOption = options.relay ?? this.options.relay ?? invite?.relayUrl;
    if (!relayOption) throw new Error('RELAY_REQUIRED');
    const recipientDid = invite?.ownerDid ?? options.to;
    const notice =
      options.notice ??
      createRevocationNotice(
        {
          targetType: options.targetType as 'invite' | 'capability',
          targetId: options.targetId ?? '',
          reason: options.reason ?? '',
        },
        this.options.owner,
      );
    return deliverRevocation({
      relay: relayOption,
      from: this.options.owner,
      recipientDid,
      notice,
      taskId: options.taskId,
      encrypt: options.encrypt,
      allowPrivateRelay: this.options.allowPrivateRelay,
      lookup: this.options.lookup,
    });
  }
  async delegate(
    options: DelegateOptions,
    hooks?: {
      onProgress?: DelegateOptions['onProgress'];
      /** @internal Multi-delegation stops cancelling execution once DELIVER is recorded. */
      onDelivered?: () => void;
    },
  ): Promise<SessionResult> {
    const managedChild = managedChildHooks.get(options);
    if (options.idempotencyKey !== undefined && !options.idempotencyOperation) {
      validateIdempotencyKey(options.idempotencyKey);
      options = { ...options, input: structuredClone(options.input),
        outputSchema: options.outputSchema && structuredClone(options.outputSchema),
        contextGrant: options.contextGrant && structuredClone(options.contextGrant),
        budget: options.budget && structuredClone(options.budget),
        capabilities: options.capabilities && structuredClone(options.capabilities) };
      options = { ...options, manifest: options.manifest && structuredClone(options.manifest),
        discover: options.discover && structuredClone(options.discover),
        capabilityChains: options.capabilityChains && structuredClone(options.capabilityChains) };
      const action = this.keyedAction(options);
      const result = unwrapIdempotency<SessionResult>(await this.keyedStore().run('acp_delegate_task', options.idempotencyKey!,
        action, async operation => ({ isError: false, value: await this.delegate({ ...options,
          idempotencyKey: undefined, idempotencyOperation: operation }, hooks) as unknown as Json })));
      if ((options.manifest ? options.manifest.contextGrant : options.contextGrant)?.deliveryMode === 'approval_redelegation' &&
          result.state === 'SETTLED') {
        const proposed = result.bundle.entries.find(e => e.body.eventType === 'PROPOSE')?.body.payload;
        const accepted = result.bundle.entries.find(e => e.body.eventType === 'ACCEPT')?.body.payload;
        const delivered = result.bundle.entries.find(e => e.body.eventType === 'DELIVER')?.body.payload as unknown as Delivery | undefined;
        if (!delivered || !verifyAudit(result.bundle).valid) throw new Error('DELEGATION_INVALID');
        verifyRecoveredDelegation(delivered, proposed, accepted);
        if (options.manifest && delivered.delegation && digest(delivered.delegation.parentContract.manifest) !== digest(options.manifest))
          throw new Error('DELEGATION_INVALID');
      }
      return result;
    }
    assertConnectionsOptions(this.options);
    // Retain the reviewed values even if the caller changes its objects while awaiting consent.
    if (options.beforePropose || managedChild ||
        (options.manifest ? options.manifest.contextGrant : options.contextGrant)?.deliveryMode === 'approval_redelegation') options = { ...options,
      input: structuredClone(options.input), manifest: options.manifest && structuredClone(options.manifest),
      contextGrant: options.contextGrant && structuredClone(options.contextGrant),
      budget: options.budget && structuredClone(options.budget),
      outputSchema: options.outputSchema && structuredClone(options.outputSchema),
      capabilities: options.capabilities && structuredClone(options.capabilities),
    };
    const timeoutOptions = resolveSessionTimeouts(this.options, options);
    validateSessionTimeouts(timeoutOptions);
    if (timeoutOptions.executionTimeoutMs !== undefined && timeoutOptions.executionTimeoutMs < 1000)
      throw new Error('INVALID_TIMEOUT: executionTimeoutMs must be at least 1000 (whole-second contract budget)');
    const onProgress = hooks?.onProgress ?? options.onProgress;
    const invite = isInviteTarget(options.to)
      ? parseAndVerifyInviteToken(options.to, Date.now(), {
          allowPrivateRelay: this.options.allowPrivateRelay,
        })
      : undefined;
    assertConnectionsOptions(options);
    if (options.workerRef && !invite) throw new Error('INVITE_REFERENCE_UNAVAILABLE');
    const relayOption = options.relay ?? this.options.relay ?? invite?.relayUrl;
    if (!relayOption) throw new Error('RELAY_REQUIRED');
    if (typeof relayOption === 'string')
      validateRelayEndpointUrl(relayOption, { allowPrivateRelay: this.options.allowPrivateRelay });
    else if ('url' in relayOption && typeof relayOption.url === 'string')
      validateRelayEndpointUrl(relayOption.url, {
        allowPrivateRelay: this.options.allowPrivateRelay,
      });
    const relay = transport(relayOption, this.options.owner, {
        allowPrivateRelay: this.options.allowPrivateRelay,
        lookup: this.options.lookup,
        requestTimeoutMs: timeoutOptions.connectTimeoutMs,
        maxAuthRecoveryAttempts: this.options.maxAuthRecoveryAttempts,
        authRecoveryTimeoutMs: this.options.authRecoveryTimeoutMs,
      }),
      owner = this.options.owner,
      inbox =
        typeof relayOption === 'string'
          ? recipientInbox(this.deliveryService ?? this, relay, owner.did, relayOption.replace(/\/$/, ''))
          : recipientInbox(this.deliveryService ?? relayOption, relay, owner.did, this.deliveryService ? options.pendingRelayUrl ?? this.options.pendingRelayUrl : undefined);
    const rawCards = !invite && relay.discover ? await relay.discover() : [];
    if (!Array.isArray(rawCards)) throw new Error('INVALID_AGENT_CARD');
    if (invite && options.discover) throw new Error('CONFLICTING_DISCOVERY_TARGET');
    const card = options.discover
      ? discoverAgentCards(rawCards, { ...options.discover,
          ...(options.to ? { did: options.to } : {}) })[0]
      : findDiscoveredAgentCard(rawCards, options.to);
    if (options.discover && !card) throw new Error('WORKER_NOT_FOUND');
    const advertisedPolicy = (invite?.agentCard ?? card)?.payload.autoAccept;
    const automationNotice = 'This worker responds automatically, not through a human. この相手は人ではなく自動で応じます。';
    const workerAutomation = advertisedPolicy?.enabled ? {
      notice: automationNotice,
      policy: advertisedPolicy,
    } : undefined;
    const peer = invite?.ownerDid ?? card?.payload.ownerDid ?? options.to;
    const protocolVersion = this.protocol.outbound(invite?.agentCard ?? card,
      options.renegotiateProtocol ? undefined : options.manifest?.protocolVersion, peer,
      invite?.agentDid ?? card?.payload.agentDid ?? peer);
    if (options.manifest && options.renegotiateProtocol) options = { ...options, manifest: { ...options.manifest, protocolVersion } };
    const manifest =
      options.manifest ??
      buildTaskManifest({
        ...options,
        protocolVersion,
        taskTimeoutMs: timeoutOptions.taskTimeoutMs ?? timeoutOptions.timeoutMs,
        budget: { ...options.budget, ...(timeoutOptions.executionTimeoutMs !== undefined
          ? { maxWallClockSeconds: options.budget?.maxWallClockSeconds ?? Math.floor(timeoutOptions.executionTimeoutMs / 1000) } : {}) },
        ownerDid: owner.did,
        workerDid: peer,
        agentDid: invite?.agentDid ?? card?.payload.agentDid ?? peer,
        skillId: options.discover?.skillId,
        taskType: options.discover?.taskType ?? (card?.payload.skills.length === 1 &&
          card.payload.skills[0].taskTypes?.length === 1 ? card.payload.skills[0].taskTypes[0] : undefined),
      });
    if (options.manifest && timeoutOptions.executionTimeoutMs !== undefined &&
        manifest.budget.maxWallClockSeconds * 1000 > timeoutOptions.executionTimeoutMs)
      throw new Error('INCOMPATIBLE_TIMEOUTS: manifest budget exceeds executionTimeoutMs');
    if (options.budget?.maxWallClockSeconds !== undefined && timeoutOptions.executionTimeoutMs !== undefined &&
        options.budget.maxWallClockSeconds * 1000 > timeoutOptions.executionTimeoutMs)
      throw new Error('INCOMPATIBLE_TIMEOUTS: requested budget exceeds executionTimeoutMs');
    validateManifest(manifest);
    validateContextGrantUse(manifest, options.input, (this.options.now ?? Date.now)());
    if (
      manifest.requester.ownerDid !== owner.did ||
      manifest.worker?.ownerDid !== peer ||
      Date.parse(manifest.deadline) <= Date.now()
    )
      throw new Error('INVALID_MANIFEST_PARTIES_OR_DEADLINE');
    if (options.minimumIsolationLevel) {
      manifest.sandboxPolicy = {
        ...manifest.sandboxPolicy,
        isolationLevel: options.minimumIsolationLevel,
      };
      if (requiresStrongIsolation(options.minimumIsolationLevel))
        manifest.verification = { ...manifest.verification, requireExecutionAttestation: true };
    }
    validateManifest(manifest);
    if (!validateOutput(manifest.io.inputSchema, options.input)) throw new Error('INPUT_SCHEMA');
    if (!this.deliveryService && typeof relayOption === 'string') {
      this.deliveryService = this.createDelivery();
      if (this.deliveryStarted) await this.deliveryService.start();
    }
    await this.deliveryService?.prepare(options.signal);
    this.deliveryService?.store.checkAvailable();
    const operation = options.idempotencyOperation, childIndex = options.idempotencyChildIndex ?? 0;
    const stableRelayUrl = typeof relayOption === 'string' ? relayOption : options.pendingRelayUrl ?? this.options.pendingRelayUrl;
    const approvalRelay = typeof relayOption === 'string' ? relayOption
      : 'url' in relayOption && typeof relayOption.url === 'string' ? relayOption.url : 'injected transport';
    const approvalTargetDigest = digest({ manifest, description: manifest.task.description, input: options.input,
      relay: approvalRelay, fanOut: operation?.children ?? 1 });
    if (operation) await operation.prepare({ childIndex, manifest, input: options.input, relayUrl: stableRelayUrl ?? approvalRelay,
      peerOwnerDid: peer, peerAgentDid: manifest.worker!.agentDid, approvalTargetDigest });
    const approvalMode = manifest.contextGrant?.deliveryMode === 'approval_redelegation';
    const proposalTarget = () => ({ type: 'ContextGrantProposal', manifestDigest: digest(manifest),
      inputDigest: digest(options.input), workerOwnerDid: peer });
    let contextProposalApproval: ApprovalReceipt | undefined;
    if (approvalMode) {
      requireOwnerDecision(this.approvalProvider);
      const target = proposalTarget(), started = Date.now();
      const approvalSignal = AbortSignal.any([
        AbortSignal.timeout(Math.max(1, Math.min(Date.parse(manifest.deadline) - Date.now(),
          timeoutOptions.waitTimeoutMs ?? timeoutOptions.taskTimeoutMs ?? timeoutOptions.timeoutMs ?? 600000))),
        ...(options.signal ? [options.signal] : []),
      ]);
      contextProposalApproval = await abortable(this.approvalProvider.approve({ taskId: manifest.taskId, gate: 'contract_acceptance',
        target: structuredClone(target), details: { manifest: structuredClone(manifest), input: structuredClone(options.input) },
        signal: approvalSignal, deadline: manifest.deadline }), approvalSignal);
      assertFreshDecision(contextProposalApproval, started);
      this.contextApprovals.require(manifest.taskId, 'contract_acceptance', target, contextProposalApproval);
      validateContextGrantUse(manifest, options.input, (this.options.now ?? Date.now)());
    }
    if (options.beforePropose) {
      const approvalSignal = AbortSignal.any([
        AbortSignal.timeout(Math.max(0, Date.parse(manifest.deadline) - Date.now())),
        ...(options.signal ? [options.signal] : []),
      ]);
      try {
        const evidence = await abortable(options.beforePropose({
          manifest: freezeApprovalAction(manifest), input: freezeApprovalAction(options.input),
          ...(workerAutomation ? { workerAutomation } : {}),
          relay: typeof relayOption === 'string' ? relayOption
            : 'url' in relayOption && typeof relayOption.url === 'string' ? relayOption.url : 'injected transport',
          signal: approvalSignal,
        }), approvalSignal);
        approvalSignal.throwIfAborted();
        await operation?.authorize(childIndex, evidence);
      } catch (error) {
        if (approvalSignal.aborted)
          throw new Error(options.signal?.aborted ? 'APPROVAL_ABORTED' : 'APPROVAL_TIMEOUT');
        throw error;
      }
      if (invite) parseAndVerifyInviteToken(options.to, Date.now(), {
        allowPrivateRelay: this.options.allowPrivateRelay,
      });
      if (Date.parse(manifest.deadline) <= Date.now()) throw new Error('APPROVAL_TIMEOUT');
    }
    if (operation && !options.beforePropose) await operation.authorize(childIndex, {
      targetDigest: approvalTargetDigest, approvedAt: (this.options.now ?? Date.now)(), policy: 'configured-auto',
    });
    if (managedChild) await managedChild.prepare(manifest, options.input, peer!);
    await operation?.sending();
    const wireDelivery: WireDelivery | undefined = this.deliveryService && stableRelayUrl ? {
      service: this.deliveryService, context: { messageId: '00000000-0000-4000-8000-000000000000',
        peerOwnerDid: peer, relayUrl: stableRelayUrl, deliveryDeadline: Date.parse(manifest.deadline),
        message: { taskId: manifest.taskId, peerAgentDid: manifest.worker!.agentDid,
          protocolVersion: manifest.protocolVersion as '0.1.0' | '0.2.0',
          ...(operation ? { operationId: operation.operationId } : {}) } },
    } : undefined;
    const auditPath = options.auditPath ?? this.options.auditPath;
    freshAudit(auditPath);
    const bridge = new AbortController();
    if (this.deliveryService && stableRelayUrl) inbox.setDelivery(this.deliveryService, stableRelayUrl, this.deliveryStarted || this.deliveryService.statusRouter.active);
    const mailbox = inbox.attach(manifest.taskId);
    const timeouts = new SessionTimeouts(timeoutOptions, manifest.deadline, bridge.signal);
    const signal = timeouts.signal;
    const wire = new SessionWire(
      mailboxRelay(relay, mailbox),
      owner,
      peer,
      manifest.taskId,
      [owner.did, peer],
      signal,
      auditPath,
      this.options.allowUnencryptedEnvelopes === true,
      false,
      wireDelivery,
      manifest.contextGrant,
    );
    if (onProgress) {
      wire.onProgress = async (progress, envelope) => {
        await onProgress(progress, {
          taskId: envelope.payload.taskId,
          seq: envelope.payload.seq,
          eventType: envelope.payload.eventType,
          senderDid: envelope.payload.senderDid,
          recipientDid: envelope.payload.recipientDid,
          payload: progress,
        });
      };
    }
    let verifiedReceipt: Omit<IncompleteDelegateReceipt, 'entries' | 'completionError'> | undefined;
    let gateway: OwnerGateway | undefined;
    let deferredCancel = false;
    let cancelStarted = false;
    const startCancel = () => {
      if (cancelStarted || !gateway) return;
      const state = gateway.machine.state;
      if (state !== 'ACCEPTED' && state !== 'IN_PROGRESS') return;
      cancelStarted = true;
      const transition = gateway.transition('CANCEL');
      void wire
        .cancelSession({
          reason: String(options.signal?.reason ?? 'cancelled'),
          cancelledBy: owner.did,
          transition,
        })
        .catch(() => undefined);
    };
    const onUserAbort = () => {
      if (wireDelivery) wireDelivery.service.closeMessage(wireDelivery.context.messageId, 'CANCELLED');
      const state = gateway?.machine.state;
      if (state === 'IN_PROGRESS') startCancel();
      else if (state === 'ACCEPTED') deferredCancel = true;
      else bridge.abort(options.signal?.reason);
    };
    options.signal?.addEventListener('abort', onUserAbort);
    if (options.signal?.aborted) onUserAbort();
    try {
      const capabilityChains =
        options.capabilityChains ??
        manifest.permissions.grantedCapabilities.map((g) => {
          const root = createCapability(
            {
              audience: owner.did,
              taskId: manifest.taskId,
              resource: g.resource,
              allowedTools: g.allowedTools,
              argConstraints: Object.fromEntries(
                g.allowedTools.map((t) => [t, g.argConstraints ?? { type: 'object' }]),
              ),
              maxCalls: g.maxInvocations,
              notBefore: manifest.createdAt,
              expiresAt: g.expiresAt,
              maxDepth: 1,
            },
            owner,
          );
          const leaf = createCapability(
            { ...root.payload, audience: peer, maxDepth: 0 },
            owner,
            root,
          );
          return [root, leaf];
        });
      let connectionRequest: SignedEnvelope | undefined;
      let connectionRouter: ConnectionRouter | undefined;
      if (this.options.connectionReview && protocolVersion === '0.2.0') {
        const relayUrl = invite?.relayUrl ?? card?.payload.relayEndpoint ?? this.options.pendingRelayUrl;
        if (!relayUrl) throw new Error('RELAY_REQUIRED');
        const store = this.options.connectionStore ?? new WorkerTrustStore(owner, { path: this.options.identityOptions
          ? workerIntakePath(owner.did, this.options.identityOptions) : undefined, now: this.options.now });
        if (store.ownerDid !== owner.did) throw new Error('CONNECTION_OWNER_MISMATCH');
        if (store.connectionState(peer) !== 'connected') {
          connectionRouter = new ConnectionRouter({ owner, relay, relayUrl, store,
            agentCard: createSignedAgentCard({ name: 'Sealbridge requester', agentDid: owner.did,
              relayEndpoint: relayUrl, skills: [], protocolVersions: this.protocol.receiveVersions() }, owner),
            review: new HeldRequestReview(owner, { ...this.options.identityOptions, now: this.options.now }),
            humanReview: this.options.connectionReview, now: this.options.now, allowPrivateRelay: this.options.allowPrivateRelay,
            onConnectionEvent: this.options.onConnectionEvent });
          try {
            const request = await connectionRouter.service.request({ toOwnerDid: peer,
              ...(invite ? { inviteToken: options.to } : card ? { peerAgentCard: card } : {}), originProposalDigest: digest({ manifest, input: options.input }), deferDelivery: true });
            connectionRequest = store.controlSnapshot().find(r => r.offer.requestId === request.requestId)?.outbox[0]?.envelope;
          } catch (error) { if (!(error instanceof Error) || error.message !== 'APPROVAL_REJECTED') throw error; }
        }
      }
      if (connectionRouter) inbox.setConnections(connectionRouter);
      // Recheck the live phase immediately before transmission; owner review may cross a boundary.
      this.protocol.outbound(invite?.agentCard ?? card, manifest.protocolVersion, peer, manifest.worker!.agentDid);
      options.beforeTransmit?.();
      validateContextGrantUse(manifest, options.input, (this.options.now ?? Date.now)());
      if (approvalMode && !verifyApproval(contextProposalApproval!, owner.did, manifest.taskId, 'contract_acceptance', proposalTarget()))
        throw new Error('DELEGATION_APPROVAL_REQUIRED');
      if (approvalMode || managedChild) {
        options.signal?.throwIfAborted();
        if (Date.parse(manifest.deadline) <= Date.now()) throw new Error('DELEGATION_INVALID');
        if (invite) parseAndVerifyInviteToken(options.to, Date.now(), { allowPrivateRelay: this.options.allowPrivateRelay });
      }
      managedChild?.beforeTransmit(manifest, options.input);
      await wire.sendEvent('PROPOSE', {
        proposal: signPayload(manifest, owner),
        input: options.input,
        capabilityChains,
        peerIdleTimeoutMs: timeoutOptions.transportIdleTimeoutMs ?? 90_000,
        ...(invite ? { inviteToken: options.to } : {}),
        ...(connectionRequest ? { connectionRequest } : {}),
      });
      const accept = (await wire.receiveEvent('ACCEPT')).payload.payload as unknown as {
        contract: TaskContract;
        transition: Signed<Transition>;
        approval: import('@acp/core').ApprovalReceipt;
      };
      if (
        !verifyContract(accept.contract) ||
        digest(accept.contract.manifest) !== digest(manifest) ||
        !verifyApproval(
          accept.approval,
          peer,
          manifest.taskId,
          'contract_acceptance',
          accept.contract.contractDigest,
        )
      )
        throw new Error('INVALID_ACCEPTANCE');
      const responseAutomation = accept.approval.payload.authorization ? {
        notice: automationNotice, authorization: accept.approval.payload.authorization,
        ...(advertisedPolicy && digest(advertisedPolicy) === accept.approval.payload.authorization.ruleDigest
          ? { policy: advertisedPolicy } : {}),
      } : workerAutomation;
      validateContextGrantUse(manifest, options.input, (this.options.now ?? Date.now)());
      managedChild?.onAcceptedContract(accept.contract);
      gateway = new OwnerGateway(owner, accept.contract, policy);
      gateway.machine.apply(accept.transition);
      gateway.machine.apply(
        (await wire.receiveEvent('START')).payload.payload as unknown as Signed<Transition>,
      );
      if (options.signal?.aborted || deferredCancel) startCancel();
      timeouts.executing(timeoutOptions.executionTimeoutMs ?? manifest.budget.maxWallClockSeconds * 1000);
      wire.onActivity = () => timeouts.activity();
      const envelope = await wire.receiveEvent('DELIVER'),
        data = envelope.payload.payload as unknown as Delivery & { transition: Signed<Transition> };
      wire.onActivity = undefined;
      timeouts.wait();
      gateway.machine.apply(data.transition);
      hooks?.onDelivered?.();
      const approval = () => {
        if (approvalMode || managedChild) requireOwnerDecision(this.approvalProvider);
        const lineage = approvalMode ? verifyDelegationAttachment(data.delegation, accept.contract) : undefined;
        const started = approvalMode || managedChild ? Date.now() : 0;
        const pendingApproval = this.approvalProvider.approve({
          taskId: manifest.taskId,
          gate: 'final_verification',
          target: data,
          details: { manifest, deliverableDigest: data.artifact.payload.digest,
            ...(responseAutomation ? { workerAutomation: responseAutomation } : {}),
            ...(approvalMode ? { delegateeOwnerDids: lineage!.delegateeOwnerDids,
              delegationDigests: data.delegation!.children.map(p => ({ linkDigest: digest(p.link),
                contractDigest: p.childContract.contractDigest, grantDigest: digest(p.childContract.manifest.contextGrant!) })) } : {}) },
          deadline: manifest.deadline,
          signal,
        });
        if (!approvalMode && !managedChild) return pendingApproval;
        return pendingApproval.then(receipt => {
          assertFreshDecision(receipt, started);
          if (Date.parse(manifest.deadline) <= Date.now()) throw new Error('DELEGATION_INVALID');
          return receipt;
        });
      };
      const { result, verification, settlement } = await abortable(gateway.verifyAndSettle(
        wire.sealed(envelope),
        this.options.verificationEngine ?? new VerificationEngine(),
        approval,
        { ...(approvalMode ? { ownerDecision: this.approvalProvider.ownerDecision } : {}), allowUnencryptedEnvelopes: this.options.allowUnencryptedEnvelopes === true, onVerifiedDelivery: () => {
          if (!wireDelivery) return;
          wireDelivery.service.markPeerObserved(wireDelivery.context.messageId, { status: 'replied', envelopeId: wireDelivery.context.messageId,
            replyEnvelopeId: receiptFileId(envelope.payload.envelopeId) });
        } },
      ), signal);
      if (!result.accepted || !settlement) {
        await wire.sendEvent('VERIFY_REJECT', verification);
        throw new Error('VERIFICATION_REJECTED: ' + result.reason);
      }
      verifiedReceipt = {
        workerDid: manifest.worker!.agentDid,
        taskId: manifest.taskId,
        outputDigest: digest(data.artifact.payload.data),
        deliverable: data.artifact.payload.data,
        accepted: true,
        checkpointComplete: false,
        delivery: wire.sealed(envelope),
        verification: result,
      };
      await wire.sendEvent('VERIFY_ACCEPT', verification);
      await wire.sendEvent('SETTLED', settlement);
      return {
        taskId: manifest.taskId,
        state: 'SETTLED',
        deliverable: data.artifact.payload.data,
        bundle: await wire.finishRequester(),
        verification: result,
      };
    } catch (e) {
      if (e instanceof PeerRejectedError && wireDelivery) {
        if (e.code === 'PENDING_OWNER_APPROVAL') wireDelivery.service.markPeerObserved(wireDelivery.context.messageId,
          { status: 'received_held', envelopeId: wireDelivery.context.messageId });
        wireDelivery.service.closeMessage(wireDelivery.context.messageId, e.code ?? 'PEER_REJECTED');
      }
      if (e instanceof PeerRejectedError && e.code === 'PENDING_OWNER_APPROVAL' && this.options.pendingStore) {
        let pendingId = options.pendingId, pendingStoreError: string | undefined;
        if (!pendingId) {
          try {
            pendingId = this.options.pendingStore.save({ ...(options.workerRef
              ? { workerRef: options.workerRef } : { to: invite ? options.to : peer }),
              relayUrl: typeof relayOption === 'string' ? relayOption : options.pendingRelayUrl ?? this.options.pendingRelayUrl ??
                ('url' in relayOption && typeof relayOption.url === 'string' ? relayOption.url : undefined),
              manifest, input: options.input, timeouts: timeoutOptions });
          } catch (error) { pendingStoreError = pendingErrorCode(error); }
        }
        Object.assign(e, { pendingId, pendingStoreError, originalTaskId: manifest.taskId, nextStep: PENDING_NEXT_STEP });
      }
      try {
        if (e instanceof PeerRejectedError && e.recovery) {
          if (e.recovery.proposalDigest !== digest({ manifest, input: options.input }))
            throw new Error('INVALID_RECOVERY_OUTCOME');
          const cached = e.recovery.result;
          if (cached) {
            const proposed = cached.bundle?.entries?.find((entry) => entry.body.eventType === 'PROPOSE')
              ?.body.payload as unknown as Proposal | undefined;
            const accepted = cached.bundle?.entries?.find((entry) => entry.body.eventType === 'ACCEPT')
              ?.body.payload as unknown as { contract: TaskContract } | undefined;
            const delivered = cached.bundle?.entries?.find((entry) => entry.body.eventType === 'DELIVER')
              ?.body.payload as unknown as Delivery | undefined;
            if (cached.taskId !== manifest.taskId || !['SETTLED', 'CANCELLED'].includes(cached.state) ||
                !verifyAudit(cached.bundle, { taskId: manifest.taskId, actors: [owner.did, peer] }).valid ||
                proposalAuditDigest(proposed) !== e.recovery.proposalDigest ||
                !(manifest.contextGrant ? verifyContextAcceptanceAudit(accepted, manifest) :
                  accepted && verifyContract(accepted.contract) && digest(accepted.contract.manifest) === digest(manifest)) ||
                (cached.state === 'CANCELLED' && (e.code !== 'TASK_CANCELLED' || cached.deliverable !== null ||
                  cached.bundle.entries.at(-1)?.body.eventType !== 'CANCEL')) ||
                (cached.state === 'SETTLED' && (!delivered ||
                  e.code !== 'TASK_SETTLED' ||
                  digest(delivered.artifact.payload.data) !== digest(cached.deliverable) ||
                  cached.bundle.entries.at(-1)?.body.eventType !== 'SETTLED')))
              throw new Error('INVALID_RECOVERY_OUTCOME');
            if (cached.state === 'SETTLED') {
              if (manifest.contextGrant) {
                verifyRecoveredDelegation(delivered!, proposed, accepted);
                if (delivered?.delegation && digest(delivered.delegation.parentContract.manifest) !== digest(manifest))
                  throw new Error('INVALID_RECOVERY_OUTCOME');
              }
              hooks?.onDelivered?.();
            }
            return cached;
          }
        }
        if (!wire.hasCommittedSend || e instanceof PeerRejectedError || verifiedReceipt) throw e;
        // A closed recipient inbox is terminal for every attached task. Do not wait
        // for another relay send (or cancellation handshake) on the failed connection.
        if (e instanceof Error && 'code' in e && ['RELAY_TERMINAL', 'RELAY_AUTH_RECOVERY_EXHAUSTED', 'RELAY_ENVELOPE_EXPIRED'].includes(String(e.code))) throw e;
        if (cancelStarted) {
          try {
            await wire.cancelSession();
            const bundle = await wire.finishRequester();
            throw Object.assign(new Error('CANCELLED'), { bundle });
          } catch (inner) {
            if (inner instanceof Error && inner.message === 'CANCELLED') throw inner;
            await wire.rawSend('ERROR', { code: safeError(inner, !!manifest.contextGrant) }).catch(() => {});
            throw inner;
          }
        }
        await wire.rawSend('ERROR', { code: safeError(e, !!manifest.contextGrant) }).catch(() => {});
        throw e;
      } catch (error) {
        if (!verifiedReceipt) throw error;
        throw new IncompleteSettlementError({
          ...verifiedReceipt,
          entries: wire.entries.slice(),
          completionError: error instanceof Error ? error.message : String(error),
        }, error);
      }
    } finally {
      timeouts.close();
      wire.close();
      options.signal?.removeEventListener('abort', onUserAbort);
      inbox.detach(manifest.taskId);
      gateway?.close();
    }
  }
  async delegateMulti(options: DelegateMultiOptions): Promise<DelegateMultiResult> {
    if (options.idempotencyKey !== undefined && !options.idempotencyOperation) {
      validateIdempotencyKey(options.idempotencyKey);
      options = { ...options, input: structuredClone(options.input),
        outputSchema: options.outputSchema && structuredClone(options.outputSchema),
        contextGrant: options.contextGrant && structuredClone(options.contextGrant),
        budget: options.budget && structuredClone(options.budget),
        capabilities: options.capabilities && structuredClone(options.capabilities) };
      options = { ...options, workers: structuredClone(options.workers) };
      const action = this.keyedAction(options);
      return unwrapIdempotency<DelegateMultiResult>(await this.keyedStore().run('acp_delegate_multi', options.idempotencyKey!,
        action, async operation => ({ isError: false, value: await this.delegateMulti({ ...options,
          idempotencyKey: undefined, idempotencyOperation: operation }) as unknown as Json }), { children: options.workers.length }));
    }
    if (!Array.isArray(options.workers) || options.workers.length === 0)
      throw new Error('WORKERS_REQUIRED');
    if (options.mode !== 'race' && options.mode !== 'quorum')
      throw new Error('INVALID_DELEGATION_MODE');
    const completionTimeoutMs = options.completionTimeoutMs ?? 45_000;
    assertPositive('COMPLETION_TIMEOUT', completionTimeoutMs);
    if (completionTimeoutMs > 2_147_483_647) throw new Error('INVALID_COMPLETION_TIMEOUT');
    const count = options.workers.length;
    const quorumSize = options.quorumSize ?? Math.floor(count / 2) + 1;
    if (
      options.mode === 'quorum' &&
      (!Number.isInteger(quorumSize) || quorumSize < 1 || quorumSize > count)
    )
      throw new Error('INVALID_QUORUM_SIZE');
    const resolved = options.workers.map((worker) =>
      resolveWorkerTarget(worker, this.options.allowPrivateRelay),
    );
    await canonicalizeDiscoveredWorkers(resolved, {
      relay: this.options.relay,
      owner: this.options.owner,
      allowPrivateRelay: this.options.allowPrivateRelay,
      lookup: this.options.lookup,
    });
    const seenWorkers = new Set<string>();
    for (const worker of resolved) {
      if (seenWorkers.has(worker.workerDid)) throw new Error('DUPLICATE_WORKER_TARGET');
      seenWorkers.add(worker.workerDid);
    }
    const controllers = options.workers.map(() => new AbortController());
    const finished = options.workers.map(() => false);
    const delivered = options.workers.map(() => false);
    const completionTimers: Array<ReturnType<typeof setTimeout> | undefined> = [];
    const receipts: DelegateReceipt[] = [];
    const incompleteReceipts: IncompleteDelegateReceipt[] = [];
    let failures = 0;
    const approvalFailures: Error[] = [];
    const allApprovalFailed = () => approvalFailures.length === count ? approvalFailures[0] : undefined;
    let winnerDigest: string | undefined;
    const abortUnfinished = (reason: string) => {
      controllers.forEach((controller, index) => {
        if (finished[index]) return;
        if (!delivered[index]) controller.abort(reason);
        else if (!completionTimers[index]) {
          // DELIVER has left execution: preserve verification and bilateral checkpointing.
          completionTimers[index] = setTimeout(() => controller.abort(new Error('COMPLETION_TIMEOUT')),
            completionTimeoutMs);
          completionTimers[index]!.unref();
        }
      });
    };
    const jobs = resolved.map(async (worker, index) => {
      const signal = options.signal
        ? AbortSignal.any([options.signal, controllers[index].signal])
        : controllers[index].signal;
      try {
        const result = await this.delegate({
          to: worker.inviteToken ?? worker.workerDid,
          relay: worker.relayUrl ?? this.options.relay,
          title: options.title,
          description: options.description,
          input: options.input,
          outputSchema: options.outputSchema,
          contextGrant: options.contextGrant,
          executionTimeoutMs: options.executionTimeoutMs,
          timeoutMs: options.timeoutMs,
          taskTimeoutMs: options.taskTimeoutMs,
          waitTimeoutMs: options.waitTimeoutMs,
          connectTimeoutMs: options.connectTimeoutMs,
          transportIdleTimeoutMs: options.transportIdleTimeoutMs,
          heartbeatIntervalMs: options.heartbeatIntervalMs,
          budget: options.budget,
          capabilities: options.capabilities,
          minimumIsolationLevel: options.minimumIsolationLevel,
          signal,
          onProgress: options.onProgress,
          beforePropose: options.beforePropose,
          idempotencyOperation: options.idempotencyOperation,
          idempotencyChildIndex: index,
          auditPath: options.auditPath
            ? options.auditPath.replace(/(\.jsonl)?$/, '.' + index + '.jsonl')
            : undefined,
        }, { onDelivered: () => { delivered[index] = true; } });
        finished[index] = true;
        // SETTLED always carries a verified deliverable, including JSON null.
        if (result.state !== 'SETTLED') throw new Error('VERIFICATION_REJECTED');
        const workerDid = verifiedWorkerDid(result.bundle, worker.workerDid);
        const outputDigest = digest(result.deliverable);
        receipts.push({
          workerDid,
          taskId: result.taskId,
          outputDigest,
          deliverable: result.deliverable,
          bundle: result.bundle,
          accepted: true,
        });
        if (options.mode === 'quorum' && !winnerDigest) {
          const distinct = new Set(
            receipts
              .filter((receipt) => receipt.outputDigest === outputDigest)
              .map((receipt) => receipt.workerDid),
          );
          if (distinct.size >= quorumSize) {
            winnerDigest = outputDigest;
            abortUnfinished('QUORUM_REACHED');
          }
        }
        return { index, result, outputDigest, workerDid };
      } catch (error) {
        if (error instanceof IncompleteSettlementError)
          incompleteReceipts.push(error.incompleteReceipt);
        await options.idempotencyOperation?.childReady(index, error);
        if ((options.beforePropose || options.idempotencyOperation) && error instanceof Error &&
            /^(APPROVAL_|IDEMPOTENCY_)/.test(error.message))
          approvalFailures.push(error);
        finished[index] = true;
        failures += 1;
        if (options.mode === 'quorum' && !winnerDigest && failures > count - quorumSize)
          abortUnfinished('QUORUM_UNREACHABLE');
        throw error;
      } finally {
        clearTimeout(completionTimers[index]);
      }
    });
    if (options.mode === 'race') {
      let winner: { index: number; result: SessionResult; outputDigest: string; workerDid: string };
      try {
        winner = await Promise.any(jobs);
      } catch {
        throw Object.assign(allApprovalFailed() ?? new Error('RACE_FAILED'), { receipts, incompleteReceipts });
      }
      abortUnfinished('RACE_LOST');
      await Promise.allSettled(jobs);
      const outputDigest = winner.outputDigest;
      return {
        mode: 'race',
        status: 'SETTLED',
        deliverable: winner.result.deliverable as Json,
        outputDigest,
        taskIds: receipts.map((receipt) => receipt.taskId),
        winners: [
          {
            workerDid: winner.workerDid,
            taskId: winner.result.taskId,
            outputDigest,
          },
        ],
        receipts,
        incompleteReceipts,
        cancelled: resolved
          .filter((_, index) => index !== winner.index && controllers[index].signal.aborted && !delivered[index])
          .map((worker) => worker.workerDid),
      };
    }
    await Promise.allSettled(jobs);
    if (!winnerDigest) throw Object.assign(allApprovalFailed() ?? new Error('QUORUM_NOT_REACHED'), { receipts, incompleteReceipts });
    const seenWinners = new Set<string>();
    const winners = receipts.filter((receipt) => {
      if (receipt.outputDigest !== winnerDigest || seenWinners.has(receipt.workerDid)) return false;
      seenWinners.add(receipt.workerDid);
      return true;
    });
    return {
      mode: 'quorum',
      status: 'SETTLED',
      deliverable: winners[0].deliverable,
      outputDigest: winnerDigest,
      taskIds: receipts.map((receipt) => receipt.taskId),
      winners: winners.map((receipt) => ({
        workerDid: receipt.workerDid,
        taskId: receipt.taskId,
        outputDigest: receipt.outputDigest,
      })),
      receipts,
      incompleteReceipts,
      cancelled: resolved
        .filter((_, index) => controllers[index].signal.aborted && !delivered[index])
        .map((worker) => worker.workerDid),
    };
  }
}
function canonicalInviteToken(token: string | Signed<Invite>): string {
  if (typeof token === 'string') return token;
  return 'acp-invite:' + Buffer.from(JSON.stringify(token)).toString('base64url');
}
function resolveWorkerTarget(
  target: DelegateWorkerTarget,
  allowPrivateRelay?: boolean,
): DelegateWorkerTarget & { inviteToken?: string } {
  let workerDid = target.workerDid;
  let inviteToken: string | undefined;
  if (target.inviteToken !== undefined && target.inviteToken !== '') {
    inviteToken = canonicalInviteToken(target.inviteToken);
    const invite = parseAndVerifyInviteToken(inviteToken, Date.now(), { allowPrivateRelay });
    const verified = invite.agentCard.payload.agentDid;
    if (verified !== invite.agentDid) throw new Error('WORKER_DID_MISMATCH');
    if (workerDid && workerDid !== verified) throw new Error('WORKER_DID_MISMATCH');
    workerDid = verified;
  } else {
    if (typeof workerDid !== 'string' || workerDid.length === 0) throw new Error('INVALID_DID');
    resolveDid(workerDid);
  }
  return { workerDid, inviteToken, relayUrl: target.relayUrl };
}
function verifiedWorkerDid(bundle: AuditBundle, expectedDid: string): string {
  if (!verifyAudit(bundle).valid) throw new Error('VERIFICATION_REJECTED');
  const accept = bundle.entries.find((entry) => entry.body.eventType === 'ACCEPT');
  const payload = accept?.body.payload;
  const worker =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as { contract?: { manifest?: TaskManifest }; worker?: TaskManifest['worker'] }).contract?.manifest?.worker ??
        (payload as { worker?: TaskManifest['worker'] }).worker
      : undefined;
  const actors = bundle.checkpoint.actor.payload.actors;
  if (
    !worker ||
    (worker.agentDid !== expectedDid && worker.ownerDid !== expectedDid) ||
    !actors.includes(worker.ownerDid) ||
    !verifySigned(bundle.checkpoint.actor, actors[0])
  )
    throw new Error('WORKER_DID_MISMATCH');
  // Receipts and quorum use the card's agentDid, even when the caller addressed the owner DID.
  return worker.agentDid;
}
async function canonicalizeDiscoveredWorkers(
  targets: Array<{ workerDid: string; inviteToken?: string; relayUrl?: string }>,
  options: {
    relay?: RelayTransport | string;
    owner: KeyPair;
    allowPrivateRelay?: boolean;
    lookup?: RelayClientSecurityOptions['lookup'];
  },
): Promise<void> {
  const pending = targets.filter((target) => !target.inviteToken);
  if (pending.length === 0) return;
  const relays = new Map<RelayTransport | string, typeof pending>();
  for (const target of pending) {
    const relay = target.relayUrl ?? options.relay;
    if (!relay) continue;
    const group = relays.get(relay) ?? [];
    group.push(target);
    relays.set(relay, group);
  }
  await Promise.all(
    [...relays.entries()].map(async ([relayOption, group]) => {
      try {
        const relay = transport(relayOption, options.owner, {
          allowPrivateRelay: options.allowPrivateRelay,
          lookup: options.lookup,
        });
        if (!relay.discover) return;
        const cards = await relay.discover();
        if (!Array.isArray(cards)) return;
        const now = Date.now();
        for (const target of group) {
          const card = findDiscoveredAgentCard(cards, target.workerDid, now);
          if (card) target.workerDid = card.payload.agentDid;
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'AMBIGUOUS_AGENT_CARD_OWNER') throw error;
        // Discovery only collapses aliases. Settlement still checks the signed manifest.
      }
    }),
  );
}
export function buildTaskManifest(options: {
  contextGrant?: ContextGrantOptions;
  ownerDid: string;
  workerDid: string;
  agentDid?: string;
  skillId?: string;
  taskType?: string;
  title: string;
  description: string;
  outputSchema?: Schema;
  budget?: Partial<BudgetSpec>;
  protocolVersion?: import('@acp/core').ManifestProtocolVersion;
  now?: () => number;
  taskTimeoutMs?: number;
  capabilities?: TaskManifest['permissions']['grantedCapabilities'];
}): TaskManifest {
  const now = (options.now ?? Date.now)();
  const createdAt = new Date(now).toISOString(),
    deadline = new Date(now + (options.taskTimeoutMs ?? 600000)).toISOString();
  const manifest: TaskManifest = {
    protocolVersion: options.protocolVersion ?? '0.2.0',
    taskId: 'task_' + randomUUID().replaceAll('-', ''),
    createdAt,
    deadline,
    requester: { ownerDid: options.ownerDid, agentDid: options.ownerDid },
    worker: { ownerDid: options.workerDid, agentDid: options.agentDid ?? options.workerDid },
    task: {
      ...(options.skillId ? { skillId: options.skillId } : {}),
      ...(options.taskType ? { taskType: options.taskType } : {}),
      title: options.title,
      description: options.description,
      acceptanceCriteria: [
        { id: 'ac_schema', description: 'Output satisfies the agreed JSON schema', required: true },
      ],
    },
    io: { inputSchema: {}, outputSchema: options.outputSchema ?? {} },
    verification: {
      mode: 'hybrid',
      requireUsageReceipt: true,
      requireExecutionAttestation: true,
      maxRetries: 0,
    },
    budget: {
      costBearer: 'worker_byok',
      maxInputTokens: 50000,
      maxOutputTokens: 10000,
      maxToolInvocations: 10,
      maxWallClockSeconds: 60,
      onOverrun: 'hard_stop',
      ...options.budget,
    },
    permissions: { maxDelegationDepth: 0, grantedCapabilities: options.capabilities ?? [] },
    sandboxPolicy: {
      isolationLevel: 'subprocess_restricted',
      networkAccess: 'none',
      filesystemScope: 'ephemeral_workspace_only',
    },
    hitlPolicy: { requiredGates: ['GATE_CONTRACT_ACCEPT', 'GATE_DELIVERY_ACCEPT'] },
  };
  if (options.contextGrant) {
    manifest.contextGrant = buildContextGrant(options.contextGrant, createdAt);
    if (manifest.contextGrant.deliveryMode === 'approval_redelegation') {
      manifest.permissions.maxDelegationDepth = 1;
      manifest.hitlPolicy.requiredGates.push('GATE_SUB_DELEGATION');
    }
    validateManifest(manifest);
  }
  return manifest;
}
