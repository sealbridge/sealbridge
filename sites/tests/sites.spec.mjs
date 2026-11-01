import { test, expect } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInviteToken, createSignedAgentCard, parseAndVerifyInviteToken } from '../../packages/core/dist/discovery.js';
import { generateKeyPair, signPayload } from '../../packages/core/dist/crypto.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const receiver = 'http://127.0.0.1:4174/i';
const site = 'http://127.0.0.1:4173';
test('agent instructions are served unchanged as plain text and linked from install pages', async ({ request }) => {
  const source = await readFile(path.join(directory, '../connect-agent.txt'));
  const response = await request.get(site + '/connect-agent.txt');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('text/plain; charset=utf-8');
  expect(await response.body()).toEqual(source);
  const text = source.toString('utf8');
  for (const command of ['sealbridge setup', 'sealbridge accept --paste', 'acp_list_invites',
    'workerRef', 'acp_discover_workers', 'acp_delegate_task', 'workerDid', 'relayUrl']) expect(text).toContain(command);
  expect(text).not.toMatch(/<script|<form|acp-invite:/i);
  for (const route of ['/en/', '/ja/', '/en/install/', '/ja/install/', '/en/get-started/', '/install/']) {
    const page = await request.get(site + route);
    expect(await page.text()).toContain('href="/connect-agent.txt"');
  }
});

function fixture({ delegated = false, name = 'Example collaborator', ttl = 3600, description } = {}) {
  const owner = generateKeyPair(), agent = delegated ? generateKeyPair() : owner;
  const card = createSignedAgentCard({ name, description, agentDid: agent.did,
    relayEndpoint: 'https://relay.sealbridge.dev', skills: [{ id: 'json', name: 'JSON' }],
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  }, owner, delegated ? agent : undefined);
  const token = createInviteToken({ agentCard: card, expiresInSeconds: ttl }, owner);
  return { token, owner, agent };
}
function unpack(token) { return JSON.parse(Buffer.from(token.slice(11), 'base64url').toString()); }
function pack(signed) { return 'acp-invite:' + Buffer.from(JSON.stringify(signed)).toString('base64url'); }

test('valid invitation shows verified identity, local QR and supported CLI command', async ({ page, context }) => {
  const { token, owner } = fixture();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${receiver}#${token}`);
  await expect(page.locator('#status')).toContainText('Signature verified');
  await expect(page.locator('#owner')).toHaveText(owner.did);
  await expect(page.locator('#qr svg')).toBeVisible();
  const command = `sealbridge accept "https://sealbridge.app/i#${token}"`;
  await expect(page.locator('#install')).toHaveText('curl -fsSL https://sealbridge.dev/install.sh | sh');
  await expect(page.locator('[data-text=acceptText]')).toContainText('sealbridge accept --paste');
  await expect(page.locator('[data-text=nextText]')).toContainText('acp_list_invites');
  await expect(page.locator('#command')).toHaveText(command);
  await expect(page.locator('main')).not.toContainText('keygen');
  await page.locator('#copy-command').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);
  await page.locator('#copy-link').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`https://sealbridge.app/i#${token}`);
  await page.locator('#language').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.locator('#status')).toContainText('署名を検証済み');
  await expect(page.locator('[data-text=acceptTitle]')).toHaveText('02 / 招待をローカルに保存');
  await expect(page.locator('#command')).toHaveText(command);
});

test('browser verifies separate owner and agent with existing delegation', async ({ page }) => {
  const { token, owner, agent } = fixture({ delegated: true });
  expect(parseAndVerifyInviteToken(token).agentDid).toBe(agent.did);
  await page.goto(`${receiver}#${token}`);
  await expect(page.locator('#owner')).toHaveText(owner.did);
  await expect(page.locator('#agent')).toHaveText(agent.did);
  await expect(page.locator('#status')).toContainText('Signature verified');
});

for (const mutation of ['payload', 'signature', 'card', 'delegation', 'binding', 'digest', 'future', 'private-relay']) {
  test(`rejects ${mutation} tampering and matches the core verifier`, async ({ page }) => {
    const { token, owner } = fixture({ delegated: mutation === 'delegation' });
    let signed = unpack(token);
    if (mutation === 'payload') signed.payload.relayUrl = 'https://attacker.example';
    if (mutation === 'signature') signed.signature.signature = 'ed25519:' + 'A'.repeat(86);
    if (mutation === 'digest') signed.signature.payloadDigest = 'sha256:' + '0'.repeat(64);
    if (mutation === 'card') signed.payload.agentCard.payload.name = 'Forged name';
    if (mutation === 'delegation') signed.payload.agentCard.payload.agentDelegation.signature = 'ed25519:' + 'A'.repeat(86);
    if (mutation === 'binding') signed.payload.agentDid = generateKeyPair().did;
    if (mutation === 'future') signed.payload.issuedAt = new Date(Date.now() + 120000).toISOString();
    if (mutation === 'private-relay') {
      signed.payload.relayUrl = 'http://127.0.0.1:8787';
      signed.payload.agentCard.payload.relayEndpoint = signed.payload.relayUrl;
      signed.payload.agentCard = signPayload(signed.payload.agentCard.payload, owner);
    }
    if (!['payload', 'signature', 'digest'].includes(mutation)) signed = signPayload(signed.payload, owner);
    const changed = pack(signed);
    expect(() => parseAndVerifyInviteToken(changed)).toThrow();
    await page.goto(`${receiver}#${changed}`);
    await expect(page.locator('#status')).toContainText('could not be verified');
    await expect(page.locator('#verified')).toBeHidden();
  });
}

