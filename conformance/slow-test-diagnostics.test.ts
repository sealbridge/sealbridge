// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { childFailure, SLOW_TEST_TIMEOUT } from './slow-test-diagnostics.js';

it('reports elapsed child time and both captured streams without invitation secrets', () => {
  const error = childFailure(
    { message: 'ETIMEDOUT', stdout: 'started acp-invite:secret', stderr: 'waiting for proxy' },
    performance.now() - 1250,
  );
  expect(error.message).toMatch(/after 1\d{3}ms: ETIMEDOUT/);
  expect(error.message).toContain('stdout:\nstarted [invite]');
  expect(error.message).toContain('stderr:\nwaiting for proxy');
  expect(error.message).not.toContain('acp-invite:secret');
  expect(SLOW_TEST_TIMEOUT).toBe(60_000);
});
