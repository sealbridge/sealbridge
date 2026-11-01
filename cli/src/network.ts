// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inviteShareCommand } from './invite-share.js';
import { publicSettingsFlags, publicProfileSummary } from './public-settings.js';
import type { KeyPair, Schema, OpenPolicy } from '@acp/core';
import { createSignedAgentCard, createInviteToken, discoverAgentCards, isInviteTarget, parseAndVerifyInviteToken } from '@acp/core';
import { startLocalRelay, HttpRelayClient } from '@acp/relay';
import {
  WorkerNode,
  resolveOrCreateIdentity,
  selectApplicationRelay,
  readApplicationConfig,
  RequesterClient,
  PolicyAutoApprovalProvider,
  InteractiveCliApprovalProvider,
} from '@acp/runtime';
import type { LocalIdentityOptions, AgentAdapter, ApprovalProvider, WorkerAcceptancePolicy, SessionTimeoutOptions } from '@acp/runtime';
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
import { japaneseErrorReason } from './error-messages.js';
const REPEATABLE = new Set(['--allow-requester', '--open-allow-task-type']);
const LLM_ADAPTERS = new Set(['claude', 'codex', 'openai']);
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
  return automatic
    ? new PolicyAutoApprovalProvider(key, undefined, { acceptance })
    : new InteractiveCliApprovalProvider(key, { output: process.stderr,
      ...(verbose ? {} : { formatRequest: approvalSummary }) });
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
  --to <invite|link|did>          Delegate: accepts https://sealbridge.app/i#acp-invite:... links.
  --invite-ttl <seconds>          Worker invite lifetime (default: 86400 / 24h; range: 1–2592000).
                                 Startup prints both the token and a ready-to-share HTTPS link.
  --verbose                     Full approval JSON instead of concise summaries (default: off).
