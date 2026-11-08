# Implemented security model (M2/M3)

Each owner's gateway, policy, local private key and provider adapter are trusted
by that owner. Worker code and all received payloads are untrusted. Gateways
verify signatures against contract parties and require explicit owner receipts at
all five gates. The demo simulates owner approvals with ephemeral keys; it does
not claim an interactive human clicked an approval screen.

The Docker image contains no generated owner identity and runs as the non-root
`node` user (UID 1000). First startup generates a mode `0600` key at
`/data/owner.private.json`; subsequent starts reuse it. Keep `/data` on a mounted
persistent volume and reuse that volume when replacing containers.
`SEALBRIDGE_KEY_PATH` can select an existing readable key or an absolute path in
another persistent mounted directory. Startup fails with actionable guidance
when the key cannot be read or created. Operators who built an earlier image
revision with a build-time identity should rotate to a new runtime identity and
update the corresponding DIDs, allowlists, and invitations.

`subprocess_restricted` (`runSandbox` in `packages/sandbox/src/index.ts`) is a
separate OS process. The parent passes a sanitized environment (no inherited
credentials, `NODE_OPTIONS`, or `PATH`), a temporary scratch directory removed
after the task, a wall-clock timeout followed by SIGTERM then SIGKILL, and an
output byte cap. Input, output, and tool requests cross as JSON. CapGuard and
real MCP handlers stay in the gateway process. `detectNodePermissionFlag` selects
`--permission` on Node.js >= 22.13 and on Node.js 23+, or `--experimental-permission`
on earlier Node.js 20 and 22 releases. `resolveNodePermissionArgs` pairs that flag
with `--allow-fs-read` and `--allow-fs-write` for the scratch directory and does
not grant child-process, worker, or native-addon permission. If neither flag is
advertised, those `--allow-fs-*` arguments are omitted and
`ExecutionAttestation.sandboxBoundary.permissionModelActive` is false.

That permission model restricts filesystem, child processes, worker threads, and
native addons. It does not block `fetch`, `node:net`, `node:http`, `node:https`,
`node:dns`, or `node:dgram`, and it is not a kernel network namespace. Task source
is evaluated with `node:vm` in that same process. Node.js documents that `node:vm`
is not a security mechanism against untrusted code. A null-prototype context that
omits `process`, `require`, `fetch`, and `WebSocket` reduces the guest API
surface. It is not a kernel boundary. Deleting `globalThis.fetch` and `WebSocket`
in the wrapper has the same limit.

Untrusted third-party code requires `oci_container`
(`isolationLevel: 'oci_container'`). `runContainerOrSubprocessSandbox` then runs
Podman or Docker with `--network none`, `--read-only`, `--cap-drop ALL`,
`--security-opt no-new-privileges`, and PID and memory limits.
`ExecutionAttestation.effectiveIsolationLevel` is the path that actually ran.
`VerificationEngine` rejects an `oci_container` contract whose attestation is not
`oci_container` unless `sandboxPolicy.allowSubprocessFallback` is true
(`ISOLATION_LEVEL_MISMATCH`). An unavailable container runtime falls back to
`subprocess_restricted` and reports that level. A container that fails to start
is not retried in the weaker sandbox. The gateway accepts the manifest's
`subprocess_restricted`, `networkAccess: none`, ephemeral-workspace policy;
unsupported isolation, network, or filesystem requests fail closed at the gateway.
Verification's deterministic checks use the same subprocess driver with tool
access denied. They are not an `oci_container` run.

BYOK credentials stay in a trusted owner-side provider adapter. Instrument it
with `meteredProvider`: usage deltas are charged before output is released, and
abort signals must be passed to provider requests. Tools reserve quota before
execution. Usage receipts attest to the gateway's measurements; they cannot prove
an independently malicious owner's honesty or recover tokens already charged by
a provider. The offline deterministic demo uses synthetic usage deltas and makes
no paid provider calls. A worker can report additional usage, but never subtract
it. A stopped run remains stopped. Signed budget amendments must be authorized
before exceeding the current budget; requester delivery verification still
requires the bilateral contract budget, so broader delivery limits require a new
bilaterally signed contract.

