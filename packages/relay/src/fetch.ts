// SPDX-License-Identifier: Apache-2.0
import {
  verifySigned,
  generateKeyPair,
  signPayload,
  resolveDid,
  verifySignedAgentCard,
  findDiscoveredAgentCard,
  toA2AAgentCard,
  verifyRelayAuthToken,
  createRelayAuthToken,
} from '@acp/core/edge';
import type { SignedEnvelope, SignedAgentCard, RelayAuthAction, KeyPair } from '@acp/core/edge';
import type { RelayWakeOptions, RelayWakeAttempt, RelayOperation, SignedRelayDeliveryStatus } from './notifications.js';
export * from './notifications.js';
// Same outer wire shape as envelope.schema.json, without filesystem schema loads.
export function verifyRelayEnvelope(e: SignedEnvelope, recipient?: string): boolean {
  try {
    const p = e.payload;
    resolveDid(p.senderDid);
    resolveDid(p.recipientDid);
    return (
      Object.keys(e).sort().join() === 'payload,signature' &&
      Object.keys(p).sort().join() ===
        'envelopeId,eventType,payload,recipientDid,senderDid,seq,taskId,type' &&
      Object.keys(e.signature).sort().join() ===
        'canonicalization,payloadDigest,signature,signedAt,signerDid' &&
      p.type === 'SignedEnvelope' &&
      [p.envelopeId, p.taskId, p.eventType].every((s) => typeof s === 'string' && s.length > 0) &&
      Number.isSafeInteger(p.seq) &&
      p.seq >= 0 &&
      (!recipient || p.recipientDid === recipient) &&
      verifySigned(e, p.senderDid)
    );
  } catch {
    return false;
  }
}
/** Single signed envelope JSON body. Larger bodies are rejected before they are queued. */
export const DEFAULT_MAX_ENVELOPE_BYTES = 256 * 1024;
/** Unread envelopes kept for one recipient. */
export const DEFAULT_MAX_QUEUE_SIZE = 256;
/** Sum of queued envelope JSON sizes for one recipient. */
export const DEFAULT_MAX_QUEUE_BYTES_PER_RECIPIENT = 4 * 1024 * 1024;
export const DEFAULT_ENVELOPE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_SEEN_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_AUTH_SEEN_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_AGENT_CARD_TTL_MS = 60 * 60 * 1000;
/** Caps the durable replay ring scanned when an inbox object wakes. */
export const DEFAULT_MAX_SEEN_ENTRIES = 4096;
export const DEFAULT_MAX_QUEUES = 10000;
export const DEFAULT_MAX_AGENTS = 10000;

