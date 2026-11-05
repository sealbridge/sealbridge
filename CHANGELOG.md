# Changelog

Notable changes to Sealbridge are documented here, following Keep a Changelog conventions.

## [Unreleased]

### Added

- Optional ContextGrant declarations on 0.2.0 task manifests for depth-zero view-only and hand-over delivery, with consistency checks, opt-in SDK builders, and digest-only context lifecycle audit events.

### Fixed

- Added opt-in worker audit interruption terminals for PROPOSE-only approval waits, with separate offline verification and restart recovery; bilateral audit results remain distinct. Related to #194.
- Audit parsing and verification diagnostics identify task IDs, entry sequences and hashes, and JSONL physical lines where available, including the last entry when a checkpoint is missing. Related to #194.

## [0.4.2] - 2026-11-05

### Fixed

- CLI `--help` and `-h` print help without creating identities, invitations, or stores; missing required arguments are checked before local writes.
- Fixed delegation to connected peers by DID, saved invitation alias, or workerRef, retaining the observed protocol version when no directory card is available.

## [0.4.1] - 2026-11-05

### Fixed

- Added standalone CLI task display and per-task held review with separate live owner approval on fresh submissions; kept connection consent separate and listed unaccepted signed offers for already connected peers. (#178)

## [0.4.0] - 2026-11-05

### Changed

- **Breaking:** Updated `@a2a-js/sdk` to 1.3.0; the SDK-backed A2A helpers `agentCard`, `a2aTask`, `a2aMessage`, `wrapA2A`, and `unwrapA2A` now use A2A 1.0 card, message, and task output shapes, including signed A2A payloads. (#177)
- Clarified CLI errors, help, and quickstarts with next steps for embedder-only task inspection and signed connection offer review. (#178)

### Fixed

- `keygen`, `validate`, and `demo` now print usage and exit successfully for standalone `--help` or `-h`; `keygen` rejects option-like output paths before generating or writing keys. (#179)
- Aligned delegate usage/help with required flags and accepted `--invite` as an alias of `--to`, rejecting differing values. (#180)
- `sealbridge accept` recognizes `--allow-private-relay` for importing loopback/private relay invitations through positional links, `--paste`, and `--stdin`; imports remain blocked by default. (#181)

## [0.3.1] - 2026-11-04

### Changed

- Dated the 0.3.0 changelog entry. (#169)
- Updated stale documentation version notes to state availability from 0.3.0. (#171)

### Fixed

- In a fresh environment with no configuration and no keys, `doctor` warned with `APP_CONFIG_INVALID` or `IDENTITY_INVALID`; missing keys are now reported as optional. (#170)

## [0.3.0] - 2026-11-03

### Added

- A typed ESM embedding entry point, `sealbridge/sdk`, for invitation, identity and secret stores, connection review, and MCP hosting APIs. Existing deep import paths remain available. (#154)
- Persistent encrypted gateway outboxes, recipient receipts, message metadata, and default worker task checkpoints. Pending sends resume after gateway restart with the same envelope IDs until relay admission or the original deadline; recovery does not repeat owner decisions or reconstruct a task session. (#149)
- Optional persistent `idempotencyKey` support for `acp_delegate_task`, `acp_delegate_multi`, and `acp_resubmit_pending_request`. Matching calls retain their original result and IDs across restarts; changed requests return `IDEMPOTENCY_CONFLICT`. Results are retained for seven days after the original deadline. (#150)
- Recipient-signed, content-free delivery observations for validated manifest `0.2.0` tasks, including held, opened, adapter handoff, and closed states. Initially unknown peers receive only held and closed observations. Both gateways need support; handoff does not establish reading or execution. (#151)
- `acp_message_status` to read retained sender-local observations by message ID or task ID, independently of a cached send result, without sending or polling. (#152)
- `InviteStore.import(..., { pendingConfirmation: true })`, `listUnconfirmed()`, `retain()`, and `removeUnconfirmed({ olderThan })` for explicit cleanup of unconfirmed imports. Existing saves remain outside this cleanup; pending references require retention before use. (#155)
- `WorkerTrustStore.connectionStatus()` and `connections status` for local connection observations, including pending states and acknowledgement progress. (#156)
- `ConnectionAdmissionReview` and `connections review list|approve|reject` for owner review of inbound connection metadata. Explicit approval grants limited connection consent; task inspection and opening remain separate. (#157)
- Optional `peerDisplayName` in connection and prior approval metadata, derived from verified invitations and agent cards and retained after invite removal. DIDs remain authoritative; older records may omit the name. (#158)
- Local `setup` for identity, relay defaults, and MCP host registration, with preview modes and agent-readable connection instructions; `doctor --offline` for local inspection. (#119, #128)
- Saved invitation aliases with `accept`, `invites`, `acp_list_invites`, and `acp_remove_invite`, including piped invitation import through `accept --stdin`. (#122, #132)
- Pluggable identity key stores, persistent `config key-store file|keychain` selection, and optional keychain invitation storage with explicit migration. Store selection does not automatically move existing identities or invitations. (#131, #136, #137)
- Worker invitation output routing through `--invite-output`, with metadata events and file or POSIX descriptor output options. (#135)
- Persistent connection state, signed connection exchange and invite redemption, encrypted held-content review APIs, and retained requester requests with explicit resubmission. (#126, #130, #139, #140, #141, #142)
- Manifest `0.1.0`/`0.2.0` compatibility schemas, peer version observations, and live version negotiation. (#138, #142)
- Linked README demo previews and an audio-free landing page demo. (#145, #146)

### Changed

- New relay admissions default to 24-hour retention; existing stored expiries are preserved. Capacity refusals return HTTP 429 `RELAY_RETRY_LATER` with a 60-second retry hint, and local relay commands expose queue and envelope limits. Hosted behavior requires an operator relay update. (#144)
- Gateway outbox retries follow 1-minute, 5-minute, 15-minute, and 1-hour delays, then hourly, while the original deadline still applies. Persistence covers process restart after completed writes and atomic publication; power-loss persistence is not guaranteed. (#149, #150, #151)
- MCP `--require-approval` uses advertised host forms before transmission and for final verification. Setup registers this mode by default; hosts without form support return `APPROVAL_CHANNEL_UNAVAILABLE` before sending. (#118, #133)
- Commands reuse persistent role identities and default to `https://relay.sealbridge.dev`. Relay configuration can retain ordered candidates while operating one active route. (#119, #124)
- Live manifest sending prefers `0.2.0` when both peers advertise it; peers without version declarations retain `0.1.0` behavior. The protocol release instant is set to `2026-11-03T12:22:18Z`, intended as the 0.3.0 npm publish time. (#138, #142)
- Unconnected requests return terminal `PENDING_OWNER_APPROVAL` and are not retried automatically. Connections grant limited consent, with inspection and owner opening for each task; the default inspection provider is unavailable. (#126, #130, #142)
- MCP discovery lists current verified published cards with skill and task-type filters. The removed `accessMode` argument returns JSON-RPC -32602; publication alone grants no admission consent. (#120, #142)

### Fixed

- `InviteStore.remove()` deletes and verifies invitation secrets before publishing metadata removal, allowing failures to be retried with the same reference. (#155)
- Delivery-store validation discards cached records after changes, missing files, or read errors. (#159)
- Idempotency orphan cleanup refreshes both indexes under the signer lock and waits for the configured lease age. Indexes also track a shared store generation for consistent updates across writers. (#161, #160)
- Shared task journals load and publish recovery state under the signer lock, handle incomplete writes consistently, and recheck source contents before background compaction. Windows journal handles are released between operations. (#162)
- Connection offers and requests, worker cards, and CLI invitation cards use one clock snapshot for bounded lifetimes. (#153)
- Setup honors the selected key store. (#134)
- Installers fall back to a user-local Node installation with bundled npm when an existing Node lacks a usable co-installed npm. (#116)
- Relay authentication recovery after HTTP 401 uses bounded retries and reports exhaustion. (#117)
- Production site media delivery supports byte-range requests. (#147)

[0.4.2]: https://github.com/sealbridge/sealbridge/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/sealbridge/sealbridge/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/sealbridge/sealbridge/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/sealbridge/sealbridge/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/sealbridge/sealbridge/compare/v0.2.2...v0.3.0
