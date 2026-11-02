// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { digest, openEnvelope, signPayload, verifySigned } from '../packages/core/src/index.js';
import type { Json } from '../packages/core/src/index.js';
import type { HeldContentInspection, HeldContentReviewProvider, InspectionCompletion } from '../packages/runtime/src/index.js';
import { HeldRequestReview } from '../packages/runtime/src/index.js';
import { HELD_TEST_NOW, heldFixture, testOnlyCompletionProvider } from './held-request-fixture.js';
let f: ReturnType<typeof heldFixture>;
beforeEach(() => { f = heldFixture(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); f.cleanup(); });

it('keeps content held with the default unavailable provider across restart', async () => {
  const review = f.review(), request = f.request(), summary = review.hold(request);
  expect(() => review.showReviewedContent(summary.id)).toThrow('INSPECTION_INCOMPLETE');
  const result = await review.inspect(summary.id);
  expect(result).toMatchObject({ state: 'held', inspectionStatus: 'unavailable' });
  expect(() => review.showReviewedContent(summary.id)).toThrow('INSPECTION_UNAVAILABLE');
  const restart = f.review(); expect(restart.list()).toEqual([result]);
  expect(() => restart.showReviewedContent(summary.id)).toThrow('INSPECTION_UNAVAILABLE');
  expect(JSON.stringify(result)).not.toContain('original input marker');
});
it('permits an explicit owner-facing read only after a bound test-only completion', async () => {
  const provider = { inspect: vi.fn(testOnlyCompletionProvider.inspect) }, review = f.review({ provider });
  const request = f.request(); review.hold(request);
  const receiveHook = vi.fn();
  expect(() => receiveHook(review.showReviewedContent(request.id))).toThrow('INSPECTION_INCOMPLETE');
  expect(receiveHook).not.toHaveBeenCalled(); expect(provider.inspect).not.toHaveBeenCalled();
  const complete = await review.inspect(request.id);
  expect(complete).toMatchObject({ state: 'reviewable', inspectionStatus: 'complete' });
  const record = f.store.read(request.id)!;
  expect(verifySigned(record.inspectionReceipt!, f.owner.did)).toBe(true);
  expect(record.inspectionReceipt?.payload).toMatchObject({ recordId: request.id, contentDigest: request.contentDigest,
    envelopeDigest: digest(request.envelope), status: 'complete', inspectedAt: HELD_TEST_NOW });
  receiveHook(review.showReviewedContent(request.id)); expect(receiveHook).toHaveBeenCalledWith(request.content);
  expect(f.review().showReviewedContent(request.id)).toEqual(request.content);
  await review.inspect(request.id); expect(provider.inspect).toHaveBeenCalledTimes(1);
  const raw = fs.readFileSync(join(f.store.directory, request.id + '.json'), 'utf8');
  expect(raw).not.toContain('original input marker');
  expect(record.envelope).toEqual(request.envelope);
});
it.each(['ownerDid', 'contentDigest', 'envelopeDigest', 'kind', 'reportDigest'] as const)('keeps content held when a completion has a different %s', async field => {
  const provider: HeldContentReviewProvider = { async inspect(envelope, context) {
    const result: InspectionCompletion = await testOnlyCompletionProvider.inspect(envelope, context);
    return { ...result, [field]: field === 'kind' ? 'connection' : 'different' };
  } };
  const review = f.review({ provider }), request = f.request(); review.hold(request);
  expect(await review.inspect(request.id)).toMatchObject({ state: 'held', inspectionStatus: 'error' });
  expect(() => review.showReviewedContent(request.id)).toThrow('INSPECTION_INCOMPLETE');
});
it('binds completion to the decrypted proposal digest as well as the envelope digest', async () => {
  const review = f.review({ provider: testOnlyCompletionProvider }), request = f.request();
  review.hold({ ...request, contentDigest: digest('other proposal') });
  expect(await review.inspect(request.id)).toMatchObject({ state: 'held', inspectionStatus: 'error' });
  expect(() => review.showReviewedContent(request.id)).toThrow('INSPECTION_INCOMPLETE');
});
it('gives the provider independent in-memory arguments and never persists its free-form fields', async () => {
  const request = f.request();
  const provider: HeldContentReviewProvider = { async inspect(envelope, context) {
    const plaintext = openEnvelope<Json>(envelope, context.owner); expect(plaintext).toEqual(request.content);
    const result = await testOnlyCompletionProvider.inspect(envelope, context);
    envelope.payload.taskId = 'changed'; context.owner.did = 'changed';
    return { ...result, extra: 'original input marker' };
  } };
  const review = f.review({ provider }); review.hold(request);
  expect((await review.inspect(request.id)).state).toBe('reviewable');
  expect(f.store.read(request.id)?.envelope).toEqual(request.envelope);
  expect(review.showReviewedContent(request.id)).toEqual(request.content);
  expect(fs.readFileSync(join(f.store.directory, request.id + '.json'), 'utf8')).not.toContain('original input marker');
});
it('keeps provider exceptions held with fixed metadata and permits an explicit later inspection', async () => {
  const provider = { inspect: vi.fn().mockRejectedValueOnce(new Error('original input marker')).mockImplementation(testOnlyCompletionProvider.inspect) };
  const review = f.review({ provider }), request = f.request(); review.hold(request);
  expect(await review.inspect(request.id)).toMatchObject({ state: 'held', inspectionStatus: 'error' });
  expect(fs.readFileSync(join(f.store.directory, request.id + '.json'), 'utf8')).not.toContain('original input marker');
  expect(await review.inspect(request.id)).toMatchObject({ state: 'reviewable', inspectionStatus: 'complete' });
});
it('aborts on timeout, ignores late completion, and leaves the record held', async () => {
  vi.useFakeTimers();
  let complete!: (result: InspectionCompletion) => void, completion!: InspectionCompletion, observedSignal!: AbortSignal;
  const provider: HeldContentReviewProvider = { async inspect(envelope, context, signal) {
    observedSignal = signal; completion = await testOnlyCompletionProvider.inspect(envelope, context);
    return new Promise(resolve => { complete = resolve; });
  } };
  const review = f.review({ provider, inspectionTimeoutMs: 100 }), request = f.request(); review.hold(request);
  const inspecting = review.inspect(request.id); await vi.advanceTimersByTimeAsync(100);
  expect(await inspecting).toMatchObject({ state: 'held', inspectionStatus: 'error' }); expect(observedSignal.aborted).toBe(true);
  complete(completion); await Promise.resolve();
  expect(review.list()[0].state).toBe('held'); expect(() => review.showReviewedContent(request.id)).toThrow('INSPECTION_INCOMPLETE');
});
it('honors cancellation before and during inspection without opening content', async () => {
  const provider = { inspect: vi.fn(async () => new Promise<InspectionCompletion>(() => {})) };
  const review = f.review({ provider }), request = f.request(); review.hold(request);
  const first = new AbortController(); first.abort();
  expect((await review.inspect(request.id, first.signal)).state).toBe('held'); expect(provider.inspect).not.toHaveBeenCalled();
  const next = new AbortController(), inspecting = review.inspect(request.id, next.signal);
  await Promise.resolve(); next.abort();
  expect((await inspecting).state).toBe('held'); expect(provider.inspect).toHaveBeenCalledTimes(1);
});
it('does not restore content discarded or expired while the provider is pending', async () => {
  let finish!: (result: InspectionCompletion) => void, completion!: InspectionCompletion;
  const provider: HeldContentReviewProvider = { async inspect(envelope, context) {
    completion = await testOnlyCompletionProvider.inspect(envelope, context);
    return new Promise(resolve => { finish = resolve; });
  } };
  const review = f.review({ provider }), request = f.request(); review.hold(request);
  const inspecting = review.inspect(request.id); await Promise.resolve(); await Promise.resolve();
  review.discard(request.id); finish(completion);
  await expect(inspecting).rejects.toThrow('QUARANTINE_NOT_FOUND'); expect(review.list()).toEqual([]);
  const next = f.request(); review.hold({ ...next, deadline: f.options.now() + 1 });
  const expiring = review.inspect(next.id); await Promise.resolve(); await Promise.resolve();
  f.advance(1); review.expire(); finish(completion);
  await expect(expiring).rejects.toThrow('QUARANTINE_NOT_FOUND'); expect(review.list()).toEqual([]);
});
it('retains ciphertext after a task read and deletes an offer on an explicit decision cleanup', async () => {
  const review = f.review({ provider: testOnlyCompletionProvider });
  for (const kind of ['task', 'connection', 'application'] as const) {
    const request = f.request(kind); review.hold(request); await review.inspect(request.id);
    expect(review.showReviewedContent(request.id)).toEqual(request.content);
    expect(f.store.read(request.id)).toBeDefined();
    expect(review.discard(request.id)).toBe(true); expect(f.store.read(request.id)).toBeUndefined();
  }
  expect(review.list()).toEqual([]);
});
it('applies the original retention deadline to reviewed task content', async () => {
  const review = f.review({ provider: testOnlyCompletionProvider }), request = f.request();
  review.hold({ ...request, deadline: f.options.now() + 10 }); await review.inspect(request.id);
  const file = join(f.store.directory, request.id + '.json'), bytes = fs.readFileSync(file, 'utf8');
  f.advance(10); expect(() => review.showReviewedContent(request.id)).toThrow('QUARANTINE_NOT_FOUND');
  expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  expect(review.expire()).toBe(1); expect(fs.existsSync(file)).toBe(false);
});
it('keeps a completed inspection when a concurrent provider attempt later returns an error', async () => {
  let fail!: (result: InspectionCompletion) => void, completion!: InspectionCompletion;
  const slow = f.review({ provider: { async inspect(envelope, context) {
    completion = await testOnlyCompletionProvider.inspect(envelope, context);
    return new Promise(resolve => { fail = resolve; });
  } } });
  const fast = f.review({ provider: testOnlyCompletionProvider }), request = f.request(); slow.hold(request);
  const pending = slow.inspect(request.id); await Promise.resolve(); await Promise.resolve();
  expect((await fast.inspect(request.id)).state).toBe('reviewable');
  fail({ ...completion, status: 'error' }); expect((await pending).state).toBe('reviewable');
  expect(slow.showReviewedContent(request.id)).toEqual(request.content);
});
it('does not mark inspection complete when receipt publication fails', async () => {
  const request = f.request(); f.store.hold(request);
  const review = f.review({ provider: testOnlyCompletionProvider, fs: { ...fs, renameSync: () => { throw new Error('fixture'); } } });
  await expect(review.inspect(request.id)).rejects.toThrow('QUARANTINE_UNWRITABLE');
  expect(f.store.list()[0]).toMatchObject({ state: 'held', inspectionStatus: 'pending' });
  expect(() => f.review().showReviewedContent(request.id)).toThrow('INSPECTION_INCOMPLETE');
});
it('rejects transplanted or unsigned completion receipts on read', async () => {
  const review = f.review({ provider: testOnlyCompletionProvider }), first = f.request(), second = f.request();
  review.hold(first); review.hold(second); await review.inspect(first.id);
  const file = join(f.store.directory, second.id + '.json'), record = f.store.read(second.id)!;
  const receipt = f.store.read(first.id)!.inspectionReceipt!;
  const signed = signPayload({ ...record, state: 'reviewable', inspectionReceipt: receipt }, f.owner);
  fs.writeFileSync(file, JSON.stringify(signed));
  expect(() => review.showReviewedContent(second.id)).toThrow('QUARANTINE_INVALID');
  const unsigned: HeldContentInspection = { ...receipt.payload, recordId: second.id, contentDigest: second.contentDigest, envelopeDigest: digest(second.envelope) };
  const wrong = { ...receipt, payload: unsigned };
  fs.writeFileSync(file, JSON.stringify(signPayload({ ...record, state: 'reviewable', inspectionReceipt: wrong }, f.owner)));
  expect(() => review.showReviewedContent(second.id)).toThrow('QUARANTINE_INVALID');
});
it('never promotes a held record through an owner approval without an inspection receipt', () => {
  const request = f.request(); f.store.hold(request);
  const file = join(f.store.directory, request.id + '.json'), record = f.store.read(request.id)!;
  fs.writeFileSync(file, JSON.stringify(signPayload({ ...record, state: 'reviewable' }, f.owner)));
  expect(() => f.review().showReviewedContent(request.id)).toThrow('QUARANTINE_INVALID');
});
