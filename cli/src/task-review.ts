// SPDX-License-Identifier: Apache-2.0
import { digest, openEnvelope, validateManifest, verifySigned } from '@acp/core';
import type { Json, KeyPair, Signed, SignedEnvelope, TaskManifest } from '@acp/core';
import { heldContentDigest } from '@acp/runtime';
import type { HeldContentReviewProvider } from '@acp/runtime';

/** JSON is literal owner-facing data. Escape format controls as well as terminal controls. */
export function literalText(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, c => c === '\n' ? c :
    c.split('').map(unit => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0')).join(''));
}

export function taskContent(envelope: SignedEnvelope, owner: KeyPair, contentDigest: string) {
  const body = openEnvelope<Json>(envelope, owner) as unknown as {
    proposal: Signed<TaskManifest>; input: Json; capabilityChains?: Json;
  };
  const manifest = body?.proposal?.payload;
  validateManifest(manifest);
  if (envelope.payload.eventType !== 'PROPOSE' || envelope.payload.seq !== 0 ||
      manifest.taskId !== envelope.payload.taskId || manifest.worker?.ownerDid !== owner.did ||
      manifest.requester.ownerDid !== envelope.payload.senderDid || !verifySigned(body.proposal, manifest.requester.ownerDid) ||
      heldContentDigest('task', body as unknown as Json) !== contentDigest)
    throw new Error('INVALID_PROPOSAL');
  // Transport credentials and invitations are not task content.
  return { manifest, input: body.input, capabilityChains: body.capabilityChains ?? [] };
}

/** Completion means validated content was rendered, never that execution was authorized. */
export function cliTaskInspection(output: (text: string) => void | Promise<void>): HeldContentReviewProvider {
  return { async inspect(envelope, context, signal) {
    if (context.kind !== 'task' || signal.aborted) throw new Error('INSPECTION_INCOMPLETE');
    const content = taskContent(envelope, context.owner, context.contentDigest);
    if (digest(envelope) !== context.envelopeDigest) throw new Error('INVALID_PROPOSAL');
    await output(literalText({ heldId: context.recordId, ...content }));
    if (signal.aborted) throw new Error('INSPECTION_INCOMPLETE');
    return { ownerDid: context.owner.did, kind: context.kind, envelopeDigest: context.envelopeDigest,
      contentDigest: context.contentDigest, status: 'complete',
      reportDigest: digest({ type: 'CliTaskDisplay', v: 1, contentDigest: context.contentDigest }) };
  } };
}
