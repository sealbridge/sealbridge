# Sealbridge conformance suite

Run `pnpm build && pnpm test` with Node 22 and pnpm 10. The suite is offline after
installation; all keys and provider usage are synthetic. `pnpm validate:schemas`
compiles every Draft 2020-12 schema and validates every JSON example.

* `jcs-signing-vectors.json`: exact UTF-8 JCS serialization, SHA-256 digest,
  synthetic Ed25519 seed, did:key and expected signed object. Metadata is signed
  with the payload; see the exact signature preimage in `spec/README.md`.
* `capability-attenuation.json`: parent bounds and child patches, including valid
  reductions and independently invalid resource, tools, schema, call count, time,
  depth and task bindings. Invalid child tokens are signed by the legitimate
  delegatee to ensure the verifier checks authority as well as authenticity.
* `state-transitions.json`: every state/event combination. A null destination
  means deterministic rejection. PROPOSE establishes PROPOSED.

The automated tests additionally cover aggregate parent usage across sibling
capabilities, signed-event replay, all five approval gates, usage receipt budget
checks, isolated verification, subprocess termination, real MCP SDK calls,
HTTP/WebSocket and in-memory relay transports, bilateral JSONL evidence and all
four executable two-owner E2E scenarios. JSONL truncation detection requires the
final signed checkpoint. Pin an external head to reject rollback to another
complete, legitimately signed bundle.

A new implementation can consume these JSON vectors without TypeScript. It must
produce the exact canonical bytes and signatures, accept the valid attenuations,
reject every invalid attenuation, and implement the same transition table.

`p1-8-require-encrypted-envelopes.test.ts` checks that `decryptEnvelopePayload`,
`WorkerNode`, `RequesterClient`, and `VerificationEngine` reject cleartext session
envelopes with `UNENCRYPTED_ENVELOPE_REJECTED` unless the caller explicitly opts out,
and that an encrypted session still settles with a valid audit bundle.

`p2-11-hkdf-key-binding.test.ts` checks that HKDF-SHA256 info for
`encryptEnvelopePayload` and `decryptEnvelopePayload` binds the canonical envelope
header plus the ephemeral and recipient X25519 public keys. AES-GCM additional
data stays the header, and the nonce stays the HKDF salt. A ciphertext whose AES
key was derived with header-only info, or whose ephemeral public key or recipient
key context was altered, is rejected with `ENVELOPE_DECRYPTION_FAILED`. An
encrypted session still settles with a `VALID` audit bundle.

`p2-15-ci-hardening.test.ts` checks that `.github/workflows/conformance.yml`
sets workflow `permissions: contents: read`, runs the conformance job on
`ubuntu-latest`, `macos-latest`, and `windows-latest`, and pins every `uses:`
action to a 40-character commit SHA. It also checks that `.github/dependabot.yml`
schedules weekly updates for the `github-actions` and `npm` ecosystems.

`p2-14-security-proof-scope-notice.test.ts` checks that `SECURITY_PROOF.md` and
`SECURITY_PROOF.ja.md` keep their language-switcher links and, within the first
30 lines, state that each "Proof" section maps a threat class to an enforcement
mechanism and an adversarial regression in `conformance/security-proofs.test.ts`
(plus the P0–P2 conformance tests). The notice must say `pnpm test:security-proof`
is an empirical red-team conformance suite, not a machine-checked formal or
mathematical proof such as TLA+, Coq, Lean, or symbolic protocol verification.

`p2-13-sandbox-boundary-accuracy.test.ts` checks that `detectNodePermissionFlag`
pairs `--permission` (Node.js >= 22.13 and Node.js 23+) or `--experimental-permission`
(earlier Node.js 20 and 22) with `--allow-fs-read` and `--allow-fs-write`.
`subprocess_restricted` denies reads outside the scratch directory when that model
is active, strips host environment variables, enforces a timeout, and reports
`effectiveIsolationLevel: 'subprocess_restricted'`. `VerificationEngine` rejects
that level when the contract requires `oci_container`. The same test reads
`SECURITY_PROOF.md`, `SECURITY_PROOF.ja.md`, `ARCHITECTURE.md`, and
`ARCHITECTURE.ja.md` and requires them to state that `node:vm` is not a security mechanism
and that kernel network isolation is `oci_container` (`--network none`).

`p2-12-audit-verify-trust-anchor-notice.test.ts` checks that `verifyAudit` and
`sealbridge audit-verify` report `VALID (no trust anchor: truncation not checked)` when
no external anchor is supplied. `--expect-final-state`, `--expect-last-hash`,
and `--expect-entry-count` (and the same fields on `verifyAudit` and
`acp_verify_audit_bundle`) set `trustAnchorVerified` and `truncationChecked`
and reject a truncated prefix whose anchor does not match. `status` stays
`VALID` or `INVALID` so existing callers that read that field keep working.

`p2-10-relay-error-sanitization.test.ts` checks that HTTP and WebSocket relay
errors return an allowlisted protocol code. An unexpected storage or runtime
exception becomes `RELAY_INTERNAL_ERROR` (HTTP 500 on the fetch handler) and the
response body does not include the exception text. Documented codes such as
`INVALID_ENVELOPE`, `RELAY_CAPACITY`, `RELAY_AUTH_ORIGIN_MISMATCH`, and
`INVALID_AGENT_CARD` keep their status and exact code.

`p1-3-adapter-tool-restrictions.test.ts` checks that the Claude Code and Codex
CLI adapters default to read-only tool flags, that adapter options and
`extraArgs` can relax a flag without emitting a second copy, and that a mock
executable receives that argv.

`network-collab.test.ts` covers M2/M3: all five adapters, genuine SDK MCP calls,
signed discovery/invites, HTTP/SSE/long-poll/WebSocket routes, approval providers,
OCI fallback, quota/CapGuard rejection and separate-process CLI collaboration.
TCP binding denied with EPERM/EACCES automatically selects a Web fetch bridge.
Force that path with `ACP_TEST_FETCH_BRIDGE=1 pnpm exec vitest run
conformance/network-collab.test.ts`. Real keys/provider billing are unnecessary;
provider responses and credentials in the tests are synthetic fixtures.

Connections cutover coverage uses temporary owner-local roots, injected clocks, InMemoryRelay and fake human/inspection ports. `connections-admission`, `connections-cli`, `connections-mcp`, `connections-board` and `connections-migration` cover live admission and compatibility. Run `pnpm test --exclude conformance/codex-proxy-real.test.ts` for the offline suite; listener tests require localhost binding. No provider credentials or real keychain are used.

接続の切替テストは一時データルート・注入した時計・メモリ内リレーを使います。既定の検査は利用不可のままで、検査完了はテスト専用のプロバイダーで確認します。localhost の待受が必要な既存テストがあります。
