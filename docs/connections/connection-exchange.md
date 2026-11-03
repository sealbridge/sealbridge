# Connection exchange

`@acp/core` exports `ConnectionRequest`, `ConnectionAccepted`, `ConnectionAck`
and their bounded validators and signing/verification helpers. `@acp/runtime`
exports `ConnectionService` and encrypted control frame helpers. Embedders supply
atomic persistence, held-content inspection, human review and transport ports;
`StoredConnectionExchange` attaches the owner-local store, while human review remains host supplied. Outgoing consent
is recorded before sending, and invite first use binds the verified owner DID
atomically with limited consent and an acceptance outbox. Importing an invite
does not connect its recipient. Control delivery is independent of task execution.

## Control profile and persistence requirements

Connection offer timestamps and their default 14-day expiry use one clock snapshot. Worker and CLI-issued card lifetimes also use one snapshot, including the 30-day maximum.

`packages/core/src/connection.ts` defines closed, bounded payload validators for
`ConnectionRequest` and `ConnectionAccepted` (`v: 1`, `protocolVersion: '0.2.0'`)
and `ConnectionAck` (`v: 1`). These types do not change the manifest version.
Requests contain a verified owner-signed AgentCard, a message of at most 240
Unicode code points, an offer deadline within 14 days, and optional invite and
origin-proposal digests. A distinct agent requires the existing signed delegation.
Request digests identify the complete signed request; accepted digests identify
the complete signed acceptance. Invite digests identify the parsed verified invite
payload, matching current revocation identifiers across token encodings.

Each owner-signed control payload travels in an encrypted SignedEnvelope to the
other owner DID. Request bodies are `{ request: Signed<ConnectionRequest>, inviteToken? }`;
acceptance and ACK bodies are their signed payloads. Envelope event names are
`CONNECTION_REQUEST`, `CONNECTION_ACCEPTED`, `CONNECTION_ACK`, with
`taskId: 'conn_' + requestId`, `seq: 0`. IDs contain 1–96 ASCII letters, digits,
underscores or hyphens. All three events use worker-role delivery without changing
task role inference, audit sequence state, contracts or task settlement.

`ConnectionService` requires owner review before outgoing consent (including
invite confirmation) and before ordinary incoming acceptance. Incoming content
requires the injected held-content inspection port. The issuer's verified invite
provides issuer consent for atomic first use; another owner follows ordinary
pending review. Same-owner reuse does not renew consent. Accepted consent is
limited with no expiry; it does not authorize task execution. Invite expiry or
revocation prevents future redemption without removing an established connection.

Persistence adapters must implement the atomic preconditions documented on
`ConnectionPersistencePort`, retain decisions through the offer deadline and
bindings through effective invite expiry, and cancel outboxes on removal.
Retries retain the original signed notification and use a fresh outer envelope ID
because the current relay rejects repeated envelope IDs. ACKs are persisted with
acceptance application before relay acknowledgement; repeated acceptance requeues
the original ACK. A send failure reports `CONNECTION_DELIVERY_PENDING`.

See [connections admission](admission.md) for the live CLI/MCP, explicit consent and migration workflows.

## Querying connection status

After `connections confirm-invite reviewer --role requester`, periodically run
`connections sync --once --role requester --relay https://relay.sealbridge.dev`
(use the invitation's relay), then `connections status reviewer --role requester`.
One sync processes at most one control envelope; repeat as needed. A continuous
process is not required. The status command returns JSON and also accepts an exact
saved workerRef or peer owner DID. Its default role is requester. Aliases and saved
references select the peer owner, so multiple invites for that owner report the
same current connection. Saved references use existing InviteStore/backend
validation, including for expired invites; a missing reference is `INVITE_NOT_FOUND`.
Without a local identity it returns `{"role":"requester","status":"none","state":"none"}` without
creating files. DID queries do not read the invite store.

`WorkerTrustStore.connectionStatus(peerOwnerDid): ConnectionStatus` reads one
owner-local snapshot and the store's injected clock. Neither API polls, sends,
prunes, inspects content, opens a task, or changes consent. Run sync separately to
apply received control messages. The result contains `peerOwnerDid`, `state`
(the existing none/pending/connected/blocked projection), and `status`:

| Status | Local evidence |
| --- | --- |
| `none` | No retained offer or established connection. |
| `pending_peer` | Outgoing consent is recorded; peer acceptance has not been applied locally. This includes unsent requests and remote inspection/review waits. |
| `pending_owner` | An incoming offer remains pending inspection or owner review. |
| `connected` | An established local limited connection. For outgoing exchanges, the peer's signed acceptance was applied and an ACK was queued atomically. |
| `inactive` | A retained exchange was deactivated locally, including rejection, withdrawal or disconnect. The exact reason is not stored. |
| `expired` | A retained, unconnected active offer reached its original offer deadline. |
| `blocked` | The peer is blocked locally. |

An established connection or block takes precedence over offer history. Otherwise
the current outgoing offer takes precedence over the incoming offer, then the last
retained exchange is used. Results include available `requestId`, `direction`,
`createdAt`, `expiresAt`, `connectionId`, and `connectedAt` (times are epoch
milliseconds). When a matching accepted exchange is retained,
`acknowledgementPending` reports an outgoing ACK awaiting send or an incoming
acceptance awaiting the peer's ACK. `false` on an outgoing exchange records ACK
transmission, not proof of peer receipt. If exchange evidence has been pruned,
this field is omitted; omission does not confirm an ACK. Existing connections
remain connected after invitation and offer expiry.

The protocol has no remote rejection notification: a sender can remain
`pending_peer` until offer expiry even if the peer rejected or blocked it. A
status read leaves expired records untouched; existing mutations prune them, so
`expired`/`inactive` details are available only while retained, then become `none`
unless a connection or block remains. This API is a current observation, not a
permanent attempt history. Version 1 and version 2 files without control records
remain readable; only evidence available in those records is returned. Storage
formats, wire messages, MCP tools and relay deployment are unchanged.
