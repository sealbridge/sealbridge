// SPDX-License-Identifier: Apache-2.0
import { verifySignedAgentCard } from '@acp/core/edge';
import type { KeyPair, SignedAgentCard, SignedEnvelope } from '@acp/core/edge';
import { agentRegistryKey } from './fetch.js';
import type { RelayOperation } from './notifications.js';
import type { RelaySnapshot } from './fetch.js';

/**
 * Durable layout for one relay object.
 *
 * A single POST /envelopes writes a constant number of keys: the new envelope
 * (`env:<seq>`), its replay record (`seen:<slot>`), and the fixed-size `meta`
 * object. A single agent registration writes that card (`agentblob:<id>`),
 * its slot pointer (`agentptr:<slot>`), and `meta`. Neither path rewrites the
 * rest of the inbox or the registry, so storage write cost stays O(1) as the
 * number of queued envelopes or registered agents grows.
 */
export interface RelayMeta {
  v: 2;
  notificationKey?: KeyPair;
  operationHead?: number;
  operationTail?: number;
  head: number;
  tail: number;
  seenTail: number;
  seenMod: number;
  authTail: number;
  authMod: number;
  agentCount: number;
  agentGen: number;
}

export interface JournalCursor {
  operationHead: number;
  operationTail: number;
  operationSeq: Map<string, number>;
  head: number;
  tail: number;
  seqById: Map<string, number>;
  orphanSeqs: number[];
  seenTail: number;
  seenMod: number;
  liveSeen: string[];
  authTail: number;
  authMod: number;
  liveAuth: string[];
  agentGen: number;
  agents: { did: string; blob: string }[];
}

export interface JournalPut {
  key: string;
  value: unknown;
}

export interface JournalPlan {
  puts: JournalPut[];
  deletes: string[];
  meta: RelayMeta;
  cursor: JournalCursor;
}

interface StoredQueueItem {
  leasedUntil?: number;
  envelope: SignedEnvelope;
  expiresAt: number;
  bytes: number;
}

interface StoredSeen {
  id: string;
  expiresAt: number;
  seq: number;
}

interface StoredAgent {
  card: SignedAgentCard;
  expiresAt: number;
}

export interface RelayKeyValueStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete?(key: string): Promise<unknown>;
}

export function emptyCursor(seenMod: number, authMod: number): JournalCursor {
  return {
    operationHead: 0,
    operationTail: 0,
    operationSeq: new Map(),
    head: 0,
    tail: 0,
    seqById: new Map(),
    orphanSeqs: [],
    seenTail: 0,
    seenMod,
    liveSeen: [],
    authTail: 0,
    authMod,
    liveAuth: [],
    agentGen: 0,
    agents: [],
  };
}

export function emptyRelaySnapshot(): RelaySnapshot {
  return {
    queues: [],
    seen: [],
    authSeen: [],
    agents: [],
    envelopeExpiry: [],
    seenExpiry: [],
    authExpiry: [],
    agentExpiry: [],
  };
}

function pairMap(pairs: [string, number][] | undefined): Map<string, number> {
  return new Map(pairs ?? []);
}

function registryKey(card: SignedAgentCard): string {
  return agentRegistryKey(card.payload.ownerDid, card.payload.agentDid);
}

function cloneCursor(cursor: JournalCursor): JournalCursor {
  return {
    operationHead: cursor.operationHead,
    operationTail: cursor.operationTail,
    operationSeq: new Map(cursor.operationSeq),
    head: cursor.head,
    tail: cursor.tail,
    seqById: new Map(cursor.seqById),
    orphanSeqs: [...cursor.orphanSeqs],
    seenTail: cursor.seenTail,
    seenMod: cursor.seenMod,
    liveSeen: [...cursor.liveSeen],
    authTail: cursor.authTail,
    authMod: cursor.authMod,
    liveAuth: [...cursor.liveAuth],
    agentGen: cursor.agentGen,
    agents: cursor.agents.map((agent) => ({ ...agent })),
  };
}

