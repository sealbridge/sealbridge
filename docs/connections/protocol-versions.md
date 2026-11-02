# Manifest protocol versions

**English** | [日本語](protocol-versions.ja.md)

`@acp/core` validates manifest protocols 0.1.0 and 0.2.0 with separate schemas.
`validateManifest` selects by `protocolVersion`; `validateSchema('task-manifest', value)`
uses the compatibility dispatcher. Validation, contracts and offline audit verification
have no retirement clock. Unknown explicit manifest versions return
`PROTOCOL_VERSION_UNSUPPORTED`; malformed supported manifests return `SCHEMA_VIOLATION`.

`spec/task-manifest.0.1.0.schema.json` retains the historical v0.1 schema ID and rules.
`spec/task-manifest.0.2.0.schema.json` has its own v0.2 ID and exact 0.2.0 version;
the remaining fields match 0.1.0. `spec/task-manifest.schema.json` references both
with a distinct ID and retains the `task-manifest` registry lookup name.
Examples in `spec/examples/protocol-versions/` exercise signed card `protocolVersions`
and skill `taskTypes`. New cards omit retired operational mode fields; historical signed payloads remain intact for verification.

The pure helpers `supportedSendVersions`, `supportedReceiveVersions`,
`selectProtocolVersion` and `assertInboundProtocolVersion` take an explicit
`ProtocolCompatibilityPolicy` and a millisecond clock. The caller supplies the public
0.2.0 protocol release instant; no release date is assigned here. Days are exactly
86,400,000 ms. From release to day 90, both versions can be sent and received;
from day 90 to day 180 only 0.2.0 can be sent; from day 180 only 0.2.0 can be received.
Cutoffs include the boundary instant. Invalid policy inputs and clocks before release
return `PROTOCOL_POLICY_INVALID`. Missing card `protocolVersions` means 0.1.0 only;
explicit future versions are retained in signed cards but cannot be selected locally.
Card `version`, A2A versions and package versions remain independent.

`@acp/runtime` exports `ProtocolPeerStore`. It takes an existing local key and data-root
options and writes owner-signed observations to
`<data-root>/protocol-peers/<sha256-local-owner-DID>.json`. `observe(ownerDid, agentDid, cards)`
resolves the current verified card from the caller's directory snapshot and records the
highest locally understood version, signed-card digest and observation time. The caller
must supply the current directory snapshot; the store does not fetch it. Older cards do
not lower a recorded floor. `floor` and `snapshot` only read and create no keys or files.
`observePolicy(policy)` persists the maximum phase for that epoch and returns a policy
that retains it after clock rollback; callers must persist it before applying live policy.
Changing an established epoch requires a separate explicit migration. Observations
confer no task permission. Files are bounded to 1 MiB and 1,000 peer pairs, with no
implicit removal of established floors; persistence errors are reported as
`PROTOCOL_STORE_INVALID`, `PROTOCOL_STORE_BUSY` or `PROTOCOL_STORE_UNWRITABLE`.
POSIX directories/files use 0700/0600; Windows inherits parent ACLs without verification.

Live paths use `LiveProtocol` and persist CLI/MCP peer observations. `buildTaskManifest`
defaults to 0.2.0; requester sending negotiates before signing. A raw DID without a
verified card implies legacy capability only. Supplied manifests are refused when
incompatible, never silently rewritten. Explicit pending resubmission negotiates anew.
All 0.1.0 requests are held without connection-derived admission, including requests
from peers with a current connection. Offline audit verification remains timeless.

`PROTOCOL_020_RELEASED_AT` in `packages/runtime/src/protocol-release.ts` is currently
`null`: a pre-release build accepts both versions and selects the newest common
version without starting a retirement clock. It never interprets unset as today.
Maintainers must set the exact UTC release instant when enabling public 0.2.0 semantics.
Packaging, including `npm pack`, permits the unset pre-release state. Before publishing,
run `pnpm run check:protocol-release`; it builds the runtime and calls
`assertProtocolReleaseConfigured`, rejecting unset or invalid instants. npm also runs
this check through `prepublishOnly` for `npm publish` (including `--dry-run`).
Host/tests may inject `protocolPolicy` and `now`; CLI/MCP installations
have no per-install epoch flag. Changing a persisted epoch requires an explicit
migration. Receive capability is recomputed at registration and the card is re-signed
when a phase changes; a stale remote card never overrides live local policy.

See [connections admission](admission.md) for owner workflows and migration.
