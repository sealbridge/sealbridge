// SPDX-License-Identifier: Apache-2.0
import type * as fs from 'node:fs';
import type { KeyPair } from '@acp/core';
export type IdentityRole = 'requester' | 'worker';
export interface DataRootOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}
export interface LocalIdentityOptions extends DataRootOptions {
  explicitKeyPath?: string;
  /** Filesystem injection for deterministic I/O failure tests. */
  fs?: typeof fs;
}
export interface LocalIdentity {
  path: string;
  source: 'explicit' | 'default' | 'legacy';
  key?: KeyPair;
}

export * from '@acp/runtime-local/local-identity';
