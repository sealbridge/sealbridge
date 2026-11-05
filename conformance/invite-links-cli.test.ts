// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInviteCommand, inviteLinksCommand, claimInviteLink, linkRevocations } from '../cli/src/invite-links.js';
import { acceptCommand } from '../cli/src/accept.js';
import { networkCommand } from '../cli/src/network.js';
import { createRelayFetchHandler } from '../packages/relay/src/fetch.js';
import { generateKeyPair, parseInviteLink, parseAndVerifyInviteToken, digest, inviteLinkVerificationNumber,
  decryptInviteLink, unpackInviteLinkCiphertext, deriveInviteLinkKeys, inviteLinkClaimTag,
  encryptInviteLink, packInviteLinkCiphertext } from '../packages/core/src/index.js';
import { InviteStore } from '../packages/runtime/src/invite-store.js';
import { randomBytes } from 'node:crypto';

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })); vi.restoreAllMocks(); });
function setup() {
  const root = fs.mkdtempSync(join(tmpdir(), 'si1-cli-')); dirs.push(root);
  const logs: string[] = [], errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(value => { logs.push(String(value)); });
  vi.spyOn(console, 'error').mockImplementation(value => { errors.push(String(value)); });
  const owner = generateKeyPair(), key = join(root, 'worker.json'); fs.writeFileSync(key, JSON.stringify(owner), { mode: 0o600 });
  const handler = createRelayFetchHandler(), sent: Request[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); sent.push(request.clone()); return handler(request);
  }) as typeof fetch;
  const identityOptions = { env: { SEALBRIDGE_DATA_DIR: root }, home: root };
  return { root, logs, errors, owner, key, sent, handler, options: { fetch: fetcher, identityOptions } };
}
const createArgs = (key: string) => ['--share','link','--key', key, '--relay','https://relay.example','--qr','none'];

it('creates and accepts a short link with matching verification number and unconfirmed storage', async () => {
  const s = setup();
  await networkCommand('invite', ['create', ...createArgs(s.key)], s.options);
  const link = s.logs[0], meta = JSON.parse(s.errors[0]), parsed = parseInviteLink(link);
  expect(meta).toEqual({ verificationNumber: expect.stringMatching(/^\d{6}$/), linkRef: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), expiresAt: expect.any(String) });
  expect(Date.parse(meta.expiresAt) - Date.now()).toBeGreaterThan(86390000);
  const create = await s.sent.find(r => r.method === 'POST')!.json();
  expect(Object.keys(create).sort()).toEqual(['ciphertext','expiresAt','id','nonce','tagHash']);
  const token = decryptInviteLink(unpackInviteLinkCiphertext({ id: create.id, ciphertext: create.ciphertext, nonce: create.nonce, expiresAt: create.expiresAt }), parsed.k, parsed.relayOrigin);
  const invite = parseAndVerifyInviteToken(token);
  expect(Date.parse(invite.expiresAt) - Date.parse(meta.expiresAt)).toBe(86400000);
  expect(invite.agentCard.payload.expiresAt).toBe(invite.expiresAt);
  expect(meta.verificationNumber).toBe(inviteLinkVerificationNumber(digest(invite)));
  const stdin = new PassThrough(); stdin.end(link + '\n');
  await acceptCommand('accept', ['--stdin','--alias','short-link'], { ...s.options.identityOptions, fetch: s.options.fetch, input: stdin });
  const accepted = JSON.parse(s.logs[1]);
  expect(accepted).toMatchObject({ verificationNumber: meta.verificationNumber, relayContacted: true });
  expect(JSON.stringify(accepted)).not.toContain(parsed.k);
  const privateFile = fs.readdirSync(join(s.root, 'identities')).find(n => n.startsWith('requester'))!;
  const requester = JSON.parse(fs.readFileSync(join(s.root, 'identities', privateFile), 'utf8'));
  const store = await InviteStore.open(requester, s.options.identityOptions);
  expect(store.listUnconfirmed()).toHaveLength(1);
  expect(() => store.resolve('short-link')).toThrow('INVITE_CONFIRMATION_REQUIRED');
  await expect(claimInviteLink(link, { fetch: s.options.fetch })).rejects.toThrow('INVITE_LINK_UNAVAILABLE');
  expect(s.errors.join('')).not.toContain(parsed.k); expect(s.errors.join('')).not.toContain(token);
});

