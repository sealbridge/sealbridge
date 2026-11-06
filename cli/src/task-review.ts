// SPDX-License-Identifier: Apache-2.0
import { digest } from '@acp/core';
import { taskContent } from '@acp/runtime';
import type { HeldContentReviewProvider } from '@acp/runtime';
export { taskContent } from '@acp/runtime';

/** JSON is literal owner-facing data. Escape format controls as well as terminal controls. */
export function literalText(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, c => c === '\n' ? c :
    c.split('').map(unit => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0')).join(''));
}

/** Completion means validated content was rendered, never that execution was authorized. */
export function cliTaskInspection(output: (text: string) => void | Promise<void>): HeldContentReviewProvider {
  return { async inspect(envelope, context, signal) {
    if (context.kind !== 'task' || signal.aborted) throw new Error('INSPECTION_INCOMPLETE');
    const content = taskContent(envelope, context.owner, context.contentDigest, context.envelopeDigest);
    await output(literalText({ heldId: context.recordId, ...content }));
    if (signal.aborted) throw new Error('INSPECTION_INCOMPLETE');
    return { ownerDid: context.owner.did, kind: context.kind, envelopeDigest: context.envelopeDigest,
      contentDigest: context.contentDigest, status: 'complete',
      reportDigest: digest({ type: 'CliTaskDisplay', v: 1, contentDigest: context.contentDigest }) };
  } };
}
