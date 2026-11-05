// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';

/**
 * Link-path verification number. inviteDigest is the existing canonical
 * `sha256:<64 lowercase hex digits>` string (digest of the verified Invite),
 * encoded as UTF-8 including the prefix, not decoded hex or a hash of token text.
 * Read the first four SHA-256 bytes as an unsigned big-endian integer.
 */
export function inviteLinkVerificationNumber(inviteDigest: string): string {
  if (typeof inviteDigest !== 'string' || inviteDigest.length !== 71 || !/^sha256:[0-9a-f]{64}$/.test(inviteDigest))
    throw new Error('INVALID_INVITE_DIGEST');
  const hash = createHash('sha256').update('sealbridge/sas/v1', 'utf8').update(inviteDigest, 'utf8').digest();
  return (hash.readUInt32BE(0) % 1_000_000).toString().padStart(6, '0');
}
