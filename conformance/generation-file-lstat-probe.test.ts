// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it, onTestFinished } from 'vitest';

const iterations = 200;
const growAndClose = String.raw`
  const fs = require('node:fs');
  const fd = fs.openSync(process.argv[1], 'r+');
  try {
    for (let i = 0; i < Number(process.argv[2]); i++) {
      const size = fs.fstatSync(fd).size + 1;
      fs.ftruncateSync(fd, size);
      fs.writeSync(1, size + '\n');
    }
  }
  finally { fs.closeSync(fd); }
`;
const growWhileOpen = String.raw`
  const fs = require('node:fs');
  const lines = require('node:readline').createInterface({ input: process.stdin });
  const acknowledgements = lines[Symbol.asyncIterator]();
  const fd = fs.openSync(process.argv[1], 'r+');
  (async () => {
    try {
      for (let i = 0; i < Number(process.argv[2]); i++) {
        const size = fs.fstatSync(fd).size + 1;
        fs.ftruncateSync(fd, size);
        fs.writeSync(1, size + '\n');
        const acknowledgement = await acknowledgements.next();
        if (acknowledgement.done || acknowledgement.value !== 'next') {
          throw new Error('Expected parent acknowledgement');
        }
      }
    } finally {
      fs.closeSync(fd);
      lines.close();
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
`;

async function observeWhileChildOpen(path: string, check: (expected: number) => void): Promise<void> {
  const child = spawn(process.execPath,
    ['--input-type=commonjs', '-e', growWhileOpen, path, String(iterations)],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let processError: Error | undefined;
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.on('error', error => { processError = error; });
  child.stdin.on('error', error => { processError = error; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const lines = createInterface({ input: child.stdout });
  const output = lines[Symbol.asyncIterator]();
  const cleanup = async () => {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    lines.close();
  };
  onTestFinished(cleanup);
  try {
    for (let iteration = 0; iteration < iterations; iteration++) {
      const line = await output.next();
      if (line.done) throw processError ?? new Error('Child stdout ended before observation: ' + stderr);
      // The child waits for our acknowledgement with its write handle open.
      check(iteration + 1);
      expect(line.value).toBe(String(iteration + 1));
      child.stdin.write('next\n');
    }
    child.stdin.end();
    const result = await exited;
    expect(processError).toBeUndefined();
    expect(result, stderr).toEqual({ code: 0, signal: null });
    expect((await output.next()).done).toBe(true);
  } finally {
    await cleanup();
  }
}

// Temporary I7 probe: use real filesystem observations across Node processes.
it.each(['child-closed', 'parent-read-handle-open', 'child-multiple-increments', 'child-handle-open'] as const)(
  'observes generation file metadata across processes (%s)', async variant => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'generation-probe-'));
    const path = join(directory, 'generation');
    const mismatches: unknown[] = [];
    let checked = 0;
    let readHandle: number | undefined;
    let fsType = 'unavailable';
    const incrementsPerChild = variant === 'child-multiple-increments' ? 3 : 1;
    try {
      fs.writeFileSync(path, '');
      try { fsType = '0x' + fs.statfsSync(directory).type.toString(16); }
      catch { /* Filesystem type reporting is optional on this platform. */ }
      const ino = fs.lstatSync(path, { bigint: true }).ino;
      function check(expected: number): void {
        // Observe both metadata calls before assertions or acknowledging the child.
        const lstat = fs.lstatSync(path, { bigint: true });
        const stat = fs.statSync(path, { bigint: true });
        checked++;
        if (lstat.size !== BigInt(expected) || stat.size !== BigInt(expected)
          || lstat.ino !== ino || stat.ino !== ino) {
          mismatches.push({ expected, ino: String(ino),
            lstat: { size: String(lstat.size), ino: String(lstat.ino) },
            stat: { size: String(stat.size), ino: String(stat.ino) } });
        }
      }

      if (variant === 'parent-read-handle-open') readHandle = fs.openSync(path, 'r');
      if (variant === 'child-handle-open') {
        await observeWhileChildOpen(path, check);
      } else for (let iteration = 0; iteration < iterations; iteration++) {
        const output = execFileSync(process.execPath,
          ['--input-type=commonjs', '-e', growAndClose, path, String(incrementsPerChild)],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        check((iteration + 1) * incrementsPerChild);
        // The batch variant reports every increment, but metadata is observed
        // only after the child has closed its handle and exited.
        expect(output.trim().split(/\r?\n/)).toEqual(Array.from(
          { length: incrementsPerChild }, (_, i) => String(iteration * incrementsPerChild + i + 1)));
      }
      expect(checked).toBe(iterations);
      expect(mismatches).toEqual([]);
    } finally {
      fs.writeSync(2, 'GENERATION_PROBE ' + JSON.stringify({ variant, platform: process.platform,
        fsType, iterations: checked, incrementsPerChild, mismatches: mismatches.length }) + '\n');
      if (readHandle !== undefined) fs.closeSync(readHandle);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000,
);
