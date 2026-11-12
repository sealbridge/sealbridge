import { afterAll } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Application config reads, including subprocess reads, use a temporary root.
const root = mkdtempSync(join(realpathSync(tmpdir()), 'sealbridge-test-data-'));
const previous = process.env.SEALBRIDGE_DATA_DIR;
const previousHome = process.env.HOME, previousProfile = process.env.USERPROFILE;
// Direct-route conformance must not depend on the runner's egress configuration.
// Proxy conformance explicitly supplies its own local proxy environment.
const proxyVariables = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
const previousProxy = new Map(proxyVariables.map(name => [name, process.env[name]]));
for (const name of proxyVariables) delete process.env[name];
process.env.HOME = root; process.env.USERPROFILE = root;
process.env.SEALBRIDGE_DATA_DIR = join(root, 'data');
afterAll(() => {
  for (const [name, value] of previousProxy) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  if (previous === undefined) delete process.env.SEALBRIDGE_DATA_DIR;
  else process.env.SEALBRIDGE_DATA_DIR = previous;
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
  rmSync(root, { recursive: true, force: true });
});