export interface RelaySnapshot {
  operations?: [string, RelayOperation][];
  queues: [string, SignedEnvelope[]][];
  seen: string[];
  authSeen?: string[];
  agents: SignedAgentCard[];
  envelopeExpiry?: [string, number][];
  leaseExpiry?: [string, number][];
  seenExpiry?: [string, number][];
  authExpiry?: [string, number][];
  agentExpiry?: [string, number][];
}
export interface InMemoryRelayOptions {
  notificationKey?: KeyPair;
  wake?: RelayWakeOptions;
  /** Bounded expiry notices and wake deduplication retention; default one hour. */
  notificationTtlMs?: number;
  requireAuth?: boolean;
  /**
   * Direct and network checks accept a `RelayAuth` token that omits `origin`.
   * A token that includes a different origin is still rejected.
   */
  allowUnboundRelayAuth?: boolean;
  maxSeenEntries?: number;
  maxAuthSeenEntries?: number;
  maxQueues?: number;
  maxQueueSize?: number;
  maxEnvelopeBytes?: number;
  maxQueueBytesPerRecipient?: number;
  maxEnvelopesPerSender?: number;
  maxAgents?: number;
  envelopeTtlMs?: number;
  seenTtlMs?: number;
  authSeenTtlMs?: number;
  agentCardTtlMs?: number;
  now?: () => number;
  tamper?: (e: SignedEnvelope) => SignedEnvelope;
}
export type RelayInboxRole = 'worker' | 'requester';
export interface RelayReceiveFilter {
  taskId?: string | readonly string[];
  role?: RelayInboxRole;
  peek?: boolean;
  lease?: boolean;
}
interface StoredEnvelope {
  envelope: SignedEnvelope;
  bytes: number;
  expiresAt: number;
  leasedUntil?: number;
  role: RelayInboxRole;
}
interface TaskRoleState {
  crossRole: Map<string, RelayInboxRole>;
  lastPrimaryRole?: RelayInboxRole;
  pendingAckRoles: RelayInboxRole[];
  workerSeq: number;
  requesterSeq: number;
}
interface NormalizedReceiveFilter {
  taskIds?: Set<string>;
  role?: RelayInboxRole;
  peek: boolean;
  lease?: boolean;
}
const CONNECTION_CONTROL_EVENTS: ReadonlySet<string> = new Set([
  'CONNECTION_REQUEST',
  'CONNECTION_ACCEPTED',
  'CONNECTION_ACK',
]);
const WORKER_PRIMARY_EVENTS: ReadonlySet<string> = new Set([
  ...CONNECTION_CONTROL_EVENTS,
  'PROPOSE',
  'REVOKE',
  'VERIFY_ACCEPT',
  'VERIFY_REJECT',
  'SETTLE',
  'SETTLED',
  'CANCEL',
  'CHECKPOINT',
]);
const REQUESTER_PRIMARY_EVENTS: ReadonlySet<string> = new Set([
  'ACCEPT',
  'ATTEST',
  'START',
  'PROGRESS',
  'DELIVER',
  'HEARTBEAT',
  'CHECKPOINT_ACK',
]);
const BILATERAL_AUDIT_EVENTS: ReadonlySet<string> = new Set([
  'PROPOSE',
  'ACCEPT',
  'START',
  'PROGRESS',
  'DELIVER',
  'VERIFY_ACCEPT',
  'VERIFY_REJECT',
  'SETTLED',
  'CANCEL',
]);
export function classifyEnvelopeRole(
  envelope: SignedEnvelope,
  state?: TaskRoleState,
): RelayInboxRole {
  const { eventType: type, seq, senderDid, recipientDid } = envelope.payload;
  // Control delivery does not participate in bilateral task role/sequence inference.
  if (CONNECTION_CONTROL_EVENTS.has(type))
    return 'worker';
  const cross = senderDid !== recipientDid;
  if (WORKER_PRIMARY_EVENTS.has(type)) {
    if (state) {
      if (cross) {
        state.crossRole.set(recipientDid, 'worker');
        state.crossRole.set(senderDid, 'requester');
      }
      state.lastPrimaryRole = 'worker';
      if (BILATERAL_AUDIT_EVENTS.has(type)) state.pendingAckRoles.push('requester');
      state.workerSeq = Math.max(state.workerSeq, seq + 1);
    }
    return 'worker';
  }
  if (REQUESTER_PRIMARY_EVENTS.has(type)) {
    if (state) {
      if (cross) {
        state.crossRole.set(recipientDid, 'requester');
        state.crossRole.set(senderDid, 'worker');
      }
      state.lastPrimaryRole = 'requester';
      if (BILATERAL_AUDIT_EVENTS.has(type)) state.pendingAckRoles.push('worker');
      state.requesterSeq = Math.max(state.requesterSeq, seq + 1);
    }
    return 'requester';
  }
  if (type === 'AUDIT_ENTRY') {
    let role: RelayInboxRole;
    if (cross && state?.crossRole.has(recipientDid)) role = state.crossRole.get(recipientDid)!;
    else if (state?.lastPrimaryRole) role = state.lastPrimaryRole;
    else role = seq === 1 ? 'worker' : 'requester';
    if (state) {
      if (role === 'worker') state.workerSeq = Math.max(state.workerSeq, seq + 1);
      else state.requesterSeq = Math.max(state.requesterSeq, seq + 1);
    }
    return role;
  }
  if (type === 'AUDIT_ACK') {
    let role: RelayInboxRole;
    if (cross && state?.crossRole.has(recipientDid)) {
      role = state.crossRole.get(recipientDid)!;
      if (state.pendingAckRoles[0] === role) state.pendingAckRoles.shift();
    } else if (state && state.pendingAckRoles.length > 0) {
      role = state.pendingAckRoles.shift()!;
    } else {
      role = seq === 0 ? 'requester' : 'worker';
      if (state && cross) {
        state.crossRole.set(recipientDid, role);
        state.crossRole.set(senderDid, role === 'requester' ? 'worker' : 'requester');
      }
    }
    if (state) {
      if (role === 'worker') state.workerSeq = Math.max(state.workerSeq, seq + 1);
      else state.requesterSeq = Math.max(state.requesterSeq, seq + 1);
    }
    return role;
  }
  if (type === 'ERROR') {
    if (cross && state?.crossRole.has(recipientDid)) return state.crossRole.get(recipientDid)!;
    if (seq === 0) {
      if (state && cross) {
        state.crossRole.set(recipientDid, 'requester');
        state.crossRole.set(senderDid, 'worker');
      }
      return 'requester';
    }
    if (state) {
      if (seq === state.requesterSeq && seq !== state.workerSeq) return 'requester';
      if (seq === state.workerSeq && seq !== state.requesterSeq) return 'worker';
      if (state.pendingAckRoles.length > 0) return state.pendingAckRoles.shift()!;
      if (state.lastPrimaryRole)
        return state.lastPrimaryRole === 'worker' ? 'requester' : 'worker';
    }
    return 'worker';
  }
  if (cross && state?.crossRole.has(recipientDid)) return state.crossRole.get(recipientDid)!;
  return 'worker';
}
export function normalizeReceiveFilter(filter?: RelayReceiveFilter): NormalizedReceiveFilter {
  if (!filter) return { peek: false };
  if (filter.role !== undefined && filter.role !== 'worker' && filter.role !== 'requester')
    throw new Error('INVALID_REQUEST');
  let taskIds: Set<string> | undefined;
  if (filter.taskId !== undefined) {
    const raw = Array.isArray(filter.taskId) ? filter.taskId : [filter.taskId];
    const items: string[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'string') throw new Error('INVALID_REQUEST');
      for (const part of entry.split(',')) {
        const trimmed = part.trim();
        if (trimmed) items.push(trimmed);
      }
    }
    if (items.length > 0) taskIds = new Set(items);
  }
  return {
    ...(taskIds ? { taskIds } : {}),
    ...(filter.role ? { role: filter.role } : {}),
    peek: filter.peek === true,
    lease: filter.lease === true,
  };
}
export function parseReceiveFilterFromUrl(url: URL): RelayReceiveFilter | undefined {
  const roleParam = url.searchParams.get('role');
  if (roleParam !== null && roleParam !== 'worker' && roleParam !== 'requester')
    throw new Error('INVALID_REQUEST');
  const peekParam = url.searchParams.get('peek');
  if (
    peekParam !== null &&
    peekParam !== 'true' &&
    peekParam !== '1' &&
    peekParam !== 'false' &&
    peekParam !== '0'
  )
    throw new Error('INVALID_REQUEST');
  const taskIdParams = url.searchParams
    .getAll('taskId')
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
  const leaseParam = url.searchParams.get('lease');
  if (leaseParam !== null && leaseParam !== 'true' && leaseParam !== 'false') throw new Error('INVALID_REQUEST');
  const lease = leaseParam === 'true';
  const peek = peekParam === 'true' || peekParam === '1';
  if (!roleParam && taskIdParams.length === 0 && !peek && !lease) return undefined;
  return {
    ...(roleParam ? { role: roleParam as RelayInboxRole } : {}),
    ...(taskIdParams.length > 0 ? { taskId: taskIdParams } : {}),
    ...(peek ? { peek: true } : {}),
    ...(lease ? { lease: true } : {}),
  };
}
export function inboxRecipientFromRequest(path: string, url: URL): string | undefined {
  if (path === '/envelopes' || path === '/stream') return url.searchParams.get('recipient') ?? '';
  if (path.startsWith('/inbox/')) {
    const rest = path.slice('/inbox/'.length);
    if (!rest || rest.includes('/')) return undefined;
    return decodeURIComponent(rest);
  }
  return undefined;
}
function matchesStoredEnvelope(item: StoredEnvelope, filter: NormalizedReceiveFilter): boolean {
  const { taskId, eventType, senderDid, recipientDid } = item.envelope.payload;
  if (filter.taskIds && !filter.taskIds.has(taskId)) return false;
  if (!filter.role) return true;
  if (item.role === filter.role) return true;
  // When a requester explicitly polls for its known taskId on a cross-DID task,
  // any non-worker-primary frame for that taskId belongs to the requester even after a cold restart.
  if (
    filter.role === 'requester' &&
    filter.taskIds?.has(taskId) &&
    senderDid !== recipientDid &&
    !WORKER_PRIMARY_EVENTS.has(eventType)
  )
    return true;
  return false;
}
function positiveLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('INVALID_RELAY_LIMIT');
  return limit;
}
export function relayLimitsFromEnv(env?: Record<string, unknown>): InMemoryRelayOptions {
  const read = (key: string): number | undefined => {
    const value = env?.[key];
    if (typeof value !== 'string' || value === '') return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
  };
  return {
    notificationTtlMs: read('ACP_NOTIFICATION_TTL_MS'),
    maxEnvelopeBytes: read('ACP_MAX_ENVELOPE_BYTES'),
    maxQueueSize: read('ACP_MAX_QUEUE_SIZE'),
    maxQueueBytesPerRecipient: read('ACP_MAX_QUEUE_BYTES'),
    maxEnvelopesPerSender: read('ACP_MAX_ENVELOPES_PER_SENDER'),
    maxSeenEntries: read('ACP_MAX_SEEN_ENTRIES'),
    envelopeTtlMs: read('ACP_ENVELOPE_TTL_MS'),
    seenTtlMs: read('ACP_SEEN_TTL_MS'),
    authSeenTtlMs: read('ACP_AUTH_SEEN_TTL_MS'),
    agentCardTtlMs: read('ACP_AGENT_CARD_TTL_MS'),
    maxAgents: read('ACP_MAX_AGENTS'),
  };
}
export function canonicalRelayPath(pathname: string): string {
  if (pathname === '/v1') return '/';
  if (pathname.startsWith('/v1/')) return pathname.slice(3);
  return pathname;
}
/**
 * Registry identity for one owner's registration of one agent.
 * did:key values do not contain "/", so the pair round-trips unambiguously.
 */
export function agentRegistryKey(ownerDid: string, agentDid: string): string {
  return ownerDid + '/' + agentDid;
}
/**
 * Use the same verified, deterministic DID selection as requesters.
 */