it('keeps token as the offline default, supports output files and adds verification metadata', async () => {
  const s = setup(), file = join(s.root, 'invite.txt');
  await createInviteCommand(['--key',s.key,'--output','file:' + file], s.options);
  expect(s.logs).toHaveLength(0); expect(s.sent).toHaveLength(0);
  const token = fs.readFileSync(file, 'utf8').trim(); expect(token).toMatch(/^acp-invite:/);
  if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  await acceptCommand('accept', [token, '--no-network'], { ...s.options.identityOptions, fetch: s.options.fetch });
  expect(JSON.parse(s.logs[0])).toMatchObject({ relayContacted: false, verificationNumber: JSON.parse(s.errors[0]).verificationNumber });
  expect(s.sent).toHaveLength(0);
});

it.each(['127.0.0.1', '10.0.0.1', '[::1]'])('keeps short-link create and claim SSRF checks for %s', async host => {
  const s = setup();
  await expect(createInviteCommand(['--key', s.key, '--relay', 'https://' + host,
    '--share', 'link', '--qr', 'none'], s.options)).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
  const link = 'https://sealbridge.app/j#v=1&k=' + randomBytes(32).toString('base64url') + '&r=' + encodeURIComponent(host);
  await expect(claimInviteLink(link, { fetch: s.options.fetch })).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
  expect(s.sent).toHaveLength(0);
  expect(s.logs).toHaveLength(0);
});

it('refuses short links with --no-network before identity creation or relay access', async () => {
  const s = setup(), link = 'sealbridge://join#v=1&k=' + randomBytes(32).toString('base64url');
  await expect(acceptCommand('accept', [link, '--no-network'], { ...s.options.identityOptions, fetch: s.options.fetch })).rejects.toThrow('INVITE_LINK_NETWORK_REQUIRED');
  expect(s.sent).toHaveLength(0); expect(fs.existsSync(join(s.root, 'identities'))).toBe(false);
});

it('gives an explicit old-relay error and never falls back to a token', async () => {
  const s = setup(), oldFetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
  await expect(createInviteCommand(createArgs(s.key), { ...s.options, fetch: oldFetch })).rejects.toThrow('INVITE_LINK_UNSUPPORTED_RELAY');
  expect(s.logs).toHaveLength(0); expect(s.errors).toHaveLength(0); expect(oldFetch).toHaveBeenCalledTimes(1);
  const link = 'sealbridge://join#v=1&k=' + randomBytes(32).toString('base64url');
  await expect(claimInviteLink(link, { fetch: oldFetch })).rejects.toThrow('INVITE_LINK_UNSUPPORTED_RELAY');
});

it('routes link output to private files/fds, makes 0600 QR files and suppresses non-TTY QR', async () => {
  const s = setup(), linkFile = join(s.root, 'link.txt'), png = join(s.root, 'qr.png'), svg = join(s.root, 'qr.svg');
  expect(process.stderr.isTTY).not.toBe(true);
  await createInviteCommand([...createArgs(s.key).slice(0, -2), '--output','file:' + linkFile,'--png',png,'--svg',svg], s.options);
  const link = fs.readFileSync(linkFile,'utf8').trim(), k = parseInviteLink(link).k;
  expect(s.logs).toHaveLength(0); expect(s.errors).toHaveLength(2); expect(s.errors[1]).toBe('QR は端末でだけ出します');
  expect(s.errors.join('')).not.toContain(k);
  if (process.platform !== 'win32') {
    for (const path of [linkFile,png,svg]) expect(fs.statSync(path).mode & 0o777).toBe(0o600);
  }
  expect(fs.readFileSync(png).subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(fs.readFileSync(svg,'utf8')).toContain('<svg');
  if (process.platform === 'win32') {
    await expect(createInviteCommand([...createArgs(s.key),'--output','fd:3'], s.options)).rejects.toThrow('INVITE_OUTPUT_FD_UNSUPPORTED_PLATFORM');
  } else {
    const fdFile = join(s.root,'fd.txt'), fd = fs.openSync(fdFile, 'wx', 0o600);
    try { await createInviteCommand([...createArgs(s.key),'--output','fd:' + fd], s.options); fs.fstatSync(fd); }
    finally { fs.closeSync(fd); }
    expect(fs.readFileSync(fdFile, 'utf8')).toMatch(/^https:\/\/sealbridge\.app\/j#v=1&k=/);
  }
});

it('lists statuses without bearer material and cancellation revokes the inner invite for running workers', async () => {
  const s = setup(); await createInviteCommand(createArgs(s.key), s.options);
  const link = s.logs[0], k = parseInviteLink(link).k, meta = JSON.parse(s.errors[0]);
  const live = linkRevocations(s.owner, s.options.identityOptions);
  await networkCommand('invite',['links','list','--key',s.key],s.options);
  expect(JSON.parse(s.logs[1]).links[0]).toMatchObject({ linkRef: meta.linkRef, status: { status: 'unused' } });
  const token = await claimInviteLink(link, { fetch: s.options.fetch }), id = digest(parseAndVerifyInviteToken(token));
  expect(live.isRevoked('invite', id)).toBe(false);
  await networkCommand('invite',['links','cancel',meta.linkRef,'--key',s.key],s.options);
  expect(JSON.parse(s.logs[2])).toMatchObject({ cancelled: true, tokenRevoked: true });
  expect(live.isRevoked('invite', id)).toBe(true);
  expect(() => live.assertNotRevoked('invite', id)).toThrow('REVOKED');
  const create = await s.sent.find(r => r.method === 'POST')!.json();
  const keys = deriveInviteLinkKeys(k);
  const response = await s.handler(new Request('https://relay.example/v1/invites/claim', { method: 'POST', body: JSON.stringify({ id: create.id, tag: inviteLinkClaimTag(keys.accessKey, keys.id).toString('base64url'), claimNonce: randomBytes(32).toString('base64url') }) }));
  expect(response.status).toBe(404);
  expect(s.logs.slice(1).join('')).not.toContain(k);
  const files: string[] = [];
  function walk(dir: string) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else files.push(path); } }
  walk(join(s.root,'invite-links'));
  for (const file of files) { const text = fs.readFileSync(file,'utf8'); expect(text).not.toContain(k); expect(text).not.toContain(token); }
});

