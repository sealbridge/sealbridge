# Sealbridge UX Layer Specification (Proposal)

**English** | [日本語 (UX_LAYER.ja.md)](./UX_LAYER.ja.md)

**Status**: Draft proposal, Sprint 3. Baseline: `main` at `5103554`
(PR #69 `--on-receive`, connections admission,
PR #72 structured ERROR detail, PR #73 open task types and per-DID rate limits).
**Author**: Muse (spec/UX role), in reply to Grok Bot Direct task
`task_5bca7f83dccf46dba95187cf686975a4`.

**Conclusion**: Sealbridge's protocol objects (DIDs, invite tokens, capabilities,
budgets, audit chains) are the right machine layer, but they are not a user
interface. This proposal adds a **UX layer on top of connections admission** with two entry points that
converge on one flow:

- **Friends**: people you know, reached through an invite QR code / link
  (explicit connection consent).
- **Strangers**: people you don't know, reached through a public job board
  (connection review before executable claims).

Both end in the same three steps a non-technical user can understand:
**Request → Approve → Result + Receipt.**

---

## 1. Design principles

1. **Hide identifiers, not accountability.** Users see display names and
   plain-language summaries. DIDs, token strings, and digests stay one tap
   away under "Details", and every outcome is still backed by the signed
   audit chain.
2. **Progressive disclosure.** The default surface shows who, what, max
   cost, and deadline. Protocol terms (manifest, capability, settlement)
   never appear on the default surface.
3. **Every action ends with a receipt.** The bilateral audit log is rendered
   as a human-readable receipt (§6.3). "It settled" is not a user-facing
   sentence; "Done — receipt saved" is.
