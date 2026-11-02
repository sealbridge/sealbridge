// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { createSignedAgentCard, findDiscoveredAgentCard, generateKeyPair, signPayload } from '../packages/core/src/index.js';
import type { KeyPair, SignedAgentCard } from '../packages/core/src/index.js';
import { InMemoryRelay, selectAgentCard, createRelayFetchHandler } from '../packages/relay/src/index.js';
import { PolicyAutoApprovalProvider, RequesterClient, WorkerNode } from '../packages/runtime/src/index.js';

function card(owner: KeyPair, agent = owner, name = 'worker') {
  return createSignedAgentCard({ name, agentDid: agent.did, relayEndpoint: 'https://relay.example', skills: [] }, owner,
    agent.did === owner.did ? undefined : agent);
}
function orders<T>(items: T[]): T[][] {
  if (items.length < 2) return [items];
  return items.flatMap((item, i) => orders(items.filter((_, j) => i !== j)).map((rest) => [item, ...rest]));
}

describe('Sprint 1 deterministic discovery', () => {
  it('prefers exact agentDid over owner aliases', () => {
    const target = generateKeyPair(), owner = generateKeyPair(), sibling = generateKeyPair();
    const exact = card(owner, target, 'exact'), alias = card(target, sibling, 'alias');
    for (const candidates of orders([alias, exact])) {
      expect(findDiscoveredAgentCard(candidates, target.did)).toEqual(exact);
      expect(selectAgentCard(candidates, target.did)).toEqual(exact);
    }
  });

  it('rejects multiple valid owners for one agent in every order, including a self-owned card', () => {
    const target = generateKeyPair(), owner = generateKeyPair(), other = generateKeyPair();
    for (const candidates of orders([card(owner, target), card(other, target), card(target)])) {
      expect(() => findDiscoveredAgentCard(candidates, target.did)).toThrow('AMBIGUOUS_AGENT_CARD_OWNER');
      expect(() => selectAgentCard(candidates, target.did)).toThrow('AMBIGUOUS_AGENT_CARD_OWNER');
    }
  });

  it('selects newest signedAt for the same pair with stable tie-breaking', () => {
    const owner = generateKeyPair(), agent = generateKeyPair();
    const latest = card(owner, agent, 'latest');
    const older = signPayload({ ...latest.payload, name: 'older' }, owner,
      new Date(Date.parse(latest.signature.signedAt) - 1000).toISOString());
    for (const candidates of orders([older, latest]))
      expect(findDiscoveredAgentCard(candidates, agent.did)).toEqual(latest);
    const tied = signPayload({ ...latest.payload, name: 'tied' }, owner, latest.signature.signedAt);
    expect(findDiscoveredAgentCard([latest, tied], agent.did)).toEqual(findDiscoveredAgentCard([tied, latest], agent.did));
  });

  it('ignores expired, forged, and malformed cards without hiding valid matches', () => {
    const owner = generateKeyPair(), target = generateKeyPair();
    const live = card(owner, target), expired = card(target);
    const expiry = Date.parse(expired.payload.expiresAt);
    const forged = { ...live, payload: { ...live.payload, ownerDid: target.did } };
    expect(findDiscoveredAgentCard([null, {}, expired, forged, live], target.did, expiry)).toBeUndefined();
    const old = signPayload({ ...expired.payload, expiresAt: new Date(Date.now() - 1000).toISOString() }, target,
      new Date(Date.now() - 2000).toISOString());
    expect(findDiscoveredAgentCard([null, {}, old, forged, live], target.did)).toEqual(live);
  });

  it('makes owner-alias selection stable across different agent DIDs', () => {
    const owner = generateKeyPair();
    const candidates = [card(owner, generateKeyPair(), 'a'), card(owner, generateKeyPair(), 'b')];
    expect(findDiscoveredAgentCard(candidates, owner.did)).toEqual(findDiscoveredAgentCard(candidates.reverse(), owner.did));
  });

  it('does not hide agent ownership ambiguity behind an owner alias', () => {
    const owner = generateKeyPair(), other = generateKeyPair(), agent = generateKeyPair();
    for (const candidates of orders([card(owner, agent), card(other, agent)]))
      expect(() => findDiscoveredAgentCard(candidates, owner.did)).toThrow('AMBIGUOUS_AGENT_CARD_OWNER');
  });

  it('rejects ambiguous DID delegation before sending any proposal', async () => {
    const owner = generateKeyPair(), other = generateKeyPair(), agent = generateKeyPair(), requester = generateKeyPair();
    const relay = new InMemoryRelay();
    relay.register(card(owner, agent)); relay.register(card(other, agent));
    const client = new RequesterClient({ owner: requester, relay, approvalProvider: new PolicyAutoApprovalProvider(requester) });
    await expect(client.delegate({ to: agent.did, title: 'ambiguous', description: 'no sends', input: {} }))
      .rejects.toThrow('AMBIGUOUS_AGENT_CARD_OWNER');
    expect(relay.snapshot().queues).toEqual([]);
  });

  it('routes DID delegation to an exact agent instead of a competing owner alias', async () => {
    const owner = generateKeyPair(), agent = generateKeyPair(), requester = generateKeyPair();
    const relay = new InMemoryRelay();
    const worker = new WorkerNode({ checkPeer: () => 'trusted',
       allowedRequesterDids: [requester.did], owner, agentDid: agent.did, agentKey: agent, relay,
      approvalProvider: new PolicyAutoApprovalProvider(owner),
      adapter: { id: 'echo', name: 'echo', skills: [], executeTask: async (ctx) => ctx.input } });
    await worker.register();
    relay.register(card(agent, generateKeyPair(), 'alias'));
    const client = new RequesterClient({ owner: requester, relay, timeoutMs: 3000,
      approvalProvider: new PolicyAutoApprovalProvider(requester) });
    const done = worker.start({ once: true });
    try {
      const [result] = await Promise.all([client.delegate({ to: agent.did, title: 'exact', description: 'exact', input: { exact: true } }), done]);
      expect(result.state).toBe('SETTLED');
      expect(result.deliverable).toEqual({ exact: true });
    } finally { worker.stop(); }
  });

  it.each(['race', 'quorum'] as const)('rejects ambiguous %s targets before launching delegates', async (mode) => {
    const owner = generateKeyPair(), agent = generateKeyPair(), requester = generateKeyPair();
    const relay = new InMemoryRelay();
    relay.register(card(owner, agent)); relay.register(card(agent));
    const client = new RequesterClient({ owner: requester, relay,
      approvalProvider: new PolicyAutoApprovalProvider(requester) });
    await expect(client.delegateMulti({ mode, workers: [{ workerDid: agent.did }],
      title: 'ambiguous multi', description: 'no sends', input: {} }))
      .rejects.toThrow('AMBIGUOUS_AGENT_CARD_OWNER');
    expect(relay.snapshot().queues).toEqual([]);
  });

  it('returns a public HTTP conflict for ambiguous discovery', async () => {
    const owner = generateKeyPair(), agent = generateKeyPair();
    const relay = new InMemoryRelay();
    relay.register(card(owner, agent)); relay.register(card(agent));
    const response = await createRelayFetchHandler({ relay })(new Request('https://relay.example/agents/' + agent.did));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'AMBIGUOUS_AGENT_CARD_OWNER' });
  });
});