it.each(['299','259201','1.5','NaN'])('validates link TTL %s before identity or network work', async ttl => {
  const s = setup(); await expect(createInviteCommand(['--share','link','--link-expires-in',ttl],s.options)).rejects.toThrow('INVALID_INVITE_LINK_OPTION');
  expect(s.sent).toHaveLength(0); expect(fs.existsSync(join(s.root,'identities'))).toBe(false);
});

it('strictly rejects malformed links and mismatched allowlists before networking', async () => {
  const s = setup(), k = randomBytes(32).toString('base64url');
  await expect(claimInviteLink('https://sealbridge.app/j#v=1&k=' + k + '&extra=x', { fetch: s.options.fetch })).rejects.toThrow('INVALID_INVITE_LINK');
  await expect(claimInviteLink('sealbridge://join#v=1&k=' + k, { fetch: s.options.fetch, relayPolicy: { allowedRelayUrls: ['https://elsewhere.example'] } })).rejects.toThrow('INVITE_LINK_RELAY_NOT_ALLOWED');
  expect(s.sent).toHaveLength(0);
});

it.each(['positional', 'paste', 'stdin'])('accepts deep links via %s with matching SAS', async mode => {
  const s = setup(); await createInviteCommand(createArgs(s.key), s.options);
  const link = s.logs[0].replace('https://sealbridge.app/j', 'sealbridge://join');
  const input = new PassThrough() as PassThrough & { isTTY?: boolean }; input.isTTY = mode === 'paste';
  if (mode === 'stdin') input.end(link + '\n');
  const args = mode === 'positional' ? [link] : ['--' + mode];
  await acceptCommand('accept', args, { ...s.options.identityOptions, fetch: s.options.fetch, input, readPaste: async () => link, output: new PassThrough() });
  expect(JSON.parse(s.logs[1])).toMatchObject({ verificationNumber: JSON.parse(s.errors[0]).verificationNumber, relayContacted: true });
});

it.each(['https://sealbridge.app/j', 'sealbridge://join'])('refuses %s through --stdin --no-network without contacting relay', async prefix => {
  const s = setup(), input = new PassThrough(); input.end(prefix + '#v=1&k=' + randomBytes(32).toString('base64url'));
  await expect(acceptCommand('accept', ['--stdin', '--no-network'], { ...s.options.identityOptions, fetch: s.options.fetch, input })).rejects.toThrow('INVITE_LINK_NETWORK_REQUIRED');
  expect(s.sent).toHaveLength(0); expect(fs.existsSync(join(s.root, 'identities'))).toBe(false);
});

it('recovers an interrupted claim reply with the same nonce, without retrying terminal refusals', async () => {
  const s = setup(); await createInviteCommand(createArgs(s.key), s.options);
  const link = s.logs[0], nonces: string[] = [];
  const interrupted = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith('/claim')) nonces.push((await request.clone().json()).claimNonce);
    const response = await s.handler(request);
    if (nonces.length === 1 && request.method === 'POST') throw new Error('connection interrupted');
    return response;
  }) as typeof fetch;
  expect(parseAndVerifyInviteToken(await claimInviteLink(link, { fetch: interrupted })).ownerDid).toBe(s.owner.did);
  expect(nonces).toHaveLength(2); expect(nonces[0]).toBe(nonces[1]);
  const refused = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => s.handler(new Request(input, init))) as typeof fetch;
  await expect(claimInviteLink(link, { fetch: refused })).rejects.toThrow('INVITE_LINK_UNAVAILABLE');
  expect(refused).toHaveBeenCalledTimes(2); // Capability read, then one claim.
});

