import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  generateInviteLinkKey,
  encryptInviteLink,
  packInviteLinkCiphertext,
  digest,
  signPayload,
  inviteLinkVerificationNumber,
} from '@acp/core';
import { ensurePrivateDirectory, resolveDataRoot, writePrivateFile } from './local-identity.js';
// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto';
import {
  createRelayAuthToken,
  parseInviteLink,
  deriveInviteLinkKeys,
  inviteLinkClaimTag,
  unpackInviteLinkCiphertext,
  decryptInviteLink,
  parseAndVerifyInviteToken,
  normalizeRelayOrigin,
} from '@acp/core';
import type { KeyPair } from '@acp/core';
import { HttpRelayClient } from '@acp/relay';
import type { InviteStoreOptions } from './invite-store.js';
const UNSUPPORTED = 'INVITE_LINK_UNSUPPORTED_RELAY: relay does not support short links';
const UNAVAILABLE =
  'INVITE_LINK_UNAVAILABLE: short link is used, expired, cancelled or truncated; ask the sender for a fresh link';
function transport(
  relay: string,
  options: { fetch?: typeof fetch },
  allowPrivateRelay = false,
): typeof fetch {
  return new HttpRelayClient(relay, options.fetch ?? fetch, { allowPrivateRelay }).fetcher;
}
export function isShortInviteLink(value: string): boolean {
  return /^(?:https:\/\/sealbridge\.app\/j(?:[?#]|$)|sealbridge:\/\/join(?:[?#]|$))/.test(value);
}
export async function resolveInviteLink(
  value: string,
  options: InviteStoreOptions & { fetch?: typeof fetch } = {},
): Promise<string> {
  return isShortInviteLink(value) ? claimInviteLink(value, options) : value;
}
export async function requestInviteJson(
  fetcher: typeof fetch,
  relay: string,
  path: string,
  method: string,
  owner?: KeyPair,
  body?: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(relay + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        ...(owner
          ? {
              authorization:
                'Bearer ' + createRelayAuthToken(owner, { action: 'invite-manage', origin: relay }),
            }
          : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error('INVITE_LINK_RELAY_UNAVAILABLE');
  }
  if (response.status === 404) {
    throw new Error(
      path === '/v1/capabilities' || path === '/v1/invites' ? UNSUPPORTED : UNAVAILABLE,
    );
  }
  if (!response.ok)
    throw new Error(
      response.status === 429 ? 'INVITE_LINK_RATE_LIMITED' : 'INVITE_LINK_RELAY_REJECTED',
    );
  // Bound untrusted responses independently of Content-Length.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('INVALID_INVITE_LINK_RESPONSE');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 24000) {
        await reader.cancel();
        throw new Error();
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new Error('INVALID_INVITE_LINK_RESPONSE');
  } finally {
    reader.releaseLock();
  }
}
export async function claimInviteLink(
  value: string,
  options: InviteStoreOptions & { fetch?: typeof fetch } = {},
): Promise<string> {
  let parsed: ReturnType<typeof parseInviteLink>;
  try {
    parsed = parseInviteLink(value, options.relayPolicy);
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_INVITE_LINK')
      throw new Error(
        'INVALID_INVITE_LINK: short link is malformed or truncated; use the complete link including its fragment',
      );
    throw error;
  }
  const keys = deriveInviteLinkKeys(parsed.k);
  const fetcher = transport(
    parsed.relayOrigin,
    { fetch: options.fetch },
    options.relayPolicy?.allowPrivateRelay,
  );
  const capabilities = (await requestInviteJson(
    fetcher,
    parsed.relayOrigin,
    '/v1/capabilities',
    'GET',
  )) as { inviteLinks?: number };
  if (capabilities?.inviteLinks !== 1) throw new Error(UNSUPPORTED);
  const claim = {
    id: keys.id.toString('base64url'),
    tag: inviteLinkClaimTag(keys.accessKey, keys.id).toString('base64url'),
    claimNonce: randomBytes(32).toString('base64url'),
  };
  let response: unknown;
  try {
    response = await requestInviteJson(
      fetcher,
      parsed.relayOrigin,
      '/v1/invites/claim',
      'POST',
      undefined,
      claim,
    );
  } catch (error) {
    // A lost reply may follow a successful claim. Reuse the same nonce once,
    // inside the relay's 120-second recovery window; terminal refusals stay terminal.
    if (
      !(error instanceof Error) ||
      !['INVITE_LINK_RELAY_UNAVAILABLE', 'INVALID_INVITE_LINK_RESPONSE'].includes(error.message)
    )
      throw error;
    response = await requestInviteJson(
      fetcher,
      parsed.relayOrigin,
      '/v1/invites/claim',
      'POST',
      undefined,
      claim,
    );
  }
  const encrypted = unpackInviteLinkCiphertext(response);
  const token = decryptInviteLink(encrypted, parsed.k, parsed.relayOrigin);
  const invite = parseAndVerifyInviteToken(token, Date.now(), options.relayPolicy);
  if (normalizeRelayOrigin(invite.relayUrl) !== parsed.relayOrigin)
    throw new Error('INVITE_LINK_RELAY_MISMATCH');
  return token;
}

export interface SharedInvite {
  link: string;
  verificationNumber: string;
  expiresAt: string;
  linkRef?: string;
  relayOrigin: string;
  warning?: string;
}
/** Publish only encrypted invite bytes; unsupported relays may explicitly fall back. */
export async function shareInvite(
  token: string,
  owner: KeyPair,
  options: InviteStoreOptions & {
    fetch?: typeof fetch;
    fallback?: boolean;
    expiresInSeconds?: number;
  } = {},
): Promise<SharedInvite> {
  const now = options.now?.() ?? Date.now();
  const invite = parseAndVerifyInviteToken(token, now, {
    ...options.relayPolicy,
    allowPrivateRelay: true,
  });
  const relayOrigin = normalizeRelayOrigin(invite.relayUrl);
  const inviteDigest = digest(invite);
  const verificationNumber = inviteLinkVerificationNumber(inviteDigest);
  const tokenExpiry = Math.min(
    Date.parse(invite.expiresAt),
    Date.parse(invite.agentCard.payload.expiresAt),
  );
  const longLink = {
    link: 'https://sealbridge.app/i#' + token,
    verificationNumber,
    expiresAt: new Date(tokenExpiry).toISOString(),
    relayOrigin,
  };
  const fallback = () => ({
    ...longLink,
    warning:
      'INVITE_LINK_UNSUPPORTED_RELAY: relay does not support short links; sharing the long invitation link instead',
  });
  if (new URL(invite.relayUrl).protocol !== 'https:' || new URL(invite.relayUrl).pathname !== '/') {
    if (options.fallback) return fallback();
    throw new Error('INVALID_INVITE_LINK_RELAY');
  }
  const expiresAt = new Date(
    Math.min(tokenExpiry, now + (options.expiresInSeconds ?? 86400) * 1000),
  ).toISOString();
  const k = generateInviteLinkKey(),
    keys = deriveInviteLinkKeys(k);
  const link =
    'https://sealbridge.app/j#v=1&k=' +
    k +
    (relayOrigin === 'https://relay.sealbridge.dev'
      ? ''
      : '&r=' + encodeURIComponent(new URL(relayOrigin).host));
  parseInviteLink(link, options.relayPolicy);
  const fetcher = transport(relayOrigin, options, options.relayPolicy?.allowPrivateRelay);
  try {
    const capabilities = (await requestInviteJson(
      fetcher,
      relayOrigin,
      '/v1/capabilities',
      'GET',
    )) as { inviteLinks?: number };
    if (capabilities.inviteLinks !== 1) throw new Error(UNSUPPORTED);
  } catch (error) {
    if (
      options.fallback &&
      error instanceof Error &&
      error.message.startsWith('INVITE_LINK_UNSUPPORTED_RELAY')
    )
      return fallback();
    throw error;
  }
  const encrypted = packInviteLinkCiphertext(
    encryptInviteLink(token, k, { relayOrigin, expiresAt, now }),
  );
  const dir = join(
    resolveDataRoot(options),
    'invite-links',
    createHash('sha256').update(owner.did).digest('hex'),
  );
  ensurePrivateDirectory(dir, fs);
  writePrivateFile(
    join(dir, encrypted.id + '.json'),
    Buffer.from(
      JSON.stringify(
        signPayload(
          {
            type: 'CreatedInviteLink',
            ownerDid: owner.did,
            id: encrypted.id,
            relayOrigin,
            inviteDigest,
            expiresAt,
          },
          owner,
        ),
      ),
    ),
    fs,
  );
  await requestInviteJson(fetcher, relayOrigin, '/v1/invites', 'POST', owner, {
    ...encrypted,
    tagHash: createHash('sha256')
      .update(inviteLinkClaimTag(keys.accessKey, keys.id))
      .digest('base64url'),
  });
  return { link, verificationNumber, expiresAt, linkRef: encrypted.id, relayOrigin };
}
export async function sharedInviteConsumed(
  invite: SharedInvite,
  owner: KeyPair,
  options: { fetch?: typeof fetch; allowPrivateRelay?: boolean } = {},
): Promise<boolean> {
  if (!invite.linkRef) return false;
  const result = (await requestInviteJson(
    transport(invite.relayOrigin, options, options.allowPrivateRelay),
    invite.relayOrigin,
    '/v1/invites/' + invite.linkRef + '/status',
    'GET',
    owner,
  )) as { status?: string };
  return result.status === 'claimed';
}
