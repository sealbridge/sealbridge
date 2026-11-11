// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';

/** Only the local owner's command is shell code. Remote records travel on stdin. */
export function createReceiveHook(command: string): (record: string) => void {
  if (!command.trim()) throw new Error('Missing --on-receive');
  return (record) => {
    const warn = () => console.error('ACP_ON_RECEIVE_FAILED');
    try {
      const child = spawn(command, {
        shell: true,
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      let reported = false;
      const failed = () => {
        if (!reported) { reported = true; warn(); }
      };
      child.on('error', failed);
      child.on('exit', (code) => { if (code !== 0) failed(); });
      child.stdin!.on('error', failed);
      child.stdin!.end(record);
      // A notification must not keep a --once worker alive until the hook exits.
      child.unref();
    } catch {
      warn();
    }
  };
}
