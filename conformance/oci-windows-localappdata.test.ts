// SPDX-License-Identifier: Apache-2.0
import { lstat, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, it } from 'vitest';
import { createOciWorkspace } from '../packages/sandbox/src/oci-workspace.js';

// Normal production path: do not change LocalAppData/ancestor permissions or
// substitute a temp root. Windows uses OS profile permissions without inspection.
// Hosted administrator success is not evidence for a fresh standard account.
it.runIf(process.platform === 'win32')(
  'creates and removes a real workspace under untouched LocalAppData',
  async () => {
    const w = await createOciWorkspace();
    try {
      expect(dirname(w.directory)).toBe(await realpath(process.env.LOCALAPPDATA!));
      await w.write('config.json', '{}');
      await w.write('runner.cjs', 'synthetic');
      await w.write('task.json', '{}');
      await w.seal();
    } finally {
      expect(await w.cleanup(true, Date.now() + 3000)).toBe(true);
    }
    await expect(lstat(w.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);
