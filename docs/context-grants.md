# Context grants (CP1 and CP5a)

`TaskManifest.contextGrant` is an optional 0.2.0 contract property for a
sender's selected context. Existing manifests without it remain valid in both
supported versions. No protocol version, peer floor, or release clock changes.
A peer with the older closed 0.2.0 schema will reject this optional extension;
use it only with CP1-capable peers. There is no automatic downgrade that strips
the grant.

| Delivery mode | Delegation depth | Retention declaration | Input retention |
| --- | --- | --- | --- |
| `view_only` (builder default) | 0 | `ephemeral_view` | false |
| `hand_over` | 0 | `keep_deliverable` | false |
| `approval_redelegation` (explicit opt-in) | 1 | either; default `ephemeral_view` | false |

`hand_over` permits keeping the agreed, accepted deliverable. It does not permit
keeping the input selection. CP5a enables `approval_redelegation` only with the
owner decision and host prerequisites described below. Desktop controls are outside this slice.

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
keep their existing audit payloads. Depth-zero delivery and progress evidence retain their
existing shapes and may contain application data; CP1 is not a general content
scrubber for adapter output.

AuditInterruption local format 1 remains limited to one acknowledged PROPOSE
containing the full signed manifest. Compact grant proposals and their lifecycle
entries are outside that scope, including with the default interruption format 1.
Grant sessions keep their existing lifecycle and recovery
behavior; sessions without grants retain format-1 interruption closure. The
interruption verifier's manifest and prefix checks are unchanged.

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


## CP5a: one approved child edge

For A → B → C, A explicitly selects `approval_redelegation` on A → B at depth 1.
The builder adds the existing `GATE_SUB_DELEGATION`. B can dispatch separate
B → C tasks with strictly narrower `view_only` grants at depth 0. Only one
edge is supported; siblings are independent one-edge chains.

The root requires protocol 0.2.0, `ephemeral_workspace_only`, and absent/false
input retention. Both root retention declarations remain available. No required
manifest field or protocol version changes. Use this mode only with a known
CP5a worker: version 0.2.0 alone does not advertise support. C receives an ordinary
CP1 task; its host handles inspection and owner opening.

### Host configuration and owner decisions

```ts
import { WorkerNode, RequesterClient } from 'sealbridge/sdk';

const childRequester = new RequesterClient({
  owner: bOwner, relay, approvalProvider: bOwnerDecisionProvider,
});
const worker = new WorkerNode({
  owner: bOwner, relay, adapter, auditPath,
  approvalProvider: bOwnerDecisionProvider,
  redelegation: { requester: childRequester, ownerApprovalProvider: bOwnerDecisionProvider },
});
// Inside an admitted root adapter:
const partial = await context.redelegate!({
  to: cInvitation, manifest: fullyBuiltChildManifest, input: alreadySelectedJson,
});
```

The worker needs `auditPath` for its durable journal and a requester using B's
same owner identity. Configure ordinary connection and inspection policy
separately. The child method exists only during an admitted approval-mode root.
`ChildDelegationRequest` accepts `to`, optional `relay`, complete `manifest`,
selected JSON `input`, and optional `auditPath`. Resolve saved references before
calling. Capability chains, automatic approval/retry flags and supplied proofs
are not accepted. The helper adds no root identifiers or parent input to C's
frames; owner-supplied child content can still disclose them.

A approves the exact root manifest/input/worker target before send. B separately
opens the root, approves each child manifest/input/owner target, and reviews its
result. A reviews the final root delivery. These live boundaries require a
provider declaring `ownerDecision: true` and fresh target-bound owner receipts.
Interactive CLI and MCP form providers declare it; webhooks declare it in
owner-decision response mode. Policy providers cannot operate this mode. The
marker is a host assertion, not independent evidence of a physical human action.

### Link checks and delivery

`createDelegationLink` signs after authenticated child acceptance and copies the
actual child limits. `verifyDelegationChain` checks signed contracts, task IDs,
owner continuity, digests, timestamps and remaining depth without consulting
today's clock. `assertDelegationAttenuation` compares declarations literally:
child selectors must be a nonempty subset, parent allowed fields cannot widen,
denied fields persist, and selectors or allowed fields must strictly narrow.
Reducing only bytes, budget or depth is insufficient. Parent grant `outputSchema`
is preserved. Numeric budgets, deadline, expiry and bytes cannot increase;
other budget fields, sandbox policy and verification policy must be equal.
Child capabilities are empty. These are per-task ceilings; sibling budgets are
not added together. The checks do not establish semantic provenance, interpret
selectors, verify an angle, prove erasure or establish child-output acceptance.

The host persists approved attempts before dispatch and accepted proofs before
parent delivery, retaining proofs even when later child execution fails. It
waits for managed children and attaches every issued proof; unresolved attempts,
duplicate IDs, invalid proofs and empty attachments prevent delivery. Restart
uses existing terminal recovery and does not replay child sends. An otherwise
valid subset cannot reveal an out-of-band sibling to A.

`Delivery.delegation` contains `{ parentContract, children }`, with each child
`{ link, childContract }`. The optional attachment is required for depth-one
contracts carrying a ContextGrant. Contracts without a ContextGrant keep their
origin/main delivery, verification, recovery and retained-result behavior at
all existing depths, including depth one without proof. CP1 depth-zero grants
keep their ordinary path; attaching CP5a evidence to them is refused. There is
no signed empty-child alternative: B cancels/rejects if it cannot produce a
linked child; A may explicitly submit a fresh depth-zero task.

Full signed parent and child contracts disclose selectors, angles, task text,
limits and owner DIDs to A. B reviews that disclosure before dispatch. Proof and
new journal fields add no raw input or child artifact body. Existing application
records and relay byte limits still apply; proofs are never stripped to fit.

`verifyDelegationAttachment(attachment, trustedContract)` checks every sibling
against the exact root. Live verification runs before output checks, callbacks
and owner review, adding `delegation_chain` only for the grant-bearing depth-one
path. Direct live verification also requires `ownerDecision: true`. Final review
includes verified child owner DIDs and proof digests. Recovery binds the embedded
root to retained proposal/acceptance evidence; historical expiry is not a new
refusal. Existing hashes and checkpoints retain the delivery attachment, and
version-1 task journals retain optional child-attempt state. `verifyAudit`
continues to check ledger hashes/signatures only.

Diagnostics are `DELEGATION_PROOF_REQUIRED`, `DELEGATION_INVALID`, and
`DELEGATION_APPROVAL_REQUIRED`. Schemas: [link](../spec/delegation-link.schema.json)
and [attachment](../spec/delegation-attachment.schema.json). See the
[complete attachment example](../spec/examples/context-pooling/approval_redelegation/sample-delegation-attachment.json).
