import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { contactsPath } from '../cli/src/contacts.js';
import { resolveDataRoot } from '../packages/runtime/src/local-identity.js';
afterEach(() => vi.unstubAllEnvs());
it('contacts uses the shared root with SEALBRIDGE_DATA_DIR before ACP_DATA_DIR', () => {
  vi.stubEnv('SEALBRIDGE_DATA_DIR', join(process.cwd(), 'chosen'));
  vi.stubEnv('ACP_DATA_DIR', join(process.cwd(), 'old'));
  expect(contactsPath()).toBe(join(resolveDataRoot(), 'contacts.json'));
  expect(contactsPath()).toContain('chosen');
});
