// SPDX-License-Identifier: Apache-2.0
import type { Json, TaskManifest } from './types.js';
export interface PreCallSizeLimits { maxDiffLines?: number; maxDiffBytes?: number; maxDiffFiles?: number }
/** Explicit owner-selected preset; omitted size caps are unlimited. */
export const TRIAL_REVIEWER_SIZE_LIMITS = Object.freeze({ maxDiffLines: 400, maxDiffBytes: 48 * 1024, maxDiffFiles: 10 });
export interface InputSize { lines: number; bytes: number; files: number }
/** Count all text, including context/headers and every JSON string leaf. Never read peer paths. */
export function measureInput(input: Json): InputSize {
  const serialized = JSON.stringify(input);
  if (serialized === undefined) throw new Error('INPUT_SIZE_UNAVAILABLE');
  let lines = 0, headers = 0, gitHeaders = 0, listedFiles = 0;
  const paths = new Set<string>();
  function walk(value: Json, depth = 0): void {
    if (depth > 64) throw new Error('INPUT_SIZE_UNAVAILABLE');
    if (typeof value === 'string') {
      const rows = value.split(/\r\n|\r|\n/);
      lines += value.length ? rows.length - (rows.at(-1) === '' ? 1 : 0) : 0;
      for (const row of rows) {
        if (row.startsWith('diff --git ')) gitHeaders++;
        if (row.startsWith('+++ ')) headers++;
      }
    } else if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); }
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (key === 'files' && Array.isArray(item)) listedFiles += item.length;
        if (['path', 'file', 'filename', 'filePath'].includes(key) && typeof item === 'string') paths.add(item);
        walk(item, depth + 1);
      }
    }
  }
  walk(input);
  return { lines, bytes: Buffer.byteLength(serialized, 'utf8'),
    files: Math.max(gitHeaders, headers, listedFiles, paths.size, lines ? 1 : 0) };
}
export function checkInputSize(input: Json, limits: PreCallSizeLimits = {}): InputSize | undefined {
  const caps = limits;
  if (Object.values(caps).every(cap => cap === undefined)) return undefined;
  for (const cap of Object.values(caps))
    if (cap !== undefined && (!Number.isSafeInteger(cap) || cap < 1)) throw new Error('INPUT_SIZE_UNAVAILABLE');
  let size: InputSize;
  try { size = measureInput(input); } catch { throw new Error('INPUT_SIZE_UNAVAILABLE'); }
  if (caps.maxDiffLines !== undefined && size.lines > caps.maxDiffLines ||
      caps.maxDiffBytes !== undefined && size.bytes > caps.maxDiffBytes ||
      caps.maxDiffFiles !== undefined && size.files > caps.maxDiffFiles)
    throw new Error('INPUT_SIZE_LIMIT_REACHED');
  return size;
}
/** Exact user message sent by the HTTP adapter; keep preflight and execution identical. */
export function modelInputMessage(manifest: TaskManifest, input: Json): string {
  return 'Return only a JSON deliverable for this task: ' + JSON.stringify({
    title: manifest.task.title, description: manifest.task.description, input, outputSchema: manifest.io.outputSchema,
  });
}
/** UTF-8 bytes conservatively bound text tokens; reserve framing overhead too. Reject, never truncate. */
export function checkModelInputBudget(manifest: TaskManifest, input: Json): void {
  const upperBound = Buffer.byteLength(modelInputMessage(manifest, input), 'utf8') + 256;
  if (!Number.isSafeInteger(manifest.budget.maxInputTokens) || upperBound > manifest.budget.maxInputTokens)
    throw new Error('INPUT_BUDGET_EXCEEDED');
}
