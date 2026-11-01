// SPDX-License-Identifier: Apache-2.0
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { signApproval, signPayload, verifyApproval, digest } from '@acp/core';
import type { ApprovalReceipt, Gate, KeyPair } from '@acp/core';
import type { OwnerPolicy } from './policy.js';
/** Caps a worker applies before it accepts a contract or spends owner credentials. */
export interface WorkerAcceptancePolicy {
  /** When non-empty, only these requester owner DIDs may be accepted. */
  allowedRequesterDids?: readonly string[];
  /** Explicit opt-in to accept every requester. Takes precedence over the allowlist. */
  allowAnyRequester?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxToolInvocations?: number;
  maxWallClockSeconds?: number;
  maxConcurrentTasks?: number;
  /** How many PROPOSE envelopes one requester DID may submit per minute. */
  maxTasksPerRequesterPerMinute?: number;
  /** Replaces the one-minute window when set. */
  requesterRateLimit?: { maxRequests: number; windowMs: number };
  /** Register the worker AgentCard in the relay directory. Default is off. */
  publishToRegistry?: boolean;
}
export class ProposalRejectedError extends Error {
  readonly approved = false;
  readonly code = 'PROPOSAL_REJECTED';
  constructor(readonly reason: string) {
    super('PROPOSAL_REJECTED: ' + reason);
    this.name = 'ProposalRejectedError';
  }
}
interface ProposedManifest {
  timeoutSeconds?: unknown;
  requester?: { ownerDid?: unknown; agentDid?: unknown };
  budget?: unknown;
}
const budgetFields = [
  'maxInputTokens',
  'maxOutputTokens',
  'maxToolInvocations',
  'maxWallClockSeconds',
] as const;
function proposedManifest(details: unknown): ProposedManifest | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const manifest = (details as { manifest?: unknown }).manifest;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return undefined;
  return manifest as ProposedManifest;
}
function envelopeFrom(details: unknown, from?: string): string | undefined {
  if (typeof from === 'string' && from.length > 0) return from;
  if (!details || typeof details !== 'object') return undefined;
  const value = (details as { from?: unknown }).from;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function budgetLimit(
  policy: WorkerAcceptancePolicy,
  field: (typeof budgetFields)[number],
): number | undefined {
  return policy[field];
}
/** Returns approved:false with a reason when a proposal exceeds the worker policy. */
export function evaluateContractAcceptance(
  policy: WorkerAcceptancePolicy | undefined,
  details: unknown,
  from?: string,
): { approved: true } | { approved: false; reason: string } {
  if (!policy) return { approved: true };
  const manifest = proposedManifest(details);
  const limited = budgetFields.some((field) => policy[field] !== undefined);
  if (limited && !manifest) return { approved: false, reason: 'manifest is missing' };
  if (manifest && limited) {
    const budget = manifest.budget;
    if (!budget || typeof budget !== 'object' || Array.isArray(budget))
      return { approved: false, reason: 'budget is missing' };
    for (const field of budgetFields) {
      const limit = budgetLimit(policy, field);
      if (limit === undefined) continue;
      const proposed = (budget as Record<string, unknown>)[field];
      if (typeof proposed !== 'number' || !Number.isFinite(proposed))
        return { approved: false, reason: field + ' is missing or not a finite number' };
      if (proposed > limit)
        return {
          approved: false,
          reason: field + ' ' + proposed + ' exceeds worker limit ' + limit,
        };
    }
  }
  if (manifest && policy.maxWallClockSeconds !== undefined && 'timeoutSeconds' in manifest) {
    const timeout = manifest.timeoutSeconds;
    if (typeof timeout !== 'number' || !Number.isFinite(timeout))
      return { approved: false, reason: 'timeoutSeconds is missing or not a finite number' };
    if (timeout > policy.maxWallClockSeconds)
      return {
        approved: false,
        reason:
          'timeoutSeconds ' +
          timeout +
          ' exceeds worker limit ' +
          policy.maxWallClockSeconds,
      };
  }
  if (policy.allowAnyRequester) return { approved: true };
  const allow = (policy.allowedRequesterDids ?? []).map((did) => did.trim()).filter(Boolean);
  if (allow.length === 0) return { approved: true };
  const ownerDid = manifest?.requester?.ownerDid;
  const sender = envelopeFrom(details, from);
  if (typeof sender === 'string' && typeof ownerDid === 'string' && sender !== ownerDid)
    return {
      approved: false,
      reason: 'requester ' + ownerDid + ' does not match envelope from ' + sender,
    };
  const authenticated =
    typeof ownerDid === 'string' && ownerDid.length > 0 ? ownerDid : sender;
  if (typeof authenticated === 'string' && allow.includes(authenticated)) return { approved: true };
  return {
    approved: false,
    reason: 'requester ' + (authenticated ?? 'unknown') + ' is not allowed',
  };
}
export interface ApprovalRequest {
  taskId: string;
  gate: Gate;
  target: unknown;
  details?: unknown;
  signal?: AbortSignal;
  deadline?: string;
}
export interface ApprovalProvider {
  approve(request: ApprovalRequest): Promise<ApprovalReceipt>;
}
export class InteractiveCliApprovalProvider implements ApprovalProvider {
  constructor(
    readonly owner: KeyPair,
    readonly options: { input?: Readable; output?: Writable; formatRequest?: (request: ApprovalRequest) => string } = {},
  ) {}
  async approve(request: ApprovalRequest): Promise<ApprovalReceipt> {
    const output = this.options.output ?? process.stdout;
    output.write(
      (this.options.formatRequest?.(request) ?? JSON.stringify(
        {
          taskId: request.taskId,
          gate: request.gate,
          targetDigest: digest(request.target),
          target: request.target,
          details: request.details ?? null,
        },
        null,
        2,
      )) + '\nApprove [y/N]? ',
    );
    const rl = createInterface({ input: this.options.input ?? process.stdin, crlfDelay: Infinity });
    try {
      const answer = await new Promise<string>((resolve, reject) => {
        const abort = () => {
          cleanup();
          reject(new Error('APPROVAL_ABORTED'));
        };
        const cleanup = () => request.signal?.removeEventListener('abort', abort);
        rl.once('line', (line) => {
          cleanup();
          resolve(line);
        });
        rl.once('close', () => {
          cleanup();
          resolve('');
        });
        rl.once('error', (e) => {
          cleanup();
          reject(e);
        });
        request.signal?.addEventListener('abort', abort, { once: true });
        if (request.signal?.aborted) abort();
      });
      return signApproval(
        request.taskId,
        request.gate,
        request.target,
        this.owner,
        /^y(es)?$/i.test(answer.trim()) ? 'APPROVED' : 'REJECTED',
      );
    } finally {
      rl.close();
    }
  }
}
export class PolicyAutoApprovalProvider implements ApprovalProvider {
  constructor(
    readonly owner: KeyPair,
    readonly policy: OwnerPolicy = {
      requiredGates: [],
      autoApprove: ['contract_acceptance', 'final_verification'],
    },
    readonly options: {
      yes?: boolean;
      confirmedGates?: Gate[];
      acceptance?: WorkerAcceptancePolicy;
    } = {},
  ) {}
  async approve(r: ApprovalRequest): Promise<ApprovalReceipt> {
    if (r.gate === 'contract_acceptance') {
      const decision = evaluateContractAcceptance(this.options.acceptance, r.details);
      if (!decision.approved) throw new ProposalRejectedError(decision.reason);
    }
    const explicit = this.options.confirmedGates?.includes(r.gate);
    const sensitive = ['external_side_effect', 'budget_increase'].includes(r.gate);
    if (
      !explicit &&
      (sensitive ||
        this.policy.requiredGates.includes(r.gate) ||
        (!this.options.yes && !this.policy.autoApprove.includes(r.gate)))
    )
      throw new Error('HITL_REQUIRED: ' + r.gate);
    return signApproval(r.taskId, r.gate, r.target, this.owner);
  }
}
export interface WebhookApprovalProviderOptions {
  url: string;
  ownerDid?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * `signed-receipt` (default) posts a signed approval request and requires a
   * signed ApprovalReceipt. `owner-decision` posts
   * `{ taskId, summaryHash, reason, approverDid }` and signs locally when the
   * webhook returns `{ approved: true }`.
   */
  response?: 'signed-receipt' | 'owner-decision';
}
/** Reject webhook URLs that are not plain HTTP(S) endpoints. */
export function assertApprovalWebhookUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('INVALID_APPROVAL_WEBHOOK_URL');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password)
    throw new Error('INVALID_APPROVAL_WEBHOOK_URL');
}
function approvalReason(request: ApprovalRequest): string {
  const details = request.details;
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    const reason = (details as { reason?: unknown }).reason;
    if (typeof reason === 'string' && reason.length > 0) return reason;
  }
  return request.gate;
}
export class WebhookApprovalProvider implements ApprovalProvider {
  constructor(
    readonly owner: KeyPair,
    readonly options: WebhookApprovalProviderOptions,
  ) {
    if (options.response === 'owner-decision') assertApprovalWebhookUrl(options.url);
  }
  async approve(r: ApprovalRequest): Promise<ApprovalReceipt> {
    if (this.options.response === 'owner-decision') return this.approveOwnerDecision(r);
    const body = signPayload(
      {
        type: 'ApprovalRequest',
        taskId: r.taskId,
        gate: r.gate,
        target: r.target,
        targetDigest: digest(r.target),
        details: r.details ?? null,
      },
      this.owner,
    );
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.options.timeoutMs ?? 60000),
      ...(r.signal ? [r.signal] : []),
    ]);
    const response = await (this.options.fetch ?? fetch)(this.options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error('APPROVAL_WEBHOOK_FAILED');
    const receipt = (await response.json()) as ApprovalReceipt;
    if (
      !verifyApproval(receipt, this.options.ownerDid ?? this.owner.did, r.taskId, r.gate, r.target)
    )
      throw new Error('INVALID_APPROVAL_RESPONSE');
    return receipt;
  }
  /** Sign with the owner key only when the webhook explicitly approves. */
  private async approveOwnerDecision(r: ApprovalRequest): Promise<ApprovalReceipt> {
    const body = {
      taskId: r.taskId,
      summaryHash: digest(r.target),
      reason: approvalReason(r),
      approverDid: this.owner.did,
    };
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.options.timeoutMs ?? 60000),
      ...(r.signal ? [r.signal] : []),
    ]);
    const response = await (this.options.fetch ?? fetch)(this.options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error('APPROVAL_REJECTED');
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new Error('APPROVAL_REJECTED');
    }
    const approved =
      !!parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as { approved?: unknown }).approved === true;
    if (!approved) throw new Error('APPROVAL_REJECTED');
    return signApproval(r.taskId, r.gate, r.target, this.owner, 'APPROVED');
  }
}