/** Diff the desired snapshot against the persisted cursor. Input cursor is not mutated. */
export function planJournal(
  cursor: JournalCursor,
  prev: RelaySnapshot,
  next: RelaySnapshot,
): JournalPlan {
  const nextCursor = cloneCursor(cursor);
  const puts: JournalPut[] = [];
  const deletes: string[] = [];
  const envelopeExpiry = pairMap(next.envelopeExpiry);
  const leaseExpiry = pairMap(next.leaseExpiry);
  const previousLease = pairMap(prev.leaseExpiry);
  const seenExpiry = pairMap(next.seenExpiry);
  const authExpiry = pairMap(next.authExpiry);
  const nextIds = new Set<string>();
  const prevOps = new Map(prev.operations ?? []);
  const nextOps = new Map(next.operations ?? []);
  for (const [id, seq] of cursor.operationSeq) {
    if (!nextOps.has(id) || JSON.stringify(prevOps.get(id)) !== JSON.stringify(nextOps.get(id))) {
      deletes.push('operation:' + seq);
      nextCursor.operationSeq.delete(id);
    }
  }
  for (const [id, operation] of nextOps) {
    if (nextCursor.operationSeq.has(id)) continue;
    const seq = nextCursor.operationTail++;
    nextCursor.operationSeq.set(id, seq);
    puts.push({ key: 'operation:' + seq, value: { id, operation } });
  }
  nextCursor.operationHead = nextCursor.operationTail;
  for (const seq of nextCursor.operationSeq.values())
    nextCursor.operationHead = Math.min(nextCursor.operationHead, seq);

  for (const [, queue] of next.queues) {
    for (const envelope of queue) {
      const id = envelope.payload.envelopeId;
      nextIds.add(id);
      const existing = nextCursor.seqById.get(id);
      if (existing !== undefined && leaseExpiry.get(id) === previousLease.get(id)) continue;
      const seq = existing ?? nextCursor.tail++;
      nextCursor.seqById.set(id, seq);
      puts.push({
        key: 'env:' + seq,
        value: {
          envelope,
          leasedUntil: leaseExpiry.get(id),
          expiresAt: envelopeExpiry.get(id) ?? 0,
          bytes: Buffer.byteLength(JSON.stringify(envelope)),
        } satisfies StoredQueueItem,
      });
    }
  }
  for (const [id, seq] of cursor.seqById) {
    if (nextIds.has(id)) continue;
    deletes.push('env:' + seq);
    nextCursor.seqById.delete(id);
  }
  for (const seq of cursor.orphanSeqs) deletes.push('env:' + seq);
  nextCursor.orphanSeqs = [];
  let head = nextCursor.tail;
  for (const seq of nextCursor.seqById.values()) head = Math.min(head, seq);
  nextCursor.head = head;

  const knownSeen = new Set(cursor.liveSeen);
  for (const id of next.seen) {
    if (knownSeen.has(id)) continue;
    const seq = nextCursor.seenTail++;
    puts.push({
      key: 'seen:' + (seq % nextCursor.seenMod),
      value: { id, expiresAt: seenExpiry.get(id) ?? 0, seq } satisfies StoredSeen,
    });
  }
  nextCursor.liveSeen = [...next.seen];

  const knownAuth = new Set(cursor.liveAuth);
  for (const id of next.authSeen ?? []) {
    if (knownAuth.has(id)) continue;
    const seq = nextCursor.authTail++;
    puts.push({
      key: 'auth:' + (seq % nextCursor.authMod),
      value: { id, expiresAt: authExpiry.get(id) ?? 0, seq } satisfies StoredSeen,
    });
  }
  nextCursor.liveAuth = [...(next.authSeen ?? [])];

  const nextCards = new Map(next.agents.map((card) => [registryKey(card), card]));
  const nextAgentExpiry = pairMap(next.agentExpiry);
  const prevCards = new Map(prev.agents.map((card) => [registryKey(card), card]));
  const prevAgentExpiry = pairMap(prev.agentExpiry);
  const removeSlots: number[] = [];
  for (let slot = 0; slot < nextCursor.agents.length; slot++) {
    if (!nextCards.has(nextCursor.agents[slot]!.did)) removeSlots.push(slot);
  }
  for (const slot of removeSlots.sort((a, b) => b - a)) {
    const removed = nextCursor.agents[slot]!;
    if (removed.blob) deletes.push('agentblob:' + removed.blob);
    const last = nextCursor.agents.length - 1;
    if (slot !== last) {
      nextCursor.agents[slot] = nextCursor.agents[last]!;
      puts.push({ key: 'agentptr:' + slot, value: { blob: nextCursor.agents[slot]!.blob } });
    }
    deletes.push('agentptr:' + last);
    nextCursor.agents.pop();
  }
  for (const card of next.agents) {
    const did = registryKey(card);
    const expiresAt = nextAgentExpiry.get(did) ?? 0;
    const slot = nextCursor.agents.findIndex((agent) => agent.did === did);
    const previous = prevCards.get(did);
    if (
      slot >= 0 &&
      previous &&
      JSON.stringify(previous) === JSON.stringify(card) &&
      prevAgentExpiry.get(did) === expiresAt
    )
      continue;
    const blob = String(++nextCursor.agentGen);
    const oldBlob = slot >= 0 ? nextCursor.agents[slot]!.blob : undefined;
    puts.push({ key: 'agentblob:' + blob, value: { card, expiresAt } satisfies StoredAgent });
    if (slot >= 0) {
      nextCursor.agents[slot] = { did, blob };
      puts.push({ key: 'agentptr:' + slot, value: { blob } });
      if (oldBlob && oldBlob !== blob) deletes.push('agentblob:' + oldBlob);
    } else {
      puts.push({ key: 'agentptr:' + nextCursor.agents.length, value: { blob } });
      nextCursor.agents.push({ did, blob });
    }
  }

  return {
    puts,
    deletes,
    meta: {
      v: 2,
      ...(nextCursor.operationTail
        ? { operationHead: nextCursor.operationHead, operationTail: nextCursor.operationTail }
        : {}),
      head: nextCursor.head,
      tail: nextCursor.tail,
      seenTail: nextCursor.seenTail,
      seenMod: nextCursor.seenMod,
      authTail: nextCursor.authTail,
      authMod: nextCursor.authMod,
      agentCount: nextCursor.agents.length,
      agentGen: nextCursor.agentGen,
    },
    cursor: nextCursor,
  };
}

