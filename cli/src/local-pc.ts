// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { dirname } from 'node:path';
import { checkPath, privateDirectory } from '@acp/runtime/local-identity';
import { appendFileSync, closeSync, constants, fchmodSync, fstatSync, openSync } from 'node:fs';
import { signPayload } from '@acp/core';
import type { KeyPair } from '@acp/core';

export const LOCAL_PC_DISABLED = 'Local PC execution is disabled by default in mainline sealbridge. Tasks you accept could reach files, signed-in accounts, and the network on this PC. Running workers in an isolated environment (microVM) is recommended. To run on this PC anyway, pass `--allow-local-pc`. For local use, install `sealbridge-local` or use Sealbridge Desktop.';
export const LOCAL_PC_MIGRATION = 'Migration: run `npm i -g sealbridge-local`, then replace `sealbridge worker start …` with `sealbridge-local worker start …` (your keys and data directory are reused).';
export const LOCAL_PC_DISABLED_JA = 'ローカルPCでの実行は、本流の sealbridge では既定で無効です。このPCのファイル、ログイン情報、ネットワークに、依頼されたタスクから手が届く可能性があります。隔離された環境（microVM）で動かすことをおすすめします。それでもこのPCで動かす場合は `--allow-local-pc` を付けてください。ローカルで使う場合は、ローカル版（`sealbridge-local`）か Sealbridge Desktop をお使いください。';
export const LOCAL_PC_MIGRATION_JA = '乗り換え: `npm i -g sealbridge-local` のあと、`sealbridge worker start …` を `sealbridge-local worker start …` に置き換えてください（鍵とデータディレクトリはそのまま使えます）。';
export const LOCAL_PC_WARNING = 'Warning: running on this PC (isolation: host_adapter). Owner approval and content inspection stay on. No execution attestation is attached.';

/** CLI flag only: environment and application settings cannot grant this permission. */
export function requireLocalPcOptIn(value: string | true | undefined): void {
  if (value !== true) throw Object.assign(new Error(
    'LOCAL_PC_EXECUTION_REQUIRES_OPT_IN: ' + LOCAL_PC_DISABLED + '\n' + LOCAL_PC_MIGRATION,
  ), { code: 'LOCAL_PC_EXECUTION_REQUIRES_OPT_IN' });
}

/** Startup evidence is local, signed, and separate from bilateral task ledgers. */
export function auditLocalPcOptIn(path: string, owner: KeyPair, managedDirectory = false): void {
  if (managedDirectory) {
    for (const directory of [dirname(dirname(dirname(path))), dirname(dirname(path)), dirname(path)])
      privateDirectory(directory, fs);
  }
  checkPath(path, fs);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND |
    constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('INVALID_AUDIT_FILE');
    fchmodSync(fd, 0o600);
    appendFileSync(fd, JSON.stringify(signPayload({ event: 'LOCAL_PC_OPT_IN',
      timestamp: new Date().toISOString(), workerDid: owner.did,
      isolation: 'host_adapter', ownerApproval: true, contentInspection: true,
    }, owner)) + '\n');
  } finally { closeSync(fd); }
}
