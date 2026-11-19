// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCodexProxy } from '../packages/adapters/src/codex-config.js';
import {
  CodexCliAdapter,
  resolveCodexCliCommand,
  runCommand,
} from '../packages/adapters/src/command.js';
import { generateKeyPair } from '../packages/core/src/index.js';
import { buildTaskManifest, type AgentTaskContext } from '../packages/runtime/src/index.js';
import { japaneseErrorReason } from '../cli/src/error-messages.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'sealbridge-codex-config-test-'));
  directories.push(dir);
  return dir;
}
function options(cwd: string) {
  return {
    proxy: { url: 'http://127.0.0.1:12345', token: 'synthetic-proxy-token' },
    invocation: resolveCodexCliCommand(),
    extraArgs: [] as string[],
    request: { cwd, signal: new AbortController().signal, timeoutMs: 10000 },
    runner: runCommand,
  };
}

describe('Codex proxy configuration', () => {
  it('runs a CLI stub with the generated provider, exact overrides and isolated environment', async () => {
    const cwd = await workspace();
    const base = options(cwd);
    const runner: typeof runCommand = async (request) => {
      if (request.args[0] === '--version') return { stdout: 'codex-cli 0.163.0' };
      const config = await readFile(join(request.env.CODEX_HOME!, 'config.toml'), 'utf8');
      // Match the CLI's custom-provider path rather than reading OPENAI_BASE_URL.
      expect(config).toContain('model_provider = "sealbridge-proxy"');
      expect(config).toContain('[model_providers.sealbridge-proxy]');
      expect(request.env.SEALBRIDGE_CODEX_PROXY_TOKEN).toBe(base.proxy.token);
      const auth = await access(join(request.env.CODEX_HOME!, 'auth.json')).then(
        () => true,
        () => false,
      );
      return { stdout: JSON.stringify({ args: request.args, env: request.env, config, auth }) };
    };
    const prepared = await prepareCodexProxy({
      ...base,
      invocation: resolveCodexCliCommand({ extraArgs: ['--model', 'fixture-model'] }),
      extraArgs: ['--model', 'fixture-model'],
      runner,
    });
    const home = prepared.env.CODEX_HOME!;
    try {
      const result = await runner({
        ...base.request,
        ...prepared.invocation,
        env: prepared.env,
        input: '{}',
      });
      const seen = JSON.parse(result.stdout);
      expect(seen.auth).toBe(false);
      expect(home).not.toBe(cwd);
      expect(seen.env).toMatchObject({
        HOME: home,
        CODEX_HOME: home,
        SEALBRIDGE_CODEX_PROXY_TOKEN: base.proxy.token,
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        ALL_PROXY: 'http://127.0.0.1:9',
        NO_PROXY: '127.0.0.1,localhost',
      });
      for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'NODE_OPTIONS'])
        expect(seen.env).not.toHaveProperty(key);
      expect(seen.config).not.toContain(base.proxy.token);
      const config = seen.config as string;
      expect(config).toContain('base_url = "http://127.0.0.1:12345/v1"');
      expect(config).toContain('wire_api = "responses"');
      expect(config).toContain('supports_websockets = false');
      expect(config).toContain('requires_openai_auth = false');
      expect(config).toContain('env_key = "SEALBRIDGE_CODEX_PROXY_TOKEN"');
      expect(config).toContain('forced_login_method = "api"');
      expect(config).toContain('web_search = "disabled"');
      expect(config).toContain('check_for_update_on_startup = false');
      expect(config).toContain('[analytics]\nenabled = false');
      expect(config).toContain('[feedback]\nenabled = false');
      expect(config).toContain('[otel]\nexporter = "none"\ntrace_exporter = "none"');
      for (const feature of [
        'api_key_model_discovery',
        'apps',
        'plugins',
        'remote_plugin',
        'skill_search',
        'daemon_auto_start',
        'shell_snapshot',
        'enable_request_compression',
        'system_proxy_fallback',
        'unbounded_connection_retries',
      ])
        expect(config).toContain(feature + ' = false');
      const args = seen.args as string[];
      expect(args.slice(0, 5)).toEqual([
        'exec',
        '--strict-config',
        '--ignore-user-config',
        '--ephemeral',
        '--ignore-rules',
      ]);
      const overrides = [
        'model_provider = "sealbridge-proxy"',
        'forced_login_method = "api"',
        'cli_auth_credentials_store = "file"',
        'check_for_update_on_startup = false',
        'web_search = "disabled"',
        'model_providers.sealbridge-proxy.name = "Sealbridge proxy"',
        'model_providers.sealbridge-proxy.base_url = "http://127.0.0.1:12345/v1"',
        'model_providers.sealbridge-proxy.wire_api = "responses"',
        'model_providers.sealbridge-proxy.env_key = "SEALBRIDGE_CODEX_PROXY_TOKEN"',
        'model_providers.sealbridge-proxy.requires_openai_auth = false',
        'model_providers.sealbridge-proxy.supports_websockets = false',
        'model_providers.sealbridge-proxy.request_max_retries = 0',
        'model_providers.sealbridge-proxy.stream_max_retries = 0',
        'analytics.enabled = false',
        'feedback.enabled = false',
        'otel.exporter = "none"',
        'otel.trace_exporter = "none"',
        'features.api_key_model_discovery = false',
        'features.apps = false',
        'features.plugins = false',
        'features.remote_plugin = false',
        'features.skill_search = false',
        'features.daemon_auto_start = false',
        'features.shell_snapshot = false',
        'features.enable_request_compression = false',
        'features.system_proxy_fallback = false',
        'features.unbounded_connection_retries = false',
      ].flatMap((setting) => ['-c', setting]);
      expect(args).toEqual([
        'exec',
        '--strict-config',
        '--ignore-user-config',
        '--ephemeral',
        '--ignore-rules',
        ...overrides,
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--model',
        'fixture-model',
        '-',
      ]);
      expect(args).toContain('model_provider = "sealbridge-proxy"');
      const envKeys = [
        'LANG',
        'TZ',
        'HOME',
        'TMPDIR',
        'PATH',
        'CODEX_HOME',
        'SEALBRIDGE_CODEX_PROXY_TOKEN',
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'NO_PROXY',
      ];
      if (process.platform === 'win32')
        envKeys.push(
          'SystemRoot',
          'ComSpec',
          'PATHEXT',
          'TEMP',
          'TMP',
          'USERPROFILE',
          'APPDATA',
          'LOCALAPPDATA',
        );
      expect(Object.keys(prepared.env).sort()).toEqual(envKeys.sort());
    } finally {
      await prepared.close();
    }
    await expect(access(home)).rejects.toThrow();
  });

  it.each([
    'codex-cli 0.162.0',
    'codex-cli 0.162.99',
    'codex-cli 0.100.0',
    'codex-cli 0.163.0-alpha.1',
    'codex-cli unknown',
    'codex-cli 0.170',
    'codex-cli 0.170.0 extra',
    '',
  ])('refuses an older or unparseable CLI version: %s', async (version) => {
    const base = options(await workspace());
    let home = '';
    await expect(
      prepareCodexProxy({
        ...base,
        runner: async (request) => {
          expect(request.args).toEqual(['--version']);
          home = request.env.CODEX_HOME!;
          return { stdout: version };
        },
      }),
    ).rejects.toThrow('CODEX_PROXY_UNSUPPORTED_VERSION');
    await expect(access(home)).rejects.toThrow();
    expect(japaneseErrorReason('CODEX_PROXY_UNSUPPORTED_VERSION')).toContain('プロキシ設定');
  });

  it.each([
    ['codex-cli 0.163.0', 0],
    ['codex-cli 0.163.0+build.1', 0],
    ['codex-cli 0.166.0', 1],
    ['codex-cli 0.170.0', 1],
    ['codex-cli 0.170.0-alpha.1', 1],
    ['codex-cli 1.0.0', 1],
    ['2.3.4', 1],
  ])('accepts %s with %i warning lines', async (version, count) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prepared = await prepareCodexProxy({
      ...options(await workspace()),
      runner: async () => ({ stdout: version }),
    });
    try {
      expect(warn).toHaveBeenCalledTimes(count);
      if (count) {
        expect(warn.mock.calls[0]).toHaveLength(1);
        expect(warn.mock.calls[0][0]).toContain('newer than verified version 0.163.0');
        expect(warn.mock.calls[0][0]).not.toMatch(/[\r\n]/);
      }
    } finally {
      await prepared.close();
    }
  });

  it('refuses a failed version command even when it prints a supported version', async () => {
    await expect(
      prepareCodexProxy({
        ...options(await workspace()),
        runner: async () => ({ stdout: 'codex-cli 0.170.0', exitCode: 1 }),
      }),
    ).rejects.toThrow('CODEX_PROXY_UNSUPPORTED_VERSION');
  });

  it.each([
    ['-c', 'model_provider="openai"'],
    ['--config=model_providers.sealbridge-proxy.base_url="https://example.com"'],
    ['-cmodel_provider=openai'],
    ['--config', 'other.toml'],
    ['--profile', 'other'],
    ['-p', 'other'],
    ['--profile=other'],
    ['-pother'],
    ['--oss'],
    ['--local-provider', 'ollama'],
    ['--search'],
    ['--enable', 'apps'],
    ['--ignore-user-config'],
    ['resume'],
    ['--', 'prompt'],
  ])('refuses provider or configuration arguments: %j', async (...extraArgs) => {
    let called = false;
    await expect(
      prepareCodexProxy({
        ...options(await workspace()),
        extraArgs,
        runner: async () => {
          called = true;
          return { stdout: '' };
        },
      }),
    ).rejects.toThrow('CODEX_PROXY_UNSUPPORTED_ARGUMENT');
    expect(called).toBe(false);
  });

  it.each(['-c', '--profile', '-p', '--config', '--oss', '--local-provider'])(
    'refuses a routing option in the actual invocation: %s',
    async (flag) => {
      const base = options(await workspace());
      base.invocation.args.splice(3, 0, flag, 'other');
      await expect(prepareCodexProxy(base)).rejects.toThrow('CODEX_PROXY_UNSUPPORTED_ARGUMENT');
    },
  );

  it('omits inherited provider, profile and config environment settings from the CLI', async () => {
    const keys = [
      'OPENAI_BASE_URL',
      'OPENAI_API_BASE',
      'CODEX_HOME',
      'CODEX_PROFILE',
      'CODEX_CONFIG_FILE',
    ];
    for (const key of keys) vi.stubEnv(key, 'owner-setting');
    const prepared = await prepareCodexProxy({
      ...options(await workspace()),
      runner: async (request) => {
        for (const key of keys) expect(request.env[key]).not.toBe('owner-setting');
        return { stdout: 'codex-cli 0.163.0' };
      },
    });
    try {
      for (const key of keys) expect(prepared.env[key]).not.toBe('owner-setting');
    } finally {
      await prepared.close();
    }
  });

  it.each([
    'https://example.com',
    'http://localhost:12345',
    'http://127.0.0.1:12345/v1',
    'http://127.0.0.1:12345?route=other',
    'http://user@127.0.0.1:12345',
  ])('refuses a different proxy URL: %s', async (url) => {
    await expect(
      prepareCodexProxy({ ...options(await workspace()), proxy: { url, token: 'fixture' } }),
    ).rejects.toThrow('CODEX_PROXY_INVALID_URL');
  });

  it.each(['config', 'auth'])('refuses a changed CLI home: %s', async (kind) => {
    const base = options(await workspace());
    await expect(
      prepareCodexProxy({
        ...base,
        runner: async (request) => {
          const home = request.env.CODEX_HOME!;
          const file = join(home, kind === 'auth' ? 'auth.json' : 'config.toml');
          if (kind === 'config') expect(await readFile(file, 'utf8')).toContain('sealbridge-proxy');
          await writeFile(file, '{}');
          return { stdout: 'codex-cli 0.163.0' };
        },
      }),
    ).rejects.toThrow('CODEX_PROXY_INVALID_CONFIG');
  });
});

