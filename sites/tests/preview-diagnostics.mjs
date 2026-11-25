import { get } from 'node:http';
import { readFile } from 'node:fs/promises';

export const previewPorts = { site: 4173, invite: 4174 };
const errors = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EACCES',
  'EADDRINUSE',
]);
const signals = new Set(['SIGTERM', 'SIGINT', 'SIGKILL', 'SIGABRT']);
const integer = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max ? value : null;

// This is the only serialization boundary. Never spread input objects into logs.
export function sanitizeDiagnostic(input) {
  return {
    event: 'preview-failure-diagnostic',
    timestamp: new Date().toISOString(),
    server: {
      pid: integer(input.server?.pid, 1, 2147483647),
      liveness: ['alive', 'exited'].includes(input.server?.liveness)
        ? input.server.liveness
        : 'unknown',
      exitCode: integer(input.server?.exitCode, 0, 255),
      signal: signals.has(input.server?.signal) ? input.server.signal : null,
    },
    origins: ['site', 'invite'].map((target) => {
      const observation = input.origins?.find((item) => item.target === target);
      return {
        target,
        status: integer(observation?.status, 100, 599),
        error: errors.has(observation?.error)
          ? observation.error
          : observation?.error
            ? 'OTHER'
            : null,
        identity: ['owned-preview', 'unverified', 'unavailable'].includes(observation?.identity)
          ? observation.identity
          : 'unavailable',
      };
    }),
  };
}

export async function readServerState(file) {
  try {
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    let state = {};
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.event === 'spawn') state = { pid: event.pid };
        if (event.event === 'exit')
          state = { ...state, exitCode: event.code, signal: event.signal, liveness: 'exited' };
      } catch {
        /* An interrupted final append is not evidence of exit. */
      }
    }
    if (state.liveness !== 'exited' && integer(state.pid, 1, 2147483647)) {
      try {
        process.kill(state.pid, 0);
        state.liveness = 'alive';
      } catch (error) {
        state.liveness = error.code === 'ESRCH' ? 'exited' : 'unknown';
      }
    }
    return state;
  } catch {
    return {};
  }
}

export function observeOrigin(target, port, nonce) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ target, ...result });
    };
    // A separate diagnostic deadline bounds one observation, never a test/navigation.
    const deadline = setTimeout(() => {
      finish({ error: 'ETIMEDOUT', identity: 'unavailable' });
      request.destroy();
    }, 1000);
    const request = get(
      { hostname: '127.0.0.1', port, path: target === 'site' ? '/en/' : '/i', agent: false },
      (response) => {
        finish({
          status: response.statusCode,
          identity:
            nonce && response.headers['x-sealbridge-test-preview'] === nonce
              ? 'owned-preview'
              : 'unverified',
        });
        response.destroy();
      },
    );
    request.on('error', (error) =>
      finish({ error: error.code || 'OTHER', identity: 'unavailable' }),
    );
  });
}
