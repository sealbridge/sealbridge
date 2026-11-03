# Connections admission

[日本語](admission.ja.md)

Release note: The following are available in the next release of the sealbridge npm
package after 0.2.2; they are not supported in CLI 0.2.2:
`requests`, `accept`, `connections`, `pending`, `worker start --allow-task-type`,
`acp_list_connections`, `acp_list_connection_requests`.

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
Embedders can mark imports as unconfirmed for explicit age-based cleanup. Retain them
before use; `confirm-invite` retains before attempting owner confirmation, even if
that attempt is rejected or interrupted. Retention grants no connection consent.
See [invite lifecycle](invite-lifecycle.md).

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

## Owner admission review

`ConnectionAdmissionReview` from `@acp/runtime` is an opt-in owner-facing queue
for held inbound connection requests. Continue receiving through the existing
listener or `ConnectionRouter`; the queue does not receive or poll. Use the same
owner, intake store, relay and held-content data root:

```ts
const admission = new ConnectionAdmissionReview({
  owner, agentCard, relayUrl, relay, store, heldOptions: identityOptions,
});
const requests = admission.list();
// Bind these calls to explicit owner actions in the host UI.
await admission.approve(requests[0].id);
// Alternatively: admission.reject(requests[0].id);
```

Pass the existing held-content `transitionSink` in `heldOptions` when the host
records delivery status or other cleanup observations.

`list()` reads without writing or inspecting. Its allowlisted projection includes
request/held IDs, request digest, full and shortened owner/agent DIDs, peer card
display name (`peerDisplayName`, optional when unknown), creation/receipt/held-expiry
times and relay URL. An optional
`inviteAlias(inviteDigest)` callback supplies an existing local label without
resolving a token; absent labels are omitted. Display labels are bounded to 120
code points, omit control/format characters and replace invitation token strings.
Names are peer-provided data. Messages, task input, envelopes, tokens and keys are
never returned. Review is scoped to one owner and relay. Expired held content,
inactive offers, accepted requests and blocked peers are excluded.

`approve(id)` accepts a held ID or request ID. It revalidates the request, card,
invitation and current peer policy, then uses built-in structural connection
metadata inspection during that owner operation only. The inspection receipt
binds the request and ciphertext digests. It records signed owner consent and
limited acceptance through the existing exchange. First invite use also commits
the original invite binding; a different owner can receive separate explicit
consent without changing that binding. Delivery failure returns connected with
`CONNECTION_DELIVERY_PENDING`; the existing control outbox handles delivery.
`reject(id)` uses the existing peer-wide rejection/cooldown and discards that
peer's held content. Repeated or stale decisions return `CONNECTION_NOT_PENDING`.

```sh
sealbridge connections review list --role worker
sealbridge connections review approve REQUEST_ID --role worker
sealbridge connections review reject REQUEST_ID --role worker
```

After approval, local `connectionStatus()` / `connections status` reports
`connected`, with `acknowledgementPending` until the peer's ACK arrives. The sender
remains `pending_peer` until it receives acceptance. Rejection reports `inactive`
locally and leaves the sender `pending_peer`; no rejection notification is sent.
Known display names remain in connection list/status metadata after invite removal.
Pending invitation imports must be retained before use; `connections confirm-invite`
retains before requesting owner confirmation. Inbound review uses the held envelope,
without resolving or retaining entries in an invitation store.

CLI decisions require a human TTY or the existing injected human confirmation
callback; there is no unattended approval flag or MCP decision tool. Listing and
rejection do not contact the relay. Listing creates no identity. The host must
expose programmatic decisions only to explicit owner actions. Constructing or
listing the queue grants no consent. Existing `connections approve` keeps its
injected-inspector requirement, while `connections review approve` explicitly
selects built-in connection metadata inspection. Default receipt inspection and
task inspection remain `unavailable`. Tasks still require their own inspection
and owner opening; no task is forwarded to an adapter by admission review.
Existing store formats and the wire protocol are unchanged. Existing atomic,
owner-only storage applies; no relay deployment is needed.


The optional send-tool `idempotencyKey` caches the first result for the local signer,
tool and exact request. A cached `PENDING_OWNER_APPROVAL` stays `retryable:false`
with its original pendingId and never resubmits. Explicit resubmission can use its
own key to identify one fresh attempt, with current policy and approval checked
before its first transmission. Duplicate cached calls do not resolve invitations
again or change connections, inspection or owner opening. See
[relay reliability](../relay-reliability.md) for key scope, expiry and interruption.

### Recipient delivery status

Recipient-signed `DeliveryStatus` for validated 0.2.0 tasks records content-free
held/opened/adapter-handoff/closed observations separately from task sequences and
bilateral audit. Unknown peers get only `received_held` and `closed`; later connection
approval does not release that task's history. Inspection/display alone does not open
a task, and successful result cleanup does not close it. Queued detail is suppressed
on disconnect; blocking suppresses all queued status. Legacy peers without version
declarations retain 0.1.0 behavior. Status records use the fixed delivery deadline plus
seven days; active maintenance deletes expired bytes. A handoff does not prove reading
or execution. Both gateways need support; no relay deployment is required.
See [relay reliability](../relay-reliability.md) for status sources, retention and lifecycle behavior.

### Local message status

A send with `idempotencyKey` keeps its original message and task IDs on cached retries.
This lookup reads the current retained observations for those IDs, independently of
the cached send result.

`acp_message_status {"messageId":"<original PROPOSE UUID>"}` or
`acp_message_status {"taskId":"<original task ID>"}` reads sender-local status without
sending, refreshing, polling or cleanup. Use exactly one selector; ambiguous task IDs
require `messageId`. Records expire seven days after the original deadline (or creation
time if later); absent, foreign and expired IDs return `found:false`. Initially unknown
peers disclose only `received_held`/`closed`. Recipient claims are separate from bilateral
audit; handoff does not prove reading or execution. This read is distinct from a cached
delegation result and explicit pending resubmission. No relay deployment is required;
richer observations require C4 peers. See [relay reliability](../relay-reliability.md).
