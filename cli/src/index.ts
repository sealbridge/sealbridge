#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { cliName } from './distribution.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { generateKeyPair, validateSchema, signApproval } from '@acp/core';
import type { KeyPair, Gate } from '@acp/core';
import { parseAuditJsonl, verifyAuditEvidence } from '@acp/ledger';
import type { AuditEvidenceVerificationOptions } from '@acp/ledger';
import { runDemo } from '@acp/two-owner-demo';
import { networkCommand } from './network.js';
import { mcpServerCommand } from './mcp.js';
import { pendingCommand } from './pending.js';
import { connectionsCommand } from './connections.js';
import { requestsCommand } from './requests.js';
import { tasksCommand } from './tasks.js';
import { contactsCommand } from './contacts.js';
import { receiptCommand } from './receipt.js';
import { doctorCommand, parseDoctorArgs } from './doctor.js';
import { setupCommand } from './setup.js';
import { configCommand } from './config.js';
import { boardCommand } from './board.js';
import { acceptCommand } from './accept.js';
import { invitesMigrateCommand } from './invites-migrate.js';
import { formatCliError } from './error-messages.js';
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as unknown;
function parseAuditJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Parser messages may quote input. JSON bundles and anchors have no JSONL location.
    throw new SyntaxError('Invalid JSON');
  }
}
const USAGE = 'Usage: ' + cliName + ' <setup|config|doctor|keygen|validate|approve|audit-verify|receipt|contacts|connections|requests|tasks|pending|board|demo|relay|worker|delegate|discover|invite|accept|invites|mcp-server>';
const AUDIT_VERIFY_USAGE =
  'Usage: ' + cliName + ' audit-verify <audit.jsonl|bundle.json> [trust-anchor.json] ' +
  '[--expect-final-state <state>] [--expect-last-hash <hash>] [--expect-entry-count <n>] [--expect-closure-kind bilateral|interruption] [--expect-interruption-hash <hash>]\n' +
  'Exit codes: 0 bilateral VALID; 2 UNILATERALLY_CLOSED (valid:false); 1 invalid or unreadable.';
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
  expectedClosureKind?: 'bilateral' | 'interruption';
  expectedInterruptionHash?: string;
} {
  const positionals: string[] = [];
  let expectedFinalState: string | undefined;
  let expectedLastEntryHash: string | undefined;
  let expectedEntryCount: number | undefined;
  let expectedClosureKind: 'bilateral' | 'interruption' | undefined;
  let expectedInterruptionHash: string | undefined;
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
    if (arg === '--expect-closure-kind') {
      if (expectedClosureKind !== undefined) throw new Error('Duplicate option: ' + arg);
      const value = auditVerifyFlag(args, i++, arg);
      if (value !== 'bilateral' && value !== 'interruption') throw new Error('INVALID_EXPECT_CLOSURE_KIND');
      expectedClosureKind = value;
      continue;
    }
    if (arg === '--expect-interruption-hash') {
      if (expectedInterruptionHash !== undefined) throw new Error('Duplicate option: ' + arg);
      expectedInterruptionHash = auditVerifyFlag(args, i++, arg);
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
    expectedClosureKind,
    expectedInterruptionHash,
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
      if (rest.includes('--help') || rest.includes('-h'))
        console.log('Usage: ' + cliName + ' doctor [--offline] [--key <file>] [--relay <url>] [--allow-private-relay]\nReports identity backend, selection source, and presence without creating keys. Use config key-store file|keychain to persist selection; SEALBRIDGE_KEY_STORE overrides it, and --key selects a file. --offline skips the relay health request.');
      else await doctorCommand(parseDoctorArgs(rest));
      break;
    case 'setup':
      await setupCommand(rest);
      break;
    case 'config':
      await configCommand(rest);
      break;
    case 'board':
      await boardCommand(rest);
      break;
    case 'pending':
      await pendingCommand(rest);
      break;
    case 'connections':
      await connectionsCommand(rest);
      break;
    case 'requests':
      await requestsCommand(rest);
      break;
    case 'tasks':
      await tasksCommand(rest);
      break;
    case 'contacts':
      await contactsCommand(rest);
      break;
    case 'accept':
    case 'invites':
      if (command === 'invites' && rest[0] === 'migrate') await invitesMigrateCommand(rest.slice(1));
      else await acceptCommand(command, rest);
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
      if (rest.includes('--help') || rest.includes('-h')) {
        console.log('Usage: ' + cliName + ' keygen <owner.private.json>');
        break;
      }
      if (rest.length !== 1) throw new Error('Usage: ' + cliName + ' keygen <owner.private.json>');
      if (rest[0].startsWith('-')) throw new Error('Unknown option: ' + rest[0]);
      const key = generateKeyPair();
      save(rest[0], key, true);
      console.log(JSON.stringify({ did: key.did, keyFile: rest[0] }));
      break;
    }
    case 'validate': {
      if (rest.includes('--help') || rest.includes('-h')) {
        console.log('Usage: ' + cliName + ' validate [schema-name] <file.json>');
        break;
      }
      const schema = rest.length === 1 ? 'task-manifest' : rest[0],
        path = rest.length === 1 ? rest[0] : rest[1];
      if (!schema || !path) throw new Error('Usage: ' + cliName + ' validate [schema-name] <file.json>');
      validateSchema(schema, read(path));
      console.log('VALID');
      break;
    }
    case 'approve': {
      if (rest.includes('--help') || rest.includes('-h')) {
        console.log('Usage: ' + cliName + ' approve <key.private.json> <gate> <taskId> <target.json> <approval.json>');
        break;
      }
      const [keyFile, gate, taskId, targetFile, outputFile] = rest;
      if (rest.length !== 5 || !keyFile || !gate || !taskId || !targetFile || !outputFile)
        throw new Error(
          'Usage: ' + cliName + ' approve <key.private.json> <gate> <taskId> <target.json> <approval.json>',
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
      if (rest.includes('--help') || rest.includes('-h')) {
        console.log(AUDIT_VERIFY_USAGE);
        break;
      }
      const parsed = parseAuditVerifyArgs(rest);
      const input = readFileSync(parsed.input, 'utf8');
      const bundle = parsed.input.endsWith('.jsonl')
        ? parseAuditJsonl(input)
        : parseAuditJson(input);
      const options: AuditEvidenceVerificationOptions = {};
      if (parsed.anchorPath) {
        const file = parseAuditJson(readFileSync(parsed.anchorPath, 'utf8')) as AuditEvidenceVerificationOptions;
        if (!file || typeof file !== 'object' || Array.isArray(file))
          throw new Error('INVALID_TRUST_ANCHOR');
        // A positional trust-anchor file still pins taskId and actors, as before.
        options.trustAnchor = file;
        if (!bundle || typeof bundle !== 'object' || !('interruption' in bundle)) {
          options.taskId = typeof file.taskId === 'string' ? file.taskId : '';
          options.actors =
            Array.isArray(file.actors) && file.actors.length === 2
              ? (file.actors as [string, string])
              : ['', ''];
        }
        if (typeof file.head === 'string') options.head = file.head;
      }
      if (parsed.expectedFinalState !== undefined)
        options.expectedFinalState = parsed.expectedFinalState;
      if (parsed.expectedLastEntryHash !== undefined)
        options.expectedLastEntryHash = parsed.expectedLastEntryHash;
      if (parsed.expectedEntryCount !== undefined)
        options.expectedEntryCount = parsed.expectedEntryCount;
      options.expectedClosureKind = parsed.expectedClosureKind;
      options.expectedInterruptionHash = parsed.expectedInterruptionHash;
      const anchored =
        parsed.anchorPath !== undefined ||
        parsed.expectedFinalState !== undefined ||
        parsed.expectedLastEntryHash !== undefined ||
        parsed.expectedEntryCount !== undefined || parsed.expectedClosureKind !== undefined || parsed.expectedInterruptionHash !== undefined;
      const result = verifyAuditEvidence(bundle, anchored ? options : undefined);
      console.log(JSON.stringify(result));
      if (!result.valid) process.exitCode = result.status === 'UNILATERALLY_CLOSED' ? 2 : 1;
      break;
    }
    case 'demo': {
      if (rest.includes('--help') || rest.includes('-h')) {
        console.log('Usage: ' + cliName + ' demo [--audit-dir <directory>]');
        break;
      }
      if (rest.length && rest[0] !== '--audit-dir') throw new Error('Unknown option: ' + rest[0]);
      const directory = rest[1];
      if (rest.length && (!directory || directory.startsWith('-'))) throw new Error('Missing --audit-dir value');
      if (rest.length > 2) throw new Error('Usage: ' + cliName + ' demo [--audit-dir <directory>]');
      if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
      console.log(JSON.stringify(await runDemo(directory), null, 2));
      break;
    }
    default:
      throw new Error('Unknown command: ' + command + '\n' + USAGE);
  }
}
main(process.argv.slice(2)).catch((error) => {
  const exitCode = (error as { code?: string } | null)?.code === 'PENDING_OWNER_APPROVAL' ? 3 : 1;
  process.exitCode = exitCode;
  process.stderr.write(formatCliError(error) + '\n', () => {
    // A rejected stdin import must exit even if the producer keeps its pipe open.
    // Wait for the diagnostic to flush before forcing exit.
    if (process.argv[2] === 'accept' && process.argv.slice(3).includes('--stdin')) process.exit(exitCode);
  });
});
