// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
describe.each(['sealbridge', 'sealbridge-local'])('%s standalone package', packageName => {
const packageRoot = packageName === 'sealbridge' ? repository : join(repository, 'dist-local');
let fixture: string, installed: string;
function write(path: string, value: string) {
  writeFileSync(path + '.tmp', value, { mode: 0o600, flag: 'wx' });
  renameSync(path + '.tmp', path);
}
beforeAll(async () => {
  // Use the same preparation as prepack without creating a tarball or publishing.
  await run(process.execPath, ['scripts/package-cli.mjs'], { cwd: repository, timeout: 60_000 });
  fixture = mkdtempSync(join(realpathSync(tmpdir()), 'sealbridge-sdk-package-'));
  installed = join(fixture, 'node_modules', packageName);
  mkdirSync(installed, { recursive: true, mode: 0o700 });
  const packagedManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  expect(packagedManifest.bin).toEqual(packageName === 'sealbridge' ? manifest.bin : { 'sealbridge-local': './dist/cli/dist/index.js' });
  write(join(installed, 'package.json'), JSON.stringify(packagedManifest));
  for (const entry of manifest.files) cpSync(join(packageRoot, entry), join(installed, entry), { recursive: true });
  // Only published dependencies are available; workspace @acp packages are absent.
  for (const name of [...Object.keys(manifest.dependencies), '@types/node']) {
    const target = join(fixture, 'node_modules', name);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    symlinkSync(realpathSync(join(repository, 'node_modules', name)), target, 'junction');
  }
  write(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
}, 60_000);
afterAll(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });

it('starts both CLI entry points and passes npm publication preflight', async () => {
  const cli = join(installed, 'dist/cli/dist/index.js');
  expect((await run(process.execPath, [cli, '--version'], { cwd: fixture })).stdout.trim()).toBe(manifest.version);
  expect((await run(process.execPath, [cli, 'worker', 'start', '--help'], { cwd: fixture })).stdout).toContain('worker start');
  // pnpm's npm-compatible publish command could contact the registry: use npm's CLI.
  const { execPath } = process;
  const npm = process.platform === 'win32' ? join(dirname(execPath), 'node_modules/npm/bin/npm-cli.js') : undefined;
  if (npm && existsSync(npm)) {
    await run(execPath, [npm, 'publish', '--dry-run', '--ignore-scripts', '--access', 'public', '--offline', '--registry', 'https://package-preflight.invalid'], { cwd: installed, timeout: 60_000 });
  } else {
    await run('npm', ['publish', '--dry-run', '--ignore-scripts', '--access', 'public', '--offline', '--registry', 'https://package-preflight.invalid'], { cwd: installed, timeout: 60_000 });
  }
}, 60_000);

it('uses the same data root and worker identity but grants saved permission only to local', async () => {
  const dataRoot = join(fixture, 'shared-data');
  const env = { ...process.env, SEALBRIDGE_DATA_DIR: dataRoot, SEALBRIDGE_KEY_STORE: 'file' };
  write(join(fixture, 'seed.mjs'), `
    import { resolveStoredIdentity } from '${packageName}/sdk';
    import { setApplicationLocalPcExecution } from '${packageName}/dist/packages/runtime/dist/application-config.js';
    import { writeFileSync } from 'node:fs';
    const identity = await resolveStoredIdentity('worker');
    setApplicationLocalPcExecution(true);
    writeFileSync('existing-did', identity.did);
  `);
  await run(process.execPath, ['seed.mjs'], { cwd: fixture, env });
  const cli = join(installed, 'dist/cli/dist/index.js');
  const args = [cli, 'worker', 'start', '--adapter', 'sandbox', '--preview', '--relay', 'https://relay.example'];
  if (packageName === 'sealbridge') {
    await expect(run(process.execPath, args, { cwd: fixture, env })).rejects.toMatchObject({ stderr: expect.stringContaining('LOCAL_PC_EXECUTION_REQUIRES_OPT_IN') });
    args.push('--allow-local-pc');
  }
  const preview = await run(process.execPath, args, { cwd: fixture, env });
  expect(preview.stdout).toContain(readFileSync(join(fixture, 'existing-did'), 'utf8'));
  if (packageName === 'sealbridge-local') {
    await run(process.execPath, [cli, 'config', 'local-pc', 'off'], { cwd: fixture, env });
    await expect(run(process.execPath, args, { cwd: fixture, env })).rejects.toMatchObject({ stderr: expect.stringContaining('LOCAL_PC_EXECUTION_REQUIRES_OPT_IN') });
    await expect(run(process.execPath, [cli, 'config', 'local-pc', 'on'], { cwd: fixture, env })).rejects.toMatchObject({ stderr: expect.stringContaining('LOCAL_PC_EXECUTION_REQUIRES_OPT_IN') });
  }
});

it('resolves the SDK and legacy paths from the prepared package without import side effects', async () => {
  expect(manifest.exports['./sdk']).toEqual({ types: './dist/cli/dist/sdk.d.ts', import: './dist/cli/dist/sdk.js' });
  for (const target of Object.values(manifest.exports['./sdk']) as string[]) expect(existsSync(join(installed, target))).toBe(true);
  for (const target of Object.values(manifest.bin) as string[]) expect(existsSync(join(installed, target))).toBe(true);
  write(join(fixture, 'consumer.mjs'), `
    import { existsSync, writeFileSync, renameSync } from 'node:fs';
    globalThis.fetch = () => { throw new Error('Unexpected network call'); };
    const sdk = await import('${packageName}/sdk');
    const legacy = await import('${packageName}/dist/packages/runtime/dist/invite-store.js');
    if (sdk.InviteStore !== legacy.InviteStore) throw new Error('Export identity differs');
    // Desktop main 0a94a35: every value consumed through its internal build paths
    // (including the existing SDK build path) must survive package preparation.
    const desktopModules = [
      ['packages/runtime/dist/key-store.js', ['resolveStoredIdentity', 'selectKeyStore']],
      ['packages/runtime/dist/application-config.js', ['setApplicationKeyStore']],
      ['packages/runtime/dist/mcp-server.js', ['AcpMcpServer']],
      ['packages/runtime/dist/invite-store.js', ['InviteStore']],
      ['packages/runtime/dist/index.js', ['WorkerTrustStore', 'workerIntakePath']],
      ['cli/dist/connections.js', ['connectionsCommand']],
      ['packages/core/dist/index.js', ['signApproval']],
      ['packages/runtime/dist/protocol-peer-store.js', ['ProtocolPeerStore', 'protocolPeerPath']],
      ['cli/dist/sdk.js', [
        'HeldRequestReview', 'RequesterClient', 'WorkerNode', 'WorkerTrustStore',
        'assertDelegationAttenuation', 'buildContextGrant', 'buildTaskManifest',
        'contextGrantAuditPayload', 'createRuleBasedContentReviewProvider', 'parseAuditJsonl',
        'readApplicationConfig', 'taskContent', 'validateContextGrant', 'validateContextGrantUse',
        'verifyAudit', 'workerIntakePath',
      ]],
    ];
    for (const [path, names] of desktopModules) {
      const legacyModule = await import('${packageName}/dist/' + path);
      for (const name of names) {
        if (typeof sdk[name] !== 'function' || sdk[name] !== legacyModule[name])
          throw new Error('Desktop export missing or identity differs: ' + name);
      }
    }
    const runtimeTask = await import('${packageName}/dist/packages/runtime/dist/held-task-content.js');
    const cliTask = await import('${packageName}/dist/cli/dist/task-review.js');
    if (typeof sdk.taskContent !== 'function' || sdk.taskContent !== runtimeTask.taskContent || sdk.taskContent !== cliTask.taskContent)
      throw new Error('Task content export identity differs');
    if ('literalText' in sdk || 'cliTaskInspection' in sdk) throw new Error('Unexpected CLI display export');
    if (existsSync(process.env.SEALBRIDGE_DATA_DIR)) throw new Error('Import created application state');
    const core = await import('${packageName}/dist/packages/core/dist/index.js');
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
      taskContent, signApproval, ProtocolPeerStore, protocolPeerPath,
    } from '${packageName}/sdk';
    import type {
      ProtocolPeerObservation, ProtocolPeerState, ProtocolPeerStoreOptions,
      SavedInvite, SecretStore, KeyStore, IdentityStoreOptions, DataRootOptions, KeyringModule,
      ConnectionServiceOptions, ConnectionHumanReviewProvider, ConnectionRouterOptions,
      ConnectionAdmissionReviewOptions, InboundConnectionSummary,
      ConnectionsCommandOptions, AcpMcpServerOptions, HeldContentReviewProvider, RelayTransport,
      RuleInspectionInput, RuleInspectionOptions, RuleInspectionFinding, RuleInspectionReport, RuleInspectionRule,
      RuleInspectionKind, RuleInspectionDiagnosticCode, RuleBasedContentReviewOptions,
      AuditBundle, AuditEvidence, AuditInterruption, InterruptedAuditBundle, AuditEvidenceVerificationResult, InterruptionStore,
      InviteLinkKeys, InviteLinkCiphertext, InviteLinkStorage, InviteLinkRelayPolicy, ParsedInviteLink,
      HeldTaskContent, KeyPair, SignedEnvelope,
    } from '${packageName}/sdk';
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
    function task(envelope: SignedEnvelope, owner: KeyPair, contentDigest: string, envelopeDigest: string): HeldTaskContent {
      const content: HeldTaskContent = taskContent(envelope, owner, contentDigest);
      const bound: HeldTaskContent = taskContent(envelope, owner, contentDigest, envelopeDigest);
      return { manifest: bound.manifest, input: content.input, capabilityChains: content.capabilityChains };
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
    function protocolPeers(owner: KeyPair, options: ProtocolPeerStoreOptions) {
      const peers = new ProtocolPeerStore(owner, options);
      const path: string = protocolPeerPath(owner.did, options);
      const state: ProtocolPeerState = { version: 1, localOwnerDid: owner.did, observations: [] };
      const observation: ProtocolPeerObservation | undefined = state.observations[0];
      const approval = signApproval('desktop-task', 'final_verification', { input: 'review' }, owner);
      return { peers, path, observation, approval };
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

});
