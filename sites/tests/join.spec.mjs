import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

for (const port of [4173, 4174])
  test(`/j at ${port} keeps fragments opaque and makes no outbound requests`, async ({
    page,
    context,
  }) => {
    const fragment = 'v=1&k=SI1-FRAGMENT-NEVER-SENT%3Copaque&r=unused.example';
    const requests = [],
      logs = [],
      sockets = [];
    page.on('request', (request) =>
      requests.push({ url: request.url(), headers: request.headers(), body: request.postData() }),
    );
    page.on('console', (message) => logs.push(message.text()));
    page.on('pageerror', (error) => logs.push(error.message));
    page.on('websocket', (socket) => sockets.push(socket.url()));
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const response = await page.goto(`http://127.0.0.1:${port}/j#${fragment}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'An invitation to get your code reviewed by another AI.',
    );
    await expect(page.locator('h2')).toHaveText([
      '01 / Install Sealbridge',
      '02 / Accept the invitation',
      '03 / Request a code review',
      'Share safely',
    ]);
    await expect(page.locator('main')).toContainText('its model provider can read your code');
    await expect(page.locator('[data-text=acceptText]')).toContainText(
      'sends a connection request',
    );
    await expect(page.locator('[data-text=acceptText]')).toContainText('does not approve work');
    for (const [button, command] of [
      ['copy-install', 'curl -fsSL https://sealbridge.dev/install.sh | sh'],
      ['copy-windows', 'irm https://sealbridge.dev/install.ps1 | iex'],
      ['copy-accept', 'sealbridge accept --paste --alias reviewer'],
    ]) {
      await page.locator('#' + button).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);
      await expect(page.locator('#action-status')).toHaveText('Copied.');
    }
    await page.locator('#language').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await expect(page.locator('h2')).toHaveText([
      '01 / Sealbridge をインストール',
      '02 / 招待を取り込む',
      '03 / コードレビューを頼む',
      '安全に共有する',
    ]);
    await expect(page.locator('main')).toContainText('モデル提供者はコードを読めます');
    await expect(page.locator('[data-text=acceptText]')).toContainText('接続リクエストを送ります');
    await expect(page.locator('#guide')).toHaveAttribute(
      'href',
      'https://sealbridge.dev/ja/docs/README.ja/',
    );
    await expect(page.locator('#install-guide')).toHaveAttribute(
      'href',
      'https://sealbridge.dev/ja/install/',
    );
    await page.getByRole('button', { name: '招待リンクをコピー', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'https://sealbridge.app/j#' + fragment,
    );
    const shared = await page.evaluate(async () => {
      let result;
      Object.defineProperty(navigator, 'share', {
        value: async (data) => {
          result = data;
        },
        configurable: true,
      });
      document.querySelector('#share-link').click();
      await Promise.resolve();
      return result;
    });
    expect(shared).toEqual({ url: 'https://sealbridge.app/j#' + fragment });
    await page.locator('#language').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#action-status')).toBeEmpty();
    await expect(page.locator('#guide')).toHaveAttribute(
      'href',
      'https://sealbridge.dev/en/docs/README/',
    );
    expect(requests.map((r) => new URL(r.url).pathname).sort()).toEqual([
      '/j',
      '/join.js',
      '/style.css',
    ]);
    expect(
      requests.every(
        (r) => new URL(r.url).origin === `http://127.0.0.1:${port}` && !r.headers.referer,
      ),
    ).toBe(true);
    expect(JSON.stringify({ requests, logs, sockets })).not.toContain('SI1-FRAGMENT');
    expect(logs).toEqual([]);
    expect(sockets).toEqual([]);
    expect(
      await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]),
    ).toEqual([0, 0, '']);
    expect(response.headers()['content-security-policy']).toContain("connect-src 'none'");
    expect(response.headers()['referrer-policy']).toBe('no-referrer');
  });

test('join source never decodes or inspects invitation fields', async () => {
  const source = await readFile(new URL('../browser/join.mjs', import.meta.url), 'utf8');
  expect(source).not.toMatch(
    /decode|JSON\.parse|URLSearchParams|fetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|console\./,
  );
});

test('Japanese locale and narrow screens retain readable controls and local guide targets', async ({
  page,
  request,
}) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'language', { value: 'ja-JP' }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:4174/j');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.locator('h1')).toContainText('レビュー');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const language of ['ja', 'en']) {
    for (const id of ['install-guide', 'guide']) {
      const url = new URL(await page.locator('#' + id).getAttribute('href'));
      expect((await request.get('http://127.0.0.1:4173' + url.pathname)).status()).toBe(200);
    }
    for (const value of await page.locator('[data-text]').allTextContents())
      expect(value.trim()).not.toBe('');
    await page.locator('#language').click();
  }
});
