# Grok Bot and Muse without a terminal

With Sealbridge connected to your agent host, ask it to create an invitation with
`acp_create_invite {}` and give the returned short link to the other person in chat.
The receiving agent can call `acp_connect {"to":"<short link>"}` directly. Show the
returned peer name and six-digit confirmation number in chat and compare them with
the sender. A pending connection means the signed peer reply has not arrived yet;
there is no separate terminal import or confirm-invite step. Do not automatically
resubmit held tasks.

For an operator configuring a background worker, `worker start --notify <command-or-webhook-URL>`
sends one JSON object per event to command stdin or via HTTP POST. It works without
`--inbox`; notification targets default to off. Events are `task_received`,
`approval_needed` (`held` identifies a held attempt), `completed` (settled), and
`new_connection`. Payloads contain timestamps and identifiers, never task bodies,
invite tokens or private keys. Commands run on the worker host. Failed notifications
are reported as `notification_failed`, do not change approval decisions and are not
retried automatically; delivery is best effort and the in-memory queue is bounded.

For example, configure a webhook once with `--notify https://your-bot.example/events`.
Use the owner's `config auto-accept invited read-only` policy for sandbox read-only
work. Matching work runs without a terminal; writes, paid work and work outside the
rule still need the existing owner review. A notification reply cannot approve work.
Running workers issue a fresh short invitation after their current short link is used.
Live MCP servers also renew consumed invitations and send the replacement link and
confirmation number through MCP logging notifications (or the embedding host callback).
One-shot CLI invite creation exits after returning its link; keep a worker or MCP host
running for automatic renewal.
Explicit `--share token` / MCP `share: "token"` preserves long offline invitations.
