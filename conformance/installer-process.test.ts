import { describe, expect, it } from 'vitest';
import { existsSync, watch } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runProcess } from './installer-process.js';
import {
  processDetails,
  ProcessTimeline,
  shellMarker,
  withMarkerWitness,
} from './installer-process-diagnostics.js';
import { windowsTestShell } from './windows-test-shell.js';

it('serializes only diagnostic fields, never streams, environment, paths or error text', () => {
  const secret = 'PRIVATE-CANARY C:\\Users\\private-person\\secret token=123';
  const timeline = new ProcessTimeline();
  timeline.record('spawn', 42);
  timeline.record('exit', 42, 1, null);
  const result = {
    timedOut: true,
    status: 1,
    signal: null,
    error: new Error(secret),
    timeline,
    stdout: secret,
    stderr: `[installer phase] ${secret}`,
    command: secret,
    env: { HOME: secret },
  };
  const output = processDetails(result);
  expect(output).not.toContain(secret);
  expect(JSON.parse(output)).toEqual({
    timedOut: true,
    exit: 1,
    signal: null,
    spawnError: true,
    timeline: [
      { event: 'spawn', ms: expect.any(Number), pid: 42 },
      { event: 'exit', ms: expect.any(Number), pid: 42, code: 1, signal: null },
    ],
  });
});

it('cleans the independent witness when the runner rejects and never echoes unexpected contents', async () => {
  let marker = '';
  await expect(
    withMarkerWitness(async (file) => {
      marker = file;
      await writeFile(file, 'private witness content');
      throw new Error('controlled rejection');
    }),
  ).rejects.toThrow('controlled rejection');
  expect(existsSync(dirname(marker))).toBe(false);
  const result = await withMarkerWitness(async (file) => {
    marker = file;
    await writeFile(file, 'private witness content');
    return {};
  });
  expect(result.witness).toBe('unavailable');
  expect(existsSync(dirname(marker))).toBe(false);
});

it('records a deadline and forced exit without changing timeout classification', async () => {
  let marker = '';
  const result = await withMarkerWitness(async (file) => {
    marker = file;
    return runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.env, 100);
  });
  expect(existsSync(dirname(marker))).toBe(false);
  expect(result.witness).toBe('absent');
  expect(result.timedOut).toBe(true);
  expect(result.error).toBeUndefined();
  const events = result.timeline.entries.map((entry) => entry.event);
  expect(events).toContain('spawn');
  expect(events).toContain('deadline');
  expect(events).toContain('forced-termination');
  expect(events.indexOf('deadline')).toBeLessThan(events.indexOf('exit'));
  expect(events.indexOf('exit')).toBeLessThan(events.indexOf('close'));
});

describe.skipIf(process.platform !== 'win32')('Windows shell marker witness', () => {
  for (const shell of ['powershell.exe', 'pwsh']) {
    it(`${shell}: witness I/O failure does not change the probe result`, async () => {
      let marker = '';
      const result = await withMarkerWitness(async (file) => {
        marker = file;
        return runProcess(
          windowsTestShell(shell),
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `${shellMarker}\n[Console]::Out.WriteLine('unchanged success')`,
          ],
          // Writing text to a directory deterministically fails on both shells.
          { ...process.env, SEALBRIDGE_TEST_MARKER: dirname(file) },
          30000,
        );
      });
      expect(result.status).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.error).toBeUndefined();
      expect(result.stdout).toBe('unchanged success\r\n');
      expect(result.stderr).toBe('[installer phase] shell started\r\n');
      expect(result.witness).toBe('absent');
      expect(existsSync(dirname(marker))).toBe(false);
    }, 40000);
    it.each(['normal', 'pre-marker', 'post-marker'] as const)(
      `${shell}: %s and cleanup`,
      async (mode) => {
        const directory = await mkdtemp(join(tmpdir(), 'sealbridge-marker-control-'));
        const ready = join(directory, 'ready');
        const controller = new AbortController();
        // Trigger termination only after the child reaches the controlled blocking
        // point; no startup-speed assumption is needed for the post-marker case.
        const watcher = watch(directory, () => {
          if (mode !== 'normal' && existsSync(ready)) controller.abort();
        });
        let marker = '';
        try {
          const script = join(directory, 'driver.ps1');
          await writeFile(
            script,
            mode === 'normal'
              ? `${shellMarker}\n[Console]::Out.WriteLine('unchanged success')`
              : `${mode === 'post-marker' ? shellMarker : ''}\n[IO.File]::WriteAllText($env:SEALBRIDGE_TEST_READY, 'ready')\n[Threading.Thread]::Sleep(60000)`,
          );
          const result = await withMarkerWitness(async (file) => {
            marker = file;
            return runProcess(
              windowsTestShell(shell),
              [
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                script,
              ],
              { ...process.env, SEALBRIDGE_TEST_MARKER: file, SEALBRIDGE_TEST_READY: ready },
              30000,
              controller.signal,
            );
          });
          expect(existsSync(dirname(marker))).toBe(false);
          expect(result.error).toBeUndefined();
          expect(result.timedOut).toBe(false);
          expect(result.witness).toBe(mode === 'pre-marker' ? 'absent' : 'after-emission');
          expect(result.stderr).toBe(
            mode === 'pre-marker' ? '' : '[installer phase] shell started\r\n',
          );
          expect(result.stdout).toBe(mode === 'normal' ? 'unchanged success\r\n' : '');
          const events = result.timeline.entries.map((entry) => entry.event);
          expect(events).toContain('spawn');
          expect(events).toContain('exit');
          expect(events).toContain('close');
          expect(events.includes('first-stderr')).toBe(mode !== 'pre-marker');
          expect(events.includes('forced-termination')).toBe(mode !== 'normal');
          expect(result.status).toBe(mode === 'normal' ? 0 : 1);
        } finally {
          watcher.close();
          await rm(directory, { recursive: true, force: true });
        }
      },
      40000,
    );
  }
});
