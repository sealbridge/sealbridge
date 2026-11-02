# Connections admission

[日本語](admission.ja.md)

Workers use four owner-local states: `none`, `pending`, `connected`, and `blocked`.
Connected means limited consent with no expiry. Every limited task requires a
completed inspection and a separate human opening before acceptance, for every
adapter. Automatic contract policy does not replace that opening. The default
inspection provider reports `unavailable`, so content remains held. An inspection
provider is required before public release.

Valid requests from unconnected peers are held as encrypted envelopes for at most
24 hours or the task deadline. They return terminal `PENDING_OWNER_APPROVAL`,
`retryable:false`, CLI exit 3. Do not retry automatically. Schema, signature,
capability, declared budget, advertised skill and operator perimeter checks precede
holding or invite redemption. New intake metadata has no title or description
preview. `requests show` returns `INSPECTION_INCOMPLETE` until inspection completes.
Plaintext inbox files and receive hooks run only after inspection and opening.

```sh
sealbridge worker start --adapter sandbox --publish --allow-task-type json --max-input-tokens 50000
sealbridge discover --skill json-task
sealbridge requests list
sealbridge requests show REQUEST_ID
sealbridge requests approve REQUEST_ID
sealbridge requests discard REQUEST_ID
sealbridge requests deny REQUEST_ID
```

Publication only adds the signed card to the directory. Unpublished workers use the
same admission rules. `--allow-requester` constrains peers; it grants no trust.
General budgets use `--max-input-tokens`, `--max-output-tokens`,
`--max-tool-invocations`, `--max-wall-clock-seconds`; rate uses
`--max-requests-per-minute`. Settings `public` controls publication only and
`alwaysAsk:false` returns `CONNECTION_OPENING_REQUIRED`.

An invitation records inviter consent and binds to the first authenticated owner DID
that uses it. A different owner using the same valid token is held. Binding is
retained through token expiry after disconnect. Expired, mismatched or revoked
tokens remain errors before mutation. Established connections survive invitation
expiry/revocation; use verified peer DID routing without the retired token for
subsequent tasks. A saved `workerRef` still selects its saved invitation and checks
that invitation on every use. Importing or previewing never connects either role.

```sh
sealbridge accept --paste --alias reviewer
sealbridge connections confirm-invite reviewer --role requester
sealbridge connections request --to PEER_DID --relay https://relay.sealbridge.dev --role worker
sealbridge connections list --role worker
sealbridge connections approve REQUEST_ID --role worker
sealbridge connections reject REQUEST_ID
sealbridge connections withdraw REQUEST_ID
sealbridge connections disconnect PEER_DID
sealbridge connections block PEER_DID
sealbridge connections unblock PEER_DID
sealbridge connections prior-approved
sealbridge connections connect-prior PEER_DID --relay https://relay.sealbridge.dev
sealbridge connections sync --role requester --relay https://relay.sealbridge.dev --once
```

All decisions require a human TTY or an injected human review provider. There is no
`--yes` connection decision. Confirm the exact local role/DID and peer owner DID;
requester and worker default identities are separate. An outgoing offer persists
sender consent before transmission and expires after 14 days. Reject starts a
seven-day offer cooldown; tasks can still be held. Discard removes content only;
`requests deny` retains its block meaning. Block is one-sided and silent. Disconnect
and block affect subsequent admission; accepted work continues unless cancelled.
Mutual requests derive one connection ID from the two DIDs in ascending order.
Control acceptance and ACK state commit before relay acknowledgement. Sync never
resubmits tasks. Held content expires independently of outgoing consent.

Task approval and connection consent are separate decisions. An interactive CLI or
MCP form may ask sequentially; without explicit connection consent no request is
attached. A held task without sender connection consent can initiate an outgoing
offer when reviewed; local approval cannot infer the remote owner's consent.
After connection review the requester owner explicitly starts a fresh task (or
`pending resubmit` with fresh audit/output paths), with new inspection and opening.

Legacy signed intake and invite files remain readable. Reads/listing do not rewrite
or migrate bytes. Finite grants from earlier releases do not skip holding or become
connections. Retained approval evidence appears under `prior-approved` and needs a
new owner action and remote consent. Historical denials remain blocks. Explicit CLI
contacts stay independent. `requests approve ID --trust trusted` is a separate
legacy 24-hour grant command; connection commands never create trusted authority.
Back up v1 intake before the first mutation if rollback is needed; old binaries do
not read v2. Do not run old and new writers concurrently. Connection and protocol
stores retain the 1,000-record / 1 MiB bounds and do not evict established records.

Retired CLI `--open`, `--access-mode`, `--open-*`, `--allow-any-requester` and JS
`accessMode`, `openPolicy`, `allowAnyRequester` options return `ACCESS_MODE_REMOVED`
with migration guidance. Use host budget/type/rate flags above. MCP discovery's
removed `accessMode` argument returns JSON-RPC -32602. Discovery returns all current
verified published cards, including legacy cards, without operational mode fields;
original signed cards remain intact. `acp_list_connections {}` and
`acp_list_connection_requests {}` read local metadata for the server signer without
creating an identity. Owner decisions stay in the human CLI.

Board claims and dispatch require the selected poster identity's current local
connection (`CONNECTION_REQUIRED` otherwise). A connection does not approve a task
or lease. Dispatch checks connection and protocol before lease consumption, then
consumes before transmission; ambiguous transmission never causes automatic retry.
One-time task tickets and a separate application queue are deferred.

The release clock is documented in [protocol versions](protocol-versions.md).
