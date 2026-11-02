# Invite sharing and the connections job board

**English** | [日本語](./ux2.ja.md)

Sealbridge UX-2 adds local invite QR/link tools,
a metadata-only board, public-worker settings, and a persistent daily admission
cap. Payments and ratings are outside this release.

## Invite sharing

Save an invite created by `sealbridge invite create` to a private local file, then:

```text
sealbridge invite share --file invite.txt --host https://sealbridge.app/i --png invite.png --svg invite.svg
sealbridge invite open --file received-link.txt
sealbridge invite open --file received-link.txt --save-contact "My friend" --key recipient.private.json
```

The link places the complete token in the URL fragment, never in its query.
No HTTP request or third-party QR service is used by these commands. The host
URL is operator supplied. `sites/` includes the static sealbridge.app receiver
(deployment is a separate operation). It bundles the existing verifier, checks
signatures, expiry and identity binding locally, and never transmits or logs
the fragment or loads third-party scripts. Save the complete scanned link to a
file and use `invite open --file` to verify it again locally.

Opening verifies both signatures, owner/agent DID binding, relay policy and
both expiries. It displays the verified identity, relay and effective expiry.
The display uses local time and relative wording; `expiresAt` retains the ISO
timestamp for machine output. After verification, opening creates an identity
only if absent (`owner.private.json` in the platform data directory, or `--key`).
Existing keys are reused; corrupt or mismatched identities fail closed.
The inviter is saved as a contact without automatic approval. A 24-hour,
reciprocal invite is saved beside the key; `--out` selects another
unused path. Output reports `local.keyFile` and `local.reciprocalInviteFile`,
never the private key or reciprocal token. Share that file back through your
trusted channel and start a sandbox worker with the reported key and relay to
receive JSON jobs (`worker start --key ... --relay ... --adapter sandbox`).
The reciprocal card advertises the built-in `json-task` skill.
Opening does not send messages, start workers, copy remote capabilities or
publish a profile.
Saving a contact does not allowlist it or approve any task. Automatic approval
options are rejected. QR images and links contain invitation material; share
them only with intended recipients.

```text
sealbridge invite request-reissue --file expired-link.txt --key recipient.private.json --out request.json
sealbridge invite reissue --file old-invite.txt --key issuer.private.json --request request.json --out fresh-invite.txt
```

Send the signed request file to the issuer through an existing trusted channel.
The issuer must explicitly answer the confirmation prompt; `--yes` is not
supported. Requests expire after 24 hours. Re-issue verifies the old token at
its original issue time, requires the issuer key, and re-signs a fresh card and
24-hour invite. An issuer may omit `--request` to initiate re-issue locally.
For separate owner/agent keys, add `--agent-key agent.private.json`. The owner
signs the new card and invite; the matching agent key renews its delegation
bound to the new expiry. Missing or mismatched keys are rejected.
Old tokens retain their original expiry/revocation. Re-issue never extends them.

### QR capacity

The local encoder uses byte mode as needed, error correction L and a four-module
quiet zone. A real signed self-owned card with the public Sealbridge relay, a JSON
skill and a published profile produced a 1,986-byte token and 2,013-byte link;
the longer name `Grok Bot Direct (Chief of Staff)` produced a 2,048-byte link.
Both rendered at version 33 (149 × 149 modules, excluding quiet zone).
Signatures are generated during evaluation; these are measurements, not a
promise that every card fits. Extra skills, descriptions, longer host URLs and
agent delegation signatures increase size.

The encoder's maximum byte payload at version 40 / L is 2,953 bytes.
Actual mixed-mode capacity is determined by the encoder. Oversized payloads
raise `QR_CAPACITY_EXCEEDED`; no truncated QR or remotely shortened link is
created. `share` prints the full link before reporting overflow, so it can
still be copied. Dense codes may be difficult to scan in a terminal. Use the
SVG at a large size or share the full link; terminal rendering is supplementary.

## Metadata-only board and publication settings

Candidates verify signatures, expiry, skill and relay, then display the poster's
local relationship and reasons. Claims and dispatch require connected peers;
otherwise they return `CONNECTION_REQUIRED`. Connection consent does not approve a
claim, task or lease. Serve uses the poster's actual requester DID, persistent
intake and held-content review. Dispatch checks connection and protocol before
consuming the lease, and consumes before transmission. Ambiguous transmission does
not cause automatic retry. One-time tickets and a separate application queue are deferred.

```text
sealbridge board candidates --post post.json --key poster.private.json
sealbridge board serve --post post.json --state lease.json --audit claim-audit.jsonl
sealbridge board dispatch --post post.json --state lease.json --input-file input.json --audit task-audit.jsonl --out result.json
sealbridge worker public --settings settings.json --preview
```

Publication settings retain `public`, task types, general per-task budgets, host
rate/daily settings and `alwaysAsk`. `public:true` maps only to `--publish`; types
use `--allow-task-type`, budgets use the general `--max-*` flags, rate uses
`--max-requests-per-minute`, and daily count uses `--max-tasks-per-day`.
`alwaysAsk:false` returns `CONNECTION_OPENING_REQUIRED`; connected tasks always
need inspection and owner opening. Retired `--open*` flags return
`ACCESS_MODE_REMOVED`. Preview reports general host budgets and inspection
availability without publishing or emitting retired fields. See
[owner workflows](connections/admission.md) for invite confirmation and migration.

## Persistent daily cap

`worker start --max-tasks-per-day N` also works without the settings wrapper.
The counter is `daily-tasks.json` in the platform data directory (the same
default directory used for contacts, overridable with `ACP_DATA_DIR`). It is
shared across requester DIDs, worker keys and processes using that directory;
changing `--contacts` does not relocate it. All cooperating processes must use
the same configured cap and data directory. Configure the flag on every worker
that must participate; it is opt-in, not a machine-wide OS security boundary.

A day resets at **00:00 UTC**, independent of local timezone. A task consumes
one slot after valid owner approval and before inbox write, ACCEPT transmission
or execution. A subsequent crash/failure does not refund it. Failed validation
or rejected owner approval does not consume a slot. Duplicate task IDs,
clock rollback, invalid state and lock contention fail closed. Exclusive locks
and atomic replacement prevent lost updates across restarts and processes.
An interrupted lock requires operator recovery after confirming the owner
process has stopped. Owners with filesystem/configuration access can delete
state, change clocks, change directories or disable the limit. The counter is
scoped to the configured host data directory, independently of remote DIDs.