/** Host form decisions are serialized per MCP connection and never use terminal IO. */
export class McpFormApprovalProvider implements ApprovalProvider {
  private queue: Promise<void> = Promise.resolve();
  constructor(
    readonly owner: KeyPair,
    readonly options: {
      available: () => boolean;
      request: (params: import('@acp/core').Json, signal: AbortSignal) => Promise<unknown>;
      timeoutMs?: number;
      now?: () => number;
    },
  ) {}
  assertAvailable(): void {
    if (!this.options.available()) throw new Error(
      'APPROVAL_CHANNEL_UNAVAILABLE: The host does not support MCP form elicitation. Use a host that supports elicitation, or --approval-webhook.',
    );
  }
  async approve(request: ApprovalRequest): Promise<ApprovalReceipt> {
    this.assertAvailable();
    const review = JSON.stringify({
      taskId: request.taskId, gate: request.gate, target: request.target,
      targetDigest: digest(request.target), details: request.details ?? null,
    }, null, 2);
    if (Buffer.byteLength(review) > 64 * 1024) throw new Error('APPROVAL_REVIEW_TOO_LARGE');
    const remaining = request.deadline
      ? Date.parse(request.deadline) - (this.options.now ?? Date.now)() : Infinity;
    const timeoutMs = Math.min(this.options.timeoutMs ?? 60000, remaining);
    if (!(timeoutMs > 0)) throw new Error('APPROVAL_TIMEOUT');
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('APPROVAL_ABORTED'));
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error('APPROVAL_TIMEOUT')), timeoutMs);
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    let onAbort!: () => void;
    try {
      const result = await Promise.race([
        previous.then(() => {
          if (controller.signal.aborted) throw controller.signal.reason;
          return this.options.request({
            mode: 'form', message: 'Review this Sealbridge action:\n' + review,
            requestedSchema: {
              type: 'object', properties: {
                approved: { type: 'boolean', title: 'Approve this specific action', default: false },
              }, required: ['approved'],
            },
          }, controller.signal);
        }),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', onAbort, { once: true });
          if (controller.signal.aborted) onAbort();
        }),
      ]);
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = result as { action?: unknown; content?: { approved?: unknown } } | null;
      if (!response || response.action !== 'accept' || response.content?.approved !== true)
        throw new Error('APPROVAL_REJECTED');
      return signApproval(request.taskId, request.gate, request.target, this.owner, 'APPROVED');
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
      // A cancelled queued entry must not let later entries overtake the active form.
      void previous.then(release);
    }
  }
}
