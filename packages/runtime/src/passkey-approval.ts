// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
  ownerApprovalChallenge,
  ownerApprovalBinding,
  digest,
  signPayload,
  verifySigned,
  signApproval,
} from '@acp/core';
import type { KeyPair } from '@acp/core';
import { HttpRelayClient } from '@acp/relay';
import { acquireDailyLock } from './daily-limit.js';
import {
  resolveDataRoot,
  privateDirectory,
  readPrivateFile,
  writePrivateFile,
} from './local-identity.js';
import type { LocalIdentityOptions } from './local-identity.js';
import { DEFAULT_PASSKEY_INPUT_BYTES } from './auto-accept.js';
import { workerIntakePath } from './worker-trust-store.js';
import { tokenCost, MonthlyCostCounter } from './monthly-limit.js';
import type { ApprovalProvider, ApprovalRequest } from './approval-providers.js';
export const NO_PASSKEY_MESSAGE =
  'No passkey is registered yet. Write tasks cannot be approved. Register within 10 minutes of worker startup; restart the worker if that window has closed.';
export const ENROLLMENT_WINDOW_MS = 10 * 60 * 1000;
export const APPROVAL_SITE = 'https://sealbridge.app';
export const DEFAULT_APPROVAL_SIZE = DEFAULT_PASSKEY_INPUT_BYTES;
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('base64url');
export const approvalChallenge = ownerApprovalChallenge;
export function encryptApproval(key: Buffer, id: string, value: unknown): string {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(id));
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}
export function decryptApproval(key: Buffer, id: string, value: string): unknown {
  const bytes = Buffer.from(value, 'base64url');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(id));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
}
interface Credential {
  id: string;
  publicKey: string;
  counter: number;
}
interface Registry {
  version: 1;
  ownerDid: string;
  credentials: Credential[];
  consumed: { id: string; expiresAt: number }[];
}
export interface ApprovalLink {
  id: string;
  taskId: string;
  gate: string;
  link: string;
  expiresAt: number;
  kind: 'task' | 'registration';
}
interface Pending extends ApprovalLink {
  key: string;
  access: string;
  targetDigest: string;
  challenge: string;
  binding: string;
  enrollmentId?: string;
  resultsAccess: string;
}
export interface PasskeyOptions extends LocalIdentityOptions {
  paid?: { model: string; maxMonthlyUsd?: number };
  relay: string;
  fetch?: typeof fetch;
  allowPrivateRelay?: boolean;
  site?: string;
  onLink?: (link: ApprovalLink) => void;
  onEnrollment?: (state: ReturnType<PasskeyApprovalBroker['enrollmentStatus']>) => void;
  onRegistered?: (credentialId: string) => void;
}
/** Local owner-signed trust store. Link possession and relay data never grant authority. */
export class PasskeyApprovalBroker {
  readonly directory: string;
  readonly site: string;
  readonly rpID: string;
  private fetcher: typeof fetch;
  private enrollmentId?: string;
  private registrationWatch?: ReturnType<typeof setInterval>;
  private observedCredentials = new Set<string>();
  constructor(
    readonly owner: KeyPair,
    readonly options: PasskeyOptions,
  ) {
    this.site = options.site ?? APPROVAL_SITE;
    const site = new URL(this.site);
    if (site.origin !== this.site || site.protocol !== 'https:')
      throw new Error('INVALID_APPROVAL_SITE');
    this.rpID = site.hostname;
    this.directory = join(resolveDataRoot(options), 'passkeys', hash(owner.did));
    privateDirectory(this.directory, fs, options.platform);
    this.fetcher = new HttpRelayClient(options.relay, options.fetch ?? fetch, {
      allowPrivateRelay: options.allowPrivateRelay,
    }).fetcher;
  }
  private load<T>(name: string): T | undefined {
    const path = join(this.directory, name);
    if (!fs.existsSync(path)) return undefined;
    try {
      const signed = JSON.parse(
        readPrivateFile(path, fs, 2 * 1024 * 1024, this.options.platform)!.toString(),
      );
      if (!verifySigned(signed, this.owner.did)) throw new Error();
      return signed.payload;
    } catch {
      throw new Error('PASSKEY_STATE_INVALID');
    }
  }
  private save(name: string, value: unknown): void {
    const path = join(this.directory, name),
      temp = path + '.' + randomBytes(12).toString('hex');
    try {
      writePrivateFile(
        temp,
        Buffer.from(JSON.stringify(signPayload(value, this.owner))),
        fs,
        this.options.platform,
      );
      fs.renameSync(temp, path);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  private registry(): Registry {
    const r = this.load<Registry>('registry.json') ?? {
      version: 1,
      ownerDid: this.owner.did,
      credentials: [],
      consumed: [],
    };
    if (
      r.version !== 1 ||
      r.ownerDid !== this.owner.did ||
      !Array.isArray(r.credentials) ||
      !Array.isArray(r.consumed)
    )
      throw new Error('PASSKEY_STATE_INVALID');
    if (!r.credentials.length && this.load('enrolled.json'))
      throw new Error('PASSKEY_STATE_INVALID');
    return r;
  }
  /** Called by the worker startup path only, never by MCP/CLI link creation. */
  startWorkerEnrollment(): void {
    if (this.registrationWatch) clearInterval(this.registrationWatch);
    const release = acquireDailyLock(join(this.directory, 'registry.lock'));
    try {
      const credentials = this.listCredentials();
      this.observedCredentials = new Set(credentials.map((c) => c.id));
      if (credentials.length && !this.load('enrolled.json'))
        this.save('enrolled.json', { registered: true });
      if (!credentials.length) {
        this.enrollmentId = randomBytes(32).toString('hex');
        const startedAt = Date.now();
        this.save('enrollment.json', {
          id: this.enrollmentId,
          startedAt,
          expiresAt: startedAt + ENROLLMENT_WINDOW_MS,
          pid: process.pid,
        });
      }
    } finally {
      release();
    }
    this.registrationWatch = setInterval(() => {
      try {
        this.checkRegistrationNotices();
      } catch {
        /* Local store failure never grants authority. */
      }
    }, 1000);
    this.registrationWatch.unref();
    this.options.onEnrollment?.(this.enrollmentStatus());
  }
  stopWorkerEnrollment(): void {
    if (this.registrationWatch) {
      this.checkRegistrationNotices();
      clearInterval(this.registrationWatch);
      this.registrationWatch = undefined;
    }
    const window = this.load<{ id: string; expiresAt: number }>('enrollment.json');
    if (this.enrollmentId && window?.id === this.enrollmentId)
      this.save('enrollment.json', { ...window, expiresAt: 0 });
    this.enrollmentId = undefined;
  }
  checkRegistrationNotices(): void {
    if (!this.registrationWatch) return;
    for (const { id } of this.listCredentials())
      if (!this.observedCredentials.has(id)) {
        this.observedCredentials.add(id);
        try {
          this.options.onRegistered?.(id);
        } catch {
          /* A notice is not an approval channel. */
        }
      }
  }
  enrollmentStatus(): {
    registered: boolean;
    open: boolean;
    expiresAt?: number;
    message?: string;
    id?: string;
  } {
    if (this.listCredentials().length) return { registered: true, open: false };
    const window = this.load<{ id: string; startedAt: number; expiresAt: number; pid: number }>(
      'enrollment.json',
    );
    let alive = false;
    if (window && Number.isSafeInteger(window.pid) && window.pid > 0) {
      try {
        process.kill(window.pid, 0);
        alive = true;
      } catch {
        /* A stopped worker cannot enroll a first key. */
      }
    }
    const open =
      !!window &&
      alive &&
      Number.isSafeInteger(window.startedAt) &&
      window.startedAt <= Date.now() &&
      window.expiresAt === window.startedAt + ENROLLMENT_WINDOW_MS &&
      window.expiresAt > Date.now();
    return {
      registered: false,
      open,
      message: NO_PASSKEY_MESSAGE,
      ...(open ? { id: window!.id, expiresAt: window!.expiresAt } : {}),
    };
  }
  private assertEnrollment(id?: string): void {
    const state = this.enrollmentStatus();
    if (!state.open || (id !== undefined && state.id !== id))
      throw new Error('PASSKEY_ENROLLMENT_CLOSED: ' + NO_PASSKEY_MESSAGE);
  }
  listCredentials(): { id: string }[] {
    return this.registry().credentials.map(({ id }) => ({ id }));
  }
  listPending(): ApprovalLink[] {
    return fs
      .readdirSync(this.directory)
      .filter((n) => /^[a-f0-9]{64}\.json$/.test(n))
      .flatMap((n) => {
        const p = this.load<Pending>(n);
        if (p && (p.id !== n.slice(0, -5) || !Number.isSafeInteger(p.expiresAt)))
          throw new Error('PASSKEY_STATE_INVALID');
        if (p && p.expiresAt <= Date.now()) {
          // Only verified, locally generated ceremony records are reclaimed.
          for (const file of [n, p.id + '.decision.json']) {
            if (this.load(file) !== undefined) {
              try {
                fs.unlinkSync(join(this.directory, file));
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              }
            }
          }
          return [];
        }
        if (p?.kind === 'registration' && p.enrollmentId) {
          const state = this.enrollmentStatus();
          if (state.registered || !state.open || state.id !== p.enrollmentId) return [];
        }
        return p &&
          p.expiresAt > Date.now() &&
          !fs.existsSync(join(this.directory, p.id + '.decision.json'))
          ? [
              {
                id: p.id,
                taskId: p.taskId,
                gate: p.gate,
                link: p.link,
                expiresAt: p.expiresAt,
                kind: p.kind,
              },
            ]
          : [];
      });
  }
  private async http(
    id: string,
    suffix: string,
    method: string,
    access?: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetcher(this.options.relay + '/v1/approvals/' + id + suffix, {
      method,
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
      headers: {
        ...(access ? { authorization: 'Bearer ' + access } : {}),
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('APPROVAL_RELAY_UNAVAILABLE');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('INVALID_APPROVAL_RESPONSE');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 400000) throw new Error('INVALID_APPROVAL_RESPONSE');
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString());
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  private async create(
    kind: Pending['kind'],
    taskId: string,
    gate: string,
    target: unknown,
    details: unknown,
    deadline: number,
  ): Promise<ApprovalLink> {
    const until = Math.min(deadline, Date.now() + 15000);
    let release: (() => void) | undefined;
    while (!release) {
      try {
        release = acquireDailyLock(join(this.directory, 'pending.lock'));
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.startsWith('DAILY_LIMIT_BUSY') ||
          Date.now() >= until
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    try {
      return await this.createLocked(kind, taskId, gate, target, details, deadline);
    } finally {
      release();
    }
  }
  private async createLocked(
    kind: Pending['kind'],
    taskId: string,
    gate: string,
    target: unknown,
    details: unknown,
    deadline: number,
  ): Promise<ApprovalLink> {
    const enrollment =
      kind === 'registration' && !this.listCredentials().length
        ? this.enrollmentStatus()
        : undefined;
    if (enrollment) this.assertEnrollment();
    const expiresAt = Math.min(deadline, Date.now() + 600000, enrollment?.expiresAt ?? Infinity);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('APPROVAL_EXPIRED');
    const pendingLinks = this.listPending();
    const existing = pendingLinks.find((link) => {
      const p = this.load<Pending>(link.id + '.json');
      return (
        p?.kind === kind &&
        p.taskId === taskId &&
        p.gate === gate &&
        p.targetDigest === digest(target) &&
        (kind !== 'registration' || p.enrollmentId === enrollment?.id)
      );
    });
    if (existing) return existing;
    if (pendingLinks.length >= 128) throw new Error('APPROVAL_CAPACITY');
    const key = randomBytes(32),
      id = randomBytes(32).toString('hex'),
      access = hash(Buffer.concat([key, Buffer.from('access')])),
      resultsAccess = randomBytes(32).toString('base64url');
    const credentials = this.listCredentials();
    const content = {
      version: 1,
      id,
      kind,
      taskId,
      gate,
      target,
      targetDigest: digest(target),
      details: details ?? null,
      expiresAt,
      ownerDid: this.owner.did,
      rpID: this.rpID,
      credentials,
      ...(!credentials.length
        ? {
            enrollmentExpiresAt: enrollment?.expiresAt ?? null,
            noPasskeyMessage: NO_PASSKEY_MESSAGE,
          }
        : {}),
    };
    const binding = ownerApprovalBinding(content),
      challenge = approvalChallenge(id, 'approve', binding);
    const registration =
      kind === 'registration'
        ? await (
            await import('@simplewebauthn/server')
          ).generateRegistrationOptions({
            rpName: 'Sealbridge owner approval',
            rpID: this.rpID,
            userID: Buffer.from(hash(this.owner.did)),
            userName: this.owner.did,
            challenge: Buffer.from(challenge, 'base64url'),
            attestationType: 'none',
            supportedAlgorithmIDs: [-7, -257],
            authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
            excludeCredentials: credentials,
          })
        : undefined;
    const request = { ...content, challenge, registration };
    await this.http(
      id,
      '',
      'POST',
      undefined,
      signPayload(
        {
          id,
          ownerDid: this.owner.did,
          expiresAt,
          accessHash: hash(access),
          resultsAccessHash: hash(resultsAccess),
          request: encryptApproval(key, id, request),
        },
        this.owner,
      ),
    );
    const fragment = new URLSearchParams({
      id,
      key: key.toString('base64url'),
      relay: this.options.relay,
    });
    const pending: Pending = {
      id,
      kind,
      taskId,
      gate,
      targetDigest: digest(target),
      challenge,
      binding,
      expiresAt,
      key: key.toString('base64url'),
      access,
      resultsAccess,
      ...(enrollment ? { enrollmentId: enrollment.id } : {}),
      link: this.site + '/approve#' + fragment.toString(),
    };
    this.save(id + '.json', pending);
    this.options.onLink?.({ id, kind, taskId, gate, expiresAt, link: pending.link });
    return { id, kind, taskId, gate, expiresAt, link: pending.link };
  }
  requestRegistration(): Promise<ApprovalLink> {
    return this.create(
      'registration',
      'passkey-registration',
      'register',
      {},
      {
        reason: this.listCredentials().length
          ? 'An existing passkey must approve this additional passkey.'
          : NO_PASSKEY_MESSAGE + ' An agent acting within this window can still register first.',
      },
      Date.now() + 600000,
    );
  }
  requestApproval(request: ApprovalRequest): Promise<ApprovalLink> {
    const details = request.details as
      | {
          manifest?: {
            deadline?: string;
            budget?: { maxInputTokens: number; maxOutputTokens: number };
          };
        }
      | undefined;
    let paidDetails: unknown;
    if (this.options.paid) {
      let maximumUsd: number | null = null;
      try {
        const budget = details?.manifest?.budget;
        if (budget)
          maximumUsd =
            tokenCost(this.options.paid.model, budget.maxInputTokens, budget.maxOutputTokens) / 1e9;
      } catch {
        /* Unknown prices require explicit review. */
      }
      paidDetails = {
        model: this.options.paid.model || 'custom endpoint; price unknown',
        maxMonthlyUsd: this.options.paid.maxMonthlyUsd ?? null,
        maximumUsd,
        accounting:
          'Maximum token budgets are charged to the automatic allowance; explicit passkey approval can exceed that allowance.',
      };
    }
    return this.create(
      'task',
      request.taskId,
      request.gate,
      request.target,
      paidDetails ? { ...(details ?? {}), paidBudget: paidDetails } : request.details,
      Date.parse(
        request.deadline ??
          details?.manifest?.deadline ??
          new Date(Date.now() + 600000).toISOString(),
      ),
    );
  }
  private async assertion(
    response: AuthenticationResponseJSON,
    challenge: string,
    registry: Registry,
  ): Promise<void> {
    this.sameOrigin(response.response.clientDataJSON);
    const credential = registry.credentials.find((c) => c.id === response?.id);
    if (!credential) throw new Error('PASSKEY_NOT_REGISTERED');
    const result = await (
      await import('@simplewebauthn/server')
    ).verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.site,
      expectedRPID: this.rpID,
      requireUserVerification: true,
      credential: { ...credential, publicKey: Buffer.from(credential.publicKey, 'base64url') },
    });
    if (!result.verified) throw new Error('PASSKEY_INVALID');
    credential.counter = result.authenticationInfo.newCounter;
  }
  private sameOrigin(clientDataJSON: string): void {
    const data = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString());
    if (data.crossOrigin === true || data.topOrigin !== undefined)
      throw new Error('PASSKEY_CROSS_ORIGIN');
  }
  /** Commit replay consumption before producing an owner signature. */
  async acceptResult(
    id: string,
    ciphertext: string,
  ): Promise<'approved' | 'rejected' | 'registered'> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('INVALID_APPROVAL_ID');
    const release = acquireDailyLock(join(this.directory, 'registry.lock'));
    try {
      const p = this.load<Pending>(id + '.json');
      if (!p || p.expiresAt <= Date.now()) throw new Error('APPROVAL_EXPIRED');
      const registry = this.registry();
      if (registry.consumed.some((c) => c.id === id)) throw new Error('APPROVAL_REPLAY');
      const value = decryptApproval(Buffer.from(p.key, 'base64url'), id, ciphertext) as {
        id: string;
        decision: 'approve' | 'reject';
        assertion?: AuthenticationResponseJSON;
        registration?: RegistrationResponseJSON;
      };
      if (value.id !== id || !['approve', 'reject'].includes(value.decision))
        throw new Error('APPROVAL_BINDING_MISMATCH');
      if (p.kind === 'registration') {
        if (!registry.credentials.length) {
          if (!p.enrollmentId) throw new Error('PASSKEY_ENROLLMENT_CLOSED');
          this.assertEnrollment(p.enrollmentId);
        }
        if (value.decision !== 'approve' || !value.registration) throw new Error('PASSKEY_INVALID');
        this.sameOrigin(value.registration.response.clientDataJSON);
        const registered = await (
          await import('@simplewebauthn/server')
        ).verifyRegistrationResponse({
          response: value.registration,
          expectedChallenge: p.challenge,
          expectedOrigin: this.site,
          expectedRPID: this.rpID,
          requireUserVerification: true,
          supportedAlgorithmIDs: [-7, -257],
        });
        if (!registered.verified || !registered.registrationInfo)
          throw new Error('PASSKEY_INVALID');
        if (registry.credentials.length) {
          if (!value.assertion) throw new Error('EXISTING_PASSKEY_APPROVAL_REQUIRED');
          await this.assertion(
            value.assertion,
            approvalChallenge(
              id,
              'register:' + hash(JSON.stringify(value.registration)),
              p.binding,
            ),
            registry,
          );
        }
        if (!registry.credentials.length) {
          if (!p.enrollmentId) throw new Error('PASSKEY_ENROLLMENT_CLOSED');
          this.assertEnrollment(p.enrollmentId);
        }
        const c = registered.registrationInfo.credential;
        if (registry.credentials.some((k) => k.id === c.id))
          throw new Error('PASSKEY_ALREADY_REGISTERED');
        registry.credentials.push({
          id: c.id,
          publicKey: Buffer.from(c.publicKey).toString('base64url'),
          counter: c.counter,
        });
      } else {
        if (!value.assertion) throw new Error('PASSKEY_REQUIRED');
        await this.assertion(
          value.assertion,
          approvalChallenge(id, value.decision, p.binding),
          registry,
        );
      }
      if (p.expiresAt <= Date.now()) throw new Error('APPROVAL_EXPIRED');
      registry.consumed = registry.consumed.filter((c) => c.expiresAt > Date.now());
      registry.consumed.push({ id, expiresAt: p.expiresAt });
      if (p.kind === 'registration') {
        this.save('enrolled.json', { registered: true });
        const window = this.load<{ id: string }>('enrollment.json');
        if (window) this.save('enrollment.json', { ...window, expiresAt: 0 });
      }
      this.save('registry.json', registry);
      if (p.kind === 'registration') this.checkRegistrationNotices();
      this.save(id + '.decision.json', {
        id,
        taskId: p.taskId,
        targetDigest: p.targetDigest,
        decision: value.decision,
        expiresAt: p.expiresAt,
      });
      return p.kind === 'registration'
        ? 'registered'
        : value.decision === 'approve'
          ? 'approved'
          : 'rejected';
    } finally {
      release();
    }
  }
  async poll(
    id: string,
    signal?: AbortSignal,
  ): Promise<'approved' | 'rejected' | 'registered' | undefined> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('INVALID_APPROVAL_ID');
    const p = this.load<Pending>(id + '.json');
    if (!p || p.expiresAt <= Date.now()) throw new Error('APPROVAL_EXPIRED');
    const decision = this.load<{ decision: string }>(id + '.decision.json');
    if (decision)
      return p.kind === 'registration'
        ? 'registered'
        : decision.decision === 'approve'
          ? 'approved'
          : 'rejected';
    const result = await this.http(id, '/results', 'GET', p.access, undefined, signal);
    if (!Array.isArray(result.results)) throw new Error('INVALID_APPROVAL_RESPONSE');
    const invalid: string[] = [];
    for (const ciphertext of result.results.slice(0, 16)) {
      try {
        return await this.acceptResult(id, ciphertext);
      } catch {
        invalid.push(hash(String(ciphertext)));
        /* Invalid results never unblock work. */
      }
    }
    if (invalid.length)
      await this.http(
        id,
        '/results',
        'DELETE',
        p.resultsAccess,
        { digests: invalid },
        signal,
      ).catch(() => {});
    return undefined;
  }
  async wait(id: string, signal?: AbortSignal): Promise<'approved' | 'rejected' | 'registered'> {
    for (;;) {
      signal?.throwIfAborted();
      const result = await this.poll(id, signal);
      if (result) return result;
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          reject(signal?.reason);
        };
        const timer = setTimeout(done, 1000);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
  async approve(request: ApprovalRequest) {
    request.signal?.throwIfAborted();
    const deadline =
      request.deadline ??
      (request.details as { manifest?: { deadline?: string } } | undefined)?.manifest?.deadline;
    const assertLive = () => {
      request.signal?.throwIfAborted();
      if (
        deadline &&
        (!Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) <= Date.now())
      )
        throw new Error('APPROVAL_EXPIRED');
    };
    assertLive();
    if (this.reservePaid(request)) {
      assertLive();
      return signApproval(request.taskId, request.gate, request.target, this.owner);
    }
    if (!this.listCredentials().length) {
      const registration = await this.requestRegistration();
      await this.wait(registration.id, request.signal);
    }
    const link = await this.requestApproval(request);
    const result = await this.wait(link.id, request.signal);
    if (result !== 'approved') throw new Error('OWNER_APPROVAL_REJECTED');
    const p = this.load<Pending>(link.id + '.json')!;
    if (
      p.taskId !== request.taskId ||
      p.targetDigest !== digest(request.target) ||
      p.expiresAt <= Date.now()
    )
      throw new Error('APPROVAL_BINDING_MISMATCH');
    assertLive();
    this.recordPaidApproval(request);
    assertLive();
    return signApproval(request.taskId, request.gate, request.target, this.owner);
  }
  private reservePaid(request: ApprovalRequest): boolean {
    const paid = this.options.paid;
    const details = request.details as
      | {
          input?: unknown;
          manifest?: {
            permissions?: { maxDelegationDepth: number; grantedCapabilities: unknown[] };
            verification?: { checks?: unknown[] };
            contextGrant?: unknown;
            budget?: { maxInputTokens: number; maxOutputTokens: number };
          };
        }
      | undefined;
    const manifest = details?.manifest;
    if (
      request.gate !== 'contract_acceptance' ||
      !paid?.maxMonthlyUsd ||
      !manifest?.budget ||
      manifest.contextGrant ||
      manifest.permissions?.maxDelegationDepth !== 0 ||
      manifest.permissions.grantedCapabilities.length ||
      manifest.verification?.checks?.length ||
      Buffer.byteLength(JSON.stringify(details?.input ?? null)) > DEFAULT_APPROVAL_SIZE
    )
      return false;
    try {
      tokenCost(paid.model, manifest.budget.maxInputTokens, manifest.budget.maxOutputTokens);
    } catch {
      return false;
    }
    const release = acquireDailyLock(join(this.directory, 'paid.lock'));
    try {
      const uncertain = this.load<{ month: string }>('paid-uncertain.json');
      if (uncertain?.month === new Date().toISOString().slice(0, 7)) return false;
      try {
        return this.paidCounter().reserveMaximum(
          paid.maxMonthlyUsd,
          request.taskId,
          paid.model,
          manifest.budget,
        );
      } catch (error) {
        if (error instanceof Error && error.message === 'MONTHLY_TASK_REPLAY')
          throw new Error('PAID_TASK_REPLAY');
        throw error;
      }
    } finally {
      release();
    }
  }
  private paidCounter(): MonthlyCostCounter {
    return new MonthlyCostCounter(
      join(dirname(workerIntakePath(this.owner.did, this.options)), 'auto-accept-monthly.jsonl'),
      this.owner,
    );
  }
  private recordPaidApproval(request: ApprovalRequest): void {
    const paid = this.options.paid;
    const details = request.details as
      { manifest?: { budget?: { maxInputTokens: number; maxOutputTokens: number } } } | undefined;
    if (!paid || request.gate !== 'contract_acceptance') return;
    const release = acquireDailyLock(join(this.directory, 'paid.lock'));
    try {
      const budget = details?.manifest?.budget;
      if (!budget) {
        this.save('paid-uncertain.json', { month: new Date().toISOString().slice(0, 7) });
        return;
      }
      try {
        tokenCost(paid.model, budget.maxInputTokens, budget.maxOutputTokens);
      } catch {
        this.save('paid-uncertain.json', { month: new Date().toISOString().slice(0, 7) });
        return;
      }
      this.paidCounter().reserveMaximum(undefined, request.taskId, paid.model, budget);
    } finally {
      release();
    }
  }
}
export class PasskeyApprovalProvider implements ApprovalProvider {
  readonly kind = 'human' as const;
  readonly ownerDecision = true as const;
  readonly remoteTaskReview = true as const;
  constructor(readonly broker: PasskeyApprovalBroker) {}
  workerStarted() {
    this.broker.startWorkerEnrollment();
  }
  workerStopped() {
    this.broker.stopWorkerEnrollment();
  }
  approve(request: ApprovalRequest) {
    return this.broker.approve(request);
  }
}
