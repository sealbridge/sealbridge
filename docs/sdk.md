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
| Held review | `ConnectionAdmissionReview`, `HeldRequestReview`, `unavailableHeldContentReviewProvider` |
| Discovery and invitations | `createSignedAgentCard`, `verifySignedAgentCard`, `createInviteToken`, `inviteTokenFromUri`, `isInviteTarget`, `parseAndVerifyInviteToken`, `discoverAgentCards`, `findDiscoveredAgentCard` |
| Key creation | `generateKeyPair` |
| MCP hosting | `AcpMcpServer`, `mcpServerCommand`, `parseMcpServerArgs`, `mcpServerOptionsFromArgs` |

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
inspection and owner opening. The default inspection provider is unavailable.
Task inspection is embedder-only: configure a task inspection provider in the
embedding app for worker receipt and held-task review. The standalone CLI cannot
inspect tasks or configure that provider. Connection review only covers signed
connection offers, not pending task-derived items or task content. CLI human
confirmation needs an interactive TTY; `--auto-accept` does not supply inspection.
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
