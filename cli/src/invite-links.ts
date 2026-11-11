// SPDX-License-Identifier: Apache-2.0
import { cliName } from './distribution.js';
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { createInviteToken, createSignedAgentCard, createRelayAuthToken, generateInviteLinkKey,
  deriveInviteLinkKeys, inviteLinkClaimTag, inviteLinkExpiry, encryptInviteLink, packInviteLinkCiphertext,
  parseInviteLink, unpackInviteLinkCiphertext, decryptInviteLink, parseAndVerifyInviteToken,
  digest, normalizeRelayOrigin, inviteLinkVerificationNumber, signPayload, verifySigned,
  createRevocationNotice, RevocationRegistry } from '@acp/core';
import type { KeyPair, Signed, RevocationList } from '@acp/core';
import { HttpRelayClient } from '@acp/relay';
import { LiveProtocol, readApplicationConfig } from '@acp/runtime';
import type { IdentityStoreOptions, InviteStoreOptions } from '@acp/runtime';
import { resolveDataRoot, ensurePrivateDirectory, inspectPrivateDirectory, writePrivateFile, readPrivateFile } from '@acp/runtime/local-identity';
import { commandIdentity } from './command-identity.js';
import { parseInviteOutput, deliverInvite } from './invite-output.js';

export const SHORT_INVITE_USAGE = 'Usage: ' + cliName + ' invite create [--share token|link] [--key FILE] [--relay URL] [--name TEXT] [--expires-in SECONDS] [--link-expires-in 300..259200] [--output stdout|file:PATH|fd:N] [--qr terminal|none] [--png FILE] [--svg FILE] [--allow-private-relay]\n       ' + cliName + ' invite links list | cancel <linkRef> [--key FILE]';
const UNSUPPORTED = 'INVITE_LINK_UNSUPPORTED_RELAY: この relay は短いリンクを受け付けませんでした。古い relay か、わざと断っているのかは区別できません。ほかの relay を使うか、--share token を自分で選んでください';
const UNAVAILABLE = 'INVITE_LINK_UNAVAILABLE: このリンクは使えません。期限切れ、使用済み、または途中が欠けています。送ってくれた人に、新しいリンクを頼んでください。';
interface LinkRecord { type: 'CreatedInviteLink'; ownerDid: string; id: string; relayOrigin: string; inviteDigest: string; expiresAt: string; }
export interface LinkCommandOptions { identityOptions?: IdentityStoreOptions; fetch?: typeof fetch; }
function directory(owner: KeyPair, options: IdentityStoreOptions): string {
  return join(resolveDataRoot(options), 'invite-links', createHash('sha256').update(owner.did).digest('hex'));
}
function saveRecord(owner: KeyPair, record: LinkRecord, options: IdentityStoreOptions): void {
  const dir = directory(owner, options); ensurePrivateDirectory(dir, fs);
  writePrivateFile(join(dir, record.id + '.json'), Buffer.from(JSON.stringify(signPayload(record, owner))), fs);
}
function records(owner: KeyPair, options: IdentityStoreOptions): LinkRecord[] {
  const dir = directory(owner, options);
  if (!fs.existsSync(dir)) return [];
  inspectPrivateDirectory(dir, fs);
  return fs.readdirSync(dir).filter(n => /^[A-Za-z0-9_-]{22}\.json$/.test(n)).map(name => {
    const data = JSON.parse(readPrivateFile(join(dir, name), fs, 8192)!) as Signed<LinkRecord>;
    if (!verifySigned(data, owner.did) || data.payload.type !== 'CreatedInviteLink' || data.payload.ownerDid !== owner.did || data.payload.id + '.json' !== name ||
        !/^sha256:[a-f0-9]{64}$/.test(data.payload.inviteDigest)) throw new Error('INVITE_LINK_STORE_INVALID');
    return data.payload;
  });
}
/** Reread signed cancellation notices for running CLI workers on each admission check. */
export function linkRevocations(owner: KeyPair, options: IdentityStoreOptions = {}): RevocationList {
  const registry = (targetType: 'invite' | 'capability', targetId: string) => {
    const result = new RevocationRegistry();
    if (targetType !== 'invite' || !/^sha256:[a-f0-9]{64}$/.test(targetId)) return result;
    const path = join(directory(owner, options), 'revoked', targetId.slice(7) + '.json');
    const text = readPrivateFile(path, fs, 16384);
    if (text) result.revoke(JSON.parse(text), owner.did);
    return result;
  };
  return { isRevoked: (type, id) => registry(type, id).isRevoked(type, id),
    assertNotRevoked: (type, id) => registry(type, id).assertNotRevoked(type, id),
    noticesFor: (type, id) => registry(type, id).noticesFor(type, id) };
}
function transport(relay: string, options: LinkCommandOptions, allowPrivateRelay = false): typeof fetch {
  return new HttpRelayClient(relay, options.fetch ?? fetch, { allowPrivateRelay }).fetcher;
}
async function requestJson(fetcher: typeof fetch, relay: string, path: string, method: string, owner?: KeyPair, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(relay + path, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { ...(owner ? { authorization: 'Bearer ' + createRelayAuthToken(owner, { action: 'invite-manage', origin: relay }) } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch { throw new Error('INVITE_LINK_RELAY_UNAVAILABLE'); }
  if (response.status === 404) {
    throw new Error(path === '/v1/capabilities' || path === '/v1/invites' ? UNSUPPORTED : UNAVAILABLE);
  }
  if (!response.ok) throw new Error(response.status === 429 ? 'INVITE_LINK_RATE_LIMITED' : 'INVITE_LINK_RELAY_REJECTED');
  // Bound untrusted responses independently of Content-Length.
  const reader = response.body?.getReader(); if (!reader) throw new Error('INVALID_INVITE_LINK_RESPONSE');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > 24000) { await reader.cancel(); throw new Error(); } chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch { throw new Error('INVALID_INVITE_LINK_RESPONSE'); }
  finally { reader.releaseLock(); }
}
export async function claimInviteLink(value: string, options: InviteStoreOptions & { fetch?: typeof fetch } = {}): Promise<string> {
  const parsed = parseInviteLink(value, options.relayPolicy), keys = deriveInviteLinkKeys(parsed.k);
  const fetcher = transport(parsed.relayOrigin, { fetch: options.fetch }, options.relayPolicy?.allowPrivateRelay);
  const capabilities = await requestJson(fetcher, parsed.relayOrigin, '/v1/capabilities', 'GET') as { inviteLinks?: number };
  if (capabilities?.inviteLinks !== 1) throw new Error(UNSUPPORTED);
  const claim = { id: keys.id.toString('base64url'), tag: inviteLinkClaimTag(keys.accessKey, keys.id).toString('base64url'), claimNonce: randomBytes(32).toString('base64url') };
  let response: unknown;
  try { response = await requestJson(fetcher, parsed.relayOrigin, '/v1/invites/claim', 'POST', undefined, claim); }
  catch (error) {
    // A lost reply may follow a successful claim. Reuse the same nonce once,
    // inside the relay's 120-second recovery window; terminal refusals stay terminal.
    if (!(error instanceof Error) || !['INVITE_LINK_RELAY_UNAVAILABLE', 'INVALID_INVITE_LINK_RESPONSE'].includes(error.message)) throw error;
    response = await requestJson(fetcher, parsed.relayOrigin, '/v1/invites/claim', 'POST', undefined, claim);
  }
  const encrypted = unpackInviteLinkCiphertext(response);
  const token = decryptInviteLink(encrypted, parsed.k, parsed.relayOrigin);
  const invite = parseAndVerifyInviteToken(token, Date.now(), options.relayPolicy);
  if (normalizeRelayOrigin(invite.relayUrl) !== parsed.relayOrigin) throw new Error('INVITE_LINK_RELAY_MISMATCH');
  return token;
}
function flags(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (result.has(arg) || !['--key','--relay','--name','--expires-in','--share','--link-expires-in','--output','--qr','--png','--svg','--allow-private-relay'].includes(arg)) throw new Error('INVALID_INVITE_OPTION');
    if (arg === '--allow-private-relay') result.set(arg, 'true');
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('INVALID_INVITE_OPTION'); result.set(arg, args[++i]); }
  }
  return result;
}
export async function createInviteCommand(args: string[], options: LinkCommandOptions = {}): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(SHORT_INVITE_USAGE); return; }
  const f = flags(args), share = f.get('--share') ?? 'token';
  if (share !== 'token' && share !== 'link') throw new Error('INVALID_INVITE_SHARE');
  if (share === 'token' && ['--link-expires-in','--qr','--png','--svg'].some(n => f.has(n))) throw new Error('INVITE_LINK_OPTIONS_REQUIRE_LINK');
  const output = parseInviteOutput(f.get('--output'));
  const ttl = Number(f.get('--link-expires-in') ?? 86400), qr = f.get('--qr') ?? 'terminal';
  if (share === 'link' && (!Number.isInteger(ttl) || ttl < 300 || ttl > 259200 || !['terminal','none'].includes(qr))) throw new Error('INVALID_INVITE_LINK_OPTION');
  const tokenTtl = Number(f.get('--expires-in') ?? (share === 'link' ? ttl + 86400 : 3600));
  if (!Number.isInteger(tokenTtl) || tokenTtl < 1 || tokenTtl > 2592000) throw new Error('INVALID_EXPIRES_IN');
  const relay = f.get('--relay') ?? readApplicationConfig({ ...options.identityOptions, allowPrivateRelay: f.has('--allow-private-relay') }).relays[0];
  const relayOrigin = normalizeRelayOrigin(relay);
  if (share === 'link' && (new URL(relay).protocol !== 'https:' || new URL(relay).pathname !== '/' || new URL(relay).search || new URL(relay).hash || new URL(relay).username || new URL(relay).password)) throw new Error('INVALID_INVITE_LINK_RELAY');
  const now = Date.now(), expiresAt = new Date(now + tokenTtl * 1000).toISOString();
  const owner = (await commandIdentity('worker', f.get('--key'), options.identityOptions ?? {}))!;
  const card = createSignedAgentCard({ name: f.get('--name') ?? 'Sealbridge Worker', agentDid: owner.did,
    relayEndpoint: relay, skills: [{ id: 'json-task', name: 'JSON task' }], protocolVersions: new LiveProtocol().receiveVersions(),
    now, ...(share === 'link' ? { expiresAt } : {}) }, owner);
  const token = createInviteToken({ agentCard: card, issuedAt: new Date(now).toISOString(), expiresInSeconds: tokenTtl }, owner);
  // Token creation only signs locally; private-relay opt-in applies when dialing.
  // Link creation contacts the relay and must retain the caller's network policy.
  const inviteDigest = digest(parseAndVerifyInviteToken(token, now, { allowPrivateRelay: share === 'token' || f.has('--allow-private-relay') }));
  const verificationNumber = inviteLinkVerificationNumber(inviteDigest);
  if (share === 'token') {
    deliverInvite(output, token, true); console.error(JSON.stringify({ verificationNumber, expiresAt })); return;
  }
  const deadline = inviteLinkExpiry(now, ttl * 1000).expiresAt, k = generateInviteLinkKey(), keys = deriveInviteLinkKeys(k);
  const link = 'https://sealbridge.app/j#v=1&k=' + k + (relayOrigin === 'https://relay.sealbridge.dev' ? '' : '&r=' + encodeURIComponent(new URL(relayOrigin).host));
  parseInviteLink(link, { allowPrivateRelay: f.has('--allow-private-relay') });
  const encrypted = packInviteLinkCiphertext(encryptInviteLink(token, k, { relayOrigin, expiresAt: deadline, now }));
  const linkRef = encrypted.id;
  const fetcher = transport(relayOrigin, options, f.has('--allow-private-relay'));
  const capabilities = await requestJson(fetcher, relayOrigin, '/v1/capabilities', 'GET') as { inviteLinks?: number };
  if (capabilities?.inviteLinks !== 1) throw new Error(UNSUPPORTED);
  // Persist only cancellation/status metadata before admission, including when
  // the admission reply is interrupted and its outcome cannot be determined.
  saveRecord(owner, { type: 'CreatedInviteLink', ownerDid: owner.did, id: linkRef, relayOrigin, inviteDigest, expiresAt: deadline }, options.identityOptions ?? {});
  await requestJson(fetcher, relayOrigin, '/v1/invites', 'POST', owner, { ...encrypted,
    tagHash: createHash('sha256').update(inviteLinkClaimTag(keys.accessKey, keys.id)).digest('base64url') });
  deliverInvite(output, link, true);
  console.error(JSON.stringify({ verificationNumber, linkRef, expiresAt: deadline }));
  if (qr === 'terminal' && process.stderr.isTTY) process.stderr.write(await QRCode.toString(link, { type: 'terminal', errorCorrectionLevel: 'L', margin: 4 }));
  else if (qr === 'terminal') console.error('QR は端末でだけ出します');
  for (const format of ['png', 'svg'] as const) if (f.has('--' + format)) {
    const path = f.get('--' + format)!;
    inspectPrivateDirectory(dirname(path), fs);
    const data = format === 'png' ? await QRCode.toBuffer(link, { errorCorrectionLevel: 'L', margin: 4 }) : Buffer.from(await QRCode.toString(link, { type: 'svg', errorCorrectionLevel: 'L', margin: 4 }));
    try { writePrivateFile(path, data, fs); } catch { throw new Error('INVITE_OUTPUT_UNAVAILABLE'); }
  }
}
export async function inviteLinksCommand(args: string[], options: LinkCommandOptions = {}): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(SHORT_INVITE_USAGE); return; }
  const [action, ...rest] = args;
  const linkRef = action === 'cancel' ? rest.shift() : undefined;
  if (!['list','cancel'].includes(action) || (action === 'cancel' && !/^[A-Za-z0-9_-]{22}$/.test(linkRef ?? ''))) throw new Error(SHORT_INVITE_USAGE);
  const f = flags(rest);
  if ([...f.keys()].some(k => !['--key','--allow-private-relay'].includes(k))) throw new Error('INVALID_INVITE_OPTION');
  const owner = await commandIdentity('worker', f.get('--key'), options.identityOptions ?? {}, false);
  if (!owner) { if (action === 'cancel') throw new Error('INVITE_LINK_NOT_FOUND'); console.log(JSON.stringify({ links: [] })); return; }
  const saved = records(owner, options.identityOptions ?? {});
  if (action === 'list') {
    const links = [];
    for (const r of saved) {
      const fetcher = transport(r.relayOrigin, options, f.has('--allow-private-relay'));
      let value: Record<string, unknown>;
      try { value = await requestJson(fetcher, r.relayOrigin, '/v1/invites/' + r.id + '/status', 'GET', owner) as Record<string, unknown>; }
      catch (error) {
        if (!(error instanceof Error) || error.message !== UNAVAILABLE) throw error;
        // An interrupted/failed creation can leave only the local cancellation
        // record. Keep other links inspectable even when this ID is absent.
        links.push({ linkRef: r.id, relay: r.relayOrigin, error: 'INVITE_LINK_UNAVAILABLE' }); continue;
      }
      if (!value || value.id !== r.id || value.expiresAt !== r.expiresAt || !['unused','claimed','expired','cancelled','locked_out'].includes(String(value.status)) ||
          (value.claimedAt !== undefined && (typeof value.claimedAt !== 'string' || !Number.isFinite(Date.parse(value.claimedAt))))) throw new Error('INVALID_INVITE_LINK_RESPONSE');
      const status = { id: r.id, status: value.status, expiresAt: r.expiresAt, ...(value.claimedAt ? { claimedAt: new Date(value.claimedAt as string).toISOString() } : {}) };
      links.push({ linkRef: r.id, relay: r.relayOrigin, status });
    }
    console.log(JSON.stringify({ links })); return;
  }
  const r = saved.find(r => r.id === linkRef); if (!r) throw new Error('INVITE_LINK_NOT_FOUND');
  const path = join(directory(owner, options.identityOptions ?? {}), 'revoked', r.inviteDigest.slice(7) + '.json');
  ensurePrivateDirectory(dirname(path), fs);
  if (!readPrivateFile(path, fs, 16384)) writePrivateFile(path, Buffer.from(JSON.stringify(createRevocationNotice({ targetType: 'invite', targetId: r.inviteDigest, reason: 'Invite link cancelled' }, owner))), fs);
  await requestJson(transport(r.relayOrigin, options, f.has('--allow-private-relay')), r.relayOrigin, '/v1/invites/' + r.id, 'DELETE', owner);
  console.log(JSON.stringify({ linkRef: r.id, cancelled: true, tokenRevoked: true }));
}
