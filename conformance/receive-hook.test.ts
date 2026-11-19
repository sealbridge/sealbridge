// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createReceiveHook } from '../cli/src/receive-hook.js';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
});

it('passes remote content only through stdin and detaches notification completion', () => {
  const stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  const child = Object.assign(new EventEmitter(), { stdin, unref: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const record = JSON.stringify({ input: '$(whoami) & echo secret; 日本語\n' }) + '\n';
  createReceiveHook('node notify.cjs')(record);
  expect(spawn).toHaveBeenCalledExactlyOnceWith('node notify.cjs', {
    shell: true,
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  expect(stdin.end).toHaveBeenCalledExactlyOnceWith(record);
  expect(child.unref).toHaveBeenCalledOnce();
});

it.each(['spawn', 'stdin', 'exit', 'throw'])(
  'contains %s failures without logging payloads',
  (mode) => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
    const child = Object.assign(new EventEmitter(), { stdin, unref: vi.fn() });
    vi.mocked(spawn).mockImplementation(() => {
      if (mode === 'throw') throw new Error('private command');
      return child as unknown as ReturnType<typeof spawn>;
    });
    expect(() => createReceiveHook('notify')('private record')).not.toThrow();
    if (mode === 'spawn') child.emit('error', new Error('private command'));
    if (mode === 'stdin') stdin.emit('error', new Error('EPIPE'));
    if (mode === 'exit') child.emit('exit', 1);
    expect(warn).toHaveBeenCalledExactlyOnceWith('ACP_ON_RECEIVE_FAILED');
  },
);

it('rejects an empty command', () => {
  expect(() => createReceiveHook('  ')).toThrow('Missing --on-receive');
});
