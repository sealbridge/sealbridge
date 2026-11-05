// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openEnvelope } from '../packages/core/src/index.js';
import { InviteStore, ProtocolPeerStore, WorkerTrustStore, workerIntakePath } from '../packages/runtime/src/index.js';
import { networkCommand } from '../cli/src/network.js';
import { admissionFixture } from './connections-fixture.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

it.each(['did', 'alias', 'workerRef'] as const)(
  'settles CLI delegation by %s to an unpublished peer connected through an invite', async form => {
    const f = admissionFixture({}, true);
    cleanups.push(f.cleanup);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const requesterStore = new WorkerTrustStore(f.requester, {
      path: workerIntakePath(f.requester.did, f.identityOptions),
    });
    const protocolPeers = new ProtocolPeerStore(f.requester, f.identityOptions);
    Object.assign(f.client.options, {
      identityOptions: f.identityOptions, protocolPeers, connectionStore: requesterStore,
      connectionReview: { kind: 'human', review: vi.fn(async () => true) },
    });
    const token = f.worker.invite();
    const bootstrap = await f.attempt(token);
    expect(bootstrap[0]).toMatchObject({ status: 'fulfilled', value: { state: 'SETTLED', deliverable: f.task.input } });
    expect(bootstrap[1].status).toBe('fulfilled');
    expect(requesterStore.connectionState(f.owner.did)).toBe('connected');
    expect(f.store.connectionState(f.requester.did)).toBe('connected');
    expect(protocolPeers.floor(f.owner.did, f.owner.did)).toBe('0.2.0');
    expect(f.relay.discover()).toEqual([]);

    // Each CLI call constructs a new requester and reopens its persisted observations.
    // The DID case has no imported invitation to fall back to.
    let target = f.owner.did;
    if (form !== 'did') {
      const saved = (await InviteStore.open(f.requester, f.identityOptions)).import(token, 'reviewer');
      target = form === 'alias' ? saved.alias : saved.workerRef;
    }
    const keyFile = join(f.root, 'requester.private.json');
    writeFileSync(keyFile, JSON.stringify(f.requester), { mode: 0o600 });
    const proposedVersions: string[] = [];
    const send = f.relay.send.bind(f.relay);
    vi.spyOn(f.relay, 'send').mockImplementation(envelope => {
      if (envelope.payload.eventType === 'PROPOSE') {
        const proposal = openEnvelope(envelope, f.owner) as unknown as {
          proposal: { payload: { protocolVersion: string } };
        };
        proposedVersions.push(proposal.proposal.payload.protocolVersion);
      }
      return send(envelope);
    });
    const results = await Promise.allSettled([
      networkCommand('delegate', ['--to', target, '--key', keyFile,
        '--title', f.task.title, '--description', f.task.description, '--input', JSON.stringify(f.task.input),
        '--auto-approve', '--relay', 'https://relay.example'], {
        identityOptions: f.identityOptions,
        transportFactory: url => { expect(url).toBe('https://relay.example'); return f.relay; },
      }),
      f.worker.start({ once: true, signal: AbortSignal.timeout(5000) }),
    ]);
    if (results[0].status === 'rejected') throw results[0].reason;
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0])).toMatchObject({
      state: 'SETTLED', deliverable: f.task.input, audit: 'VALID',
    });
    expect(proposedVersions).toEqual(['0.2.0']);
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.human.approve).toHaveBeenCalledTimes(2);
    expect(new ProtocolPeerStore(f.requester, f.identityOptions).floor(f.owner.did, f.owner.did)).toBe('0.2.0');
  },
);
