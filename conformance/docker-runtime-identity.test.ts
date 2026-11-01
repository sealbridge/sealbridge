// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../scripts/docker-runtime-identity.mjs', import.meta.url));
const entrypoint = fileURLToPath(new URL('../docker-entrypoint.sh', import.meta.url));
const directories: string[] = [];
const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'sealbridge-identity-'));
  directories.push(directory);
  return directory;
};
const run = (keyPath: string) => spawnSync(process.execPath, [helper, keyPath], {
  encoding: 'utf8', timeout: 15000,
});
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('declares persistent storage and non-root runtime startup in the image', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  expect(dockerfile).not.toMatch(/\bkeygen\b/);
  expect(dockerfile).toContain('VOLUME ["/data"]');
  expect(dockerfile).toContain('USER node');
  expect(dockerfile).toContain('chown node:node /data');
  expect(dockerfile).toContain('ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]');
});

describe.skipIf(process.platform === 'win32')('Docker runtime identity', () => {
  it('creates a private identity on first startup', () => {
    const keyPath = join(temporaryDirectory(), 'owner.private.json');
    const result = run(keyPath);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it('reuses the same identity on subsequent startups', () => {
    const keyPath = join(temporaryDirectory(), 'owner.private.json');
    expect(run(keyPath).status).toBe(0);
    const original = digest(keyPath);
    const modified = statSync(keyPath).mtimeMs;
    expect(run(keyPath).status).toBe(0);
    expect(digest(keyPath) === original).toBe(true);
    expect(statSync(keyPath).mtimeMs).toBe(modified);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it('uses an existing readable key in a read-only directory', () => {
    const directory = temporaryDirectory();
    const keyPath = join(directory, 'owner.private.json');
    expect(run(keyPath).status).toBe(0);
    const original = digest(keyPath);
    chmodSync(keyPath, 0o400);
    chmodSync(directory, 0o500);
    try {
      expect(run(keyPath).status).toBe(0);
      expect(digest(keyPath) === original).toBe(true);
      expect(statSync(keyPath).mode & 0o777).toBe(0o400);
    } finally {
      chmodSync(directory, 0o700);
    }
  });

  it('reports mount and permission guidance when the key directory is not writable', () => {
    const directory = temporaryDirectory();
    chmodSync(directory, 0o755);
    const data = join(directory, 'data');
    mkdirSync(data, { mode: 0o555 });
    const keyPath = join(data, 'owner.private.json');
    try {
      const result = spawnSync(process.execPath, [helper, keyPath], {
        encoding: 'utf8', timeout: 15000,
        ...(process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {}),
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Mount a persistent volume at /data writable by the container user');
      expect(result.stderr).toContain('SEALBRIDGE_KEY_PATH');
      expect(existsSync(keyPath)).toBe(false);
    } finally {
      chmodSync(data, 0o700);
    }
  });

  it('requires an existing directory for a new runtime identity', () => {
    const data = join(temporaryDirectory(), 'missing');
    const result = run(join(data, 'owner.private.json'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Mount a persistent volume');
    expect(existsSync(data)).toBe(false);
  });

  it('starts MCP with the configured runtime identity and clean stdout', () => {
    const keyPath = join(temporaryDirectory(), 'owner identity.private.json');
    const result = spawnSync('sh', [entrypoint, 'mcp-server'], {
      env: { ...process.env, SEALBRIDGE_KEY_PATH: keyPath, SEALBRIDGE_RELAY_URL: 'https://relay.example' },
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n',
      encoding: 'utf8', timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    // Keep the original tmpdir spelling: macOS commonly exposes /var via /private/var.
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    const response = JSON.parse(result.stdout);
    expect(response.id).toBe(1);
    expect(response.result.serverInfo.name).toBe('sealbridge-mcp-server');
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it('preserves explicit container commands without creating an identity', () => {
    const keyPath = join(temporaryDirectory(), 'owner.private.json');
    const result = spawnSync('sh', [entrypoint, process.execPath, '-e', 'process.stdout.write("ready")'], {
      env: { ...process.env, SEALBRIDGE_KEY_PATH: keyPath }, encoding: 'utf8', timeout: 15000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('ready');
    expect(existsSync(keyPath)).toBe(false);
  });
});
