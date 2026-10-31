// SPDX-License-Identifier: Apache-2.0
import { validateRelayAuthRecoveryOptions } from '@acp/relay';
import type { RelayAuthRecoveryOptions } from '@acp/relay';

export const RELAY_AUTH_HELP = `Relay authentication recovery:
  --relay-auth-retries <n>                 Additional attempts after HTTP 401 (default: 3; 0: fail immediately).
  --relay-auth-recovery-timeout-ms <ms>    Overall recovery window in milliseconds (default: 120000).
HTTP 403 and other permanent rejections remain terminal.`;

export function relayAuthOptions(flags: Map<string, string | true>): RelayAuthRecoveryOptions {
  const count = (flag: string): number | undefined => {
    if (!flags.has(flag)) return undefined;
    const raw = flags.get(flag);
    if (typeof raw !== 'string' || !/^\d+$/.test(raw))
      throw new Error('INVALID_' + flag.slice(2).toUpperCase().replaceAll('-', '_'));
    return Number(raw);
  };
  const options = {
    maxAuthRecoveryAttempts: count('--relay-auth-retries'),
    authRecoveryTimeoutMs: count('--relay-auth-recovery-timeout-ms'),
  };
  validateRelayAuthRecoveryOptions(options);
  return options;
}
