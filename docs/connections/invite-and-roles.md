# Invitations and local roles

[日本語](invite-and-roles.ja.md)

An invite is a way to create a connection between two parties; it does not assign
the worker/requester role. The signed invite payload has no role field. Importing
or previewing an invite alone grants neither connection consent nor task approval.

Whether a side accepts work depends on local configuration: a worker must be
running with the addressed identity, and `config auto-accept` controls which work
can open automatically. A local alias selects a peer; it does not start a worker
or grant permission. DIDs identify parties. Display names are informational and
can be duplicated. Aliases are chosen and stored locally, not assigned remotely.

## What ships today

Without migration, entry points retain the separate worker and requester keys.
CLI `invite create` signs with the worker key. MCP `acp_create_invite` signs with
the server owner (requester by default); receiving it requires a worker with that
owner identity. Explicit MCP owners and same-owner workers keep working.

After explicit `worker migrate --apply`, the existing requester key is the public
owner. A **new** delegate key identifies the execution agent. The owner signs the
invite and agent card; the delegate co-signs the existing agent-card delegation
statement. `worker start` runs a trusted owner gateway with that delegated agent.
MCP `acp_create_invite`, CLI `invite create`, and startup invites now advertise the
same owner/delegate pair. Invite creation alone still starts no receiver.

The gateway authenticates to the relay, decrypts owner-addressed input, and signs
session envelopes, approvals and bilateral audit entries with the owner key.
The execution adapter receives task context, not either private key. The separate
delegate key cannot sign as the owner, read the owner's relay inbox, or decrypt
owner-addressed envelopes. This is an execution identity under a trusted local
gateway, not permission for a delegate-only process to use the owner's inbox.
The gateway remains trusted with the owner key; this adds no OS sandbox boundary.
The hosted relay authenticates the inbox recipient DID and provides no alternate
DID inbox authorization. Keeping the owner gateway avoids a relay change/deploy
and requires no protocol bump or invite role field.

### Explicit migration and revocation

Stop old workers and other processes writing these stores before applying. Never
run old and new processes concurrently against the same writable connection,
held-task, delivery or audit store. With existing file-backed requester and worker
identities in the same data root:

```sh
sealbridge worker migrate --dry-run
sealbridge worker migrate --apply
sealbridge worker start # retain your usual adapter/approval/relay options
```

Omitting `--apply` is also a dry run. It reads and reports the plan without
creating files, directories, keys or network requests. Apply backs up the original
key bytes and source paths in `<data-root>/worker-delegation/backups/<uuid>/`
before creating the delegate. Original keys are never replaced or deleted.
The new key lives at `worker-delegation/<uuid>.private.json`; an owner-signed
`active.json` selects it only after backup and key writes complete. Activation is
atomic and exclusive. Repeating migration preserves keys and backup bytes.
An interrupted attempt may leave an unselected new key/backup; it cannot activate
a partial binding. A busy migration lock is never stolen automatically.
Keychain migration is not supported by this command; it fails before writes.
A missing worker identity fails before writes. A worker-key-only folder keeps working
without migration. To opt in, run `sealbridge worker migrate --create-owner` to
preview, then `sealbridge worker migrate --create-owner --apply`. This backs up
the original worker key before creating a separate requester owner key and a new
delegate. It never repurposes or replaces the worker key; old invites retain their
identity. Without this option, a missing requester key produces these exact commands.
If interrupted after owner creation, the new owner key is retained for a retry.

Connection records are **not moved or re-signed**: the legacy worker inbox stays
running alongside the owner inbox, using the original worker key and per-key
records. Thus old worker invitations, connection consent, and the Muse procedure
keep their target and acceptance rules. New owner connections use the owner's
existing per-key store; worker-side consent is not silently granted to the owner.
Use `connections ... --role requester` and `tasks ... --role requester` to inspect
owner-side records; existing `--role worker` selects the retained legacy store.
Explicit `--key FILE` keeps selecting that exact identity, bypassing migration.
Explicit legacy audit/inbox paths insert `.legacy` before `.jsonl`:
`audit.jsonl` becomes `audit.legacy.jsonl`, and `inbox.jsonl` becomes
`inbox.legacy.jsonl` (paths without `.jsonl` gain `.legacy.jsonl`). Owner paths
keep the supplied names. Separate files avoid sharing per-identity task journals
and audit chains. After opting into migration, configure notification watchers to
follow both `inbox.jsonl` and `inbox.legacy.jsonl`, or the glob `inbox*.jsonl`.
Unmigrated watchers need no change. `audit-verify` detects JSON/JSONL by content,
so it also verifies historical `audit.jsonl.legacy` files. A one-shot worker stops both listeners after one attempt.

