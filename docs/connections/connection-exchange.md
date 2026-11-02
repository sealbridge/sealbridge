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
