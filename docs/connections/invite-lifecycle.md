# Invite store lifecycle

[日本語](invite-lifecycle.ja.md)

`InviteStore` recovery is local to its signer and data root. Secret values are never
included in lifecycle results or errors. Existing file/keychain selection and
owner-only atomic metadata replacement apply. No relay deployment is needed.

## Retrying removal

`remove(workerRef)` deletes the referenced secret and checks its absence while
holding the store lock, before publishing metadata removal. A secret deletion or
readback failure returns `INVITE_SECRET_DELETE_FAILED` and leaves metadata unchanged.
Retry with the same alias or saved reference, including after reopening the store.
CLI `invites remove` and MCP `acp_remove_invite` use the same operation.

If the secret is already absent, removal continues. If metadata publication fails
or the process stops after secret deletion, metadata can still reference a missing
secret. `list()`/`resolve()` then report `INVITE_SECRET_MISSING`; `remove` reads
metadata independently and can finish the removal. Successful removal returns
`true`; subsequent removal returns `false`. Injected `SecretStore.delete` must accept
an already absent entry. Errors omit backend exception text.

This ordering retains references needed for retries. It does not enumerate or
recover secrets whose metadata was removed by earlier implementations, or strings
left by an interrupted import/migration before metadata publication.

## Pending imports for embedding hosts

Ordinary `import(link, alias?)` remains a durable save and writes the existing
version-1 shape. Hosts that need to discard abandoned confirmation flows opt in:

```ts
const store = await InviteStore.open(owner, { ...identityOptions, keyStore: 'keychain' });
const saved = store.import(link, alias, { pendingConfirmation: true });
// Show only saved metadata to the owner. Import grants no connection consent.
const pending = store.listUnconfirmed();
// On explicit save or before handing the invite to a connection/use flow:
store.retain(saved.workerRef);
// Separately run the existing owner-approved connection or delegation flow.
// After restart, explicitly reclaim abandoned pending imports:
const result = store.removeUnconfirmed({ olderThan: '2026-11-01T00:00:00.000Z' });
```

Only a newly created entry receives signed `importState: 'unconfirmed'`. `SavedInvite`
exposes this optional field without tokens. `importedAt` remains its original import
time. Pending reimport keeps existing provenance and never demotes a retained save.
A duplicate ordinary import is an explicit save and clears the marker.

`retain(workerRef)` clears the marker under the store lock and returns `SavedInvite`.
It is idempotent and returns `INVITE_NOT_FOUND` for an absent reference. It grants no
connection or task consent. `resolve` returns `INVITE_CONFIRMATION_REQUIRED` for
pending entries; retain before any use. This prevents cleanup from selecting an
invite already returned for use, without adding writes or fsync to resolution/send
paths. `connections confirm-invite` retains before resolving, even if the subsequent
owner prompt rejects the attempt or transport fails. Such entries stay retained
conservatively. Confirmation still requires the existing owner review.

`listUnconfirmed()` reads signed metadata without fetching secrets, including after
interrupted removal. `removeUnconfirmed({ olderThan })` accepts a parseable timestamp
no later than the injected/current clock; invalid/future values return
`INVITE_CLEANUP_INVALID_CUTOFF`. It deletes only marked entries whose `importedAt` is
strictly earlier than that timestamp, and returns `{ removed: number }`. Equal or
newer imports, retained/used entries, and legacy entries without the marker remain.
Expiration alone does not select an entry. Cleanup and retention share the existing
exclusive lock and publication path. Cleanup does not run automatically.

All selected secrets are deleted before one metadata replacement. On partial
failure metadata stays unchanged; some strings may already be absent. Use
`listUnconfirmed()` and retry cleanup or `remove` with the same references. Migration
to keychain preserves the pending marker. Existing version-1 files remain readable
and ordinary duplicate saves retain their bytes. Older readers with exact field
validation cannot read the opt-in marker until retention/removal clears it; use the
updated runtime for pending-import flows. No wire format, consent policy, CLI flag,
or MCP tool is added. Pending entries appear with the optional marker in existing
list results and cannot delegate through saved references until retained.