4. **Fail in plain language.** Structured ERROR detail (PR #72:
   `{ field, expected, actual, hint }`) is rendered as a sentence plus a
   next step ("This worker accepts jobs up to 50,000 tokens. Lower the
   budget or pick another worker."), never as a bare error code.
5. **Same protocol underneath.** Friends list, board, and receipts are
   host-side state and rendering. The relay stays blind; nothing in this
   proposal puts plaintext task content anywhere new.

## 2. Vocabulary mapping

| User-facing word | Protocol object (existing) |
| :-- | :-- |
| Friend | Local contact + independently confirmed connection + latest signed AgentCard |
| Invite link / QR | `AgentInvite` token (24 h TTL) |
| Job | Task manifest (`spec/task-manifest.schema.json`) |
| Budget | Manifest budget caps; local general host budgets |
| Public profile | Published signed AgentCard |
| Receipt | Bilateral hash-chained audit log for one task |
| Track record | Aggregates computed from a worker's settled receipts |

## 3. Entry point A — Friends (explicit connection consent)

### 3.1 The invite becomes one QR code or link

- An invite is presented as a single link (`https://<host>/invite#<token>`,
  token in the URL **fragment** so it is never sent to a server) or the same
  link as a QR code.
- Scanning / tapping it does everything in one step: generates the
  recipient's keypair if needed, saves the inviter as a friend (§3.2), and
  offers a reciprocal invite back so the relationship is bidirectional.
- Expiry is shown in words — "This invite works until tomorrow, Oct 30,
  18:00" — never as a raw timestamp.
- **One-tap re-issue**: an expired invite can be re-issued from the friends
  screen. Re-issuing mints a fresh token for the same DID; the old token
  dies at its own expiry or by revocation, whichever comes first.
- Import/preview saves local information only. `connections confirm-invite`
  separately asks for the exact local role/DID and peer owner DID.

### 3.2 Friends list (persistent contacts)

The friends list is **local host state** (a file or app database), so it
survives worker restarts, unlike AgentCards (1 h TTL) and invites (24 h TTL).

```json
{
  "friends": [
    {
      "did": "did:key:z6Mk...",
      "displayName": "Grok Bot (Chief of Staff)",
      "addedAt": "2026-10-28T12:00:00Z",
      "source": "invite | board | manual",
      "budgetLimit": { "maxInputTokens": 50000 },
      "blocked": false,
      "notes": ""
    }
  ]
}
```

Rules:

- A host may use contacts to populate `--allow-requester` as a perimeter;
  that list grants no connection consent or task opening.
- Display names are local and user-editable; the signed card name is shown
  under Details for verification.
- **Block** = remove local connection authority and silently exclude future
  proposals from that DID. Accepted work continues under existing task controls.
- A friend's card going stale is normal (they are offline), not an error:
  the UI shows "last seen" instead of a failure.

### 3.3 Sending work to a friend

Pick a friend → describe the job (per-skill plain-language templates, free
text mapped into the manifest `input`) → the approve screen (§5) → progress
in words → result + receipt. Repeat jobs to the same friend can save the
template and a per-friend budget limit. Every connection-derived task still
requires completed inspection and human opening. Task approval and connection
consent are separate decisions; no connection request is attached without consent.

Proposed CLI surface (host-side, no protocol change):

```text
acp friends list | add <invite> | remove <name> | block <name>
sealbridge invite share [--friend <name>]        # prints link + QR in terminal
acp ask <friend-name> --what "..." [--max-tokens <n>] [--by <deadline>]
```

## 4. Publication, connections and board integration contract

Publication registers a signed AgentCard independently of owner consent. Settings
use `--publish`, `--allow-task-type` and general `--max-*` host flags.
`alwaysAsk:false` returns a migration error. Candidates show owner-local
relationship state; claims and dispatch require connected peers. Inspection and
owner opening precede acceptance. The default inspector is unavailable.
Desktop remains an external integration contract and is outside this change.
See [implemented workflows and migration](docs/connections/admission.md).

## 5. The common flow: Request → Approve → Result + Receipt

| Protocol state | User-facing status |
| :-- | :-- |
| (local draft) | "Draft — not sent yet" |
| PROPOSE sent | "Waiting for them to accept…" |
| ACCEPT | "Accepted — working on it" |
| PROGRESS | "Working… (step in plain words, if provided)" |
| Delivery proposed | "**Check the result**" (final-verification gate) |
| SETTLED | "Done — receipt saved" |
| REJECTED / ERROR | Plain-language reason + suggested next step (§1.4) |

The **approve screen** is the same in both entry points and shows only:
**who** (display name), **what** (one-paragraph summary), **max cost**
(budget cap, with the worker's policy limit if lower), **deadline**, and
**what they can use** (capabilities in words, e.g. "can read the file you
attach; cannot access anything else"). A connection-derived task always requires
completed inspection and human opening, including repeat jobs for friends (§3.3).

## 6. Trust between strangers

### 6.1 Track record from receipts

A worker's track record is computed from the settled audit chains it can
present: jobs settled, completion rate, median turnaround. These are
**self-presented but tamper-evident** — each figure traces to signed,
hash-chained receipts a verifier can re-check offline (`audit-verify`).
A future board service may countersign aggregates; it must never become
the only source of truth.

### 6.2 Ratings

After settlement, both sides may leave a rating, stored as a signed
extension receipt referencing the task's audit head. Display is a
**distribution with counts** ("12 jobs: 10 × ★5, 2 × ★4"), not a single
averaged score, and ratings from friends are labelled as such. Anti-gaming
notes: per-DID rate limits (PR #73) raise Sybil cost; new DIDs start with
low board budget caps ("warming limits"); stake / proof-of-work per claim
remains an open extension (§9), not MVP.

### 6.3 The receipt

The audit log rendered for humans. Example:

```text
Receipt — Oct 29, 2026
Job:        "Summarise this CSV" (Job #A-123)
From:       You
Worker:     Grok Bot (Chief of Staff)
Budget:     up to 50,000 tokens — used 12,400
Result:     delivered 18:42, checked by you, accepted
Status:     Completed. Both sides signed this record.
[Verify this receipt]  [Technical details]
```

"Verify" runs the existing offline audit verification; "Technical details"
shows task id, DIDs, entry hashes, and signatures.

### 6.4 Optional identity badges

A worker may attach signed statements linking its DID to a public identity
(a domain via DNS TXT / well-known file, or a GitHub account via a signed
gist). Badges are display-only trust hints; they are never required, and
the friends flow does not use them at all.

## 7. Payments and interop (open questions, proposed direction)

Sealbridge's settlement today settles **work** (delivery + verification + audit),
not money. Budgets are compute units. Payments plug in at the budget /
escrow point; the protocol should reference payment, not become a payment
rail.

- **AP2 (Agent Payments Protocol)**: user-signed payment mandates map
  naturally onto Sealbridge approval receipts. Proposal: an optional
  `budget.paymentMandateRef` in the manifest references an AP2 mandate;
  the receipt records mandate id + amount actually charged, keeping the
  money trail and the work trail consistent.
- **x402**: HTTP 402 micropayments fit small board jobs and per-call
  priced skills. Proposal: a card extension `payments: ["x402"]` advertises
  support; the claim flow (§4.4) gains an optional pay-per-claim step.
  Pilot candidate for Phase 4 (§8).
- **A2A (Agent2Agent)**: a different layer (HTTP task APIs and Agent
  Cards). Proposal: a **gateway mapping**, not a merger — A2A Agent Card
  fields ↔ Sealbridge AgentCard, A2A task ↔ Sealbridge manifest — so a Sealbridge worker can
  be reached from A2A clients through a bridge, with the audit receipt as
  the added value.
- **Escrow / stake**: the same hook serves anti-abuse stakes (§6.2) and
  job escrow; semantics (refund on REJECTED / timeout) are an open
  question for the payments phase, flagged here so the board design does
  not preclude it.

## 8. Product name: Sealbridge

**Formerly ACP / agent-collab-platform.** The owner selected Sealbridge
(issue #86) to avoid confusion with Zed’s Agent Client Protocol and
IBM / BeeAI’s Agent Communication Protocol. These are separate projects.

Use Sealbridge in product copy and the new `sealbridge` CLI entry point.
The `acp` command remains a deprecated alias with a one-line stderr notice.
Internal `@acp/*` package names, MCP tool identifiers, wire identifiers,
`acp-invite:` tokens, audit formats, data paths, repository and relay URLs
remain unchanged for compatibility.

## 9. Phased roadmap

| Phase | Scope | Depends on |
| :-- | :-- | :-- |
| UX-1 | Friends list, invite link/QR + one-tap re-issue, approve screen, receipt rendering (text/CLI first) | existing invite, `--allow-requester`, audit-verify |
| UX-2 | Job board (metadata-only), candidate rendering, "Go public" settings screen | connections admission and host budgets |
| UX-3 | Track-record aggregates, two-way ratings as signed receipts | UX-2 |
| UX-4 | Payments pilot (x402 for board micro-jobs), AP2 mandate reference, A2A gateway sketch | §7 decisions |

## 10. Open questions

1. Track record: is self-presented-but-verifiable enough for launch, or
   must the board countersign aggregates from day one?
2. Identity verification: which badge (domain vs. GitHub) first, if any?
3. Payments sequencing: x402 pilot before AP2 mandates, as proposed?
4. Naming: resolved by the owner’s Sealbridge decision (§8, issue #86).
5. Plain-language strings need a localisation process (en/ja maintained as
   paired documents, like this one) and accessibility review before any
   GUI phase.
6. Board operation: who runs the first board — the relay operator, or a
   separate service — and what quotas keep metadata-only posting from
   becoming spam?

---

*End of proposal. Discussion and review happen on the pull request that
carries this document.*

Host rate / ホストの頻度: `--max-requests-per-minute`.
