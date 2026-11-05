# Context grants (CP1)

`TaskManifest.contextGrant` is an optional 0.2.0 contract property for a
sender's selected context. Existing manifests without it remain valid in both
supported versions. No protocol version, peer floor, or release clock changes.
A peer with the older closed 0.2.0 schema will reject this optional extension;
use it only with CP1-capable peers. There is no automatic downgrade that strips
the grant.

| Delivery mode | Delegation depth | Retention declaration | Input retention |
| --- | --- | --- | --- |
| `view_only` (builder default) | 0 | `ephemeral_view` | false |
| `hand_over` | 0 | `keep_deliverable` | false in CP1 |

`hand_over` permits keeping the agreed, accepted deliverable. It does not permit
keeping the input selection. `approval_redelegation` is a reserved enum value;
active creation and acceptance return `CONTEXT_GRANT_MODE_UNAVAILABLE` pending
CP5a. CP1 adds no delegation links or Desktop controls.

## Build and validate

```ts
import { buildTaskManifest, validateManifest, validateContextGrantUse } from 'sealbridge/sdk';

const manifest = buildTaskManifest({
  ownerDid, workerDid, title: 'Production feasibility',
  description: 'Review selected dimensions and material.',
  contextGrant: {
    selectors: ['$.items[*]'],
    fieldsAllowed: ['dimensions', 'material'],
    fieldsDenied: ['customerName'],
    angle: 'Report feasibility and missing dimensions.',
    // Optional: deliveryMode: 'hand_over'
  },
});
validateManifest(manifest);
validateContextGrantUse(manifest, selectedInput);
```

The opt-in builder defaults to `view_only`, 24 hours from manifest `createdAt`,
64 KiB, the mode's retention declaration, and `inputRetentionAllowed: false`.
It does not change default manifests. `RequesterClient.delegate` also accepts
these builder options as `contextGrant`; a supplied `manifest` is authoritative.

Selectors are non-empty opaque strings describing the sender's selection.
CP1 does not define a selector language, fetch source data, or filter input.
The sender must construct the selection before submitting it. Allowed and denied
field identifiers are compared literally; any identical identifier in both lists
is refused. Empty selectors, blank angles, unknown grant properties (including a
second `maxDelegationDepth`), and mismatched depth, retention or filesystem scope
are refused. `view_only` requires the existing
`filesystemScope: ephemeral_workspace_only` declaration. The builder uses that
scope for both modes. CP1 refuses `inputRetentionAllowed: true` in either mode.
A worker configured with the persistent plaintext `inboxPath` refuses grants.

The schema caps `maxBytes` at 65,536. Live use checks the UTF-8 byte length of the
entire JSON-serialized inline input, including JSON syntax, against that limit.
This is an input limit, not a promise that envelope overhead fits every relay's
configured admission cap. CP1 does not add attachment transfer or source access.
`expiresAt` must be after manifest `createdAt` and at most seven days after it.
Live proposal, acceptance and execution handoff additionally reject expired
grants, including expiry during owner review. Historical contract verification
checks the declared interval without consulting the current clock. Expiry does
not extend the task deadline or prove deletion. Existing execution timeouts still
control a running adapter.

`outputSchema` in a grant is an optional declaration. CP1 does not add angle or
grant-output verification; existing `io.outputSchema` behavior continues.

## Audit lifecycle

Context events are `CONTEXT_GRANT`, `CONTEXT_MODE`, `CONTEXT_OPENED`,
`CONTEXT_DISCARDED`, and `CONTEXT_DELETION_ATTEMPTED`. Each payload contains only
`{ grantDigest, deliveryMode }`, with the digest computed over the exact grant
using the existing canonical JSON digest. Extra lifecycle payload fields are
rejected by the audit-entry schema.

The worker records grant and mode after proposal admission, opened after contract
approval, and discarded on a subsequent terminal failure where its audit channel
is still available. Pending intake is not recorded as discarded. On normal
execution completion it attempts the existing temporary workspace cleanup before
delivery and records deletion attempted before the bilateral checkpoint. The
event describes an attempt, including cleanup failures; the existing cleanup
error callback still reports residual files. Existing cancellation and failure
cleanup paths remain; they do not claim a deletion event after a sealed or
unavailable audit channel. Pre-admission refusals have no new bilateral entries.

For grant-bearing sessions, proposal audit payloads contain proposal/manifest
and frame digests plus the grant digest and mode, rather than the manifest and
input. Acceptance audit payloads contain digests, worker identity, and the
worker's signed acceptance proof, rather than the full contract. The encrypted
wire frames still carry the complete signed contract. Replay/recovery verifies
the compact evidence against the supplied manifest. Sessions without a grant
keep their existing audit payloads. Delivery and progress evidence retain their
existing shapes and may contain application data; CP1 is not a general content
scrubber for adapter output.

Embedders can use `appendContextGrantAuditEvent(append, eventType, grant)` from
`sealbridge/sdk` for an actual local lifecycle action. The append port owns
signing, countersigning and persistence; for example, it can call an existing
`BilateralLedger.append`. The helper never appends a grant body. Do not report
opened or deletion attempted unless the corresponding action occurred.

The filesystem and retention fields are contract declarations. A temporary
workspace cleanup attempt does not prove erasure of copies, provider records,
held input, owner-managed files, or application logs. CP1 adds neither a deletion
proof nor a deliverable storage UI.

Schemas: [ContextGrant](../spec/context-grant.schema.json),
[audit payload](../spec/context-grant-audit-payload.schema.json),
[manifest 0.2.0](../spec/task-manifest.0.2.0.schema.json).
Examples: [view only](../spec/examples/context-pooling/view_only/sample-task-manifest.0.2.0.json),
[hand over](../spec/examples/context-pooling/hand_over/sample-task-manifest.0.2.0.json).
