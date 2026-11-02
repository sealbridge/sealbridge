// SPDX-License-Identifier: Apache-2.0
/** Manifest versions, newest first. Card, package and A2A versions are independent. */
export const MANIFEST_PROTOCOL_VERSIONS = Object.freeze(['0.2.0', '0.1.0'] as const);
export type ManifestProtocolVersion = (typeof MANIFEST_PROTOCOL_VERSIONS)[number];
export type ProtocolCompatibilityPhase = 0 | 1 | 2;
export interface ProtocolCompatibilityPolicy {
  /** Exact UTC instant of the public protocol 0.2.0 release; supplied by the caller. */
  releasedAt: string;
  sendLegacyUntilDays: 90;
  receiveLegacyUntilDays: 180;
  /** Persisted phase for this epoch, when supplied by an observation store. */
  maximumObservedPhase?: ProtocolCompatibilityPhase;
}
export const PROTOCOL_DAY_MS = 86_400_000;
export function isManifestProtocolVersion(value: unknown): value is ManifestProtocolVersion {
  return MANIFEST_PROTOCOL_VERSIONS.some(version => version === value);
}
/** Unknown strings have no ordering in the local manifest protocol. */
export function compareProtocolVersions(left: string, right: string): number {
  if (!isManifestProtocolVersion(left) || !isManifestProtocolVersion(right))
    throw new Error('PROTOCOL_VERSION_UNSUPPORTED');
  return MANIFEST_PROTOCOL_VERSIONS.indexOf(right) - MANIFEST_PROTOCOL_VERSIONS.indexOf(left);
}
export function protocolCompatibilityPhase(policy: ProtocolCompatibilityPolicy, now: number): ProtocolCompatibilityPhase {
  const released = Date.parse(policy.releasedAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(policy.releasedAt) ||
      !Number.isFinite(released) || new Date(released).toISOString().replace('.000Z', 'Z') !== policy.releasedAt.replace('.000Z', 'Z') ||
      !Number.isFinite(now) || now < released || policy.sendLegacyUntilDays !== 90 ||
      policy.receiveLegacyUntilDays !== 180 ||
      (policy.maximumObservedPhase !== undefined && ![0, 1, 2].includes(policy.maximumObservedPhase)))
    throw new Error('PROTOCOL_POLICY_INVALID');
  const phase = now >= released + 180 * PROTOCOL_DAY_MS ? 2 : now >= released + 90 * PROTOCOL_DAY_MS ? 1 : 0;
  return Math.max(phase, policy.maximumObservedPhase ?? 0) as ProtocolCompatibilityPhase;
}
export function supportedReceiveVersions(policy: ProtocolCompatibilityPolicy, now: number): ManifestProtocolVersion[] {
  return protocolCompatibilityPhase(policy, now) < 2 ? [...MANIFEST_PROTOCOL_VERSIONS] : ['0.2.0'];
}
export function supportedSendVersions(policy: ProtocolCompatibilityPolicy, now: number): ManifestProtocolVersion[] {
  return protocolCompatibilityPhase(policy, now) === 0 ? [...MANIFEST_PROTOCOL_VERSIONS] : ['0.2.0'];
}
/** Absent legacy capabilities imply 0.1.0 only; explicit unknown versions imply nothing. */
export function understoodProtocolVersions(peerVersions?: readonly string[]): ManifestProtocolVersion[] {
  const advertised = peerVersions ?? ['0.1.0'];
  return MANIFEST_PROTOCOL_VERSIONS.filter(version => advertised.includes(version));
}
function assertFloor(version: ManifestProtocolVersion, observedFloor?: ManifestProtocolVersion): void {
  if (observedFloor !== undefined && compareProtocolVersions(version, observedFloor) < 0)
    throw new Error('PROTOCOL_DOWNGRADE_REFUSED');
}
export function selectProtocolVersion(
  peerVersions: readonly string[] | undefined,
  observedFloor: ManifestProtocolVersion | undefined,
  policy: ProtocolCompatibilityPolicy,
  now: number,
): ManifestProtocolVersion {
  const peer = understoodProtocolVersions(peerVersions);
  const version = supportedSendVersions(policy, now).find(version => peer.includes(version));
  if (!version) throw new Error('PROTOCOL_VERSION_UNSUPPORTED');
  assertFloor(version, observedFloor);
  return version;
}
/** The floor belongs to the authenticated sender owner/agent pair. */
export function assertInboundProtocolVersion(
  version: string,
  senderObservedFloor: ManifestProtocolVersion | undefined,
  policy: ProtocolCompatibilityPolicy,
  now: number,
): asserts version is ManifestProtocolVersion {
  if (!supportedReceiveVersions(policy, now).some(candidate => candidate === version))
    throw new Error('PROTOCOL_VERSION_UNSUPPORTED');
  assertFloor(version as ManifestProtocolVersion, senderObservedFloor);
}
