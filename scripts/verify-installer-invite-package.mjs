// Run against an unpacked, locally prepared npm package. No live relay traffic.
// Usage: node scripts/verify-installer-invite-package.mjs /path/to/package
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';

const root = resolve(process.argv[2]);
const load = (file) => import(pathToFileURL(join(root, 'dist', file)).href);
const core = await load('packages/core/dist/index.js');
const { acceptCommand } = await load('cli/dist/accept.js');
const { shareInvite } = await load('packages/runtime/dist/invite-links.js');
const { createRelayFetchHandler } = await load('packages/relay/dist/fetch.js');
assert.equal(JSON.parse(readFileSync(join(root, 'package.json'))).version, '0.10.1');
const owner = core.generateKeyPair();
const token = core.createInviteToken(
  {
    agentCard: core.createSignedAgentCard(
      {
        name: 'Synthetic installer preflight',
        agentDid: owner.did,
        relayEndpoint: 'https://relay.example',
        skills: [],
      },
      owner,
    ),
    expiresInSeconds: 3600,
  },
  owner,
);
const dirs = [];
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), 'installer-preflight-'));
  dirs.push(dir);
  return dir;
};
const originalLog = console.log;
const records = [];
try {
  // Real packaged CLI process, actual OS stdin pipe, no inherited terminal.
  for (const [name, input, expected] of [
    ['token', token, 0],
    ['invalid', 'synthetic-invalid-secret', 1],
    ['empty', '', 1],
    ['multiline', 'synthetic-one\nsynthetic-two', 1],
  ]) {
    const result = spawnSync(
      process.execPath,
      [join(root, 'dist/cli/dist/index.js'), 'accept', '--stdin', '--no-network'],
      {
        input: input + '\n',
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, SEALBRIDGE_DATA_DIR: directory(), SEALBRIDGE_KEY_STORE: 'file' },
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, expected);
    assert.ok(!input || !(result.stdout + result.stderr).includes(input));
    assert.ok(!(result.stdout + result.stderr).includes('Paste the complete'));
    records.push({ case: name, exit: result.status, noEchoOrPrompt: true });
  }
  // Exercise packaged short-link code with the real in-memory relay handler.
  // This is injected fetch, not an HTTP server or a public relay request.
  for (const kind of ['token', 'long-link', 'acp-uri', 'short-https', 'short-uri']) {
    const dir = directory();
    const options = { env: { SEALBRIDGE_DATA_DIR: dir, SEALBRIDGE_KEY_STORE: 'file' }, home: dir };
    const handler = createRelayFetchHandler();
    const requests = [];
    const fetcher = async (input, init) => {
      const request = new Request(input, init);
      requests.push(new URL(request.url).pathname);
      return handler(request);
    };
    let input = token;
    if (kind.startsWith('short')) {
      input = (await shareInvite(token, owner, { ...options, fetch: fetcher })).link;
      if (kind === 'short-uri')
        input = input.replace('https://sealbridge.app/j', 'sealbridge://join');
    } else if (kind === 'long-link') input = 'https://sealbridge.app/i#' + token;
    else if (kind === 'acp-uri') input = 'acp://invite?token=' + token.slice(11);
    requests.length = 0;
    const stream = new PassThrough();
    stream.end(' \t' + input + '\r\n');
    const logs = [];
    console.log = (value) => logs.push(String(value));
    await acceptCommand('accept', ['--stdin'], { ...options, fetch: fetcher, input: stream });
    console.log = originalLog;
    const output = logs.join('\n');
    assert.ok(!output.includes(token) && !output.includes(input));
    const files = readdirSync(dir, { recursive: true }).filter((file) =>
      String(file).endsWith('.json'),
    );
    const consent = files.some((file) =>
      readFileSync(join(dir, file), 'utf8').includes('ConnectionConsent'),
    );
    const short = kind.startsWith('short');
    assert.equal(requests.length > 0, short);
    assert.equal(consent, short);
    if (short) assert.ok(requests.includes('/v1/invites/claim'));
    records.push({
      case: kind,
      relayContacted: short,
      signedConnectionConsent: consent,
      noEchoOrPrompt: true,
    });
  }
} finally {
  console.log = originalLog;
  for (const dir of dirs)
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log(
  JSON.stringify(
    { version: '0.10.1', evidence: 'locally built package; not a published artifact', records },
    null,
    2,
  ),
);
