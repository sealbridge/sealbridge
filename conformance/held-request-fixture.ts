// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, generateKeyPair, signEnvelope } from '../packages/core/src/index.js';
import type { Json } from '../packages/core/src/index.js';
import { HeldRequestReview, HeldRequestStore, buildTaskManifest, heldContentDigest } from '../packages/runtime/src/index.js';
import type { HeldContentKind, HeldRequestReviewOptions } from '../packages/runtime/src/index.js';

export const HELD_TEST_NOW = Date.parse('2026-11-02T00:00:00.000Z');
export function heldFixture() {
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'sealbridge-held-'));
  fs.chmodSync(root, 0o700);
  const owner = generateKeyPair(), peer = generateKeyPair(); let clock = HELD_TEST_NOW;
  const options = { env: { SEALBRIDGE_DATA_DIR: root }, now: () => clock };
  const store = new HeldRequestStore(owner, options);
  function request(kind: HeldContentKind = 'task', input: Json = { text: 'original input marker' }) {
    const taskId = randomUUID();
    const manifest = buildTaskManifest({ ownerDid: peer.did, workerDid: owner.did, title: 'original title marker', description: 'original description marker' });
    manifest.taskId = taskId;
    manifest.createdAt = new Date(clock).toISOString(); manifest.deadline = new Date(clock + 48 * 3600_000).toISOString();
    const content: Json = kind === 'task' ? { manifest: manifest as unknown as Json, input } : { message: input };
    const envelope = signEnvelope({ taskId, seq: 0, eventType: kind === 'task' ? 'PROPOSE' : 'CONNECTION_REQUEST',
      recipientDid: owner.did, payload: content }, peer, { encrypt: true });
    return { id: randomUUID(), kind, senderOwnerDid: peer.did, taskId, contentDigest: heldContentDigest(kind, content),
      deadline: clock + 48 * 3600_000, envelope, content };
  }
  return { root, owner, peer, options, store, request,
    review: (extra: HeldRequestReviewOptions = {}) => new HeldRequestReview(owner, { ...options, ...extra }),
    advance: (ms: number) => { clock += ms; }, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
/** Test-only completion provider. It supplies no inspection implementation. */
export const testOnlyCompletionProvider = {
  async inspect(_envelope: unknown, context: { owner: { did: string }; contentDigest: string; envelopeDigest: string; kind: HeldContentKind }) {
    return { ownerDid: context.owner.did, contentDigest: context.contentDigest, envelopeDigest: context.envelopeDigest,
      kind: context.kind, status: 'complete' as const, reportDigest: digest({ fixture: 'test-only' }) };
  },
};
