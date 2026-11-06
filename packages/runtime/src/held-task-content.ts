// SPDX-License-Identifier: Apache-2.0
import { digest, openEnvelope, validateManifest, verifyEnvelope, verifySigned } from '@acp/core';
import type { Json, KeyPair, Signed, SignedEnvelope, TaskManifest } from '@acp/core';
import { heldContentDigest } from './held-request-review.js';

/** Sensitive in-memory projection; contains no invitation or transport fields. */
export interface HeldTaskContent {
  manifest: TaskManifest;
  input: Json;
  capabilityChains: Json;
}

/**
 * Verify and decrypt task content for inspection or owner-facing display.
 * Display callers must separately require completed held review. This function
 * grants no execution permission and checks neither capability authority nor
 * current deadline/grant usability, so terminal attempts remain reviewable.
 */
export function taskContent(envelope: SignedEnvelope, owner: KeyPair,
  contentDigest: string, envelopeDigest?: string): HeldTaskContent {
  if (!verifyEnvelope(envelope, owner.did) ||
      envelopeDigest !== undefined && digest(envelope) !== envelopeDigest)
    throw new Error('INVALID_PROPOSAL');
  // openEnvelope requires encryption and returns fixed decryption error codes.
  const body = openEnvelope<Json>(envelope, owner) as unknown as {
    proposal: Signed<TaskManifest>; input: Json; capabilityChains?: Json;
  };
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'input'))
      throw new Error('INVALID_PROPOSAL');
    const manifest = body.proposal?.payload;
    validateManifest(manifest);
    if (envelope.payload.eventType !== 'PROPOSE' || envelope.payload.seq !== 0 ||
        manifest.taskId !== envelope.payload.taskId || manifest.worker?.ownerDid !== owner.did ||
        manifest.requester.ownerDid !== envelope.payload.senderDid || !verifySigned(body.proposal, manifest.requester.ownerDid) ||
        heldContentDigest('task', { manifest: manifest as unknown as Json, input: body.input }) !== contentDigest)
      throw new Error('INVALID_PROPOSAL');
    return { manifest, input: body.input, capabilityChains: body.capabilityChains ?? [] };
  } catch {
    // Schema/parser details and plaintext never become display diagnostics.
    throw new Error('INVALID_PROPOSAL');
  }
}
