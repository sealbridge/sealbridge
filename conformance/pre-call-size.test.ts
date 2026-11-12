// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { autoAcceptPolicy, checkInputSize, measureInput, checkModelInputBudget, modelInputMessage, schemaRegistry, verifySigned } from '../packages/core/src/index.js';
import { OpenAICompatibleAdapter } from '../packages/adapters/src/openai.js';
import { workerIntakePath } from '../packages/runtime/src/index.js';
import type { AgentTaskContext } from '../packages/runtime/src/index.js';
import { PeerRejectedError } from '../packages/runtime/src/session-audit.js';
import { formatCliError } from '../cli/src/error-messages.js';
import { configCommand } from '../cli/src/config.js';
import { readApplicationConfig } from '../packages/runtime/src/application-config.js';
import { admissionFixture } from './connections-fixture.js';
const fixtures: ReturnType<typeof admissionFixture>[] = [];
afterEach(() => { vi.restoreAllMocks(); fixtures.splice(0).forEach(f => f.cleanup()); });
function fixture() {
  const f = admissionFixture({ autoAccept: { ...autoAcceptPolicy(), from: 'anyone', limits: { maxTasksPerDayPerDid: 1 } } }, true);
  f.worker.options.identityOptions = f.identityOptions;
  Object.assign(f.worker.options.adapter, { taskAccess: 'read-only' });
  fixtures.push(f); return f;
}
it('counts LF, CRLF, CR, trailing newlines, nested text and UTF-8 bytes', () => {
  for (const separator of ['\n', '\r\n', '\r']) {
    expect(checkInputSize(Array(400).fill('x').join(separator) + separator).lines).toBe(400);
    expect(() => checkInputSize(Array(401).fill('x').join(separator))).toThrow('INPUT_SIZE_LIMIT_REACHED');
  }
  expect(measureInput({ diff: '日本語\nx', note: ['y\nz'] }).lines).toBe(4);
  expect(measureInput('日本語').bytes).toBe(9);
  expect(measureInput('').lines).toBe(0);
});
it('enforces inclusive byte and file boundaries without reading paths', () => {
  expect(checkInputSize('x'.repeat(49152)).bytes).toBe(49152);
  expect(() => checkInputSize('x'.repeat(49153))).toThrow('INPUT_SIZE_LIMIT_REACHED');
  const diff = (n: number) => Array.from({ length: n }, (_, i) => `diff --git a/${i} b/${i}\n--- a/${i}\n+++ b/${i}\n+x\n`).join('');
  expect(checkInputSize(diff(10)).files).toBe(10);
  expect(() => checkInputSize(diff(11))).toThrow('INPUT_SIZE_LIMIT_REACHED');
  expect(() => checkInputSize({ files: Array.from({ length: 11 }, (_, i) => ({ path: `file-${i}`, diff: '+x' })) })).toThrow('INPUT_SIZE_LIMIT_REACHED');
  expect(measureInput('--- a\n+++ b\n+x').files).toBe(1);
});
it('fails closed for uncountable input or invalid limits', () => {
  const circular: any = {}; circular.diff = circular;
  expect(() => checkInputSize(circular)).toThrow('INPUT_SIZE_UNAVAILABLE');
  for (const maxDiffLines of [0, -1, NaN, Infinity, 1.5])
    expect(() => checkInputSize('', { maxDiffLines })).toThrow('INPUT_SIZE_UNAVAILABLE');
});
it.each(['lines', 'bytes', 'files'] as const)('rejects oversized %s before execution, owner approval or daily consumption with a signed record', async kind => {
  const f = fixture();
  const input = kind === 'lines' ? 'x\n'.repeat(401) : kind === 'bytes' ? 'x'.repeat(49153)
    : { files: Array.from({ length: 11 }, (_, i) => ({ path: `f${i}`, diff: '+x' })) };
  expect((await f.attempt(f.owner.did, { input }))[0]).toMatchObject({ status: 'rejected', reason: { code: 'INPUT_SIZE_LIMIT_REACHED' } });
  expect(f.execute).not.toHaveBeenCalled(); expect(f.human.approve).not.toHaveBeenCalled();
  const directory = join(dirname(workerIntakePath(f.owner.did, f.identityOptions)), 'pre-call-audit');
  const record = JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]), 'utf8'));
  expect(verifySigned(record, f.owner.did)).toBe(true);
  expect(record.payload).toMatchObject({ event: 'input_size_check', code: 'INPUT_SIZE_LIMIT_REACHED' });
  expect((await f.attempt())[0].status).toBe('fulfilled');
});
it('fails closed when the signed size audit cannot be written', async () => {
  const f = fixture();
  const directory = join(dirname(workerIntakePath(f.owner.did, f.identityOptions)), 'pre-call-audit');
  mkdirSync(directory, { recursive: true });
  const fs = await import('node:fs');
  // A non-directory at the required audit directory is an unavailable destination.
  fs.rmdirSync(directory); fs.writeFileSync(directory, 'blocked');
  expect((await f.attempt())[0]).toMatchObject({ status: 'rejected', reason: { code: 'INPUT_SIZE_UNAVAILABLE' } });
  expect(f.execute).not.toHaveBeenCalled();
});
it('also rejects oversized work when automatic admission is disabled', async () => {
  const f = fixture(); f.worker.autoAccept.enabled = false;
  expect((await f.attempt(f.worker.invite(), { input: 'x\n'.repeat(401) }))[0])
    .toMatchObject({ status: 'rejected', reason: { code: 'INPUT_SIZE_LIMIT_REACHED' } });
  expect(f.execute).not.toHaveBeenCalled(); expect(f.human.approve).not.toHaveBeenCalled();
});
it('persists size settings, preserves other limits and keeps advertised schemas closed', async () => {
  const f = fixture(); vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const [key, n] of [['max-diff-lines', '500'], ['max-diff-bytes', '49152'], ['max-diff-files', '10']])
    await configCommand(['auto-accept', key, n], f.identityOptions);
  const policy = readApplicationConfig(f.identityOptions).autoAccept!;
  expect(policy.limits).toMatchObject({ maxDiffLines: 500, maxDiffBytes: 49152, maxDiffFiles: 10 });
  f.worker.autoAccept.limits.maxDiffLines = 500;
  f.worker.agentCard.payload.autoAccept!.limits.maxDiffLines = 500;
  expect(schemaRegistry().getSchema('agent-card')!(f.worker.agentCard)).toBe(true);
  expect((await f.attempt(f.owner.did, { input: 'x\n'.repeat(401) }))[0].status).toBe('fulfilled');
  await configCommand(['auto-accept', 'max-diff-lines', 'default'], f.identityOptions);
  expect(readApplicationConfig(f.identityOptions).autoAccept!.limits.maxDiffLines).toBeUndefined();
  expect(() => autoAcceptPolicy({ ...policy, limits: { maxDiffLines: 0 } })).toThrow();
  f.worker.agentCard.payload.autoAccept!.limits = { extra: 1 } as never;
  expect(schemaRegistry().getSchema('agent-card')!(f.worker.agentCard)).toBe(false);
});
it.each(['openai', 'anthropic'] as const)('bounds the complete %s prompt before fetch, including understated budgets', async apiStyle => {
  const f = fixture(); const fetcher = vi.fn(async () => Response.json({ choices: [{ message: { content: '{}' } }],
    content: [{ type: 'text', text: '{}' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  const adapter = new OpenAICompatibleAdapter({ model: 'gpt-6-luna', apiStyle, fetch: fetcher });
  const m = f.manifest(); const input = { diff: '+small' };
  const minimum = Buffer.byteLength(modelInputMessage(m, input)) + 256;
  m.budget.maxInputTokens = minimum - 1;
  const context = { manifest: m, input, signal: new AbortController().signal, reportUsage: vi.fn() } as unknown as AgentTaskContext;
  await expect(adapter.executeTask(context)).rejects.toThrow('INPUT_SIZE_LIMIT_REACHED');
  expect(fetcher).not.toHaveBeenCalled();
  m.budget.maxInputTokens = minimum;
  expect(() => checkModelInputBudget(m, input)).not.toThrow();
  await adapter.executeTask(context); expect(fetcher).toHaveBeenCalledTimes(1);
  m.task.description = 'x'.repeat(minimum);
  await expect(adapter.executeTask(context)).rejects.toThrow('INPUT_SIZE_LIMIT_REACHED');
  expect(fetcher).toHaveBeenCalledTimes(1);
  m.task.description = 'small';
  m.io.outputSchema = { description: 'x'.repeat(minimum) };
  await expect(adapter.executeTask(context)).rejects.toThrow('INPUT_SIZE_LIMIT_REACHED');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('checks the actual HTTP prompt before monthly accounting and rejects tiny declared budgets', async () => {
  const f = fixture(); const fetcher = vi.fn();
  f.worker.options.adapter = new OpenAICompatibleAdapter({ model: 'gpt-6-luna', fetch: fetcher });
  f.worker.autoAccept.limits.maxMonthlyUsd = 20;
  expect((await f.attempt(f.owner.did, { budget: { maxInputTokens: 1 }, input: { diff: '+small' } }))[0])
    .toMatchObject({ status: 'rejected', reason: { code: 'INPUT_SIZE_LIMIT_REACHED' } });
  expect(fetcher).not.toHaveBeenCalled();
  expect(readdirSync(dirname(workerIntakePath(f.owner.did, f.identityOptions)))).not.toContain('auto-accept-monthly.jsonl');
});
it.each(['INPUT_SIZE_LIMIT_REACHED', 'INPUT_SIZE_UNAVAILABLE', 'MONTHLY_MODEL_UNSUPPORTED'])('projects only fixed bilingual requester text for %s', code => {
  const clean = new PeerRejectedError({ code });
  const malicious = new PeerRejectedError({ code, reason: 'EVIL', detail: { hint: 'EVIL' }, resetAt: 'EVIL', extra: 'EVIL' });
  expect(malicious.message).toBe(clean.message);
  expect(formatCliError(malicious)).not.toContain('EVIL');
  if (code === 'INPUT_SIZE_LIMIT_REACHED') {
    expect(clean.message).toContain('Split it into smaller parts.');
    expect(clean.message).toContain('小さく分けて送ってください。');
  }
});
