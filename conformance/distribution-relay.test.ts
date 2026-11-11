// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PUBLIC_RELAY } from '../packages/runtime/src/relay-selection.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// Discover tracked manifests too, so adding a server.json cannot bypass the guard.
const distributionFiles = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(path => /(^|\/)(Dockerfile(?:\.[^/]+)?|docker-entrypoint\.sh|smithery\.ya?ml|(?:server|[^/]+\.server|[^/]+-server)\.json)$/.test(path));

describe('distribution relay selection', () => {
  it.each(distributionFiles)('%s contains no divergent relay URL literal', path => {
    const text = read(path);
    // Distribution files currently contain no non-relay URLs. For JSON server
    // manifests, exclude standard registry metadata, never args/env/config.
    const content = path.endsWith('.json') ? JSON.stringify(JSON.parse(text), (key, value) =>
      ['$schema', 'repository', 'websiteUrl', 'icons'].includes(key) ? undefined : value) : text;
    const urls = content.match(/https?:\/\/[^\s"'`<>}\]\\,)]+/g) ?? [];
    for (const url of urls) expect(url, `${path}: ${url}`).toBe(DEFAULT_PUBLIC_RELAY);
  });

  it.skipIf(process.platform === 'win32')('Docker forwards only explicit relay settings, preserving arguments', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sealbridge-relay-'));
    try {
      copyFileSync(new URL('../docker-entrypoint.sh', import.meta.url), join(directory, 'entrypoint.sh'));
      mkdirSync(join(directory, 'bin'));
      const node = join(directory, 'bin', 'node');
      // Stub identity creation and capture the actual CLI argv without networking.
      writeFileSync(node, '#!/bin/sh\ncase "$1" in */docker-runtime-identity.mjs) exit 0 ;; esac\nprintf "%s\\n" "$@"\n');
      chmodSync(node, 0o700);
      for (const relay of [undefined, '', 'https://custom.example/path']) {
        const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}`, SEALBRIDGE_KEY_PATH: '/owner key.json' };
        delete env.SEALBRIDGE_RELAY_URL;
        if (relay !== undefined) Object.assign(env, { SEALBRIDGE_RELAY_URL: relay });
        for (const args of [[], ['mcp-server', '--allow-worker', 'did:example:worker']]) {
          const result = spawnSync('sh', [join(directory, 'entrypoint.sh'), ...args], { env, encoding: 'utf8' });
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(0);
          expect(result.stdout.trim().split('\n')).toEqual([
            `${directory}/cli/dist/index.js`, 'mcp-server', '--key', '/owner key.json',
            ...(relay ? ['--relay', relay] : []), ...args.slice(1),
          ]);
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps Smithery relay optional and forwards explicit overrides', () => {
    const smithery = read('smithery.yaml');
    const schema = smithery.split('  commandFunction:')[0];
    expect(schema.split('    properties:')[0]).not.toContain('relayUrl');
    expect(schema).not.toMatch(/\bdefault:/);
    const command = new Function(`return (${smithery.split('    |-\n')[1].trim()})`)() as
      (config: { keyFile: string; relayUrl?: string }) => { args: string[] };
    for (const relayUrl of [undefined, '']) {
      expect(command({ keyFile: '/owner.json', relayUrl }).args)
        .toEqual(['cli/dist/index.js', 'mcp-server', '--key', '/owner.json']);
    }
    expect(command({ keyFile: '/owner.json', relayUrl: 'https://custom.example' }).args)
      .toEqual(['cli/dist/index.js', 'mcp-server', '--key', '/owner.json', '--relay', 'https://custom.example']);
  });
});