export interface LoadedRelay {
  cursor: JournalCursor;
  snapshot?: RelaySnapshot;
  legacy?: { generation: string; count: number };
}

function asBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return undefined;
}

async function readLegacy(
  storage: RelayKeyValueStorage,
  now: number,
): Promise<{ snapshot: RelaySnapshot; generation: string; count: number } | undefined> {
  const head = await storage.get<{ generation: string; count: number }>('relay-head');
  if (
    !head ||
    typeof head.generation !== 'string' ||
    !Number.isSafeInteger(head.count) ||
    head.count < 1
  )
    return undefined;
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < head.count; i++) {
    const chunk = asBytes(await storage.get<unknown>('relay:' + head.generation + ':' + i));
    if (!chunk) return undefined;
    chunks.push(chunk);
  }
  const snapshot = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RelaySnapshot;
  if (Array.isArray(snapshot.agents)) {
    const validAgents = snapshot.agents.filter((card) => verifySignedAgentCard(card, now));
    const validKeys = new Set(validAgents.map((card) => registryKey(card)));
    snapshot.agents = validAgents;
    if (Array.isArray(snapshot.agentExpiry)) {
      snapshot.agentExpiry = snapshot.agentExpiry.filter(
        ([key, expiresAt]) => validKeys.has(key) && expiresAt > now,
      );
    }
  }
  return {
    snapshot,
    generation: head.generation,
    count: head.count,
  };
}

