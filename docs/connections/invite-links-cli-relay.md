# Short invitation links

[Invitations and local roles](invite-and-roles.md)


`sealbridge invite create` still prints an offline `acp-invite:` token by
default. To create a short link, use a relay with `inviteLinks: 1` capability:

```sh
sealbridge invite create --share link --qr none
```

The link is printed to stdout. Stderr contains its six-digit verification
number, `linkRef`, and expiry. Compare the verification number with the recipient
over a separate conversation. The default link lifetime is 24 hours; use
`--link-expires-in` for 300–259200 seconds. Unless explicitly overridden with
`--expires-in`, the inner token expires 24 hours after the link.

`--output file:/absolute/private/directory/invitation.txt` and POSIX `--output
fd:N` follow the worker invitation destination rules. Files must be new, and
their parent directories must already be private. `--png` and `--svg` write new
0600 QR files under the same directory rules. QR contents include the link key;
terminal QR output is limited to TTY stderr. Redirected stderr receives only
metadata and the terminal-only notice. Windows uses inherited ACLs; the CLI does
not inspect them. Descriptor output remains POSIX-only.

To import a link without placing it in a command argument, use:

```sh
sealbridge accept --paste --alias colleague
```

`--stdin` also accepts one link through a pipe or file. Both
`https://sealbridge.app/j#v=1&k=…` and `sealbridge://join#v=1&k=…` work. A
nondefault relay is encoded as the optional `r` host field. Only short links
contact the relay; the import result reports `relayContacted` and the
verification number. `--no-network` refuses short links before relay access or
identity creation, while existing long tokens and `/i#acp-invite:` links remain
offline. A short-link import is stored as unconfirmed and still requires the
existing owner connection confirmation. Importing grants no task approval.

The CLI checks relay capabilities and does not automatically fall back to a
long token. Its unsupported-relay message explains that an older relay and a
relay deliberately refusing the operation cannot be distinguished.

```sh
sealbridge invite links list
sealbridge invite links cancel LINK_REF
```

These commands use the same worker identity and data root as creation; supply
`--key` when creation used an explicit key file. The local signed index retains
only the ID, relay, invite digest, owner, and expiry. Cancellation writes a
signed local token revocation before requesting relay cancellation. Running CLI
workers using that identity and data root reread these revocations at admission.
Other hosts do not learn this local record automatically. Cancellation does not
disconnect an already established connection.

The relay stores ciphertext and a hash of the claim tag. Each link has one
winning claim nonce, with recovery for that same nonce for at most 120 seconds
and never beyond link expiry. The CLI retries an interrupted reply once with
that same nonce. Other claimants receive the same 404 response for absent,
expired, claimed, cancelled, locked, malformed, or wrong-tag requests. Three
wrong tags lock an unused link. Owner-authenticated status returns `unused`,
`claimed` with its time, `expired`, `cancelled`, or `locked_out`, without a
claimant IP.

Hosted state uses `InviteDurableObject`: one object per ID, one admission
coordinator per owner DID, and one rolling-limit coordinator per hashed IP.
Owner limits are 20 unused links and 50 creations per rolling day. Claim IP
limits are 10 per minute, 60 per hour, and 10 failures per hour. Counters survive
object restarts and do not rely on isolate-local maps. An optional
`RATE_LIMITER` can refuse additional requests. Alarms remove ciphertext on
expiry, cancellation, lockout, or the end of claim recovery. The local relay
uses the same state machine with in-memory storage and timers; process restart
does not retain its links.

The `/j` page provides click-only app, copy, and sharing actions. It treats the
fragment as opaque text, does not claim a link, and retains `connect-src 'none'`
and `Referrer-Policy: no-referrer`. The existing `/i` page remains available.

Hosted relay and site updates are separate operator actions. The example
Wrangler configuration includes the new binding and migration, but this change
does not deploy them. Manifest versions, invite token signatures and contents,
and connection request formats remain unchanged. Pairing codes, Desktop work,
and Desktop owner notifications are outside this batch.
