// SPDX-License-Identifier: Apache-2.0
import { autoAcceptPolicy } from '@acp/core';
import { LOCAL_DISTRIBUTION, cliName } from './distribution.js';
import { confirmLocalPcExecution } from './local-pc.js';
import { setApplicationAutoAccept, setApplicationKeyStore, readApplicationConfig, setApplicationLocalPcExecution } from '@acp/runtime/application-config';
import { keyStoreSelection, selectKeyStore, otherKeyStorePresence } from '@acp/runtime/key-store';
import type { IdentityStoreOptions } from '@acp/runtime/key-store';

const USAGE = LOCAL_DISTRIBUTION
  ? 'Usage: sealbridge-local config key-store [file|keychain] | local-pc [on|off|status]\non requires an interactive terminal (stdin and stderr TTY). For non-interactive execution, pass --allow-local-pc on every invocation.'
  : 'Usage: ' + cliName + ' config key-store [file|keychain]';

/** Read or persist selection without moving or creating identities. */
export async function configCommand(args: string[], options: IdentityStoreOptions = {}): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE + '\n       ' + cliName + ' config auto-accept [off | invited|connected|anyone read-only|write | max-tasks-per-day-per-did N|off]'); return; }
  if (LOCAL_DISTRIBUTION && args[0] === 'local-pc') {
    const value = args[1] ?? 'status';
    if (args.length > 2 || !['on', 'off', 'status'].includes(value)) throw new Error('Usage: sealbridge-local config local-pc [on|off|status]');
    const configOptions = { ...options, allowPrivateRelay: true };
    if (value === 'on') {
      if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('LOCAL_PC_CONSENT_REQUIRES_TERMINAL: Run sealbridge-local config local-pc on in an interactive terminal (stdin and stderr must be TTY). For non-interactive execution, pass --allow-local-pc on every invocation.');
      if (!await confirmLocalPcExecution()) throw new Error('LOCAL_PC_EXECUTION_REQUIRES_OPT_IN');
      setApplicationLocalPcExecution(true, configOptions);
    } else if (value === 'off') setApplicationLocalPcExecution(false, configOptions);
    console.log(JSON.stringify({ localPcExecution: readApplicationConfig(configOptions).localPcExecution === true }));
    return;
  }
  if (args[0] === 'auto-accept') {
    const configOptions = { ...options, allowPrivateRelay: true };
    const current = autoAcceptPolicy(readApplicationConfig(configOptions).autoAccept);
    if (args.length > 1) {
      if (args.length === 3 && args[1] === 'max-tasks-per-day-per-did') {
        if (args[2] === 'off') delete current.limits.maxTasksPerDayPerDid;
        else {
          if (!/^[1-9][0-9]*$/.test(args[2]) || !Number.isSafeInteger(Number(args[2])))
            throw new Error('AUTO_ACCEPT_POLICY_INVALID');
          current.limits.maxTasksPerDayPerDid = Number(args[2]);
        }
      }
      else if (args.length === 2 && args[1] === 'off') current.enabled = false;
      else if (args.length === 3 && ['invited', 'connected', 'anyone'].includes(args[1]) && ['read-only', 'write'].includes(args[2])) {
        current.enabled = true;
        current.from = args[1] as typeof current.from;
        current.work = args[2] as typeof current.work;
      } else throw new Error('Usage: sealbridge config auto-accept [off | invited|connected|anyone read-only|write | max-tasks-per-day-per-did N|off]');
      setApplicationAutoAccept(current, configOptions);
    }
    console.log(JSON.stringify({ autoAccept: current }));
    return;
  }
  if (args[0] !== 'key-store' || args.length > 2) throw new Error(USAGE);
  const value = args[1];
  if (value !== undefined) {
    if (value !== 'file' && value !== 'keychain') throw new Error('KEY_STORE_INVALID');
    const configured: IdentityStoreOptions = { ...options, explicitKeyPath: undefined, keyStore: value };
    for (const role of ['requester', 'worker'] as const)
      await (await selectKeyStore(role, configured)).exists(role);
    const warnings = await otherKeyStorePresence(value, configured);
    setApplicationKeyStore(value, { ...options, allowPrivateRelay: true });
    for (const warning of warnings) console.warn(warning);
  }
  const selection = keyStoreSelection(options);
  console.log(JSON.stringify({ keyStore: typeof selection.keyStore === 'object' ? 'custom' : selection.keyStore,
    source: selection.source }));
}
