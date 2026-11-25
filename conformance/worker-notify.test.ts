import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { createEventNotifier } from '../cli/src/notify.js';
const event = {
  event: 'task_received' as const,
  timestamp: '2026-11-20T00:00:00Z',
  workerDid: 'did:key:worker',
  taskId: 'task-1',
};
it('defaults to off and does not contact a webhook', async () => {
  const fetcher = vi.fn();
  const notifier = createEventNotifier(undefined, { fetch: fetcher });
  notifier.emit(event);
  await notifier.drain();
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(['task_received', 'approval_needed', 'completed', 'new_connection'] as const)(
  'posts %s JSON without an inbox',
  async (name) => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 })) as any;
    const notifier = createEventNotifier('https://notify.example/event', { fetch: fetcher });
    notifier.emit({ ...event, event: name });
    await notifier.drain();
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe('https://notify.example/event');
    expect(request.redirect).toBe('error');
    expect(JSON.parse(request.body)).toEqual({ ...event, event: name });
  },
);
it('contains target failures and never treats responses as approval', async () => {
  const onError = vi.fn();
  const notifier = createEventNotifier('https://notify.example/event', {
    fetch: vi.fn(async () => new Response(null, { status: 500 })) as any,
    onError,
  });
  notifier.emit(event);
  await expect(notifier.drain()).resolves.toBeUndefined();
  expect(onError).toHaveBeenCalledWith('NOTIFY_FAILED');
});
it.each([
  'ftp://example.com',
  'https://user:password@example.com',
  'https://example.com/#secret',
  '',
])('rejects invalid target %s', (target) => {
  expect(() => createEventNotifier(target)).toThrow('INVALID_NOTIFY_TARGET');
});

it('delivers JSON to command stdin without an inbox or exposed stdout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sealbridge-notify-'));
  try {
    const script = join(root, 'notify.cjs'),
      output = join(root, 'event.json');
    writeFileSync(
      script,
      "let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>require('node:fs').writeFileSync(process.argv[2],JSON.stringify({input,args:process.argv.slice(2)})));",
    );
    const onError = vi.fn();
    const notifier = createEventNotifier(`"${process.execPath}" "${script}" "${output}"`, {
      onError,
    });
    notifier.emit(event);
    await notifier.drain();
    expect(onError).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({
      input: JSON.stringify(event) + '\n',
      args: [output],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
