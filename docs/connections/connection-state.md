# Connection state persistence

`@acp/runtime` exports connection record types, lifecycle validation and
`connectionPersistencePort(WorkerTrustStore)`. The store adds `connectionState`,
`connectionLevel`, `listConnections`, `listPriorApprovedPeers`, `recordOutgoing`,
`recordIncoming`, `approveConnection`, `applyAccepted`, `rejectConnection`,
`disconnect`, `block`, `unblock` and `bindInviteFirstUse`, plus acceptance outbox
listing and delivery acknowledgement. Connected projects to limited with no expiry;
connections do not create trusted grants. Offers last at most 14 days; refusing an
incoming offer starts a seven-day incoming-offer cooldown. Invite bindings use the
canonical parsed invite digest and authenticated requester owner DID and remain
through the invite's effective expiry after disconnect/block. Binding, local
consent and acceptance outbox publication are atomic.

These owner-local APIs are attached to live admission, control exchange and the human CLI. `StoredConnectionExchange` commits lifecycle and control outbox metadata under the same store lock. Legacy finite grants are retained as evidence and do not skip holding.

Reads create no identities/files and do not rewrite or migrate stores. Only an
explicit new connection mutation upgrades the existing signed `intake.json` from
v1 to v2. Finite grants retain their expiry and are not converted to connections;
retained approvals/grants become prior-approved candidates requiring fresh consent.
Already pruned history cannot be recovered, and legacy records do not provide an
exact approval timestamp. The file retains its 1 MiB ceiling; live connections are
not evicted for capacity. Before mutation, preserve a v1 backup if rollback is
needed: older binaries cannot read v2. Do not run old and new writers concurrently.

Connection records, `ConnectionPeer`, `ConnectionSummary`, `ConnectionOffer` and
`PriorApprovedPeer` accept optional `peerDisplayName` (a non-empty string). The
store retains the first known name for that owner DID; later unnamed offers do
not erase it. Names are informational data, never identity selectors or consent.
DIDs remain authoritative: equal names do not merge peers or imply a key change.
Names inherit the store's existing byte ceiling and are not executable content.

Incoming control exchange derives the name from the verified request's signed
agent card. Outgoing invite confirmation derives it from the verified invite.
`ConnectionService.request` also accepts optional `peerAgentCard` for a card
already available through discovery; it verifies signature, current expiry,
owner DID and relay before owner consent and transmission. The requester passes
its discovered peer card through this local API. Task admission uses the matched
verified discovery card when available, rather than a manifest display label.
Plain DID requests without a peer card can remain unnamed; acceptance messages
carry no new name field. No wire or protocol schema changes are made.

`WorkerTrustStore.listConnections()`, `connectionStatus()`, `connections list`,
`connections status`, `acp_list_connections`
and `acp_list_connection_requests` include the optional field. Prior-approved
candidates retain a known name from connection metadata for the same owner DID;
`listPriorApprovedPeers()` and `connections prior-approved` return it. This does
not create approval evidence or a connection. Invite removal does not remove
connection names. Legacy v1/v2 records without names remain readable without
rewrites; an inspected incoming exchange can fill a missing name during its next
mutation without changing consent comparisons. The signed store stays version 2.
Earlier binaries that reject unknown record fields cannot read named records;
use the updated reader and avoid concurrent writers from different versions.

`ConnectionStatus.peerDisplayName` is optional and comes from the retained connection
or latest applicable offer, including inactive offers still present locally. Status
reads do not resolve invitation tokens, rewrite records or send messages. The
`sealbridge/sdk` entry exports `ConnectionPeer` and `ConnectionStatus` alongside the
other connection types. Confirming a pending import retains it before verifying the
invite and recording its name; unconfirmed-import cleanup does not change established
connection metadata.
