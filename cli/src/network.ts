// SPDX-License-Identifier: Apache-2.0
import { createInviteCommand, inviteLinksCommand, SHORT_INVITE_USAGE, linkRevocations } from './invite-links.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inviteShareCommand } from './invite-share.js';
import { connectionHumanReview } from './connections.js';
import { publicSettingsFlags, publicProfileSummary } from './public-settings.js';
import type { KeyPair, Schema } from '@acp/core';
import { discoverAgentCards, isInviteTarget, parseAndVerifyInviteToken } from '@acp/core';
import type { RelayTransport } from '@acp/relay';
import { startLocalRelay, HttpRelayClient } from '@acp/relay';
import {
  WorkerNode,
  HeldRequestReview,
  LiveProtocol,
  ProtocolPeerStore,
  WorkerTrustStore,
  workerIntakePath,
  resolveStoredIdentity,
  selectApplicationRelay,
  normalizeRelayUrl,
  readApplicationConfig,
  RequesterClient,
  RequesterPendingStore,
  InviteStore,
  PolicyAutoApprovalProvider,
  InteractiveCliApprovalProvider,
} from '@acp/runtime';
import type { InviteStoreOptions, DelegateOptions, AgentAdapter, ApprovalProvider, WorkerAcceptancePolicy, SessionTimeoutOptions } from '@acp/runtime';
import {
  CommandAgentAdapter,
  ClaudeCodeAdapter,
  CodexCliAdapter,
  OpenAICompatibleAdapter,
  SandboxAgentAdapter,
  assertCliAuthentication,
} from '@acp/adapters';
import { createWakeHook } from './wake-hook.js';
import { createReceiveHook } from './receive-hook.js';
import { contactsPath, loadContacts, contactsApproval, addContact } from './contacts.js';
import { readTaskInputFile } from './task-input.js';
import { approvalSummary } from './approval-summary.js';
import { relayAuthOptions, RELAY_AUTH_HELP } from './relay-auth.js';
import { parseInviteOutput, deliverInvite } from './invite-output.js';
import { emitWorkerJson, inviteDigest } from './worker-json.js';
import { cliTaskInspection, literalText } from './task-review.js';
const REPEATABLE = new Set(['--allowed-peer', '--allow-requester', '--allow-task-type']);
const LLM_ADAPTERS = new Set(['claude', 'codex', 'openai']);
// One stdin answer must decide only the task/gate currently displayed.
let approvalQueue: Promise<unknown> = Promise.resolve();
function flags(args: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) throw new Error('Unexpected argument: ' + arg);
    const next = args[i + 1];
    const value = next !== undefined && !next.startsWith('--') ? args[++i] : true;
    if (REPEATABLE.has(arg)) {
      if (typeof value !== 'string' || value.trim() === '')
        throw new Error('Missing ' + arg);
      const previous = out.get(arg);
      out.set(arg, (typeof previous === 'string' && previous ? previous + ',' : '') + value);
      continue;
    }
    if (out.has(arg)) throw new Error('Duplicate option: ' + arg);
    out.set(arg, value);
  }
  return out;
}
function text(f: Map<string, string | true>, name: string, fallback?: string): string {
  const value = f.get('--' + name) ?? fallback;
  if (typeof value !== 'string') throw new Error('Missing --' + name);
  return value;
}
function approval(
  key: KeyPair,
  automatic: boolean,
  acceptance?: WorkerAcceptancePolicy,
  verbose = false,
): ApprovalProvider {
  if (automatic) return new PolicyAutoApprovalProvider(key, undefined, { acceptance });
  const interactive = new InteractiveCliApprovalProvider(key, { output: process.stderr,
    formatRequest: verbose ? request => literalText({ taskId: request.taskId, gate: request.gate,
      target: request.target, details: request.details ?? null }) : approvalSummary });
  return { kind: 'human', approve(request) {
    const pending = approvalQueue.catch(() => {}).then(() => {
      if (request.signal?.aborted) throw new Error('APPROVAL_ABORTED');
      return interactive.approve(request);
    });
    approvalQueue = pending;
    return pending;
  } };
}
function optionalCount(parsed: Map<string, string | true>, name: string): number | undefined {
  if (!parsed.has('--' + name)) return undefined;
  const raw = text(parsed, name);
  if (!/^[1-9]\d*$/.test(raw))
    throw new Error('INVALID_' + name.toUpperCase().replaceAll('-', '_'));
  const value = Number(raw);
  if (!Number.isSafeInteger(value))
    throw new Error('INVALID_' + name.toUpperCase().replaceAll('-', '_'));
  return value;
}
function sessionTimeouts(parsed: Map<string, string | true>): SessionTimeoutOptions {
  return {
    executionTimeoutMs: optionalCount(parsed, 'execution-timeout-ms'),
    taskTimeoutMs: optionalCount(parsed, 'task-timeout-ms'),
    waitTimeoutMs: optionalCount(parsed, 'wait-timeout-ms'),
    connectTimeoutMs: optionalCount(parsed, 'connect-timeout-ms'),
    transportIdleTimeoutMs: optionalCount(parsed, 'transport-idle-timeout-ms'),
    heartbeatIntervalMs: optionalCount(parsed, 'heartbeat-interval-ms'),
  };
}
const DELEGATE_USAGE = 'Usage: sealbridge delegate ' +
  '(--to <invite|link|did|alias|workerRef> | --invite <invite|link|did|alias|workerRef> | --discover <skill> | --task-type <type>) ' +
  '--title <text> --description <text> (--input <json> | --input-file <path>) ' +
  '[--relay <url>] [--key <file>] [--output-schema <json_or_file>] ' +
  '[--audit <file>] [--out <file>] [--auto-approve] [--allow-private-relay]';
