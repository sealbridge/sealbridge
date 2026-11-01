// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import type { TaskManifest, Schema } from './types.js';
import { isManifestProtocolVersion } from './protocol.js';
export function createAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
  (formats as unknown as (a: Ajv2020) => void)(ajv);
  return ajv;
}
export const specDirectory = new URL('../../../spec/', import.meta.url);
export const SCHEMA_NAMES = [
  'task-manifest', 'task-manifest.0.1.0', 'task-manifest.0.2.0', 'agent-card',
  'envelope', 'usage-receipt', 'ack-receipt', 'capability-token', 'approval-receipt', 'audit-entry',
] as const;
export function loadSchema(name: string): Schema {
  if (!SCHEMA_NAMES.some(known => known === name)) throw new Error('INVALID_SCHEMA_NAME');
  return JSON.parse(readFileSync(new URL(name + '.schema.json', specDirectory), 'utf8')) as Schema;
}
let cachedRegistry: ReturnType<typeof createAjv> | undefined;
/** Spec files are static. Rebuilding Ajv for every envelope check dominates a session. */
export function schemaRegistry() {
  if (cachedRegistry) return cachedRegistry;
  const ajv = createAjv();
  for (const f of readdirSync(specDirectory).filter((f) => f.endsWith('.schema.json')))
    ajv.addSchema(loadSchema(f.slice(0, -12)), f.slice(0, -12));
  cachedRegistry = ajv;
  return ajv;
}
export function validateSchema(name: string, value: unknown): void {
  if (!SCHEMA_NAMES.some(known => known === name)) throw new Error('INVALID_SCHEMA_NAME');
  const ajv = schemaRegistry();
  const validate = ajv.getSchema(name)!;
  if (!validate(value)) throw new Error('SCHEMA_VIOLATION: ' + ajv.errorsText(validate.errors));
}
export function validateManifest(value: unknown): asserts value is TaskManifest {
  const version = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { protocolVersion?: unknown }).protocolVersion : undefined;
  if (version !== undefined && !isManifestProtocolVersion(version))
    throw new Error('PROTOCOL_VERSION_UNSUPPORTED');
  validateSchema(isManifestProtocolVersion(version) ? 'task-manifest.' + version : 'task-manifest', value);
}
export function assertSynchronousSchema(schema: unknown): void {
  if (!schema || typeof schema !== 'object') return;
  if (Object.hasOwn(schema, '$async')) throw new Error('ASYNC_SCHEMA_FORBIDDEN');
  for (const value of Object.values(schema)) assertSynchronousSchema(value);
}
export function validateOutput(schema: Schema, value: unknown): boolean {
  assertSynchronousSchema(schema);
  return createAjv().compile(schema)(value) === true;
}
