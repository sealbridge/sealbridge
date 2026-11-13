# Relay reliability

Proxied HTTP/SSE requests send `Connection: keep-alive` but use a disposable CONNECT tunnel per request, closed after the body ends or on cancellation/failure. Initial discovery GETs and temporary proxy failures sending an envelope retry up to four times with jitter. Envelope retries preserve the exact signed envelope ID and bytes; a replay rejection after an ambiguous send confirms prior admission without enqueueing twice. Authentication, TLS and admission refusals retain their existing behavior.

**English** | [日本語](./relay-reliability.ja.md)

## Request deadlines and retries

The direct Node HTTP relay transport disables keep-alive and pins every connection to the validated DNS addresses. Requests have a 45-second overall deadline (including the response body) and a 35-second socket idle timeout. DNS resolution is also bounded. SSE keeps the idle timeout but releases the overall deadline after stream headers arrive. Library callers can set `requestTimeoutMs` and `socketTimeoutMs` in `RelayClientSecurityOptions`. A timeout has code `ETIMEDOUT`. Successful DNS pins and security failures remain cached; transient DNS failures may resolve again, with the same address validation.

Worker and requester polling retry transient network errors and HTTP 429/502/503/504. Backoff starts at 125–250 ms, doubles, and caps at 15–30 seconds with jitter. Each failed attempt logs a metadata-only retry notice. Cancellation interrupts backoff. HTTP 403, validation, SSRF and other permanent failures still fail immediately. HTTP registration uses the same deadline and makes at most five attempts. Non-proxied transport sends remain single attempts. Gateway task envelopes use the persistent admission retry described below.

HTTP 401 on a RelayAuth request starts bounded authentication recovery. By default the client uses the full **120000 ms** window after the first 401, waiting 2, 10, 30, then 60 seconds (clamped to remaining time). Every attempt signs a new credential with a current timestamp and an uncached nonce. An explicit attempt cap retains the short jittered backoff above. Elapsed recovery time uses a monotonic clock. Each request is bounded by the remaining recovery window and its request timeout; earlier task deadlines and cancellation still apply. Intervening network errors or retryable HTTP statuses consume the same recovery budget. A successful protected operation resets its budget; unrelated successful operations do not reset an active failure. Concurrent failures of the same operation and recipient share the attempt bound without sharing responses.

| CLI flag (`worker start`, `delegate`, `mcp-server`) | Library option | Default |
| --- | --- | --- |
| `--relay-auth-retries <n>` | `maxAuthRecoveryAttempts` | Full recovery window unless capped; 0 restores immediate failure on 401 |
| `--relay-auth-recovery-timeout-ms <ms>` | `authRecoveryTimeoutMs` | 120000 ms; positive integer, at most 2147483647 |

Retry counts must be nonnegative integers, at most 2147483647. Library settings are available in `RelayClientSecurityOptions`, and on worker, requester and MCP options when they construct a client from a relay URL. Configure an explicitly supplied HTTP/SSE client at construction. Recovery covers polling, peek, SSE handshakes, delivery-status reads, wake registration and acknowledgements. It does not republish agent cards, change identity, renew invites, or restart task execution. Exhaustion reports `RELAY_AUTH_RECOVERY_EXHAUSTED`, including the local clock difference from relay Date when available; matching clocks also permit nonce replay or key/DID mismatch. On authentication recovery exhaustion, continuous workers close all in-flight tasks as interrupted without rerunning them, and remain unavailable while reconnecting every 60 seconds. One-shot workers and requesters fail on exhaustion. Diagnostics contain no credentials or response bodies.

## Proxy failure diagnostics

Proxy errors retain a sanitized `relayProxyFailure: { stage, code }` property. Their existing error messages and transient/permanent classification are unchanged. Retry lines (worker and requester), authentication recovery retries, and doctor failures render `RELAY_PROXY_UNAVAILABLE:<stage>/<code>`, for example `RELAY_PROXY_UNAVAILABLE:response/ECONNRESET`. The prefix identifies the proxy diagnostic family; it does not make CONNECT rejection or TLS verification errors retryable.

