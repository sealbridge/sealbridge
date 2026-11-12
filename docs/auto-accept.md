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
provider. Monthly model-cost accounting is described below. Pre-call-size and
shared-invite limits remain unimplemented (#257–#258).
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
`off` removes it. Restart workers after changes. The default is unlimited; the
official worker explicitly sets 20 (50 and 100 are also supported), selects
`--adapter openai --model gpt-6-luna`, and keeps the separate daily DID cap at 3.
The cap covers all model work on that local worker identity, including human-approved
tasks, so a different admission path cannot bypass it. Other worker identities
and data roots have separate counters.

Prices are a versioned-in-source snapshot supplied for 2026-11-11, in USD per
million input/output tokens: gpt-6-luna 0.10/0.50, gpt-6.1-terra 1/5,
gpt-6.1-sol 2/10, claude-haiku-5-5 0.10/0.50, claude-sonnet-5-5 2/10.
Integer nano-dollars avoid accumulated rounding. This is model cost only, without
server, relay or operator costs, discounts or cached-token rates. Custom endpoints
must use the corresponding price; aliases and unknown models fail closed.
The trusted adapter declares `billingModel` and reports actual input/output token
deltas (including billed reasoning tokens in output), even when execution fails.
CLI adapters without reliable model/usage reporting cannot use a monthly cap.

Admissions stop at the cap with `MONTHLY_LIMIT_REACHED`; running tasks finish and
their usage continues to count, so concurrent tasks can overshoot the cap. There
is no cost reservation or pre-call size estimation (#257). Each usage report is
charged to its reporting month, resetting on the first at 00:00 UTC (09:00 Japan
time), including across year boundaries. The signed AgentCard retains its strict
schema and advertised cap, remains published and says “Monthly intake closed.
今月の受付は終了”. On the next UTC month, an idle published worker refreshes the
card during polling. Offline workers refresh on restart/register/invitation.

The source of counting state is a worker-signed, hash-linked JSONL history at
`<data-root>/workers/<worker-DID-hash>/auto-accept-monthly.jsonl`. Begin, usage and
finish/uncertain records include the model, timestamp and integer token/cost
amounts. The rule digest remains in the ordinary bilateral approval audit.
PID-claim locking, exclusive temporary writes, flush and atomic rename serialize
updates. A separate `.initialized` marker prevents a missing journal from silently
resetting an existing counter. Retain both files and protect the directory.

Corruption, signature failures, clock rollback, missing prices, lock contention,
unavailable writes and unresolved usage fail closed (`MONTHLY_STATE_UNAVAILABLE`).
An unreported or interrupted call stays uncertain even next month. An active call
is recognized only by the process actually metering it; another process sharing
the identity waits until it finishes. Before operator recovery, stop every worker
sharing the identity and reconcile uncertain usage with provider billing; do not
delete accounting history to resume acceptance. This is not power-loss durable
directory fsync, nor protection against an owner deleting all local state.

Worker errors send only a known limit code and a canonical reset timestamp.
Requester CLI/MCP render fixed bilingual text, discard peer prose for monthly,
daily and rate-limit errors, and validate the reset time before displaying it.
Monthly guidance suggests `sealbridge demo` or inviting a friend. Human admission,
discovery and invitation do not waive the cap.
