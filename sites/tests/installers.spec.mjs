import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
for (const name of ['install.sh', 'install.ps1']) {
  test(`${name} is served unchanged as plain text with CSP`, async ({ request }) => {
    const response = await request.get(`http://127.0.0.1:4173/${name}`);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.headers()['content-security-policy']).toContain("default-src 'self'");
    expect(await response.text()).toBe(
      await readFile(new URL(`../${name}`, import.meta.url), 'utf8'),
    );
  });
}
