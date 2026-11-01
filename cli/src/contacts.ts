// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseAndVerifyInviteToken, signPayload, verifySigned } from '@acp/core';
import type { KeyPair, Signed } from '@acp/core';
import type { ApprovalProvider, WorkerAcceptancePolicy } from '@acp/runtime';
import { PolicyAutoApprovalProvider } from '@acp/runtime';
import type { IdentityStoreOptions } from '@acp/runtime/key-store';
import { commandIdentity, readCommandKey } from './command-identity.js';

export interface Contact {
  displayName: string;
  ownerDid: string;
  agentDid: string;
  relay: string;
  verifiedAt: string;
  allow: boolean;
  revoked: boolean;
  saved: boolean;
}
interface Contacts { version: 1; ownerDid: string; contacts: Contact[] }
export function contactsPath(): string {
  const base = process.env.ACP_DATA_DIR ?? (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? homedir(), 'AgentCollaborationPlatform')
    : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'AgentCollaborationPlatform')
    : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'agent-collab-platform'));
  return join(base, 'contacts.json');
}
export function loadContacts(path: string, ownerDid: string): Contact[] {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  try {
    const signed = JSON.parse(raw) as Signed<Contacts>;
    const p = signed.payload;
    if (!verifySigned(signed, ownerDid) || p.version !== 1 || p.ownerDid !== ownerDid || !Array.isArray(p.contacts)) throw new Error();
    const seen = new Set<string>();
    for (const c of p.contacts) {
      if (!c || typeof c.displayName !== 'string' || c.displayName.length > 200 ||
          !c.ownerDid.startsWith('did:key:') || !c.agentDid.startsWith('did:key:') ||
          typeof c.relay !== 'string' || !Number.isFinite(Date.parse(c.verifiedAt)) ||
          typeof c.allow !== 'boolean' || typeof c.revoked !== 'boolean' || typeof c.saved !== 'boolean' ||
          (c.allow && (c.revoked || !c.saved)) || seen.has(c.ownerDid)) throw new Error();
      seen.add(c.ownerDid);
    }
    return p.contacts;
  } catch { throw new Error('CONTACTS_INVALID: signature, owner or schema mismatch'); }
}
export function updateContacts(path: string, key: KeyPair, change: (contacts: Contact[]) => void): Contact[] {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Exclusive lock prevents concurrent read-modify-write updates from losing revocations.
  const lock = path + '.lock';
  writeFileSync(lock, '', { flag: 'wx', mode: 0o600 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    const contacts = loadContacts(path, key.did);
    change(contacts);
    const signed = signPayload({ version: 1 as const, ownerDid: key.did, contacts }, key);
    writeFileSync(temporary, JSON.stringify(signed, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
    return contacts;
  } finally {
    try { unlinkSync(temporary); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    unlinkSync(lock);
  }
}
export function addContact(path: string, key: KeyPair, token: string, name?: string, allowPrivateRelay = false): Contact[] {
  const invite = parseAndVerifyInviteToken(token, Date.now(), { allowPrivateRelay });
  const displayName = name ?? invite.agentCard.payload.name;
  if (!displayName || displayName.length > 200 || /[\x00-\x1f\x7f]/.test(displayName)) throw new Error('INVALID_CONTACT_NAME');
  return updateContacts(path, key, (contacts) => {
    const old = contacts.find(c => c.ownerDid === invite.ownerDid);
    const contact: Contact = { displayName, ownerDid: invite.ownerDid, agentDid: invite.agentDid,
      relay: invite.relayUrl, verifiedAt: new Date().toISOString(), allow: old?.allow ?? false, revoked: old?.revoked ?? false, saved: true };
    if (old) Object.assign(old, contact); else contacts.push(contact);
  });
}
export function contactsApproval(path: string, key: KeyPair, automatic: boolean,
  base: WorkerAcceptancePolicy, interactive: ApprovalProvider): ApprovalProvider {
  return { async approve(request) {
    const contacts = loadContacts(path, key.did);
    {
      const details = request.details as { manifest?: { requester?: { ownerDid?: string } } } | undefined;
      const did = details?.manifest?.requester?.ownerDid;
      const contact = contacts.find(c => c.ownerDid === did);
      if (contact?.revoked) throw new Error('CONTACT_REVOKED');
      if (automatic && request.gate === 'contract_acceptance' && contact && !contact.allow) throw new Error('CONTACT_NOT_ALLOWED');
    }
    const acceptance = { ...base, allowedRequesterDids: [...new Set([
      ...(base.allowedRequesterDids ?? []), ...contacts.filter(c => c.allow && !c.revoked).map(c => c.ownerDid),
    ])] };
    return (automatic ? new PolicyAutoApprovalProvider(key, undefined, { acceptance }) : interactive).approve(request);
  } };
}
export function contactsCommand(args: string[], identityOptions: IdentityStoreOptions = {}): void | Promise<void> {
  const [action, ...rest] = args;
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) { positional.push(rest[i]); continue; }
    const flag = rest[i];
    if (!['--key', '--file', '--name', '--allow-private-relay'].includes(flag) || options.has(flag)) throw new Error('INVALID_CONTACT_OPTION');
    if (flag === '--allow-private-relay') { options.set(flag, 'true'); continue; }
    const value = rest[++i];
    if (!value || value.startsWith('--')) throw new Error('MISSING_CONTACT_OPTION');
    options.set(flag, value);
  }
  if (!['list', 'add', 'allow', 'revoke', 'remove'].includes(action) || positional.length !== (action === 'list' ? 0 : 1))
    throw new Error('Usage: sealbridge contacts list|add <invite>|allow <ownerDid>|revoke <ownerDid>|remove <ownerDid> --key <key> [--file <contacts.json>] [--name <name>]');
  const run = (key: KeyPair | undefined) => {
    if (!key) { console.log(JSON.stringify({ version: 1, contacts: [] })); return; }
    const path = options.get('--file') ?? contactsPath();
    let contacts: Contact[];
    if (action === 'list') contacts = loadContacts(path, key.did);
    else if (action === 'add') contacts = addContact(path, key, positional[0], options.get('--name'), options.has('--allow-private-relay'));
    else contacts = updateContacts(path, key, (items) => {
      const index = items.findIndex(c => c.ownerDid === positional[0]);
      if (index < 0) throw new Error('CONTACT_NOT_FOUND');
      if (action === 'remove') {
        items[index].saved = false;
        items[index].displayName = '';
        items[index].allow = false;
        items[index].revoked = true;
      } else {
        if (action === 'allow' && !items[index].saved) throw new Error('CONTACT_NOT_SAVED');
        items[index].allow = action === 'allow'; items[index].revoked = action === 'revoke';
      }
    });
    console.log(JSON.stringify({ version: 1, contacts: contacts.filter(c => c.saved) }));
  };
  // Explicit-file callers retain synchronous completion and errors.
  const keyFile = options.get('--key');
  if (keyFile !== undefined) return run(readCommandKey(keyFile));
  return commandIdentity('requester', undefined, identityOptions, action !== 'list').then(run);
}
