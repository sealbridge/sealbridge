// SPDX-License-Identifier: Apache-2.0
/** Status-only send failures; response text is never included in diagnostics. */
export class RelayAdmissionError extends Error {
  readonly code = 'RELAY_RETRY_LATER';
  constructor(readonly status: number, readonly retryAfterMs?: number) {
    super('RELAY_REJECTED: ' + status);
    this.name = 'RelayAdmissionError';
  }
}
export class RelayDuplicateEnvelopeError extends Error {
  readonly code = 'REPLAYED_ENVELOPE';
  constructor(readonly status = 400) { super('RELAY_REJECTED: ' + status); this.name = 'RelayDuplicateEnvelopeError'; }
}

/** Decode at most 1 KiB and only the two documented admission responses. */
export async function decodeAdmissionError(response: Response): Promise<Error> {
  let value: Record<string, unknown> | undefined;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 1024) break;
        chunks.push(part.value);
      }
      if (size <= 1024) {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
      }
    } catch { /* Malformed responses retain status-only behavior. */ }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  if (response.status === 400 && value?.error === 'REPLAYED_ENVELOPE' &&
      Object.keys(value).join(',') === 'error') return new RelayDuplicateEnvelopeError();
  if (response.status === 429) {
    const hint = value?.error === 'RELAY_RETRY_LATER' && value.retryable === true &&
      Object.keys(value).sort().join(',') === 'error,retryAfterMs,retryable' &&
      Number.isSafeInteger(value.retryAfterMs) && Number(value.retryAfterMs) > 0 && Number(value.retryAfterMs) <= 3_600_000
      ? Number(value.retryAfterMs) : undefined;
    return new RelayAdmissionError(429, hint);
  }
  return new Error('RELAY_REJECTED: ' + response.status);
}