it('uses configured relay defaults when creating token and link invitations', async () => {
  const s = setup(); fs.writeFileSync(join(s.root, 'config.json'), JSON.stringify({ version: 1, relays: ['https://configured.example'] }), { mode: 0o600 });
  await createInviteCommand(['--key', s.key], s.options);
  expect(parseAndVerifyInviteToken(s.logs[0]).relayUrl).toBe('https://configured.example');
  await createInviteCommand(['--key', s.key, '--share', 'link', '--qr', 'none'], s.options);
  expect(parseInviteLink(s.logs[1]).relayOrigin).toBe('https://configured.example');
  expect(s.sent.every(r => new URL(r.url).origin === 'https://configured.example')).toBe(true);
});

it('rejects modified ciphertext before identity creation or import', async () => {
  const s = setup(); await createInviteCommand(createArgs(s.key), s.options);
  const corrupt = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), response = await s.handler(request);
    if (request.method !== 'POST') return response;
    const body = await response.json(); body.ciphertext = (body.ciphertext[0] === 'A' ? 'B' : 'A') + body.ciphertext.slice(1);
    return Response.json(body);
  };
  await expect(acceptCommand('accept', [s.logs[0]], { ...s.options.identityOptions, fetch: corrupt })).rejects.toThrow('INVITE_LINK_DECRYPTION_FAILED');
  expect(fs.existsSync(join(s.root, 'identities'))).toBe(false);
});

it('does not create identities when listing absent link records, and never overwrites outputs', async () => {
  const s = setup();
  await inviteLinksCommand(['list'], s.options);
  expect(JSON.parse(s.logs[0])).toEqual({ links: [] }); expect(fs.existsSync(join(s.root, 'identities'))).toBe(false);
  const path = join(s.root, 'existing.txt'); fs.writeFileSync(path, 'keep', { mode: 0o600 });
  await expect(createInviteCommand([...createArgs(s.key), '--output', 'file:' + path], s.options)).rejects.toThrow('INVITE_OUTPUT_UNAVAILABLE');
  expect(fs.readFileSync(path, 'utf8')).toBe('keep'); expect(s.logs).toHaveLength(1);
});

it('rejects an authenticated inner token for a different relay and a locally expired response', async () => {
  const s = setup(); await createInviteCommand(['--key', s.key, '--relay', 'https://different.example'], s.options);
  const token = s.logs[0], k = randomBytes(32).toString('base64url'), link = 'sealbridge://join#v=1&k=' + k;
  const encrypted = packInviteLinkCiphertext(encryptInviteLink(token, k, {
    relayOrigin: 'https://relay.sealbridge.dev', expiresAt: new Date(Date.now() + 300000).toISOString(),
  }));
  const response = (body: unknown) => (async (_input: RequestInfo | URL, init?: RequestInit) => Response.json(init?.method === 'POST' ? body : { inviteLinks: 1 })) as typeof fetch;
  await expect(acceptCommand('accept', [link], { ...s.options.identityOptions, fetch: response(encrypted) })).rejects.toThrow('INVITE_LINK_RELAY_MISMATCH');
  const now = Date.now() - 360000;
  const expired = packInviteLinkCiphertext(encryptInviteLink(token, k, {
    relayOrigin: 'https://relay.sealbridge.dev', expiresAt: new Date(now + 300000).toISOString(), now,
  }));
  await expect(acceptCommand('accept', [link], { ...s.options.identityOptions, fetch: response(expired) })).rejects.toThrow('INVITE_LINK_DECRYPTION_FAILED');
  expect(fs.existsSync(join(s.root, 'identities'))).toBe(false);
});

it('does not fall back when a relay advertises links but refuses create', async () => {
  const s = setup();
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({}, { status: 404 }) : Response.json({ inviteLinks: 1 })) as typeof fetch;
  await expect(createInviteCommand(createArgs(s.key), { ...s.options, fetch: fetcher })).rejects.toThrow('INVITE_LINK_UNSUPPORTED_RELAY');
  expect(s.logs).toEqual([]); expect(s.errors).toEqual([]); expect(fetcher).toHaveBeenCalledTimes(2);
  await inviteLinksCommand(['list', '--key', s.key], s.options);
  expect(JSON.parse(s.logs[0]).links).toEqual([{ linkRef: expect.any(String), relay: 'https://relay.example', error: 'INVITE_LINK_UNAVAILABLE' }]);
});
