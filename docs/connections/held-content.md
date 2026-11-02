# Held-content library boundary

[日本語](held-content.ja.md)

`@acp/runtime` exports `HeldRequestStore`, `HeldRequestReview`, and the injected
`HeldContentReviewProvider`. Runtime, CLI and board attach these interfaces to live admission. Inspection is unavailable by default; see [connections admission](admission.md).

The store retains original encrypted signed envelopes with owner-signed metadata
under `<dataRoot>/quarantine/<sha256-local-owner-DID>/<id>.json`; summaries omit
input, titles and descriptions. The default provider returns `unavailable`, so
content remains held. No inspection rules, detectors or subprocess are included.
`hold`, `inspect`, `showReviewedContent`, `discard`, and `expire` are library APIs.
Content display requires a completed receipt bound to the owner, kind, content,
envelope and report digests; it does not approve execution or connection consent.
Task digests use `digest({manifest,input})`; connection and reserved application
digests cover the entire decrypted body. Inspection timeout defaults to 5 seconds;
errors, timeout and unavailable results leave content held.

Hosts authorize owner review, validate sender-owner delegation and deadlines,
acknowledge only after `hold` succeeds, schedule `expire`, call `discardPeer` on
block, discard offers after decisions and tasks after result transmission. Reads
leave files intact. Retention is the earlier of the deadline and 24 hours. Bounds:
100 records, 256 KiB per envelope, 32 MiB of envelopes, plus 8 KiB metadata per
record; live records are not evicted. POSIX paths use 0700/0600; Windows inherits
the parent DACL without ACL verification. Supply `workspaceDir` when known to
reject storage within an adapter workspace. A real provider is a separate host
integration. Application transport and UI are deferred.
