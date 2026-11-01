// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import type { KeyPair } from '@acp/core';
import { inspectStoredIdentity, resolveStoredIdentity } from '@acp/runtime/key-store';
import type { IdentityStoreOptions } from '@acp/runtime/key-store';
import type { IdentityRole } from '@acp/runtime/local-identity';

/** Retain the existing explicit-file reader for these command surfaces. */
export function readCommandKey(path: string): KeyPair {
  return JSON.parse(readFileSync(path, 'utf8')) as KeyPair;
}

export async function commandIdentity(role: IdentityRole, path: string | undefined,
  options: IdentityStoreOptions, create = true): Promise<KeyPair | undefined> {
  if (path !== undefined) return readCommandKey(path);
  return create ? resolveStoredIdentity(role, options) : (await inspectStoredIdentity(role, options)).key;
}