```sh
sealbridge worker revoke-delegate --dry-run
sealbridge worker revoke-delegate --apply
```

Revocation backs up the activation before publishing an owner-signed local
revocation marker. Running CLI gateways check activation/revocation before
admitting work. Future default starts and invite creation fail closed; they do not
fall back to a legacy identity. Repeating revocation is safe. It does not delete
keys, revoke unrelated historical worker invites, or cancel already running work;
stop the worker to end that work. Revocation is local gateway authorization, not
a new wire-level revocation type.

To recover after revocation, stop the worker, then run:

```sh
sealbridge worker migrate              # dry-run recovery plan
sealbridge worker migrate --apply      # back up, then issue a fresh delegate
sealbridge worker start                # retain your usual options
```

Recovery backs up the original owner/worker keys, prior activation, delegate key
and revocation evidence before publishing a new owner-signed activation. Only
activation metadata is atomically replaced; keys and signed revocations remain.
Every recovery generates a fresh delegate. Revoked delegates remain rejected even
if an old activation is restored. A subsequent revoke/recover cycle retains earlier
revocations, including the original `revoked.json` format. Backup/write failure
leaves the revoked activation in place; no manual deletion or editing is needed.
Existing owner-addressed invites remain routable; invites advertising the revoked
delegate must be reissued to advertise the new execution identity.

The `invite open` reciprocal invite still advertises requester-as-agent. A migrated
gateway also accepts that owner-as-agent identity, preserving old MCP and return
invites. Opening an invite does not create a receiver or bilateral requesting.

## Two-way connections and local names

The Muse path remains unchanged: Muse creates an invite, Grok Bot imports it
locally and delegates to the running Muse worker. `accept` is still a local-only
import (apart from resolving an existing short link); it sends no connection
exchange and grants no connection consent or task approval.

Connection records are created during the existing signed connection exchange:

- `connections confirm-invite <peerRef-or-workerRef>` asks for separate local
  owner consent and saves an outgoing pending offer before sending it. The
  creator records a connected peer when its running receiver validates, inspects
  and redeems that invite offer. The importing side records connected when it
  receives and verifies the signed acceptance; the final ACK completes delivery.
  Keep a receiver or `connections sync --role requester --relay <URL>` running
  on the importing side to consume a late acceptance.
- The first delegate over an invite can carry the same offer after the existing
  separate connection-consent prompt. Its creator records the connection when
  the validated task redeems the invite, and the requester records the reverse
  connection when it consumes the signed connection acceptance. Declining that
  prompt, or running without a connection-review channel, still permits the old
  invite task path but does not invent requester-side connection consent.
  `--auto-approve` and `--auto-accept` do not answer the connection prompt.

The CLI inspects signed connection-request metadata separately from task content,
including in a headless worker. This lets an issuer redeem its own invitation and
send the signed acceptance. It neither completes task inspection nor grants task
execution; offers without a redeemable invite still require owner consent.

Once that exchange is accepted, both sides have their own connection record.
Either side can send work, including the original invite creator, if the other
side runs a worker for the addressed identity and accepts that work. Connection
consent does not start a worker or grant task execution permission. Task review,
auto-accept configuration and defaults are unchanged.

