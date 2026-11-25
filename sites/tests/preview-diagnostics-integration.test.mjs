import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('@playwright/test/package.json')), 'cli.js');
const configURL = new URL('../playwright.config.mjs', import.meta.url).href;
const diagnosticsURL = new URL('./preview-diagnostics.mjs', import.meta.url).href;
const secret = 'acp-invite:SYNTHETIC_TOKEN#fragment-SECRET?key=PRIVATE_KEY';
const quote = (value) =>
  process.platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", "'\"'\"'")}'`;

test('final failure awaits slow owned origins before webServer teardown; success stays silent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'preview-runner-regression-'));
  const reservations = [];
  try {
    for (let i = 0; i < 2; i++) {
      const server = createServer();
      reservations.push(server);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
    }
    const ports = { site: reservations[0].address().port, invite: reservations[1].address().port };
    const serverFile = join(directory, 'server.mjs');
    const countsFile = join(directory, 'observations.jsonl');
    await writeFile(
      serverFile,
      `
import { createServer } from 'node:http';
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const directory = process.env.SEALBRIDGE_TEST_PREVIEW_DIAGNOSTICS;
const { nonce } = JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8'));
appendFileSync(join(directory, 'state.jsonl'), JSON.stringify({ event: 'spawn', pid: process.pid }) + '\\n');
for (const [target, port] of Object.entries(${JSON.stringify(ports)})) {
  createServer((req, res) => {
    if (req.url === '/ready') { res.end('ready'); return; }
    appendFileSync(${JSON.stringify(countsFile)}, JSON.stringify({ target }) + '\\n');
    // Controlled slow response exposes teardown racing an unawaited onTestEnd.
    setTimeout(() => {
      res.writeHead(200, { 'X-Sealbridge-Test-Preview': nonce, 'X-Secret': ${JSON.stringify(secret)} });
      res.end(${JSON.stringify(secret)});
    }, 300);
  }).listen(port, '127.0.0.1');
}
`,
    );
    const configFile = join(directory, 'playwright.config.mjs');
    await writeFile(
      configFile,
      `
import base from ${JSON.stringify(configURL)};
import { previewPorts } from ${JSON.stringify(diagnosticsURL)};
import { fileURLToPath } from 'node:url';
Object.assign(previewPorts, ${JSON.stringify(ports)});
if (!base.globalTeardown) throw new Error('Expected diagnostic teardown hook');
export default {
  ...base,
  testDir: ${JSON.stringify(directory)},
  testMatch: 'case.spec.mjs',
  outputDir: ${JSON.stringify(join(directory, 'results'))},
  workers: 1,
  reporter: base.reporter.map(([name]) => [name.startsWith('.') ? fileURLToPath(new URL(name, ${JSON.stringify(configURL)})) : name]),
  globalTeardown: fileURLToPath(new URL(base.globalTeardown, ${JSON.stringify(configURL)})),
  webServer: { ...base.webServer, command: ${JSON.stringify(quote(process.execPath) + ' ' + quote(serverFile))}, url: 'http://127.0.0.1:${ports.invite}/ready', reuseExistingServer: false },
};
`,
    );
    await writeFile(
      join(directory, 'case.spec.mjs'),
      `
import { test, expect } from ${JSON.stringify(pathToFileURL(join(dirname(require.resolve('@playwright/test/package.json')), 'index.mjs')).href)};
test('final case', () => { expect(process.env.PREVIEW_TEST_FAIL).toBe('0'); });
`,
    );
    await Promise.all(
      reservations.map((server) => new Promise((resolve) => server.close(resolve))),
    );
    for (const failing of [false, true]) {
      await writeFile(countsFile, '');
      const env = { ...process.env, CI: '1', PREVIEW_TEST_FAIL: failing ? '1' : '0' };
      delete env.DEBUG;
      const child = spawn(process.execPath, [cli, 'test', '--config', configFile], {
        env,
        windowsHide: true,
      });
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      const [code, signal] = await once(child, 'close');
      assert.equal(signal, null, output);
      assert.equal(code, failing ? 1 : 0, output);
      for (const marker of ['SYNTHETIC_TOKEN', 'fragment-SECRET', 'PRIVATE_KEY'])
        assert.ok(!output.includes(marker), marker);
      const records = output
        .split(/\r?\n/)
        .filter((line) => line.startsWith('{"event":"preview-failure-diagnostic"'))
        .map((line) => JSON.parse(line));
      assert.equal(records.length, failing ? 1 : 0, output);
      const observations = (await readFile(countsFile, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        observations.map((item) => item.target).sort(),
        failing ? ['invite', 'site'] : [],
        output,
      );
      if (failing) {
        assert.equal(records[0].server.liveness, 'alive', output);
        assert.ok(records[0].server.pid > 0, output);
        assert.deepEqual(
          records[0].origins,
          ['site', 'invite'].map((target) => ({
            target,
            status: 200,
            error: null,
            identity: 'owned-preview',
          })),
          output,
        );
      }
    }
  } finally {
    for (const server of reservations) server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
