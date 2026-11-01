// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  assertInboundProtocolVersion, compareProtocolVersions, protocolCompatibilityPhase,
  PROTOCOL_DAY_MS, selectProtocolVersion, supportedReceiveVersions, supportedSendVersions,
} from '../packages/core/src/index.js';
import type { ProtocolCompatibilityPolicy } from '../packages/core/src/index.js';

// Test epoch only; operational activation supplies its own release instant.
const policy: ProtocolCompatibilityPolicy = {
  releasedAt: '2030-01-01T00:00:00.000Z', sendLegacyUntilDays: 90, receiveLegacyUntilDays: 180,
};
const release = Date.parse(policy.releasedAt), day = PROTOCOL_DAY_MS;
describe('manifest compatibility windows', () => {
  it.each([
    [0, 0, true, true], [90 * day - 1, 0, true, true], [90 * day, 1, false, true],
    [90 * day + 1, 1, false, true], [180 * day - 1, 1, false, true],
    [180 * day, 2, false, false], [180 * day + 1, 2, false, false],
  ] as const)('applies the phase at release plus %i milliseconds', (offset, phase, send, receive) => {
    const now = release + offset;
    expect(protocolCompatibilityPhase(policy, now)).toBe(phase);
    expect(supportedSendVersions(policy, now)).toEqual(send ? ['0.2.0', '0.1.0'] : ['0.2.0']);
    expect(supportedReceiveVersions(policy, now)).toEqual(receive ? ['0.2.0', '0.1.0'] : ['0.2.0']);
    if (send) expect(selectProtocolVersion(undefined, undefined, policy, now)).toBe('0.1.0');
    else expect(() => selectProtocolVersion(['0.1.0'], undefined, policy, now)).toThrow('PROTOCOL_VERSION_UNSUPPORTED');
    if (receive) expect(() => assertInboundProtocolVersion('0.1.0', undefined, policy, now)).not.toThrow();
    else expect(() => assertInboundProtocolVersion('0.1.0', '0.2.0', policy, now)).toThrow('PROTOCOL_VERSION_UNSUPPORTED');
    expect(selectProtocolVersion(['0.1.0', '0.2.0'], undefined, policy, now)).toBe('0.2.0');
  });
  it('uses only understood common versions and treats omission as legacy capability', () => {
    expect(selectProtocolVersion(undefined, undefined, policy, release)).toBe('0.1.0');
    expect(selectProtocolVersion(['3.0.0', '0.1.0'], undefined, policy, release)).toBe('0.1.0');
    expect(selectProtocolVersion(['3.0.0', '0.2.0'], undefined, policy, release)).toBe('0.2.0');
    for (const versions of [[], ['3.0.0']])
      expect(() => selectProtocolVersion(versions, undefined, policy, release)).toThrow('PROTOCOL_VERSION_UNSUPPORTED');
    expect(compareProtocolVersions('0.2.0', '0.1.0')).toBeGreaterThan(0);
    expect(compareProtocolVersions('0.1.0', '0.1.0')).toBe(0);
    expect(() => compareProtocolVersions('3.0.0', '0.2.0')).toThrow('PROTOCOL_VERSION_UNSUPPORTED');
  });
  it('checks a sender floor independently of receive capability and preserves error precedence', () => {
    for (const versions of [undefined, ['0.1.0']])
      expect(() => selectProtocolVersion(versions, '0.2.0', policy, release)).toThrow('PROTOCOL_DOWNGRADE_REFUSED');
    expect(() => assertInboundProtocolVersion('0.1.0', '0.2.0', policy, release + 100 * day)).toThrow('PROTOCOL_DOWNGRADE_REFUSED');
    expect(() => assertInboundProtocolVersion('0.2.0', '0.2.0', policy, release)).not.toThrow();
    expect(() => selectProtocolVersion(['9.0.0'], '0.2.0', policy, release)).toThrow('PROTOCOL_VERSION_UNSUPPORTED');
    expect(() => selectProtocolVersion(undefined, '0.2.0', policy, release + 90 * day)).toThrow('PROTOCOL_VERSION_UNSUPPORTED');
  });
  it('honors persisted phases after clock rollback without mutating caller data', () => {
    expect(supportedSendVersions({ ...policy, maximumObservedPhase: 1 }, release)).toEqual(['0.2.0']);
    expect(supportedReceiveVersions({ ...policy, maximumObservedPhase: 2 }, release)).toEqual(['0.2.0']);
    expect(policy).not.toHaveProperty('maximumObservedPhase');
  });
  it('requires an explicit UTC release instant and a finite clock at or after release', () => {
    for (const releasedAt of ['', 'today', '2030-02-31T00:00:00.000Z', '2030-01-01T00:00:00+00:00'])
      expect(() => supportedSendVersions({ ...policy, releasedAt }, release)).toThrow('PROTOCOL_POLICY_INVALID');
    for (const now of [NaN, Infinity, release - 1])
      expect(() => supportedSendVersions(policy, now)).toThrow('PROTOCOL_POLICY_INVALID');
  });
});
