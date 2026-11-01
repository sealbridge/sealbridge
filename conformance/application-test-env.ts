import { afterAll } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Application config reads, including subprocess reads, use a temporary root.
const root = mkdtempSync(join(realpathSync(tmpdir()), 'sealbridge-test-data-'));
const previous = process.env.SEALBRIDGE_DATA_DIR;
process.env.SEALBRIDGE_DATA_DIR = join(root, 'data');
afterAll(() => {
  if (previous === undefined) delete process.env.SEALBRIDGE_DATA_DIR;
  else process.env.SEALBRIDGE_DATA_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
