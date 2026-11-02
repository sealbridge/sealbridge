// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import type { InMemoryRelayOptions } from '../packages/relay/src/fetch.js';

const captured = vi.hoisted(() => ({ options: undefined as InMemoryRelayOptions | undefined,
  close: vi.fn(async () => {}), stop: undefined as (() => void) | undefined }));
vi.mock('../packages/relay/dist/index.js', async original => ({
  ...await original<typeof import('../packages/relay/src/index.js')>(),
  startLocalRelay: vi.fn(async (options: { relayOptions: InMemoryRelayOptions }) => {
    captured.options = options.relayOptions;
    return { url: 'http://127.0.0.1:8787', close: captured.close };
  }),
}));
import { networkCommand } from '../cli/src/network.js';

afterEach(() => { vi.restoreAllMocks(); captured.close.mockClear(); captured.stop = undefined; });

it('forwards local relay retention and cap flags without a listener', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process, 'once').mockImplementation(((event: string, listener: () => void) => {
    if (event === 'SIGINT') captured.stop = listener;
    if (event === 'SIGTERM') captured.stop?.();
    return process;
  }) as typeof process.once);
  await networkCommand('relay', ['start', '--envelope-ttl-ms', '172800000', '--max-queue-size', '9',
    '--max-queue-bytes', '8192', '--max-envelope-bytes', '2048', '--max-envelopes-per-sender', '3']);
  expect(captured.options).toMatchObject({ envelopeTtlMs: 172_800_000, maxQueueSize: 9,
    maxQueueBytesPerRecipient: 8192, maxEnvelopeBytes: 2048, maxEnvelopesPerSender: 3 });
  expect(captured.close).toHaveBeenCalledOnce();
});

it.each(['envelope-ttl-ms', 'max-queue-size', 'max-queue-bytes', 'max-envelope-bytes', 'max-envelopes-per-sender'])(
  'rejects invalid local --%s values before starting a relay', async flag => {
    for (const value of ['0', '-1', '1.5', '9007199254740992'])
      await expect(networkCommand('relay', ['start', '--' + flag, value]))
        .rejects.toThrow('INVALID_' + flag.toUpperCase().replaceAll('-', '_'));
  });

it('documents the retention and cap defaults in local relay help', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await networkCommand('relay', ['start', '--help']);
  const text = output.mock.calls.map(call => call[0]).join('\n');
  expect(text).toContain('86400000');
  for (const flag of ['max-queue-size', 'max-queue-bytes', 'max-envelope-bytes', 'max-envelopes-per-sender'])
    expect(text).toContain('--' + flag);
});
