// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { digest, generateKeyPair, signEnvelope, signPayload } from '../packages/core/src/index.js';
import type { Envelope, Json, SignedEnvelope, TaskManifest } from '../packages/core/src/index.js';
import { buildTaskManifest, taskContent } from '../packages/runtime/src/index.js';
import type { HeldTaskContent } from '../packages/runtime/src/index.js';

const NOW = Date.parse('2030-01-01T00:00:00Z');
function fixture(protocolVersion: '0.1.0' | '0.2.0' = '0.2.0', grant = false) {
  const owner = generateKeyPair(), requester = generateKeyPair(), other = generateKeyPair();
  const manifest = buildTaskManifest({ ownerDid: requester.did, workerDid: owner.did,
    title: 'Review', description: 'Task content', protocolVersion, now: () => NOW,
    ...(grant ? { contextGrant: { selectors: ['$.items'], angle: 'Review dimensions' } } : {}) });
  const input: Json = { items: [{ width: 12 }], text: 'literal \u202e <b>text</b>' };
  const body: Record<string, Json> = { proposal: signPayload(manifest, requester) as unknown as Json, input };
  const contentDigest = digest({ manifest, input });
  function envelope(content: Json = body, header: Partial<Envelope> = {}, signer = requester, encrypt = true) {
    return signEnvelope({ taskId: manifest.taskId, recipientDid: owner.did, seq: 0,
      eventType: 'PROPOSE', payload: content, ...header }, signer, { encrypt });
  }
  return { owner, requester, other, manifest, input, body, contentDigest, envelope };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([['0.1.0', false], ['0.2.0', false], ['0.2.0', true]] as const)
  ('extracts a verified %s task (grant=%s) with the three- and four-argument forms', (version, grant) => {
    const f = fixture(version, grant), envelope = f.envelope(), before = structuredClone({ envelope, owner: f.owner });
    const expected: HeldTaskContent = { manifest: f.manifest, input: f.input, capabilityChains: [] };
    expect(taskContent(envelope, f.owner, f.contentDigest)).toEqual(expected);
    expect(taskContent(envelope, f.owner, f.contentDigest, digest(envelope))).toEqual(expected);
    expect({ envelope, owner: f.owner }).toEqual(before);
  });

it.each([null, [], [[{ declaration: 'display only' }]]])('projects supplied capabilities or their existing default: %j', capabilities => {
  const f = fixture(); f.body.capabilityChains = capabilities;
  expect(taskContent(f.envelope(), f.owner, f.contentDigest).capabilityChains).toEqual(capabilities ?? []);
});

it('returns only manifest, input and capabilities without transport or invitation fields', () => {
  const f = fixture();
  Object.assign(f.body, { inviteToken: 'invitation', connectionRequest: { value: 'connection' },
    liveness: { token: 'liveness' }, transport: { credential: 'transport' } });
  const result = taskContent(f.envelope(), f.owner, f.contentDigest);
  expect(result).toEqual({ manifest: f.manifest, input: f.input, capabilityChains: [] });
  expect(Object.keys(result).sort()).toEqual(['capabilityChains', 'input', 'manifest']);
});

it('retains expired terminal task and grant content for review without network calls', () => {
  const f = fixture('0.2.0', true);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW + 30 * 86400000);
  const fetch = vi.fn(() => { throw new Error('Unexpected network call'); }); vi.stubGlobal('fetch', fetch);
  expect(taskContent(f.envelope(), f.owner, f.contentDigest).manifest.contextGrant).toEqual(f.manifest.contextGrant);
  expect(fetch).not.toHaveBeenCalled();
});

it('rejects a signature-only edit even when the optional digest matches the edited envelope', () => {
  const f = fixture(), envelope = f.envelope();
  envelope.signature.signature = Buffer.alloc(64).toString('base64url');
  expect(() => taskContent(envelope, f.owner, f.contentDigest)).toThrow(/^INVALID_PROPOSAL$/);
  expect(() => taskContent(envelope, f.owner, f.contentDigest, digest(envelope))).toThrow(/^INVALID_PROPOSAL$/);
});

it('rejects an outer payload edit', () => {
  const f = fixture(), envelope = f.envelope(); envelope.payload.seq = 1;
  expect(() => taskContent(envelope, f.owner, f.contentDigest)).toThrow(/^INVALID_PROPOSAL$/);
});

it('rejects ciphertext changes with a valid outer signature using a fixed error', () => {
  const f = fixture(), envelope = f.envelope();
  (envelope.payload.payload as Record<string, Json>).tag = Buffer.alloc(16).toString('base64url');
  const signed = signPayload(envelope.payload, f.requester);
  expect(() => taskContent(signed, f.owner, f.contentDigest)).toThrow(/^ENVELOPE_DECRYPTION_FAILED$/);
});

it('requires encrypted content', () => {
  const f = fixture();
  expect(() => taskContent(f.envelope(f.body, {}, f.requester, false), f.owner, f.contentDigest))
    .toThrow(/^UNENCRYPTED_ENVELOPE_REJECTED$/);
});

