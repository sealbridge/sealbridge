# Sealbridge Protocol Specification (`spec/`)

**English** | [日本語 (README.ja.md)](./README.ja.md)

**Conclusion**: This directory is the language-independent source of truth for the protocol specification and the JSON Schema (Draft 2020-12). Every protocol object computes a **SHA-256 digest** and an **Ed25519 signature** over bytes canonicalized with **RFC 8785 (JCS: JSON Canonicalization Scheme)**.

---

## 1. Shared cryptographic and serialization rules

1. **Encoding**: UTF-8 JSON (the I-JSON subset). Amounts, token counts, and durations are integers, so floating-point error does not enter the signed bytes.
2. **Canonicalization**: A JSON object that will be signed or hashed is converted to a deterministic byte string with keys sorted lexicographically and whitespace removed, following [RFC 8785 (JCS)](https://www.rfc-editor.org/info/rfc8785/).
3. **Principal ID**: Owner and agent identifiers use W3C `did:key` (the Ed25519 public key in multibase base58btc, for example `did:key:z6Mk...`).
4. **Digest form**: `"sha256:<64 lowercase hex characters>"` (for example `"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"`).
5. **Signature form**: `"ed25519:<base64url or 128 lowercase hex characters>"`. Before signing, remove the `signature` / `signatures` fields from the object and then apply JCS.

---

## 2. Core schemas

| File                                                       | Status                     | Role                                                                                                                                                                                      |
| :--------------------------------------------------------- | :------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`task-manifest.schema.json`](./task-manifest.schema.json) | **Draft v0.1 (validated)** | The task specification the requester presents: input and output JSON Schema, acceptance criteria, verification method, budget cap, granted Capabilities, and isolation requirements       |
| `capability-token.schema.json`                             | Planned (M0)               | A UCAN/Biscuit-style attenuating scope token (`issuer`, `audience`, `taskId`, `resources`, `allowedTools`, `argConstraints`, `maxInvocations`, `maxDelegationDepth`, `proofs`)            |
| `envelope.schema.json`                                     | Planned (M0)               | The signed message envelope that crosses the Relay (`envelopeId`, `taskId`, `seq`, `eventType`, `senderDid`, `recipientDid`, `payload`, `signature`) and the acknowledgement `AckReceipt` |
| `audit-entry.schema.json`                                  | Planned (M0)               | A bilateral signed hash-chain ledger entry, plus `UsageReceipt` / `ApprovalReceipt`                                                                                                       |

---

## 3. Schema validation command

### Manifest protocol versions

The versioned 0.1.0/0.2.0 schemas share the `task-manifest` dispatcher; include both references below.
The 0.1.0 rules and original example remain valid. See [protocol versions](../docs/connections/protocol-versions.md)
for registry details, signed card examples and compatibility policy.

```bash
npx --yes -p ajv-cli@5 -p ajv-formats@3 ajv validate \
  --spec=draft2020 \
  -c ajv-formats \
  -s spec/task-manifest.schema.json \
  -r 'spec/task-manifest.*.schema.json' \
  -d spec/examples/sample-task-manifest.json
```

## M0–M1 executable wire profile

The new `capability-token`, `usage-receipt`, `approval-receipt`, `ack-receipt`,
`envelope` and `audit-entry` schemas are implemented. Run `pnpm validate:schemas`
to compile all schemas and validate every example using Ajv Draft 2020-12.

Signed protocol objects use `{ "payload": <object>, "signature": <block> }`.
Let `D = "sha256:" + hex(SHA256(UTF8(JCS(payload))))`. The block contains
`signerDid`, `canonicalization: "RFC8785-JCS"`, `payloadDigest: D`, `signedAt`, and
`signature: "ed25519:" + base64url(64-byte-signature)` without padding.
The exact Ed25519 signature preimage is:

```text
UTF8(JCS({payload, signerDid, canonicalization, payloadDigest, signedAt}))
```

This covers the payload and signature metadata, and does not sign the signature
bytes themselves. It refines the draft's general rule above. JCS inputs must be
finite JSON data with valid Unicode; undefined, cycles, sparse arrays, nonfinite
numbers, custom object instances and lone surrogates are rejected. Content
addresses for JSON artifacts use `SHA256(UTF8(JCS(data)))`; `digestBytes` is
available for exact binary content. did:key encodes the Ed25519 public key with
multicodec bytes `ed 01` and base58btc multibase `z`.

Capability proofs are an ordered root-to-leaf array of signed tokens. Each child
binds `parentHash` to the SHA-256 digest of its complete signed parent, changes
issuer to the parent's audience, retains task binding, narrows the resource,
tools and argument schemas, never raises maxCalls or expiry, never backdates
notBefore, and decreases maxDepth by at least one. A zero depth forbids another
child. Wire token `maxCalls`/`maxDepth` correspond to manifest grant
`maxInvocations`/`maxDelegationDepth`. Argument schemas are indexed by tool name.
Only identical schemas or direct `allOf` inheritance are accepted. See the
security model for supported scope and schema syntax.

