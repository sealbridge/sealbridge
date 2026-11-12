import { afterAll } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Application config reads, including subprocess reads, use a temporary root.
const root = mkdtempSync(join(realpathSync(tmpdir()), 'sealbridge-test-data-'));
const previous = process.env.SEALBRIDGE_DATA_DIR;
const previousHome = process.env.HOME, previousProfile = process.env.USERPROFILE;
process.env.HOME = root; process.env.USERPROFILE = root;
process.env.SEALBRIDGE_DATA_DIR = join(root, 'data');
afterAll(() => {
  if (previous === undefined) delete process.env.SEALBRIDGE_DATA_DIR;
  else process.env.SEALBRIDGE_DATA_DIR = previous;
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
  rmSync(root, { recursive: true, force: true });
});
