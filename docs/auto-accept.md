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

The signed AgentCard advertises the complete rule. CLI and MCP requester review
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
provider. No daily-DID, monthly-cost, pre-call-size or shared-invite limits are
implemented here (#255–#258); `limits` reserves their configuration location.
Nonempty/unknown limits and unsupported rule versions are rejected, rather than
silently running without those protections. This feature does not implement
per-connection standing approvals (#248), deploy a worker, or change relay code.
