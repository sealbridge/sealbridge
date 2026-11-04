# Separate-process collaboration

After `pnpm install --frozen-lockfile && pnpm build`, run:

```sh
node examples/network-collab/run.mjs
```

This starts a local relay, generates ephemeral owner keys in a fresh `/tmp`
directory, runs Bob's command adapter in a separate CLI process, and runs Alice's
Requester in another process using Bob's printed invite. The script expects a
completed result and independently signed audit bundles, but it does not configure
a task inspection provider. With the standalone CLI's default inspection,
normal limited tasks return terminal `PENDING_OWNER_APPROVAL` without a completed
result. Do not retry automatically.

Task completion requires an embedding app configured with a task inspection
provider and owner opening of a fresh task after connection consent. The
standalone CLI cannot inspect tasks; `requests show` and default `requests approve`
return `INSPECTION_INCOMPLETE` until inspection completes. Use `requests list` for
pending metadata and `connections review list` for signed connection offers.
A plain task creates only a pending task-derived item, not a reviewable offer.
On `CONNECTION_NOT_PENDING`, use a listed ID with the same role/key; if the list is
empty, use the invitation/connect flow (`connections confirm-invite`). Connection
review does not inspect or open tasks. Human confirmation requires an interactive
TTY; `--auto-accept` does not supply inspection or connection consent.

The example needs loopback socket binding. The conformance suite automatically
uses a fetch bridge when binding is denied with EPERM/EACCES; it can also be tested
explicitly with `ACP_TEST_FETCH_BRIDGE=1 pnpm exec vitest run
conformance/network-collab.test.ts`.

For manual three-terminal operation and real adapters, see the root README.
