#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { generateKeyPair, validateSchema, signApproval } from '@acp/core';
import type { KeyPair, Gate } from '@acp/core';
import { parseJsonl, verifyAudit } from '@acp/ledger';
import type { AuditBundle, AuditVerificationOptions } from '@acp/ledger';
import { runDemo } from '@acp/two-owner-demo';
import { networkCommand } from './network.js';
import { mcpServerCommand } from './mcp.js';
import { requestsCommand } from './requests.js';
import { contactsCommand } from './contacts.js';
import { receiptCommand } from './receipt.js';
import { doctorCommand, parseDoctorArgs } from './doctor.js';
import { setupCommand } from './setup.js';
import { boardCommand } from './board.js';
import { formatCliError } from './error-messages.js';
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as unknown;
const USAGE = 'Usage: sealbridge <setup|doctor|keygen|validate|approve|audit-verify|receipt|contacts|requests|board|demo|relay|worker|delegate|discover|invite|mcp-server>';
const AUDIT_VERIFY_USAGE =
  'Usage: sealbridge audit-verify <audit.jsonl|bundle.json> [trust-anchor.json] ' +
  '[--expect-final-state <state>] [--expect-last-hash <hash>] [--expect-entry-count <n>]';
function auditVerifyFlag(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error('Missing ' + name);
  return value;
}
function parseAuditVerifyArgs(args: string[]): {
  input: string;
  anchorPath?: string;
  expectedFinalState?: string;
  expectedLastEntryHash?: string;
  expectedEntryCount?: number;
} {
  const positionals: string[] = [];
  let expectedFinalState: string | undefined;
  let expectedLastEntryHash: string | undefined;
  let expectedEntryCount: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--expect-final-state') {
      if (expectedFinalState !== undefined) throw new Error('Duplicate option: ' + arg);
      expectedFinalState = auditVerifyFlag(args, i, arg);
      i++;
      continue;
    }
    if (arg === '--expect-last-hash') {
      if (expectedLastEntryHash !== undefined) throw new Error('Duplicate option: ' + arg);
      expectedLastEntryHash = auditVerifyFlag(args, i, arg);
      i++;
      continue;
    }
    if (arg === '--expect-entry-count') {
      if (expectedEntryCount !== undefined) throw new Error('Duplicate option: ' + arg);
      const raw = auditVerifyFlag(args, i, arg);
      if (!/^(0|[1-9]\d*)$/.test(raw)) throw new Error('INVALID_EXPECT_ENTRY_COUNT');
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed)) throw new Error('INVALID_EXPECT_ENTRY_COUNT');
      expectedEntryCount = parsed;
      i++;
      continue;
    }
    if (arg.startsWith('--')) throw new Error('Unknown option: ' + arg);
    positionals.push(arg);
  }
  if (positionals.length < 1 || positionals.length > 2) throw new Error(AUDIT_VERIFY_USAGE);
  return {
    input: positionals[0],
    anchorPath: positionals[1],
    expectedFinalState,
    expectedLastEntryHash,
    expectedEntryCount,
  };
}
function save(path: string, value: unknown, privateFile = false) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', {
    mode: privateFile ? 0o600 : 0o644,
    flag: 'wx',
  });
}
async function main(args: string[]) {
  const [command, ...rest] = args;
  switch (command) {
    case undefined:
      console.error(USAGE);
      process.exitCode = 1;
      break;
    case '--help':
    case '-h':
    case 'help':
      console.log(USAGE);
      break;
    case '--version':
    case '-v':
      console.log(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
      break;
    case 'doctor':
      if (rest.length === 1 && rest[0] === '--help')
        console.log('Usage: sealbridge doctor [--offline] [--key <file>]\nInspects persisted identities without creating keys. --offline skips the relay health request.');
      else await doctorCommand(parseDoctorArgs(rest));
      break;
    case 'setup':
      await setupCommand(rest);
      break;
    case 'board':
      await boardCommand(rest);
      break;
    case 'requests':
      await requestsCommand(rest);
      break;
    case 'contacts':
      contactsCommand(rest);
      break;
    case 'receipt':
      receiptCommand(rest);
      break;
    case 'relay':
    case 'worker':
    case 'delegate':
    case 'discover':
    case 'invite':
      await networkCommand(command, rest);
      break;
    case 'mcp-server':
      await mcpServerCommand(rest);
      break;
    case 'keygen': {
      if (rest.length !== 1) throw new Error('Usage: sealbridge keygen <owner.private.json>');
      const key = generateKeyPair();
      save(rest[0], key, true);
      console.log(JSON.stringify({ did: key.did, keyFile: rest[0] }));
      break;
    }
    case 'validate': {
      const schema = rest.length === 1 ? 'task-manifest' : rest[0],
        path = rest.length === 1 ? rest[0] : rest[1];
      if (!schema || !path) throw new Error('Usage: sealbridge validate [schema-name] <file.json>');
      validateSchema(schema, read(path));
      console.log('VALID');
      break;
    }
    case 'approve': {
      const [keyFile, gate, taskId, targetFile, outputFile] = rest;
      if (!keyFile || !gate || !taskId || !targetFile || !outputFile)
        throw new Error(
          'Usage: sealbridge approve <key.private.json> <gate> <taskId> <target.json> <approval.json>',
        );
      if (
        ![
          'contract_acceptance',
          'external_side_effect',
          'budget_increase',
          'redelegation',
          'final_verification',
        ].includes(gate)
      )
        throw new Error('INVALID_GATE');
      const receipt = signApproval(
        taskId,
        gate as Gate,
        read(targetFile),
        read(keyFile) as KeyPair,
      );
      validateSchema('approval-receipt', receipt);
      save(outputFile, receipt);
      console.log(JSON.stringify({ receiptId: receipt.payload.receiptId, outputFile }));
      break;
    }
    case 'audit-verify': {
      const parsed = parseAuditVerifyArgs(rest);
      const input = readFileSync(parsed.input, 'utf8');
      const bundle = parsed.input.endsWith('.jsonl')
        ? parseJsonl(input)
        : (JSON.parse(input) as AuditBundle);
      const options: AuditVerificationOptions = {};
      if (parsed.anchorPath) {
        const file = read(parsed.anchorPath) as AuditVerificationOptions;
        if (!file || typeof file !== 'object' || Array.isArray(file))
          throw new Error('INVALID_TRUST_ANCHOR');
        // A positional trust-anchor file still pins taskId and actors, as before.
        options.trustAnchor = file;
        options.taskId = typeof file.taskId === 'string' ? file.taskId : '';
        options.actors =
          Array.isArray(file.actors) && file.actors.length === 2
            ? (file.actors as [string, string])
            : ['', ''];
        if (typeof file.head === 'string') options.head = file.head;
      }
      if (parsed.expectedFinalState !== undefined)
        options.expectedFinalState = parsed.expectedFinalState;
      if (parsed.expectedLastEntryHash !== undefined)
        options.expectedLastEntryHash = parsed.expectedLastEntryHash;
      if (parsed.expectedEntryCount !== undefined)
        options.expectedEntryCount = parsed.expectedEntryCount;
      const anchored =
        parsed.anchorPath !== undefined ||
        parsed.expectedFinalState !== undefined ||
        parsed.expectedLastEntryHash !== undefined ||
        parsed.expectedEntryCount !== undefined;
      const result = verifyAudit(bundle, anchored ? options : undefined);
      console.log(JSON.stringify(result));
      if (!result.valid) process.exitCode = 1;
      break;
    }
    case 'demo': {
      const index = rest.indexOf('--audit-dir'),
        directory = index >= 0 ? rest[index + 1] : undefined;
      if (index >= 0 && !directory) throw new Error('Missing --audit-dir value');
      if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
      console.log(JSON.stringify(await runDemo(directory), null, 2));
      break;
    }
    default:
      throw new Error('Unknown command: ' + command + '\n' + USAGE);
  }
}
main(process.argv.slice(2)).catch((error) => {
  console.error(formatCliError(error));
  process.exitCode = (error as { code?: string } | null)?.code === 'PENDING_OWNER_APPROVAL' ? 3 : 1;
});