Approval receipt gate names map to the manifest's names:

| Receipt gate         | Manifest gate             |
| -------------------- | ------------------------- |
| contract_acceptance  | GATE_CONTRACT_ACCEPT      |
| external_side_effect | GATE_EXTERNAL_SIDE_EFFECT |
| budget_increase      | GATE_BUDGET_OVERRUN       |
| redelegation         | GATE_SUB_DELEGATION       |
| final_verification   | GATE_DELIVERY_ACCEPT      |

Owner-signed approval receipts bind the task, gate, exact target digest and
APPROVED/REJECTED decision. Gate instances reject receipt replay. Signed
transitions bind contract digest, task, prior state and zero-based sequence. The
M1 transition profile uses PROPOSED, ACCEPTED, IN_PROGRESS, DELIVERED,
VERIFY_ACCEPT, VERIFY_REJECT, SETTLED, CANCELLED and DISPUTED; the exhaustive table
is in `conformance/state-transitions.json`. PROPOSE establishes PROPOSED. Negotiation,
retry and timeout-specific states in the architecture remain later extensions.

Audit body fields are `taskId`, zero-based `seq`, `prevEntryHash` (null at genesis),
`actorDid`, `receiverDid`, `eventType`, `payload`. `entryHash = digest(body)`;
`actorSignature` signs the body and `counterSignature` is a signed AckReceipt
binding that hash, task and both parties. The final signed checkpoint fixes the
count, head and actors and is signed again by the other party. JSONL contains
`{"entry": ...}` records followed by one `{"checkpoint": ...}` record. Bundles
contain `{entries, checkpoint}`. The checkpoint is required for offline verification.
An independent latest head is required to detect rollback to an older valid bundle.

A valid `reportProgress` may include intermediate `metrics`, and those metrics are charged to the session quota before the progress frame is queued. An invalid `reportProgress` payload (`INVALID_PROGRESS`) does not apply its `metrics`. The returned promise rejects immediately, and the session records a sticky failure, so a later deliverable cannot settle. The requester observes `PEER_REJECTED: {"code":"INVALID"}` and the worker fails with `INVALID_PROGRESS`, even if the adapter catches the promise.

A2A AgentCard, Task, Message and Artifact retain SDK wire shapes, carried inside
signed Sealbridge envelopes. The bridge uses the installed A2A SDK 0.3 wire profile;
Sealbridge contract/receipt objects are overlay payloads rather than changes to A2A.
MCP `tools/call` requests and results use the official SDK and are physically
proxied outside the sandbox. Unknown tools and metadata-free bypasses are denied.

## Connection control profile (preparatory)

See [connection exchange](../docs/connections/connection-exchange.md) for signed
request, acceptance and ACK payloads, control envelopes and persistence requirements.

## M2/M3 additive discovery and session profile

The M0/M1 JSON schemas and examples remain unchanged. Signed AgentCards and
invites use the same `Signed<T>` preimage. `AgentCard` contains ownerDid,
agentDid, relayEndpoint, skills (including optional JSON input/output schemas),
costModes, name, description and version. The owner signs the card.
`AgentInvite` binds the complete signed card to the same ownerDid/agentDid and
relayUrl, plus issuedAt/expiresAt. Parsers reject invalid signatures, mismatched
identities/routes, future issuance and expiry. URI encoding is either
`acp-invite:<base64url(JSON(Signed<AgentInvite>))>` or
`acp://invite?token=<same-base64url>`.

Session envelopes have monotonic sequence numbers per sender. Each application
event is followed by an `AUDIT_ENTRY` envelope carrying a signed audit body;
the receiver returns `AUDIT_ACK` carrying its signed AckReceipt. Both sides
append the identical AuditEntry. `CHECKPOINT` and `CHECKPOINT_ACK` exchange the
final signed checkpoint and countersignature. DELIVER includes artifact, usage,
attestation and its signed transition. Attestations may add
`effectiveIsolationLevel` and `sandboxBoundary` (`nodePermissionFlag`,
`permissionModelActive`, `kernelNetworkIsolated`). `node:vm` is not a security mechanism,
and Node's `--permission` / `--experimental-permission` model does not block
`fetch`, `node:net`, `node:http`, `node:https`, `node:dns`, or `node:dgram`.
`kernelNetworkIsolated` is true only for `oci_container` (`isolationLevel: 'oci_container'`),
which is the kernel network boundary: `--network none`, `--read-only`, `--cap-drop ALL`, and `no-new-privileges`.
`subprocess_restricted` may add `--allow-fs-read` and `--allow-fs-write` with the
permission flag. Original M1 attestations remain valid.
