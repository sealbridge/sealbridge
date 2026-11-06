# Embedding SDK

[日本語](sdk.ja.md)

`sealbridge/sdk` is the supported ESM entry point for embedding existing Sealbridge
APIs. It is available from sealbridge 0.3.0. Use Node.js 22 or
later and TypeScript `NodeNext` (or another resolver that supports package export
maps). The package includes JavaScript and declarations; workspace packages are
not required in the consuming application.

```ts
import { InviteStore, resolveStoredIdentity } from 'sealbridge/sdk';
import type { InviteStoreOptions, SavedInvite } from 'sealbridge/sdk';
```

## Contract and compatibility

The explicit exports below and their declared public signatures are the supported
SDK contract. Additions can appear in compatible releases. During 0.x, breaking
SDK changes require a minor release and release notes; patch releases preserve
compatibility. Imports under `sealbridge/dist/...` remain resolvable for existing
consumers, but the internal layout is outside this contract. Migrate those imports
to `sealbridge/sdk`. There is no CommonJS entry point.

Importing the SDK does not create identities, read invitations, start a listener,
or contact a relay. Operations retain their existing behavior, storage formats,
approval requirements and defaults. No relay deployment is required.

## Exported surface

All values are direct re-exports of existing implementations, without wrappers.

| Area | Values |
| --- | --- |
| Saved invitations | `InviteStore` |
| Invitation strings | `KeychainSecretStore`, `openKeychainSecretStore` |
| Identity selection | `FileKeyStore`, `KeychainKeyStore`, `inspectStoredIdentity`, `resolveStoredIdentity`, `selectKeyStore`, `keyStoreSelection`, `keychainService`, `resolveDataRoot` |
| Application config | `readApplicationConfig`, `setApplicationKeyStore` |
| Connection metadata | `WorkerTrustStore` (including `listConnections`), `workerIntakePath` |
| Connection exchange | `ConnectionService`, `ConnectionRouter`, `StoredConnectionExchange`, `syncConnections` |
| Owner confirmation command | `connectionsCommand`, `connectionHumanReview` |
| Held review | `ConnectionAdmissionReview`, `HeldRequestReview`, `unavailableHeldContentReviewProvider`, `createRuleBasedContentReviewProvider` |
| Discovery and invitations | `createSignedAgentCard`, `verifySignedAgentCard`, `createInviteToken`, `inviteTokenFromUri`, `isInviteTarget`, `parseAndVerifyInviteToken`, `discoverAgentCards`, `findDiscoveredAgentCard` |
| Key creation | `generateKeyPair` |
| MCP hosting | `AcpMcpServer`, `mcpServerCommand`, `parseMcpServerArgs`, `mcpServerOptionsFromArgs` |
| Content rules | `inspectRuleContent`, `CONTENT_INSPECTION_RULES`, `CONTENT_INSPECTION_RULESET_VERSION`, `CONTENT_INSPECTION_RULESET_DIGEST`, `CONTENT_INSPECTION_LIMITS` |

Named type exports:

- Invitations: `SavedInvite`, `InviteStoreOptions`, `SecretStore`.
- Identity/config: `DataRootOptions`, `LocalIdentityOptions`, `IdentityRole`,
  `IdentityStoreOptions`, `StoredIdentity`, `KeyStore`, `KeyStoreDescription`,
  `KeyStoreSelection`, `KeyringEntry`, `KeyringModule`, `ApplicationConfig`,
  `ApplicationConfigOptions`, `RelaySelectionOptions`.
- Connections: `ConnectionState`, `ConnectionTrust`, `ConnectionRecord`,
  `ConnectionSummary`, `PriorApprovedPeer`, `ConnectionServiceOptions`,
  `ConnectionServiceResult`, `ConnectionHumanReviewProvider`,
  `ConnectionInspectionPort`, `ConnectionPersistencePort`, `ConnectionOffer`,
  `ConnectionConsent`, `ConnectionOutboxEntry`, `ConnectionAcceptanceCommit`,
  `ConnectionRedemptionCommit`, `ConnectionTransport`, `ConnectionFrame`,
  `ConnectionRouterOptions`, `ConnectedEvent`, `ConnectionsCommandOptions`.
- Review: `HeldRequestReviewOptions`, `HeldContentReviewProvider`,
  `HeldInspectionContext`, `InspectionCompletion`, `ConnectionAdmissionReviewOptions`,
  `InboundConnectionSummary`.
- MCP: `AcpMcpServerOptions`, `ApprovalProvider`, `ParsedMcpServerArgs`.
- Core/transport: `KeyPair`, `Json`, `Signed`, `SignedEnvelope`, `Invite`,
  `AgentSkill`, `DiscoveryAgentCard`, `CreateAgentCardOptions`, `SignedAgentCard`,
  `RelayEndpointPolicy`, `ConnectionRequest`, `ConnectionAccepted`, `ConnectionAck`,
  `ConnectionControl`, `RelayTransport`.