it('requires the owner recipient and matching decryption key', () => {
  const f = fixture();
  expect(() => taskContent(f.envelope(f.body, { recipientDid: f.other.did }), f.owner, f.contentDigest))
    .toThrow(/^INVALID_PROPOSAL$/);
  expect(() => taskContent(f.envelope(), { ...f.owner, privateKey: f.other.privateKey }, f.contentDigest))
    .toThrow(/^ENVELOPE_DECRYPTION_FAILED$/);
});

it.each([{ eventType: 'DELIVER' }, { seq: 1 }, { taskId: 'task_other' }])('requires task envelope bindings: %j', header => {
  const f = fixture();
  expect(() => taskContent(f.envelope(f.body, header), f.owner, f.contentDigest)).toThrow(/^INVALID_PROPOSAL$/);
});

it('requires the signed proposal requester to match the envelope sender', () => {
  const f = fixture();
  expect(() => taskContent(f.envelope(f.body, {}, f.other), f.owner, f.contentDigest)).toThrow(/^INVALID_PROPOSAL$/);
});

it.each(['signature', 'payload', 'signer'] as const)('requires proposal signature binding: %s', edit => {
  const f = fixture(), proposal = signPayload(f.manifest, f.requester);
  if (edit === 'signature') proposal.signature.signature = Buffer.alloc(64).toString('base64url');
  if (edit === 'payload') proposal.payload.task.title = 'Changed';
  f.body.proposal = (edit === 'signer' ? signPayload(f.manifest, f.other) : proposal) as unknown as Json;
  expect(() => taskContent(f.envelope(), f.owner, f.contentDigest)).toThrow(/^INVALID_PROPOSAL$/);
});

it.each(['other', 'absent'] as const)('requires the manifest worker owner: %s', edit => {
  const f = fixture();
  if (edit === 'other') f.manifest.worker!.ownerDid = f.other.did;
  else delete f.manifest.worker;
  f.body.proposal = signPayload(f.manifest, f.requester) as unknown as Json;
  const contentDigest = digest({ manifest: f.manifest, input: f.input });
  expect(() => taskContent(f.envelope(), f.owner, contentDigest)).toThrow(/^INVALID_PROPOSAL$/);
});

it('requires an own input field while allowing explicit null', () => {
  const f = fixture(); delete f.body.input;
  expect(() => taskContent(f.envelope(), f.owner, f.contentDigest)).toThrow(/^INVALID_PROPOSAL$/);
  // JSON.parse must not acquire an input field from the object prototype.
  Object.defineProperty(Object.prototype, 'input', { configurable: true, value: f.input });
  try {
    expect(() => taskContent(f.envelope(), f.owner, f.contentDigest)).toThrow(/^INVALID_PROPOSAL$/);
  } finally { delete (Object.prototype as { input?: Json }).input; }
  f.body.input = null;
  expect(taskContent(f.envelope(), f.owner, digest({ manifest: f.manifest, input: null })).input).toBe(null);
});

it.each([null, [], 'literal', {}, { input: {} }, { input: {}, proposal: { payload: {} } }] as Json[])
  ('rejects malformed decrypted content with a fixed error: %j', body => {
    const f = fixture();
    expect(() => taskContent(f.envelope(body), f.owner, f.contentDigest)).toThrow(/^INVALID_PROPOSAL$/);
  });

it.each(['schema', 'version', 'grant'] as const)('rejects an invalid manifest without parser details: %s', edit => {
  const f = fixture('0.2.0', true);
  if (edit === 'schema') delete (f.manifest as Partial<TaskManifest>).task;
  if (edit === 'version') (f.manifest as unknown as Record<string, Json>).protocolVersion = '9.9.9';
  if (edit === 'grant') f.manifest.contextGrant!.inputRetentionAllowed = true;
  f.body.proposal = signPayload(f.manifest, f.requester) as unknown as Json;
  expect(() => taskContent(f.envelope(), f.owner, f.contentDigest)).toThrow(/^INVALID_PROPOSAL$/);
});

it('binds the content digest to the returned proposal manifest and input', () => {
  const f = fixture(); f.body.input = { changed: true };
  expect(() => taskContent(f.envelope(), f.owner, f.contentDigest)).toThrow(/^INVALID_PROPOSAL$/);
  const otherManifest = { ...f.manifest, task: { ...f.manifest.task, title: 'Other' } };
  f.body.manifest = otherManifest as unknown as Json;
  expect(() => taskContent(f.envelope(), f.owner, digest({ manifest: otherManifest, input: f.body.input })))
    .toThrow(/^INVALID_PROPOSAL$/);
  expect(taskContent(f.envelope(), f.owner, digest({ manifest: f.manifest, input: f.body.input })).manifest).toEqual(f.manifest);
});

it('rejects wrong optional envelope digests and malformed envelopes with fixed errors', () => {
  const f = fixture();
  expect(() => taskContent(f.envelope(), f.owner, f.contentDigest, digest('other'))).toThrow(/^INVALID_PROPOSAL$/);
  expect(() => taskContent(f.envelope(), f.owner, f.contentDigest, '')).toThrow(/^INVALID_PROPOSAL$/);
  for (const value of [null, {}, { payload: {} }])
    expect(() => taskContent(value as SignedEnvelope, f.owner, f.contentDigest)).toThrow(/^INVALID_PROPOSAL$/);
});
