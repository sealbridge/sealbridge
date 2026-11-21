// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { verifySigned, type Signed } from '@acp/core/edge';
import type { InviteNamespace, InviteStorage } from './invites.js';

const headers = {
  'cache-control': 'no-store',
  'access-control-allow-origin': 'https://sealbridge.app',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'referrer-policy': 'no-referrer',
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
const hash = (s: string) => createHash('sha256').update(s).digest('base64url');
interface Mailbox {
  id: string;
  ownerDid: string;
  expiresAt: number;
  accessHash: string;
  resultsAccessHash: string;
  request: string;
  results: string[];
}
async function body(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error();
  let size = 0;
  const chunks: Uint8Array[] = [];
  const timeout = setTimeout(() => {
    void reader.cancel().catch(() => {});
  }, 10000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) throw new Error();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  } finally {
    clearTimeout(timeout);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Opaque, bounded ten-minute mailbox. The relay never receives a decrypting key. */
export class ApprovalDurableObject {
  private turn: Promise<unknown> = Promise.resolve();
  constructor(private state: { storage: InviteStorage & { deleteAll(): Promise<void> } }) {}
  fetch(request: Request): Promise<Response> {
    const next = this.turn.then(() => this.handle(request));
    this.turn = next.catch(() => undefined);
    return next;
  }
  alarm(): Promise<void> {
    const next = this.turn.then(() => this.state.storage.deleteAll());
    this.turn = next.catch(() => undefined);
    return next;
  }
  private async handle(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const match = /^\/v1\/approvals\/([a-f0-9]{64})(\/results)?$/.exec(
      new URL(request.url).pathname,
    );
    if (!match) return json({ error: 'APPROVAL_UNAVAILABLE' }, 404);
    try {
      let box = await this.state.storage.get<Mailbox>('mailbox');
      if (request.method === 'POST' && !match[2]) {
        const signed = (await body(request)) as Signed<Omit<Mailbox, 'results'>>;
        const p = signed.payload;
        if (
          box ||
          !p ||
          p.id !== match[1] ||
          !verifySigned(signed, p.ownerDid) ||
          !Number.isSafeInteger(p.expiresAt) ||
          p.expiresAt <= Date.now() ||
          p.expiresAt > Date.now() + 600_000 ||
          !/^[\w-]{43}$/.test(p.accessHash) ||
          !/^[\w-]{43}$/.test(p.resultsAccessHash) ||
          typeof p.request !== 'string' ||
          p.request.length > 1_500_000
        )
          throw new Error();
        box = { ...p, results: [] };
        await this.state.storage.put('mailbox', box);
        await this.state.storage.setAlarm?.(p.expiresAt);
        return json({ created: true }, 201);
      }
      if (!box || box.expiresAt <= Date.now()) return json({ error: 'APPROVAL_EXPIRED' }, 410);
      const access = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      if (request.method === 'DELETE' && match[2]) {
        if (hash(access) !== box.resultsAccessHash)
          return json({ error: 'APPROVAL_UNAVAILABLE' }, 404);
        const value = (await body(request)) as { digests?: unknown };
        if (
          !Array.isArray(value.digests) ||
          value.digests.length > 16 ||
          value.digests.some((d) => typeof d !== 'string')
        )
          throw new Error();
        const digests = value.digests;
        box.results = box.results.filter((ciphertext) => !digests.includes(hash(ciphertext)));
        if (box.expiresAt <= Date.now()) return json({ error: 'APPROVAL_EXPIRED' }, 410);
        await this.state.storage.put('mailbox', box);
        return json({ removed: true });
      }
      if (hash(access) !== box.accessHash) return json({ error: 'APPROVAL_UNAVAILABLE' }, 404);
      if (request.method === 'GET')
        return json(match[2] ? { results: box.results } : { request: box.request });
      if (request.method === 'POST' && match[2]) {
        const result = (await body(request)) as { result?: unknown };
        if (box.expiresAt <= Date.now()) return json({ error: 'APPROVAL_EXPIRED' }, 410);
        if (typeof result.result !== 'string' || result.result.length > 24000) throw new Error();
        if (!box.results.includes(result.result)) {
          // A bounded rolling queue never locks out a later valid decision.
          box.results.push(result.result);
          box.results = box.results.slice(-16);
          await this.state.storage.put('mailbox', box);
        }
        return json({ delivered: true });
      }
      return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
    } catch {
      return json({ error: 'INVALID_APPROVAL_REQUEST' }, 400);
    }
  }
}
export function routeApproval(request: Request, namespace: InviteNamespace): Promise<Response> {
  const id = /^\/v1\/approvals\/([a-f0-9]{64})(?:\/results)?$/.exec(
    new URL(request.url).pathname,
  )?.[1];
  if (!id) return Promise.resolve(json({ error: 'APPROVAL_UNAVAILABLE' }, 404));
  return namespace.get(namespace.idFromName(id)).fetch(request);
}
export function createMemoryApprovalHandler() {
  const objects = new Map<string, { object: ApprovalDurableObject; expires: number }>();
  return (request: Request) =>
    routeApproval(request, {
      idFromName: (name) => name,
      get(id) {
        for (const [key, entry] of objects) if (entry.expires < Date.now()) objects.delete(key);
        const key = String(id);
        let entry = objects.get(key);
        if (!entry) {
          if (objects.size >= 1000)
            return { fetch: async () => json({ error: 'APPROVAL_CAPACITY' }, 429) };
          let saved: unknown;
          entry = {
            expires: Date.now() + 600_000,
            object: new ApprovalDurableObject({
              storage: {
                get: async <T>() => saved as T,
                deleteAll: async () => {
                  saved = undefined;
                },
                put: async (_key, value) => {
                  saved = structuredClone(value);
                },
              },
            }),
          };
          objects.set(key, entry);
        }
        return entry.object;
      },
    });
}
