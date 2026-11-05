// SPDX-License-Identifier: Apache-2.0
import { digest } from './crypto.js';
import { validateSchema } from './schema.js';
import type { ContextGrant, ContextGrantOptions, ContextGrantAuditPayload, TaskManifest } from './types.js';

export const CONTEXT_GRANT_MAX_BYTES = 64 * 1024;
export const CONTEXT_GRANT_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const CONTEXT_GRANT_DEFAULT_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Time-independent contract checks also apply when verifying historical evidence. */
export function validateContextGrant(grant: unknown, createdAt: string): asserts grant is ContextGrant {
  validateSchema('context-grant', grant);
  const g = grant as ContextGrant;
  if (g.inputRetentionAllowed === true) throw new Error('CONTEXT_GRANT_INPUT_RETENTION_UNAVAILABLE');
  const start = Date.parse(createdAt), end = Date.parse(g.expiresAt);
  if (!Number.isFinite(start) || end <= start || end - start > CONTEXT_GRANT_MAX_LIFETIME_MS)
    throw new Error('CONTEXT_GRANT_EXPIRY_INVALID');
  const denied = new Set(g.fieldsDenied);
  if (g.fieldsAllowed?.some(field => denied.has(field))) throw new Error('CONTEXT_GRANT_FIELDS_CONFLICT');
}

export function validateManifestContextGrant(manifest: TaskManifest): void {
  const grant = manifest.contextGrant;
  if (!grant) return;
  validateContextGrant(grant, manifest.createdAt);
  if (manifest.protocolVersion !== '0.2.0') throw new Error('CONTEXT_GRANT_PROTOCOL_UNSUPPORTED');
  if (manifest.permissions.maxDelegationDepth !== (grant.deliveryMode === 'approval_redelegation' ? 1 : 0)) throw new Error('CONTEXT_GRANT_DEPTH_CONFLICT');
  if (grant.deliveryMode !== 'hand_over' && manifest.sandboxPolicy.filesystemScope !== 'ephemeral_workspace_only')
    throw new Error('CONTEXT_GRANT_FILESYSTEM_CONFLICT');
}

/** Check live use separately so expired grants remain verifiable in historical contracts. */
export function validateContextGrantUse(manifest: TaskManifest, input: unknown, now = Date.now()): void {
  validateManifestContextGrant(manifest);
  const grant = manifest.contextGrant;
  if (!grant) return;
  if (!Number.isFinite(now) || Date.parse(grant.expiresAt) <= now) throw new Error('CONTEXT_GRANT_EXPIRED');
  const bytes = JSON.stringify(input);
  if (bytes === undefined || Buffer.byteLength(bytes, 'utf8') > grant.maxBytes)
    throw new Error('CONTEXT_GRANT_MAX_BYTES_EXCEEDED');
}

/** Defaults are opt-in and never widen a supplied declaration. */
export function buildContextGrant(options: ContextGrantOptions, createdAt = new Date().toISOString()): ContextGrant {
  const mode = options.deliveryMode === undefined ? 'view_only' : options.deliveryMode;
  const grant: ContextGrant = structuredClone({
    ...options,
    deliveryMode: mode,
    expiresAt: options.expiresAt === undefined
      ? new Date(Date.parse(createdAt) + CONTEXT_GRANT_DEFAULT_LIFETIME_MS).toISOString() : options.expiresAt,
    maxBytes: options.maxBytes === undefined ? CONTEXT_GRANT_MAX_BYTES : options.maxBytes,
    retention: options.retention === undefined
      ? mode === 'hand_over' ? 'keep_deliverable' : 'ephemeral_view' : options.retention,
    inputRetentionAllowed: options.inputRetentionAllowed === undefined ? false : options.inputRetentionAllowed,
  });
  validateContextGrant(grant, createdAt);
  return grant;
}

/** Only these two fields enter context lifecycle audit payloads. */
export function contextGrantAuditPayload(grant: ContextGrant): ContextGrantAuditPayload {
  validateSchema('context-grant', grant);
  return { grantDigest: digest(grant), deliveryMode: grant.deliveryMode };
}