Capability argument schemas must be synchronous and self-contained (no `$ref`,
`$dynamicRef`, `$id`, anchors or `$async`). Child schemas must be identical or
contain the entire parent schema as a direct `allOf` conjunct. Equivalent schema
rewrites may be rejected intentionally. Scope syntax supports exact resource URIs
and terminal `/*` prefixes only. Trusted tool definitions extract the resource
from arguments; callers cannot supply an independent scope claim. A single
owner-side CapabilityGuard must be shared across tasks/proxies that consume the
same capability proofs to preserve aggregate parent counters. Counts are in-memory
in the CapabilityGuard; persist counters before using tokens across gateway restarts.

The relay validates outer signatures, routes immutable copies and rejects repeated
envelope IDs. Gateway inboxes also pin expected sender, task and sequence so relay
replay protection is not a trust assumption. Session payloads are encrypted to the
recipient `did:key` with ephemeral X25519, HKDF-SHA256 and AES-256-GCM. HKDF info
binds the canonical envelope header and both X25519 public keys; AES-GCM additional
data binds the header. The relay can observe routing metadata, but not application
payload contents or provider credentials.

`decryptEnvelopePayload`, `WorkerNode`, `RequesterClient` and `VerificationEngine`
require encrypted envelopes by default and reject cleartext session envelopes with
`UNENCRYPTED_ENVELOPE_REJECTED`. Explicit `requireEncrypted: false` and
`allowUnencryptedEnvelopes: true` compatibility options are for legacy in-memory
fixtures. The local HTTP/WebSocket relay defaults to binding `127.0.0.1`; hosted
relays are remote services. Signed, action- and origin-bound relay authentication
tokens and durable replay storage are implemented. Public deployments still need
TLS and operational access controls appropriate to their deployment. See the
[M2/M3 implemented profile](../ARCHITECTURE.md#m2m3-implemented-profile-wp-7wp-12).

The hosted relay shards Durable Objects by recipient DID (`inbox:<did>`) and
stores agent cards on a separate `registry` object. Each accepted envelope is
one storage key plus a fixed-size meta record. Queued envelopes expire after
24 hours by default for new admissions; stored expiry times are unchanged. Replay
IDs expire after 1 hour, and agent cards expire after at most 1 hour (or their
signed expiry, if earlier). Defaults are
256 KiB per envelope, 256 envelopes and 4 MiB per inbox, with a per-IP rate
limit. Leased envelopes count toward recipient caps. These are implementation
defaults; hosted configuration changes require an operator deployment. Retention
does not extend task deadlines or approve held work. See
[relay retention and admission](relay-reliability.md#retention-and-admission).

Audit entries include a signature from each distinct party. A separate, final,
bilaterally signed checkpoint fixes the entry count and head. JSONL must end with
that checkpoint: deleting any entry or removing the checkpoint is invalid. Pin the
latest checkpoint head and expected party DIDs outside the supplied audit file
when checking for replacement or rollback to an older, legitimately signed bundle.
No offline hash chain can distinguish a complete old valid history from a current
one without such an external trust anchor. `verifyAudit` records that distinction:
`statusLabel` is `VALID (no trust anchor: truncation not checked)` when no external
anchor was supplied, while `status` stays `VALID`. `sealbridge audit-verify` accepts
`--expect-final-state`, `--expect-last-hash`, and `--expect-entry-count` in addition
to the positional trust-anchor file. `acp_verify_audit_bundle` accepts the same three
fields. A matching anchor sets `trustAnchorVerified` and `truncationChecked`. The
verifier checks evidence integrity; it does not replay execution or certify the
truth of arbitrary event descriptions.
