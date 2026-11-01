// SPDX-License-Identifier: Apache-2.0
import {
  createSignedAgentCard,
  isInviteTarget,
  createInviteToken,
  createRevocationNotice,
  verifyApproval,
  parseAndVerifyInviteToken,
  resolveDid,
  validateRelayEndpointUrl,
  verifySignedAgentCard,
} from '@acp/core';
import type { BudgetSpec, Invite, Json, KeyPair, Schema } from '@acp/core';
import { RevocationRegistry } from '@acp/core';
import type { AuditBundle, AuditVerificationOptions } from '@acp/ledger';
import { verifyAudit } from '@acp/ledger';
import { HttpRelayClient, validateRelayAuthRecoveryOptions } from '@acp/relay';
import type { RelayAuthRecoveryOptions } from '@acp/relay';
import type { RelayTransport } from '@acp/relay';
import { McpRpc } from './mcp-rpc.js';
import { mcpTools } from './mcp-tool-catalog.js';
import type { Readable, Writable } from 'node:stream';
import {
  McpFormApprovalProvider,
  PolicyAutoApprovalProvider,
  WebhookApprovalProvider,
  assertApprovalWebhookUrl,
} from './approval-providers.js';
import type { ApprovalProvider } from './approval-providers.js';
import type { BeforeProposeContext, DelegateMultiOptions, DelegateOptions } from './session.js';
import { RequesterClient } from './session.js';
import { resolveOrCreateIdentity } from './local-identity.js';
import type { LocalIdentityOptions } from './local-identity.js';
import { DEFAULT_PUBLIC_RELAY, selectApplicationRelay } from './relay-selection.js';
import { validateSessionTimeouts } from './session-timeouts.js';
import type { SessionTimeoutOptions } from './session-timeouts.js';

export interface AcpMcpServerOptions extends RelayAuthRecoveryOptions {
  owner?: KeyPair;
  /** Application defaults are loaded only for identity-dependent operations. */
  identityOptions?: LocalIdentityOptions;
  /** Constructs transports after relay policy checks; useful for offline hosts/tests. */
  transportFactory?: (url: string, owner?: KeyPair) => RelayTransport;
  relay?: RelayTransport | string;
  revocation?: RevocationRegistry;
  name?: string;
  /** Signs agentDid on acp_create_invite when that DID is not the server owner. */
  agentKey?: KeyPair;
  /**
   * When set, a task may proceed only if its worker DID is listed. An invite
   * matches when either agentDid or ownerDid is listed. Checked before dialing.
   */
  allowedWorkerDids?: string[];
  /**
   * When set, every outbound relay URL must match an entry after normalization
   * to origin + pathname with no trailing slash. Includes tool arguments, the
   * configured relay, and relay URLs embedded in invite tokens.
   */
  allowedRelayUrls?: string[];
  /**
   * Permit a tool call or invite to select a relay other than `relay` when no
   * allowlist is set. `allowedRelayUrls` still wins when it is set.
   */
  allowAnyRelay?: boolean;
  /**
   * Opt in to loopback and RFC1918 relays. Untrusted invites stay blocked by default.
   * Passed through to relay URL validation and invite parsing.
   */
  allowPrivateRelay?: boolean;
  /** Used for pre-send and final-verification approvals instead of the default. */
  approvalProvider?: ApprovalProvider;
  /**
   * POST `{ taskId, summaryHash, reason, approverDid }` and sign the owner
   * decision only when the webhook returns `{ approved: true }`.
   */
  approvalWebhookUrl?: string;
  approvalWebhookFetcher?: typeof fetch;
  /** Request host form elicitation for outbound and final approvals. */
  requireInteractiveApproval?: boolean;
  /** Internal form timeout; defaults to 60000 ms and is bounded by the task deadline. */
  approvalTimeoutMs?: number;
}

interface RpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const PROTOCOL_VERSION = '2025-06-18';
const LEGACY_PROTOCOL_VERSION = '2024-11-05';
const OUTBOUND_REASON = 'outbound delegation to a remote Sealbridge worker';
/**
 * Guidance MCP clients place ahead of the tool catalog. Keep the workflow,
 * the sibling-tool split, and the outbound security boundary in this text.
 */
