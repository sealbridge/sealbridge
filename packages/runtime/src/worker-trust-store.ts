// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { digest, signPayload, verifySigned } from '@acp/core';
import type { KeyPair, TaskManifest, Json, Signed } from '@acp/core';
import { resolveDataRoot, privateDirectory, checkPath, checkStat, inspectDirectory } from './local-identity.js';
import type { LocalIdentityOptions } from './local-identity.js';

export type PeerTrust = 'unknown' | 'limited' | 'trusted' | 'denied';
export interface IntakeRequest {
  id: string; requesterOwnerDid: string; requesterAgentDid: string; taskId: string; digest: string;
  title: string; description: string; scope: { skillId?: string; taskType?: string }; budget: TaskManifest['budget']; capabilities: number;
  receivedAt: number; expiresAt: number; state: 'pending' | 'approved' | 'denied' | 'expired';
  trust?: 'limited' | 'trusted';
}
interface TrustState {
  version: 1; workerOwnerDid: string; requests: IntakeRequest[];
  grants: Array<{ did: string; trust: 'limited' | 'trusted'; expiresAt: number }>;
  denials: string[];
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
export class WorkerTrustStore implements WorkerIntakeStore {
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
    let fd: number | undefined;
    try {
      for (const directory of [dirname(dirname(dirname(path))), dirname(dirname(path)), dirname(path)]) {
        try { inspectDirectory(directory, io, this.platform); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      }
      checkPath(path, io, this.platform);
      const before = io.lstatSync(path);
      checkStat(before);
      if (before.size > ceiling) throw new Error();
      fd = io.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      const stat = io.fstatSync(fd); checkStat(stat);
      if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size > ceiling) throw new Error();
      const bytes = Buffer.alloc(ceiling + 1);
      const size = io.readSync(fd, bytes, 0, bytes.length, null);
      if (size > ceiling) throw new Error();
      const signed = JSON.parse(bytes.subarray(0, size).toString('utf8')) as Signed<TrustState>;
      const s = signed.payload;
      if (!verifySigned(signed, this.owner.did) || s.version !== 1 || s.workerOwnerDid !== this.owner.did ||
          !Array.isArray(s.requests) || !Array.isArray(s.grants) || !Array.isArray(s.denials) ||
          s.requests.length > 200 || s.requests.some(r => !r || typeof r.id !== 'string' ||
            !['pending', 'approved', 'denied', 'expired'].includes(r.state) ||
            !Number.isFinite(r.expiresAt) || typeof r.requesterOwnerDid !== 'string' ||
            Buffer.byteLength(JSON.stringify(r)) > 4096) ||
          s.grants.some(g => !g || !['limited', 'trusted'].includes(g.trust) ||
            typeof g.did !== 'string' || !Number.isFinite(g.expiresAt)) ||
          s.denials.some(d => typeof d !== 'string')) throw new Error();
      return s;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, workerOwnerDid: this.owner.did, requests: [], grants: [], denials: [] };
      throw new Error('INTAKE_STORE_INVALID');
    } finally { if (fd !== undefined) io.closeSync(fd); }
  }
  private mutate(change: (state: TrustState) => void): void {
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
      const state = this.read(), now = this.now();
      state.grants = state.grants.filter(g => g.expiresAt > now);
      for (const r of state.requests) if (r.state === 'pending' && r.expiresAt <= now) r.state = 'expired';
      change(state);
      state.requests = [...state.requests.filter(r => r.state !== 'pending').slice(-100),
        ...state.requests.filter(r => r.state === 'pending')];
      const bytes = JSON.stringify(signPayload(state, this.owner)) + '\n';
      // Leave room for owner decisions when intake fills the queue.
      if (Buffer.byteLength(bytes) > ceiling) throw new Error('INTAKE_QUEUE_FULL');
      if (path) {
        temporary = path + '.' + randomUUID() + '.tmp';
        const fd = io.openSync(temporary, 'wx', 0o600);
        try { io.writeFileSync(fd, bytes); io.fsyncSync(fd); } finally { io.closeSync(fd); }
        checkPath(path, io, this.platform);
        io.renameSync(temporary, path);
      } else this.state = state;
    } catch (e) {
      if (e instanceof Error && /^(INTAKE_|REQUEST_)/.test(e.message)) throw e;
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
