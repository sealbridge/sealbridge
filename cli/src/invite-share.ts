// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync, mkdirSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import QRCode from 'qrcode';
import { createInviteToken, createSignedAgentCard, generateKeyPair, inviteTokenFromUri, parseAndVerifyInviteToken, signPayload, verifySigned } from '@acp/core';
import type { Invite, KeyPair, Signed } from '@acp/core';
import { inspectStoredIdentity } from '@acp/runtime/key-store';
import type { IdentityStoreOptions } from '@acp/runtime/key-store';
import { commandIdentity } from './command-identity.js';
import { addContact, contactsPath } from './contacts.js';

export function inviteToken(value: string): string {
  return inviteTokenFromUri(value);
}
export function openInvite(value: string, now = Date.now()): Invite {
  return parseAndVerifyInviteToken(inviteToken(value), now);
}
export function shareLink(token: string, host: string): string {
  openInvite(token);
  const u = new URL(host);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash)
    throw new Error('INVALID_SHARE_HOST');
  u.hash = inviteToken(token);
  return u.href;
}
/** The QR contains exactly the verified link; no remote shortening or QR service. */
export async function renderInviteQr(link: string, format: 'terminal' | 'svg' | 'png'): Promise<string | Buffer> {
  openInvite(link);
  try {
    if (format === 'png') return await QRCode.toBuffer(link, { errorCorrectionLevel: 'L', margin: 4 });
    return await QRCode.toString(link, { type: format, errorCorrectionLevel: 'L', margin: 4 });
  } catch { throw new Error('QR_CAPACITY_EXCEEDED: share the full link instead; no truncated QR was created'); }
}
export function verifiedExpiredInvite(value: string): Invite {
  const token = inviteToken(value);
  let issuedAt: string;
  try { issuedAt = JSON.parse(Buffer.from(token.slice(11), 'base64url').toString()).payload.issuedAt; }
  catch { throw new Error('INVALID_INVITE'); }
  const time = Date.parse(issuedAt);
  if (!Number.isFinite(time) || time > Date.now()) throw new Error('INVALID_INVITE');
  return parseAndVerifyInviteToken(token, time);
}
export function reissueInvite(value: string, key: KeyPair, seconds = 86400, agentKey?: KeyPair): string {
  const old = verifiedExpiredInvite(value);
  if (old.ownerDid !== key.did) throw new Error('INVITE_ISSUER_KEY_REQUIRED');
  const { type: _type, ownerDid: _owner, agentDelegation: _delegation, ...card } = old.agentCard.payload;
  return createInviteToken({ agentCard: createSignedAgentCard({ ...card,
    expiresAt: new Date(Date.now() + seconds * 1000).toISOString() }, key, agentKey), expiresInSeconds: seconds }, key);
}
export function friendlyExpiry(expiresAt: string, now = Date.now(), locale?: string, timeZone?: string): string {
  const date = new Date(expiresAt), remaining = date.getTime() - now;
  if (!Number.isFinite(remaining)) throw new Error('INVALID_INVITE_EXPIRY');
  const minutes = Math.max(1, Math.ceil(Math.abs(remaining) / 60000));
  const amount = minutes < 60 ? `${minutes} minute${minutes === 1 ? '' : 's'}`
    : `${Math.ceil(minutes / 60)} hour${Math.ceil(minutes / 60) === 1 ? '' : 's'}`;
  const local = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'long', timeZone }).format(date);
  return remaining > 0 ? `Expires in ${amount} (${local})` : `Expired ${amount} ago (${local})`;
}
/** Validate remote input before touching local identity; never replace an existing key. */
export function setupInvite(value: string, keyPath: string, contactPath: string, out: string, name?: string) {
  const invite = openInvite(value);
  let key: KeyPair;
  try {
    if (!lstatSync(keyPath).isFile()) throw new Error('INVALID_IDENTITY_FILE');
    key = JSON.parse(readFileSync(keyPath, 'utf8')) as KeyPair;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    key = generateKeyPair();
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    writeFileSync(keyPath, JSON.stringify(key), { flag: 'wx', mode: 0o600 });
  }
  return saveReciprocalInvite(value, invite, key, contactPath, out, name, keyPath);
}
function saveReciprocalInvite(value: string, invite: Invite, key: KeyPair, contactPath: string,
  out: string, name?: string, keyPath?: string, backend?: string) {
  if (!verifySigned(signPayload({ type: 'IdentityCheck' }, key), key.did)) throw new Error('INVALID_IDENTITY_KEY');
  if (key.did === invite.ownerDid) throw new Error('SELF_INVITE');
  const card = createSignedAgentCard({ name: 'Sealbridge contact', agentDid: key.did, relayEndpoint: invite.relayUrl,
    skills: [{ id: 'json-task', name: 'JSON task' }], accessMode: 'invite-only',
    expiresAt: new Date(Date.now() + 86400000).toISOString() }, key);
  const reciprocal = createInviteToken({ agentCard: card, expiresInSeconds: 86400 }, key);
  writeFileSync(out, reciprocal, { flag: 'wx', mode: 0o600 });
  addContact(contactPath, key, inviteToken(value), name);
  return { ownerDid: key.did, keyFile: keyPath, reciprocalInviteFile: out,
    ...(backend !== undefined ? { keyStore: backend, role: 'requester' } : {}) };
}
interface ReissueRequest { type: 'InviteReissueRequest'; requesterDid: string; issuerDid: string; createdAt: string; }
async function confirm(message: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { if ((await rl.question(message + ' Type yes: ')).trim() !== 'yes') throw new Error('APPROVAL_REJECTED'); }
  finally { rl.close(); }
}
export async function inviteShareCommand(action: string, args: string[], identityOptions: IdentityStoreOptions = {}): Promise<void> {
  const allowed = ['--file', '--host', '--png', '--svg', '--save-contact', '--key', '--agent-key', '--contacts', '--out', '--request'];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || flags.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--'))
      throw new Error('INVALID_INVITE_OPTION: automatic approval is not supported');
    flags.set(args[i], args[i + 1]);
  }
  const need = (name: string) => { const v = flags.get('--' + name); if (!v) throw new Error('Missing --' + name); return v; };
  const value = readFileSync(need('file'), 'utf8').trim();
  if (action === 'open') {
    const p = openInvite(value);
    const contactPath = flags.get('--contacts') ?? contactsPath();
    const keyPath = flags.get('--key');
    const out = flags.get('--out') ?? join(keyPath ? dirname(keyPath) : dirname(contactsPath()), 'reciprocal-' + randomUUID() + '.txt');
    let local;
    if (keyPath !== undefined) local = setupInvite(value, keyPath, contactPath, out, flags.get('--save-contact'));
    else {
      const key = (await commandIdentity('requester', undefined, identityOptions))!;
      const stored = await inspectStoredIdentity('requester', identityOptions);
      if (!flags.has('--out')) mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
      local = saveReciprocalInvite(value, p, key, contactPath, out, flags.get('--save-contact'),
        stored.backend === 'file' ? stored.location : undefined, stored.backend);
    }
    const expiresAt = new Date(Math.min(Date.parse(p.expiresAt), Date.parse(p.agentCard.payload.expiresAt))).toISOString();
    console.log(JSON.stringify({ name: p.agentCard.payload.name, ownerDid: p.ownerDid, agentDid: p.agentDid,
      relay: p.relayUrl, expires: friendlyExpiry(expiresAt), expiresAt, local,
      nextStep: local.keyFile
        ? 'Share reciprocalInviteFile with the inviter through your trusted channel. Start a sandbox worker with keyFile and this relay to receive JSON jobs.'
        : 'Share reciprocalInviteFile with the inviter through your trusted channel. The reciprocal identity uses the requester role in the selected key store.',
      approval: 'Opening an invite does not approve work or allow automatic acceptance.' }));
  } else if (action === 'share') {
    const link = shareLink(value, need('host'));
    console.log(link);
    console.log(await renderInviteQr(link, 'terminal'));
    for (const type of ['png', 'svg'] as const) if (flags.has('--' + type))
      writeFileSync(need(type), await renderInviteQr(link, type), { flag: 'wx', mode: 0o600 });
  } else if (action === 'request-reissue') {
    const old = verifiedExpiredInvite(value);
    const key = (await commandIdentity('requester', flags.get('--key'), identityOptions))!;
    const request = signPayload<ReissueRequest>({ type: 'InviteReissueRequest', requesterDid: key.did,
      issuerDid: old.ownerDid, createdAt: new Date().toISOString() }, key);
    writeFileSync(need('out'), JSON.stringify(request), { flag: 'wx', mode: 0o600 });
    console.log('Re-issue request saved. Send it to the issuer for approval.');
  } else if (action === 'reissue') {
    const key = (await commandIdentity('worker', flags.get('--key'), identityOptions))!;
    if (flags.has('--request')) {
      const r = JSON.parse(readFileSync(need('request'), 'utf8')) as Signed<ReissueRequest>;
      if (!verifySigned(r, r.payload.requesterDid) || r.payload.type !== 'InviteReissueRequest' ||
          r.payload.issuerDid !== key.did || !Number.isFinite(Date.parse(r.payload.createdAt)) ||
          Math.abs(Date.now() - Date.parse(r.payload.createdAt)) > 86400000) throw new Error('INVALID_REISSUE_REQUEST');
      await confirm('Approve re-issue requested by ' + r.payload.requesterDid + '?');
    } else await confirm('Approve a fresh 24-hour invite for the same identity?');
    const agentKey = flags.has('--agent-key') ? JSON.parse(readFileSync(need('agent-key'), 'utf8')) as KeyPair : undefined;
    writeFileSync(need('out'), reissueInvite(value, key, 86400, agentKey), { flag: 'wx', mode: 0o600 });
    console.log('Fresh invite saved. Previous invite retains its own expiry/revocation.');
  } else throw new Error('INVALID_INVITE_ACTION');
}
