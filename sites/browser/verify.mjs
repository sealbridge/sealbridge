import { parseAndVerifyInviteToken } from '../../packages/core/src/discovery.ts';

export function verifyFragment(hash, now = Date.now()) {
  // Accept only the existing fragment format; never read a query parameter.
  if (!/^#acp-invite:[A-Za-z0-9_-]+$/.test(hash) || hash.length > 65548)
    throw new Error('INVALID_OR_EXPIRED_INVITE');
  const token = hash.slice(1);
  const invite = parseAndVerifyInviteToken(token, now);
  const link = `https://sealbridge.app/i#${token}`;
  return { token, invite, link,
    command: `sealbridge accept "${link}"` };
}