Stages are `proxy_connect` (TCP/DNS connection to the proxy), `connect_response` (waiting for or rejecting CONNECT), `tls` (TLS inside the tunnel), `request` (relay request before response headers), and `response` (body after headers). Codes are allowlisted errno/TLS codes or numeric HTTP status 100-599; unrecognized codes become `OTHER`. Raw errors, messages, response bodies, proxy URLs, hosts and credentials are never retained in this property or printed in these diagnostics. Legacy errors without stage metadata keep their existing short code.

`sealbridge doctor [--relay <url>] [--allow-private-relay]` probes `/health` through the same transport and reports `via proxy` without the proxy address. Private relay policy still applies; `--offline` makes no request. A successful health check only establishes that short request, not successful authenticated leased polling or SSE body delivery.

## Retention and admission

Retention starts at first admission and expires at `expiresAt <= now`. Leasing,
peek and repeated sends do not renew it. The relay cannot read encrypted task
deadlines; the gateway task default remains 600000 ms. Task traffic stays signed
ciphertext plus routing metadata; the relay adds no plaintext task fields.

| Library option | Worker binding | Local `relay start` flag | Default |
| --- | --- | --- | --- |
| `envelopeTtlMs` | `ACP_ENVELOPE_TTL_MS` | `--envelope-ttl-ms` | 86400000 ms (24 hours) |
| `maxQueueSize` | `ACP_MAX_QUEUE_SIZE` | `--max-queue-size` | 256 per recipient |
| `maxQueueBytesPerRecipient` | `ACP_MAX_QUEUE_BYTES` | `--max-queue-bytes` | 4194304 serialized UTF-8 JSON bytes per recipient |
| `maxEnvelopeBytes` | `ACP_MAX_ENVELOPE_BYTES` | `--max-envelope-bytes` | 262144 serialized UTF-8 JSON bytes |
| `maxEnvelopesPerSender` | `ACP_MAX_ENVELOPES_PER_SENDER` | `--max-envelopes-per-sender` | Selected recipient count, normally 256, per sender/recipient |
| `seenTtlMs` | `ACP_SEEN_TTL_MS` | — | 3600000 ms; bounded replay cache |

Library and local flag values must be positive integers. Malformed Worker
binding values retain the existing fallback to defaults. Explicit library/local
settings take precedence over library defaults; Worker bindings use the existing
environment parser. Leased envelopes remain in all occupancy counts. Equality
with a cap is allowed; only an admission that would exceed it is refused.

Recipient/global queue capacity and sender occupancy refusal return exactly:

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json; charset=utf-8
Retry-After: 60
Cache-Control: no-store