async function loadMeta(
  storage: RelayKeyValueStorage,
  meta: RelayMeta,
  now: number,
  limits: { seenMod: number; authMod: number },
): Promise<LoadedRelay> {
  const cursor = emptyCursor(meta.seenMod || limits.seenMod, meta.authMod || limits.authMod);
  cursor.operationHead = meta.operationHead ?? 0;
  cursor.operationTail = meta.operationTail ?? 0;
  const operations: [string, RelayOperation][] = [];
  for (let seq = cursor.operationHead; seq < cursor.operationTail; seq++) {
    const row = await storage.get<{ id: string; operation: RelayOperation }>('operation:' + seq);
    if (!row) continue;
    cursor.operationSeq.set(row.id, seq);
    operations.push([row.id, row.operation]);
  }
  cursor.head = meta.head;
  cursor.tail = meta.tail;
  cursor.seenTail = meta.seenTail;
  cursor.authTail = meta.authTail;
  cursor.agentGen = meta.agentGen;
  const queues = new Map<string, SignedEnvelope[]>();
  const envelopeExpiry: [string, number][] = [];
  const leaseExpiry: [string, number][] = [];
  for (let seq = meta.head; seq < meta.tail; seq++) {
    const row = await storage.get<StoredQueueItem>('env:' + seq);
    if (!row?.envelope?.payload?.envelopeId) {
      cursor.orphanSeqs.push(seq);
      continue;
    }
    // Restore expired envelopes too: the relay converts them into signed tombstones.

    const id = row.envelope.payload.envelopeId;
    cursor.seqById.set(id, seq);
    const did = row.envelope.payload.recipientDid;
    const queue = queues.get(did) ?? [];
    queue.push(row.envelope);
    queues.set(did, queue);
    envelopeExpiry.push([id, row.expiresAt]);
    if (row.leasedUntil) leaseExpiry.push([id, row.leasedUntil]);
  }
  const seen: StoredSeen[] = [];
  const seenStart = Math.max(0, meta.seenTail - cursor.seenMod);
  for (let seq = seenStart; seq < meta.seenTail; seq++) {
    const row = await storage.get<StoredSeen>('seen:' + (seq % cursor.seenMod));
    if (!row || row.seq !== seq || row.expiresAt <= now) continue;
    seen.push(row);
  }
  seen.sort((a, b) => a.seq - b.seq);
  cursor.liveSeen = seen.map((row) => row.id);
  const auth: StoredSeen[] = [];
  const authStart = Math.max(0, meta.authTail - cursor.authMod);
  for (let seq = authStart; seq < meta.authTail; seq++) {
    const row = await storage.get<StoredSeen>('auth:' + (seq % cursor.authMod));
    if (!row || row.seq !== seq || row.expiresAt <= now) continue;
    auth.push(row);
  }
  auth.sort((a, b) => a.seq - b.seq);
  cursor.liveAuth = auth.map((row) => row.id);
  const agents: SignedAgentCard[] = [];
  const agentExpiry: [string, number][] = [];
  for (let slot = 0; slot < meta.agentCount; slot++) {
    const ptr = await storage.get<{ blob: string }>('agentptr:' + slot);
    const row = ptr?.blob ? await storage.get<StoredAgent>('agentblob:' + ptr.blob) : undefined;
    if (!row?.card?.payload?.agentDid || !row.card.payload.ownerDid) {
      // Keep the slot index aligned with storage so a later plan can delete the hole.
      cursor.agents.push({ did: 'missing:' + slot, blob: ptr?.blob ?? '' });
      continue;
    }
    const did = registryKey(row.card);
    cursor.agents.push({ did, blob: ptr?.blob ?? '' });
    if (row.expiresAt <= now || !verifySignedAgentCard(row.card, now)) continue;
    agents.push(row.card);
    agentExpiry.push([did, row.expiresAt]);
  }
  return {
    cursor,
    snapshot: {
      operations,
      queues: [...queues],
      seen: cursor.liveSeen,
      authSeen: cursor.liveAuth,
      agents,
      envelopeExpiry,
      leaseExpiry,
      seenExpiry: seen.map((row) => [row.id, row.expiresAt]),
      authExpiry: auth.map((row) => [row.id, row.expiresAt]),
      agentExpiry,
    },
  };
}

export async function loadRelayState(
  storage: RelayKeyValueStorage,
  now: number,
  limits: { seenMod: number; authMod: number },
): Promise<LoadedRelay> {
  const meta = await storage.get<RelayMeta>('meta');
  if (meta?.v === 2) return loadMeta(storage, meta, now, limits);
  const legacy = await readLegacy(storage, now);
  if (!legacy) return { cursor: emptyCursor(limits.seenMod, limits.authMod) };
  return {
    cursor: emptyCursor(limits.seenMod, limits.authMod),
    snapshot: legacy.snapshot,
    legacy: { generation: legacy.generation, count: legacy.count },
  };
}
