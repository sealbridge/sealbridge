// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { digest, signPayload, verifySigned } from '@acp/core';
import type { KeyPair, TaskManifest, Json, Signed } from '@acp/core';
import { resolveDataRoot, privateDirectory, checkPath, checkStat, inspectDirectory } from './local-identity.js';
import type { LocalIdentityOptions } from './local-identity.js';
import { emptyConnectionData, validConnectionData, pruneConnectionData, assertConnectionCapacity,
  projectConnectionState, projectConnectionTrust, validConnectionPeer, validConnectionOffer,
  validConnectionOutbox, assertConnectionCommit, assertConnectionOwnerDid, connectionInviteDigest, CONNECTION_REFUSAL_TTL_MS } from './connection-records.js';
import type { ConnectionData, ConnectionState, ConnectionTrust, ConnectionRecord, ConnectionPeer,
  PriorApprovedPeer, RecordIncomingConnection, RecordOutgoingConnection, ApproveConnectionInput,
  ApplyConnectionAcceptedInput, BindInviteFirstUseInput, ConnectionOutboxRecord, ConnectionPersistence } from './connection-records.js';

export type PeerTrust = 'unknown' | 'limited' | 'trusted' | 'denied';
export interface IntakeRequest {
  id: string; requesterOwnerDid: string; requesterAgentDid: string; taskId: string; digest: string;
  title: string; description: string; scope: { skillId?: string; taskType?: string }; budget: TaskManifest['budget']; capabilities: number;
  receivedAt: number; expiresAt: number; state: 'pending' | 'approved' | 'denied' | 'expired';
  trust?: 'limited' | 'trusted';
}
interface LegacyTrustState {
  version: 1; workerOwnerDid: string; requests: IntakeRequest[];
  grants: Array<{ did: string; trust: 'limited' | 'trusted'; expiresAt: number }>;
  denials: string[];
}
type ConnectionTrustState = Omit<LegacyTrustState, 'version'> & ConnectionData & { version: 2 };
type TrustState = LegacyTrustState | ConnectionTrustState;