describe('Sprint 1 snapshot restoration', () => {
  it.each(['signed-expiry', 'registry-ttl'] as const)('purges %s cards while retaining valid cards', (kind) => {
    let now = Date.now();
    const relay = new InMemoryRelay({ now: () => now });
    const live = card(generateKeyPair()), shortOwner = generateKeyPair();
    const short = createSignedAgentCard({ name: 'short', agentDid: shortOwner.did,
      relayEndpoint: 'https://relay.example', skills: [], expiresAt: new Date(now + 1000).toISOString() }, shortOwner);
    relay.register(live); relay.register(short);
    const snapshot = relay.snapshot();
    if (kind === 'registry-ttl') snapshot.agentExpiry = snapshot.agentExpiry!.map(([key, expiry]) =>
      [key, key.startsWith(shortOwner.did + '/') ? now : expiry]);
    else now += 1000; // Exact equality is expired.
    const restored = new InMemoryRelay({ now: () => now });
    expect(() => restored.restore(snapshot)).not.toThrow();
    expect(restored.discover()).toEqual([live]);
    expect(restored.snapshot().agents).toEqual([live]);
    expect(restored.snapshot().agentExpiry).toHaveLength(1);
  });

  it.each(['signature', 'structure', 'missing-expiry', 'invalid-lifetime', 'duplicate', 'malformed-ttl'] as const)(
    'rejects %s even among expired cards and leaves existing state intact', (kind) => {
      const owner = generateKeyPair(), valid = card(owner);
      const relay = new InMemoryRelay(); relay.register(valid);
      const snapshot = relay.snapshot();
      const expired = signPayload({ ...valid.payload, expiresAt: new Date(Date.now() - 1000).toISOString() }, owner,
        new Date(Date.now() - 2000).toISOString()) as SignedAgentCard;
      snapshot.agents = [expired];
      if (kind === 'signature') snapshot.agents[0] = { ...expired, payload: { ...expired.payload, name: 'tampered' } };
      if (kind === 'structure') snapshot.agents = [null as unknown as SignedAgentCard];
      if (kind === 'missing-expiry') {
        const payload = { ...expired.payload } as Partial<typeof expired.payload>;
        delete payload.expiresAt;
        snapshot.agents = [signPayload(payload, owner) as SignedAgentCard];
      }
      if (kind === 'invalid-lifetime') snapshot.agents = [signPayload(expired.payload, owner) as SignedAgentCard];
      if (kind === 'duplicate') snapshot.agents.push(expired);
      if (kind === 'malformed-ttl') snapshot.agentExpiry = [[owner.did + '/' + owner.did, NaN]];
      expect(() => relay.restore(snapshot)).toThrow('INVALID_AGENT_SNAPSHOT');
      expect(relay.discover()).toEqual([valid]);
    },
  );
});
