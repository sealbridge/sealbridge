# Owner-configured automatic acceptance

[日本語](auto-accept.ja.md)

All workers support the same rule. A new installation automatically accepts only
read-only work from connected peers. Unknown peers remain held until the owner
explicitly selects another audience. Publication and `--allow-local-pc` grant no
admission authority. Connection consent and requester approval remain separate.

```sh
sealbridge config auto-accept                        # read, without writes
sealbridge config auto-accept connected read-only    # default
sealbridge config auto-accept invited read-only
sealbridge config auto-accept anyone read-only       # explicit public admission
sealbridge config auto-accept connected write        # explicit write/command opt-in
sealbridge config auto-accept off                    # human approval
```

Restart existing workers after changing settings. Settings are saved atomically in
the existing owner-local `<data-root>/config.json`, preserving unrelated fields:

```json
{
  "version": 1,
  "relays": ["https://relay.sealbridge.dev"],
  "autoAccept": {
    "version": 1,
    "enabled": true,
    "from": "connected",
    "work": "read-only",
    "limits": {}
  }
}
```

`invited` requires an active connection established by this worker's verified,
owner-bound invitation. It preserves the current first-owner binding, expiry and
revocation rules; a common multi-person invite is not implemented. `connected`
requires a current 0.2.0 connection. `anyone` can admit an unknown peer without
creating connection consent. Blocks, explicit peer/requester allowlists, capability
checks, task scope, budgets and rate limits still apply in every mode. A previously
held task attempt stays terminal: submit a new task explicitly.

Read-only classification uses host-owned execution properties, never text supplied
by the requester. An adapter must guarantee `taskAccess: 'read-only'`, every granted
tool must be registered as `readOnly: true`, and the manifest must contain no
delegation or executable verification checks. The API-only OpenAI-compatible
adapter qualifies; arbitrary command, CLI, MCP and sandbox adapters conservatively
require `write` or human approval unless a trusted embedding supplies an adapter
that guarantees read-only behavior. This declaration is a host contract, not an OS
sandbox or an analysis of the task prompt. Writing a deliverable and local audit
records is not classified as modifying the owner's resources.

Matching work runs without per-task inspection or human opening. Non-matching
work follows the existing inspection and human approval flow. `--auto-accept`,
`--auto-approve` and `--yes` on worker startup do not expand the configured audience
or enable writes. The former LLM allowlist requirement is removed. A custom `PolicyAutoApprovalProvider` and legacy trusted grants cannot bypass an
unmatched rule. Embedders must explicitly configure `autoAccept.work: "write"` to
automate adapters that can modify resources or execute commands.

The signed AgentCard advertises the complete rule. CLI, MCP requester review and invitation-page
surfaces say “This worker responds automatically, not through a human.” The existing
requester send and final verification approvals remain in place. Old cards omit
the field; a remote advertisement never changes the local owner's settings.

Every automatic acceptance carries a signed `ApprovalReceipt.authorization` with
`kind: "auto-policy"`, `ruleVersion: 1`, and `ruleDigest` (SHA-256 of the full rule).
It is included in the bilateral `ACCEPT` audit entry. `--audit` keeps its normal
per-task paths; without it, workers persist task ledgers under
`<data-root>/workers/<worker-DID-hash>/auto-accept-audit/`. Failure to persist the
audit prevents acceptance. Retention/cleanup is owner-managed.

