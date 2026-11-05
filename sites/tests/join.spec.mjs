import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

for (const port of [4173, 4174]) test(`/j at ${port} keeps fragments opaque and makes no outbound requests`, async ({ page, context }) => {
  const fragment = 'v=1&k=SI1-FRAGMENT-NEVER-SENT%3Copaque&r=unused.example';
  const requests = [], logs = [], sockets = [];
  page.on('request', request => requests.push({ url: request.url(), headers: request.headers(), body: request.postData() }));
  page.on('console', message => logs.push(message.text()));
  page.on('pageerror', error => logs.push(error.message));
  page.on('websocket', socket => sockets.push(socket.url()));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const response = await page.goto(`http://127.0.0.1:${port}/j#${fragment}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sealbridge の招待リンクです');
  await expect(page.locator('main')).toContainText('スマホでは開けません');
  await expect(page.locator('main')).toContainText('INVITE_LINK_TOKEN_REQUIRED');
  await page.getByRole('button', { name: 'リンクをコピー', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://sealbridge.app/j#' + fragment);
  const shared = await page.evaluate(async () => {
    let result;
    Object.defineProperty(navigator, 'share', { value: async data => { result = data; }, configurable: true });
    document.querySelector('#share-link').click();
    await Promise.resolve(); return result;
  });
  expect(shared).toEqual({ url: 'https://sealbridge.app/j#' + fragment });
  expect(requests.map(r => new URL(r.url).pathname).sort()).toEqual(['/j', '/join.js', '/style.css']);
  expect(requests.every(r => new URL(r.url).origin === `http://127.0.0.1:${port}` && !r.headers.referer)).toBe(true);
  expect(JSON.stringify({ requests, logs, sockets })).not.toContain('SI1-FRAGMENT');
  expect(logs).toEqual([]); expect(sockets).toEqual([]);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, '']);
  expect(response.headers()['content-security-policy']).toContain("connect-src 'none'");
  expect(response.headers()['referrer-policy']).toBe('no-referrer');
});

test('join source never decodes or inspects invitation fields', async () => {
  const source = await readFile(new URL('../browser/join.mjs', import.meta.url), 'utf8');
  expect(source).not.toMatch(/decode|JSON\.parse|URLSearchParams|fetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|console\./);
});