export function selectAgentCard(
  cards: Iterable<SignedAgentCard>,
  agentDid: string,
  now = Date.now(),
): SignedAgentCard | undefined {
  return findDiscoveredAgentCard([...cards], agentDid, now);
}
export class InMemoryRelay {
  private operations = new Map<string, RelayOperation>();
  private notificationKey: KeyPair;
  private readonly wake?: RelayWakeOptions;
  readonly notificationTtlMs: number;
  private flushing?: Promise<void>;
  get notificationDid(): string { return this.notificationKey.did; }
  /** Durable hosts install the persisted relay identity before restoring queues. */
  setNotificationKey(key: KeyPair): void { this.notificationKey = key; }
  private queues = new Map<string, StoredEnvelope[]>();
  private taskStates = new Map<string, TaskRoleState>();
  private seen = new Map<string, number>();
  private authSeen = new Map<string, number>();
  private agentExpiry = new Map<string, number>();
  private version = 0;
  get mutationVersion(): number {
    return this.version;
  }
  private listeners = new Map<string, Set<() => void>>();
  /** Keyed by agentRegistryKey(ownerDid, agentDid). One owner cannot block another. */
  readonly agents = new Map<string, SignedAgentCard>();
  readonly tamper?: (e: SignedEnvelope) => SignedEnvelope;
  readonly requireAuth: boolean;
  readonly allowUnboundRelayAuth: boolean;
  readonly maxSeenEntries: number;
  readonly maxAuthSeenEntries: number;
  readonly maxQueues: number;
  readonly maxQueueSize: number;
  readonly maxEnvelopeBytes: number;
  readonly maxQueueBytesPerRecipient: number;
  readonly maxEnvelopesPerSender: number;
  readonly maxAgents: number;
  readonly envelopeTtlMs: number;
  readonly seenTtlMs: number;
  readonly authSeenTtlMs: number;
  readonly agentCardTtlMs: number;
  private readonly now: () => number;
  constructor(options?: InMemoryRelayOptions | ((e: SignedEnvelope) => SignedEnvelope)) {
    const config = typeof options === 'function' ? { tamper: options } : (options ?? {});
    this.notificationKey = config.notificationKey ?? generateKeyPair();
    this.wake = config.wake;
    if (this.wake) {
      positiveLimit(this.wake.maxAttempts, 5);
      positiveLimit(this.wake.retryBaseMs, 1000);
      if (positiveLimit(this.wake.timeoutMs, 5000) > 2_147_483_647) throw new Error('INVALID_RELAY_LIMIT');
      const url = new URL(this.wake.relay);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new Error('INVALID_REQUEST');
    }
    this.notificationTtlMs = positiveLimit(config.notificationTtlMs, DEFAULT_SEEN_TTL_MS);
    this.tamper = config.tamper;
    this.requireAuth = config.requireAuth ?? false;
    this.allowUnboundRelayAuth = config.allowUnboundRelayAuth ?? false;
    this.maxSeenEntries = positiveLimit(config.maxSeenEntries, DEFAULT_MAX_SEEN_ENTRIES);
    this.maxAuthSeenEntries = positiveLimit(
      config.maxAuthSeenEntries,
      this.maxSeenEntries,
    );
    this.maxQueues = positiveLimit(config.maxQueues, DEFAULT_MAX_QUEUES);
    this.maxQueueSize = positiveLimit(config.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE);
    this.maxEnvelopeBytes = positiveLimit(config.maxEnvelopeBytes, DEFAULT_MAX_ENVELOPE_BYTES);
    this.maxQueueBytesPerRecipient = positiveLimit(
      config.maxQueueBytesPerRecipient,
      DEFAULT_MAX_QUEUE_BYTES_PER_RECIPIENT,
    );
    this.maxEnvelopesPerSender = positiveLimit(
      config.maxEnvelopesPerSender,
      this.maxQueueSize,
    );
    this.maxAgents = positiveLimit(config.maxAgents, DEFAULT_MAX_AGENTS);
    this.envelopeTtlMs = positiveLimit(config.envelopeTtlMs, DEFAULT_ENVELOPE_TTL_MS);
    this.seenTtlMs = positiveLimit(config.seenTtlMs, DEFAULT_SEEN_TTL_MS);
    this.authSeenTtlMs = positiveLimit(config.authSeenTtlMs, DEFAULT_AUTH_SEEN_TTL_MS);
    this.agentCardTtlMs = positiveLimit(config.agentCardTtlMs, DEFAULT_AGENT_CARD_TTL_MS);
    this.now = config.now ?? Date.now;
  }
  private remember(map: Map<string, number>, key: string, limit: number, ttlMs: number): void {
    const now = this.now();
    for (const [entry, expiresAt] of map) if (expiresAt <= now) map.delete(entry);
    if (map.size >= limit) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, now + ttlMs);
    this.version++;
  }
  authenticate(
    recipientDid: string,
    token?: string,
    action?: RelayAuthAction,
    check?: RelayAuthContext,
  ): boolean {
    this.evictExpired();
    const result = verifyRelayAuthToken(token ?? '', recipientDid, {
      expectedOrigin: check?.expectedOrigin,
      requireOrigin: check?.requireOrigin,
    });
    if (!result.valid) {
      if (
        result.reason === 'RELAY_AUTH_ORIGIN_MISMATCH' ||
        result.reason === 'RELAY_AUTH_ORIGIN_REQUIRED'
      )
        throw new Error(result.reason);
      return false;
    }
    if (action !== undefined && result.action !== action) return false;
    const key = recipientDid + ':' + result.nonce;
    if (this.authSeen.has(key)) return false;
    this.remember(this.authSeen, key, this.maxAuthSeenEntries, this.authSeenTtlMs);
    return true;
  }
  private stateForTask(taskId: string): TaskRoleState {
    let state = this.taskStates.get(taskId);
    if (!state) {
      if (this.taskStates.size >= this.maxSeenEntries) {
        const oldest = this.taskStates.keys().next().value;
        if (oldest !== undefined) this.taskStates.delete(oldest);
      }
      state = { crossRole: new Map(), pendingAckRoles: [], workerSeq: 0, requesterSeq: 0 };
      this.taskStates.set(taskId, state);
    }
    return state;
  }
  /** Authenticate once for a long poll or persistent stream, then read only this inbox. */
  openInbox(
    recipientDid: string,
    token?: string,
    action: RelayAuthAction = 'receive',
    check?: RelayAuthContext,
    filter?: RelayReceiveFilter,
  ): () => SignedEnvelope | undefined {
    const normalized = normalizeReceiveFilter(filter);
    if (!this.authenticate(recipientDid, token, action, check))
      throw new Error('RELAY_UNAUTHORIZED');
    if (normalized.peek) {
      const seenInPeek = new Set<string>();
      return () => this.dequeue(recipientDid, filter, seenInPeek);
    }
    return () => this.dequeue(recipientDid, filter);
  }
  private ensureQueue(did: string): StoredEnvelope[] {
    let queue = this.queues.get(did);
    if (!queue) {
      if (this.queues.size >= this.maxQueues) throw new Error('RELAY_CAPACITY');
      queue = [];
      this.queues.set(did, queue);
    }
    return queue;
  }
  private putOperation(id: string, operation: RelayOperation): void {
    // Each kind has its own cap; notification traffic cannot consume queue capacity.
    if (!this.operations.has(id)) {
      const same = [...this.operations].filter(([, row]) => row.kind === operation.kind);
      if (same.length >= this.maxSeenEntries) this.operations.delete(same[0]![0]);
    }
    this.operations.set(id, operation);
    this.version++;
  }
  registerWake(recipientDid: string, channel: string | null, token?: string, check?: RelayAuthContext): void {
    if (!this.authenticate(recipientDid, token, 'receive', check)) throw new Error('RELAY_UNAUTHORIZED');
    if (channel === null) {
      this.operations.delete('registration:' + recipientDid);
      for (const [id, op] of this.operations)
        if (op.kind === 'wake' && op.recipientDid === recipientDid) this.operations.delete(id);
      this.version++;
      return;
    }
    if (!this.wake || !Object.hasOwn(this.wake.channels, channel)) throw new Error('INVALID_REQUEST');
    this.putOperation('registration:' + recipientDid, {
      kind: 'registration', recipientDid, channel, expiresAt: this.now() + this.notificationTtlMs,
    });
  }
  private queueWake(envelope: SignedEnvelope): void {
    const { recipientDid, taskId } = envelope.payload;
    if (!this.wake || this.listeners.get(recipientDid)?.size) return;
    const reg = this.operations.get('registration:' + recipientDid);
    const id = 'wake:' + recipientDid + ':' + taskId;
    if (reg?.kind !== 'registration' || reg.expiresAt <= this.now() || this.operations.has(id)) return;
    this.putOperation(id, { kind: 'wake', recipientDid, taskId, channel: reg.channel,
      attempts: 0, nextAttempt: this.now(), done: false, expiresAt: this.now() + this.notificationTtlMs });
  }
  /** Claim inside a durable mutation turn and persist before invoking the channel. */
  claimWakeNotification(): RelayWakeAttempt | undefined {
    if (!this.wake) return;
    for (const [id, op] of this.operations) {
      if (op.kind !== 'wake' || op.done || op.nextAttempt > this.now() || op.expiresAt <= this.now()) continue;
      const registration = this.operations.get('registration:' + op.recipientDid);
      if (op.attempts >= (this.wake.maxAttempts ?? 5) || registration?.kind !== 'registration' ||
          registration.expiresAt <= this.now() || registration.channel !== op.channel ||
          this.listeners.get(op.recipientDid)?.size ||
          !this.queues.get(op.recipientDid)?.some(item => item.expiresAt > this.now() && item.envelope.payload.taskId === op.taskId)) {
        op.done = true;
        this.version++;
        continue;
      }
      const channel = this.wake.channels[op.channel];
      if (!channel || !Object.hasOwn(this.wake.channels, op.channel)) continue;
      op.attempts++;
      op.nextAttempt = this.now() + Math.min(60_000, (this.wake.retryBaseMs ?? 1000) * 2 ** Math.min(op.attempts - 1, 16));
      this.version++;
      return { id, attempt: op.attempts, deliver: channel, timeoutMs: this.wake.timeoutMs ?? 5000,
        notice: signPayload({ recipientDid: op.recipientDid, taskId: op.taskId, relay: this.wake.relay }, this.notificationKey) };
    }
  }
  /** Run outside the durable mutation turn so notification latency cannot stall inbox delivery. */
  async deliverWakeNotification(attempt: RelayWakeAttempt): Promise<boolean> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        attempt.deliver(attempt.notice, controller.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new Error('WAKE_TIMEOUT'));
        }, attempt.timeoutMs); }),
      ]);
      return !controller.signal.aborted;
    } catch { return false; }
    finally { clearTimeout(timer); }
  }
  completeWakeNotification(attempt: RelayWakeAttempt, delivered: boolean): void {
    const op = this.operations.get(attempt.id);
    if (op?.kind !== 'wake' || op.attempts !== attempt.attempt) return;
    op.done = delivered || op.attempts >= (this.wake?.maxAttempts ?? 5);
    if (!op.done)
      op.nextAttempt = this.now() + Math.min(60_000, (this.wake?.retryBaseMs ?? 1000) * 2 ** Math.min(op.attempts - 1, 16));
    this.version++;
  }
  /** In-memory hosts call periodically; durable hosts commit claims and completion separately. */
  flushWakeNotifications(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      let attempt: RelayWakeAttempt | undefined;
      while ((attempt = this.claimWakeNotification())) {
        const delivered = await this.deliverWakeNotification(attempt);
        this.completeWakeNotification(attempt, delivered);
      }
    })().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }
  getDeliveryStatus(recipientDid: string, envelopeId: string, senderDid: string, relay: string,
    token?: string, check?: RelayAuthContext): SignedRelayDeliveryStatus {
    if (!this.authenticate(senderDid, token, 'receive', check)) throw new Error('RELAY_UNAUTHORIZED');
    const expired = this.operations.get('expiry:' + envelopeId);
    if (expired?.kind === 'expiry' && expired.notice.payload.senderDid === senderDid &&
        expired.notice.payload.recipientDid === recipientDid)
      return signPayload({ ...expired.notice.payload, relay }, this.notificationKey);
    const item = this.queues.get(recipientDid)?.find(row => row.envelope.payload.envelopeId === envelopeId && row.envelope.payload.senderDid === senderDid);
    return signPayload({ type: 'RelayDeliveryStatus', state: item ? 'pending' : 'unknown', envelopeId,
      senderDid, recipientDid, relay,
      ...(item ? { taskId: item.envelope.payload.taskId, expiresAt: item.expiresAt } : {}),
    }, this.notificationKey);
  }
  /** Drop queued envelopes, replay ids, and agent cards whose TTL has elapsed. */
  evictExpired(): void {
    const now = this.now();
    let changed = false;
    for (const [id, op] of this.operations) if (op.expiresAt <= now) {
      this.operations.delete(id); changed = true;
    }
    for (const [did, queue] of this.queues) {
      const live = queue.filter((item) => {
        if (item.expiresAt > now) return true;
        const { envelopeId, senderDid, recipientDid, taskId } = item.envelope.payload;
        this.putOperation('expiry:' + envelopeId, { kind: 'expiry', expiresAt: now + this.notificationTtlMs,
          notice: signPayload({ type: 'RelayDeliveryStatus', state: 'expired', envelopeId, senderDid,
            recipientDid, taskId, relay: this.wake?.relay ?? '', expiresAt: item.expiresAt }, this.notificationKey) });
        return false;
      });
      if (live.length === queue.length) continue;
      changed = true;
      if (live.length || this.listeners.get(did)?.size) this.queues.set(did, live);
      else this.queues.delete(did);
    }
    for (const map of [this.seen, this.authSeen, this.agentExpiry]) {
      for (const [key, expiresAt] of map) {
        if (expiresAt > now) continue;
        map.delete(key);
        changed = true;
        if (map === this.agentExpiry) this.agents.delete(key);
      }
    }
    for (const [key, card] of this.agents) {
      const expiresAt = this.agentExpiry.get(key);
      if ((expiresAt !== undefined && expiresAt <= now) || !verifySignedAgentCard(card, now)) {
        this.agents.delete(key);
        this.agentExpiry.delete(key);
        changed = true;
      }
    }
    if (changed) this.version++;
  }
  private queuedBytes(queue: StoredEnvelope[]): number {
    let total = 0;
    for (const item of queue) total += item.bytes;
    return total;
  }
  private senderCount(queue: StoredEnvelope[], senderDid: string): number {
    let total = 0;
    for (const item of queue) if (item.envelope.payload.senderDid === senderDid) total++;
    return total;
  }
  send(envelope: SignedEnvelope): void {
    if (!verifyRelayEnvelope(envelope)) throw new Error('INVALID_ENVELOPE');
    this.evictExpired();
    if (this.seen.has(envelope.payload.envelopeId) || this.operations.has('expiry:' + envelope.payload.envelopeId)) throw new Error('REPLAYED_ENVELOPE');
    const did = envelope.payload.recipientDid;
    const queue = this.queues.get(did) ?? [];
    const bytes = Buffer.byteLength(JSON.stringify(envelope));
    if (!this.queues.has(did) && this.queues.size >= this.maxQueues)
      throw new Error('RELAY_CAPACITY');
    if (queue.length >= this.maxQueueSize || bytes > this.maxEnvelopeBytes)
      throw new Error('RELAY_CAPACITY');
    if (this.queuedBytes(queue) + bytes > this.maxQueueBytesPerRecipient)
      throw new Error('QUEUE_BYTES_EXCEEDED');
    if (this.senderCount(queue, envelope.payload.senderDid) >= this.maxEnvelopesPerSender)
      throw new Error('SENDER_QUOTA_EXCEEDED');
    this.remember(this.seen, envelope.payload.envelopeId, this.maxSeenEntries, this.seenTtlMs);
    const role = classifyEnvelopeRole(envelope, CONNECTION_CONTROL_EVENTS.has(envelope.payload.eventType)
      ? undefined : this.stateForTask(envelope.payload.taskId));
    const wire = structuredClone(envelope);
    const stored = this.tamper ? this.tamper(wire) : wire;
    queue.push({
      envelope: stored,
      bytes: Buffer.byteLength(JSON.stringify(stored)),
      expiresAt: this.now() + this.envelopeTtlMs,
      role,
    });
    this.queues.set(did, queue);
    this.queueWake(envelope);
    for (const fn of [...(this.listeners.get(did) ?? [])]) fn();
  }
  receive(
    recipientDid: string,
    authToken?: string | number,
    _signal?: AbortSignal,
    checkOrFilter?: RelayAuthContext | RelayReceiveFilter,
    maybeFilter?: RelayReceiveFilter,
  ): SignedEnvelope | undefined {
    const isFilter =
      checkOrFilter !== undefined &&
      ('role' in checkOrFilter || 'taskId' in checkOrFilter || 'peek' in checkOrFilter || 'lease' in checkOrFilter);
    const check = isFilter ? undefined : (checkOrFilter as RelayAuthContext | undefined);
    const filter = isFilter ? (checkOrFilter as RelayReceiveFilter) : maybeFilter;
    const normalized = normalizeReceiveFilter(filter);
    if (
      (typeof authToken === 'string' || this.requireAuth) &&
      !this.authenticate(
        recipientDid,
        typeof authToken === 'string' ? authToken : undefined,
        'receive',
        check,
      )
    )
      throw new Error('RELAY_UNAUTHORIZED');
    return this.dequeue(recipientDid, normalized);
  }
  peek(
    recipientDid: string,
    authTokenOrFilter?: string | Omit<RelayReceiveFilter, 'peek'>,
    check?: RelayAuthContext,
    filter?: Omit<RelayReceiveFilter, 'peek'>,
  ): SignedEnvelope | undefined {
    const authToken = typeof authTokenOrFilter === 'string' ? authTokenOrFilter : undefined;
    const effectiveFilter =
      typeof authTokenOrFilter === 'object' && authTokenOrFilter !== null
        ? authTokenOrFilter
        : filter;
    return this.receive(recipientDid, authToken, undefined, check, {
      ...effectiveFilter,
      peek: true,
    });
  }
  pollInbox(
    recipientDid: string,
    authTokenOrFilter?: string | (RelayReceiveFilter & { waitMs?: number; signal?: AbortSignal }),
    filter?: RelayReceiveFilter,
    check?: RelayAuthContext,
  ): SignedEnvelope | undefined {
    const authToken = typeof authTokenOrFilter === 'string' ? authTokenOrFilter : undefined;
    const effectiveFilter =
      typeof authTokenOrFilter === 'object' && authTokenOrFilter !== null
        ? authTokenOrFilter
        : filter;
    return this.receive(recipientDid, authToken, undefined, check, effectiveFilter);
  }
  private dequeue(
    recipientDid: string,
    filter?: RelayReceiveFilter | NormalizedReceiveFilter,
    seenInPeek?: Set<string>,
  ): SignedEnvelope | undefined {
    this.evictExpired();
    const normalized =
      filter && 'peek' in filter && typeof filter.peek === 'boolean' && !('taskId' in filter)
        ? (filter as NormalizedReceiveFilter)
        : normalizeReceiveFilter(filter as RelayReceiveFilter | undefined);
    const q = this.queues.get(recipientDid);
    if (!q || !q.length) return undefined;
    const index = q.findIndex(
      (item) =>
        (normalized.peek || (item.leasedUntil ?? 0) <= this.now()) &&
        matchesStoredEnvelope(item, normalized) &&
        (!seenInPeek || !seenInPeek.has(item.envelope.payload.envelopeId)),
    );
    if (index < 0) return undefined;
    const item = normalized.peek || normalized.lease ? q[index] : q.splice(index, 1)[0];
    if (item && normalized.lease && !normalized.peek) item.leasedUntil = Math.min(item.expiresAt, this.now() + 30_000);
    if (!normalized.peek) {
      if (!q.length && !this.listeners.get(recipientDid)?.size) this.queues.delete(recipientDid);
      if (item) this.version++;
    } else if (item && seenInPeek) {
      seenInPeek.add(item.envelope.payload.envelopeId);
    }
    if (item && !verifyRelayEnvelope(item.envelope, recipientDid))
      throw new Error('RELAY_TAMPERING_DETECTED');
    return item ? (normalized.peek ? structuredClone(item.envelope) : item.envelope) : undefined;
  }
  /** Recipient-authenticated removal of one queued envelope. False when it is not queued. */
  acknowledge(
    recipientDid: string,
    envelopeId: string,
    token?: string,
    check?: RelayAuthContext,
  ): boolean {
    this.evictExpired();
    if (!this.authenticate(recipientDid, token, 'receive', check))
      throw new Error('RELAY_UNAUTHORIZED');
    const queue = this.queues.get(recipientDid);
    if (!queue) return false;
    const index = queue.findIndex((item) => item.envelope.payload.envelopeId === envelopeId);
    if (index < 0) return false;
    queue.splice(index, 1);
    if (!queue.length && !this.listeners.get(recipientDid)?.size) this.queues.delete(recipientDid);
    this.version++;
    return true;
  }
  /** Seconds until the soonest queued item expires, for Retry-After. */
  retryAfterSeconds(): number {
    const next = this.nextExpiry();
    if (next === undefined) return 60;
    return Math.max(1, Math.ceil((next - this.now()) / 1000));
  }
  nextExpiry(): number | undefined {
    const now = this.now();
    let soonest = Infinity;
    const consider = (value: number) => {
      if (value > now && value < soonest) soonest = value;
    };
    for (const op of this.operations.values()) {
      consider(op.expiresAt);
      if (op.kind === 'wake' && !op.done) consider(Math.max(now + 1, op.nextAttempt));
    }
    for (const queue of this.queues.values()) for (const item of queue) consider(item.expiresAt);
    for (const expiresAt of this.seen.values()) consider(expiresAt);
    for (const expiresAt of this.authSeen.values()) consider(expiresAt);
    for (const expiresAt of this.agentExpiry.values()) consider(expiresAt);
    return Number.isFinite(soonest) ? soonest : undefined;
  }
  withRecipient(key: KeyPair) {
    return {
      send: (e: SignedEnvelope) => this.send(e),
      deliveryStatus: (e: SignedEnvelope) => this.getDeliveryStatus(e.payload.recipientDid, e.payload.envelopeId,
        key.did, this.wake?.relay ?? '', createRelayAuthToken(key)),
      receive: (
        did: string,
        _waitMs?: number,
        signal?: AbortSignal,
        filter?: RelayReceiveFilter,
      ) => this.receive(did, createRelayAuthToken(key), signal, undefined, filter),
      peek: (did: string, filter?: Omit<RelayReceiveFilter, 'peek'>) =>
        this.peek(did, createRelayAuthToken(key), undefined, filter),
      pollInbox: (
        did: string,
        filter?: RelayReceiveFilter & { waitMs?: number; signal?: AbortSignal },
      ) => this.receive(did, createRelayAuthToken(key), filter?.signal, undefined, filter),
      register: (card: SignedAgentCard) => this.register(card),
      discover: () => this.discover(),
    };
  }
  subscribe(did: string, fn: () => void): () => void {
    this.ensureQueue(did);
    const set = this.listeners.get(did) ?? new Set();
    set.add(fn);
    this.listeners.set(did, set);
    return () => {
      set.delete(fn);
      if (!set.size) {
        this.listeners.delete(did);
        if (!this.queues.get(did)?.length) this.queues.delete(did);
      }
    };
  }
  private hasMatching(did: string, filter?: RelayReceiveFilter): boolean {
    const q = this.queues.get(did);
    if (!q?.length) return false;
    const normalized = normalizeReceiveFilter(filter);
    return q.some((item) => (normalized.peek || (item.leasedUntil ?? 0) <= this.now()) && matchesStoredEnvelope(item, normalized));
  }
  async wait(
    did: string,
    ms: number,
    signal?: AbortSignal,
    filter?: RelayReceiveFilter,
  ): Promise<void> {
    this.evictExpired();
    if (signal?.aborted || ms <= 0 || this.hasMatching(did, filter)) return;
    const normalized = normalizeReceiveFilter(filter);
    const leaseWait = (this.queues.get(did) ?? [])
      .filter(item => matchesStoredEnvelope(item, normalized) && (item.leasedUntil ?? 0) > this.now())
      .reduce((delay, item) => Math.min(delay, item.leasedUntil! - this.now()), ms);
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const checkWake = () => {
        if (this.hasMatching(did, filter)) done();
      };
      const off = this.subscribe(did, checkWake),
        timer = setTimeout(done, leaseWait);
      signal?.addEventListener('abort', done, { once: true });
      // Cover the gap between the length check and listener installation.
      if (signal?.aborted || this.hasMatching(did, filter)) done();
    });
  }
  snapshot(): RelaySnapshot {
    this.evictExpired();
    const envelopeExpiry: [string, number][] = [];
    const leaseExpiry: [string, number][] = [];
    const queues: [string, SignedEnvelope[]][] = [];
    for (const [did, queue] of this.queues) {
      const envelopes: SignedEnvelope[] = [];
      for (const item of queue) {
        envelopes.push(item.envelope);
        if (item.leasedUntil) leaseExpiry.push([item.envelope.payload.envelopeId, item.leasedUntil]);
        envelopeExpiry.push([item.envelope.payload.envelopeId, item.expiresAt]);
      }
      queues.push([did, envelopes]);
    }
    return structuredClone({
      operations: [...this.operations],
      queues,
      seen: [...this.seen.keys()],
      authSeen: [...this.authSeen.keys()],
      agents: [...this.agents.values()],
      envelopeExpiry,
      leaseExpiry,
      seenExpiry: [...this.seen],
      authExpiry: [...this.authSeen],
      agentExpiry: [...this.agentExpiry],
    });
  }
  restore(snapshot: RelaySnapshot): void {
    const seenExpiry = new Map(snapshot.seenExpiry ?? []);
    const authExpiry = new Map(snapshot.authExpiry ?? []);
    const envelopeExpiry = new Map(snapshot.envelopeExpiry ?? []);
    const leaseExpiry = new Map(snapshot.leaseExpiry ?? []);
    const agentExpiry = new Map(snapshot.agentExpiry ?? []);
    const now = this.now();
    this.assertValidAgentSnapshot(snapshot, agentExpiry);
    if (
      snapshot.seen.length > this.maxSeenEntries ||
      (snapshot.authSeen?.length ?? 0) > this.maxAuthSeenEntries ||
      snapshot.queues.length > this.maxQueues ||
      snapshot.agents.length > this.maxAgents ||
      snapshot.queues.some(([did, queue]) => {
        if (queue.length > this.maxQueueSize) return true;
        let bytes = 0;
        for (const envelope of queue) {
          if (!verifyRelayEnvelope(envelope, did)) return true;
          bytes += Buffer.byteLength(JSON.stringify(envelope));
          if (bytes > this.maxQueueBytesPerRecipient || bytes > this.maxEnvelopeBytes * queue.length)
            return true;
        }
        return queue.some((envelope) => Buffer.byteLength(JSON.stringify(envelope)) > this.maxEnvelopeBytes);
      })
    )
      throw new Error('INVALID_RELAY_SNAPSHOT');
    this.operations = new Map(structuredClone(snapshot.operations ?? []));
    for (const kind of ['registration', 'wake', 'expiry'])
      if ([...this.operations.values()].filter(op => op.kind === kind).length > this.maxSeenEntries)
        throw new Error('INVALID_RELAY_SNAPSHOT');
    this.queues = new Map();
    this.taskStates = new Map();
    for (const [did, envelopes] of structuredClone(snapshot.queues)) {
      this.queues.set(
        did,
        envelopes.map((envelope) => ({
          envelope,
          leasedUntil: leaseExpiry.get(envelope.payload.envelopeId),
          bytes: Buffer.byteLength(JSON.stringify(envelope)),
          expiresAt:
            envelopeExpiry.get(envelope.payload.envelopeId) ?? this.now() + this.envelopeTtlMs,
          role: classifyEnvelopeRole(envelope, CONNECTION_CONTROL_EVENTS.has(envelope.payload.eventType)
            ? undefined : this.stateForTask(envelope.payload.taskId)),
        })),
      );
    }
    this.seen = new Map(
      snapshot.seen.map((id) => [id, seenExpiry.get(id) ?? this.now() + this.seenTtlMs]),
    );
    this.authSeen = new Map(
      (snapshot.authSeen ?? []).map((id) => [id, authExpiry.get(id) ?? this.now() + this.authSeenTtlMs]),
    );
    this.agents.clear();
    this.agentExpiry.clear();
    for (const card of snapshot.agents) {
      const key = agentRegistryKey(card.payload.ownerDid, card.payload.agentDid);
      const effective = Math.min(
        agentExpiry.get(key) ?? now + this.agentCardTtlMs,
        Date.parse(card.payload.expiresAt),
      );
      if (effective <= now) continue;
      const copy = structuredClone(card);
      this.agents.set(key, copy);
      this.agentExpiry.set(key, effective);
    }
    this.version++;
  }
  /** Authenticate even expired cards before allowing restore to discard them. */
  private assertValidAgentSnapshot(snapshot: RelaySnapshot, agentExpiry: Map<string, number>): void {
    if (!Array.isArray(snapshot.agents)) throw new Error('INVALID_AGENT_SNAPSHOT');
    const seen = new Set<string>();
    for (const card of snapshot.agents) {
      // Verification at the last millisecond of its lifetime skips only current
      // expiry, retaining all signature, delegation, structure and TTL checks.
      const expiresAt = Date.parse(card?.payload?.expiresAt);
      if (!verifySignedAgentCard(card, expiresAt - 1))
        throw new Error('INVALID_AGENT_SNAPSHOT');
      const key = agentRegistryKey(card.payload.ownerDid, card.payload.agentDid);
      const stored = agentExpiry.get(key);
      if (seen.has(key) || (stored !== undefined && !Number.isFinite(stored)))
        throw new Error('INVALID_AGENT_SNAPSHOT');
      seen.add(key);
    }
  }
  discover(): SignedAgentCard[] {
    this.evictExpired();
    const now = this.now();
    return structuredClone(
      [...this.agents.values()].filter((card) => verifySignedAgentCard(card, now)),
    );
  }
  register(card: SignedAgentCard): void {
    if (!verifySignedAgentCard(card, this.now())) throw new Error('INVALID_AGENT_CARD');
    this.evictExpired();
    // A different ownerDid is a different registry entry and cannot squat this agentDid.
    const key = agentRegistryKey(card.payload.ownerDid, card.payload.agentDid);
    const old = this.agents.get(key);
    if (old && Date.parse(old.signature.signedAt) > Date.parse(card.signature.signedAt))
      throw new Error('AGENT_OWNER_OR_VERSION_MISMATCH');
    if (!old && this.agents.size >= this.maxAgents) throw new Error('RELAY_CAPACITY');
    const copy = structuredClone(card);
    const expiresAt = Math.min(this.now() + this.agentCardTtlMs, Date.parse(copy.payload.expiresAt));
    if (!(expiresAt > this.now())) throw new Error('INVALID_AGENT_CARD');
    this.agents.set(key, copy);
    this.agentExpiry.set(key, expiresAt);
    this.version++;
  }
}
export interface RelayAuthContext {
  expectedOrigin?: string;
  requireOrigin?: boolean;
}
export interface RelayRequestAuthOptions {
  allowQueryAuth?: boolean;
  requireOrigin?: boolean;
  allowUnboundRelayAuth?: boolean;
}
export interface RelayFetchOptions extends RelayRequestAuthOptions {
  relay?: InMemoryRelay;
  agentCard?: SignedAgentCard;
  deferNotifications?: boolean;
}
/** Defensive headers for any relay URL opened directly in a browser. */
export function relayHttpHeaders(kind: 'json' | 'empty' | 'sse' = 'json'): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cache-control': kind === 'sse' ? 'no-cache, no-store' : 'no-store',
    ...(kind === 'json' ? { 'content-type': 'application/json; charset=utf-8' } : {}),
    ...(kind === 'sse' ? { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' } : {}),
  };
}
function relayJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: relayHttpHeaders('json') });
}
/**
 * Protocol codes the relay may place in an HTTP or WebSocket error body.
 * A thrown message is returned only when it matches one of these strings exactly.
 * Names that the live relay does not throw today stay listed so a later
 * constant code is not replaced by RELAY_INTERNAL_ERROR.
 */
