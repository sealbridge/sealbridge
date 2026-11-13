// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '../packages/core/src/index.js';
import { completeInspection } from './connections-fixture.js';
import { parseJsonl, verifyAudit } from '../packages/ledger/src/index.js';
import { HttpRelayClient, createRelayFetchHandler } from '../packages/relay/src/index.js';
import { WorkerNode, RequesterClient, PolicyAutoApprovalProvider, HeldRequestReview,
  GatewayDeliveryService, InviteStore, resolveStoredIdentity } from '../packages/runtime/src/index.js';
import { acceptCommand } from '../cli/src/accept.js';
import { protocolTestNow } from './protocol-test-clock.js';

it('settles the first delegate on a fresh invite with valid bilateral audits', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(protocolTestNow('2026-11-13T00:00:00Z'));
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'first-invite-'));
  const identityOptions = { env: { SEALBRIDGE_DATA_DIR: root } };
  const owner = generateKeyPair(), requester = await resolveStoredIdentity('requester', identityOptions);
  const handler = createRelayFetchHandler();
  const trace: string[] = [];
  let interruptedStart = false;
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
  let releaseAudit!: () => void;
  const auditGate = new Promise<void>(resolve => { releaseAudit = resolve; });
  const fetcher: typeof fetch = async (input, init) => {
    if (init?.method === 'POST' && new URL(String(input)).pathname === '/envelopes') {
      const e = JSON.parse(String(init.body)).payload;
      if (e.senderDid === owner.did && e.eventType === 'AUDIT_ENTRY' && e.seq === 4) await auditGate;
      trace.push(`${e.senderDid === owner.did ? 'W' : 'R'} ${e.eventType} ${e.seq}`);
    }
    const response = await handler(new Request(input, init));
    if (new URL(String(input)).searchParams.get('recipient') === requester.did && !init?.method) {
      const body = await response.clone().json();
      if (body.envelopes?.some((e: { payload: { eventType: string } }) => e.payload.eventType === 'START')) {
        // A cold status-reader initialization finishes after START was leased,
        // before its HTTP response arrives. Hold seq=4 outside this batch so a
        // discarded seq=3 reproduces the reported strict sequence failure.
        releaseRefresh();
        await requesterDelivery.statusRouter.refresh();
        interruptedStart = init?.signal?.aborted ?? false;
        releaseAudit();
      }
    }
    return response;
  };
  const url = 'https://relay.example';
  const requesterDelivery = new GatewayDeliveryService(requester, { identityOptions,
    assertReceiveAllowed: () => refreshGate,
    resolveTransport: () => new HttpRelayClient(url, fetcher, requester) });
  const executeTask = vi.fn(async (c: { input: unknown }) => c.input as never);
  const worker = new WorkerNode({ owner, relay: new HttpRelayClient(url, fetcher, owner), relayUrl: url,
    auditPath: join(root, 'worker-audit.jsonl'),
    identityOptions, deliveryOptions: { identityOptions, resolveTransport: () => new HttpRelayClient(url, fetcher, owner) }, timeoutMs: 5000,
    heldReview: new HeldRequestReview(owner, { ...identityOptions, provider: completeInspection }),
    autoAccept: { version: 1, enabled: true, from: 'invited', work: 'read-only', limits: {} },
    adapter: { id: 'echo', name: 'Echo', taskAccess: 'read-only', skills: [], executeTask },
    approvalProvider: new PolicyAutoApprovalProvider(owner) });
  const client = new RequesterClient({ owner: requester, relay: new HttpRelayClient(url, fetcher, requester),
    identityOptions, deliveryService: requesterDelivery, pendingRelayUrl: url, timeoutMs: 5000,
    connectionReview: { kind: 'human', review: async () => true },
    approvalProvider: new PolicyAutoApprovalProvider(requester) });
  try {
    const input = new PassThrough();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const imported = acceptCommand('accept', ['--stdin', '--alias', 'reviewer'], { ...identityOptions, input });
    input.end(worker.invite() + '\n');
    await imported;
    log.mockRestore();
    const saved = (await InviteStore.open(requester, identityOptions)).resolve('reviewer');
    await worker.startDelivery(); await client.startDelivery();
    const results = await Promise.allSettled([worker.start({ once: true }), client.delegate({
      to: saved.inviteToken, title: 'First task', description: 'Return the JSON input', input: { hello: 'world' },
      auditPath: join(root, 'requester-audit.jsonl') })]);
    expect(interruptedStart).toBe(false);
    expect(trace.filter(frame => frame.startsWith('W ') && !frame.includes('DELIVERY_STATUS') && !frame.includes('CONNECTION_')))
      .toEqual(['W AUDIT_ACK 0', 'W ACCEPT 1', 'W AUDIT_ENTRY 2', 'W START 3', 'W AUDIT_ENTRY 4',
        'W DELIVER 5', 'W AUDIT_ENTRY 6', 'W AUDIT_ACK 7', 'W AUDIT_ACK 8', 'W CHECKPOINT_ACK 9']);
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: { state: 'SETTLED' } });
    expect(trace.filter(frame => frame === 'R PROPOSE 0')).toHaveLength(1);
    expect(executeTask).toHaveBeenCalledOnce();
    for (const result of results) {
      expect(result.status).toBe('fulfilled');
      if (result.status === 'fulfilled') expect(verifyAudit(result.value!.bundle).valid).toBe(true);
    }
    for (const side of ['requester', 'worker'])
      expect(verifyAudit(parseJsonl(readFileSync(join(root, side + '-audit.jsonl'), 'utf8'))).valid).toBe(true);
  } finally {
    releaseRefresh(); releaseAudit(); worker.stop(); client.stopDelivery();
    await requesterDelivery.statusRouter.refresh();
    vi.restoreAllMocks(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true });
  }
});
