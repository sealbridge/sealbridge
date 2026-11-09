# Worker audit interruptions (local format 1)

Workers use this storage format by default. Update older audit readers before upgrading writers:

```sh
sealbridge worker start --audit worker.jsonl
sealbridge audit-verify worker.jsonl
```

The library option `WorkerNodeOptions.auditInterruptionFormat` defaults to `1`. Explicit library value `1` and CLI `--audit-interruption-format 1` remain supported; no opt-in is required. This setting changes local storage only: manifest versions, wire events, agent cards, and peer floors are unchanged. It grants no approval or connection consent. Normal entries retain their existing hashes and both signatures.

A worker may append one final `{ "interruption": Signed<AuditInterruption> }` JSONL row after exactly one acknowledged `PROPOSE`. It covers `OWNER_APPROVAL` and `ACCEPT_ACK_WAIT` only, for `SESSION_TIMEOUT`, `WORKER_STOPPED`, `WORKER_RESTART_OBSERVED`, or `HELD_ATTEMPT_CLOSED`. An ACCEPT frame sent without its verified audit ACK is excluded. Ordinary refusal, pre-admission rejection, held intake, execution, and settlement are outside this format's scope. `HELD_ATTEMPT_CLOSED` means the worker observed that this task's held record was discarded while the attempt was still in one of those two phases. It does not record owner approval, owner refusal, or why the requester left.

ContextGrant sessions use compact proposal evidence and bilateral lifecycle entries, so they are also outside format-1 interruption closure scope. The default preserves their existing lifecycle and recovery behavior without writing an interruption or persisting an eligible audit stage. Sessions without grants keep the format-1 behavior described here. See [context grants](context-grants.md).

The worker owner signs the task ID, ordered `[requesterOwnerDid, workerOwnerDid]` actors, terminal sequence and previous hash, acknowledged count/last sequence/head, a digest of the complete saved entries array (including signature metadata), phase, reason, UTC observation time, and `formatVersion:1`. The observation time equals the signature time; restart uses the time of observation, without estimating the original stop time. Offline verification checks the signed PROPOSE manifest and roles without applying current manifest expiry or live retirement policy.

The JSON form is `{ entries, interruption }`, exclusive of `{ entries, checkpoint }`. Schemas are `audit-interruption`, `audit-evidence`, and `audit-file-record`; the existing `audit-entry` schema still requires its countersignature. Empty prefixes, unknown versions/phases/reasons, duplicate or misplaced terminals, subsequent entries, mixed row kinds, and extra object properties are rejected. Blank lines and CRLF retain the bilateral parser's existing handling and physical-line diagnostics. No header or replacement checkpoint is added.

## Public interfaces and results

`@acp/ledger` and `sealbridge/sdk` export `parseAuditJsonl`, `verifyAuditEvidence`, and `createAuditInterruption`; the new types are `AuditInterruption`, `InterruptedAuditBundle`, `AuditEvidence`, `AuditFileRecord`, `InterruptionStore`, `AuditEvidenceTrustAnchor`, `AuditEvidenceVerificationOptions`, `InterruptedAuditVerificationResult`, and `AuditEvidenceVerificationResult`. Both entry points also export the existing bilateral ledger APIs and types.

`parseJsonl(): AuditBundle` and `verifyAudit(AuditBundle)` remain bilateral-only. Older 0.4.x readers reject interruption JSONL with `MISSING_OR_MISPLACED_CHECKPOINT`; new readers do not reinterpret an interruption as a checkpoint. `SessionResult.bundle`, recovered results, and task result caches still require bilateral evidence.

| Evidence | `status` | `valid` | `audit-verify` exit |
| --- | --- | --- | --- |
| Verified bilateral checkpoint | `VALID` | `true` | 0 |
| Verified worker-only terminal | `UNILATERALLY_CLOSED` | `false` | 2 |
| Broken evidence or mismatched pins | `INVALID` | `false` | 1 |

Unreadable input and argument/I/O failures exit 1 with diagnostics. Existing bilateral results, status labels, pins, and exit codes are retained. Scripts requiring bilateral evidence must continue to require exit 0 or `valid:true`; accepting exit 2 is an explicit choice to handle a worker observation.

Interruption results include `prefixVerified`, `terminalSignatureVerified`, `bilateralCheckpointVerified:false`, `closureKind:'interruption'`, `trustAnchorVerified`, and `truncationChecked`. Their result reason `WORKER_ONLY_INTERRUPTION` is separate from the payload's observation reason. Even matching independent pins never produce `VALID` or a peer terminal signature.

Existing task/actor/head/final-event/last-entry-hash/count pins apply to the normal prefix; the interruption is excluded from entry counts. `expectedFinalState` still means the last normal event, so `SETTLED` does not match a PROPOSE-only interruption. New options `expectedClosureKind` and `expectedInterruptionHash` pin the terminal kind and `digest(interruption.payload)`. Options may be top-level or in `trustAnchor`; contradictory values fail. CLI equivalents are `--expect-closure-kind bilateral|interruption` and `--expect-interruption-hash <hash>`, or fields in an anchor JSON file.

For interruption results, `trustAnchorVerified` means all supplied pins matched. `truncationChecked` becomes true only when a head, count, last-entry hash, final event, or interruption hash was actually compared. Task ID, actors, or closure kind alone leave it false. The existing bilateral identity-only anchor behavior remains unchanged; unifying those flags is outside this change.

