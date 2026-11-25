import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  fullyParallel: true,
  workers: 2,
  reporter: [['list'], ['./tests/preview-diagnostic-reporter.mjs']],
  globalTeardown: './tests/preview-diagnostic-teardown.mjs',
  use: { browserName: 'chromium', locale: 'en-US' },
  // Traces and screenshots could capture invitation material; do not record them.
  webServer: {
    command: 'node tests/preview-diagnostic-server.mjs',
    url: 'http://127.0.0.1:4174/i',
    reuseExistingServer: !process.env.CI,
  },
});