export const KNOWN_RELAY_ERROR_CODES = [
  'INVALID_ENVELOPE',
  'INVALID_SIGNED_ENVELOPE',
  'ENVELOPE_EXPIRED',
  'REPLAYED_ENVELOPE',
  'DUPLICATE_ENVELOPE_ID',
  'ENVELOPE_TOO_LARGE',
  'RELAY_CAPACITY',
  'RELAY_QUEUE_FULL',
  'QUEUE_BYTES_EXCEEDED',
  'QUEUE_LIMIT_EXCEEDED',
  'RELAY_BYTE_BUDGET_EXCEEDED',
  'SENDER_QUOTA_EXCEEDED',
  'INVALID_RECIPIENT_DID',
  'MISSING_RECIPIENT_DID',
  'INVALID_DID',
  'RELAY_TAMPERING_DETECTED',
  'INVALID_AGENT_CARD',
  'INVALID_AGENT_SNAPSHOT',
  'AMBIGUOUS_AGENT_CARD_OWNER',
  'AGENT_CARD_EXPIRED',
  'AGENT_CARD_EXPIRY_TOO_LONG',
  'AGENT_CARD_DELEGATION_REQUIRED',
  'AGENT_DELEGATION_REQUIRED',
  'AGENT_CARD_DELEGATION_INVALID',
  'AGENT_CARD_TOO_LARGE',
  'AGENT_REGISTRY_FULL',
  'AGENT_CARD_TTL_INVALID',
  'AGENT_OWNER_OR_VERSION_MISMATCH',
  'NO_AGENT_REGISTERED',
  'RELAY_UNAUTHORIZED',
  'RELAY_AUTH_REQUIRED',
  'RELAY_AUTH_INVALID',
  'RELAY_AUTH_SIGNATURE_INVALID',
  'RELAY_AUTH_RECIPIENT_MISMATCH',
  'RELAY_AUTH_ACTION_MISMATCH',
  'RELAY_AUTH_EXPIRED',
  'RELAY_AUTH_FUTURE_ISSUED_AT',
  'RELAY_AUTH_REPLAYED',
  'RELAY_AUTH_NONCE_INVALID',
  'RELAY_AUTH_ORIGIN_REQUIRED',
  'RELAY_AUTH_ORIGIN_MISMATCH',
  'RELAY_QUERY_AUTH_DISABLED',
  'INVALID_RELAY_ORIGIN',
  'RATE_LIMITED',
  'RATE_LIMITER_UNAVAILABLE',
  'PAYLOAD_TOO_LARGE',
  'BODY_TOO_LARGE',
  'MISSING_BODY',
  'INVALID_JSON',
  'INVALID_UNICODE',
  'INVALID_LIMIT',
  'INVALID_RELAY_LIMIT',
  'INVALID_TIMEOUT',
  'INVALID_WAIT',
  'MISSING_ENVELOPE_ID',
  'UNSUPPORTED_METHOD',
  'NOT_FOUND',
  'WEBSOCKET_UPGRADE_REQUIRED',
  'INVALID_REQUEST',
  'INVALID_RELAY_SNAPSHOT',
  'RELAY_INTERNAL_ERROR',
] as const;
const KNOWN_RELAY_ERROR_CODE_SET: ReadonlySet<string> = new Set(KNOWN_RELAY_ERROR_CODES);
/** HTTP status for each public code. Anything else is 500 RELAY_INTERNAL_ERROR. */
const RELAY_ERROR_STATUS: Readonly<Record<string, number>> = {
  INVALID_ENVELOPE: 400,
  INVALID_SIGNED_ENVELOPE: 400,
  ENVELOPE_EXPIRED: 400,
  REPLAYED_ENVELOPE: 400,
  DUPLICATE_ENVELOPE_ID: 400,
  ENVELOPE_TOO_LARGE: 400,
  RELAY_CAPACITY: 400,
  RELAY_QUEUE_FULL: 400,
  INVALID_RECIPIENT_DID: 400,
  MISSING_RECIPIENT_DID: 400,
  INVALID_DID: 400,
  RELAY_TAMPERING_DETECTED: 400,
  INVALID_AGENT_CARD: 400,
  INVALID_AGENT_SNAPSHOT: 400,
  AMBIGUOUS_AGENT_CARD_OWNER: 409,
  AGENT_CARD_EXPIRED: 400,
  AGENT_CARD_EXPIRY_TOO_LONG: 400,
  AGENT_CARD_DELEGATION_REQUIRED: 400,
  AGENT_DELEGATION_REQUIRED: 400,
  AGENT_CARD_DELEGATION_INVALID: 400,
  AGENT_CARD_TOO_LARGE: 400,
  AGENT_REGISTRY_FULL: 400,
  AGENT_CARD_TTL_INVALID: 400,
  AGENT_OWNER_OR_VERSION_MISMATCH: 400,
  INVALID_RELAY_ORIGIN: 400,
  PAYLOAD_TOO_LARGE: 400,
  BODY_TOO_LARGE: 400,
  MISSING_BODY: 400,
  INVALID_JSON: 400,
  INVALID_UNICODE: 400,
  INVALID_LIMIT: 400,
  INVALID_RELAY_LIMIT: 400,
  INVALID_TIMEOUT: 400,
  INVALID_WAIT: 400,
  MISSING_ENVELOPE_ID: 400,
  UNSUPPORTED_METHOD: 400,
  WEBSOCKET_UPGRADE_REQUIRED: 400,
  INVALID_REQUEST: 400,
  INVALID_RELAY_SNAPSHOT: 400,
  RELAY_UNAUTHORIZED: 401,
  RELAY_AUTH_REQUIRED: 401,
  RELAY_AUTH_INVALID: 401,
  RELAY_AUTH_SIGNATURE_INVALID: 401,
  RELAY_AUTH_RECIPIENT_MISMATCH: 401,
  RELAY_AUTH_ACTION_MISMATCH: 401,
  RELAY_AUTH_EXPIRED: 401,
  RELAY_AUTH_FUTURE_ISSUED_AT: 401,
  RELAY_AUTH_REPLAYED: 401,
  RELAY_AUTH_NONCE_INVALID: 401,
  RELAY_AUTH_ORIGIN_REQUIRED: 401,
  RELAY_AUTH_ORIGIN_MISMATCH: 401,
  RELAY_QUERY_AUTH_DISABLED: 401,
  QUEUE_BYTES_EXCEEDED: 429,
  QUEUE_LIMIT_EXCEEDED: 429,
  RELAY_BYTE_BUDGET_EXCEEDED: 429,
  SENDER_QUOTA_EXCEEDED: 429,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  NO_AGENT_REGISTERED: 404,
  RATE_LIMITER_UNAVAILABLE: 503,
  RELAY_INTERNAL_ERROR: 500,
};
if (
  KNOWN_RELAY_ERROR_CODE_SET.size !== KNOWN_RELAY_ERROR_CODES.length ||
  KNOWN_RELAY_ERROR_CODES.some((code) => RELAY_ERROR_STATUS[code] === undefined) ||
  Object.keys(RELAY_ERROR_STATUS).some((code) => !KNOWN_RELAY_ERROR_CODE_SET.has(code))
)
  throw new Error('RELAY_ERROR_CATALOG_MISMATCH');
