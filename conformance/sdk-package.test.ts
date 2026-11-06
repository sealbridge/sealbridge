// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as source from '../cli/src/sdk.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
const run = promisify(execFile);
let fixture: string, installed: string;
function write(path: string, value: string) {
  writeFileSync(path + '.tmp', value, { mode: 0o600, flag: 'wx' });
  renameSync(path + '.tmp', path);
}
beforeAll(async () => {
  // Use the same preparation as prepack without creating a tarball or publishing.
  await run(process.execPath, ['scripts/package-cli.mjs'], { cwd: repository, timeout: 60_000 });
  fixture = mkdtempSync(join(realpathSync(tmpdir()), 'sealbridge-sdk-package-'));
  installed = join(fixture, 'node_modules', 'sealbridge');
  mkdirSync(installed, { recursive: true, mode: 0o700 });
  write(join(installed, 'package.json'), JSON.stringify(manifest));
  for (const entry of manifest.files) cpSync(join(repository, entry), join(installed, entry), { recursive: true });
  // Only published dependencies are available; workspace @acp packages are absent.
  for (const name of [...Object.keys(manifest.dependencies), '@types/node']) {
    const target = join(fixture, 'node_modules', name);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    symlinkSync(realpathSync(join(repository, 'node_modules', name)), target, 'junction');
  }
  write(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
}, 60_000);
afterAll(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });

it('resolves the SDK and legacy paths from the prepared package without import side effects', async () => {
  expect(manifest.exports['./sdk']).toEqual({ types: './dist/cli/dist/sdk.d.ts', import: './dist/cli/dist/sdk.js' });
  for (const target of Object.values(manifest.exports['./sdk']) as string[]) expect(existsSync(join(installed, target))).toBe(true);
  for (const target of Object.values(manifest.bin) as string[]) expect(existsSync(join(installed, target))).toBe(true);
  write(join(fixture, 'consumer.mjs'), `
    import { existsSync, writeFileSync, renameSync } from 'node:fs';
    globalThis.fetch = () => { throw new Error('Unexpected network call'); };
    const sdk = await import('sealbridge/sdk');
    const legacy = await import('sealbridge/dist/packages/runtime/dist/invite-store.js');
    if (sdk.InviteStore !== legacy.InviteStore) throw new Error('Export identity differs');
    if (existsSync(process.env.SEALBRIDGE_DATA_DIR)) throw new Error('Import created application state');
    const core = await import('sealbridge/dist/packages/core/dist/index.js');
    const owner = sdk.generateKeyPair(), requester = sdk.generateKeyPair();
    const manifest = sdk.buildTaskManifest({ ownerDid: requester.did, workerDid: owner.did, title: 'Review', description: 'Read text' });
    const input = 'system prompt';
    const report = await sdk.inspectRuleContent({ manifest, input });
    if (report.verdict !== 'warn' || report.rulesetDigest !== sdk.CONTENT_INSPECTION_RULESET_DIGEST) throw new Error('Scanner export differs');
    let received = 0;
    const provider = sdk.createRuleBasedContentReviewProvider({ onReport: (_id, report) => {
      if (report.verdict !== 'warn') throw new Error('Child report differs'); received++;
    } });
    const body = { proposal: core.signPayload(manifest, requester), input };
    const envelope = core.signEnvelope({ taskId: manifest.taskId, seq: 0, eventType: 'PROPOSE', recipientDid: owner.did, payload: body }, requester, { encrypt: true });
    const result = await provider.inspect(envelope, { owner, recordId: 'packaged-review', kind: 'task',
      contentDigest: core.digest({ manifest, input }), envelopeDigest: core.digest(envelope) }, new AbortController().signal);
    if (result.status !== 'complete' || received !== 1) throw new Error('Packaged child did not complete');

    writeFileSync('sdk-exports.json.tmp', JSON.stringify(Object.keys(sdk).sort()), { mode: 0o600, flag: 'wx' });
    renameSync('sdk-exports.json.tmp', 'sdk-exports.json');
  `);
  await run(process.execPath, ['consumer.mjs'], { cwd: fixture, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, SEALBRIDGE_DATA_DIR: join(fixture, 'unused-data') } });
  expect(JSON.parse(readFileSync(join(fixture, 'sdk-exports.json'), 'utf8'))).toEqual(Object.keys(source).sort());
  for (const target of Object.values(manifest.bin) as string[]) {
    await run(process.execPath, [join(installed, target), '--help'], { cwd: fixture, timeout: 60_000,
      env: { ...process.env, SEALBRIDGE_DATA_DIR: join(fixture, 'unused-data') } });
  }
  expect(existsSync(join(fixture, 'unused-data'))).toBe(false);
});

