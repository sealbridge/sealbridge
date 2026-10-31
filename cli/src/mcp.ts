// SPDX-License-Identifier: Apache-2.0
import type { KeyPair } from '@acp/core';
import { AcpMcpServer, resolveOrCreateIdentity } from '@acp/runtime';
import type { AcpMcpServerOptions } from '@acp/runtime';

const REPEATABLE = new Set(['--allow-worker', '--allow-relay']);
const KNOWN = new Set([
  '--key',
  '--relay',
  '--allow-worker',
  '--allow-relay',
  '--allow-private-relay',
  '--require-approval',
  '--approval-webhook',
]);
const USAGE =
  'Usage: sealbridge mcp-server [--key <file>] [--relay URL] [--allow-private-relay] [--allow-worker <did>] [--allow-relay <url>] [--require-approval | --approval-webhook <url>]';

function flags(args: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) throw new Error('Unexpected argument: ' + arg);
    if (!KNOWN.has(arg)) throw new Error('Unexpected argument: ' + arg);
    const next = args[i + 1];
    const value = next && !next.startsWith('--') ? args[++i] : true;
    if (REPEATABLE.has(arg)) {
      if (typeof value !== 'string' || value.trim() === '') throw new Error('Missing ' + arg);
      const previous = out.get(arg);
      out.set(arg, (typeof previous === 'string' && previous ? previous + ',' : '') + value);
      continue;
    }
    if (out.has(arg)) throw new Error('Duplicate option: ' + arg);
    out.set(arg, value);
  }
  return out;
}

function listOption(parsed: Map<string, string | true>, name: string): string[] | undefined {
  if (!parsed.has(name)) return undefined;
  const raw = parsed.get(name);
  if (typeof raw !== 'string') throw new Error('Missing ' + name);
  const values = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (values.length === 0) throw new Error('Missing ' + name);
  return values;
}

export interface ParsedMcpServerArgs {
  keyFile?: string;
  relay?: string;
  allowedWorkerDids?: string[];
  allowedRelayUrls?: string[];
  allowPrivateRelay: boolean;
  requireInteractiveApproval: boolean;
  approvalWebhookUrl?: string;
}

/** Parse `acp mcp-server` flags without reading the owner key or opening stdio. */
export function parseMcpServerArgs(args: string[]): ParsedMcpServerArgs {
  const parsed = flags(args);
  if (parsed.has('--require-approval') && parsed.has('--approval-webhook'))
    throw new Error('Use either --require-approval or --approval-webhook');
  const relay = parsed.get('--relay');
  if (parsed.has('--relay') && typeof relay !== 'string') throw new Error('Missing --relay');
  const webhook = parsed.get('--approval-webhook');
  if (parsed.has('--approval-webhook') && typeof webhook !== 'string')
    throw new Error('Missing --approval-webhook');
  const key = parsed.get('--key');
  if (parsed.has('--key') && typeof key !== 'string') throw new Error(USAGE);
  return {
    keyFile: typeof key === 'string' ? key : undefined,
    relay: typeof relay === 'string' ? relay : undefined,
    allowedWorkerDids: listOption(parsed, '--allow-worker'),
    allowedRelayUrls: listOption(parsed, '--allow-relay'),
    allowPrivateRelay: parsed.has('--allow-private-relay'),
    requireInteractiveApproval: parsed.has('--require-approval'),
    approvalWebhookUrl: typeof webhook === 'string' ? webhook : undefined,
  };
}

/** Map parsed flags onto server options. Does not read a key file or open stdio. */
export function mcpServerOptionsFromArgs(
  parsed: ParsedMcpServerArgs,
  owner?: KeyPair,
): AcpMcpServerOptions {
  return {
    owner,
    identityOptions: { explicitKeyPath: parsed.keyFile },
    relay: parsed.relay,
    allowedWorkerDids: parsed.allowedWorkerDids,
    allowedRelayUrls: parsed.allowedRelayUrls,
    allowPrivateRelay: parsed.allowPrivateRelay,
    requireInteractiveApproval: parsed.requireInteractiveApproval,
    approvalWebhookUrl: parsed.approvalWebhookUrl,
  };
}

/** `acp mcp-server` speaks MCP over stdio with an outbound allowlist and approval policy. */
export async function mcpServerCommand(args: string[]): Promise<void> {
  const parsed = parseMcpServerArgs(args);
  const server = new AcpMcpServer(mcpServerOptionsFromArgs(parsed, parsed.keyFile
    ? resolveOrCreateIdentity('requester', { explicitKeyPath: parsed.keyFile }) : undefined));
  await server.serve(process.stdin, process.stdout);
}
