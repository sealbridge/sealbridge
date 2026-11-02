# Connection state persistence (preparatory)

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

These are owner-local persistence APIs. Callers provide owner authorization,
verified request/acceptance data and parsed, verified, unrevoked invitations;
transport, review and live admission integration arrive separately. `level`,
`decide` and the existing CLI/MCP/board behavior remain unchanged. Operational
defaults do not change until the cutover PR, after the four independent foundations.

Reads create no identities/files and do not rewrite or migrate stores. Only an
explicit new connection mutation upgrades the existing signed `intake.json` from
v1 to v2. Finite grants retain their expiry and are not converted to connections;
retained approvals/grants become prior-approved candidates requiring fresh consent.
Already pruned history cannot be recovered, and legacy records do not provide an
exact approval timestamp. The file retains its 1 MiB ceiling; live connections are
not evicted for capacity. Before mutation, preserve a v1 backup if rollback is
needed: older binaries cannot read v2. Do not run old and new writers concurrently.
