// SPDX-License-Identifier: Apache-2.0
import { assertInboundProtocolVersion, compareProtocolVersions, protocolCompatibilityPhase,
  selectProtocolVersion, supportedReceiveVersions, understoodProtocolVersions, findDiscoveredAgentCard, DEFAULT_CLOCK_SKEW_MS } from '@acp/core';
import type { ManifestProtocolVersion, ProtocolCompatibilityPolicy, SignedAgentCard } from '@acp/core';
import type { ProtocolPeerStore } from './protocol-peer-store.js';

/** Maintainers set this UTC release instant before publishing the public 0.2.0 release. */
export const PROTOCOL_020_RELEASED_AT: string | null = null;
export interface ProtocolReleaseOptions {
  /** Host/test injection; CLI installations do not choose their own release epoch. */
  protocolPolicy?: ProtocolCompatibilityPolicy;
  protocolPeers?: Pick<ProtocolPeerStore, 'floor' | 'observe' | 'observePolicy'>;
  now?: () => number;
}
export function assertProtocolReleaseConfigured(releasedAt = PROTOCOL_020_RELEASED_AT): void {
  if (releasedAt === null) throw new Error('PROTOCOL_RELEASE_UNSET');
  protocolCompatibilityPhase({ releasedAt, sendLegacyUntilDays: 90, receiveLegacyUntilDays: 180 }, Date.parse(releasedAt));
}
/** Unset means a pre-release build: both versions, newest common first, no retirement clock. */
export class LiveProtocol {
  private readonly floors = new Map<string, ManifestProtocolVersion>();
  private maximumObservedPhase: 0 | 1 | 2 = 0;
  readonly now: () => number;
  constructor(private readonly options: ProtocolReleaseOptions = {}) { this.now = options.now ?? Date.now; }
  private policy(): ProtocolCompatibilityPolicy | undefined {
    const releasedAt = this.options.protocolPolicy?.releasedAt ?? PROTOCOL_020_RELEASED_AT;
    if (releasedAt === null) return undefined;
    const policy = this.options.protocolPolicy ?? { releasedAt, sendLegacyUntilDays: 90, receiveLegacyUntilDays: 180 };
    if (this.options.protocolPeers) return this.options.protocolPeers.observePolicy(policy);
    this.maximumObservedPhase = Math.max(this.maximumObservedPhase, protocolCompatibilityPhase(policy, this.now())) as 0 | 1 | 2;
    return { ...policy, maximumObservedPhase: this.maximumObservedPhase };
  }
  receiveVersions(): ManifestProtocolVersion[] {
    const policy = this.policy();
    return policy ? supportedReceiveVersions(policy, this.now()) : ['0.2.0', '0.1.0'];
  }
  private key(owner: string, agent: string): string { return JSON.stringify([owner, agent]); }
  floor(owner: string, agent: string): ManifestProtocolVersion | undefined {
    return this.options.protocolPeers?.floor(owner, agent) ?? this.floors.get(this.key(owner, agent));
  }
  observe(card: SignedAgentCard, cards: readonly SignedAgentCard[] = [card]): void {
    const current = findDiscoveredAgentCard(cards, card.payload.agentDid, this.now());
    if (!current || current.payload.ownerDid !== card.payload.ownerDid || Date.parse(current.signature.signedAt) > this.now() + DEFAULT_CLOCK_SKEW_MS)
      throw new Error('PROTOCOL_STORE_INVALID');
    card = current;
    if (this.options.protocolPeers) this.options.protocolPeers.observe(card.payload.ownerDid, card.payload.agentDid, cards);
    const version = understoodProtocolVersions(card.payload.protocolVersions)[0];
    const key = this.key(card.payload.ownerDid, card.payload.agentDid), previous = this.floors.get(key);
    if (version && (!previous || compareProtocolVersions(version, previous) > 0)) this.floors.set(key, version);
  }
  outbound(card?: SignedAgentCard, supplied?: string, owner = '', agent = ''): ManifestProtocolVersion {
    const policy = this.policy(), floor = this.floor(card?.payload.ownerDid ?? owner, card?.payload.agentDid ?? agent);
    const version = policy ? selectProtocolVersion(card?.payload.protocolVersions, floor, policy, this.now())
      : understoodProtocolVersions(card?.payload.protocolVersions)[0];
    if (!version) throw new Error('PROTOCOL_VERSION_UNSUPPORTED: Peer upgrade required.');
    if (floor && compareProtocolVersions(version, floor) < 0) throw new Error('PROTOCOL_DOWNGRADE_REFUSED');
    if (supplied !== undefined && supplied !== version) throw new Error('PROTOCOL_VERSION_UNSUPPORTED: Supplied manifest does not match negotiated version.');
    if (card) this.observe(card);
    return version;
  }
  inbound(version: string, owner: string, agent: string): void {
    const policy = this.policy(), floor = this.floor(owner, agent);
    if (policy) assertInboundProtocolVersion(version, floor, policy, this.now());
    else {
      if (!this.receiveVersions().includes(version as ManifestProtocolVersion)) throw new Error('PROTOCOL_VERSION_UNSUPPORTED');
      if (floor && compareProtocolVersions(version, floor) < 0) throw new Error('PROTOCOL_DOWNGRADE_REFUSED');
    }
  }
}
