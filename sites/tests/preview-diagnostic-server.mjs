import { fork } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.env.SEALBRIDGE_TEST_PREVIEW_DIAGNOSTICS;
let nonce;
try {
  nonce = JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8')).nonce;
} catch {
  /* Diagnostic storage must not prevent the preview from starting. */
}
const child = fork(new URL('../preview.mjs', import.meta.url), [], {
  execArgv: nonce
    ? ['--import', new URL('./preview-diagnostic-preload.mjs', import.meta.url).href]
    : [],
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  env: { ...process.env, ...(nonce ? { SEALBRIDGE_TEST_PREVIEW_NONCE: nonce } : {}) },
});
const record = (data) => {
  try {
    appendFileSync(join(directory, 'state.jsonl'), JSON.stringify(data) + '\n');
  } catch {
    /* Observation failure must not change the server's outcome. */
  }
};
record({ event: 'spawn', pid: child.pid });
child.on('error', () => {
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  record({ event: 'exit', code, signal });
  process.exitCode = code ?? 1;
});