// A finite grant is evidence of a past decision, never a connection.
function priorApprovedPeers(state: TrustState): PriorApprovedPeer[] {
  const peers = new Map<string, PriorApprovedPeer>((state.version === 2 ? state.priorApprovedPeers : [])
    .map(p => [p.peerOwnerDid, structuredClone(p)]));
  const add = (did: string, trust: 'limited' | 'trusted', requestId?: string) => {
    const p = peers.get(did) ?? { peerOwnerDid: did, sourceRequestIds: [], legacyTrust: trust };
    if (trust === 'trusted') p.legacyTrust = trust;
    if (requestId && !p.sourceRequestIds.includes(requestId)) p.sourceRequestIds.push(requestId);
    // Bound per-peer evidence without removing the peer or inferring an approval timestamp.
    p.sourceRequestIds = p.sourceRequestIds.slice(-200);
    peers.set(did, p);
  };
  for (const r of state.requests) if (r.state === 'approved') add(r.requesterOwnerDid, r.trust ?? 'limited', r.id);
  for (const g of state.grants) add(g.did, g.trust);
  return [...peers.values()];
}
export interface WorkerIntakeStore {
  level(did: string): PeerTrust;
  enqueue(manifest: TaskManifest, input: Json): void;
  pendingTask(did: string, taskId: string, proposalDigest: string): boolean;
}
const ceiling = 1024 * 1024;
export const PENDING_MESSAGE = 'The worker owner must review this requester. No task was accepted. Do not retry automatically.';
export function workerIntakePath(ownerDid: string, options: LocalIdentityOptions = {}): string {
  return join(resolveDataRoot(options), 'workers', createHash('sha256').update(ownerDid).digest('hex'), 'intake.json');
}
/** JSON output also escapes controls; store previews never carry terminal control sequences. */
function preview(value: string, length: number): string {
  return value.slice(0, length).replace(/[\p{Cc}\p{Cf}]/gu, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
export class WorkerTrustStore implements WorkerIntakeStore, ConnectionPersistence {
  private state: TrustState;
  private times: Array<{ did: string; at: number }> = [];
  private readonly io: typeof fs;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  constructor(private readonly owner: KeyPair, private readonly options: {
    path?: string; fs?: typeof fs; platform?: NodeJS.Platform; now?: () => number;
  } = {}) {
    this.io = options.fs ?? fs; this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.state = { version: 1, workerOwnerDid: owner.did, requests: [], grants: [], denials: [] };
  }
  private read(): TrustState {
    if (!this.options.path) return structuredClone(this.state);
    const path = this.options.path, io = this.io;
    let fd: number | undefined, observed = false;
    try {
      for (const directory of [dirname(dirname(dirname(path))), dirname(dirname(path)), dirname(path)]) {
        try { inspectDirectory(directory, io, this.platform); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      }
      checkPath(path, io, this.platform);
      const before = io.lstatSync(path);
      observed = true;
      checkStat(before);
      if (before.size > ceiling) throw new Error();
      fd = io.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      const stat = io.fstatSync(fd); checkStat(stat);
      if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size > ceiling) throw new Error();
      const bytes = Buffer.alloc(ceiling + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = io.readSync(fd, bytes, size, bytes.length - size, null);
        if (!count) break;
        size += count;
      }
      if (size > ceiling) throw new Error();
      const signed = JSON.parse(bytes.subarray(0, size).toString('utf8')) as Signed<TrustState>;
      const s = signed.payload;
      if (!verifySigned(signed, this.owner.did) || ![1, 2].includes(s.version) || s.workerOwnerDid !== this.owner.did ||
          !Array.isArray(s.requests) || !Array.isArray(s.grants) || !Array.isArray(s.denials) ||
          s.requests.length > 200 || s.requests.some(r => !r || typeof r.id !== 'string' ||
            !['pending', 'approved', 'denied', 'expired'].includes(r.state) ||
            !Number.isFinite(r.expiresAt) || typeof r.requesterOwnerDid !== 'string' ||
            Buffer.byteLength(JSON.stringify(r)) > 4096) ||
          s.grants.some(g => !g || !['limited', 'trusted'].includes(g.trust) ||
            typeof g.did !== 'string' || !Number.isFinite(g.expiresAt)) ||
          s.denials.some(d => typeof d !== 'string') ||
          (s.version === 2 && (!validConnectionData(s, this.owner.did) ||
            s.connections.some(c => s.denials.includes(c.peerOwnerDid)) ||
            s.outbox.some(e => s.denials.includes(e.peerOwnerDid))))) throw new Error();
      return s;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !observed)
        return { version: 1, workerOwnerDid: this.owner.did, requests: [], grants: [], denials: [] };
      throw new Error('INTAKE_STORE_INVALID');
    } finally { if (fd !== undefined) io.closeSync(fd); }
  }
  private mutate<T>(change: (state: TrustState) => T, connectionMutation = false, reserveRoom = false): T {
    const path = this.options.path, io = this.io;
    let locked = false, temporary: string | undefined;
    try {
      if (path) {
        // Apply P1's private-directory policy to every store-owned directory.
        privateDirectory(dirname(dirname(dirname(path))), io, this.platform);
        privateDirectory(dirname(dirname(path)), io, this.platform);
        privateDirectory(dirname(path), io, this.platform);
        try { io.writeFileSync(path + '.lock', '', { flag: 'wx', mode: 0o600 }); locked = true; }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('INTAKE_STORE_BUSY'); throw e; }
      }
      let state = this.read();
      const now = this.now();
      if (connectionMutation && state.version === 1)
        state = { ...state, ...emptyConnectionData(), version: 2, priorApprovedPeers: priorApprovedPeers(state) };
      if (state.version === 2) {
        state.priorApprovedPeers = priorApprovedPeers(state);
      }
      state.grants = state.grants.filter(g => g.expiresAt > now);
      for (const r of state.requests) if (r.state === 'pending' && r.expiresAt <= now) r.state = 'expired';
      const result = change(state);
      state.requests = [...state.requests.filter(r => r.state !== 'pending').slice(-100),
        ...state.requests.filter(r => r.state === 'pending')];
      if (state.version === 2) {
        state.priorApprovedPeers = priorApprovedPeers(state);
        pruneConnectionData(state, now);
        assertConnectionCapacity(state);
        if (!validConnectionData(state, this.owner.did)) throw new Error('INTAKE_STORE_INVALID');
      }
      const bytes = JSON.stringify(signPayload(state, this.owner, new Date(now).toISOString())) + '\n';
      // Leave room for owner decisions when intake fills the queue.
      if (Buffer.byteLength(bytes) > ceiling - (reserveRoom ? 32 * 1024 : 0))
        throw new Error(connectionMutation ? 'CONNECTION_STORE_FULL' : 'INTAKE_QUEUE_FULL');
      if (path) {
        temporary = path + '.' + randomUUID() + '.tmp';
        const fd = io.openSync(temporary, 'wx', 0o600);
        try { io.writeFileSync(fd, bytes); io.fsyncSync(fd); } finally { io.closeSync(fd); }
        checkPath(path, io, this.platform);
        io.renameSync(temporary, path);
      } else this.state = state;
      return result;
    } catch (e) {
      if (e instanceof Error && /^(INTAKE_|REQUEST_|CONNECTION_)/.test(e.message)) throw e;
      throw new Error('INTAKE_STORE_UNWRITABLE');
    } finally {
      if (temporary) try { io.unlinkSync(temporary); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (locked) io.unlinkSync(path + '.lock');
    }
  }
  level(did: string): PeerTrust {
    const state = this.read();
    if (state.denials.includes(did)) return 'denied';
    return state.grants.find(g => g.did === did && g.expiresAt > this.now())?.trust ?? 'unknown';
  }
  hasTrustedGrant(): boolean {
    const s = this.read();
    return s.grants.some(g => g.trust === 'trusted' && g.expiresAt > this.now() && !s.denials.includes(g.did));
  }
  list(): IntakeRequest[] {
    return this.read().requests.map(r => r.state === 'pending' && r.expiresAt <= this.now() ? { ...r, state: 'expired' } : r);
  }
  pendingTask(did: string, taskId: string, _proposalDigest: string): boolean {
    // A reviewed entry still identifies an admission-only attempt; never replay it.
    return this.read().requests.some(r => r.requesterOwnerDid === did && r.taskId === taskId);
  }
  /** Connection projection is separate from level(), which retains legacy grant semantics. */
  connectionState(peerOwnerDid: string): ConnectionState {
    const state = this.read();
    return projectConnectionState(state.version === 2 ? state : emptyConnectionData(), state.denials, peerOwnerDid, this.now());
  }
  connectionLevel(peerOwnerDid: string): ConnectionTrust {
    return projectConnectionTrust(this.connectionState(peerOwnerDid));
  }
  listConnections(): Array<(ConnectionRecord | { peerOwnerDid: string }) & { state: Exclude<ConnectionState, 'none'> }> {
    const state = this.read(), data = state.version === 2 ? state : emptyConnectionData();
    pruneConnectionData(data, this.now());
    return [...data.connections.filter(c => !state.denials.includes(c.peerOwnerDid)),
      ...state.denials.map(peerOwnerDid => ({ peerOwnerDid, state: 'blocked' as const }))];
  }
  listPriorApprovedPeers(): PriorApprovedPeer[] { return priorApprovedPeers(this.read()); }
  private mutateConnections<T>(change: (state: ConnectionTrustState) => T, reserveRoom = false): T {
    return this.mutate(s => change(s as ConnectionTrustState), true, reserveRoom);
  }
  private assertAvailable(s: ConnectionTrustState, peer: string, incoming = false): void {
    assertConnectionOwnerDid(peer);
    if (s.denials.includes(peer)) throw new Error('CONNECTION_ALREADY_DECIDED');
    if (incoming && s.refusals.some(r => r.peerOwnerDid === peer && r.refuseUntil > this.now()))
      throw new Error('CONNECTION_REQUEST_COOLDOWN');
  }
  private recordOffer(input: RecordIncomingConnection | RecordOutgoingConnection, outgoing: boolean): void {
    this.mutateConnections(s => {
      pruneConnectionData(s, this.now());
      const offer = 'outgoing' in input ? input.outgoing : input.incoming;
      if (!validConnectionPeer(input) || !validConnectionOffer(offer, outgoing)) throw new Error('INTAKE_STORE_INVALID');
      const start = 'createdAt' in offer ? offer.createdAt : offer.receivedAt;
      if (offer.expiresAt <= this.now()) throw new Error('CONNECTION_REQUEST_EXPIRED');
      if (start > this.now()) throw new Error('INTAKE_STORE_INVALID');
      this.assertAvailable(s, input.peerOwnerDid, !outgoing);
      let c = s.connections.find(c => c.peerOwnerDid === input.peerOwnerDid);
      if (c?.state === 'connected') throw new Error('CONNECTION_ALREADY_DECIDED');
      const previous = outgoing ? c?.outgoing : c?.incoming;
      if (previous) {
        if (digest(previous) === digest(offer) && c!.relayUrl === input.relayUrl) return;
        throw new Error('CONNECTION_ALREADY_DECIDED');
      }
      if (c && c.relayUrl !== input.relayUrl) throw new Error('INTAKE_STORE_INVALID');
      if (!c) {
        c = { peerOwnerDid: input.peerOwnerDid, relayUrl: input.relayUrl, state: 'pending' };
        s.connections.push(c);
      }
      if (input.peerAgentDid) c.peerAgentDid = input.peerAgentDid;
      if ('outgoing' in input) c.outgoing = structuredClone(input.outgoing);
      else c.incoming = structuredClone(input.incoming);
      if (s.requests.filter(r => r.state === 'pending').length + s.connections.filter(c => c.state === 'pending').length > 100)
        throw new Error('CONNECTION_STORE_FULL');
    }, true);
  }
  recordOutgoing(input: RecordOutgoingConnection): void { this.recordOffer(input, true); }
  recordIncoming(input: RecordIncomingConnection): void { this.recordOffer(input, false); }
  private queueAcceptance(s: ConnectionTrustState, peer: ConnectionPeer, event: ConnectionOutboxRecord, deadline: number): void {
    if (!validConnectionOutbox(event, this.owner.did) || event.peerOwnerDid !== peer.peerOwnerDid ||
      event.relayUrl !== peer.relayUrl || event.state !== 'pending' ||
      event.deliveryDeadline <= this.now() || event.deliveryDeadline > deadline) throw new Error('INTAKE_STORE_INVALID');
    const existing = s.outbox.find(e => e.eventId === event.eventId && e.deliveryDeadline > this.now());
    if (existing) throw new Error('CONNECTION_ALREADY_DECIDED');
    s.outbox.push(structuredClone(event));
  }
  approveConnection(input: ApproveConnectionInput): void {
    this.mutateConnections(s => {
      this.assertAvailable(s, input.peerOwnerDid);
      assertConnectionCommit(input.connectionId, input.localConsentDigest);
      const c = s.connections.find(c => c.peerOwnerDid === input.peerOwnerDid);
      if (!c?.incoming) throw new Error('CONNECTION_NOT_FOUND');
      if (c.incoming.requestId !== input.requestId || c.incoming.requestDigest !== input.requestDigest)
        throw new Error('CONNECTION_ALREADY_DECIDED');
      if (c.state === 'connected') {
        if (c.connectionId === input.connectionId && c.localConsentDigest === input.localConsentDigest) return;
        throw new Error('CONNECTION_ALREADY_DECIDED');
      }
      if (c.incoming.expiresAt <= this.now()) throw new Error('CONNECTION_REQUEST_EXPIRED');
      if (input.source !== undefined && !['request', 'prior-approval'].includes(input.source)) throw new Error('INTAKE_STORE_INVALID');
      if (input.source === 'prior-approval' && !s.priorApprovedPeers.some(p => p.peerOwnerDid === c.peerOwnerDid))
        throw new Error('CONNECTION_NOT_FOUND');
      this.queueAcceptance(s, c, input.outbox, c.incoming.expiresAt);
      Object.assign(c, { state: 'connected', connectionId: input.connectionId, connectedAt: this.now(),
        source: input.source ?? 'request', localConsentDigest: input.localConsentDigest });
    });
  }
  applyAccepted(input: ApplyConnectionAcceptedInput): void {
    this.mutateConnections(s => {
      this.assertAvailable(s, input.peerOwnerDid);
      assertConnectionCommit(input.connectionId, input.remoteAcceptanceDigest);
      const c = s.connections.find(c => c.peerOwnerDid === input.peerOwnerDid);
      if (!c?.outgoing) throw new Error('CONNECTION_NOT_FOUND');
      if (c.outgoing.requestId !== input.requestId || c.outgoing.requestDigest !== input.requestDigest)
        throw new Error('CONNECTION_ALREADY_DECIDED');
      if (c.state === 'connected') {
        if (c.connectionId === input.connectionId && c.remoteAcceptanceDigest === input.remoteAcceptanceDigest) return;
        throw new Error('CONNECTION_ALREADY_DECIDED');
      }
      if (c.outgoing.expiresAt <= this.now()) throw new Error('CONNECTION_REQUEST_EXPIRED');
      Object.assign(c, { state: 'connected', connectionId: input.connectionId, connectedAt: this.now(),
        source: 'request', localConsentDigest: c.outgoing.ownerConsentDigest, remoteAcceptanceDigest: input.remoteAcceptanceDigest });
    });
  }
  rejectConnection(peerOwnerDid: string): void {
    this.mutateConnections(s => {
      this.assertAvailable(s, peerOwnerDid);
      const c = s.connections.find(c => c.peerOwnerDid === peerOwnerDid);
      if (!c?.incoming) throw new Error('CONNECTION_NOT_FOUND');
      if (c.state !== 'pending') throw new Error('CONNECTION_ALREADY_DECIDED');
      if (c.incoming.expiresAt <= this.now()) throw new Error('CONNECTION_REQUEST_EXPIRED');
      this.removeConnection(s, peerOwnerDid, false);
      s.refusals = s.refusals.filter(r => r.peerOwnerDid !== peerOwnerDid);
      s.refusals.push({ peerOwnerDid, refuseUntil: this.now() + CONNECTION_REFUSAL_TTL_MS });
    });
  }
  private removeConnection(s: ConnectionTrustState, peerOwnerDid: string, removeLegacyGrants = true): void {
    assertConnectionOwnerDid(peerOwnerDid);
    s.connections = s.connections.filter(c => c.peerOwnerDid !== peerOwnerDid);
    if (removeLegacyGrants) s.grants = s.grants.filter(g => g.did !== peerOwnerDid);
    s.outbox = s.outbox.filter(e => e.peerOwnerDid !== peerOwnerDid);
  }
  disconnect(peerOwnerDid: string): void { this.mutateConnections(s => this.removeConnection(s, peerOwnerDid)); }
  block(peerOwnerDid: string): void {
    this.mutateConnections(s => {
      this.removeConnection(s, peerOwnerDid);
      if (!s.denials.includes(peerOwnerDid)) s.denials.push(peerOwnerDid);
    });
  }
  unblock(peerOwnerDid: string): void {
    this.mutateConnections(s => {
      this.removeConnection(s, peerOwnerDid);
      s.denials = s.denials.filter(d => d !== peerOwnerDid);
    });
  }
  bindInviteFirstUse(input: BindInviteFirstUseInput): 'first' | 'same' | 'other' {
    return this.mutateConnections(s => {
      const inviteDigest = connectionInviteDigest(input.invite);
      const deadline = Math.min(Date.parse(input.invite.expiresAt), Date.parse(input.invite.agentCard.payload.expiresAt));
      if (input.invite.ownerDid !== this.owner.did || !Number.isFinite(deadline)) throw new Error('INTAKE_STORE_INVALID');
      if (deadline <= this.now()) throw new Error('CONNECTION_REQUEST_EXPIRED');
      if (!validConnectionPeer(input)) throw new Error('INTAKE_STORE_INVALID');
      const existing = s.inviteBindings.find(b => b.inviteDigest === inviteDigest);
      if (existing) return existing.requesterOwnerDid === input.peerOwnerDid ? 'same' : 'other';
      this.assertAvailable(s, input.peerOwnerDid, true);
      assertConnectionCommit(input.connectionId, input.localConsentDigest);
      const connected = s.connections.find(c => c.peerOwnerDid === input.peerOwnerDid && c.state === 'connected');
      if (connected && connected.connectionId !== input.connectionId)
        throw new Error('CONNECTION_ALREADY_DECIDED');
      this.queueAcceptance(s, input, input.outbox, deadline);
      if (!connected) {
        s.connections = s.connections.filter(c => c.peerOwnerDid !== input.peerOwnerDid);
        s.connections.push({ peerOwnerDid: input.peerOwnerDid, ...(input.peerAgentDid ? { peerAgentDid: input.peerAgentDid } : {}),
          relayUrl: input.relayUrl, state: 'connected', connectionId: input.connectionId, connectedAt: this.now(),
          source: 'invite', localConsentDigest: input.localConsentDigest });
      }
      s.inviteBindings.push({ inviteDigest, requesterOwnerDid: input.peerOwnerDid, boundAt: this.now(),
        tokenExpiresAt: deadline, connectionId: input.connectionId });
      return 'first';
    });
  }
  listConnectionOutbox(): ConnectionOutboxRecord[] {
    const s = this.read();
    return s.version === 2 ? s.outbox.filter(e => e.state === 'pending' && e.deliveryDeadline > this.now()) : [];
  }
  markConnectionEventDelivered(eventId: string): void {
    this.mutateConnections(s => {
      const e = s.outbox.find(e => e.eventId === eventId);
      if (!e) throw new Error('CONNECTION_NOT_FOUND');
      e.state = 'delivered';
    });
  }
  enqueue(manifest: TaskManifest, input: Json): void {
    const now = this.now(), did = manifest.requester.ownerDid;
    this.times = this.times.filter(t => now - t.at < 60_000);
    if (this.times.length >= 60 || this.times.filter(t => t.did === did).length >= 5) throw new Error('INTAKE_RATE_LIMITED');
    this.times.push({ did, at: now });
    this.mutate(s => {
      if (s.denials.includes(did)) throw new Error('REQUEST_DENIED');
      if (s.requests.some(r => r.requesterOwnerDid === did &&
          (r.state === 'pending' || (r.taskId === manifest.taskId && r.digest === digest({ manifest, input }))))) return;
      if (s.requests.filter(r => r.state === 'pending').length >= 100 ||
          Buffer.byteLength(JSON.stringify(s)) > ceiling - 32 * 1024) throw new Error('INTAKE_QUEUE_FULL');
      const entry: IntakeRequest = { id: randomUUID(), requesterOwnerDid: did,
        requesterAgentDid: manifest.requester.agentDid, taskId: manifest.taskId,
        digest: digest({ manifest, input }), title: preview(manifest.task.title, 100),
        description: preview(manifest.task.description, 150),
        scope: { ...(manifest.task.skillId ? { skillId: preview(manifest.task.skillId, 64) } : {}),
          ...(manifest.task.taskType ? { taskType: preview(manifest.task.taskType, 64) } : {}) }, budget: manifest.budget,
        capabilities: manifest.permissions.grantedCapabilities.length, receivedAt: now,
        expiresAt: Math.min(Date.parse(manifest.deadline), now + 15 * 60_000), state: 'pending' };
      if (Buffer.byteLength(JSON.stringify(entry)) > 4096) throw new Error('INTAKE_QUEUE_FULL');
      s.requests.push(entry);
    });
  }
  decide(id: string, decision: 'approve' | 'deny', trust: 'limited' | 'trusted' = 'limited'): void {
    this.mutate(s => {
      const r = s.requests.find(r => r.id === id);
      if (!r) throw new Error('REQUEST_NOT_FOUND');
      if (decision === 'deny') {
        if (!s.denials.includes(r.requesterOwnerDid)) s.denials.push(r.requesterOwnerDid);
        if (s.version === 2) this.removeConnection(s, r.requesterOwnerDid);
        s.grants = s.grants.filter(g => g.did !== r.requesterOwnerDid); r.state = 'denied'; return;
      }
      if (r.state === 'approved' && r.trust === trust) return;
      if (r.state === 'expired') throw new Error('REQUEST_EXPIRED');
      if (r.state !== 'pending' || s.denials.includes(r.requesterOwnerDid)) throw new Error('REQUEST_ALREADY_DECIDED');
      s.grants = s.grants.filter(g => g.did !== r.requesterOwnerDid);
      s.grants.push({ did: r.requesterOwnerDid, trust, expiresAt: this.now() + 24 * 60 * 60_000 });
      r.state = 'approved'; r.trust = trust;
    });
  }
}
