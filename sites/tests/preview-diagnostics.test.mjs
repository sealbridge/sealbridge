import { removeTestFixture } from '../../conformance/test-fixture-cleanup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  observeOrigin,
  previewPorts,
  readServerState,
  sanitizeDiagnostic,
} from './preview-diagnostics.mjs';
import Reporter from './preview-diagnostic-reporter.mjs';

const secret = 'acp-invite:SYNTHETIC_TOKEN#fragment-SECRET?key=PRIVATE_KEY';
const serialize = (input) => JSON.stringify(sanitizeDiagnostic(input));

test('exit diagnostics retain 32-bit Windows status and only platform-recognized signals', () => {
  for (const exitCode of [0, 23, 255, 0xc0000005, -1073741819, -2147483648, 4294967295]) {
    assert.equal(sanitizeDiagnostic({ server: { exitCode } }).server.exitCode, exitCode);
  }
  for (const exitCode of [-2147483649, 4294967296, 1.5, Infinity, secret]) {
    assert.equal(sanitizeDiagnostic({ server: { exitCode } }).server.exitCode, null);
  }
  for (const signal of [
    'SIGSEGV',
    'SIGBUS',
    'SIGILL',
    'SIGFPE',
    'SIGABRT',
    'SIGQUIT',
    'SIGKILL',
    'SIGTERM',
    secret,
  ]) {
    assert.equal(
      sanitizeDiagnostic({ server: { signal } }).server.signal,
      Object.hasOwn(constants.signals, signal) ? signal : null,
    );
  }
});

test('real child exit status keeps Windows NTSTATUS or the POSIX low byte', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0xc0000005)'], { windowsHide: true });
  const [exitCode, signal] = await once(child, 'close');
  assert.equal(signal, null);
  if (process.platform === 'win32') assert.equal(exitCode >>> 0, 0xc0000005);
  else assert.equal(exitCode, 5);
  assert.equal(sanitizeDiagnostic({ server: { exitCode, signal } }).server.exitCode, exitCode);
});

test('pre-log allowlist rejects secrets in every diagnostic field and extra data', () => {
  const result = serialize({
    timestamp: secret,
    url: secret,
    headers: { authorization: secret },
    body: secret,
    server: { pid: secret, liveness: secret, exitCode: secret, signal: secret, key: secret },
    origins: ['site', 'invite'].map((target) => ({
      target,
      status: secret,
      error: secret,
      identity: secret,
      body: secret,
      nonce: secret,
      url: secret,
    })),
  });
  for (const marker of [
    'acp-invite',
    'SYNTHETIC_TOKEN',
    'fragment-SECRET',
    'PRIVATE_KEY',
    'authorization',
    'body',
    'nonce',
    'url',
  ])
    assert.ok(!result.includes(marker), marker);
  const value = JSON.parse(result);
  assert.deepEqual(value.server, { pid: null, liveness: 'unknown', exitCode: null, signal: null });
  assert.equal(value.origins[0].error, 'OTHER');
  assert.match(value.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('one observation identifies only the owned nonce and never emits response data', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    res.writeHead(200, { 'X-Sealbridge-Test-Preview': secret, 'X-Secret': secret });
    res.end(secret);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const owned = await observeOrigin('site', server.address().port, secret);
    const foreign = await observeOrigin('invite', server.address().port, 'different-run');
    assert.equal(calls, 2);
    assert.equal(owned.identity, 'owned-preview');
    assert.equal(foreign.identity, 'unverified');
    assert.ok(!serialize({ origins: [owned, foreign] }).includes(secret));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('one refused connection is classified without a free-form error', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  assert.deepEqual(await observeOrigin('invite', port, secret), {
    target: 'invite',
    error: 'ECONNREFUSED',
    identity: 'unavailable',
  });
});

test('owned process exit is retained and malformed state cannot leak secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'preview-state-test-'));
  const file = join(directory, 'state.jsonl');
  try {
    await writeFile(file, JSON.stringify({ event: 'spawn', pid: process.pid }) + '\n');
    assert.equal((await readServerState(file)).liveness, 'alive');
    await writeFile(
      file,
      [
        JSON.stringify({ event: 'spawn', pid: 123 }),
        JSON.stringify({ event: 'exit', code: 23, signal: null, body: secret }),
        '{truncated',
      ].join('\n'),
    );
    assert.deepEqual(await readServerState(file), {
      pid: 123,
      exitCode: 23,
      signal: null,
      liveness: 'exited',
    });
    assert.ok(!serialize({ server: await readServerState(file) }).includes(secret));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reporter is silent on success, emits one sanitized failure record, preserves status and cleans up', async () => {
  const previous = process.stderr.write;
  let output = '';
  process.stderr.write = (chunk) => {
    output += chunk;
    return true;
  };
  try {
    const success = new Reporter();
    const directory = success.directory;
    assert.equal(await success.onEnd({ status: 'passed' }), undefined);
    assert.equal(output, '');
    await assert.rejects(access(directory));
    const failed = new Reporter();
    failed.observation = Promise.resolve(
      sanitizeDiagnostic({
        server: { pid: secret },
        origins: [{ target: 'invite', error: secret }],
      }),
    );
    assert.equal(await failed.onEnd({ status: 'failed' }), undefined);
    assert.equal(output.trim().split('\n').length, 1);
    assert.ok(!output.includes(secret));
    assert.equal(JSON.parse(output).event, 'preview-failure-diagnostic');
    await assert.rejects(access(failed.directory));
  } finally {
    process.stderr.write = previous;
  }
});

test('multiple failures trigger exactly one sanitized observation per origin', async () => {
  const originalPorts = { ...previewPorts };
  const previousWrite = process.stderr.write;
  const servers = [];
  const counts = { site: 0, invite: 0 };
  let output = '';
  let reporter;
  try {
    for (const target of ['site', 'invite']) {
      const server = createServer((req, res) => {
        counts[target]++;
        res.writeHead(200, { 'X-Sealbridge-Test-Preview': secret, 'X-Private-Key': secret });
        res.end(secret);
      });
      servers.push(server);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      previewPorts[target] = server.address().port;
    }
    reporter = new Reporter();
    reporter.nonce = secret;
    await writeFile(
      join(reporter.directory, 'state.jsonl'),
      JSON.stringify({ event: 'spawn', pid: process.pid, url: secret }),
    );
    process.stderr.write = (chunk) => {
      output += chunk;
      return true;
    };
    reporter.onTestEnd(
      { expectedStatus: 'passed', title: secret },
      { status: 'failed', error: secret },
    );
    reporter.onError({ message: secret });
    reporter.onTestEnd({ expectedStatus: 'passed' }, { status: 'timedOut' });
    assert.equal(await reporter.onEnd({ status: 'failed' }), undefined);
    assert.deepEqual(counts, { site: 1, invite: 1 });
    assert.equal(output.trim().split('\n').length, 1);
    assert.ok(!output.includes(secret));
    assert.deepEqual(
      JSON.parse(output).origins.map((origin) => origin.identity),
      ['owned-preview', 'owned-preview'],
    );
  } finally {
    process.stderr.write = previousWrite;
    Object.assign(previewPorts, originalPorts);
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    if (reporter?.directory)
      await removeTestFixture(reporter.directory, 'sealbridge-preview-diagnostics-');
  }
});
