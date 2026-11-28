// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateKeyPair,
  createSignedAgentCard,
  createInviteToken,
  parseAndVerifyInviteToken,
} from '../packages/core/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
import {
  RequesterClient,
  PolicyAutoApprovalProvider,
  connectionIdFor,
} from '../packages/runtime/src/index.js';
import type {
  WorkerNodeOptions,
  WorkerNode,
  ApprovalRequest,
} from '../packages/runtime/src/index.js';
import { completeInspection } from './connections-fixture.js';
const state = vi.hoisted(() => ({
  relay: undefined as InMemoryRelay | undefined,
  ready: (_worker: WorkerNode) => {},
  approvals: 0,
}));
// Replace only external transport and human interaction. Real worker, approval
// checks, internal gateway, adapter execution and settlement remain exercised.
vi.mock('../packages/runtime/dist/index.js', async (original) => {
  const runtime = await original<typeof import('../packages/runtime/src/index.js')>();
  return {
    ...runtime,
    WorkerNode: class extends runtime.WorkerNode {
      constructor(options: WorkerNodeOptions) {
        super({
          ...options,
          relay: state.relay!,
          deliveryOptions: options.deliveryOptions
            ? { ...options.deliveryOptions, resolveTransport: () => state.relay! }
            : undefined,
          heldReview: new runtime.HeldRequestReview(options.owner, {
            ...options.identityOptions,
            provider: completeInspection,
          }),
        });
        state.ready(this);
      }
      override start() {
        return super.start({ once: true });
      }
    },
    InteractiveCliApprovalProvider: class {
      readonly kind = 'human';
      readonly policy: PolicyAutoApprovalProvider;
      constructor(owner: import('../packages/core/src/index.js').KeyPair) {
        this.policy = new runtime.PolicyAutoApprovalProvider(owner);
      }
      approve(request: ApprovalRequest) {
        state.approvals++;
        return this.policy.approve(request);
      }
    },
  };
});
import { boardCommand, createPost } from '../cli/src/board.js';
import { networkCommand } from '../cli/src/network.js';
import { addContact, updateContacts } from '../cli/src/contacts.js';
const roots: string[] = [];
const ttyDescriptors = [process.stdin, process.stderr].map(
  (stream) => [stream, Object.getOwnPropertyDescriptor(stream, 'isTTY')] as const,
);
afterEach(() => {
  vi.restoreAllMocks();
  for (const [stream, descriptor] of ttyDescriptors) {
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else Reflect.deleteProperty(stream, 'isTTY');
  }
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it.runIf(process.platform !== 'win32').each(['board', 'openai'] as const)(
  'completes %s CLI work after owner approval without root override',
  async (mode) => {
    vi.spyOn(process, 'geteuid').mockReturnValue(0);
    vi.stubEnv('SEALBRIDGE_ALLOW_ROOT_LOCAL_EXECUTION', undefined);
    vi.stubEnv('OPENAI_API_KEY', 'synthetic');
    for (const [stream] of ttyDescriptors)
      Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
    state.relay = new InMemoryRelay();
    state.approvals = 0;
    const root = mkdtempSync(join(tmpdir(), 'root-remote-completion-'));
    roots.push(root);
    const owner = generateKeyPair(),
      peer = generateKeyPair(),
      relay = 'https://relay.example';
    const identityOptions = { env: { SEALBRIDGE_DATA_DIR: join(root, 'data') } };
    const key = join(root, 'owner.json');
    writeFileSync(key, JSON.stringify(owner), { mode: 0o600 });
    const card = createSignedAgentCard(
      {
        name: 'Peer',
        agentDid: peer.did,
        relayEndpoint: relay,
        skills: [{ id: 'echo', name: 'Echo', taskTypes: ['json'] }],
      },
      peer,
    );
    const contacts = join(root, 'contacts.json');
    addContact(contacts, owner, createInviteToken({ agentCard: card }, peer), undefined, true);
    updateContacts(contacts, owner, (items) => {
      items[0].allow = true;
    });
    const post = createPost(
      owner,
      {
        relay,
        what: 'Synthetic',
        skillId: 'echo',
        taskType: 'json',
        budget: {
          maxInputTokens: 100,
          maxOutputTokens: 100,
          maxToolInvocations: 1,
          maxWallClockSeconds: 10,
        },
        deadline: new Date(Date.now() + 600000).toISOString(),
      },
      { value: 7 },
    );
    const postPath = join(root, 'post.json');
    writeFileSync(postPath, JSON.stringify(post));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      expect(String(input)).toBe('https://provider.example/completions');
      return Response.json({
        choices: [{ message: { content: '{"value":7}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    let resolve!: (worker: WorkerNode) => void;
    const ready = new Promise<WorkerNode>((done) => {
      resolve = done;
    });
    state.ready = resolve;
    const serving =
      mode === 'board'
        ? boardCommand(
            [
              'serve',
              '--post',
              postPath,
              '--key',
              key,
              '--state',
              join(root, 'lease.json'),
              '--audit',
              join(root, 'worker.jsonl'),
            ],
            identityOptions,
          )
        : networkCommand(
            'worker',
            [
              'start',
              '--adapter',
              'openai',
              '--share',
              'token',
              '--contacts',
              contacts,
              '--endpoint',
              'https://provider.example/completions',
              '--key',
              key,
              '--relay',
              relay,
              '--tty-approval',
              '--invite-output',
              'none',
              '--once',
            ],
            { identityOptions },
          );
    void serving.catch(() => {});
    const worker = await Promise.race([
      ready,
      serving.then(() => {
        throw new Error('WORKER_NOT_CREATED');
      }),
    ]);
    worker.connectionStore.redeemTaskInvite(
      parseAndVerifyInviteToken(worker.invite()),
      { peerOwnerDid: peer.did, relayUrl: relay },
      connectionIdFor(owner.did, peer.did),
    );
    try {
      const requester = new RequesterClient({
        owner: peer,
        relay: state.relay,
        approvalProvider: new PolicyAutoApprovalProvider(peer),
      });
      const result = await requester.delegate({
        to: owner.did,
        title: 'Synthetic',
        description:
          mode === 'board' ? JSON.stringify({ postId: post.payload.id, card }) : 'Return JSON',
        input: mode === 'board' ? { postId: post.payload.id } : { value: 7 },
      });
      await serving;
      expect(result.state).toBe('SETTLED');
      expect(state.approvals).toBeGreaterThan(0);
      if (mode === 'board')
        expect(result.deliverable).toMatchObject({ payload: { accepted: true } });
      else {
        expect(result.deliverable).toEqual({ value: 7 });
        expect(provider).toHaveBeenCalledTimes(1);
      }
      expect(stderr.mock.calls.some(([line]) => String(line).includes('starting as root'))).toBe(
        false,
      );
    } finally {
      worker.stop();
      await serving.catch(() => {});
      expect(state.approvals).toBeGreaterThan(0);
    }
  },
);
