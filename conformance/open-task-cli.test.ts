// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { networkCommand } from '../cli/src/network.js';
it.each(['--open','--open=false','--allow-any-requester=false','--access-mode','--access-mode=open','--open-max-input-tokens','--open-max-output-tokens',
  '--open-max-tool-calls','--open-max-wall-seconds','--open-allow-task-type','--open-rate-limit-per-did','--allow-any-requester'])
  ('rejects retired CLI option %s before identity or transport work', async flag => {
    await expect(networkCommand('worker', ['start', flag, 'open'])).rejects.toThrow('ACCESS_MODE_REMOVED');
  });