Records stay in the existing owner-signed **per-key connection store**, under the
DID that participated in the exchange. With separate unmigrated keys, a creator's
record belongs to its worker key, and the importer's record belongs to its
requester key. Default unmigrated `worker start` listens only on its worker key,
as before. To explicitly receive return work on an existing separate requester key,
start it with `--also-requester`. Automatic acceptance on that additional listener
is **off**: it inherits neither `--auto-accept` nor the folder's auto-accept config.
The owner can separately opt in with `--requester-auto-accept read-only|write`,
which accepts that work only from connected peers. No requester key is created.
`--also-requester` is incompatible with `--key` and migrated owner setups (the
migrated gateway already receives owner-addressed work). Explicit audit/inbox paths use
`*.requester.jsonl`; original worker paths remain unchanged. `--key FILE` selects
only that identity. Migrated owner/delegate setups use the owner store and retain
the legacy listener and `*.legacy.jsonl` paths. No records are copied, moved or
rewritten on read, and no migration is required.

```sh
sealbridge connections list
sealbridge connections list --role requester
sealbridge connections alias <peer-DID-or-current-alias> reviewer
sealbridge delegate --to reviewer --title "Review" --description "Review input" --input-file input.json
```

`connections list` includes the local alias, `peerOwnerDid`, `localOwnerDid` and
connection state for both existing local identities. Use `--role worker`,
`--role requester` or `--key FILE` to narrow the store. The historical top-level
`role` and `localOwnerDid` describe the selected/default identity (worker by default);
`scope: "all"` marks the aggregate listing, whose rows each identify their local owner.
Renaming is local only;
use the peer DID plus a role/key if a name is ambiguous. It sends no protocol
message and changes no peer DID or connection consent.

The default alias is derived from the retained peer display name: lowercase,
replace runs outside ASCII letters/digits with `-`, trim edge hyphens, and take
at most 64 characters; an empty result uses `peer`. Renames accept 1–64 lowercase
ASCII letters/digits, `_` or `-`, starting with a letter/digit. Identical display
names can produce identical defaults: they are **ambiguous**, never silently
numbered or picked. Display names and aliases are not identifiers; DIDs identify
peers. Explicit renames are owner-signed in a separate
`<data-root>/connection-aliases/<sha256-local-owner-DID>.json` sidecar. Keeping
aliases outside connection records lets older strict store readers continue to
share the original format.

Display names are peer-controlled. Confirm the intended peer DID before using a
derived alias, and rename it locally if helpful; ambiguity always fails closed.
If an alias-store lock survives a crash, the error identifies its exact path.
Check that no alias writer is alive before manually removing that lock; the CLI
does not delete a possibly active writer's lock automatically.

### `--to` resolution and compatibility

1. Invite links/tokens and literal `did:...` values keep their existing meaning.
   `saved:...` references always use the invite store with its expiry checks.
2. A plain `--to <name>` searches connection aliases across existing local
   requester/worker stores (or just `--key FILE`). A unique connected match selects
   the peer DID, its recorded relay/agent DID, and the local signing identity
   owning that connection. It works without publishing to the relay directory.
3. Only connected aliases participate in conflicts with saved invite aliases;
   pending/blocked aliases do not shadow a saved invitation. If the saved alias
   and connected aliases all identify the **same peer DID**, keep the original
   invite-store resolution, including expiry and confirmation checks. A connected
   alias identifying a **different peer DID** fails `CONNECTION_TARGET_CONFLICT`.
   Without a saved alias, multiple connected matches fail `CONNECTION_ALIAS_AMBIGUOUS`.
   Rename the connection or use an explicit DID / `saved:...` reference to disambiguate.
4. With no connection match, the existing invite-store alias/reference resolution
   runs unchanged. An unknown name fails with `INVITE_NOT_FOUND`; a pending or
   blocked connection alias fails with `CONNECTION_NOT_CONNECTED`.

`peerRef` remains the role-neutral spelling of `workerRef`, with the same saved
reference value. Existing MCP arguments and TypeScript options are unchanged.
`--peer-ref` and `--invite` explicitly retain invite-store resolution, including
expiry checks. Combined selectors must still contain exactly equal values;
unequal values fail before sending. `--to <workerRef>` remains supported.

## Later work

Accepter defaults (Q2), warnings before sending to a peer that will not accept
(Q3), `connections allow`, MCP connected-peer listing/name targeting (PR5),
Desktop and the Muse-first README guide remain separate changes. This PR changes
neither automatic acceptance defaults nor the protocol version or invite payload.