function malformedClientCode(error: unknown): string | undefined {
  if (error instanceof SyntaxError || error instanceof URIError) return 'INVALID_REQUEST';
  if (error instanceof TypeError && error.message === 'Invalid URL') return 'INVALID_REQUEST';
  return undefined;
}
/**
 * Public error code for an untrusted caller.
 * Parser and URL failures become INVALID_REQUEST. Any other message is returned
 * only when it is an allowlisted code; otherwise the result is the fallback
 * when that fallback is itself allowlisted, or RELAY_INTERNAL_ERROR.
 */
export function sanitizeRelayErrorCode(error: unknown, fallback = 'RELAY_INTERNAL_ERROR'): string {
  const raw =
    malformedClientCode(error) ?? (error instanceof Error ? error.message : String(error));
  if (KNOWN_RELAY_ERROR_CODE_SET.has(raw)) return raw;
  return KNOWN_RELAY_ERROR_CODE_SET.has(fallback) ? fallback : 'RELAY_INTERNAL_ERROR';
}
export interface MappedRelayError {
  status: number;
  error: string;
}
/** Status and public code for one relay failure. Internal detail never leaves this function. */
export function mapRelayError(error: unknown): MappedRelayError {
  const code = sanitizeRelayErrorCode(error);
  return { status: RELAY_ERROR_STATUS[code] ?? 500, error: code };
}
/** Auth failures that must stay 401s with a stable error code. */
export function relayAuthFailure(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = sanitizeRelayErrorCode(error);
  return RELAY_ERROR_STATUS[code] === 401 ? code : undefined;
}
export function relayErrorResponse(error: unknown, relay?: InMemoryRelay): Response {
  const mapped = mapRelayError(error);
  if (mapped.status === 429) {
    return Response.json(
      { error: mapped.error },
      {
        status: 429,
        headers: {
          ...relayHttpHeaders('json'),
          'retry-after': String(relay?.retryAfterSeconds() ?? 60),
        },
      },
    );
  }
  return relayJson({ error: mapped.error }, mapped.status);
}
/**
 * Bearer credential for a relay request.
 * `?auth=` is ignored unless `allowQueryAuth` is set, so tokens do not land in
 * access logs, proxy logs, or Referer headers by default.
 */
