# Two-owner M1 demonstration

From the repository root:

```sh
pnpm install
pnpm build
pnpm test
pnpm --filter @acp/two-owner-demo start
pnpm sealbridge demo --audit-dir /tmp/acp-demo-audit
pnpm sealbridge audit-verify /tmp/acp-demo-audit/alice.jsonl
pnpm sealbridge audit-verify /tmp/acp-demo-audit/bob.jsonl
```

Those two commands do not pass a trust anchor, so a valid file prints
`VALID (no trust anchor: truncation not checked)` in `statusLabel`. `status`
stays `VALID`. Pin the tail with `--expect-final-state`, `--expect-last-hash`,
`--expect-entry-count`, or a positional trust-anchor JSON file.

Use a fresh audit directory for each run. Sealed logs cannot be appended to.

Alice and Bob generate independent ephemeral Ed25519 did:key identities. Alice
signs the task proposal and issues a root capability and an attenuated read-only
child for Bob. The demo explicitly simulates Bob's owner signing the acceptance
receipt according to `bob-policy.json`; it never implies an unattended agent can
approve on behalf of a real human. Signed proposal, acceptance, progress,
delivery and settlement messages pass through the in-memory Blind Relay and
sequence-checking gateway inboxes.

Bob executes JavaScript in a restricted subprocess. Its tool requests cross IPC
to CapGuard; allowed requests are metered and forwarded to a real MCP SDK
client/server pair. The source document and token usage are deterministic local
fixtures. No external LLM, API key, paid tool, network account or remote service
is required. Alice verifies artifact signatures and content hashes, the usage
receipt and original budget, the output JSON Schema, an isolated deterministic
check, and her explicitly simulated final approval. Both gateways reach SETTLED,
capabilities are revoked, and both copies of the bilateral audit log verify VALID.

The same command also asserts every negative scenario:

1. Unknown tools, out-of-scope URI/schema arguments, exhausted invocation counts,
   wider tools/scope/schema/call limits/expiry, different task binding and excessive
   delegation depth produce CAPABILITY_VIOLATION audit events before backend use.
2. Token usage exceeding budget aborts the subprocess; its signed over-budget
   receipt is rejected by the requester without settlement.
3. Altered artifacts, invalid output schema, modified relay envelopes, audit-byte
   changes, reordering and interior/trailing deletion are rejected deterministically.

`conformance/e2e.test.ts` runs these same four scenario functions. Unit and
transport tests add policy, quota, signing, JSONL and HTTP/WebSocket coverage.
See `docs/security-model.md` for the M1 isolation and trust boundaries.
