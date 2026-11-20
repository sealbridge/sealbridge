// SPDX-License-Identifier: Apache-2.0
import {
  createSignedAgentCard,
  digest,
  inviteLinkVerificationNumber,
  parseAndVerifyInviteToken,
} from '@acp/core';
import type { KeyPair } from '@acp/core';
import { HttpRelayClient } from '@acp/relay';
import type { RelayTransport } from '@acp/relay';
import { InviteStore } from './invite-store.js';
import type { InviteStoreOptions } from './invite-store.js';
import { ConnectionRouter, syncConnections } from './connection-router.js';
import { WorkerTrustStore, workerIntakePath } from './worker-trust-store.js';
import { HeldRequestReview } from './held-request-review.js';
import { LiveProtocol } from './protocol-release.js';
import { resolveInviteLink } from './invite-links.js';
/** Using an invitation explicitly requests a limited connection, never execution permission. */
export async function connectInvite(
  value: string,
  owner: KeyPair,
  options: InviteStoreOptions & {
    fetch?: typeof fetch;
    alias?: string;
    transportFactory?: (url: string, owner: KeyPair) => RelayTransport;
  } = {},
) {
  const token = await resolveInviteLink(value, options);
  const invite = parseAndVerifyInviteToken(
    token,
    options.now?.() ?? Date.now(),
    options.relayPolicy,
  );
  const saved = await (await InviteStore.open(owner, options)).import(token, options.alias);
  const relay =
    options.transportFactory?.(invite.relayUrl, owner) ??
    new HttpRelayClient(invite.relayUrl, options.fetch ?? fetch, owner, options.relayPolicy);
  const store = new WorkerTrustStore(owner, {
    path: workerIntakePath(owner.did, options),
    now: options.now,
  });
  const router = new ConnectionRouter({
    owner,
    relay,
    store,
    identityOptions: options,
    relayUrl: invite.relayUrl,
    now: options.now,
    allowPrivateRelay: options.relayPolicy?.allowPrivateRelay,
    review: new HeldRequestReview(owner, options),
    agentCard: createSignedAgentCard(
      {
        name: 'Sealbridge requester',
        agentDid: owner.did,
        relayEndpoint: invite.relayUrl,
        skills: [],
        protocolVersions: new LiveProtocol(options).receiveVersions(),
      },
      owner,
    ),
    humanReview: { kind: 'human', review: async ({ reason }) => reason === 'confirm-invite' },
  });
  let status = store.connectionState(invite.ownerDid);
  if (status !== 'connected') {
    const existing = store
      .controlSnapshot()
      .some(
        (r) => r.active && r.direction === 'outgoing' && r.offer.toOwnerDid === invite.ownerDid,
      );
    if (!existing)
      await router.service.request({ toOwnerDid: invite.ownerDid, inviteToken: token });
    await syncConnections(router, { once: true });
    status = store.connectionState(invite.ownerDid);
    if (status !== 'connected') {
      const taskIds = store
        .controlSnapshot()
        .filter(
          (r) => r.active && r.direction === 'outgoing' && r.offer.toOwnerDid === invite.ownerDid,
        )
        .map((r) => 'conn_' + r.offer.requestId);
      if (taskIds.length) {
        const reply = await relay.receive(owner.did, 1000, AbortSignal.timeout(1500), {
          taskId: taskIds,
          lease: true,
        });
        if (reply) await router.route(reply);
        status = store.connectionState(invite.ownerDid);
      }
    }
  }
  return {
    ...saved,
    peerName: invite.agentCard.payload.name,
    verificationNumber: inviteLinkVerificationNumber(digest(invite)),
    connectionState: status,
    ...router.inviteNaming(invite.ownerDid),
  };
}
