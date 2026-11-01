// SPDX-License-Identifier: Apache-2.0
import { PENDING_NEXT_STEP, pendingErrorCode } from './requester-pending-store.js';
import type { RequesterPendingStore } from './requester-pending-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { consumeDailyTask } from './daily-limit.js';
import {
  existsSync, openSync, closeSync, fstatSync, fchmodSync, appendFileSync, constants, fsyncSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  createContract,
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
  OPEN_POLICY_FIELDS,
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
  OpenPolicy,
  RevocationList,
  Invite,
  SignedRevocationNotice,
} from '@acp/core';
import { parseJsonl, verifyAudit, type AuditBundle, type AuditEntry } from '@acp/ledger';
import type { SandboxBoundaryMetadata } from '@acp/sandbox';
import { HttpRelayClient, waitForRelayRetry, relayDiagnostic, relayDeadline, validateRelayAuthRecoveryOptions } from '@acp/relay';
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
import { WorkerTrustStore, PENDING_MESSAGE } from './worker-trust-store.js';
import type { WorkerIntakeStore } from './worker-trust-store.js';
import { TaskJournal } from './task-journal.js';
import type { TaskCheckpoint, TaskOutcome } from './task-journal.js';
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
    allowAnyRequester: options.allowAnyRequester,
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
  constructor(
    private readonly relay: RelayTransport,
    private readonly did: string,
  ) {}
  hasTask(taskId: string): boolean {
    return this.mailboxes.has(taskId);
  }
  deliverFromPeerRole(envelope: SignedEnvelope): boolean {
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
      if (this.mailboxes.size === 0) {
        await new Promise<void>((resolve) => {
          if (this.mailboxes.size > 0) {
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
        const envelope = await receiveRelay(this.relay, this.did, controller.signal, {
          role: 'requester',
        });
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
export interface WorkerNodeOptions extends WorkerAcceptancePolicy, SessionTimeoutOptions, RelayAuthRecoveryOptions {
  intakeStore?: WorkerIntakeStore;
  /** Hard owner-DID perimeter. An explicit empty array denies all peers. */
  allowedPeerDids?: readonly string[];
  /** Label custom LLM adapters explicitly. Built-in LLM IDs are also recognized. */
  adapterKind?: 'llm' | 'non-llm';
  automaticApproval?: boolean;
  /** Separate human decision channel for limited peers; never the automatic provider. */
  ownerApprovalProvider?: ApprovalProvider;
  /** Reread host contact decisions at admission, execution and each outbound frame. */
  checkPeer?: (did: string) => 'trusted' | void;
  /** Startup invite and signed card lifetime in seconds. Default 86400 (24 hours). */
  inviteTtlSeconds?: number;
  /** Shared host state, independent of requester and worker identity. */
  dailyLimit?: { path: string; maxTasks: number };
  /** Explicit admission policy. Defaults to invite-only. */
  accessMode?: 'invite-only' | 'open';
  openPolicy?: OpenPolicy;
  owner: KeyPair;
  relay: RelayTransport | string;
  relayUrl?: string;
  adapter: AgentAdapter;
  name?: string;
  agentDid?: string;
  /** Controls agentDid when it is not owner.did. Required to sign the delegation. */
  agentKey?: KeyPair;
  approvalProvider?: ApprovalProvider;
  /** Bilateral audit path; enables adjacent task checkpoints when inboxPath is absent. */
  auditPath?: string;
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
  readonly relay: RelayTransport;
  readonly agentCard: SignedAgentCard;
  readonly approvalProvider: ApprovalProvider;
  readonly acceptance: WorkerAcceptancePolicy;
  readonly intakeStore: WorkerIntakeStore;
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
    validateRelayAuthRecoveryOptions(options);
    validateSessionTimeouts(options);
    this.intakeStore = options.intakeStore ?? new WorkerTrustStore(options.owner);
    if (options.inviteTtlSeconds !== undefined && (!Number.isSafeInteger(options.inviteTtlSeconds) ||
        options.inviteTtlSeconds < 1 || options.inviteTtlSeconds > 2592000))
      throw new Error('INVALID_INVITE_TTL');
    const persistencePath = options.inboxPath ?? options.auditPath;
    if (persistencePath) this.taskJournal = new TaskJournal(persistencePath + '.tasks.jsonl', options.owner);
    if (options.dailyLimit && (!options.dailyLimit.path || !Number.isSafeInteger(options.dailyLimit.maxTasks) || options.dailyLimit.maxTasks < 1))
      throw new Error('INVALID_DAILY_LIMIT');
    if (options.accessMode !== undefined && !['invite-only', 'open'].includes(options.accessMode))
      throw new Error('INVALID_ACCESS_MODE');
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
    this.approvalProvider =
      options.approvalProvider ?? new InteractiveCliApprovalProvider(options.owner);
    const agentDid = options.agentDid ?? options.agentKey?.did ?? options.owner.did;
    this.agentCard = createSignedAgentCard(
      {
        name: options.name ?? options.adapter.name,
        agentDid,
        relayEndpoint:
          typeof options.relay === 'string'
            ? options.relay
            : (options.relayUrl ?? 'http://in-memory.invalid'),
        skills: options.adapter.skills,
        ...(options.inviteTtlSeconds !== undefined ? {
          expiresAt: new Date(Date.now() + options.inviteTtlSeconds * 1000).toISOString(),
        } : {}),
        ...(options.accessMode ? { accessMode: options.accessMode } : {}),
        ...(options.openPolicy !== undefined ? { openPolicy: options.openPolicy } : {}),
      },
      options.owner,
      agentDid === options.owner.did ? undefined : options.agentKey,
    );
  }
  invite(expiresInSeconds = this.options.inviteTtlSeconds ?? 86400): string {
    return createInviteToken({ agentCard: this.agentCard, expiresInSeconds }, this.options.owner);
  }
  async register(): Promise<void> {
    await this.relay.register?.(this.agentCard);
  }
  stop(): void {
    this.controller.abort('WORKER_STOPPED');
    this.listenerStatus('stopped');
  }
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
  private status?: RelayConnectionStatus;
  private listenerStatus(status: RelayConnectionStatus, error?: Error): void {
    if (this.status === status && !error) return;
    this.status = status;
    this.options.onStatus?.(status, error);
  }
  private listen(signal: AbortSignal): Promise<SignedEnvelope> {
    return receiveRelay(this.relay, this.options.owner.did, signal, { role: 'worker' },
      (status) => this.listenerStatus(status === 'connected' ? this.relay.connectionStatus ?? status : status))
      .catch((error: unknown) => { if (signal.aborted) throw error; throw relayDiagnostic(error); });
  }
  async start(
    options: { once?: boolean; signal?: AbortSignal } = {},
  ): Promise<SessionResult | undefined> {
    // Register first so immediate discovery can resolve owner and agent aliases.
    if (this.publishes()) await this.register();
    await this.reconcileTasks();
    const idleSignal = AbortSignal.any([
      this.controller.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    const jobs = new Set<Promise<void>>();
    const unregister = registerWorkerListener(this.options.owner.did, (env) => {
      this.forwardedQueue.push(env);
      this.forwardedWaiters.shift()?.();
      return true;
    });
    try {
      while (!idleSignal.aborted) {
        // revocationAwareRelay ingests a leading REVOKE before this read returns.
        const envelope = await this.listen(idleSignal);
        if (await this.recoverProposal(envelope)) {
          if (options.once) return this.lastResult;
          continue;
        }
        if (this.deliver(envelope)) continue;
        const job = this.beginTask(envelope, idleSignal, options.once === true);
        if (!job) continue;
        jobs.add(job);
        void job.finally(() => jobs.delete(job)).catch(() => undefined);
        if (options.once) {
          await this.pumpUntil(job, idleSignal);
          return this.lastResult;
        }
      }
    } catch (error) {
      if (!idleSignal.aborted) {
        // A rejected one-shot task may be followed by another start on this node.
        // Only a terminal listener failure shuts down the worker and all of its tasks.
        if (error instanceof Error && 'code' in error && ['RELAY_TERMINAL', 'RELAY_AUTH_RECOVERY_EXHAUSTED'].includes(String(error.code))) {
          this.listenerStatus('unavailable', error);
          for (const mailbox of this.mailboxes.values()) mailbox.close(error);
          this.controller.abort(error);
        }
        throw error;
      }
    } finally {
      if (this.status !== 'unavailable') this.listenerStatus('stopped');
      unregister();
      await Promise.allSettled([...jobs]);
    }
    return this.lastResult;
  }
  private assertPeer(did: string): 'trusted' | void {
    if (this.options.allowedPeerDids !== undefined && !this.options.allowedPeerDids.includes(did))
      throw new Error('PEER_NOT_ALLOWED');
    if (this.intakeStore.level(did) === 'denied') throw new Error('REQUEST_DENIED');
    return this.options.checkPeer?.(did);
  }
  private trust(did: string, invited: boolean): 'unknown' | 'limited' | 'trusted' {
    const contactTrust = this.assertPeer(did);
    if (contactTrust === 'trusted' || this.acceptance.allowAnyRequester || this.acceptance.allowedRequesterDids?.includes(did)) return 'trusted';
    const grant = this.intakeStore.level(did);
    return grant === 'limited' || grant === 'trusted' ? grant : invited ? 'limited' : 'unknown';
  }
  private async notifyOutcome(record: TaskCheckpoint, outcome = record.outcome!): Promise<void> {
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
  private async reconcileTasks(): Promise<void> {
    if (this.reconciled || !this.taskJournal) return;
    this.taskJournal.load();
    for (const saved of this.taskJournal.tasks.values()) {
      let record = saved;
      const pending = this.intakeStore.pendingTask(record.requesterDid, record.taskId, record.proposalDigest);
      if (record.phase !== 'terminal') {
        const result = this.sealedTaskResult(record);
        // Adapters expose executeTask only. Unknown execution/tool results cannot be retried safely.
        record = { ...record, phase: 'terminal', outcome: pending ? { code: 'PENDING_OWNER_APPROVAL' } : result
          ? { code: result.state === 'SETTLED' ? 'TASK_SETTLED' : 'TASK_CANCELLED', result }
          : { code: 'TASK_INTERRUPTED' }, notificationPending: true };
        this.taskJournal.save(record);
        if (!result && !pending) this.options.onEvent?.('INTERRUPTED', record.taskId, { code: 'TASK_INTERRUPTED' });
      }
      if (record.notificationPending) {
        try { this.assertPeer(record.requesterDid); } catch { continue; }
        if (pending) {
          record = { ...record, phase: 'terminal', outcome: { code: 'PENDING_OWNER_APPROVAL' } };
          this.taskJournal.save(record);
        }
        await this.notifyOutcome(record);
        this.taskJournal.save({ ...record, notificationPending: false });
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
      if (!proposal || digest({ manifest: proposal.proposal.payload, input: proposal.input }) !== record.proposalDigest) return;
      const last = bundle.entries.at(-1)?.body.eventType;
      if (last === 'CANCEL') return { taskId: record.taskId, state: 'CANCELLED', deliverable: null, bundle };
      const delivery = bundle.entries.find((entry) => entry.body.eventType === 'DELIVER')?.body.payload as unknown as Delivery;
      if (last === 'SETTLED' && delivery)
        return { taskId: record.taskId, state: 'SETTLED', deliverable: delivery.artifact.payload.data, bundle };
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
    let record = this.taskJournal.tasks.get(manifest.taskId);
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
  private reportRejection(taskId: string, error: unknown): void {
    const diagnostic = rejectionBody(error);
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
      if (verified && first.payload.eventType !== 'ERROR')
        this.options.onEvent?.('REJECTED', first.payload.taskId, { code: 'INVALID_PROPOSAL_ENVELOPE' });
      return;
    }
    let rejection = this.intakeRejection(first);
    let reserved = false;
    if (!rejection && this.activeTasks >= this.concurrentLimit)
      rejection = 'maxConcurrentTasks ' + this.concurrentLimit + ' reached';
    else if (!rejection) {
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
    return this.executeTask(first, idleSignal, this.relay);
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
    let auditPath: string | undefined;
    let checkpoint: TaskCheckpoint | undefined;
    const saveCheckpoint = (patch: Partial<TaskCheckpoint>): void => {
      if (!checkpoint || !this.taskJournal) return;
      checkpoint = { ...checkpoint, ...patch };
      this.taskJournal.save(checkpoint);
    };
    const saveOutcome = (outcome: TaskOutcome): void => {
      saveCheckpoint({ phase: 'terminal', outcome, notificationPending: true });
    };
    try {
      data = openEnvelope(
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
        Date.parse(manifest.deadline) <= Date.now() ||
        Date.parse(manifest.createdAt) > Date.now() + DEFAULT_CLOCK_SKEW_MS
      )
        throw new Error('INVALID_PROPOSAL');
      this.assertPeer(first.payload.senderDid);
      m = manifest;
      auditPath = this.options.auditPath
        ? this.completed++ === 0 && !existsSync(this.options.auditPath)
          ? this.options.auditPath
          : this.options.auditPath.replace(/(?:\.jsonl)?$/, '.' + m.taskId + '.jsonl')
        : undefined;
      freshAudit(auditPath);
      if (this.taskJournal) {
        checkpoint = { version: 1, taskId: m.taskId, requesterDid: m.requester.ownerDid,
          envelopeId: first.payload.envelopeId, proposalDigest: digest({ manifest: m, input: data.input }),
          phase: 'received', auditPath, invocations: [] };
        this.taskJournal.save(checkpoint);
      }
    } catch (e) {
      this.reportRejection(first.payload.taskId, e);
      try {
        await relay.send(
          signEnvelope(
            {
              taskId: first.payload.taskId,
              recipientDid: first.payload.senderDid,
              seq: 0,
              eventType: 'ERROR',
              payload: asJson(rejectionBody(e)),
            },
            this.options.owner,
            { encrypt: true },
          ),
        );
      } catch {
        // Ignore transport errors while reporting pre-wire rejection.
      }
      throw e;
    }
    const timeouts = new SessionTimeouts(this.options, m.deadline, idleSignal);
    const activeSignal = timeouts.signal;
    const wire = new SessionWire(
      relay,
      this.options.owner,
      m.requester.ownerDid,
      m.taskId,
      [m.requester.ownerDid, this.options.owner.did],
      activeSignal,
      auditPath,
      this.options.allowUnencryptedEnvelopes === true,
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
    let gateway: OwnerGateway | undefined, workspace: string | undefined;
    let preserveWorkspace = false;
    let trackedTaskId: string | undefined;
    // Progress metrics are applied synchronously. The tail only serializes wire frames.
    let progressTail: Promise<void> = Promise.resolve();
    let progressFailure: unknown;
    let wireFailureSent = false;
    try {
      const invited = this.assertInviteActive(data);
      if (this.options.accessMode === 'open') {
        for (const field of OPEN_POLICY_FIELDS) {
          const limit = this.agentCard.payload.openPolicy?.[field];
          if (limit !== undefined && m.budget[field] > limit)
            throw diagnosticError('TASK_SCOPE_REJECTED', 'budget.' + field, limit, m.budget[field], 'Use a budget within the advertised policy.');
        }
        const skills = this.agentCard.payload.skills;
        const selected = m.task.skillId ? skills.filter((skill) => skill.id === m.task.skillId) : skills;
        if ((m.task.skillId && selected.length === 0) ||
            (m.task.taskType && !selected.some((skill) => skill.taskTypes?.includes(m.task.taskType!))) ||
            (m.task.skillId && !m.task.taskType && selected.some((skill) => skill.taskTypes?.length)))
          throw diagnosticError('TASK_SCOPE_REJECTED', 'task.scope', skills, m.task, 'Select an advertised skill and task type, or omit both for direct delegation.');
      }
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
      const peerTrust = this.trust(m.requester.ownerDid, invited);
      if (peerTrust === 'unknown' || this.intakeStore.pendingTask(m.requester.ownerDid, m.taskId,
          digest({ manifest: m, input: data.input }))) {
        if (peerTrust === 'unknown') this.intakeStore.enqueue(m, data.input);
        throw new Error('PENDING_OWNER_APPROVAL');
      }
      const llm = this.options.adapterKind === 'llm' ||
        ['claude', 'codex', 'openai'].includes(this.options.adapter.id);
      // An explicit non-LLM automatic policy retains invited sandbox/command behavior.
      const contractProvider = peerTrust === 'limited' && (llm || this.options.automaticApproval === false)
        ? this.options.ownerApprovalProvider : this.approvalProvider;
      if (!contractProvider) throw new Error('APPROVAL_CHANNEL_UNAVAILABLE');
      await wire.receiveEvent('PROPOSE', first);
      const contract = createContract(m, data.proposal, this.options.owner);
      const approval = await abortable(contractProvider.approve({
        taskId: m.taskId,
        gate: 'contract_acceptance',
        target: contract.contractDigest,
        details: {
          manifest: m,
          input: data.input,
          capabilities: data.capabilityChains,
          from: first.payload.senderDid,
        },
        signal: activeSignal,
      }), activeSignal);
      if (this.trust(m.requester.ownerDid, this.assertInviteActive(data)) === 'unknown')
        throw new Error('APPROVAL_CHANNEL_UNAVAILABLE');
      this.assertCapabilitiesActive(data.capabilityChains, capabilityContext);
      this.assertPeer(m.requester.ownerDid);
      if (peerTrust === 'trusted' && this.trust(m.requester.ownerDid, invited) !== 'trusted')
        throw new Error('APPROVAL_CHANNEL_UNAVAILABLE');
      gateway = new OwnerGateway(this.options.owner, contract, policy, this.revocation);
      const accepted = gateway.accept(approval);
      saveCheckpoint({ phase: 'accepted' });
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
        await acknowledgeRelay(relay, first, activeSignal);
        // Notification errors must not fail a persisted task.
        try {
          void Promise.resolve(this.options.onInboxRecord?.(record)).catch(() => undefined);
        } catch {
          // Synchronous notification failures are also best effort.
        }
      }
      await wire.sendEvent('ACCEPT', { contract, transition: accepted, approval });
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
      this.assertPeer(m.requester.ownerDid);
      workspace = await mkdtemp(join(tmpdir(), 'acp-adapter-'));
      saveCheckpoint({ phase: 'running', workspace });
      let invocationCount = 0;
      const executionSignal = AbortSignal.any([
        activeSignal,
        gateway.quota.controller.signal,
        cancelController.signal,
      ]);
      let effectiveIsolationLevel = 'host_adapter';
      let sandboxBoundary: SandboxBoundaryMetadata | undefined;
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
      const context: AgentTaskContext = {
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
                gateway!.quota.recordMetrics(delta);
              } catch (error) {
                metricsError = error;
              }
            }
          }
          if (metricsError) {
            progressFailure ??= metricsError;
            const code = safeError(metricsError);
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
        reportIsolation: (level, boundary) => {
          effectiveIsolationLevel = level;
          sandboxBoundary = boundary;
        },
        callTool: async (tool, args) => {
          this.assertPeer(m.requester.ownerDid);
          executionSignal.throwIfAborted();
          if (!args || typeof args !== 'object' || Array.isArray(args))
            throw new Error('CAPABILITY_VIOLATION: arguments');
          const index = data.capabilityChains.findIndex((c) =>
            c.at(-1)!.payload.allowedTools.includes(tool),
          );
          if (index < 0) throw new Error('CAPABILITY_VIOLATION: unauthorized tool');
          const approval =
            tools[tool] && !tools[tool].readOnly
              ? await this.approvalProvider.approve({
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
      this.assertPeer(m.requester.ownerDid);
      if (this.trust(m.requester.ownerDid, this.assertInviteActive(data)) === 'unknown')
        throw new Error('APPROVAL_CHANNEL_UNAVAILABLE');
      this.assertCapabilitiesActive(data.capabilityChains, capabilityContext);
      if (peerTrust === 'trusted' && this.trust(m.requester.ownerDid, invited) !== 'trusted')
        throw new Error('APPROVAL_CHANNEL_UNAVAILABLE');
      const output = await abortable(this.options.adapter.executeTask(context), executionSignal);
      if (!this.options.inboxPath) await acknowledgeRelay(relay, first, executionSignal);
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
          effectiveIsolationLevel,
          ...(sandboxBoundary ? { sandboxBoundary } : {}),
        },
      );
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
          await wire.rawSend('ERROR', { code: safeError(inner) }).catch(() => {});
          throw inner;
        }
      }
      await progressTail;
      preserveWorkspace = activeSignal.aborted || idleSignal.aborted;
      if (idleSignal.aborted) throw e;
      const diagnostic = preserveWorkspace ? { code: 'TASK_INTERRUPTED' } : rejectionBody(progressFailure ?? e);
      saveOutcome(diagnostic);
      this.reportRejection(m.taskId, progressFailure ?? e);
      if (!wireFailureSent) {
        wireFailureSent = true;
        await wire.rawSend('ERROR', diagnostic)
          .then(async () => {
            saveCheckpoint({ notificationPending: false });
            if (diagnostic.code === 'PENDING_OWNER_APPROVAL') await acknowledgeRelay(relay, first);
          }).catch(() => {});
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
      heartbeatStopped = true;
      clearTimeout(heartbeat);
      timeouts.close();
      wire.close();
      if (trackedTaskId) this.liveChains.delete(trackedTaskId);
      gateway?.close();
      if (idleSignal.aborted && checkpoint?.phase !== 'terminal') preserveWorkspace = true;
      if (workspace && !preserveWorkspace) {
        try {
          await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code ?? 'WORKSPACE_CLEANUP_FAILED';
          // Reporting residual files must not replace settlement or the execution error.
          try {
            if (this.options.onWorkspaceCleanupError)
              void Promise.resolve(this.options.onWorkspaceCleanupError({ taskId: m.taskId, workspaceDir: workspace, code }))
                .catch(() => {});
            else console.warn('Workspace cleanup incomplete (' + code + '): ' + workspace);
          } catch {}
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
        const forwarded = this.forwardedQueue.shift();
        if (forwarded) {
          if (this.consumeRevocation(forwarded)) continue;
          return forwarded;
        }
        const envelope = await relay.receive(
          recipientDid, waitMs, signal, filter ?? { role: 'worker' },
        );
        if (!envelope) {
          const afterWait = this.forwardedQueue.shift();
          if (afterWait) {
            if (this.consumeRevocation(afterWait)) continue;
            return afterWait;
          }
          return undefined;
        }
        if (this.consumeRevocation(envelope)) { await acknowledgeRelay(relay, envelope); continue; }
        if (
          this.isRequesterBoundFrame(envelope) &&
          forwardToRequesterInbox(this.options.owner.did, envelope)
        )
          continue;
        return envelope;
      }
    };
    return {
      get connectionStatus() { return relay.connectionStatus; },
      send: (envelope) => {
        this.assertPeer(envelope.payload.recipientDid);
        return relay.send(envelope);
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
    if (typeof token !== 'string' || token.length === 0) {
      if (this.options.accessMode !== 'open' &&
          !this.options.allowedRequesterDids?.includes(data.proposal.payload.requester.ownerDid) &&
          !['limited', 'trusted'].includes(this.intakeStore.level(data.proposal.payload.requester.ownerDid)))
        throw new Error('INVITE_REQUIRED');
      return false;
    }
    const invite = parseAndVerifyInviteToken(token, Date.now(), { allowPrivateRelay: true, allowExpired: true });
    if (invite.ownerDid !== this.options.owner.did ||
        invite.agentDid !== this.agentCard.payload.agentDid ||
        invite.relayUrl !== this.agentCard.payload.relayEndpoint)
      throw new Error('INVITE_WORKER_MISMATCH');
    this.revocation.assertNotRevoked('invite', digest(invite));
    this.revocation.assertNotRevoked('invite', token);
    if (Math.min(Date.parse(invite.expiresAt), Date.parse(invite.agentCard.payload.expiresAt)) <= Date.now()) {
      if (this.options.accessMode === 'open') return false;
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
export interface ErrorDiagnostic { code: string; detail?: ErrorDetail }
class DiagnosticError extends Error {
  constructor(code: string, readonly detail: ErrorDetail) { super(code); }
}
function diagnosticError(code: string, field: string, expected: unknown, actual: unknown, hint: string): Error {
  return new DiagnosticError(code, { field, expected: digest(expected), actual: digest(actual), hint });
}
function rejectionBody(error: unknown): ErrorDiagnostic & { reason?: string } {
  if (error instanceof DiagnosticError) return { code: safeError(error), detail: error.detail };
  if (error instanceof ProposalRejectedError) return { code: error.code, reason: error.reason };
  if (safeError(error) === 'PENDING_OWNER_APPROVAL') return { code: 'PENDING_OWNER_APPROVAL', reason: PENDING_MESSAGE };
  return { code: safeError(error) };
}
function safeError(e: unknown): string {
  const s = String(e);
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
export interface RequesterClientOptions extends SessionTimeoutOptions, RelayAuthRecoveryOptions {
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
export interface DelegateOptions extends SessionTimeoutOptions {
  /** Saved target retained without its token; applications must resolve it into `to` on each attempt. */
  workerRef?: string;
  /** Existing requester-local record when explicitly resubmitting. */
  pendingId?: string;
  /** Selected endpoint when an application replaces a per-task transport. */
  pendingRelayUrl?: string;
  beforePropose?: (action: BeforeProposeContext) => Promise<void>;
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
  readonly approvalProvider: ApprovalProvider;
  constructor(readonly options: RequesterClientOptions) {
    validateRelayAuthRecoveryOptions(options);
    validateSessionTimeouts(options);
    this.approvalProvider =
      options.approvalProvider ?? new InteractiveCliApprovalProvider(options.owner);
  }
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
    // Retain the reviewed values even if the caller changes its objects while awaiting consent.
    if (options.beforePropose) options = { ...options,
      input: structuredClone(options.input), manifest: options.manifest && structuredClone(options.manifest),
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
    if (options.workerRef && !invite) throw new Error('INVITE_REQUIRED');
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
          ? recipientInbox(this, relay, owner.did, relayOption.replace(/\/$/, ''))
          : recipientInbox(relayOption, relay, owner.did);
    const rawCards = !invite && relay.discover ? await relay.discover() : [];
    if (!Array.isArray(rawCards)) throw new Error('INVALID_AGENT_CARD');
    if (invite && options.discover) throw new Error('CONFLICTING_DISCOVERY_TARGET');
    const card = options.discover
      ? discoverAgentCards(rawCards, { ...options.discover, accessMode: 'open',
          ...(options.to ? { did: options.to } : {}) })[0]
      : findDiscoveredAgentCard(rawCards, options.to);
    if (options.discover && !card) throw new Error('OPEN_WORKER_NOT_FOUND');
    const peer = invite?.ownerDid ?? card?.payload.ownerDid ?? options.to;
    const manifest =
      options.manifest ??
      buildTaskManifest({
        ...options,
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
    // Cap only implicit defaults; explicit budgets remain subject to worker admission.
    if (!options.manifest && card?.payload.accessMode === 'open') {
      for (const field of OPEN_POLICY_FIELDS) {
        const limit = card.payload.openPolicy?.[field];
        if (limit !== undefined && options.budget?.[field] === undefined)
          manifest.budget[field] = Math.min(manifest.budget[field], limit);
      }
    }
    if (options.manifest && timeoutOptions.executionTimeoutMs !== undefined &&
        manifest.budget.maxWallClockSeconds * 1000 > timeoutOptions.executionTimeoutMs)
      throw new Error('INCOMPATIBLE_TIMEOUTS: manifest budget exceeds executionTimeoutMs');
    if (options.budget?.maxWallClockSeconds !== undefined && timeoutOptions.executionTimeoutMs !== undefined &&
        options.budget.maxWallClockSeconds * 1000 > timeoutOptions.executionTimeoutMs)
      throw new Error('INCOMPATIBLE_TIMEOUTS: requested budget exceeds executionTimeoutMs');
    validateManifest(manifest);
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
      if (options.minimumIsolationLevel === 'oci_container')
        manifest.verification = { ...manifest.verification, requireExecutionAttestation: true };
    }
    if (!validateOutput(manifest.io.inputSchema, options.input)) throw new Error('INPUT_SCHEMA');
    if (options.beforePropose) {
      const approvalSignal = AbortSignal.any([
        AbortSignal.timeout(Math.max(0, Date.parse(manifest.deadline) - Date.now())),
        ...(options.signal ? [options.signal] : []),
      ]);
      try {
        await abortable(options.beforePropose({
          manifest: freezeApprovalAction(manifest), input: freezeApprovalAction(options.input),
          relay: typeof relayOption === 'string' ? relayOption
            : 'url' in relayOption && typeof relayOption.url === 'string' ? relayOption.url : 'injected transport',
          signal: approvalSignal,
        }), approvalSignal);
        approvalSignal.throwIfAborted();
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
    const auditPath = options.auditPath ?? this.options.auditPath;
    freshAudit(auditPath);
    const bridge = new AbortController();
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
      await wire.sendEvent('PROPOSE', {
        proposal: signPayload(manifest, owner),
        input: options.input,
        capabilityChains,
        peerIdleTimeoutMs: timeoutOptions.transportIdleTimeoutMs ?? 90_000,
        ...(invite ? { inviteToken: options.to } : {}),
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
      const approval = () =>
        this.approvalProvider.approve({
          taskId: manifest.taskId,
          gate: 'final_verification',
          target: data,
          details: { manifest, deliverableDigest: data.artifact.payload.digest },
          deadline: manifest.deadline,
          signal,
        });
      const { result, verification, settlement } = await abortable(gateway.verifyAndSettle(
        wire.sealed(envelope),
        this.options.verificationEngine ?? new VerificationEngine(),
        approval,
        { allowUnencryptedEnvelopes: this.options.allowUnencryptedEnvelopes === true },
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
                !proposed || digest({ manifest: proposed.proposal.payload, input: proposed.input }) !== e.recovery.proposalDigest ||
                !accepted || !verifyContract(accepted.contract) || digest(accepted.contract.manifest) !== digest(manifest) ||
                (cached.state === 'CANCELLED' && (e.code !== 'TASK_CANCELLED' || cached.deliverable !== null ||
                  cached.bundle.entries.at(-1)?.body.eventType !== 'CANCEL')) ||
                (cached.state === 'SETTLED' && (!delivered ||
                  e.code !== 'TASK_SETTLED' ||
                  digest(delivered.artifact.payload.data) !== digest(cached.deliverable) ||
                  cached.bundle.entries.at(-1)?.body.eventType !== 'SETTLED')))
              throw new Error('INVALID_RECOVERY_OUTCOME');
            if (cached.state === 'SETTLED') hooks?.onDelivered?.();
            return cached;
          }
        }
        if (verifiedReceipt) throw e;
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
            await wire.rawSend('ERROR', { code: safeError(inner) }).catch(() => {});
            throw inner;
          }
        }
        await wire.rawSend('ERROR', { code: safeError(e) }).catch(() => {});
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
        if (options.beforePropose && error instanceof Error && error.message.startsWith('APPROVAL_'))
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
      ? (payload as { contract?: { manifest?: TaskManifest } }).contract?.manifest?.worker
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
  ownerDid: string;
  workerDid: string;
  agentDid?: string;
  skillId?: string;
  taskType?: string;
  title: string;
  description: string;
  outputSchema?: Schema;
  budget?: Partial<BudgetSpec>;
  taskTimeoutMs?: number;
  capabilities?: TaskManifest['permissions']['grantedCapabilities'];
}): TaskManifest {
  const createdAt = new Date().toISOString(),
    deadline = new Date(Date.now() + (options.taskTimeoutMs ?? 600000)).toISOString();
  return {
    protocolVersion: '0.1.0',
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
}