const WORKER_USAGE = 'Usage: sealbridge worker start [--adapter sandbox|command|claude|codex|openai] [options] | public --settings <file> [options]';
const RELAY_USAGE = 'Usage: sealbridge relay start [--port <n>] [--host <address>] [options]';
const INVITE_USAGE = 'Usage: sealbridge invite create [--key <file>] [--relay <url>] [--name <text>] [--expires-in <seconds>]\n' +
  '       sealbridge invite open|share|request-reissue|reissue --file <invite> [options]';
const DISCOVER_USAGE = 'Usage: sealbridge discover [--relay <url>] [--skill <id>] [--task-type <type>] [--did <did>] [--allow-private-relay]';
// Validate option names and required values before identities or stores are opened.
function checkNetworkOptions(command: string, parsed: Map<string, string | true>): void {
  const boolean = new Set(['--allow-private-relay', '--yes', '--auto-accept', '--auto-approve',
    '--once', '--publish', '--preview', '--verbose']);
  const timeouts = ['--execution-timeout-ms', '--task-timeout-ms', '--wait-timeout-ms',
    '--connect-timeout-ms', '--transport-idle-timeout-ms', '--heartbeat-interval-ms'];
  const options: Record<string, string[]> = {
    invite: ['--name', '--expires-in'],
    discover: ['--skill', '--task-type', '--did'],
    relay: ['--port', '--host', '--notification-key', '--notification-ttl-ms', '--envelope-ttl-ms',
      '--max-queue-size', '--max-queue-bytes', '--max-envelope-bytes', '--max-envelopes-per-sender',
      '--wake-command', '--wake-relay', '--wake-max-attempts', '--wake-retry-base-ms', '--wake-timeout-ms'],
    worker: [...timeouts, '--adapter', '--cmd', '--model', '--endpoint', '--name', '--invite-ttl', '--invite-output',
      '--contacts', '--allowed-peer', '--allow-requester', '--allow-task-type', '--skill', '--task-type',
      '--max-input-tokens', '--max-output-tokens', '--max-tool-invocations', '--max-wall-clock-seconds',
      '--max-concurrent-tasks', '--max-requests-per-minute', '--max-tasks-per-day', '--wake-channel',
      '--audit', '--audit-interruption-format', '--inbox', '--on-receive', '--yes', '--auto-accept', '--auto-approve', '--once', '--publish', '--preview', '--verbose'],
    delegate: [...timeouts, '--to', '--invite', '--discover', '--task-type', '--title', '--description',
      '--input', '--input-file', '--output-schema', '--save-contact', '--contacts', '--audit', '--out',
      '--yes', '--auto-accept', '--auto-approve', '--verbose'],
  };
  const known = new Set(['--key', '--relay', '--allow-private-relay', '--relay-auth-retries',
    '--relay-auth-recovery-timeout-ms', ...options[command]]);
  for (const [name, value] of parsed) {
    if (!known.has(name)) throw new Error('Unknown option: ' + name);
    if (!boolean.has(name) && typeof value !== 'string') throw new Error('Missing ' + name);
  }
  if (command === 'worker' || command === 'delegate') sessionTimeouts(parsed);
  if (command === 'worker') {
    optionalCount(parsed, 'max-tasks-per-day');
    if (parsed.has('--audit-interruption-format') && parsed.get('--audit-interruption-format') !== '1')
      throw new Error('UNSUPPORTED_AUDIT_INTERRUPTION_FORMAT');
  }
}
const TIMEOUT_HELP = `Timeout options (positive integer milliseconds):
  --execution-timeout-ms <n>       Execution/AI-step wall-clock limit; delegate proposes this budget (default: 60000).
  --task-timeout-ms <n>            Overall task, including approvals and settlement (default: 600000).
  --wait-timeout-ms <n>            Each peer/owner approval wait phase (default: 600000).
  --connect-timeout-ms <n>         Relay connection/request timeout (default: 45000).
  --transport-idle-timeout-ms <n>  Authenticated peer idle watchdog during execution (default: 90000).
  --heartbeat-interval-ms <n>      Worker liveness interval (default: 15000).
Worker execution limit defaults to the agreed budget. Heartbeats do not renew task or execution deadlines.`;
const REVIEW_HELP = `
  --input-file <path>            Delegate: JSON object, or text/diff wrapped as { "diff": contents }.
                                 Use exactly one of --input <json> and --input-file.
  --to <invite|link|did|alias|workerRef>  Delegate: accepts invitation links and saved invitation references.
  --invite <invite|link|did|alias|workerRef>  Delegate: alias of --to; if both are given, values must match.
  --invite-ttl <seconds>          Worker invite lifetime (default: 86400 / 24h; range: 1–2592000).
                                 Startup prints both the token and a ready-to-share HTTPS link.
  --invite-output <destination>  Worker: stdout (default), none, file:<path>, or fd:<n> (POSIX only, n > 2).
                                 File: unused path in an existing private directory; token + newline.
                                 FD: inherited pipe/socket or private file; remains open. No stdout copy.
                                 Stderr invite_ready JSON contains metadata only in every mode.
  --audit-interruption-format 1  Opt in to worker-only PROPOSE interruption terminals; update audit readers first.
  --verbose                     Full approval JSON instead of concise summaries (default: off).
Claude/Codex workers require a host ANTHROPIC_API_KEY / OPENAI_API_KEY.
With interactive stdin/stderr, workers display the full validated task as literal JSON before the live owner approval prompt.
Use tasks list/show/approve/reject for individual terminal held attempts; connection consent stays on connections.
Without an interactive TTY, limited tasks remain held; --auto-accept never supplies their owner approval.
Task HOME is fresh: host CLI login directories are not exposed. --cmd overrides manage their own authentication.`;
function allowRequesterDids(parsed: Map<string, string | true>): string[] {
  const raw = parsed.get('--allow-requester');
  if (raw === undefined) return [];
  if (typeof raw !== 'string') throw new Error('Missing --allow-requester');
  const dids = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (dids.length === 0) throw new Error('Missing --allow-requester');
  return dids;
}
function workerAcceptance(parsed: Map<string, string | true>): WorkerAcceptancePolicy {
  return {
    allowedRequesterDids: allowRequesterDids(parsed),
    maxInputTokens: optionalCount(parsed, 'max-input-tokens'),
    maxOutputTokens: optionalCount(parsed, 'max-output-tokens'),
    maxToolInvocations: optionalCount(parsed, 'max-tool-invocations'),
    maxWallClockSeconds: optionalCount(parsed, 'max-wall-clock-seconds'),
    maxConcurrentTasks: optionalCount(parsed, 'max-concurrent-tasks'),
    maxTasksPerRequesterPerMinute: optionalCount(parsed, 'max-requests-per-minute'),
    publishToRegistry: parsed.has('--publish'),
  };
}
function assertLlmAutoAccept(
  adapter: string,
  automatic: boolean,
  acceptance: WorkerAcceptancePolicy,
  trustedGrant = false,
): void {
  if (!automatic || !LLM_ADAPTERS.has(adapter)) return;
  if (trustedGrant || (acceptance.allowedRequesterDids?.length ?? 0) > 0) return;
  throw new Error(
    'LLM_AUTO_ACCEPT_REQUIRES_ALLOWLIST: --auto-accept with the ' +
      adapter +
      ' adapter can spend the worker owner API key. Pass --allow-requester <did> ' +
      '(repeatable or comma-separated). Connections remain limited and require owner opening.',
  );
}
export async function networkCommand(command: string, args: string[], application: {
  identityOptions?: InviteStoreOptions; fetch?: typeof fetch;
  pendingRequest?: DelegateOptions; pendingRelayUrl?: string;
  transportFactory?: (url: string, owner: KeyPair) => RelayTransport;
  onDelegated?: () => void;
} = {}): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    if (command === 'invite') {
      if (['open', 'share', 'request-reissue', 'reissue'].includes(args[0]))
        return inviteShareCommand(args[0], args.slice(1), application.identityOptions);
      console.log(SHORT_INVITE_USAGE + '\n' + INVITE_USAGE); return;
    }
    if (command === 'discover') { console.log(DISCOVER_USAGE); return; }
    console.log(command === 'relay' ? RELAY_USAGE + '\n\n' + `Relay notification options:
  --wake-command <command>       Opt-in wake hook, signed routing JSON on stdin (default: off).
  --wake-relay <url>             Advertised relay URL; required with --wake-command.
  --wake-max-attempts <n>        Maximum wake attempts (default: 5).
  --wake-retry-base-ms <n>       Exponential retry base, capped at 60000ms (default: 1000).
  --wake-timeout-ms <n>          Per-attempt timeout (default: 5000).
  --notification-key <file>      Persistent signing key (default: ephemeral local identity).
  --notification-ttl-ms <n>      Wake registration/dedup and expiry notice retention (default: 3600000).
  --envelope-ttl-ms <n>          Undelivered envelope TTL (default: 86400000).
  --max-queue-size <n>           Queued envelopes per recipient (default: 256).
  --max-queue-bytes <n>          Queued JSON bytes per recipient (default: 4194304).
  --max-envelope-bytes <n>       Signed envelope JSON bytes (default: 262144).
  --max-envelopes-per-sender <n> Queued envelopes per sender and recipient (default: queue size).` :
      (command === 'delegate' ? DELEGATE_USAGE : WORKER_USAGE) + '\n\n' + TIMEOUT_HELP + '\n' + RELAY_AUTH_HELP + REVIEW_HELP + `
  --allowed-peer <did>          Worker: hard peer perimeter (repeatable/comma-separated).
  requests list|show|approve|discard|deny  Local review; approve records limited connection consent.
  tasks list|show|approve|reject  Individual terminal held-task review; fresh tasks need live owner approval.
  connections list|request|approve|reject|withdraw|disconnect|block|unblock|confirm-invite|prior-approved|connect-prior|sync
                                 Separate human connection consent; tasks use their own inspection and live approval.
  --allow-task-type <type>       Repeatable/comma-separated advertised task types.
  --wake-channel <name>          Worker: register an operator channel on startup (default: off).
                                 The local relay CLI provides channel "default".`);
    return;
  }
  if (args.some(a => a === '--open' || a.startsWith('--open=') || a === '--access-mode' || a.startsWith('--open-') || a.startsWith('--access-mode=') || a === '--allow-any-requester' || a.startsWith('--allow-any-requester=')))
    throw new Error('ACCESS_MODE_REMOVED: Use connections; replace old budget flags with --max-input-tokens, --max-output-tokens, --max-tool-invocations, --max-wall-clock-seconds, --allow-task-type and --max-requests-per-minute.');
  if (command === 'delegate' && args.length === 0 && !application.pendingRequest)
    throw new Error(DELEGATE_USAGE);
  const sub = ['relay', 'worker', 'invite'].includes(command) ? args.shift() : undefined;
  if (command === 'worker' && sub === 'public') {
    const index = args.indexOf('--settings');
    if (index < 0 || !args[index + 1]) throw new Error('Missing --settings');
    const settings = JSON.parse(readFileSync(args[index + 1], 'utf8'));
    args.splice(index, 2);
    if (args.some(a => ['--open','--publish','--auto-accept','--auto-approve','--yes','--allow-any-requester','--access-mode'].includes(a) || a.startsWith('--open-') || a === '--max-tasks-per-day'))
      throw new Error('CONFLICTING_PUBLIC_SETTINGS');
    const generated = publicSettingsFlags(settings);
    for (const flag of ['--max-input-tokens','--max-output-tokens','--max-tool-invocations','--max-wall-clock-seconds','--max-requests-per-minute']) {
      const existing = args.indexOf(flag), setting = generated.indexOf(flag);
      if (existing >= 0 && setting >= 0) { generated[setting + 1] = String(Math.min(Number(args[existing + 1]), Number(generated[setting + 1]))); args.splice(existing, 2); }
    }
    return networkCommand('worker', ['start', ...args, ...generated], application);
  }
  if (command === 'invite' && sub === 'links') return inviteLinksCommand(args, application);
  if (command === 'invite' && sub === 'create') return createInviteCommand(args, application);
  if (command === 'invite' && sub !== 'create') return inviteShareCommand(sub ?? '', args, application.identityOptions);
  if ((command === 'relay' || command === 'worker') && sub !== 'start')
    throw new Error(command === 'worker' ? WORKER_USAGE : RELAY_USAGE);
  const f = flags(args);
  const inviteOutput = command === 'worker' ? parseInviteOutput(f.get('--invite-output')) : undefined;
  const authRecovery = relayAuthOptions(f);
  checkNetworkOptions(command, f);
  if (command === 'delegate' && f.has('--invite')) {
    const invite = text(f, 'invite');
    if (f.has('--to') && text(f, 'to') !== invite)
      throw new Error('CONFLICTING_TARGET_OPTIONS: --to and --invite must match');
    f.set('--to', invite);
  }
  const allowPrivateRelay = f.has('--allow-private-relay');
  if (command === 'relay') {
    const port = Number(text(f, 'port', '8787'));
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_PORT');
    const relay = await startLocalRelay({ port, host: text(f, 'host', '127.0.0.1'), relayOptions: {
      envelopeTtlMs: optionalCount(f, 'envelope-ttl-ms'),
      maxQueueSize: optionalCount(f, 'max-queue-size'),
      maxQueueBytesPerRecipient: optionalCount(f, 'max-queue-bytes'),
      maxEnvelopeBytes: optionalCount(f, 'max-envelope-bytes'),
      maxEnvelopesPerSender: optionalCount(f, 'max-envelopes-per-sender'),
      notificationTtlMs: optionalCount(f, 'notification-ttl-ms'),
      notificationKey: f.has('--notification-key') ? JSON.parse(readFileSync(text(f, 'notification-key'), 'utf8')) as KeyPair : undefined,
      ...(f.has('--wake-command') ? { wake: {
        relay: text(f, 'wake-relay'), channels: { default: createWakeHook(text(f, 'wake-command')) },
        maxAttempts: optionalCount(f, 'wake-max-attempts'),
        retryBaseMs: optionalCount(f, 'wake-retry-base-ms'), timeoutMs: optionalCount(f, 'wake-timeout-ms'),
      } } : {}),
    } });
    console.log(JSON.stringify({ relay: relay.url }));
    await new Promise<void>((resolve) => {
      const stop = () => resolve();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    await relay.close();
    return;
  }
  const { relays: fallbackCandidates } = readApplicationConfig({ ...application.identityOptions, allowPrivateRelay });
  const selectedRelay = (inviteRelay?: string) => selectApplicationRelay({
    configured: f.has('--relay') ? text(f, 'relay') : undefined,
    inviteRelay, fallbackCandidates, allowPrivateRelay,
  }).relay as string;
  if (command === 'discover') {
    const client = new HttpRelayClient(selectedRelay(), application.fetch ?? fetch, undefined, { allowPrivateRelay });
    console.log(JSON.stringify(discoverAgentCards(await client.discover(), {
      ...(f.has('--skill') ? { skillId: text(f, 'skill') } : {}),
      ...(f.has('--task-type') ? { taskType: text(f, 'task-type') } : {}),
      ...(f.has('--did') ? { did: text(f, 'did') } : {}),
    }), null, 2));
    return;
  }
  const getKey = () => resolveStoredIdentity(command === 'delegate' ? 'requester' : 'worker', {
    ...application.identityOptions,
    explicitKeyPath: f.has('--key') ? text(f, 'key') : undefined,
  });
  const automatic = ['yes', 'auto-accept', 'auto-approve'].some((name) => f.has('--' + name));
  if (command === 'worker') {
    const onInboxRecord = f.has('--on-receive')
      ? createReceiveHook(text(f, 'on-receive')) : undefined;
    if (onInboxRecord && !f.has('--inbox')) throw new Error('--on-receive requires --inbox');
    const adapterName = text(f, 'adapter', 'sandbox');
    const inviteTtl = optionalCount(f, 'invite-ttl') ?? 86400;
    if (inviteTtl > 2592000) throw new Error('INVALID_INVITE_TTL: expected 1–2592000 seconds');
    const acceptance = workerAcceptance(f);
    const allowedTaskTypes = f.has('--allow-task-type')
      ? [...new Set(text(f, 'allow-task-type').split(',').map(value => value.trim()))] : undefined;
    if (allowedTaskTypes?.some(value => !value)) throw new Error('INVALID_ALLOW_TASK_TYPE');
    if (allowedTaskTypes && f.has('--task-type') && !allowedTaskTypes.includes(text(f, 'task-type')))
      throw new Error('CONFLICTING_TASK_TYPE');
    let adapter: AgentAdapter;
    switch (adapterName) {
      case 'command':
        adapter = new CommandAgentAdapter({ command: text(f, 'cmd') });
        break;
      case 'claude':
        adapter = new ClaudeCodeAdapter(f.has('--cmd') ? { command: text(f, 'cmd') } : {});
        break;
      case 'codex':
        adapter = new CodexCliAdapter(f.has('--cmd') ? { command: text(f, 'cmd') } : {});
        break;
      case 'openai':
        adapter = new OpenAICompatibleAdapter({
          model: text(f, 'model', 'gpt-4o-mini'),
          ...(f.has('--endpoint') ? { endpoint: text(f, 'endpoint') } : {}),
        });
        break;
      case 'sandbox':
        adapter = new SandboxAgentAdapter(text(f, 'cmd', 'return input;'));
        break;
      default:
        throw new Error('UNKNOWN_ADAPTER');
    }
    if (f.has('--skill') || f.has('--task-type')) {
      const skillId = text(f, 'skill', adapter.skills[0]?.id ?? 'json-task');
      adapter.skills = [{ id: skillId, name: skillId,
        ...(f.has('--task-type') ? { taskTypes: [text(f, 'task-type')] } : {}),
      }];
    }
    if (allowedTaskTypes)
      adapter.skills = adapter.skills.map((skill) => ({ ...skill, taskTypes: allowedTaskTypes }));
    const relayUrl = selectedRelay();
    const key = await getKey();
    const contactFile = f.has('--contacts') ? text(f, 'contacts') : contactsPath();
    const explicitAcceptance = { ...acceptance };
    acceptance.allowedRequesterDids = [...new Set([
      ...(acceptance.allowedRequesterDids ?? []),
      ...loadContacts(contactFile, key.did).filter(c => c.allow && !c.revoked).map(c => c.ownerDid),
    ])];
    const intakeStore = new WorkerTrustStore(key, {
      path: workerIntakePath(key.did, application.identityOptions),
      fs: application.identityOptions?.fs, platform: application.identityOptions?.platform,
    });
    assertLlmAutoAccept(adapterName, automatic, acceptance, intakeStore.hasTrustedGrant());
    if (adapterName === 'claude' || adapterName === 'codex')
      assertCliAuthentication(adapterName, f.has('--cmd') ? { command: text(f, 'cmd') } : {});
    const workerRelay = new HttpRelayClient(relayUrl, application.fetch ?? fetch, key, { allowPrivateRelay, ...authRecovery,
      requestTimeoutMs: optionalCount(f, 'connect-timeout-ms') });
    const worker = new WorkerNode({
      revocation: linkRevocations(key, application.identityOptions),
      ...authRecovery,
      ...(f.has('--max-tasks-per-day') ? { dailyLimit: {
        path: join(dirname(contactsPath()), 'daily-tasks.json'),
        maxTasks: optionalCount(f, 'max-tasks-per-day')!,
      } } : {}),
      intakeStore,
      ...(f.has('--allowed-peer') ? { allowedPeerDids: text(f, 'allowed-peer').split(',').map(d => d.trim()).filter(Boolean) } : {}),
      adapterKind: LLM_ADAPTERS.has(adapterName) ? 'llm' : 'non-llm',
      automaticApproval: automatic,
      ownerApprovalProvider: process.stdin.isTTY && process.stderr.isTTY
        ? contactsApproval(contactFile, key, false, explicitAcceptance, approval(key, false, undefined, f.has('--verbose')))
        : undefined,
      checkPeer: (did) => {
        const contact = loadContacts(contactFile, key.did).find(c => c.ownerDid === did);
        if (contact?.revoked) throw new Error('CONTACT_REVOKED');
        if (automatic && contact && !contact.allow) throw new Error('CONTACT_NOT_ALLOWED');
        if (contact?.allow) return 'trusted';
      },
      identityOptions: application.identityOptions ?? {},
      deliveryOptions: { identityOptions: application.identityOptions,
        resolveTransport: url => {
          if (normalizeRelayUrl(url) !== normalizeRelayUrl(relayUrl)) throw new Error('RELAY_ENDPOINT_MISMATCH');
          return workerRelay;
        } },
      heldReview: new HeldRequestReview(key, { ...application.identityOptions,
        ...(process.stdin.isTTY && process.stderr.isTTY ? { provider: cliTaskInspection(text => new Promise<void>((resolve, reject) => {
          process.stderr.write(text + '\n', error => error ? reject(error) : resolve());
        })) } : {}) }),
      protocolPeers: new ProtocolPeerStore(key, application.identityOptions),
      connectionReview: connectionHumanReview(undefined, 'worker'),
      onConnectionEvent: event => console.error(JSON.stringify(event)),
      ...sessionTimeouts(f),
      owner: key,
      relay: workerRelay,
      inviteTtlSeconds: inviteTtl,
      relayUrl,
      adapter,
      name: text(f, 'name', adapter.name),
      approvalProvider: contactsApproval(contactFile, key, automatic, explicitAcceptance, approval(key, false, undefined, f.has('--verbose'))),
      auditPath: f.has('--audit') ? text(f, 'audit') : undefined,
      auditInterruptionFormat: f.has('--audit-interruption-format') ? 1 : undefined,
      inboxPath: f.has('--inbox') ? text(f, 'inbox') : undefined,
      onInboxRecord,
      onStatus: (status, error) => emitWorkerJson({ status, error }),
      onEvent: (event, taskId, error) => emitWorkerJson({ event, taskId,
        code: error?.code, detail: error?.detail, reason: (error as { reason?: string } | undefined)?.reason }),
      ...acceptance,
      allowPrivateRelay,
    });
    if (f.has('--preview')) {
      console.log(JSON.stringify(publicProfileSummary(worker.agentCard, acceptance.maxTasksPerRequesterPerMinute,
        optionalCount(f, 'max-tasks-per-day'), automatic, { maxInputTokens: acceptance.maxInputTokens,
          maxOutputTokens: acceptance.maxOutputTokens, maxToolInvocations: acceptance.maxToolInvocations, maxWallClockSeconds: acceptance.maxWallClockSeconds }), null, 2));
      return;
    }
    if (f.has('--wake-channel')) await workerRelay.registerWake(key.did, text(f, 'wake-channel'));
    if (acceptance.publishToRegistry) await worker.register();
    const token = worker.invite(inviteTtl);
    const invite = parseAndVerifyInviteToken(token, Date.now(), { allowPrivateRelay });
    deliverInvite(inviteOutput!, token);
    emitWorkerJson({ event: 'invite_ready', inviteDigest: inviteDigest(token),
      expiresAt: invite.expiresAt, workerDid: invite.agentDid, relay: relayUrl });
    const stop = () => worker.stop();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await worker.startDelivery();
      await worker.start({ once: f.has('--once') });
    } finally {
      worker.stopDelivery();
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
    return;
  }
  if (command === 'delegate') {
    if (f.has('--input') && f.has('--input-file'))
      throw new Error('INVALID_INPUT_OPTIONS: use exactly one of --input and --input-file');
    const input = application.pendingRequest ? application.pendingRequest.input : f.has('--input-file')
      ? readTaskInputFile(text(f, 'input-file')) : JSON.parse(text(f, 'input'));
    let outputSchema: Schema = {};
    if (f.has('--output-schema')) {
      const value = text(f, 'output-schema');
      outputSchema = JSON.parse(
        value.trim().startsWith('{') ? value : readFileSync(value, 'utf8'),
      ) as Schema;
    }
    const title = application.pendingRequest?.title ?? text(f, 'title');
    const description = application.pendingRequest?.description ?? text(f, 'description');
    const target = application.pendingRequest
      ? application.pendingRequest.to ?? ''
      : text(f, 'to', f.has('--discover') || f.has('--task-type') ? '' : undefined);
    if (f.has('--save-contact')) text(f, 'to');
    const key = await getKey();
    const workerRef = application.pendingRequest?.workerRef ??
      (target && !isInviteTarget(target) && !target.startsWith('did:') ? target : undefined);
    const to = workerRef
      ? (await InviteStore.open(key, { ...application.identityOptions, relayPolicy: { allowPrivateRelay } })).resolve(workerRef).inviteToken
      : target;
    const invite = isInviteTarget(to) ? parseAndVerifyInviteToken(to, Date.now(), { allowPrivateRelay }) : undefined;
    const relay = selectedRelay(invite?.relayUrl ?? application.pendingRelayUrl);
    if (f.has('--save-contact')) addContact(
      f.has('--contacts') ? text(f, 'contacts') : contactsPath(), key, text(f, 'to'),
      text(f, 'save-contact'), allowPrivateRelay,
    );
    const client = new RequesterClient({
      ...authRecovery,
      ...sessionTimeouts(f),
      owner: key,
      identityOptions: application.identityOptions ?? {},
      protocolPeers: new ProtocolPeerStore(key, application.identityOptions),
      connectionReview: connectionHumanReview(),
      pendingStore: new RequesterPendingStore(key, application.identityOptions),
      pendingRelayUrl: relay,
      deliveryOptions: { identityOptions: application.identityOptions,
        resolveTransport: (url, owner) => application.transportFactory?.(url, owner) ??
          new HttpRelayClient(url, application.fetch ?? fetch, owner, { allowPrivateRelay, ...authRecovery,
            requestTimeoutMs: optionalCount(f, 'connect-timeout-ms') }) },
      relay: application.transportFactory?.(relay, key) ?? new HttpRelayClient(relay as string, application.fetch ?? fetch, key, { allowPrivateRelay, ...authRecovery,
        requestTimeoutMs: optionalCount(f, 'connect-timeout-ms') }),
      approvalProvider: approval(key, automatic, undefined, f.has('--verbose')),
      auditPath: f.has('--audit') ? text(f, 'audit') : undefined,
      allowPrivateRelay,
    });
    await client.startDelivery();
    let result;
    try { result = await client.delegate({
      ...sessionTimeouts(f),
      ...(f.has('--discover') || f.has('--task-type') ? { discover: {
        ...(f.has('--discover') ? { skillId: text(f, 'discover') } : {}),
        ...(f.has('--task-type') ? { taskType: text(f, 'task-type') } : {}),
      } } : {}),
      title,
      description,
      input,
      outputSchema,
      ...application.pendingRequest,
      to,
      ...(workerRef ? { workerRef } : {}),
      ...Object.fromEntries(Object.entries(sessionTimeouts(f)).filter(([, value]) => value !== undefined)),
    }); } finally { client.stopDelivery(); }
    application.onDelegated?.();
    if (f.has('--out'))
      writeFileSync(text(f, 'out'), JSON.stringify(result.deliverable, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
    console.log(
      JSON.stringify({
        taskId: result.taskId,
        state: result.state,
        deliverable: result.deliverable,
        audit: 'VALID',
      }),
    );
    return;
  }
  throw new Error('UNKNOWN_NETWORK_COMMAND');
}
