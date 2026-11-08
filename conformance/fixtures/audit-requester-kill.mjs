// SPDX-License-Identifier: Apache-2.0
// Real requester: no cooperative abort or cleanup runs when the parent force-kills it.
import { readFileSync } from 'node:fs';
import { RequesterClient, PolicyAutoApprovalProvider } from '../../packages/runtime/dist/index.js';
const { owner, invite, relayUrl } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const client = new RequesterClient({ owner, relay: relayUrl, allowPrivateRelay: true,
  taskTimeoutMs: 120_000, waitTimeoutMs: 120_000,
  approvalProvider: new PolicyAutoApprovalProvider(owner) });
await client.delegate({ to: invite, title: 'Force-killed first contact',
  description: 'Requester dies while live worker approval is open', input: {} });
throw new Error('Requester unexpectedly completed before force-kill');
