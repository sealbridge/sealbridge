// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { Json } from '@acp/core';

export function readTaskInputFile(path: string): Json {
  const contents = readFileSync(path, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    if (extname(path).toLowerCase() === '.json')
      throw new Error('INVALID_INPUT_FILE: expected a JSON object in the .json file');
    return { diff: contents };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_INPUT_FILE: JSON task input must be an object');
  return value as Json;
}
