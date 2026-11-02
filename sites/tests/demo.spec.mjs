import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const site = 'http://127.0.0.1:4173';
const assets = [
  ['sealbridge-demo.webm', 'video/webm'],
  ['sealbridge-demo.mp4', 'video/mp4'],
  ['sealbridge-demo-still.png', 'image/png'],
];

for (const lang of ['en', 'ja']) {
  test(`${lang} landing demo plays with local sources, controls and an accessible transcript`, async ({ page }) => {
    const errors = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.cspViolations = [];
      document.addEventListener('securitypolicyviolation', event => window.cspViolations.push(event.violatedDirective));
    });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const response = await page.goto(`${site}/${lang}/`);
    expect(response.headers()['content-security-policy']).toContain("default-src 'self'");
    const video = page.locator('#demo-video');
    for (const attribute of ['autoplay', 'muted', 'loop', 'playsinline', 'controls']) {
      await expect(video).toHaveAttribute(attribute, '');
    }
    for (const [attribute, value] of Object.entries({ poster: '/media/sealbridge-demo-still.png',
      width: '1920', height: '1080', preload: 'metadata' })) await expect(video).toHaveAttribute(attribute, value);
    await expect(video).toHaveAccessibleName(lang === 'en' ? 'Watch a code review in 30 seconds' : '30秒で見るコードレビュー');
    await expect(video).toHaveAccessibleDescription(/Bob/);
    expect(await video.locator('source').evaluateAll(sources => sources.map(source => [source.getAttribute('src'), source.type])))
      .toEqual(assets.slice(0, 2).map(([file, type]) => [`/media/${file}`, type]));
    await expect(video.locator('a')).toHaveAttribute('href', '/media/sealbridge-demo.mp4');
    await expect(page.locator('.demo-transcript ol')).toHaveAttribute('lang', 'en');
    await page.locator('.demo-transcript summary').click();
    await expect(page.locator('.demo-transcript li')).toHaveCount(7);
    await expect(page.locator('.demo-transcript')).toContainText('Every step in a verifiable audit log');
    // Check actual decoding/playback, rather than just the HTML attributes.
    await expect.poll(() => video.evaluate(element => !element.paused && element.currentTime > 0)).toBe(true);
    await expect.poll(() => video.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(2);
    expect(await video.evaluate(element => ({ muted: element.muted, error: element.error }))).toEqual({ muted: true, error: null });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const size = await video.boundingBox();
      expect(size.width / size.height).toBeCloseTo(16 / 9, 2);
      expect(await video.evaluate(element => getComputedStyle(element).aspectRatio)).toBe('16 / 9');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => video.evaluate(element => element.paused && !element.autoplay && element.controls)).toBe(true);
    expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`${lang} landing demo respects reduced motion on initial load and permits manual playback`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${site}/${lang}/`);
    const video = page.locator('#demo-video');
    await expect.poll(() => video.evaluate(element => element.paused && !element.autoplay && element.controls)).toBe(true);
    await video.evaluate(element => element.play());
    await expect.poll(() => video.evaluate(element => !element.paused && element.currentTime > 0)).toBe(true);
    await video.evaluate(element => element.pause());
  });
}

test('demo assets preserve docs/media bytes in the build and preview serves MIME types and byte ranges', async ({ request }) => {
  for (const [file, type] of assets) {
    const [original, built] = await Promise.all([
      readFile(new URL(`../../docs/media/${file}`, import.meta.url)),
      readFile(new URL(`../dist/site/media/${file}`, import.meta.url)),
    ]);
    // Compare whole assets on disk without costly per-byte assertion traversal or HTTP downloads.
    const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
    expect(built.length, `${file} build size`).toBe(original.length);
    expect(sha256(built), `${file} build SHA-256`).toBe(sha256(original));
    const head = await request.head(`${site}/media/${file}`);
    expect(head.status()).toBe(200);
    expect(head.headers()['content-type']).toBe(type);
    expect(head.headers()['accept-ranges']).toBe('bytes');
    expect(head.headers()['content-length']).toBe(String(original.length));
    expect(await head.body()).toHaveLength(0);
    for (const [range, start, end] of [['bytes=0-127', 0, 127], ['bytes=-64', original.length - 64, original.length - 1],
      [`bytes=${original.length - 32}-`, original.length - 32, original.length - 1],
      [`bytes=${original.length - 16}-${original.length + 128}`, original.length - 16, original.length - 1]]) {
      const partial = await request.get(`${site}/media/${file}`, { headers: { Range: range } });
      expect(partial.status()).toBe(206);
      expect(partial.headers()['content-type']).toBe(type);
      expect(partial.headers()['accept-ranges']).toBe('bytes');
      expect(partial.headers()['content-length']).toBe(String(end - start + 1));
      expect(partial.headers()['content-range']).toBe(`bytes ${start}-${end}/${original.length}`);
      expect(await partial.body()).toEqual(original.subarray(start, end + 1));
    }
    for (const range of [`bytes=${original.length}-`, 'bytes=-0']) {
      const invalid = await request.get(`${site}/media/${file}`, { headers: { Range: range } });
      expect(invalid.status()).toBe(416);
      expect(invalid.headers()['accept-ranges']).toBe('bytes');
      expect(invalid.headers()['content-range']).toBe(`bytes */${original.length}`);
      expect(invalid.headers()['content-length']).toBe('0');
      expect(await invalid.body()).toHaveLength(0);
    }
    for (const range of ['bytes=20-10', 'bytes=0-1,4-5', 'bytes=invalid']) {
      const fallback = await request.head(`${site}/media/${file}`, { headers: { Range: range } });
      expect(fallback.status()).toBe(200);
      expect(fallback.headers()['accept-ranges']).toBe('bytes');
      expect(fallback.headers()['content-length']).toBe(String(original.length));
      expect(fallback.headers()['content-range']).toBeUndefined();
      expect(await fallback.body()).toHaveLength(0);
    }
  }
});
