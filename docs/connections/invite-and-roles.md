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
Missing pre-existing identities likewise fail before writes.

Connection records are **not moved or re-signed**: the legacy worker inbox stays
running alongside the owner inbox, using the original worker key and per-key
records. Thus old worker invitations, connection consent, and the Muse procedure
keep their target and acceptance rules. New owner connections use the owner's
existing per-key store; worker-side consent is not silently granted to the owner.
Use `connections ... --role requester` and `tasks ... --role requester` to inspect
owner-side records; existing `--role worker` selects the retained legacy store.
Explicit `--key FILE` keeps selecting that exact identity, bypassing migration.
Explicit audit/inbox paths for the legacy listener gain `.legacy`; owner paths
use the supplied names. A one-shot worker stops both listeners after one attempt.

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

The `invite open` reciprocal invite still advertises requester-as-agent. A migrated
gateway also accepts that owner-as-agent identity, preserving old MCP and return
invites. Opening an invite does not create a receiver or bilateral requesting.

The current Muse path remains: Muse creates an invite, Grok Bot accepts it locally
and delegates to the running Muse worker. Existing connection recording is on the
worker side. One invite does **not** yet enable requests in both directions.

`peerRef` is the role-neutral alias of `workerRef`, with exactly the same saved
reference value. MCP delegation and removal accept either spelling; if both are
supplied they must match. TypeScript `DelegateOptions` accepts either spelling
(applications still resolve the saved invite into `to`). CLI delegation accepts
`--peer-ref <peerRef>` alongside existing `--to <workerRef>` and `--invite`; combined
selectors must match. InviteStore methods and positional CLI references accept
the same reference value under either variable name. Resolution still uses the
saved invite store, including its expiry checks, rather than the connection list.

## Later work

Bidirectional connection handling, accepter defaults,
warnings before sending to a peer that will not accept, further MCP listing
changes and Desktop support are separate staged changes. This preparation does
not enable them, change automatic acceptance, or bump the protocol version.
