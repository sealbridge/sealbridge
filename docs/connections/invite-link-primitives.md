# Invite-link primitives and verification numbers

SI1 batch 1 adds local Node crypto helpers in `@acp/core` and `sealbridge/sdk`.
It adds no relay endpoints, network calls, CLI commands, or approval behavior.
Existing invite tokens, `ConnectionRequest`, `TaskManifest`, protocol versions,
peer floors, and release clocks retain their current formats and values.

## Key and byte conventions

`generateInviteLinkKey()` returns `k`, the unpadded base64url encoding of a
32-byte random key K (43 characters). `deriveInviteLinkKeys(k)` uses HKDF-SHA256
with K as input key material, an empty salt, and these exact UTF-8 info labels:

| Output | Bytes | Info |
| --- | ---: | --- |
| id | 16 | `sealbridge/invite-link/v1/id` |
| encKey | 32 | `sealbridge/invite-link/v1/enc-key` |
| accessKey | 32 | `sealbridge/invite-link/v1/access-key` |

`inviteLinkClaimTag(accessKey, id)` computes
`HMAC-SHA256(accessKey, UTF8("claim") || rawId)` (32 bytes). For later relay
creation requests, hash those tag bytes with SHA-256; send the hash, never K,
the plaintext token, or the claim tag. A later claim request supplies the tag.
These helpers do not perform either request.

`padInviteLinkToken(token)` encodes a four-byte unsigned big-endian UTF-8 byte
length, the token bytes, then zero bytes to the smallest multiple of 4096 bytes.
The padded result is at most 16384 bytes, leaving at most 16380 bytes for the
token. Empty tokens and lossy UTF-8 conversion are rejected. Unpadding checks the
length, the minimal block size, UTF-8 round trip, and every padding byte.
This framing wraps the existing token string; it does not modify that token.

`encryptInviteLink(token, k, { relayOrigin, expiresAt, now? })` uses AES-256-GCM,
a fresh random 12-byte nonce, and a 16-byte authentication tag. Ciphertext stores
the encrypted padded bytes followed by the authentication tag. AAD is exactly:

```text
UTF8("sealbridge/invite-link/v1") || rawId || UTF8(relayOrigin) || UTF8(expiresAt)
```

There are no separators or terminating NULs. `rawId` is 16 bytes. The origin is
canonicalized with `normalizeRelayOrigin`: lowercase URL origin, no path or
trailing slash, omitted default port, `ws`/`wss` mapped to `http`/`https`.
`expiresAt` must already be the canonical UTC `Date.toISOString()` representation
with milliseconds, such as `2030-01-02T00:00:00.000Z`. Offset times, missing
milliseconds, and normalized invalid calendar dates are rejected.

`inviteLinkExpiry(now?, ttlMs?)` returns `expiresAt` and `tokenExpiresAt` from one
clock snapshot. The default TTL is 24 hours, the maximum is 72 hours, and the
inner token deadline is the link deadline plus 24 hours. Encryption checks a
future deadline within 72 hours. Decryption checks the deadline locally with
the existing 60-second clock allowance; a deadline 60 seconds past is rejected.
`now` arguments are Unix milliseconds and allow deterministic local tests.

`packInviteLinkCiphertext` / `unpackInviteLinkCiphertext` convert between bytes
and the strict JSON-compatible relay storage shape:

```text
{ id: base64url, ciphertext: base64url, nonce: base64url, expiresAt: ISO-UTC }
```

All base64url encodings are canonical and unpadded. Unknown storage fields,
incorrect byte lengths, and ciphertext outside the four permitted block sizes
(plus its 16-byte tag) are rejected. Authentication failures return
`INVITE_LINK_DECRYPTION_FAILED`.

The encryption/decryption helpers treat the token as opaque text. After
decryption, the caller must use `parseAndVerifyInviteToken`, check the token and
card deadlines against its own clock, and compare the verified token's relay
origin with the storage relay origin before importing it. Link decryption grants
no connection consent or task approval. No helper sends data to a relay.

## Fragment parsing

`parseInviteLink(uri, policy?)` accepts only:

```text
https://sealbridge.app/j#v=1&k=<43-character-key>
sealbridge://join#v=1&k=<43-character-key>
```

An optional `r=<host[:port]>` selects an HTTPS relay; bracketed IPv6 hosts and
percent-encoded host punctuation are accepted. Without `r`, the relay is
`https://relay.sealbridge.dev`. Parameters may appear in any order, once each.
Parsing returns `{ v: 1, k, relayOrigin }` and never fetches the link.

The parser rejects extra/duplicate fields, queries (including empty queries),
userinfo, other hosts/paths/schemes, URL normalization aliases, invalid key
encodings, whitespace, empty values, and links longer than 2048 characters.
`r` accepts no scheme, credentials, path, query, fragment, or encoded delimiter
that would introduce one. Endpoint validation uses `validateRelayEndpointUrl`;
private relays require `allowPrivateRelay: true`, and metadata destinations stay
blocked. Optional `allowedRelayUrls` follows the existing origin-plus-path relay
allow-list comparison; an empty list denies all relays. Because `r` identifies
an origin, an allow-list entry with a nonempty path does not match it. Parsing
performs no DNS resolution; callers retain their existing checks when dialing.

## Six-digit verification number

`inviteLinkVerificationNumber(inviteDigest)` accepts the existing canonical
`sha256:<64 lowercase hex digits>` digest of the verified `Invite` object,
as used by `InviteStore` and `ConnectionRequest`. It is neither a hash of token
text nor decoded digest bytes. Compute:

```text
h = SHA256(UTF8("sealbridge/sas/v1") || UTF8(inviteDigest))
n = uint32_big_endian(h[0..4]) mod 1000000
```

The result is exactly six decimal digits, retaining leading zeros. A later UI
may display it as three digits, a space, and three digits. Both sides use the
same inner Invite digest. Different invites can produce the same number; the
number depends only on inviter-controlled data. It supports comparison by
phone or in person and does not itself approve a connection. No CLI/UI output
or CPace derivation is included here.

## Relay authentication and later integration

`RelayAuthAction` additionally accepts `invite-manage`. Origin binding,
signatures, timestamps, nonces, and the existing `receive`, `stream`, and
`subscribe` checks retain their behavior. An `invite-manage` token cannot stand
in for an inbox action. There are no `/v1/invites` handlers in this batch.

The later relay design stores ciphertext, id, tag hash, expiry and owner routing
metadata. It must not receive K, plaintext, or the verification number. Claim
consumption, retries, admission limits, status, cancellation and cleanup belong
to the relay batch. The primitives implement no retention or one-use state.

Fixed vectors in `conformance/invite-link.test.ts` were calculated independently
with Python `hmac`/`hashlib` and `cryptography` AESGCM. They pin HKDF labels, empty
salt, claim concatenation, padding, AAD, ciphertext and GCM tag. Verification
number vectors separately pin digest encoding and byte order.