Claude/Codex workers require a host ANTHROPIC_API_KEY / OPENAI_API_KEY.
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
    allowAnyRequester: parsed.has('--allow-any-requester'),
    maxInputTokens: optionalCount(parsed, 'max-input-tokens'),
    maxOutputTokens: optionalCount(parsed, 'max-output-tokens'),
    maxToolInvocations: optionalCount(parsed, 'max-tool-invocations'),
    maxWallClockSeconds: optionalCount(parsed, 'max-wall-clock-seconds'),
    maxConcurrentTasks: optionalCount(parsed, 'max-concurrent-tasks'),
    maxTasksPerRequesterPerMinute: optionalCount(parsed, 'max-requests-per-minute'),
    publishToRegistry: parsed.has('--publish'),
  };
}
function openRateLimit(parsed: Map<string, string | true>): number | undefined {
  const raw = parsed.get('--open-rate-limit-per-did');
  if (raw === undefined) return undefined;
  const match = typeof raw === 'string' ? /^([1-9]\d*)(?:\/(?:m|min|60s))?$/.exec(raw) : null;
  if (!match || !Number.isSafeInteger(Number(match[1])))
    throw new Error('INVALID_OPEN_RATE_LIMIT_PER_DID');
  return Number(match[1]);
}
function assertLlmAutoAccept(
  adapter: string,
  automatic: boolean,
  acceptance: WorkerAcceptancePolicy,
): void {
  if (!automatic || !LLM_ADAPTERS.has(adapter)) return;
  if (acceptance.allowAnyRequester || (acceptance.allowedRequesterDids?.length ?? 0) > 0) return;
  throw new Error(
    'LLM_AUTO_ACCEPT_REQUIRES_ALLOWLIST: --auto-accept with the ' +
      adapter +
      ' adapter can spend the worker owner API key. Pass --allow-requester <did> ' +
      '(repeatable or comma-separated) or --allow-any-requester.',
  );
}
export async function networkCommand(command: string, args: string[], application: {
  identityOptions?: LocalIdentityOptions; fetch?: typeof fetch;
} = {}): Promise<void> {
  if (args.includes('--help') && ['delegate', 'worker', 'relay'].includes(command)) {
    console.log(command === 'relay' ? `Relay notification options:
  --wake-command <command>       Opt-in wake hook, signed routing JSON on stdin (default: off).
  --wake-relay <url>             Advertised relay URL; required with --wake-command.
  --wake-max-attempts <n>        Maximum wake attempts (default: 5).
  --wake-retry-base-ms <n>       Exponential retry base, capped at 60000ms (default: 1000).
  --wake-timeout-ms <n>          Per-attempt timeout (default: 5000).
  --notification-key <file>      Persistent signing key (default: ephemeral local identity).
  --notification-ttl-ms <n>      Wake registration/dedup and expiry notice retention (default: 3600000).
  --envelope-ttl-ms <n>          Undelivered envelope TTL (default: 600000).` : TIMEOUT_HELP + REVIEW_HELP + `
  --wake-channel <name>          Worker: register an operator channel on startup (default: off).
                                 The local relay CLI provides channel "default".`);
    return;
  }
  const sub = ['relay', 'worker', 'invite'].includes(command) ? args.shift() : undefined;
  if (command === 'worker' && sub === 'public') {
    const index = args.indexOf('--settings');
    if (index < 0 || !args[index + 1]) throw new Error('Missing --settings');
    const settings = JSON.parse(readFileSync(args[index + 1], 'utf8'));
    args.splice(index, 2);
    if (args.some(a => ['--open','--publish','--auto-accept','--auto-approve','--yes','--allow-any-requester','--access-mode'].includes(a) || a.startsWith('--open-') || a === '--max-tasks-per-day'))
      throw new Error('CONFLICTING_PUBLIC_SETTINGS');
    return networkCommand('worker', ['start', ...args, ...publicSettingsFlags(settings)], application);
  }
  if (command === 'invite' && sub !== 'create') return inviteShareCommand(sub ?? '', args);
  if ((command === 'relay' || command === 'worker') && sub !== 'start')
    throw new Error('Expected ' + command + ' start');
  const f = flags(args);
  const allowPrivateRelay = f.has('--allow-private-relay');
  if (command === 'relay') {
    const port = Number(text(f, 'port', '8787'));
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_PORT');
    const relay = await startLocalRelay({ port, host: text(f, 'host', '127.0.0.1'), relayOptions: {
      envelopeTtlMs: optionalCount(f, 'envelope-ttl-ms'),
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
  const key = resolveOrCreateIdentity(command === 'delegate' ? 'requester' : 'worker', {
    ...application.identityOptions,
    explicitKeyPath: f.has('--key') ? text(f, 'key') : undefined,
  });
  if (command === 'invite') {
    // Local signing retains the explicit URL; connection policy applies when dialing.
    const relayUrl = text(f, 'relay', fallbackCandidates[0]);
    const card = createSignedAgentCard(
      {
        name: text(f, 'name', 'Sealbridge Worker'),
        agentDid: key.did,
        relayEndpoint: relayUrl,
        skills: [{ id: 'json-task', name: 'JSON task' }],
      },
      key,
    );
    console.log(
      createInviteToken(
        { agentCard: card, expiresInSeconds: Number(text(f, 'expires-in', '3600')) },
        key,
      ),
    );
    return;
  }
  const automatic = ['yes', 'auto-accept', 'auto-approve'].some((name) => f.has('--' + name));
  if (command === 'worker') {
    const accessMode = text(f, 'access-mode', f.has('--open') ? 'open' : 'invite-only');
    if (!['invite-only', 'open'].includes(accessMode) || (f.has('--open') && accessMode !== 'open'))
      throw new Error('INVALID_ACCESS_MODE');
    const onInboxRecord = f.has('--on-receive')
      ? createReceiveHook(text(f, 'on-receive')) : undefined;
    if (onInboxRecord && !f.has('--inbox')) throw new Error('--on-receive requires --inbox');
    const adapterName = text(f, 'adapter', 'sandbox');
    const inviteTtl = optionalCount(f, 'invite-ttl') ?? 86400;
    if (inviteTtl > 2592000) throw new Error('INVALID_INVITE_TTL: expected 1–2592000 seconds');
    const acceptance = workerAcceptance(f);
    const contactFile = f.has('--contacts') ? text(f, 'contacts') : contactsPath();
    const explicitAcceptance = { ...acceptance };
    acceptance.allowedRequesterDids = [...new Set([
      ...(acceptance.allowedRequesterDids ?? []),
      ...loadContacts(contactFile, key.did).filter(c => c.allow && !c.revoked).map(c => c.ownerDid),
    ])];
    const rateLimit = openRateLimit(f);
    const allowedTaskTypes = f.has('--open-allow-task-type')
      ? [...new Set(text(f, 'open-allow-task-type').split(',').map((value) => value.trim()))]
      : undefined;
    if (allowedTaskTypes?.some((value) => !value))
      throw new Error('INVALID_OPEN_ALLOW_TASK_TYPE');
    if ((allowedTaskTypes || rateLimit !== undefined) && accessMode !== 'open')
      throw new Error('OPEN_POLICY_REQUIRES_OPEN_MODE');
    if (allowedTaskTypes && f.has('--task-type') && !allowedTaskTypes.includes(text(f, 'task-type')))
      throw new Error('CONFLICTING_OPEN_TASK_TYPE');
    if (rateLimit !== undefined)
      acceptance.maxTasksPerRequesterPerMinute = Math.min(
        acceptance.maxTasksPerRequesterPerMinute ?? rateLimit, rateLimit);
    const openPolicy: OpenPolicy = {};
    const openFlags = {
      maxInputTokens: 'open-max-input-tokens',
      maxOutputTokens: 'open-max-output-tokens',
      maxToolInvocations: 'open-max-tool-calls',
      maxWallClockSeconds: 'open-max-wall-seconds',
    } as const;
    for (const field of Object.keys(openFlags) as (keyof OpenPolicy)[]) {
      const limit = optionalCount(f, openFlags[field]);
      if (limit !== undefined) openPolicy[field] = limit;
    }
    if (Object.keys(openPolicy).length && accessMode !== 'open')
      throw new Error('OPEN_POLICY_REQUIRES_OPEN_MODE');
    if (accessMode === 'open') for (const field of Object.keys(openFlags) as (keyof OpenPolicy)[]) {
      const general = acceptance[field];
      if (general !== undefined) openPolicy[field] = Math.min(openPolicy[field] ?? general, general);
    }
    assertLlmAutoAccept(adapterName, automatic, acceptance);
    if (adapterName === 'claude' || adapterName === 'codex')
      assertCliAuthentication(adapterName, f.has('--cmd') ? { command: text(f, 'cmd') } : {});
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
    const workerRelay = new HttpRelayClient(relayUrl, application.fetch ?? fetch, key, { allowPrivateRelay,
      requestTimeoutMs: optionalCount(f, 'connect-timeout-ms') });
    const worker = new WorkerNode({
      ...(f.has('--max-tasks-per-day') ? { dailyLimit: {
        path: join(dirname(contactsPath()), 'daily-tasks.json'),
        maxTasks: optionalCount(f, 'max-tasks-per-day')!,
      } } : {}),
      accessMode: accessMode as 'invite-only' | 'open',
      ...(Object.keys(openPolicy).length ? { openPolicy } : {}),
      ...sessionTimeouts(f),
      owner: key,
      relay: workerRelay,
      inviteTtlSeconds: inviteTtl,
      relayUrl,
      adapter,
      name: text(f, 'name', adapter.name),
      approvalProvider: contactsApproval(contactFile, key, automatic, explicitAcceptance, approval(key, false, undefined, f.has('--verbose'))),
      auditPath: f.has('--audit') ? text(f, 'audit') : undefined,
      inboxPath: f.has('--inbox') ? text(f, 'inbox') : undefined,
      onInboxRecord,
      onStatus: (status, error) => console.error(JSON.stringify({ status, ...(error ? { error: error.message, reasonJa: japaneseErrorReason(error.message) } : {}) })),
      onEvent: (event, taskId, error) => console.error(JSON.stringify({ event, taskId, ...error,
        ...(error ? { reasonJa: japaneseErrorReason(error.code) } : {}) })),
      ...acceptance,
      allowPrivateRelay,
    });
    if (f.has('--preview')) {
      console.log(JSON.stringify(publicProfileSummary(worker.agentCard, acceptance.maxTasksPerRequesterPerMinute,
        optionalCount(f, 'max-tasks-per-day'), automatic), null, 2));
      return;
    }
    if (f.has('--wake-channel')) await workerRelay.registerWake(key.did, text(f, 'wake-channel'));
    if (acceptance.publishToRegistry) await worker.register();
    if (accessMode === 'open' && automatic && !acceptance.allowedRequesterDids?.length)
      console.error(`[Sealbridge WARNING] Worker started in --open mode with ${f.has('--yes') ? '--yes' : 'automatic approval'} and no requester allowlist. Any requester can submit tasks for automatic acceptance within configured limits.`);
    const token = worker.invite(inviteTtl);
    console.log(token);
    console.log('https://sealbridge.app/i#' + token);
    const stop = () => worker.stop();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await worker.start({ once: f.has('--once') });
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
    return;
  }
  if (command === 'delegate') {
    if (f.has('--input') && f.has('--input-file'))
      throw new Error('INVALID_INPUT_OPTIONS: use exactly one of --input and --input-file');
    const input = f.has('--input-file')
      ? readTaskInputFile(text(f, 'input-file')) : JSON.parse(text(f, 'input'));
    if (f.has('--save-contact')) addContact(
      f.has('--contacts') ? text(f, 'contacts') : contactsPath(), key, text(f, 'to'),
      text(f, 'save-contact'), allowPrivateRelay,
    );
    let outputSchema: Schema = {};
    if (f.has('--output-schema')) {
      const value = text(f, 'output-schema');
      outputSchema = JSON.parse(
        value.trim().startsWith('{') ? value : readFileSync(value, 'utf8'),
      ) as Schema;
    }
    const to = text(f, 'to', f.has('--discover') || f.has('--task-type') ? '' : undefined);
    const invite = isInviteTarget(to) ? parseAndVerifyInviteToken(to, Date.now(), { allowPrivateRelay }) : undefined;
    const relay = selectedRelay(invite?.relayUrl);
    const client = new RequesterClient({
      ...sessionTimeouts(f),
      owner: key,
      relay: new HttpRelayClient(relay as string, application.fetch ?? fetch, key, { allowPrivateRelay,
        requestTimeoutMs: optionalCount(f, 'connect-timeout-ms') }),
      approvalProvider: approval(key, automatic, undefined, f.has('--verbose')),
      auditPath: f.has('--audit') ? text(f, 'audit') : undefined,
      allowPrivateRelay,
    });
    const result = await client.delegate({
      ...sessionTimeouts(f),
      to,
      ...(f.has('--discover') || f.has('--task-type') ? { discover: {
        ...(f.has('--discover') ? { skillId: text(f, 'discover') } : {}),
        ...(f.has('--task-type') ? { taskType: text(f, 'task-type') } : {}),
      } } : {}),
      title: text(f, 'title'),
      description: text(f, 'description'),
      input,
      outputSchema,
    });
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