it('resolves SDK declarations and their workspace references for a downstream TypeScript consumer', async () => {
  const declarations = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? declarations(path) : entry.name.endsWith('.d.ts') ? [path] : [];
  });
  for (const path of declarations(join(installed, 'dist'))) expect(readFileSync(path, 'utf8')).not.toMatch(/['"]@acp\//);
  write(join(fixture, 'consumer.mts'), `
    import {
      AcpMcpServer, ConnectionService, ConnectionRouter, StoredConnectionExchange, ConnectionAdmissionReview, InviteStore,
      WorkerTrustStore, HeldRequestReview, inspectRuleContent, createRuleBasedContentReviewProvider,
      CONTENT_INSPECTION_RULES, CONTENT_INSPECTION_LIMITS, CONTENT_INSPECTION_RULESET_VERSION, CONTENT_INSPECTION_RULESET_DIGEST, KeychainSecretStore, resolveStoredIdentity, resolveDataRoot,
      connectionsCommand, connectionHumanReview, mcpServerCommand, parseMcpServerArgs,
      mcpServerOptionsFromArgs, parseAndVerifyInviteToken, parseJsonl, verifyAudit, parseAuditJsonl, verifyAuditEvidence, createAuditInterruption,
      generateInviteLinkKey, deriveInviteLinkKeys, inviteLinkClaimTag, inviteLinkExpiry,
      encryptInviteLink, decryptInviteLink, packInviteLinkCiphertext, unpackInviteLinkCiphertext,
      parseInviteLink, inviteLinkVerificationNumber,
    } from 'sealbridge/sdk';
    import type {
      SavedInvite, SecretStore, KeyStore, IdentityStoreOptions, DataRootOptions, KeyringModule,
      ConnectionServiceOptions, ConnectionHumanReviewProvider, ConnectionRouterOptions,
      ConnectionAdmissionReviewOptions, InboundConnectionSummary,
      ConnectionsCommandOptions, AcpMcpServerOptions, HeldContentReviewProvider, RelayTransport,
      RuleInspectionInput, RuleInspectionOptions, RuleInspectionFinding, RuleInspectionReport, RuleInspectionRule,
      RuleInspectionKind, RuleInspectionDiagnosticCode, RuleBasedContentReviewOptions,
      AuditBundle, AuditEvidence, AuditInterruption, InterruptedAuditBundle, AuditEvidenceVerificationResult, InterruptionStore,
      InviteLinkKeys, InviteLinkCiphertext, InviteLinkStorage, InviteLinkRelayPolicy, ParsedInviteLink,
    } from 'sealbridge/sdk';
    async function rules(content: RuleInspectionInput) {
      const limits: RuleInspectionOptions = { maxFindings: 20 };
      const options: RuleBasedContentReviewOptions = { limits, timeoutMs: 5000,
        onReport: (_id: string, report: RuleInspectionReport) => { const findings: RuleInspectionFinding[] = report.findings; } };
      const provider: HeldContentReviewProvider = createRuleBasedContentReviewProvider(options);
      const rules: readonly RuleInspectionRule[] = CONTENT_INSPECTION_RULES;
      const kind: RuleInspectionKind = 'injection', diagnostic: RuleInspectionDiagnosticCode = 'ABORTED';
      const report: RuleInspectionReport = await inspectRuleContent(content, limits, new AbortController().signal);
      return { provider, report, rules, kind, diagnostic, version: CONTENT_INSPECTION_RULESET_VERSION,
        digest: CONTENT_INSPECTION_RULESET_DIGEST, defaults: CONTENT_INSPECTION_LIMITS };
    }
    function inviteLink(token: string, inviteDigest: string) {
      const k = generateInviteLinkKey();
      const keys: InviteLinkKeys = deriveInviteLinkKeys(k);
      const deadlines = inviteLinkExpiry();
      const encrypted: InviteLinkCiphertext = encryptInviteLink(token, k, {
        relayOrigin: 'https://relay.sealbridge.dev', expiresAt: deadlines.expiresAt,
      });
      const storage: InviteLinkStorage = packInviteLinkCiphertext(encrypted);
      const policy: InviteLinkRelayPolicy = { allowedRelayUrls: ['https://relay.sealbridge.dev'] };
      const parsed: ParsedInviteLink = parseInviteLink('https://sealbridge.app/j#v=1&k=' + k, policy);
      return {
        token: decryptInviteLink(unpackInviteLinkCiphertext(storage), k, parsed.relayOrigin),
        tag: inviteLinkClaimTag(keys.accessKey, keys.id), number: inviteLinkVerificationNumber(inviteDigest),
      };
    }
    function audit(text: string, store: InterruptionStore, interrupted: InterruptedAuditBundle) {
      const bilateral: AuditBundle = parseJsonl(text);
      const evidence: AuditEvidence = parseAuditJsonl(text);
      const report: AuditEvidenceVerificationResult = verifyAuditEvidence(evidence, { expectedClosureKind: 'interruption' });
      const observation: AuditInterruption = interrupted.interruption.payload;
      store.closeInterrupted(interrupted, () => {});
      // @ts-expect-error The old bundle still requires its bilateral checkpoint.
      const oldBundle: AuditBundle = interrupted;
      return { report, observation, oldReport: verifyAudit(bilateral) };
    }
    function admission(options: ConnectionAdmissionReviewOptions): InboundConnectionSummary[] {
      const queue = new ConnectionAdmissionReview(options);
      const rows = queue.list();
      const name: string | undefined = rows[0]?.peerDisplayName;
      return rows;
    }
    const unnamed: Pick<InboundConnectionSummary, 'peerDisplayName'> = {};
    const root: DataRootOptions = { env: { SEALBRIDGE_DATA_DIR: '/example' } };
    const secrets: SecretStore = { get: () => undefined, set: () => {}, delete: () => {} };
    const identity: IdentityStoreOptions = { ...root, keyStore: 'keychain' };
    async function host(saved: SavedInvite, review: (summary: string) => Promise<boolean>) {
      const owner = await resolveStoredIdentity('requester', identity);
      const invites = await InviteStore.open(owner, { ...identity, secretStore: secrets });
      const listed: SavedInvite[] = invites.list();
      const options: ConnectionsCommandOptions = { identityOptions: identity, review };
      await connectionsCommand(['confirm-invite', saved.workerRef], options);
      const mcpOptions: AcpMcpServerOptions = mcpServerOptionsFromArgs(parseMcpServerArgs(['--require-approval']), owner, identity);
      const server: AcpMcpServer = new AcpMcpServer(mcpOptions);
      const trust = new WorkerTrustStore(owner);
      const connections = trust.listConnections();
      // @ts-expect-error SavedInvite metadata omits invitation strings.
      const token = saved.inviteToken;
      // @ts-expect-error Store selection is a bounded choice or a KeyStore implementation.
      const invalid: IdentityStoreOptions = { keyStore: 'other' };
      return { listed, connections, server };
    }
  `);
  write(join(fixture, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    noEmit: true, skipLibCheck: true, types: ['node'],
  }, files: ['consumer.mts'] }));
  await run(process.execPath, [join(repository, 'node_modules/typescript/bin/tsc'), '-p', join(fixture, 'tsconfig.json')],
    { cwd: fixture, encoding: 'utf8', timeout: 60_000 });
}, 60_000);
