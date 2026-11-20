import { createRequire, syncBuiltinESMExports } from 'node:module';
import { afterAll } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Application config reads, including subprocess reads, use a temporary root.
const root = mkdtempSync(join(realpathSync(tmpdir()), 'sealbridge-test-data-'));
const previous = process.env.SEALBRIDGE_DATA_DIR;
const previousHome = process.env.HOME,
  previousProfile = process.env.USERPROFILE;
// Direct-route conformance must not depend on the runner's egress configuration.
// Proxy conformance explicitly supplies its own local proxy environment.
const proxyVariables = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
];
const previousProxy = new Map(proxyVariables.map((name) => [name, process.env[name]]));
for (const name of proxyVariables) delete process.env[name];
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.SEALBRIDGE_DATA_DIR = join(root, 'data');
afterAll(() => {
  for (const [name, value] of previousProxy) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (previous === undefined) delete process.env.SEALBRIDGE_DATA_DIR;
  else process.env.SEALBRIDGE_DATA_DIR = previous;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousProfile;
  rmSync(root, { recursive: true, force: true });
});

// Never send a test request to the production relay or any other public service.
// In-process handlers and explicit fetch mocks remain available to every test.
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    return Promise.reject(new Error('TEST_EXTERNAL_NETWORK_BLOCKED'));
  return originalFetch(input, init);
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});

// HttpRelayClient's native pinned HTTP transport deliberately bypasses fetch.
// Guard the actual built-in DNS export too, before any public lookup is issued.
const nativeDns = createRequire(import.meta.url)(
  'node:dns/promises',
) as typeof import('node:dns/promises');
const originalLookup = nativeDns.lookup;
nativeDns.lookup = ((hostname: string, ...args: unknown[]) => {
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname))
    return Promise.reject(new Error('TEST_EXTERNAL_NETWORK_BLOCKED'));
  return (originalLookup as (...args: unknown[]) => unknown)(hostname, ...args);
}) as typeof nativeDns.lookup;
syncBuiltinESMExports();
afterAll(() => {
  nativeDns.lookup = originalLookup;
  syncBuiltinESMExports();
});