{"error":"RELAY_RETRY_LATER","retryable":true,"retryAfterMs":60000}
```

The hint is a positive integer bounded by 3600000 ms; `Retry-After` is its
ceiling in seconds (1–3600). This build uses 60000 ms. No occupancy or task
content is included. Refusal adds no queue, replay ID, expiry extension or wake
record. Expiry cleanup is independent. Invalid or oversized bodies remain
permanent HTTP 400 errors, including a single envelope that cannot fit the
recipient byte cap. `RELAY_CAPACITY` remains in the public error catalog for
other existing paths. WebSocket refusal is
`{"ok":false,"error":"RELAY_RETRY_LATER","retryable":true,"retryAfterMs":60000}`.
Existing HTTP clients surface `RELAY_REJECTED: 429` and do not automatically
retry sends; receive-side transient handling remains unchanged.

A live queued ID always returns `REPLAYED_ENVELOPE`, even after replay-cache
expiry or ring turnover. It retains the original bytes and expiry. Acknowledging
or dequeuing preserves existing replay records. Once both queued and remembered
records are gone, relay replay history is bounded; it is not indefinite.

Durable Objects retain original numeric expiries, leases, replay metadata and
alarms across reconstruction. Upgrading changes only new admission expiries,
without rewriting or extending existing ten-minute entries. The class and
migration tag stay unchanged. Hosted behavior requires an operator-controlled
Worker deployment/config update; this change performs no deployment. Local and
embedded relays adopt the default when upgraded. Drain before replacing an old
storage layout, using its configured retention interval rather than a fixed wait.

## HTTP lease and acknowledgement protocol

`GET /envelopes?recipient=<did>&lease=true` (also `/inbox/<did>`) opts into a 30-second visibility lease. The envelope remains queued and counts against all existing limits. Unacknowledged envelopes become visible after the lease expires, until the original configured TTL (default 24 hours) expires. Durable Objects persist the lease; restarting the object does not remove it. Requests without `lease=true` and WebSocket clients retain their existing destructive fetch behavior. `SseRelayClient` now requests leases; raw `/stream` requests without `lease=true` retain destructive delivery. Peek does not acquire or extend a lease.

After persistence or processing, acknowledge with `DELETE /envelopes/<envelopeId>?recipient=<did>` and a fresh recipient-bound RelayAuth token for the `receive` action. The existing response is 204 when removed, or 404 when already absent. The HTTP client treats either as acknowledgement success. A different recipient cannot read or delete another inbox. Acknowledgement does not remove the envelope replay record or weaken signature, sequence, timestamp, or authentication nonce checks.

Runtime HTTP polling opts into leases. `HttpRelayClient.receive` callers outside the runtime opt in using `{ lease: true }` and call `acknowledgeDelivery` themselves. The client verifies every fetched envelope before suppressing duplicates by recipient and envelope ID. It remembers deliveries for ten minutes, with a 16,384-entry cap, and retries acknowledgements of completed deliveries when redelivered. A full deduplication cache fails closed.

Workers with `--inbox` append an `envelopeId` field to each accepted record, flush the file to disk, then acknowledge the proposal. On restart, recorded envelope IDs prevent a second inbox append or task execution for the same proposal. Old records without this field remain readable. A failed persistence leaves the proposal unacknowledged. Without `--inbox`, a proposal is acknowledged after adapter execution succeeds. Session events are acknowledged after audit processing; control receipts are acknowledged when consumed. Relays or transports without the acknowledgement capability retain their previous runtime behavior.

The existing `--on-receive` hook remains a best-effort notification after persistence. Delivery durability comes from the inbox, not from hook completion. This protocol does not provide exactly-once external side effects or resume an interrupted bilateral session. A crash before persistence permits redelivery; after persistence the inbox is the recovery source. No automatic deployment of the hosted relay is performed by this change.

## Listener supervision and liveness

`WorkerNode.start()` and `worker start` supervise inbox reads, including reads while a task runs. A dropped connection retries with the jittered backoff above; successful reads refresh authentication. Status callbacks (`WorkerNodeOptions.onStatus`) and CLI stderr report `connected`, `reconnecting`, `unavailable`, or `stopped`. Exhausted HTTP 401 recovery, HTTP 403 and invalid signed envelopes stop the listener and fail its active task mailboxes. A recovered 401 keeps the existing listener and task state. Persistent task checkpoints retain their existing restart/reconciliation behavior. Without an audit or inbox path, recovery retains state only within the current process; a process restart has no durable task journal to reconcile.

`SseRelayClient` reconnects after EOF, connection resets, and classified transient errors, with a new signed credential on each connection. Its default connection timeout is 45 seconds and byte-idle timeout is 35 seconds; relay stream comments arrive every 15 seconds. Stop/abort interrupts reads and backoff. Terminal authentication or verification failures stay terminal. SSE receive filters are preserved on reconnect. The client requests `lease=true` and resumes by envelope ID and explicit acknowledgement, rather than treating the last parsed SSE frame as processed. Buffered frames survive reconnect; a frame lost before parsing is redelivered after its visibility lease expires. Completed deliveries are deduplicated and their lost acknowledgements retried. This requires a relay supporting the lease/DELETE protocol; a legacy destructive-only stream cannot guarantee redelivery.

During execution, workers send signed, encrypted `HEARTBEAT` envelopes (default every 15 seconds). The requester checks the peer identity, task, timestamp, and signature before refreshing its idle watchdog. Heartbeats have their own liveness semantics and do not add audit entries, change session sequence numbers, reset approval waits, extend task deadlines, or amend the agreed budget. Replayed or stale heartbeats cannot keep a peer alive. A peer idle timeout reports `PEER_IDLE_TIMEOUT`; a terminal relay status is reported directly, for example `RELAY_AUTH_RECOVERY_EXHAUSTED`. The shared requester inbox closes every attached task on a terminal transport failure and stops polling. Diagnostics omit HTTP response bodies and arbitrary transport text. CLI and MCP callers receive the same errors.

## Task timeout controls

There is no implicit two-minute absolute session cap. `delegate --help` and `worker start --help` list these options; all values are positive integer **milliseconds**, at most 2147483647:

| CLI flag | Library option | Default | Meaning |
| --- | --- | --- | --- |
| `--execution-timeout-ms` | `executionTimeoutMs` | Delegate: existing 60000 ms contract budget; worker: agreed budget | AI/adapter execution ceiling. Delegate proposes this limit as `budget.maxWallClockSeconds`, rounded down to whole seconds (minimum 1000 ms). A supplied manifest must fit the explicit limit. |
| `--task-timeout-ms` | `taskTimeoutMs` | 600000 ms (10 minutes) | Absolute task limit, including approval and settlement. Generated manifests use this deadline; an earlier supplied manifest deadline always wins. |
| `--wait-timeout-ms` | `waitTimeoutMs` | 600000 ms | Maximum time in each peer/owner approval wait phase: proposal/accept/start and delivery/verification/settlement. Authenticated activity does not reset this timer. |
| `--connect-timeout-ms` | `connectTimeoutMs` | 45000 ms | Bound each relay request/connection, including injected transports. Transient failures retry until cancellation or the task deadline. |
| `--transport-idle-timeout-ms` | `transportIdleTimeoutMs` | 90000 ms | Requester watchdog for authenticated peer activity during execution, independent of execution quota. |
| `--heartbeat-interval-ms` | `heartbeatIntervalMs` | 15000 ms | Worker heartbeat interval. On the requester this validates the expected cadence; configure the actual worker separately. Must be below the idle timeout. Workers also check the requesting peer's idle requirement before acceptance. |

These options are accepted by `delegate` and `worker start`, and by `DelegateOptions` / `RequesterClientOptions` / `WorkerNodeOptions`. MCP single and multi delegation accept the camelCase options. Multi delegation forwards the controls to every task. The existing library `timeoutMs` remains an alias for the overall limit; `taskTimeoutMs` takes precedence. An idle worker waiting for a new proposal is not subject to the per-task or approval-wait timers; owner stop still interrupts it.

An explicit execution limit above an explicit overall limit is rejected before a proposal is sent. Workers reject a proposed wall-clock budget exceeding their explicit execution or overall cap before `ACCEPT`. The execution quota and manifest deadline remain authoritative even with regular heartbeats or progress; budget increases still require the existing owner approval flow. Set execution, overall, and wait limits on both peers to accommodate longer tasks and human approvals. Timeouts report `EXECUTION_TIMEOUT`, `TASK_TIMEOUT`, or `PEER_WAIT_TIMEOUT` as appropriate; they never authorize a retry of uncertain task execution.

For example, to propose a five-minute execution budget with ten minutes for approvals and settlement, add `--execution-timeout-ms 300000 --task-timeout-ms 600000 --wait-timeout-ms 600000` to `delegate`. Configure the worker with compatible limits. Increasing `--wait-timeout-ms` alone does not extend the overall deadline.

## Offline wake notifications

Wake delivery is **off by default** and requires two opt-ins: an operator configures a channel, and the recipient authenticates a registration for that channel. No sender can supply a callback URL or command. The relay calls the channel only for queued work without an active inbox subscription/long poll. A wake is an Ed25519-signed object whose payload contains exactly `{ recipientDid, taskId, relay }`; ciphertext, sender identity, envelope contents, and approval material are omitted. Several envelopes for one recipient/task produce one successful wake within the retention window.

For a local relay, configure the operator-owned command and register the worker:

```sh
pnpm sealbridge relay start --port 8787 \
  --wake-command 'node /opt/sealbridge/wake-receiver.mjs' \
  --wake-relay http://127.0.0.1:8787 \
  --notification-key ~/.acp/relay.private.json