const SERVER_INSTRUCTIONS =
  "This server delegates JSON tasks to remote Sealbridge workers over an encrypted Blind Relay and checks the bilateral audit trail. Call acp_discover_workers or start from an acp-invite, mint one with acp_create_invite when you are the worker owner, then use acp_delegate_task for one worker or acp_delegate_multi for race or quorum. Use acp_verify_audit_bundle with an anchor or expected tail fields when truncation must be ruled out, and use acp_revoke_token with acp_inspect_revocations to record and read local invite or capability revocation. Delegation signs with this process's Ed25519 owner key, and task input is transmitted externally only after allowedWorkerDids, allowedRelayUrls, and the configured approval policy permit transmission. When approval is requested, use advertised host form elicitation or an explicit webhook/provider; MCP stdio is never a terminal approval channel. Verify and inspect stay on this machine, discover only reads a relay directory, and revoke does not push a notice to a worker. Do not put secrets in arguments: delegation is synchronous and returns the verified result in that same call.";

function rpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id: (id ?? null) as Json, error: { code, message } };
}

function toolResult(value: Json, isError = false): Json {
  const result: { [key: string]: Json } = {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    isError,
  };
  // Success payloads are also exposed as structuredContent for outputSchema.
  // Failures stay in content text so they are not validated as the success schema.
  if (!isError && value && typeof value === 'object' && !Array.isArray(value))
    result.structuredContent = value;
  return result;
}

function taskTimeouts(args: Record<string, unknown>): SessionTimeoutOptions {
  const options: SessionTimeoutOptions = {};
  for (const key of ['executionTimeoutMs', 'taskTimeoutMs', 'waitTimeoutMs', 'connectTimeoutMs',
    'transportIdleTimeoutMs', 'heartbeatIntervalMs'] as const) {
    if (args[key] !== undefined) {
      if (typeof args[key] !== 'number') throw new RpcError(-32602, 'Invalid timeout: ' + key);
      options[key] = args[key];
    }
  }
  validateSessionTimeouts(options);
  return options;
}
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RpcError(-32602, 'Invalid params');
  return value as Record<string, unknown>;
}

/** Origin plus pathname, without a trailing slash. Query and fragment are dropped. */
export function normalizeMcpRelayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('MCP_RELAY_NOT_ALLOWED');
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function workerAllowlist(dids: string[] | undefined): ReadonlySet<string> | undefined {
  if (dids === undefined) return undefined;
  if (!Array.isArray(dids)) throw new Error('INVALID_WORKER_DID');
  const allow = new Set<string>();
  for (const did of dids) {
    if (typeof did !== 'string') throw new Error('INVALID_WORKER_DID');
    const trimmed = did.trim();
    try {
      resolveDid(trimmed);
    } catch {
      throw new Error('INVALID_WORKER_DID');
    }
    allow.add(trimmed);
  }
  return allow;
}

function relayAllowlist(
  urls: string[] | undefined,
  allowPrivateRelay: boolean | undefined,
): ReadonlySet<string> | undefined {
  if (urls === undefined) return undefined;
  if (!Array.isArray(urls)) throw new Error('INVALID_RELAY_URL');
  const allow = new Set<string>();
  for (const entry of urls) {
    if (typeof entry !== 'string') throw new Error('INVALID_RELAY_URL');
    const trimmed = entry.trim();
    validateRelayEndpointUrl(trimmed, { allowPrivateRelay });
    allow.add(normalizeMcpRelayUrl(trimmed));
  }
  return allow;
}

function selectApproval(options: AcpMcpServerOptions, owner: KeyPair): ApprovalProvider {
  if (options.approvalProvider) return options.approvalProvider;
  if (options.approvalWebhookUrl) {
    return new WebhookApprovalProvider(owner, {
      url: options.approvalWebhookUrl,
      fetch: options.approvalWebhookFetcher,
      response: 'owner-decision',
    });
  }
  return new PolicyAutoApprovalProvider(owner);
}

