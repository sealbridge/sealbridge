// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  compareProtocolVersions, digest, digestBytes, findDiscoveredAgentCard,
  isManifestProtocolVersion, protocolCompatibilityPhase, resolveDid,
  signPayload, understoodProtocolVersions, verifySigned, DEFAULT_CLOCK_SKEW_MS,
} from '@acp/core';
import type {
  KeyPair, ManifestProtocolVersion, ProtocolCompatibilityPhase,
  ProtocolCompatibilityPolicy, Signed, SignedAgentCard,
} from '@acp/core';
import {
  checkPath, inspectDirectory, privateDirectory, readPrivateFile, resolveDataRoot, writePrivateFile,
} from './local-identity.js';
import type { LocalIdentityOptions } from './local-identity.js';

export interface ProtocolPeerObservation {
  ownerDid: string;
  agentDid: string;
  highestVersion: ManifestProtocolVersion;
  cardDigest: string;
  observedAt: string;
}
export interface ProtocolPeerState {
  version: 1;
  localOwnerDid: string;
  policyEpoch?: string;
  maximumObservedPhase?: ProtocolCompatibilityPhase;
  observations: ProtocolPeerObservation[];
}
export interface ProtocolPeerStoreOptions extends LocalIdentityOptions {
  now?: () => number;
}
const MAX_BYTES = 1024 * 1024;
const MAX_OBSERVATIONS = 1000;
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
function validInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value;
}
function exactKeys(value: object, required: string[], optional: string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
export function protocolPeerPath(ownerDid: string, options: LocalIdentityOptions = {}): string {
  return join(resolveDataRoot(options), 'protocol-peers', digestBytes(ownerDid).slice(7) + '.json');
}
/** Local compatibility observations confer no permission to execute tasks. */
export class ProtocolPeerStore {
  readonly path: string;
  private readonly root: string;
  private readonly directory: string;
  private readonly io: typeof fs;
  private readonly now: () => number;
  constructor(private readonly owner: KeyPair, private readonly options: ProtocolPeerStoreOptions = {}) {
    this.root = resolveDataRoot(options);
    this.directory = join(this.root, 'protocol-peers');
    this.path = protocolPeerPath(owner.did, options);
    this.io = options.fs ?? fs;
    this.now = options.now ?? Date.now;
  }
  private read(): ProtocolPeerState {
    try {
      for (const directory of [this.root, this.directory]) {
        try { inspectDirectory(directory, this.io, this.options.platform); }
        catch (error) { if (code(error) !== 'ENOENT') throw error; }
      }
      const bytes = readPrivateFile(this.path, this.io, MAX_BYTES, this.options.platform);
      if (bytes === undefined) return { version: 1, localOwnerDid: this.owner.did, observations: [] };
      const signed = JSON.parse(bytes) as Signed<ProtocolPeerState>;
      const state = signed.payload;
      if (!verifySigned(signed, this.owner.did) || !state ||
          !exactKeys(state, ['version', 'localOwnerDid', 'observations'], ['policyEpoch', 'maximumObservedPhase']) ||
          state.version !== 1 || state.localOwnerDid !== this.owner.did ||
          !Array.isArray(state.observations) || state.observations.length > MAX_OBSERVATIONS ||
          ((state.policyEpoch === undefined) !== (state.maximumObservedPhase === undefined)) ||
          (state.policyEpoch !== undefined && (!validInstant(state.policyEpoch) ||
            ![0, 1, 2].includes(state.maximumObservedPhase!)))) throw new Error();
      const peers = new Set<string>();
      for (const entry of state.observations) {
        if (!entry || !exactKeys(entry, ['ownerDid', 'agentDid', 'highestVersion', 'cardDigest', 'observedAt']) ||
            !isManifestProtocolVersion(entry.highestVersion) || !validInstant(entry.observedAt) ||
            typeof entry.cardDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(entry.cardDigest)) throw new Error();
        resolveDid(entry.ownerDid); resolveDid(entry.agentDid);
        const key = JSON.stringify([entry.ownerDid, entry.agentDid]);
        if (peers.has(key)) throw new Error();
        peers.add(key);
      }
      return state;
    } catch { throw new Error('PROTOCOL_STORE_INVALID'); }
  }
  private mutate<T>(change: (state: ProtocolPeerState, now: number) => T): T {
    let locked = false, temporary: string | undefined;
    try {
      for (const directory of [this.root, this.directory]) privateDirectory(directory, this.io, this.options.platform);
      try { writePrivateFile(this.path + '.lock', Buffer.alloc(0), this.io, this.options.platform); locked = true; }
      catch (error) { if (code(error) === 'EEXIST') throw new Error('PROTOCOL_STORE_BUSY'); throw error; }
      const state = this.read(), now = this.now();
      if (!Number.isFinite(now)) throw new Error('PROTOCOL_STORE_INVALID');
      const result = change(state, now);
      const bytes = Buffer.from(JSON.stringify(signPayload(state, this.owner, new Date(now).toISOString())) + '\n');
      if (state.observations.length > MAX_OBSERVATIONS || bytes.length > MAX_BYTES)
        throw new Error('PROTOCOL_STORE_UNWRITABLE');
      temporary = this.path + '.' + randomUUID() + '.tmp';
      writePrivateFile(temporary, bytes, this.io, this.options.platform);
      checkPath(this.path, this.io, this.options.platform);
      this.io.renameSync(temporary, this.path);
      return structuredClone(result);
    } catch (error) {
      if (error instanceof Error && /^PROTOCOL_/.test(error.message)) throw error;
      throw new Error('PROTOCOL_STORE_UNWRITABLE');
    } finally {
      let cleanupFailed = false;
      for (const path of [temporary, locked ? this.path + '.lock' : undefined]) {
        if (!path) continue;
        try { this.io.unlinkSync(path); }
        catch (error) { if (code(error) !== 'ENOENT') cleanupFailed = true; }
      }
      if (cleanupFailed) throw new Error('PROTOCOL_STORE_UNWRITABLE');
    }
  }
  /** Inspection does not create files, prune observations or advance policy. */
  snapshot(): ProtocolPeerState { return this.read(); }
  floor(ownerDid: string, agentDid: string): ManifestProtocolVersion | undefined {
    return this.read().observations.find(entry => entry.ownerDid === ownerDid && entry.agentDid === agentDid)?.highestVersion;
  }
  /** Resolve the current card from the caller's directory snapshot before recording it. */
  observe(ownerDid: string, agentDid: string, currentCards: readonly SignedAgentCard[]): ProtocolPeerObservation | undefined {
    return this.mutate((state, now) => {
      let card: SignedAgentCard | undefined;
      try { card = findDiscoveredAgentCard(currentCards, agentDid, now); }
      catch { throw new Error('PROTOCOL_STORE_INVALID'); }
      if (!card || card.payload.ownerDid !== ownerDid || card.payload.agentDid !== agentDid ||
          Date.parse(card.signature.signedAt) > now + DEFAULT_CLOCK_SKEW_MS)
        throw new Error('PROTOCOL_STORE_INVALID');
      const highestVersion = understoodProtocolVersions(card.payload.protocolVersions)[0];
      const previous = state.observations.find(entry => entry.ownerDid === ownerDid && entry.agentDid === agentDid);
      if (!highestVersion || (previous && compareProtocolVersions(highestVersion, previous.highestVersion) <= 0))
        return previous;
      const entry: ProtocolPeerObservation = {
        ownerDid, agentDid, highestVersion, cardDigest: digest(card), observedAt: new Date(now).toISOString(),
      };
      if (previous) state.observations.splice(state.observations.indexOf(previous), 1, entry);
      else state.observations.push(entry);
      return entry;
    });
  }
  /** Persist before using the returned policy. Epoch replacement requires separate migration. */
  observePolicy(policy: ProtocolCompatibilityPolicy): ProtocolCompatibilityPolicy {
    return this.mutate((state, now) => {
      const phase = protocolCompatibilityPhase(policy, now);
      const epoch = new Date(Date.parse(policy.releasedAt)).toISOString();
      if (state.policyEpoch !== undefined && state.policyEpoch !== epoch)
        throw new Error('PROTOCOL_STORE_INVALID');
      state.policyEpoch = epoch;
      state.maximumObservedPhase = Math.max(phase, state.maximumObservedPhase ?? 0) as ProtocolCompatibilityPhase;
      return { ...policy, maximumObservedPhase: state.maximumObservedPhase };
    });
  }
}
