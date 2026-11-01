# Relay reliability

**English** | [日本語](./relay-reliability.ja.md)

## Request deadlines and retries

The Node HTTP relay transport disables keep-alive and pins every connection to the validated DNS addresses. Requests have a 45-second overall deadline (including the response body) and a 35-second socket idle timeout. DNS resolution is also bounded. SSE keeps the idle timeout but releases the overall deadline after stream headers arrive. Library callers can set `requestTimeoutMs` and `socketTimeoutMs` in `RelayClientSecurityOptions`. A timeout has code `ETIMEDOUT`. Successful DNS pins and security failures remain cached; transient DNS failures may resolve again, with the same address validation.

Worker and requester polling retry transient network errors and HTTP 429/502/503/504. Backoff starts at 125–250 ms, doubles, and caps at 15–30 seconds with jitter. Each failed attempt logs a metadata-only retry notice. Cancellation interrupts backoff. HTTP 403, validation, SSRF and other permanent failures still fail immediately. HTTP registration uses the same deadline and makes at most five attempts. Sends are not automatically retried, because an uncertain POST may already have been accepted.

HTTP 401 on a RelayAuth request starts bounded authentication recovery. By default the client allows **three additional attempts** within **120000 ms** of the first 401. Every attempt waits with the jittered backoff above, then signs a new credential with a current timestamp and new nonce. Elapsed recovery time uses a monotonic clock. Each request is bounded by the remaining recovery window and its request timeout; earlier task deadlines and cancellation still apply. Intervening network errors or retryable HTTP statuses consume the same recovery budget. A successful protected operation resets its budget; unrelated successful operations do not reset an active failure. Concurrent failures of the same operation and recipient share the attempt bound without sharing responses.

| CLI flag (`worker start`, `delegate`, `mcp-server`) | Library option | Default |
| --- | --- | --- |
| `--relay-auth-retries <n>` | `maxAuthRecoveryAttempts` | 3 additional attempts; 0 restores immediate failure on 401 |
| `--relay-auth-recovery-timeout-ms <ms>` | `authRecoveryTimeoutMs` | 120000 ms; positive integer, at most 2147483647 |

Retry counts must be nonnegative integers, at most 2147483647. Library settings are available in `RelayClientSecurityOptions`, and on worker, requester and MCP options when they construct a client from a relay URL. Configure an explicitly supplied HTTP/SSE client at construction. Recovery covers polling, peek, SSE handshakes, delivery-status reads, wake registration and acknowledgements. It does not republish agent cards, change identity, renew invites, or restart task execution. Exhaustion reports `RELAY_AUTH_RECOVERY_EXHAUSTED` and asks the operator to check system clock synchronization and the key/DID pairing. Worker startup exits non-zero on exhaustion. Diagnostics contain no credentials or response bodies.

## HTTP lease and acknowledgement protocol

`GET /envelopes?recipient=<did>&lease=true` (also `/inbox/<did>`) opts into a 30-second visibility lease. The envelope remains queued and counts against all existing limits. Unacknowledged envelopes become visible after the lease expires, until the original ten-minute TTL expires. Durable Objects persist the lease; restarting the object does not remove it. Requests without `lease=true` and WebSocket clients retain their existing destructive fetch behavior. `SseRelayClient` now requests leases; raw `/stream` requests without `lease=true` retain destructive delivery. Peek does not acquire or extend a lease.

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
| `--envelope-ttl-ms <n>` | `envelopeTtlMs` | 600000 ms; existing envelope TTL |

`worker start --wake-channel <name>` defaults to off. Library hosts can configure multiple named channels. They must periodically call `evictExpired()` and `flushWakeNotifications()`; the local relay runs maintenance every second. A custom callback must honor its abort signal. Notification attempts never extend envelope TTLs, task deadlines, budgets, or approval policy. A successful wake is a request to reconcile work, not approval to execute a task.

For Durable Objects, `ACP_WAKE_ENDPOINT` enables channel `default` at a fixed operator-provisioned HTTPS endpoint and requires `ACP_WAKE_RELAY` (the advertised relay URL). The endpoint receives the same signed JSON by POST; redirects are refused, non-2xx responses retry, and responses are discarded. `ACP_WAKE_MAX_ATTEMPTS`, `ACP_WAKE_RETRY_BASE_MS`, and `ACP_WAKE_TIMEOUT_MS` use the defaults above. `ACP_NOTIFICATION_TTL_MS` defaults to 3600000; the existing `ACP_ENVELOPE_TTL_MS` defaults to 600000. `ACP_NOTIFICATION_KEY` is an optional secret binding containing a dedicated relay KeyPair JSON; otherwise each inbox generates and durably retains its own signing identity. Provision the corresponding public DID at the receiver. Changing the signing key requires updating pinned identities. Embedded Durable Object hosts can instead supply `ACP_WAKE: RelayWakeOptions` with their own named callbacks.

Durable relays commit the envelope/outbox before notifying, and commit each attempt before calling the channel. Alarms drive retries and TTL cleanup; a restart resumes unfinished attempts. A crash after a receiver handles a wake but before the relay records success can cause another wake. Registrations, wake records, and expiry tombstones each have a separate cap of `maxSeenEntries` (default 4096); oldest records of that kind are evicted at capacity. These bounded metadata records do not consume or relax existing envelope count/byte/sender quotas. Wake delivery does not copy or decrypt an envelope.

## Expiry tombstones and requester notices

When an envelope expires while still queued, both in-memory and durable relays replace it with a signed `RelayDeliveryStatus` tombstone. Durable startup converts expired journal entries rather than silently dropping them; alarms perform the same conversion while idle. Tombstones contain only envelope/task/routing identifiers, expiry time, and `state: "expired"`. They are separate transport observations and do not forge peer audit entries or imply that an adapter never ran: a leased envelope can expire without its acknowledgement arriving.

A requester retrieves the notice with `GET /delivery-status?recipient=<original-recipient>&sender=<requester>&envelopeId=<id>`, authenticated by its own fresh `receive` RelayAuth token. The route stays on the original recipient shard, so an offline requester does not require a second inbox write or cross-shard forwarding. Other identities receive no status for that envelope. Pending envelopes return signed `state: "pending"`; absent, delivered, or no-longer-retained records return signed `state: "unknown"`. Unknown does not prove delivery. Network failures remain unreachable/transport errors, distinct from an authenticated expiry.

Admission responses advertise the inbox signing identity in `X-ACP-Relay-Did`. `HttpRelayClient` pins that identity for the accepted envelope and verifies status signatures and routing against it. HTTP/SSE runtime sessions check outstanding sends every second, retry transient status failures within the existing request/session deadlines, and throw `RelayEnvelopeExpiredError` with code `RELAY_ENVELOPE_EXPIRED` and the signed `notice`. Only that task fails; unrelated mailboxes remain active. Raw HTTP callers can retain the admission identity and verify notices themselves after a restart. Relays that do not advertise status support keep the previous timeout behavior. The relay cannot read an encrypted manifest deadline; the existing session deadline still enforces it independently. Configure queue TTL below the requester wait deadline if an expiry notice must arrive first.