describe('Codex task proxy requests', () => {
  it.each(['none', 'missing', 'wrong', 'correct'])(
    'requires an authenticated request before returning a stub deliverable: %s',
    async (mode) => {
      const cwd = await workspace();
      const script = join(cwd, 'codex-stub.cjs');
      await writeFile(
        script,
        `
if (process.argv.includes('--version')) { console.log('codex-cli 0.170.0'); process.exit(0); }
(async () => {
  const mode = ${JSON.stringify(mode)};
  if (mode !== 'none') {
    const setting = process.argv.find(a => a.startsWith('model_providers.sealbridge-proxy.base_url = '));
    const base = JSON.parse(setting.slice(setting.indexOf('=') + 1));
    const headers = mode === 'missing' ? {} : { authorization: 'Bearer ' +
      (mode === 'correct' ? process.env.SEALBRIDGE_CODEX_PROXY_TOKEN : 'wrong-token') };
    const response = await fetch(base + '/responses', { method: 'POST', headers, body: '{}' });
    await response.text();
  }
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}}));
  console.log(JSON.stringify({type:'turn.completed'}));
})().catch(() => process.exit(1));
`,
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const upstream = vi.fn(
        async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
      );
      const adapter = new CodexCliAdapter({
        binaryPath: script,
        apiKey: 'synthetic-upstream-key',
        fetch: upstream,
      });
      const manifest = buildTaskManifest({
        ownerDid: generateKeyPair().did,
        workerDid: generateKeyPair().did,
        title: 'Proxy routing fixture',
        description: 'Return JSON.',
      });
      const context: AgentTaskContext = {
        manifest,
        taskId: manifest.taskId,
        workspaceDir: cwd,
        input: {},
        signal: new AbortController().signal,
        reportUsage: () => {},
        callTool: async () => null,
      };
      const run = adapter.executeTask(context);
      if (mode === 'correct') {
        await expect(run).resolves.toEqual({ ok: true });
        expect(upstream).toHaveBeenCalledTimes(1);
      } else {
        await expect(run).rejects.toThrow('ADAPTER_PROXY_NOT_USED');
        expect(upstream).not.toHaveBeenCalled();
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(japaneseErrorReason('ADAPTER_PROXY_NOT_USED')).toContain('成果物を返せません');
    },
  );
});
