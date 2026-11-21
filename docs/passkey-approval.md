# Owner approval in chat

Workers use encrypted approval links by default for work outside their automatic
read-only rule. The agent shows the link in Muse or Grok Bot. The owner opens it,
reviews the peer DID, exact task input, capabilities, gate and reason, then uses
a passkey (Face ID, fingerprint, Windows Hello, or authenticator PIN).
There is no social login. Opening a link grants no permission. Connection consent
and isolation policy remain separate. Real isolation stays opt-in through
`requireIsolatedExecution`.

Use MCP `acp_owner_approval {"action":"list"}` to obtain pending links for the
local worker owner. `{"action":"register"}` returns a registration link immediately
and verifies results while the MCP process runs. `{"action":"poll","id":"..."}`
explicitly checks a result after a restart. The server's relay allowlist applies.
Worker stderr and event notifications carry approval metadata only; private links
are retrieved through this tool or `passkeys pending`, rather than service logs.
CLI equivalents: `passkeys list`, `passkeys pending`, `passkeys register`, and
`passkeys poll ID`, with optional `--key` and `--relay`. CLI registration prints
the link and waits; MCP registration returns the link immediately.

The first task requiring approval can issue a registration link, followed by a
separate task approval link. Keep the worker running; links do not resume a task
after process exit. Interrupted tasks require explicit fresh submission.

## First-passkey trust and verification

**First-key trust is limited to the first ten minutes after worker startup.**
Only a running worker can open that local enrollment window, and only while no
passkey exists. The worker verifies its own signed window record and local clock;
relay and page timestamps cannot extend it. Restarting a still-unenrolled worker
opens a fresh ten-minute window and invalidates prior-window registration links.
Once a passkey is registered, restarting never opens another bootstrap window;
additional keys require an existing passkey. Missing previously initialized
registry state fails closed rather than resetting first-key trust.

**Remaining risk: an agent that acts within the ten-minute window can still
register a software authenticator first and approve work.** The window reduces
exposure; it does not prove that the first enrollee is the human owner.
Register promptly from an owner-controlled installation and inspect the
`https://sealbridge.app` origin. An agent must not complete the first ceremony on
the owner's behalf. With no key, worker output, MCP results and the approval page
explain that writes cannot be approved and how to restart/register. Read-only
work continues when enrollment closes. Newly registered credentials generate a
`passkey_registered` worker log and the existing `--notify` target when configured,
including registration completed by a separate MCP process.

Recommend `sealbridge config key-store keychain` (JSON: `keyStore: "keychain"`).
This does not automatically migrate existing keys; see the key-store guide.

Additional passkeys require a verified registration and an assertion from an
existing passkey, committing to the new registration bytes. Registration and
authentication require user presence, user verification, exact origin and RP ID.
The local registry is owner-signed and serialized with a lock. WebAuthn challenges
commit to the displayed content, decision, gate and one-use nonce. Replay
consumption is persisted before signing as owner. Expired requests cannot start
work; a decision for task A cannot authorize task B.

The relay carries only AES-GCM ciphertext. The key stays in the link fragment and
is removed from browser history when the page loads. A separate derived capability
permits mailbox access without allowing relay decryption. Possession permits
viewing the request but cannot replace a registered passkey. Share links privately.
Owner-key or same-account process compromise is outside this approval boundary.

## Automatic money and size limits

Write-capable adapters always require owner approval in the default passkey flow,
even if an older automatic rule says `write`. Paid-only OpenAI work can proceed
without a passkey inside an owner-configured `max-monthly-usd` and known pricing.
Without a cap, it requires approval every time. Set a cap using
`sealbridge config auto-accept max-monthly-usd 5`.

The default automatic input limit is **128 KiB of UTF-8 JSON**. Larger inputs need
approval. The complete signed/encrypted relay envelope is capped at 256 KiB;
protocol metadata, capability chains and encryption overhead can further reduce
the input that fits. Existing configured diff limits still apply.
Capabilities, redelegation and verification commands cannot use the paid-only
exception. Custom provider endpoints and unknown model prices require approval.

Automatic paid admission conservatively debits the manifest's maximum input/output
token cost before approval under a shared owner/month lock. Concurrent workers
and restarts cannot each spend the full cap. Reservations stay charged through
the UTC month, including unused/failed work; there is no usage-based refund.
At/above this automatic authorization ceiling the owner may explicitly approve
additional money. It is not a provider billing guarantee. Maximum reservations use the existing owner-signed monthly journal, so prior
spend and live legacy reservations reduce the available allowance. Explicitly
approved known-price work is charged too. Approving unknown-price work requires
manual approval for subsequent paid work that UTC month, since its total cannot
be established safely. Terminal compatibility keeps its existing usage semantics.

Supported standard OpenAI text rates include `gpt-4o-mini` and its dated alias
($0.15 input/$0.60 output per million tokens), checked on 2026-11-21 against the
[official model page](https://developers.openai.com/api/docs/models/gpt-4o-mini).
The existing owner-supplied `gpt-6-luna` price snapshot remains supported.
Unknown prices are never guessed. Recheck rates before relying on automatic spend.

## Terminal compatibility

`worker start --tty-approval` explicitly selects the previous terminal approval
and inspection behavior, including its existing monthly-limit semantics.
It still requires stdin and stderr TTYs. There is no implicit terminal fallback
when the relay/passkey channel fails. This preserves terminal integrations while
keeping the default usable from Muse and Grok Bot. Existing invitation and task
wire formats remain compatible; worker approval-channel defaults change.

## Deployment needed (not performed)

1. Deploy the relay worker exporting `ApprovalDurableObject`. Add the `APPROVALS`
   Durable Object binding and SQLite migration `v3-owner-approvals`, as shown in
   `packages/relay/wrangler.toml.example`. Existing bindings remain.
2. Routes: `POST /v1/approvals/:id` for owner-signed encrypted requests;
   `GET /v1/approvals/:id` for encrypted request retrieval;
   `GET|POST|DELETE /v1/approvals/:id/results` for encrypted result candidates;
   CORS `OPTIONS`. Result DELETE is worker-management-only and drops exact invalid
   candidate hashes; its random capability is never included in approval links.
   The bounded rolling result queue retains at most 16 candidates and always
   accepts a later candidate instead of locking a full mailbox. The worker verifies
   candidates and drains junk. Local pending creation is serialized and deduplicated
   (128 distinct active ceremonies per owner); repeated registration calls reuse
   one link. Continuous flooding or an untrusted relay can still deny availability,
   but cannot authorize work. IDs are 64 lowercase hex characters. Routes use bounded bodies,
   capability authentication, rate limiting, no-store headers and ten-minute
   expiry alarms. Production approval routes require the existing `RATE_LIMITER` binding and fail
   closed if it is missing or unavailable; reuse the operator's namespace or add it
   as shown in the example. No new database/KV, account provider or secret binding
   is needed. Expiry uses `storage.deleteAll()` to remove the complete mailbox.
3. Deploy invite-site `/approve/index.html`, `/approve.js`, stylesheet and updated
   `_headers` at **`https://sealbridge.app`**. Only the approval page permits HTTPS
   relay connections; existing `/i` and `/j` policies stay unchanged. The RP ID and
   expected origin must stay consistent. Publishing this guide on the main docs
   site is optional.
4. Distribute the new CLI/runtime only after separate release approval. Old relays
   fail closed with `APPROVAL_RELAY_UNAVAILABLE`; they cannot carry this new flow.

This PR performs no relay/site deployment, publish, release, tag or version bump.
Tests use in-memory transports and a local virtual authenticator, without
production relay or provider requests.