pnpm sealbridge worker start --key ~/.acp/worker.private.json \
  --relay http://127.0.0.1:8787 --allow-private-relay \
  --adapter sandbox --wake-channel default
```

Generate a dedicated relay key with the existing `sealbridge keygen` command before using `--notification-key`. Keep that file private. The wake command receives signed JSON on stdin, has ignored stdout/stderr, and must exit zero to acknowledge delivery. Its timeout kills its process group on POSIX. The command should validate the routing DID against its local worker configuration and start/wake that process through the owner's service manager. It must not execute anything supplied in task metadata. For receivers on another host, pin the relay's public DID and use `verifyRelayWake(notice, relayDid, relayUrl)` to check the signature, exact routing-only shape, and five-minute timestamp window; also check that the recipient DID is one the receiver operates. Retries carry fresh signatures for the same routing identifiers. Receivers should coalesce duplicate wakes by recipient/task/relay, including requests whose successful acknowledgement was lost.

The recipient registration uses `POST /wake?recipient=<did>`, a fresh recipient-bound `receive` RelayAuth token, and `{ "channel": "default" }`. `{ "channel": null }` unregisters and cancels outstanding retries. `HttpRelayClient.registerWake(did, channel)` returns the public signing DID for provisioning the receiver; registration must be renewed before its retention expires. Worker startup with `--wake-channel` registers before listening and then reconciles queued work through the ordinary authenticated inbox and existing checkpoint recovery. Registration does not replay old notifications. `--on-receive` continues to run after local acceptance/persistence; it does not wake an offline process.

| Relay CLI option | Library option (`InMemoryRelayOptions`) | Default |
| --- | --- | --- |
| `--wake-command <command>` | `wake.channels.default` (async callback receiving signed wake and abort signal) | Off |
| `--wake-relay <url>` | `wake.relay` | Required when wake is enabled; public URL advertised to recipients |
| `--wake-max-attempts <n>` | `wake.maxAttempts` | 5 total attempts |
| `--wake-retry-base-ms <n>` | `wake.retryBaseMs` | 1000 ms; doubles after failure, capped at 60000 ms |
| `--wake-timeout-ms <n>` | `wake.timeoutMs` | 5000 ms per attempt; maximum 2147483647 |
| `--notification-key <file>` | `notificationKey` | Ephemeral identity for a local relay; persist a key to keep the identity across restarts |
| `--notification-ttl-ms <n>` | `notificationTtlMs` | 3600000 ms for registration, wake dedup/retry retention, and recorded expiry notices |
| `--envelope-ttl-ms <n>` | `envelopeTtlMs` | 86400000 ms; new admission retention |

`worker start --wake-channel <name>` defaults to off. Library hosts can configure multiple named channels. They must periodically call `evictExpired()` and `flushWakeNotifications()`; the local relay runs maintenance every second. A custom callback must honor its abort signal. Notification attempts never extend envelope TTLs, task deadlines, budgets, or approval policy. A successful wake is a request to reconcile work, not approval to execute a task.

For Durable Objects, `ACP_WAKE_ENDPOINT` enables channel `default` at a fixed operator-provisioned HTTPS endpoint and requires `ACP_WAKE_RELAY` (the advertised relay URL). The endpoint receives the same signed JSON by POST; redirects are refused, non-2xx responses retry, and responses are discarded. `ACP_WAKE_MAX_ATTEMPTS`, `ACP_WAKE_RETRY_BASE_MS`, and `ACP_WAKE_TIMEOUT_MS` use the defaults above. `ACP_NOTIFICATION_TTL_MS` defaults to 3600000; `ACP_ENVELOPE_TTL_MS` defaults to 86400000. `ACP_NOTIFICATION_KEY` is an optional secret binding containing a dedicated relay KeyPair JSON; otherwise each inbox generates and durably retains its own signing identity. Provision the corresponding public DID at the receiver. Changing the signing key requires updating pinned identities. Embedded Durable Object hosts can instead supply `ACP_WAKE: RelayWakeOptions` with their own named callbacks.

Durable relays commit the envelope/outbox before notifying, and commit each attempt before calling the channel. Alarms drive retries and TTL cleanup; a restart resumes unfinished attempts. A crash after a receiver handles a wake but before the relay records success can cause another wake. Registrations, wake records, and expiry tombstones each have a separate cap of `maxSeenEntries` (default 4096); oldest records of that kind are evicted at capacity. These bounded metadata records do not consume or relax existing envelope count/byte/sender quotas. Wake delivery does not copy or decrypt an envelope.

## Expiry tombstones and requester notices

When an envelope expires while still queued, both in-memory and durable relays replace it with a signed `RelayDeliveryStatus` tombstone. Durable startup converts expired journal entries rather than silently dropping them; alarms perform the same conversion while idle. Tombstones contain only envelope/task/routing identifiers, expiry time, and `state: "expired"`. They are separate transport observations and do not forge peer audit entries or imply that an adapter never ran: a leased envelope can expire without its acknowledgement arriving.

A requester retrieves the notice with `GET /delivery-status?recipient=<original-recipient>&sender=<requester>&envelopeId=<id>`, authenticated by its own fresh `receive` RelayAuth token. The route stays on the original recipient shard, so an offline requester does not require a second inbox write or cross-shard forwarding. Other identities receive no status for that envelope. Pending envelopes return signed `state: "pending"`; absent, delivered, or no-longer-retained records return signed `state: "unknown"`. Unknown does not prove delivery. Network failures remain unreachable/transport errors, distinct from an authenticated expiry.

Admission responses advertise the inbox signing identity in `X-ACP-Relay-Did`. `HttpRelayClient` pins that identity for the accepted envelope and verifies status signatures and routing against it. HTTP/SSE runtime sessions check outstanding sends every second, retry transient status failures within the existing request/session deadlines, and throw `RelayEnvelopeExpiredError` with code `RELAY_ENVELOPE_EXPIRED` and the signed `notice`. Only that task fails; unrelated mailboxes remain active. Raw HTTP callers can retain the admission identity and verify notices themselves after a restart. Relays that do not advertise status support keep the previous timeout behavior. The relay cannot read an encrypted manifest deadline; the existing session deadline still enforces it independently. Configure queue TTL below the requester wait deadline if an expiry notice must arrive first.

## Persistent pending sends

CLI worker/delegate, board and MCP hosts persist approved task envelopes under
`<data-root>/delivery/<sha256-local-signer-DID>/`. An event and its audit entry
are committed together before either is sent. Transient send failures retry the
same signed ciphertext and envelope ID after 1 minute, 5 minutes, 15 minutes,
then 1 hour repeatedly, stopping at relay admission or the original task deadline.
A validated relay retry hint can delay an attempt further. Relay admission means
queue acceptance; it does not mean owner opening, agent execution or settlement.
`PENDING_OWNER_APPROVAL` remains terminal and requires explicit fresh resubmission.

Pending sends resume when the gateway next starts with the same signer and data
root. A stopped gateway performs no retries. Transport recovery does not restore
an arbitrary bilateral session or rerun an adapter. The default worker task journal
and recipient receipts prevent a repeated proposal from rerunning recorded work;
explicit inbox/audit journal paths retain precedence. Heartbeats and the separate
connection-consent outbox retain their existing behavior. Concurrent delegations keep
their own task and relay bindings while sharing the signer’s delivery store.

C1 persistence covers gateway process restart: completed writes and atomic replacement precede transmission or acknowledgement. Envelope records, receipts and the default task journal do not fsync files or directories; power-loss persistence is not guaranteed. Lease, retry and relay-admission bookkeeping may replay the same envelope ID after interruption. Explicit inbox/audit task journals retain their existing flush policy. Unchanged records and directory inventories reuse validation. Gateway index refresh, recovery scans and scheduled record cleanup yield between batches or records.

Session sends and processed receipts write unique temporary files asynchronously without acquiring the signer lock for preparation. Handles close before atomic publication; independent tasks sharing a signer and relay can write concurrently. Publication rechecks capacity and receipt state under the signer lock, without filesystem retry sleeps. The default task journal reuses its append handle and unchanged validated checkpoints; compaction and worker shutdown close the handle.

POSIX delivery directories/files use 0700/0600; Windows inherits the parent DACL.
Live sends remove completed batch ciphertext after consuming admission results.
Maintenance closes expired pending batches before pruning message metadata, and
removes remaining completed or closed batches.
Content-free message records and receipt deduplication persist until seven days
after `max(createdAt, original deliveryDeadline)`, without extending that horizon
on reads or retries. Maintenance runs at startup and every minute while active;
an inactive store may retain expired bytes until its next maintenance pass.
Local bounds are 1,024 pending envelopes, 32 MiB of envelope JSON, 256 KiB per
wire envelope and 10,000 retained messages/receipts per kind; a full or unwritable
store reports a fixed error before an unrecorded send and does not evict live work.

Embedders can inject `deliveryService` or `deliveryOptions` and explicitly call
`startDelivery()`/`stopDelivery()`. A custom transport needs a stable relay URL and
resolver for restart behavior; anonymous injected transports remain ephemeral.
Initialization, tool listing and local reads do not start delivery or create keys.
Direct transport `send()` remains a single attempt. No relay deployment is needed
for this gateway behavior; existing relay retention still governs admitted frames.
See [relay reliability](./relay-reliability.md).

The wire schema also accepts non-UUID IDs from other producers. Such incoming IDs use a derived UUID receipt filename; the signed receipt keeps the original ID and envelope digest. Locally generated outgoing IDs and their paths remain UUIDs.

`OUTBOX_STORE_BUSY` leaves an existing writer lock intact. Local lock recovery requires first checking that no writer is active; runtime attempt leases do not replace filesystem locks.

If completed-batch cleanup fails, the gateway reports a fixed storage error and retries cleanup during maintenance. The relay admission outcome is retained.


Optional `idempotencyKey` on `acp_delegate_task`, `acp_delegate_multi` and
`acp_resubmit_pending_request` is an exact Unicode string of 1–200 UTF-8 bytes.
For example, add `"idempotencyKey":"review-2026-11-02"` to a send call.
It is scoped to the local signer and tool across MCP sessions and restarts;
matching content returns the first stored result, including a held/error result,
without another proposal or pre-send approval (one approval per recipient for multi).
Changed content returns `IDEMPOTENCY_CONFLICT`; choose a new key for a new action.
A duplicate in the same server joins the active call. Another server returns
`IDEMPOTENCY_IN_PROGRESS` while its lease is active. After interruption it returns
`APPROVAL_INTERRUPTED` or `IDEMPOTENCY_RESULT_UNAVAILABLE` with the original IDs;
it never repeats the owner prompt or reconstructs an adapter execution.
Final verification remains separate. Key bindings and owner-only cached results
expire seven days after the original task deadline (latest child deadline for multi;
creation time if later). Reads do not renew retention; inactive stores may keep
expired bytes until maintenance. Reusing an expired key follows current policy.
Cached lookup does not resolve an expired invitation or a rebound alias, contact
a relay, or increment pending attempts. Pending resubmission remains explicit;
a new resubmission key identifies one fresh attempt under current policy.
Keys are optional; calls without them retain existing behavior. No relay deployment
is needed. The runtime single/multi options also accept `idempotencyKey`;
a keyed `beforePropose` hook must return verified authorization evidence.

The delivery root also contains the internal `.idempotency-gen` file. Its size increases by one before each operation or binding replacement/removal under the signer lock; both indexes use its inode and size together with directory metadata. The file is never shrunk or replaced by the store. Missing or replaced files require both indexes to be rebuilt. Signed record formats are unchanged. Older versions ignore this root-level file; directory metadata remains part of change detection, with the existing possibility of matching stamps between concurrent older writers. Downgrading retains the older index behavior.

C2 operation, authorization, binding and result records use the same process-restart durability: completed writes and atomic publication, without file or directory fsync. Power-loss persistence is not guaranteed.

The local cache permits 10,000 retained operations and 16 MiB aggregate cached-result JSON per signer, with a 4 MiB operation-record bound. Active calls reserve their result space before approval; capacity and persistence failures return fixed `IDEMPOTENCY_STORE_*` codes without evicting live work.

## Recipient delivery observations

For validated 0.2.0 tasks, upgraded gateways exchange encrypted, recipient-signed
`DeliveryStatus` frames containing identifiers, state, revision and timestamps only.
They travel separately from task sequences and bilateral audit entries. Peers without
version declarations keep existing 0.1.0 behavior and receive no new frame.
Unknown, pending and former open peers receive only `received_held` and `closed`.
The initial admission classification stays attached to that task; connecting later
does not release its detailed history. Current disconnection suppresses queued detail;
blocking suppresses every queued status. Inspection completion and content display
alone do not open a task. Connection-only approval closes the original held task
without recording `opened`.

| State | Source and meaning |
| --- | --- |
| `queued` | Local approved ciphertext persisted in the outbox |
| `relayed` | Relay admission; no recipient opening implied |
| `received_held` | Recipient persisted quarantine content; an existing authenticated pending response can also establish this local observation |
| `opened` | Recipient committed human contract approval after completed inspection |
| `handed_to_agent` | Recipient recorded the adapter input boundary; no proof of reading or completed execution |
| `replied` | Sender verified the returned delivery, independently of final owner verification |
| `closed` | Local deadline/closure or recipient terminal held disposition; no proof of non-execution |

Status facts outlive quarantine deletion. Successful result cleanup does not create
`closed`. Records contain no task content, inspection details or closure reasons.
They use the existing signer-scoped delivery store, POSIX 0600 files/0700 directories
and atomic publication (Windows inherits parent DACLs). Observations, status batches
and revision receipts follow the C1 process-restart policy: completed writes without
file or directory fsync; power-loss persistence is not guaranteed. The fixed retention horizon
is seven days after the original deadline, or creation if later; reads hide expired
records without writing. Active gateway maintenance removes expired bytes. Status
frames retry unchanged for at most 24 hours after the fact, within that horizon.
A stopped gateway neither retries nor polls. Explicit gateway startup restores the
reader for retained outgoing message IDs, including after a pending delegation ends;
initialization and tool listing do not start it. This is an observation record for a
later local query, not a new MCP tool or an execution/audit guarantee.
A cached `idempotencyKey` lookup returns the first result without a new envelope.
Recipient observations continue to update the original message record; cached
lookups create no additional delivery records, observations or revision receipts.

Both gateways need this implementation for recipient observations. No relay deployment
is required; relay retention configuration is a separate change.

### Read local message status

A send with `idempotencyKey` keeps its original message and task IDs on cached retries.
This lookup reads the current retained observations for those IDs, independently of
the cached send result.

Use `acp_message_status {"messageId":"<original PROPOSE UUID>"}` or
`acp_message_status {"taskId":"<original task ID>"}` with exactly one selector.
It reads messages sent by this gateway's requester signer, including other local
entry points using the same signer/data root. It never sends, refreshes, polls,
acknowledges, starts delivery or cleans up records. Multiple retained task matches
return `MESSAGE_STATUS_AMBIGUOUS`; use `messageId` to select one.

Records become absent at the fixed horizon: seven days after the original delivery
deadline (or creation time if later). Unknown IDs, foreign IDs, expired records and
missing local identities all return `{"found":false}`. An unknown peer with a retained
message can still have `received_held` or `closed`; absence makes no delivery claim.
`updatedAt` is the last committed fact time. The initial proposal's retained retry
count becomes zero after C1 removes its completed batch member. Reads preserve files;
active gateway maintenance removes expired bytes independently.

Recipient detail follows C4: initially unknown tasks disclose only `received_held`
and `closed`, including after later connection. Recipient status is a signed gateway
claim, separate from bilateral audit; handoff does not prove reading or execution.
Legacy peers have null recipient status. This tool is distinct from a cached first
delegation result and explicit pending resubmission. A gateway upgrade provides the
tool; richer observations require C4 peers. No relay deployment is needed.

Persistent workers treat a strictly decoded `REPLAYED_ENVELOPE` HTTP 400 on a send as prior relay admission, including direct recovery/control sends. Initial registration, checkpoint notifications and recovered-proposal acknowledgements share the reconnect supervisor: transient transport failures, exhausted auth recovery, capacity refusal and HTTP 401/408/429/5xx leave the worker unavailable and retry after one minute, without replaying execution. This includes raw registration/send 401s and message-only auth exhaustion through bounded, cycle-safe cause chains, even if transport-level auth retries are disabled. A permanent cause takes precedence: 403 remains a policy refusal requiring intervention. Unclassified relay/SSE failures retry instead of exiting solely because of their prefix. A fetched proposal is retained across a failed recovery notification/ack. Permanent configuration/auth-policy, key and integrity failures still stop the worker; the CLI emits `WORKER_EXIT` / `WORKER_TERMINAL`, a sanitized relay reason and a Japanese explanation. One-shot execution is unchanged. Authentication recovery renews request credentials; it does not itself resend task envelopes.
