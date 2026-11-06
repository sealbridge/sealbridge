# Held-content library boundary

[日本語](held-content.ja.md)

`@acp/runtime` exports `HeldRequestStore`, `HeldRequestReview`, and the injected
`HeldContentReviewProvider`. Runtime, CLI and board attach these interfaces to live admission. Inspection is unavailable by default; see [connections admission](admission.md).

The store retains original encrypted signed envelopes with owner-signed metadata
under `<dataRoot>/quarantine/<sha256-local-owner-DID>/<id>.json`; summaries omit
input, titles and descriptions. The default provider returns `unavailable`, so
content remains held. An opt-in offline rule provider is available separately; it is never installed automatically.
`hold`, `inspect`, `showReviewedContent`, `discard`, and `expire` are library APIs.
Content display requires a completed receipt bound to the owner, kind, content,
envelope and report digests; it does not approve execution or connection consent.
Task digests use `digest({manifest,input})`; connection and reserved application
digests cover the entire decrypted body. Inspection timeout defaults to 5 seconds;
errors, timeout and unavailable results leave content held.

Hosts authorize owner review, validate sender-owner delegation and deadlines,
acknowledge only after `hold` succeeds, schedule `expire`, call `discardPeer` on
block, discard offers after decisions and tasks after result transmission. Reads
leave files intact. Retention is the earlier of the deadline and 24 hours. Bounds:
100 records, 256 KiB per envelope, 32 MiB of envelopes, plus 8 KiB metadata per
record; live records are not evicted. POSIX paths use 0700/0600; Windows inherits
the parent DACL without ACL verification. Supply `workspaceDir` when known to
reject storage within an adapter workspace. Custom providers remain host integrations. The standalone CLI supplies built-in
owner-facing task display: `tasks list/show/approve/reject` select individual held
tasks; interactive workers display each fresh task before their live owner gate.
Display validates the signed proposal, manifest, recipient and content digest and
renders manifest/input/capabilities as literal JSON with terminal controls escaped.
Only successful rendering returns completion to `HeldRequestReview.inspect`, which
signs the existing v1 `HeldContentInspection` receipt in the existing held record.
Its report digest is `digest({type:'CliTaskDisplay',v:1,contentDigest})`. This means
validated content was rendered, not automated assessment or owner consent. Failed,
interrupted or unavailable display does not record completion. Cached receipts do
not replace display in a new owner operation. No storage format changes are needed.
Terminal held approve/reject closes only the selected ciphertext locally; it stores
no execution approval. A fresh task needs new inspection and live owner approval.
The library default provider and non-interactive workers remain unavailable.
Connection metadata review remains separate.

`taskContent(envelope, owner, contentDigest, envelopeDigest?)` is available from
`@acp/runtime` and `sealbridge/sdk`, with the `HeldTaskContent` type. It verifies
the outer envelope signature/recipient before decrypting and checks the manifest,
proposal signature, PROPOSE/sequence-zero, task/requester/worker-owner bindings,
an own input field and `digest({manifest,input})`. Pass the stored envelope digest
to check the exact envelope as well. It returns only manifest/input/capabilities
(default `[]`), excluding invitation, connection and transport fields.

This sensitive in-memory result is inspection material. Display callers must
separately require completed owner-bound review; the helper cannot establish that
gate and does not create a receipt or authorize opening/execution. Inspection
providers may use it before returning completion. Capability authority, trust and
current grant/deadline usability remain live-admission checks; no wall-clock check
prevents verification of terminal attempts. It performs no heuristic content
assessment. Keep plaintext out of logs/storage and render literal data. Errors are
fixed `INVALID_PROPOSAL`, `UNENCRYPTED_ENVELOPE_REJECTED` or
`ENVELOPE_DECRYPTION_FAILED`, without plaintext or parser details. The helper has
no file/network effects. Existing `showReviewedContent` and its completed-review
gate remain unchanged; it returns the full proposal body, so use the task-only
projection for task display. See the [SDK contract](../sdk.md#verified-held-task-content).

Gateway task sends use a signer-scoped persistent envelope outbox and worker receipt/default
checkpoint records under `<data-root>/delivery/<sha256-local-signer-DID>/`. A repeated
proposal does not authorize another adapter invocation. Inspection and owner opening
remain required on their existing paths. Pending review terminates the delegation call;
outbox retries do not resubmit it. Ciphertext retry ends at relay admission or the original
deadline, and a stopped gateway waits for restart. See [relay reliability](../relay-reliability.md).

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

### Opt-in rule inspection

`createRuleBasedContentReviewProvider` is exported by `@acp/runtime` and
`sealbridge/sdk`; the pure scanner and immutable rule descriptors are exported by
`@acp/core` and the SDK. Inject it through `new HeldRequestReview(owner,
{provider: createRuleBasedContentReviewProvider(options)})`, then pass `heldReview`
to `WorkerNode`. See the [SDK example and report contract](../sdk.md#opt-in-offline-content-rules).
There are no new CLI or MCP options; display inspection and the default
`unavailable` provider keep their existing behavior.

The task-only provider authenticates the envelope/proposal and held bindings,
projects the full manifest, input and capabilities, and scans them in a fixed
compiled child using bounded JSON over IPC. It passes no keys or transport
credentials, inherits an environment allowlist, writes no plaintext files/logs,
and makes no network calls. It does not execute, unpack or recursively decode
content; it does not provide kernel network isolation. Default timeout is 5 seconds
(maximum 45 seconds); set it at or below `inspectionTimeoutMs`. Abort, timeout,
malformed output, child failure, bound excess and callback failure cannot complete
inspection. Errors leave content held, including the existing display gate.

Rules identify size/format limits, invisible characters, instruction phrases,
URL forms, secret requests/presence, code and bounded base64 binary/archive
prefixes. The initial bounds are 256 KiB content, depth 32, 100,000 nodes/keys,
64 KiB of UTF-8 per string, 100 findings, 64 KiB decoded bytes and 64 KiB child result.
Limits may be lowered. These are heuristic findings with fixed codes, redacted
sensitive path segments and no evidence snippets. Quoted text can match and
unrecognized forms can pass. URLs and credential forms are never checked online.

`pass`, `warn` and `block` all record existing `HeldContentInspection` v1
`status:'complete'`; `block` is the strongest owner warning and adds no execution
veto. Completion only supplies inspection material. Connected tasks still require
live human contract opening; unknown tasks stay terminal pending. Inspection
alone does not invoke an adapter or approve a connection.

`onReport(recordId, report)` delivers a copy in memory. Only the existing
`reportDigest` is stored, binding the report, effective limits, record, owner,
kind, content and exact envelope. Reports have no new store, audit event or
approval-detail field. A cached receipt has no findings; if a restarted host needs
a report, explicitly recompute through the provider with the stored envelope and
bound context. Do not fabricate a clean report from cached completion. No protocol,
schema, required manifest field, wire or stored-record format changes are made.