export function extractRelayAuthToken(
  request: Request,
  options: { allowQueryAuth?: boolean } = {},
  url = new URL(request.url),
): string | undefined {
  if (url.searchParams.has('auth') && options.allowQueryAuth !== true)
    throw new Error('RELAY_QUERY_AUTH_DISABLED');
  return (
    request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1] ??
    request.headers.get('x-acp-relay-auth') ??
    (options.allowQueryAuth === true ? (url.searchParams.get('auth') ?? undefined) : undefined)
  );
}
export function relayRequestToken(
  request: Request,
  url = new URL(request.url),
  options?: { allowQueryAuth?: boolean },
): string | undefined {
  return extractRelayAuthToken(request, options, url);
}
export function relayAuthContext(
  request: Request,
  relay: InMemoryRelay,
  options: RelayRequestAuthOptions = {},
): RelayAuthContext {
  const requireOrigin =
    options.requireOrigin ??
    !(options.allowUnboundRelayAuth === true || relay.allowUnboundRelayAuth);
  return { expectedOrigin: new URL(request.url).origin, requireOrigin };
}
export type DurableLongPoll =
  | { mode: 'response'; response: Response }
  | {
      mode: 'wait';
      recipient: string;
      waitMs: number;
      filter?: RelayReceiveFilter;
      receive: () => SignedEnvelope | undefined;
    };