MCP `acp_verify_audit_bundle` accepts either exclusive bundle form and returns the corresponding report union. `UNILATERALLY_CLOSED` is a normal tool result with `valid:false`, never a tool execution error. Bad argument shapes retain JSON-RPC `-32602`. Verification remains offline. `receipt` reports the worker-only observation and verification, redacts content, and retains its existing non-completion state; it does not add an interruption receipt state or classify it as `COMPLETED` or `UNCONFIRMED`.

## Persistence and recovery

The worker freezes wire audit mutation and drains queued sends before deciding closure. The JSONL store re-reads all rows and checks the exact prefix under the same file lock used by append and seal. The worker persists a signed journal intent containing the complete signed interruption before append; the store rechecks file bytes after the intent callback, appends a complete row, fsyncs the file, then the worker saves `auditClosure.state:'written'`. Replays accept only the identical signed terminal and prefix and sync again, without re-signing or adding a duplicate row. An interruption seals the file against both append and checkpoint writes with `LEDGER_SEALED`.

Task journal version 1 gains optional `auditStage` (`OWNER_APPROVAL`, `ACCEPT_ACK_WAIT`, or `OUT_OF_SCOPE`) and `auditClosure` (`pending`/`written` plus the signed record). New-format in-progress stages are closed on startup with `WORKER_RESTART_OBSERVED`, including when the writer option is omitted. Pending intents replay the original signed record whether the row is absent or already present. An eligible audit stage left without an intent by a pre-intent write failure can still close on restart when its business outcome is TASK_INTERRUPTED; the business outcome does not supply a completed audit terminal. Stages absent from legacy records are never inferred or backfilled. A valid existing bilateral terminal remains the task-result authority; other terminals, mismatched prefixes, and torn audit JSON are preserved and diagnosed. Audit tails are never truncated or repaired automatically.

The business outcome remains `TASK_INTERRUPTED`; no SETTLED/CANCELLED result or adapter invocation is generated by closure. By default, discarding that task's held record during `OWNER_APPROVAL` or `ACCEPT_ACK_WAIT` (`tasks approve`, `tasks reject`, or the same local discard) appends `HELD_ATTEMPT_CLOSED` immediately. The worker process does not need to stop. Closing the held attempt still does not execute the task or grant connection consent. Later attempts continue to use separate task-suffixed audit files, while the primary file preserves the named interruption. A file sealed by an interruption is not appended.

File and journal persistence are separate writes, not a transaction. Explicit worker journals use file fsync and, on POSIX, directory fsync; interruption closure fsync includes the previously saved normal prefix. Windows uses file fsync without directory fsync. This does not add per-entry fsync to normal audit appends or broaden normal bilateral durability guarantees.

`JsonlStore` coordinates cooperating writers using an exclusive `<auditPath>.lock`; all processes must use the same path and updated writer. Sharing with an old writer is unsupported. A leftover lock returns `LEDGER_BUSY` and is never stolen automatically: verify that no writer is alive before explicit local removal. Interrupted closure failures are reported as `AUDIT_INTERRUPTION_WRITE_FAILED`, leave an unresolved intent when one was persisted, and retain the original task outcome. They never report closure as written. A process death while holding the lock requires that local lock recovery before journal replay can proceed.

Embedders can use `InterruptionStore.closeInterrupted(bundle, beforeWrite?)`, implemented by `JsonlStore` and `MemoryStore`. The callback journals the exact intent while the store excludes other writers; it must complete synchronously and must not change the audit file. Promise-returning intent callbacks are rejected before terminal append. Unsupported custom `AuditStore` implementations do not gain interruption support implicitly. Without a journal, a live closure can be synced, but there is no persisted intent or automatic restart recovery. The embedder must keep the original prefix and handle uncertain writes; the store permits only identical retries. Without an audit path, the worker reports no in-file interruption closure.

## Comparing independently held evidence

The worker signature attests its own observation of the presented prefix. It does not establish the owner's approval/refusal, the requester's exit cause, the reason's factual accuracy, an independent timestamp, the absence of later history, or task completion. The worker journal and values derived from the same file are not independent comparison anchors.

For a requester copy, match task ID and owner roles, verify each normal entry's body hash and signatures, and then determine the common prefix. A shorter requester copy can reflect ACK arrival or persistence differences and alone is not a contradiction. Preserve independently verified longer history or a bilateral checkpoint alongside the worker observation. Different verified content at the same sequence is a history mismatch; retain both originals. An interruption cannot revoke or replace a bilateral completion checkpoint, and the two are not merged into a synthesized agreement. Re-presenting identical evidence is the same observation, never a new task or approval. Different interruptions for the same task are not selected by timestamp. The verifier does not fetch peer files; dedicated comparison UX is deferred.

Worker terminal events and `WorkerNodeOptions.onEvent` distinguish `INTERRUPTED` (`code: TASK_INTERRUPTED`) from `REJECTED` (including real `EXECUTION_FAILED` adapter failures). Live interrupted handshakes include `phase: OWNER_APPROVAL` or `ACCEPT_ACK_WAIT`; CLI JSON includes a Japanese reason explaining that the session was interrupted while waiting for the peer, which may have exited. Restart recovery may omit the phase. This local event does not change wire events or audit evidence.