for (const expired of ['invite', 'card']) {
  test(`rejects expired ${expired} and clears prior content on fragment changes`, async ({ page }) => {
    const { token, owner } = fixture();
    await page.goto(`${receiver}#${token}`);
    await expect(page.locator('#verified')).toBeVisible();
    const signed = unpack(token), now = Date.now();
    signed.payload.issuedAt = new Date(now - 60000).toISOString();
    if (expired === 'invite') signed.payload.expiresAt = new Date(now - 1000).toISOString();
    else {
      signed.payload.agentCard.payload.expiresAt = new Date(now - 1000).toISOString();
      signed.payload.agentCard = signPayload(signed.payload.agentCard.payload, owner, new Date(now - 60000).toISOString());
    }
    const changed = pack(signPayload(signed.payload, owner));
    expect(() => parseAndVerifyInviteToken(changed)).toThrow('INVITE_EXPIRED');
    await page.evaluate((t) => { location.hash = t; }, changed);
    await expect(page.locator('#status')).toContainText('has expired');
    await expect(page.locator('#verified')).toBeHidden();
    await expect(page.locator('#qr')).toBeEmpty();
    await expect(page.locator('#command')).toBeEmpty();
  });
}

test('expires an invitation while the page remains open', async ({ page }) => {
  const { token } = fixture({ ttl: 2 });
  await page.goto(`${receiver}#${token}`);
  await expect(page.locator('#verified')).toBeVisible();
  await expect(page.locator('#status')).toContainText('has expired', { timeout: 5000 });
  await expect(page.locator('#verified')).toBeHidden();
});

test('does not transmit the fragment, log it, or persist it; only local resources load', async ({ page }) => {
  const { token } = fixture();
  const requests = [], logs = [];
  page.on('request', (r) => requests.push({ url: r.url(), headers: r.headers(), body: r.postData() }));
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(e.message));
  const response = await page.goto(`${receiver}#${token}`);
  await expect(page.locator('#status')).toContainText('Signature verified');
  await page.locator('#language').click();
  const recorded = JSON.stringify({ requests, logs });
  expect(recorded.includes(token)).toBe(false);
  expect(recorded.includes(token.slice(11))).toBe(false);
  expect(requests.every((r) => new URL(r.url).origin === new URL(receiver).origin)).toBe(true);
  expect(requests.every((r) => !r.headers.referer)).toBe(true);
  expect(requests.map((r) => new URL(r.url).pathname).sort()).toEqual(['/i', '/invite.js', '/style.css']);
  expect(logs).toEqual([]);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, '']);
  expect(response.headers()['content-security-policy']).toContain("connect-src 'none'");
  expect(response.headers()['referrer-policy']).toBe('no-referrer');
});

test('untrusted signed display text stays text and oversized QR fails honestly', async ({ page }) => {
  const name = '<img src="https://evil.example/x" onerror="alert(1)">';
  const { token } = fixture({ name, description: 'x'.repeat(5000) });
  await page.goto(`${receiver}#${token}`);
  await expect(page.locator('#name')).toHaveText(name);
  await expect(page.locator('#name img')).toHaveCount(0);
  await expect(page.locator('#qr')).toContainText('too large');
  await expect(page.locator('#command')).toBeVisible();
});

test('missing, malformed and query-only invitations never enable acceptance', async ({ page }) => {
  for (const suffix of ['', '?token=not-an-invitation', '#malformed', '#acp-invite:____', '#acp-invite:a%20b']) {
    await page.goto(receiver + suffix);
    await expect(page.locator('#verified')).toBeHidden();
    await expect(page.locator('#status')).not.toHaveText('Checking the invitation…');
  }
});

test('both deployment bundles carry the strict headers and static configuration', async () => {
  for (const target of ['site', 'invite']) {
    const config = JSON.parse(await readFile(path.join(directory, `../wrangler.${target}.jsonc`), 'utf8'));
    expect(config.assets.directory).toBe(`./dist/${target}`);
    expect(config.workers_dev).toBe(false);
    expect(config.routes).toBeUndefined();
    const headers = await readFile(path.join(directory, `../dist/${target}/_headers`), 'utf8');
    for (const directive of ["default-src 'self'", "frame-ancestors 'none'", "connect-src 'none'", 'Referrer-Policy: no-referrer']) expect(headers).toContain(directive);
    expect(headers).not.toContain('unsafe-inline');
  }
});

test('landing pages, generated source content and language switch work on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(site + '/en/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Working together');
  await page.getByRole('link', { name: '日本語', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto(site + '/en/docs/docs/sites/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Official site and private invite receiver');
  await page.locator('header').getByRole('link', { name: '日本語', exact: true }).click();
  await expect(page).toHaveURL(site + '/ja/docs/docs/sites.ja/');
  await expect(page.locator('article')).toHaveAttribute('lang', 'ja');
});

test('all local document links resolve and all scripts/styles are external local assets', async ({ request }) => {
  const root = path.join(directory, '../dist/site');
  async function files(dir) { return (await Promise.all((await readdir(dir, { withFileTypes: true })).map((e) => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]))).flat(); }
  const links = new Set();
  for (const file of (await files(root)).filter((f) => f.endsWith('.html'))) {
    const html = await readFile(file, 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*src=)|<style[\s>]|\son\w+=/i);
    for (const match of html.matchAll(/(?:href|src)="(\/[^"#]*)(?:#[^"]*)?"/g)) links.add(match[1]);
  }
  for (const link of links) expect((await request.get(site + link)).status(), link).toBe(200);
});