/** Dependency-free MCP server for ACP delegation, discovery, audit verification, and revocation. */
export class AcpMcpServer {
  readonly revocation: RevocationRegistry;
  private readonly allowedWorkers?: ReadonlySet<string>;
  private readonly allowedRelays?: ReadonlySet<string>;
  private selectedApproval?: ApprovalProvider;
  private selectedOwner?: KeyPair;
  private owner(): KeyPair {
    return this.options.owner ?? (this.selectedOwner ??=
      resolveOrCreateIdentity('requester', this.options.identityOptions));
  }
  private get approval(): ApprovalProvider {
    return this.selectedApproval ??= this.options.requireInteractiveApproval &&
      !this.options.approvalProvider && !this.options.approvalWebhookUrl
      ? new McpFormApprovalProvider(this.owner(), {
          available: () => this.formSupported && this.rpc !== undefined,
          request: (params, signal) => this.rpc!.request('elicitation/create', params, signal),
          timeoutMs: this.options.approvalTimeoutMs,
        })
      : selectApproval(this.options, this.owner());
  }
  private rpc?: McpRpc;
  private formSupported = false;
  constructor(readonly options: AcpMcpServerOptions) {
    validateRelayAuthRecoveryOptions(options);
    this.revocation = options.revocation ?? new RevocationRegistry();
    this.allowedWorkers = workerAllowlist(options.allowedWorkerDids);
    this.allowedRelays = relayAllowlist(options.allowedRelayUrls, options.allowPrivateRelay);
    if (options.approvalWebhookUrl) assertApprovalWebhookUrl(options.approvalWebhookUrl);
  }
  async handle(message: unknown, signal?: AbortSignal): Promise<Json | undefined> {
    if (!message || typeof message !== 'object' || Array.isArray(message))
      return rpcError(null, -32600, 'Invalid Request');
    const request = message as RpcRequest;
    const hasId = Object.hasOwn(message, 'id');
    const id = hasId ? request.id : null;
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      if (!hasId) return undefined;
      return rpcError(id, -32600, 'Invalid Request');
    }
    try {
      const result = await this.dispatch(request.method, request.params, signal);
      if (!hasId) return undefined;
      return { jsonrpc: '2.0', id: id as Json, result };
    } catch (error) {
      if (!hasId) return undefined;
      const code = error instanceof RpcError ? error.code : -32603;
      const messageText = error instanceof Error ? error.message : String(error);
      return rpcError(id, code, messageText);
    }
  }
  /** Read newline-delimited JSON or Content-Length frames and answer in the same framing. */
  async serve(input: Readable, output: Writable): Promise<void> {
    if (this.rpc) throw new Error('MCP_ALREADY_SERVING');
    const rpc = new McpRpc(output, (message, signal) => this.handle(message, signal));
    this.rpc = rpc;
    try { await rpc.serve(input); }
    finally { this.rpc = undefined; this.formSupported = false; }
  }
  private async dispatch(method: string, params: unknown, signal?: AbortSignal): Promise<Json> {
    if (method === 'initialize') {
      const init = asRecord(params ?? {});
      const version = !init.protocolVersion || init.protocolVersion === LEGACY_PROTOCOL_VERSION
        ? LEGACY_PROTOCOL_VERSION : PROTOCOL_VERSION;
      const elicitation = (init.capabilities as { elicitation?: unknown } | undefined)?.elicitation;
      this.formSupported = version === PROTOCOL_VERSION && !!elicitation &&
        typeof elicitation === 'object' && !Array.isArray(elicitation) &&
        ((Object.hasOwn(elicitation, 'form') && !!(elicitation as { form?: unknown }).form &&
          typeof (elicitation as { form?: unknown }).form === 'object' &&
          !Array.isArray((elicitation as { form?: unknown }).form)) || Object.keys(elicitation).length === 0);
      return {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'sealbridge-mcp-server', version: '0.2.2' },
        instructions: SERVER_INSTRUCTIONS,
      };
    }
    if (method === 'notifications/initialized') return {};
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: mcpTools };
    if (method === 'tools/call') return this.toolsCall(params, signal);
    throw new RpcError(-32601, 'Method not found');
  }
  private async toolsCall(params: unknown, signal?: AbortSignal): Promise<Json> {
    const body = asRecord(params);
    const name = body.name;
    if (typeof name !== 'string') throw new RpcError(-32602, 'Invalid params');
    const args = body.arguments === undefined ? {} : asRecord(body.arguments);
    try {
      const value = await this.callTool(name, args, signal);
      return toolResult(value, false);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      return toolResult({ error: error instanceof Error ? error.message : String(error) }, true);
    }
  }
  private async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Json> {
    if (name === 'acp_delegate_task') return this.delegateTask(args, signal);
    if (name === 'acp_delegate_multi') return this.delegateMulti(args, signal);
    if (name === 'acp_verify_audit_bundle') return this.verifyBundle(args);
    if (name === 'acp_create_invite') return this.createInvite(args);
    if (name === 'acp_revoke_token') return this.revokeToken(args);
    if (name === 'acp_discover_workers') return this.discoverWorkers(args);
    if (name === 'acp_inspect_revocations') return this.inspectRevocations(args);
    throw new RpcError(-32602, 'Unknown tool');
  }
  private selectedRelay(explicit?: string, inviteRelay?: string): RelayTransport | string {
    return selectApplicationRelay({
      configured: this.options.relay, explicit, inviteRelay,
      allowPrivateRelay: this.options.allowPrivateRelay,
      allowAnyRelay: this.options.allowAnyRelay,
      allowedRelayUrls: this.options.allowedRelayUrls,
      conflictError: 'MCP_RELAY_NOT_ALLOWED',
    }).relay;
  }
  private transport(selected: RelayTransport | string, owner?: KeyPair): RelayTransport {
    if (typeof selected !== 'string') return selected;
    return this.options.transportFactory?.(selected, owner) ??
      (owner ? new HttpRelayClient(selected, owner, {
        allowPrivateRelay: this.options.allowPrivateRelay,
        maxAuthRecoveryAttempts: this.options.maxAuthRecoveryAttempts,
        authRecoveryTimeoutMs: this.options.authRecoveryTimeoutMs,
      }) : new HttpRelayClient(selected, {
        allowPrivateRelay: this.options.allowPrivateRelay,
        maxAuthRecoveryAttempts: this.options.maxAuthRecoveryAttempts,
        authRecoveryTimeoutMs: this.options.authRecoveryTimeoutMs,
      }));
  }
  private client(relay: RelayTransport | string): RequesterClient {
    const owner = this.owner();
    const server = this;
    return new class extends RequesterClient {
      override delegate(options: DelegateOptions, hooks?: Parameters<RequesterClient['delegate']>[1]) {
        const relay = typeof options.relay === 'string' && server.options.transportFactory
          ? server.transport(options.relay, owner) : options.relay;
        return super.delegate({ ...options, relay }, hooks);
      }
    }({
      owner,
      relay: typeof relay === 'string' && this.options.transportFactory ? this.transport(relay, owner) : relay,
      approvalProvider: this.approval,
      allowPrivateRelay: this.options.allowPrivateRelay,
      maxAuthRecoveryAttempts: this.options.maxAuthRecoveryAttempts,
      authRecoveryTimeoutMs: this.options.authRecoveryTimeoutMs,
    });
  }
  private parseInvite(token: string): Invite {
    return parseAndVerifyInviteToken(token, Date.now(), {
      allowPrivateRelay: this.options.allowPrivateRelay,
    });
  }
  /** Reject unlisted workers before any relay dial. */
  private assertWorker(invite: Invite | undefined, workerDid: string | undefined): void {
    if (!this.allowedWorkers) return;
    if (invite) {
      if (this.allowedWorkers.has(invite.agentDid) || this.allowedWorkers.has(invite.ownerDid))
        return;
      throw new Error('MCP_WORKER_NOT_ALLOWED');
    }
    if (typeof workerDid === 'string' && this.allowedWorkers.has(workerDid)) return;
    throw new Error('MCP_WORKER_NOT_ALLOWED');
  }
  /**
   * Reject unlisted or switched relay URLs before any relay dial.
   * Explicit tool URLs are dial targets. Invite URLs are outbound destinations
   * even when the configured transport is what would be dialed.
   */
  private assertRelays(explicit: string[], inviteUrls: string[]): void {
    const configured = typeof this.options.relay === 'string' ? this.options.relay : undefined;
    const outbound = [...explicit, ...inviteUrls];
    if (configured) outbound.push(configured);
    if (this.allowedRelays) {
      for (const url of outbound) {
        if (!this.allowedRelays.has(normalizeMcpRelayUrl(url)))
          throw new Error('MCP_RELAY_NOT_ALLOWED');
      }
      return;
    }
    if (this.options.allowAnyRelay) return;
    if (configured) {
      const expected = normalizeMcpRelayUrl(configured);
      for (const url of [...explicit, ...inviteUrls]) {
        if (normalizeMcpRelayUrl(url) !== expected) throw new Error('MCP_RELAY_NOT_ALLOWED');
      }
      return;
    }
    if (this.options.relay && explicit.length > 0) throw new Error('MCP_RELAY_NOT_ALLOWED');
  }
  private outboundApprovalRequired(): boolean {
    if (this.options.approvalProvider)
      return !(this.options.approvalProvider instanceof PolicyAutoApprovalProvider);
    return Boolean(this.options.approvalWebhookUrl || this.options.requireInteractiveApproval);
  }
  /** Bind pre-send consent to the resolved task, without including invitation tokens. */
  private beforePropose(fanOut: number): DelegateOptions['beforePropose'] {
    if (this.approval instanceof McpFormApprovalProvider) this.approval.assertAvailable();
    if (!this.outboundApprovalRequired()) return undefined;
    return async ({ manifest, input, relay, signal }: BeforeProposeContext) => {
      const target = Object.freeze({ manifest, input, relay, fanOut });
      const receipt = await this.approval.approve({
        taskId: manifest.taskId, gate: 'external_side_effect', target,
        details: { reason: OUTBOUND_REASON }, signal, deadline: manifest.deadline,
      });
      if (!verifyApproval(receipt, this.owner().did, manifest.taskId, 'external_side_effect', target) ||
          receipt.payload.decision !== 'APPROVED') throw new Error('APPROVAL_REJECTED');
    };
  }
  private async delegateTask(args: Record<string, unknown>, signal?: AbortSignal): Promise<Json> {
    const to = typeof args.inviteToken === 'string' ? args.inviteToken : args.workerDid;
    if (typeof to !== 'string' || typeof args.title !== 'string')
      throw new RpcError(-32602, 'Invalid params');
    const invite = isInviteTarget(to) ? this.parseInvite(to) : undefined;
    const explicitRelay = typeof args.relayUrl === 'string' ? args.relayUrl : undefined;
    this.assertWorker(invite, invite ? undefined : to);
    this.assertRelays(explicitRelay ? [explicitRelay] : [], invite ? [invite.relayUrl] : []);
    const relay = this.selectedRelay(explicitRelay, invite?.relayUrl);
    const request: DelegateOptions = {
      signal,
      beforePropose: this.beforePropose(1),
      ...taskTimeouts(args),
      to,
      title: args.title,
      description: typeof args.description === 'string' ? args.description : '',
      input: (args.input ?? null) as Json,
      outputSchema: args.outputSchema as Schema | undefined,
      budget: args.budget as Partial<BudgetSpec> | undefined,
      minimumIsolationLevel:
        typeof args.minimumIsolationLevel === 'string' ? args.minimumIsolationLevel : undefined,
    };
    const result = await this.client(relay).delegate(request);
    const report = verifyAudit(result.bundle);
    return {
      taskId: result.taskId,
      status: result.state,
      deliverable: result.deliverable,
      auditBundle: {
        valid: report.valid,
        status: report.status,
        count: result.bundle.entries.length,
        head: result.bundle.checkpoint.actor.payload.head,
        taskId: result.taskId,
      },
    };
  }
  private async delegateMulti(args: Record<string, unknown>, signal?: AbortSignal): Promise<Json> {
    if (!Array.isArray(args.workers) || (args.mode !== 'race' && args.mode !== 'quorum'))
      throw new RpcError(-32602, 'Invalid params');
    if (typeof args.title !== 'string') throw new RpcError(-32602, 'Invalid params');
    const relay = typeof args.relayUrl === 'string' ? args.relayUrl : undefined;
    const explicitRelays: string[] = [];
    if (relay) explicitRelays.push(relay);
    const inviteUrls: string[] = [];
    const workers = args.workers.map((worker) => {
      const item = asRecord(worker);
      if (typeof item.workerDid !== 'string') throw new RpcError(-32602, 'Invalid params');
      const inviteToken = typeof item.inviteToken === 'string' ? item.inviteToken : undefined;
      const invite = inviteToken ? this.parseInvite(inviteToken) : undefined;
      this.assertWorker(invite, item.workerDid);
      if (typeof item.relayUrl === 'string') explicitRelays.push(item.relayUrl);
      if (invite) inviteUrls.push(invite.relayUrl);
      const selected = this.selectedRelay(typeof item.relayUrl === 'string' ? item.relayUrl : relay, invite?.relayUrl);
      return {
        workerDid: item.workerDid,
        inviteToken,
        relayUrl: typeof selected === 'string' ? selected : undefined,
      };
    });
    this.assertRelays(explicitRelays, inviteUrls);
    const quorumSize =
      args.quorumSize === undefined
        ? undefined
        : typeof args.quorumSize === 'number'
          ? args.quorumSize
          : Number.NaN;
    const request: DelegateMultiOptions = {
      signal,
      beforePropose: this.beforePropose(workers.length),
      ...taskTimeouts(args),
      workers,
      mode: args.mode,
      quorumSize,
      title: args.title,
      description: typeof args.description === 'string' ? args.description : '',
      input: (args.input ?? null) as Json,
      outputSchema: args.outputSchema as Schema | undefined,
      budget: args.budget as Partial<BudgetSpec> | undefined,
      minimumIsolationLevel:
        typeof args.minimumIsolationLevel === 'string' ? args.minimumIsolationLevel : undefined,
    };
    const result = await this.client(this.selectedRelay(workers[0]?.relayUrl ?? relay)).delegateMulti(request);
    return {
      mode: result.mode,
      status: result.status,
      deliverable: result.deliverable,
      outputDigest: result.outputDigest,
      taskIds: result.taskIds,
      winners: result.winners as unknown as Json,
      cancelled: result.cancelled,
      auditBundles: result.receipts.map((receipt) => ({
        workerDid: receipt.workerDid,
        taskId: receipt.taskId,
        outputDigest: receipt.outputDigest,
        valid: verifyAudit(receipt.bundle).valid,
        count: receipt.bundle.entries.length,
        head: receipt.bundle.checkpoint.actor.payload.head,
      })),
    };
  }
  private verifyBundle(args: Record<string, unknown>): Json {
    const bundle = args.bundle as AuditBundle;
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle))
      throw new RpcError(-32602, 'Invalid params');
    const options: AuditVerificationOptions = {};
    let anchored = false;
    if (args.anchor !== undefined) {
      if (!args.anchor || typeof args.anchor !== 'object' || Array.isArray(args.anchor))
        throw new RpcError(-32602, 'Invalid params');
      const anchor = args.anchor as AuditVerificationOptions;
      // The legacy anchor object still pins taskId and actors, as before.
      options.trustAnchor = anchor;
      options.taskId = typeof anchor.taskId === 'string' ? anchor.taskId : '';
      options.actors =
        Array.isArray(anchor.actors) && anchor.actors.length === 2
          ? (anchor.actors as [string, string])
          : ['', ''];
      if (typeof anchor.head === 'string') options.head = anchor.head;
      anchored = true;
    }
    if (args.expectedFinalState !== undefined) {
      if (typeof args.expectedFinalState !== 'string' || args.expectedFinalState.length === 0)
        throw new RpcError(-32602, 'Invalid params');
      options.expectedFinalState = args.expectedFinalState;
      anchored = true;
    }
    if (args.expectedLastEntryHash !== undefined) {
      if (typeof args.expectedLastEntryHash !== 'string' || args.expectedLastEntryHash.length === 0)
        throw new RpcError(-32602, 'Invalid params');
      options.expectedLastEntryHash = args.expectedLastEntryHash;
      anchored = true;
    }
    if (args.expectedEntryCount !== undefined) {
      if (
        typeof args.expectedEntryCount !== 'number' ||
        !Number.isSafeInteger(args.expectedEntryCount) ||
        args.expectedEntryCount < 0
      )
        throw new RpcError(-32602, 'Invalid params');
      options.expectedEntryCount = args.expectedEntryCount;
      anchored = true;
    }
    const report = verifyAudit(bundle, anchored ? options : undefined);
    return report as unknown as Json;
  }
  private createInvite(args: Record<string, unknown>): Json {
    if (args.relayUrl !== undefined && typeof args.relayUrl !== 'string') throw new RpcError(-32602, 'Invalid params');
    const relayUrl = typeof args.relayUrl === 'string' ? args.relayUrl
      : typeof this.options.relay === 'string' ? this.options.relay : DEFAULT_PUBLIC_RELAY;
    const owner = this.owner();
    const agentDid = typeof args.agentDid === 'string' ? args.agentDid : owner.did;
    const card = createSignedAgentCard(
      {
        name: typeof args.name === 'string' ? args.name : (this.options.name ?? 'Sealbridge Worker'),
        agentDid,
        relayEndpoint: relayUrl,
        skills: [{ id: 'json-task', name: 'JSON task' }],
      },
      owner,
      agentDid === owner.did ? undefined : this.options.agentKey,
    );
    const inviteOptions: { agentCard: typeof card; expiresInSeconds?: number } = {
      agentCard: card,
    };
    if (args.expiresInSeconds !== undefined) {
      if (typeof args.expiresInSeconds !== 'number') throw new Error('INVALID_INVITE_EXPIRY');
      inviteOptions.expiresInSeconds = args.expiresInSeconds;
    }
    return {
      inviteToken: createInviteToken(inviteOptions, owner),
    };
  }
  private revokeToken(args: Record<string, unknown>): Json {
    if (
      (args.targetType !== 'invite' && args.targetType !== 'capability') ||
      typeof args.targetId !== 'string' ||
      typeof args.reason !== 'string'
    )
      throw new RpcError(-32602, 'Invalid params');
    const notice = createRevocationNotice(
      { targetType: args.targetType, targetId: args.targetId, reason: args.reason },
      this.owner(),
    );
    this.revocation.revoke(notice);
    return { notice: notice as unknown as Json };
  }
  private async discoverWorkers(args: Record<string, unknown>): Promise<Json> {
    if (args.relayUrl !== undefined && typeof args.relayUrl !== 'string')
      throw new RpcError(-32602, 'Invalid params');
    const explicitRelay = typeof args.relayUrl === 'string' ? args.relayUrl : undefined;
    this.assertRelays(explicitRelay ? [explicitRelay] : [], []);
    const selected = this.selectedRelay(explicitRelay);
    const transport = this.transport(selected);
    if (!transport.discover) throw new Error('DISCOVERY_UNAVAILABLE');
    const rawCards = await transport.discover();
    if (!Array.isArray(rawCards)) throw new Error('INVALID_AGENT_CARD');
    const now = Date.now();
    const cards = rawCards.filter((card) => verifySignedAgentCard(card, now));
    return {
      relayUrl: typeof selected === 'string' ? selected : null,
      count: cards.length,
      workers: cards.map((card) => {
        const worker: { [key: string]: Json } = {
          name: card.payload.name,
          description: card.payload.description,
          ownerDid: card.payload.ownerDid,
          agentDid: card.payload.agentDid,
          relayEndpoint: card.payload.relayEndpoint,
          expiresAt: card.payload.expiresAt,
          version: card.payload.version,
          costModes: card.payload.costModes,
          skills: card.payload.skills.map((skill) => {
            const item: { [key: string]: Json } = { id: skill.id, name: skill.name };
            if (typeof skill.description === 'string') item.description = skill.description;
            return item;
          }),
          signerDid: card.signature.signerDid,
          signedAt: card.signature.signedAt,
          signature: card.signature as unknown as Json,
        };
        if (card.payload.agentDelegation)
          worker.agentDelegation = card.payload.agentDelegation as unknown as Json;
        return worker;
      }),
    };
  }
  private inspectRevocations(args: Record<string, unknown>): Json {
    const hasType = args.targetType !== undefined;
    const hasId = args.targetId !== undefined;
    if (hasId && !hasType) throw new RpcError(-32602, 'Invalid params');
    if (hasType && args.targetType !== 'invite' && args.targetType !== 'capability')
      throw new RpcError(-32602, 'Invalid params');
    if (hasId && (typeof args.targetId !== 'string' || args.targetId.length === 0))
      throw new RpcError(-32602, 'Invalid params');
    const targetType = hasType ? (args.targetType as 'invite' | 'capability') : undefined;
    const targetId = hasId ? (args.targetId as string) : undefined;
    const notices = this.revocation.exportNotices().filter((notice) => {
      if (targetType && notice.payload.targetType !== targetType) return false;
      if (targetId !== undefined && notice.payload.targetId !== targetId) return false;
      return true;
    });
    const result: { [key: string]: Json } = {
      count: notices.length,
      notices: notices as unknown as Json,
    };
    if (targetType && targetId !== undefined)
      result.revoked = this.revocation.isRevoked(targetType, targetId);
    return result;
  }
}