## Identity and invitation storage

Pass the same identity/data-root options to all operations that share an owner.
Requester and worker identities remain separate. `resolveDataRoot` only resolves a
path; `inspectStoredIdentity` inspects without creating an identity, while
`resolveStoredIdentity` can create one. `WorkerTrustStore` takes a `path` rather
than identity options; use `workerIntakePath(owner.did, identityOptions)`.

For OS credential storage, explicitly select `keyStore: 'keychain'` and use
`InviteStore.open`. The optional native backend must be available to the runtime;
see [key storage](../README.md). A host may inject
`keyStore`, `keyringLoader` or `secretStore` through the documented option types.
The default remains file storage, and existing inline entries do not migrate
automatically. `SavedInvite` contains metadata only; `resolve` returns invitation
material for local use and must not be logged or passed as MCP arguments. Use
`workerRef` or the exact alias for MCP delegation.

The following function runs inside the host's invitation input boundary. Its data
root is an absolute host-managed path, and its input stays in memory:

```ts
import { InviteStore, resolveStoredIdentity } from 'sealbridge/sdk';

async function saveInvitation(link: string, dataRoot: string) {
  const identityOptions = {
    env: { ...process.env, SEALBRIDGE_DATA_DIR: dataRoot },
    keyStore: 'keychain' as const,
  };
  const owner = await resolveStoredIdentity('requester', identityOptions);
  const invites = await InviteStore.open(owner, identityOptions);
  return invites.import(link); // SavedInvite: return only metadata to the UI.
}
```

## Owner review and connections

`connectionsCommand(['confirm-invite', workerRef], options)` exposes the existing
command flow. `ConnectionsCommandOptions.identityOptions` selects the local
identity; `review(summary)` must present the exact decision to the human owner and
return that decision for this operation. `output` receives JSON metadata/events.
`now`, `transportFactory` and `inspectionProvider` support host injection. Omitted
review uses the existing TTY rules; it does not imply consent.

For a custom host flow, `ConnectionService` accepts persistence, transport,
inspection and `ConnectionHumanReviewProvider` ports. `ConnectionRouter` and
`StoredConnectionExchange` connect the existing stores and held review to that
service. Import/preview grants no consent. Confirming an invitation records local
consent and sends a request; it does not establish remote completion. Read
`WorkerTrustStore.listConnections()` after receiving the signed exchange, or use
explicit `syncConnections`. Connected remains limited; each task requires
inspection and owner opening. The library default inspection provider is unavailable; interactive CLI workers supply display inspection.
The standalone CLI provides literal task display through `tasks list/show` and
interactive workers. A display inspection receipt grants no execution approval;
every fresh limited task requires live owner approval. Terminal held decisions
(`tasks approve/reject`) close only that attempt locally. Custom embedding hosts
still supply their own inspection provider. Connection review covers signed
connection offers separately; unaccepted offers remain selectable for connected
peers. CLI owner confirmation requires an interactive TTY.
See [connection exchange](connections/connection-exchange.md) and
[held-content review](connections/held-content.md).

