// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInviteToken, createSignedAgentCard, generateKeyPair, parseAndVerifyInviteToken, verifyApproval } from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import { InteractiveCliApprovalProvider, PolicyAutoApprovalProvider, RequesterClient, WorkerNode } from '../packages/runtime/src/index.js';
import type { ApprovalRequest } from '../packages/runtime/src/index.js';
import { assertCliAuthentication } from '../packages/adapters/src/command.js';
import { sanitizedEnvironment } from '../packages/sandbox/src/index.js';
import { approvalSummary } from '../cli/src/approval-summary.js';
import { formatCliError, japaneseErrorReason } from '../cli/src/error-messages.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function fixture() {
  const owner = generateKeyPair();
  const card = createSignedAgentCard({ name: 'Reviewer', agentDid: owner.did,
    relayEndpoint: 'https://relay.example', skills: [] }, owner);
  return { owner, token: createInviteToken({ agentCard: card }, owner) };
}
it('core accepts HTTPS fragment invitations and both existing token formats without fetching', () => {
  const { owner, token } = fixture();
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network expected'));
  for (const value of [token, 'https://sealbridge.app/i#' + token, 'acp://invite?token=' + token.slice(11)])
    expect(parseAndVerifyInviteToken(value).ownerDid).toBe(owner.did);
  expect(fetch).not.toHaveBeenCalled();
});
it('token-less HTTPS links report the missing invitation instead of a missing relay', async () => {
  const client = new RequesterClient({ owner: generateKeyPair() });
  await expect(client.delegate({ to: 'https://sealbridge.app/i', title: 'Review', description: 'Review', input: {} }))
    .rejects.toThrow('INVITE_LINK_TOKEN_REQUIRED');
  for (const link of ['https://sealbridge.app/i?token=ignored', 'https://sealbridge.app/i#unrelated', 'https://sealbridge.app/i#acp-invite:'])
    expect(() => parseAndVerifyInviteToken(link)).toThrow('INVITE_LINK_TOKEN_REQUIRED');
});
it('an HTTPS invitation completes an in-process diff review with unchanged signed approval targets', async () => {
  const owner = generateKeyPair(), requester = generateKeyPair(), relay = new InMemoryRelay();
  const diff = '-before\n+after\n';
  const summaries: string[] = [];
  function approval(key: typeof owner) {
    const automatic = new PolicyAutoApprovalProvider(key);
    return { async approve(request: ApprovalRequest) {
      summaries.push(approvalSummary(request));
      const receipt = await automatic.approve(request);
      expect(verifyApproval(receipt, key.did, request.taskId, request.gate, request.target)).toBe(true);
      return receipt;
    } };
  }
  const worker = new WorkerNode({ checkPeer: () => 'trusted', owner, relay, relayUrl: 'https://relay.example',
    approvalProvider: approval(owner), adapter: { id: 'review', name: 'Reviewer', skills: [],
      async executeTask(context) { expect(context.input).toEqual({ diff }); return { review: 'Looks good. Add an edge-case check.' }; } } });
  const invite = parseAndVerifyInviteToken(worker.invite());
  expect(Date.parse(invite.expiresAt) - Date.parse(invite.issuedAt)).toBe(86400000);
  const running = worker.runOnce();
  const result = await new RequesterClient({ owner: requester, relay, approvalProvider: approval(requester) })
    .delegate({ to: 'https://sealbridge.app/i#' + worker.invite(), title: 'Review change', description: 'Check diff', input: { diff } });
  await running;
  expect(result.state).toBe('SETTLED');
  const summary = summaries.find(s => s.includes('contract_acceptance'))!;
  for (const text of [requester.did, 'Review change', '2 diff lines', 'Time limit:', 'Budget:', 'tokens', 'tools'])
    expect(summary).toContain(text);
  expect(summaries.find(s => s.includes('final_verification'))).toContain('Looks good. Add an edge-case check.');
});
it('CLI login directories stay hidden and preflight explains host key setup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sealbridge-login-'));
  try {
    mkdirSync(join(dir, '.claude'));
    mkdirSync(join(dir, '.codex'));
    vi.stubEnv('HOME', dir);
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(sanitizedEnvironment('/task').HOME).toBe('/task');
    expect(sanitizedEnvironment('/task').CODEX_HOME).toBeUndefined();
    for (const [adapter, variable] of [['claude', 'ANTHROPIC_API_KEY'], ['codex', 'OPENAI_API_KEY']] as const) {
      expect(() => assertCliAuthentication(adapter)).toThrow(variable);
      expect(() => assertCliAuthentication(adapter)).toThrow('local CLI logins');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('approval summaries show full review bodies and retain full actions for other approval gates', () => {
  const body = 'Review line one\nReview line two';
  const request: ApprovalRequest = { taskId: 'task_review', gate: 'final_verification',
    target: { artifact: { payload: { data: { review: body } } } } };
  expect(approvalSummary(request)).toContain('Review line one');
  expect(approvalSummary(request)).toContain('Review line two');
  const sideEffect = approvalSummary({ taskId: 'task_review', gate: 'external_side_effect', target: { name: 'send', args: { recipient: 'peer' } } });
  expect(sideEffect).toContain('recipient');
  expect(sideEffect).toContain('peer');
  expect(approvalSummary({ ...request, target: { artifact: { payload: { data: '\x1b[2Jreview' } } } })).not.toContain('\x1b');
});
it.each([false, true])('interactive approval signs the same target in summary and verbose mode (verbose=%s)', async verbose => {
  const owner = generateKeyPair(), input = new PassThrough(), output = new PassThrough();
  const request: ApprovalRequest = { taskId: 'task_review', gate: 'final_verification',
    target: { artifact: { payload: { data: { review: 'Useful review body' } } } } };
  let displayed = '';
  output.on('data', chunk => { displayed += String(chunk); });
  const provider = new InteractiveCliApprovalProvider(owner, { input, output,
    ...(verbose ? {} : { formatRequest: approvalSummary }) });
  const pending = provider.approve(request);
  input.end('y\n');
  const receipt = await pending;
  expect(verifyApproval(receipt, owner.did, request.taskId, request.gate, request.target)).toBe(true);
  expect(displayed).toContain('Useful review body');
  expect(displayed).toContain('Approve [y/N]?');
  expect(displayed.includes('targetDigest')).toBe(verbose);
});
it.each(['APPROVAL_REJECTED', 'INVALID_INPUT_FILE', 'BUDGET_EXCEEDED', 'ABORT', 'EXECUTION_FAILED',
  'SESSION_ABORTED', 'RELAY_REQUIRED', 'AGENT_AUTH_REQUIRED', 'UNAUTHORIZED', 'ADAPTER_TIMEOUT', 'TASK_TIMEOUT'])
  ('CLI error %s retains its machine code and adds a Japanese next step', code => {
    const reason = japaneseErrorReason(code);
    expect(reason).toMatch(/[ぁ-んァ-ン一-龯]/);
    expect(reason).toContain('ください');
    const rendered = formatCliError(new Error(code));
    expect(rendered).toContain(code);
    expect(rendered).toContain('\n' + reason);
  });

it('summary approval still defaults to rejection on an empty answer', async () => {
  const owner = generateKeyPair(), input = new PassThrough(), output = new PassThrough();
  const request: ApprovalRequest = { taskId: 'task_review', gate: 'contract_acceptance', target: 'contract-digest' };
  const pending = new InteractiveCliApprovalProvider(owner, { input, output, formatRequest: approvalSummary }).approve(request);
  input.end('\n');
  const receipt = await pending;
  expect(receipt.payload.decision).toBe('REJECTED');
});