For embedders, `WorkerNodeOptions.autoAccept` supplies the same typed rule, and
`autoAcceptStateGuard(context, policy)` is the check/reservation boundary for
future stateful limits. It must atomically read and reserve its counting state
before returning exactly `true`; rejection, unavailable state or exceptions do not
authorize automatic acceptance. A failed check never falls back to a policy
provider. Monthly model-cost accounting and pre-call size checks are described
below. Shared invitations remain unimplemented (#258).
Unknown limits and unsupported rule versions are rejected, rather than
silently running without those protections. This feature does not implement
per-connection standing approvals (#248), deploy a worker, or change relay code.

## Per-requester daily allowance

The default has no per-DID daily cap, preserving existing behavior. For the official
worker's three tasks per person per day, the owner configures:

```sh
sealbridge config auto-accept max-tasks-per-day-per-did 3
sealbridge config auto-accept max-tasks-per-day-per-did off # remove cap
```

Restart the worker. This preserves the audience, work permission and enabled state.
The JSON setting is `autoAccept.limits.maxTasksPerDayPerDid`, a positive safe integer;
omit it for unlimited. The signed AgentCard and audit rule digest include the cap.

Automatic admissions count separately for each requester **owner DID**, shared by
that owner's agents, under each local worker identity. The day resets at 00:00 UTC
(09:00 Japan time), with no rolling window. State lives at
`<data-root>/workers/<worker-DID-hash>/auto-accept-daily/<requester-DID-hash>.json`.
The existing dailyLimit lock, exclusive temporary write, flush and atomic rename
reserve a slot before automatic approval. Reservations survive restarts and are
not refunded if later approval/audit/execution fails. Human-approved work is outside
this automatic allowance; the worker-wide `--max-tasks-per-day` remains separate.

At exhaustion, `AUTO_ACCEPT_DAILY_LIMIT_REACHED` returns fixed English/Japanese
text: “Today's free allowance is exhausted. It resets at 09:00 Japan time
(00:00 UTC).” / 「今日の無料分は使い切りました。日本時間の朝9時（UTC 0時）に戻ります。」
Unreadable, corrupt, locked or unwritable counting state and clock rollback
reject with `AUTO_ACCEPT_DAILY_STATE_UNAVAILABLE`, without falling back to human or
legacy policy approval for that attempt. First-use missing files initialize empty.
Repeated task IDs return `AUTO_ACCEPT_DAILY_TASK_REPLAY` with fixed bilingual
guidance that a slot was already reserved; the count is not incremented again.
The persistent `.lock/` directory contains unique PID claims. A subsequent request
reclaims claims only when the OS reports that their process no longer exists
(`ESRCH`). Live/reused PIDs, permission errors and malformed claims fail closed.
The directory remains in place to block older file-lock clients; stop older
workers before upgrading all processes that share counting state. Legacy empty
`.lock` files have no verifiable owner and require operator recovery after checking
that no worker is running. Never delete a live claim or the lock directory.
Owners must protect and retain the counting directory; deleting it loses history.
DIDs can be created freely; this does not prevent one person using several DIDs.

## Monthly model-cost cap

`sealbridge config auto-accept max-monthly-usd 20` sets `limits.maxMonthlyUsd`;
`off` removes it. Restart workers after changes. The default is unlimited. The
cap covers **all model work on the local worker identity, including manually
approved tasks**. Other worker identities and data roots have separate counters.
The official worker sets 20, keeps the separate daily DID allowance at 3, and runs
`--adapter openai --model gpt-6-luna`. Decimal USD limits such as 19.99 are supported.

The only priced model is gpt-6-luna: $0.10 input / $0.50 output per million tokens
(100 / 500 nano-dollars per token; owner-supplied 2026-11-11 snapshot). These are
model costs only, excluding server/relay/operator costs, discounts and caching.
A trusted adapter supplies `billingModel` and actual token deltas through
`reportUsage`; reasoning tokens billed as output belong in output usage. With a
monthly cap, an unpriced model is rejected **before approval/execution** with
`MONTHLY_MODEL_UNSUPPORTED` and fixed guidance to change model or cap settings.
It creates no unfinished accounting entry: changing back to a supported model
resumes acceptance, subject to the normal cap. No guessed price is used.

For cancelled, timed-out, over-budget, failed or unreported work, including a
process crash, accounting uses the valid token reports already persisted. If
there were no token reports (a valid zero-token report counts as a report), it
charges `maxInputTokens * 100 + maxOutputTokens * 500` nano-dollars from that
**task's saved manifest budget**. It records a signed `finish` or `estimate`, not
an indefinitely uncertain task. On the next admission/register/start, orphaned
begins are settled once. Live calls in this process or another live process keep
running. PID liveness errors do not poison admissions. Late reports after
settlement are ignored to avoid double charging. Rejections before acceptance
release their unused accounting entry at zero. An interrupted write/corrupt file
is a storage failure, not an excuse to discard spending; that still fails closed.

At the cap, new admissions get `MONTHLY_LIMIT_REACHED` while running tasks finish
and can overshoot it. No monetary reservation is made; pre-call size checks are described below.
Token reports count in the reporting month; a maximum-budget estimate counts in
the settlement/recovery month. The month resets on the 1st at 00:00 UTC (09:00 JST).
The strict signed AgentCard stays published with “Monthly intake closed.
今月の受付は終了”, and an idle published worker refreshes it on next month's poll.

The default requester text is generic: “The monthly intake limit is reached.
It resets on the 1st at 00:00 UTC (09:00 JST).” The official worker owner explicitly
selects the trial-specific fixed text, including `sealbridge demo` and inviting a
friend, with:

```sh
sealbridge config auto-accept monthly-limit-message trial-reviewer
sealbridge config auto-accept monthly-limit-message standard # restore generic text
```

The setting is `limits.monthlyLimitMessage` (`standard` by default). Worker errors
send only known codes, a validated reset timestamp and this bounded message-kind
enum. Requester CLI/MCP choose their own bilingual fixed text, never peer prose.
Unsupported message kinds fall back to generic text. The setting is included in
the advertised policy, strict AgentCard schema and signed approval rule digest.

### Accounting history and owner recovery

`<data-root>/workers/<worker-DID-hash>/auto-accept-monthly.jsonl` is the active
worker-signed, hash-linked journal. Begin rows save the original token budget;
usage/finish/estimate rows record the accounting decision. Ordinary writes append
and flush; they do not rewrite the history. A process caches verified state only
while inode, size and nanosecond modification/change timestamps match under the
writer lock; external changes force complete signature verification.

At a UTC month change, the previous journal becomes an immutable
`.jsonl.<YYYY-MM>.<sha256>.archive` file. A signed checkpoint in the active file
summarizes the previous month, binds its last hash and carries unfinished tasks.
Normal admission does not reread past archives. Keep archives according to the
owner's audit retention policy. The `.initialized` marker detects a missing active
journal. Initial creation and rollover use exclusive temporary writes and atomic
replacement; PID-claim locks serialize all changes. Directory fsync/power-loss
durability and protection against an owner deleting all state are not guaranteed.
The file-open I/O test limit remains unchanged at 450.

For an interrupted process, restart normally: saved reports or budget estimates
settle its unfinished calls. No manual clearing is needed. For an unsupported
model, select gpt-6-luna (or explicitly remove the cap) and restart. For a busy
lock, stop all processes sharing the identity and confirm none is alive before
removing only unverifiable stale claims; never clear accounting to resolve a lock.

For missing, corrupt or truncated storage (`MONTHLY_STATE_UNAVAILABLE`):

1. Stop every worker sharing this identity/data root. Preserve the damaged files
   and archives as evidence. Correct permissions, storage availability or clock
   rollback first; a transient failure needs no reset.
2. Restore an intact, owner-signed active journal and its `.initialized` marker
   from a trusted backup. Retain the archives. Verify it with the same worker key;
   the counter refuses invalid signatures and hash links. A partial final append
   must be restored from a complete authenticated prefix, not edited to invent
   usage. Do **not** delete both files or start with a zero counter.
3. Reconstruct each task missing since the backup from its signed task manifest
   and provider usage. In a built checkout of this revision, a trusted owner-side
   maintenance script can load the existing worker with
   `inspectStoredIdentity('worker', identityOptions)` from
   `packages/runtime/dist/key-store.js`, locate the journal via `workerIntakePath`
   from `packages/runtime/dist/index.js`, then instantiate `MonthlyCostCounter`
   from `packages/runtime/dist/monthly-limit.js` with that key and exact path.
   Call `counter.reconcileTask(taskId, {maxInputTokens, maxOutputTokens},
   {inputTokens, outputTokens})` using authenticated original bounds and provider
   counts. Omit the third argument if usage is unavailable: it charges the maximum.
   This appends signed records and is idempotent for already settled task IDs.
   It also repairs pre-release v1 unfinished rows whose budgets were not saved.
   Do this **before** `check`, restart or discovery, which automatically settles
   orphans. No private key should be printed or pasted into a command argument.
4. Back up the reconciled files, then restart with the same identity, data root,
   model and cap. If a complete authenticated history cannot be reconstructed,
   keep the worker stopped and obtain maintainer help; do not bypass the cap.

## Pre-call input size

Size caps default to **unlimited**, just like omitted daily/monthly caps. Owners explicitly choose positive safe-integer `limits.maxDiffLines`, `maxDiffBytes`, and `maxDiffFiles`; only selected dimensions apply. Configured caps cover all adapters, including human-approved work and disabled automatic admission, before execution and daily/monthly counters. They are separate from the relay's 256 KiB transport/inspection cap. The public AgentCard retains `additionalProperties: false`.

```sh
# Official-worker preset: set all three caps (400 lines, 49152 bytes, 10 files).
sealbridge config auto-accept diff-size trial-reviewer
# Individual caps are independent; omitted dimensions stay unlimited.
sealbridge config auto-accept max-diff-lines 400
sealbridge config auto-accept max-diff-bytes 49152
sealbridge config auto-accept max-diff-files 10
# Remove one cap, or all three. Daily/monthly limits and message selection stay intact.
sealbridge config auto-accept max-diff-lines off
sealbridge config auto-accept diff-size off
# Trial wording is a separate explicit choice (the preset does not change it).
sealbridge config auto-accept monthly-limit-message trial-reviewer
```

Restart after configuration changes. Existing `--max-input-tokens` and `--max-output-tokens` still limit advertised budgets. For the medium trial configuration, set them to 30000 and 4000. Size `off` does not disable input-token budget validation.

Counting never opens requester-supplied paths: text uses LF/CRLF/CR lines, excluding a final empty line, and includes unified-diff headers/context. JSON inputs sum every string leaf's lines. Byte count is `Buffer.byteLength(JSON.stringify(input), 'utf8')` for every input, including strings: JSON quotes, property names and escapes count too; this is not raw diff-file length. File count is the maximum of `diff --git` headers, `+++` headers, `files` array entries, and distinct `path`/`file`/`filename`/`filePath` fields, with one file for otherwise unstructured text. Send unified diffs or explicit file lists; this is an input-size bound, not a repository parser or an attachment fetcher.

Independently of size caps, the OpenAI-compatible adapter (including Anthropic API style) **always** validates the complete outgoing user message, including title, description, JSON escaping and output schema. The UTF-8 bytes of that message plus 256 framing tokens must fit `budget.maxInputTokens`. An understated budget returns `INPUT_BUDGET_EXCEEDED` before fetch; do not truncate input or silently raise the approved budget. This prevents undercharging the monthly maximum-budget fallback. Custom model adapters should implement `validateInput(manifest, input)` for their exact provider prompt too.

Only preflight refusals write owner-signed, fsynced `input_size_check` records under the worker's `pre-call-audit/`, containing task/requester IDs, time, configured limits, counts when available and outcome, without input text. Successful requests never create a size-audit file or depend on that destination, with or without caps. Unreadable configuration, uncountable input under an enabled cap or an unavailable rejection-audit destination fails closed. No mutable size counter is needed; refusals never spend daily or monthly quota.

Requester CLI and MCP construct fixed bilingual text from codes, discarding worker prose and extra fields. `INPUT_SIZE_LIMIT_REACHED` normally says the input exceeds the worker's size limit and asks to split it. Only explicit `monthly-limit-message trial-reviewer` selects trial-reviewer size wording; `standard` restores ordinary wording. Unknown message kinds select ordinary wording. Budget failures always use ordinary budget guidance, even with trial wording selected. `INPUT_SIZE_UNAVAILABLE` reports unverifiable size. Fixed text does not claim numeric caps that might differ from configuration. `MONTHLY_MODEL_UNSUPPORTED` only says the worker cannot accept the request; model/cap changes belong in owner-facing guidance.
