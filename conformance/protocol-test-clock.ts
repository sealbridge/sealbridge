// SPDX-License-Identifier: Apache-2.0
import { PROTOCOL_020_RELEASED_AT } from '../packages/runtime/src/protocol-release.js';

/**
 * Keep unrelated CLI/integration fixtures in the initial compatibility window.
 * CLI paths construct LiveProtocol internally without a policy override. Start
 * one day after a configured release, leaving room for these fixtures' advances
 * (well under 90 days); pre-release builds retain their original fixed dates.
 * Release-phase tests should inject their own protocolPolicy and now instead.
 */
export function protocolTestNow(preReleaseInstant: string): number {
  return PROTOCOL_020_RELEASED_AT === null
    ? Date.parse(preReleaseInstant)
    : Date.parse(PROTOCOL_020_RELEASED_AT) + 86_400_000;
}