/**
 * Authenticate a long-poll and pop envelopes that are already queued.
 * The caller waits outside the durable-object lock when the inbox is empty.
 */
export function beginDurableLongPoll(
  relay: InMemoryRelay,
  request: Request,
  auth: RelayRequestAuthOptions = {},
): DurableLongPoll {
  try {
    const url = new URL(request.url);
    const path = canonicalRelayPath(url.pathname);
    const recipient = inboxRecipientFromRequest(path, url) ?? '';
    resolveDid(recipient);
    const ms = Number(url.searchParams.get('waitMs'));
    if (!url.searchParams.has('waitMs') || !Number.isFinite(ms) || ms < 0)
      throw new Error('INVALID_WAIT');
    const filter = parseReceiveFilterFromUrl(url);
    const token = extractRelayAuthToken(request, auth, url);
    // A request that is already aborted must not authenticate or pop.
    if (request.signal.aborted) return { mode: 'response', response: relayJson({ envelopes: [] }) };
    const receive = relay.openInbox(
      recipient,
      token,
      'receive',
      relayAuthContext(request, relay, auth),
      filter,
    );
    if (request.signal.aborted) return { mode: 'response', response: relayJson({ envelopes: [] }) };
    const buffered: SignedEnvelope[] = [];
    let envelope: SignedEnvelope | undefined;
    while ((envelope = receive())) buffered.push(envelope);
    if (buffered.length) return { mode: 'response', response: relayJson({ envelopes: buffered }) };
    return { mode: 'wait', recipient, waitMs: Math.min(ms, 30000), filter, receive };
  } catch (error) {
    return { mode: 'response', response: relayErrorResponse(error, relay) };
  }
}
export function createRelayFetchHandler(
  options: RelayFetchOptions = {},
): (request: Request) => Promise<Response> {
  const relay = options.relay ?? new InMemoryRelay();
  const authOptions: RelayRequestAuthOptions = {
    allowQueryAuth: options.allowQueryAuth,
    requireOrigin: options.requireOrigin,
    allowUnboundRelayAuth: options.allowUnboundRelayAuth,
  };
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: relayHttpHeaders('json') });
  const empty = (status: 202 | 204) =>
    new Response(null, { status, headers: relayHttpHeaders('empty') });
  async function body(request: Request): Promise<unknown> {
    const limit = relay.maxEnvelopeBytes;
    if (Number(request.headers.get('content-length')) > limit) throw new Error('BODY_TOO_LARGE');
    const reader = request.body?.getReader();
    if (!reader) throw new Error('MISSING_BODY');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new Error('BODY_TOO_LARGE');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  return async (request) => {
    try {
      relay.evictExpired();
      const url = new URL(request.url),
        path = canonicalRelayPath(url.pathname);
      if (request.method === 'GET' && path === '/health') return json({ status: 'ok' });
      if (request.method === 'POST' && path === '/agents') {
        relay.register((await body(request)) as SignedAgentCard);
        return json({ registered: true }, 201);
      }
      if (request.method === 'GET' && path === '/agents') {
        const ownerDid = url.searchParams.get('ownerDid');
        const agentDid = url.searchParams.get('agentDid');
        let cards = [...relay.agents.values()];
        if (ownerDid !== null) cards = cards.filter((card) => card.payload.ownerDid === ownerDid);
        if (agentDid !== null) cards = cards.filter((card) => card.payload.agentDid === agentDid);
        return json(cards);
      }
      if (request.method === 'GET' && path.startsWith('/agents/')) {
        const segments = path
          .slice('/agents/'.length)
          .split('/')
          .filter((segment) => segment.length > 0)
          .map((segment) => decodeURIComponent(segment));
        const card =
          segments.length === 2
            ? relay.agents.get(agentRegistryKey(segments[0]!, segments[1]!))
            : segments.length === 1
              ? selectAgentCard(relay.agents.values(), segments[0]!)
              : undefined;
        return card ? json(card) : json({ error: 'NOT_FOUND' }, 404);
      }
      if (request.method === 'GET' && path === '/.well-known/agent.json') {
        const card = options.agentCard ?? relay.agents.values().next().value;
        return card ? json(toA2AAgentCard(card)) : json({ error: 'NO_AGENT_REGISTERED' }, 404);
      }
      if (request.method === 'POST' && path === '/wake') {
        const recipient = url.searchParams.get('recipient') ?? '';
        resolveDid(recipient);
        const value = await body(request) as { channel?: unknown };
        if (value.channel !== null && typeof value.channel !== 'string') throw new Error('INVALID_REQUEST');
        relay.registerWake(recipient, value.channel, extractRelayAuthToken(request, authOptions, url),
          relayAuthContext(request, relay, authOptions));
        return json({ registered: value.channel !== null, relayDid: relay.notificationDid });
      }
      if (request.method === 'GET' && path === '/delivery-status') {
        const recipient = url.searchParams.get('recipient') ?? '';
        const sender = url.searchParams.get('sender') ?? '';
        resolveDid(recipient); resolveDid(sender);
        const id = url.searchParams.get('envelopeId') ?? '';
        if (!id) throw new Error('MISSING_ENVELOPE_ID');
        return json(relay.getDeliveryStatus(recipient, id, sender, url.origin,
          extractRelayAuthToken(request, authOptions, url), relayAuthContext(request, relay, authOptions)));
      }
      if (request.method === 'POST' && path === '/envelopes') {
        relay.send((await body(request)) as SignedEnvelope);
        if (!options.deferNotifications) void relay.flushWakeNotifications().catch(() => {});
        return new Response(null, { status: 202, headers: { ...relayHttpHeaders('empty'),
          'x-acp-relay-did': relay.notificationDid } });
      }
      if (
        request.method === 'DELETE' &&
        (path === '/envelopes' || path.startsWith('/envelopes/'))
      ) {
        const envelopeId = path.startsWith('/envelopes/')
          ? decodeURIComponent(path.slice('/envelopes/'.length))
          : (url.searchParams.get('id') ?? '');
        if (!envelopeId) throw new Error('MISSING_ENVELOPE_ID');
        const recipient = url.searchParams.get('recipient') ?? '';
        resolveDid(recipient);
        const removed = relay.acknowledge(
          recipient,
          envelopeId,
          extractRelayAuthToken(request, authOptions, url),
          relayAuthContext(request, relay, authOptions),
        );
        return removed ? empty(204) : json({ error: 'NOT_FOUND' }, 404);
      }
      const inboxRecipient =
        request.method === 'GET' ? inboxRecipientFromRequest(path, url) : undefined;
      if (request.method === 'GET' && inboxRecipient !== undefined) {
        const recipient = inboxRecipient;
        resolveDid(recipient);
        const ms = url.searchParams.has('waitMs')
          ? Number(url.searchParams.get('waitMs'))
          : undefined;
        if (ms !== undefined && (!Number.isFinite(ms) || ms < 0)) throw new Error('INVALID_WAIT');
        const filter = parseReceiveFilterFromUrl(url);
        const token = extractRelayAuthToken(request, authOptions, url);
        const receive = relay.openInbox(
          recipient,
          token,
          path === '/stream' ? 'stream' : 'receive',
          relayAuthContext(request, relay, authOptions),
          filter,
        );
        if (path === '/stream') {
          let stop = () => {};
          let flush = () => {};
          // One queued chunk keeps an unread stream from draining the relay queue.
          const stream = new ReadableStream<Uint8Array>(
            {
              start(controller) {
                const encoder = new TextEncoder();
                let closed = false;
                const close = () => {
                  if (closed) return;
                  closed = true;
                  off();
                  clearInterval(heartbeat);
                  request.signal.removeEventListener('abort', close);
                  try {
                    controller.close();
                  } catch {
                    /* Stream cancellation already closed the controller. */
                  }
                };
                flush = () => {
                  if (closed) return;
                  try {
                    let envelope;
                    // Leave envelopes in the bounded recipient queue until the client pulls.
                    while (
                      controller.desiredSize !== null &&
                      controller.desiredSize > 0 &&
                      (envelope = receive())
                    )
                      controller.enqueue(
                        encoder.encode('data: ' + JSON.stringify(envelope) + '\n\n'),
                      );
                  } catch {
                    close();
                  }
                };
                const off = relay.subscribe(recipient, flush);
                const heartbeat = setInterval(() => {
                  if (!closed && controller.desiredSize !== null && controller.desiredSize > 0)
                    controller.enqueue(encoder.encode(': heartbeat\n\n'));
                }, 15000);
                stop = close;
                request.signal.addEventListener('abort', close, { once: true });
                controller.enqueue(encoder.encode(': connected\n\n'));
                flush();
                if (request.signal.aborted) close();
              },
              pull() {
                flush();
              },
              cancel() {
                stop();
              },
            },
            { highWaterMark: 1 },
          );
          return new Response(stream, { headers: relayHttpHeaders('sse') });
        }
        if (!url.searchParams.has('waitMs')) {
          const e = receive();
          return e ? json(e) : empty(204);
        }
        // An already-aborted poll must not pop envelopes that are still queued.
        if (request.signal.aborted) return json({ envelopes: [] });
        const ready: SignedEnvelope[] = [];
        let queued: SignedEnvelope | undefined;
        while ((queued = receive())) ready.push(queued);
        if (!ready.length) {
          await relay.wait(recipient, Math.min(ms!, 30000), request.signal, filter);
          if (request.signal.aborted) return json({ envelopes: [] });
          while ((queued = receive())) ready.push(queued);
        }
        return json({ envelopes: ready });
      }
      return json({ error: 'NOT_FOUND' }, 404);
    } catch (error) {
      return relayErrorResponse(error, relay);
    }
  };
}
