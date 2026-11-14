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

Today, entry points still choose separate local worker and requester keys. CLI
`invite create` uses the worker key. MCP `acp_create_invite` uses the MCP server's
owner key (the requester key by default), including when its default display name
is `Sealbridge Worker`. Delegation to that invite routes to its owner DID; the
name does not redirect it to the separate default worker identity. A receiver
must run with that owner key and matching agent identity. MCP creation itself
starts no worker. Explicit MCP owners and workers sharing that owner can receive
these tasks; replacing the signer unconditionally would change those targets.
`invite open` return invites likewise use the importer/requester key and do not
start a receiver.

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

Owner/delegate key changes, bidirectional connection handling, accepter defaults,
warnings before sending to a peer that will not accept, further MCP listing
changes and Desktop support are separate staged changes. This preparation does
not enable them, change automatic acceptance, or bump the protocol version.
