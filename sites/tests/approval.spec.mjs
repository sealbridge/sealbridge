import { headerRules, headersFor } from '../header-rules.mjs';
import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '../../packages/core/dist/index.js';
import { createRelayFetchHandler } from '../../packages/relay/dist/index.js';
import { PasskeyApprovalBroker } from '../../packages/runtime/dist/passkey-approval.js';

test('private browser approval registers and authenticates a passkey without any account login', async ({
  page,
  context,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'sealbridge-browser-approval-'));
  const handler = createRelayFetchHandler();
  const fetcher = async (url, init) => handler(new Request(url, init));
  const broker = new PasskeyApprovalBroker(generateKeyPair(), {
    env: { SEALBRIDGE_DATA_DIR: directory },
    relay: 'https://relay.example',
    fetch: fetcher,
  });
  const rules = headerRules(await readFile(new URL('../_headers', import.meta.url), 'utf8'));
  broker.startWorkerEnrollment();
  const unexpected = [],
    requests = [];
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    requests.push(request.url());
    if (url.origin === 'https://relay.example') {
      const response = await handler(
        new Request(request.url(), {
          method: request.method(),
          headers: request.headers(),
          ...(request.method() === 'POST' ? { body: request.postData() } : {}),
        }),
      );
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      });
    } else if (
      url.origin === 'https://sealbridge.app' &&
      ['/approve', '/approve.js', '/style.css'].includes(url.pathname)
    ) {
      const file = url.pathname === '/approve' ? 'approve/index.html' : url.pathname.slice(1);
      await route.fulfill({
        headers: headersFor(rules, url.pathname),
        body: await readFile(new URL('../dist/invite/' + file, import.meta.url)),
        contentType: file.endsWith('.js')
          ? 'text/javascript'
          : file.endsWith('.css')
            ? 'text/css'
            : 'text/html',
      });
    } else {
      unexpected.push(request.url());
      await route.abort();
    }
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  try {
    const registration = await broker.requestRegistration();
    await page.goto(registration.link);
    expect(requests.some((url) => url.includes('relay.example'))).toBe(false);
    expect(new URL(page.url()).hash).toBe('');
    await page.getByRole('button', { name: 'Open private request' }).click();
    await expect(page.locator('#enrollment')).toContainText('No passkey is registered yet');
    await expect(page.locator('#reason')).toContainText('register first');
    await page.getByRole('button', { name: 'Register passkey', exact: true }).click();
    await expect(page.locator('#status')).toContainText('Decision sent encrypted');
    const saved = JSON.parse(
      await readFile(join(broker.directory, registration.id + '.json'), 'utf8'),
    ).payload;
    const results = await (
      await fetcher('https://relay.example/v1/approvals/' + registration.id + '/results', {
        headers: { authorization: 'Bearer ' + saved.access },
      })
    ).json();
    expect(await broker.acceptResult(registration.id, results.results[0])).toBe('registered');
    const approval = await broker.requestApproval({
      taskId: 'browser-task',
      gate: 'contract_acceptance',
      target: { write: 'reviewed.txt' },
      deadline: new Date(Date.now() + 60000).toISOString(),
      details: {
        approvalReasons: ['write'],
        input: { path: 'reviewed.txt' },
        manifest: {
          task: { title: 'Update reviewed file' },
          requester: { ownerDid: 'peer-owner' },
        },
      },
    });
    await page.goto(approval.link);
    await page.getByRole('button', { name: 'Open private request' }).click();
    await expect(page.locator('#peer')).toContainText('peer-owner');
    await expect(page.locator('#content')).toContainText('reviewed.txt');
    expect(await broker.poll(approval.id)).toBeUndefined();
    await page.getByRole('button', { name: 'Approve with passkey' }).click();
    await expect(page.locator('#status')).toContainText('Decision sent encrypted');
    expect(await broker.poll(approval.id)).toBe('approved');
    expect(unexpected).toEqual([]);
  } finally {
    broker.stopWorkerEnrollment();
    await rm(directory, { recursive: true, force: true });
  }
});
