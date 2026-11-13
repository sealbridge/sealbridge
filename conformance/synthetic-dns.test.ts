import { afterEach, expect, it, vi } from 'vitest';
import { lookup as nodeLookup } from 'node:dns';
import { resolveAndValidateRelayEndpoint, HttpRelayClient, relayRetryCode } from '../packages/relay/src/index.js';
import { diagnose } from '../cli/src/doctor.js';

afterEach(() => vi.unstubAllEnvs());
function dns(canary: 'synthetic' | 'real' = 'synthetic', answers = ['198.18.0.1']) {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) vi.stubEnv(key, '');
  return vi.fn(async (hostname: string) => {
    if (hostname.endsWith('.invalid') && canary === 'real') throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return (hostname.endsWith('.invalid') ? ['198.19.255.254'] : answers).map(address => ({ address, family: 4 as const }));
  });
}
it('detects a synthetic resolver once and uses hostname lookup for HTTPS and WSS', async () => {
  const lookup = dns();
  for (const scheme of ['https', 'wss', 'https']) {
    const endpoint = await resolveAndValidateRelayEndpoint(`${scheme}://relay.example`, { lookup });
    expect(endpoint).toMatchObject({ addresses: [], syntheticDns: true });
    expect(endpoint.lookup).toBe(nodeLookup);
  }
  expect(lookup.mock.calls.filter(([host]) => /^sb-.+\.invalid$/.test(host))).toHaveLength(1);
});
it('blocks benchmark DNS when the canary has NXDOMAIN and caches the negative result', async () => {
  const lookup = dns('real');
  for (let i = 0; i < 2; i++) await expect(resolveAndValidateRelayEndpoint('https://relay.example', { lookup })).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
  expect(lookup.mock.calls.filter(([host]) => host.endsWith('.invalid'))).toHaveLength(1);
});
it.each(['https://198.18.0.1', 'http://relay.example', 'ws://relay.example', 'https://relay.local', 'https://u:p@relay.example'])('keeps URL and plaintext guards: %s', async url => {
  const lookup = dns();
  await expect(resolveAndValidateRelayEndpoint(url, { lookup })).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
  expect(lookup.mock.calls.some(([host]) => host.endsWith('.invalid'))).toBe(false);
});
it.each([['8.8.8.8', '198.18.0.1'], ['198.18.0.1', '10.0.0.1']])('blocks mixed answers %j', async (...answers) => {
  await expect(resolveAndValidateRelayEndpoint('https://relay.example', { lookup: dns('synthetic', answers) })).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
});
it('fails closed on a bounded canary timeout', async () => {
  const lookup = dns();
  const resolver = (host: string) => host.endsWith('.invalid') ? new Promise<never>(() => {}) : lookup(host);
  await expect(resolveAndValidateRelayEndpoint('https://relay.example', { lookup: resolver, requestTimeoutMs: 10 })).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
});
it.each([[], ['198.18.0.1', '8.8.8.8'], ['10.0.0.1']])('fails closed on non-synthetic canary answers %j', async (...canaryAnswers) => {
  dns();
  const lookup = async (hostname: string) => (hostname.endsWith('.invalid') ? canaryAnswers : ['198.18.0.1'])
    .map(address => ({ address, family: 4 as const }));
  await expect(resolveAndValidateRelayEndpoint('https://relay.example', { lookup })).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
});
it('allows shared HTTP relay operations only after canary detection', async () => {
  const lookup = dns();
  const fetcher = vi.fn(async () => new Response('[]'));
  const client = new HttpRelayClient('https://relay.example', fetcher, { lookup });
  await client.discover();
  expect(fetcher).toHaveBeenCalledOnce();
  const blocked = new HttpRelayClient('https://relay.example', fetcher, { lookup: dns('real') });
  await expect(blocked.discover()).rejects.toThrow('SSRF_BLOCKED_RELAY_URL');
  expect(fetcher).toHaveBeenCalledOnce();
});
it('doctor preserves the SSRF cause without transport secrets', async () => {
  dns();
  const checks = await diagnose({ fetch: async () => { throw new Error('SSRF_BLOCKED_RELAY_URL'); } });
  expect(checks.find(c => c.name === 'Relay')).toMatchObject({ ok: false, message: 'Blocked (SSRF_BLOCKED_RELAY_URL)' });
  expect(checks.find(c => c.name === 'Relay')?.remediation).toContain('HTTPS_PROXY');
  expect(relayRetryCode(new Error('wrapper', { cause: new Error('SSRF_BLOCKED_RELAY_URL') }))).toBe('SSRF_BLOCKED_RELAY_URL');
});