`ConnectionAdmissionReview` exposes `list()`, `approve(id)` and `reject(id)` for held
inbound connections. Bind decisions to explicit owner actions. Its
`InboundConnectionSummary` includes optional `peerDisplayName` when known; display
names are informational data. Built-in inspection covers connection metadata only.
See [owner admission review](connections/admission.md#owner-admission-review).

## MCP lifecycle

In a dedicated stdio MCP process, `mcpServerCommand(args, identityOptions)` runs the
existing CLI lifecycle. For host-owned streams, construct `AcpMcpServer`, call
`startDelivery()`, await `serve(readable, writable)`, and call `stopDelivery()` in
`finally`. Configure `requireInteractiveApproval: true` for host form approval or
inject an `approvalProvider`; the unflagged policy-auto default is unchanged.
Approval before sending and final verification remain separate. Connection review
is a separate `connectionReview` option. See [MCP integration](../README.md#mcp-live-progress-revocation-and-quorum).

## Audit evidence

`parseJsonl` / `verifyAudit` retain their bilateral-only contracts. Use `parseAuditJsonl` / `verifyAuditEvidence` for the `AuditEvidence` union (`AuditBundle | InterruptedAuditBundle`). Worker-only format-1 terminals return `UNILATERALLY_CLOSED` with `valid:false`, even with matching external pins; ordinary result APIs still require bilateral bundles. `createAuditInterruption`, the interruption-aware stores, and public evidence types are exported from `sealbridge/sdk`. See [storage, pins, durability, and requester comparison rules](audit-interruption.md).

## Opt-in offline content rules

`inspectRuleContent({manifest,input,capabilityChains?}, limits?, signal?)` is the
in-memory core scanner. `RuleInspectionInput`, `RuleInspectionOptions`,
`RuleInspectionRule`, `RuleInspectionKind`, `RuleInspectionFinding`,
`RuleInspectionDiagnosticCode`, `RuleInspectionReport`, and
`RuleBasedContentReviewOptions` are supported SDK type exports. Core owns the
rules and traversal; runtime owns the child process. The edge entry is unchanged.

For held tasks, inject the provider explicitly:

```ts
import { HeldRequestReview, WorkerNode, createRuleBasedContentReviewProvider } from 'sealbridge/sdk';

const inspectionTimeoutMs = 5000;
const heldReview = new HeldRequestReview(owner, {
  ...identityOptions,
  inspectionTimeoutMs,
  provider: createRuleBasedContentReviewProvider({
    timeoutMs: inspectionTimeoutMs,
    onReport(recordId, report) {
      // Supply literal owner-facing review material in memory.
      renderInspection(recordId, report);
    },
  }),
});
const worker = new WorkerNode({ ...workerOptions, owner, heldReview });
```

Here `owner`, `identityOptions`, `workerOptions`, and `renderInspection` belong to
the embedding host. Keep provider timeout at or below the review timeout; both
default to 5 seconds and accept 1–45,000 ms. Cancellation or either deadline ends
inspection and terminates the child. Callback failure, rejection, interruption or
exceeding that deadline cannot produce completion. The callback receives a copy;
its mutation cannot change the receipt. It is a host callback, not an isolation
boundary for arbitrary code.

The provider verifies the outer envelope, encrypted recipient, signed proposal,
manifest, task/sender/worker and held digests before projecting manifest, input and
capabilities into the fixed compiled scanner over IPC. Owner keys and transport
credentials are excluded. It uses an environment allowlist, a 64 KiB result cap,
and termination on abort, timeout or failure. It writes no plaintext files or
logs and makes no network requests, DNS lookups, execution or archive extraction.
This fixed trusted scanner does not provide kernel network isolation or accept
plugins, downloaded rules, caller regexes or source code.

The immutable descriptors, detector version and default limits determine
`CONTENT_INSPECTION_RULESET_DIGEST`. Defaults are 256 KiB serialized content,
depth 32, 100,000 nodes/keys, 64 KiB of UTF-8 per string, 100 findings and 64 KiB total
decoded base64 bytes. `limits` may lower these local bounds. Exceeding a work or
result bound is `error`; findings are never silently truncated into success.
All manifest fields, input, capabilities and string keys are scanned in JSON
Pointer order. Location offsets count original UTF-16 units; pointer segments use
`~0`/`~1` escaping, with potentially sensitive keys replaced by `[redacted]`.
Reports contain fixed note/diagnostic codes and no evidence snippets or URL values.
Ordinary keys can occur as location segments; treat reports as review material.

The rules check invisible/control characters, English/Japanese instruction phrases,
URL forms, combined secret requests, recognizable credential forms, code markers
and long base64. Decoding is bounded and performed once; executable/archive
prefixes produce `block`. These are heuristics: matching text may be ordinary
quoted material, unrecognized forms may pass, and credentials are not verified
online. A `pass` is the absence of findings from these rules. A completed
`pass`, `warn` or `block` maps to the existing receipt's `complete`, with `block`
as the strongest owner warning. None authorizes execution, opens a task or
bypasses the existing live human contract decision. Failures outrank partial
findings, remain `error`, and preserve the completed-inspection display gate.

`contentDigest` is `digest({manifest,input})`; supplied capabilities and effective
limits are bound through the report and exact envelope. A standalone core error
before a bounded JSON snapshot exists uses `digest(null)` as an incomplete digest;
never use an error report as content verification. The runtime binds error reports
to the authenticated held digest. The receipt's existing `reportDigest` hashes
`{recordId,ownerDid,kind,contentDigest,envelopeDigest,report}`. Only this digest is
persisted; full reports remain in `onReport` memory. Existing cached receipts
contain no findings: `HeldRequestReview.inspect` can return a cached completion
without calling the provider. After restart, explicitly call the provider with the
stored envelope and bound inspection context when a report is needed. Do not
infer an empty report from a receipt or create a report cache on disk.

Other held kinds return `unavailable`. Default review, CLI display, trusted
admission, MCP and automatic approval behavior are unchanged. No protocol,
schema, required manifest field, wire or stored-record format changes are made.
