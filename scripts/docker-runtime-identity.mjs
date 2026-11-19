// SPDX-License-Identifier: Apache-2.0
import { accessSync, constants, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const keyPath = process.argv[2];
try {
  if (!keyPath || !isAbsolute(keyPath)) throw new Error('An absolute key path is required');
  let exists = false;
  try {
    if (!statSync(keyPath).isFile()) throw new Error('The key path must be a file');
    exists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!exists) {
    const directory = dirname(keyPath);
    if (!statSync(directory).isDirectory()) throw new Error('The key directory must exist');
    accessSync(directory, constants.W_OK | constants.X_OK);
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL('../cli/dist/index.js', import.meta.url)), 'keygen', keyPath],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
  }
  accessSync(keyPath, constants.R_OK);
} catch {
  console.error(
    'Sealbridge runtime identity could not be loaded or created. ' +
      'Mount a persistent volume at /data writable by the container user (UID 1000), ' +
      'or set SEALBRIDGE_KEY_PATH to an absolute path in a persistent mounted directory ' +
      'or to an existing readable key file. Check the directory and file permissions.',
  );
  process.exitCode = 1;
}
