# Official site and private invite receiver

**English** | [日本語](sites.ja.md)

`sites/` builds two independent, static Cloudflare Workers asset bundles.
Nothing is deployed by a build or CI. There is no server application, analytics,
external font, CDN script, or remote QR service.

| Intended host | Assets | Configuration |
| --- | --- | --- |
| sealbridge.dev | `sites/dist/site` | `sites/wrangler.site.jsonc` (`sealbridge-site`) |
| sealbridge.app | `sites/dist/invite` | `sites/wrangler.invite.jsonc` (`sealbridge-invite`) |

`sites/connect-agent.txt` is copied unchanged to `/connect-agent.txt` and served
as `text/plain; charset=utf-8` by the headers file. Landing/install pages link
to it. It describes local setup, host reload, human-run invite import and open
worker discovery, distinguishing local state from relay traffic. Commands and
tools delivered separately require a release exposing them. No site runtime or
deployment is added by this route.

## Build and preview

Use Node.js 22 and pnpm 10 from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @sealbridge/sites preview
```

Preview serves the official site at `http://127.0.0.1:4173` and the invitation
receiver at `http://127.0.0.1:4174/i`. Stop it with Ctrl-C. It does not log
requests. Preview applies the same `_headers` security policy as the asset
bundles, but is not a Cloudflare routing emulator.

`pnpm --filter @sealbridge/sites build` rebuilds only the sites. Landing copy is
in `sites/build.mjs`; all documentation is generated from the root README,
UX_LAYER, SECURITY and SECURITY_PROOF files (including Japanese counterparts)
and every Markdown file under `docs/`. Edit those originals, never generated
HTML. Relative Markdown links are rewritten to generated pages; source-code
links point to GitHub. HTML is sanitized and external document images are
omitted. The language switcher opens the matching translation when one exists;
untranslated documents retain their source language and are labeled explicitly.

## Invite verification and privacy

The canonical link is `https://sealbridge.app/i#acp-invite:…`. Only `location.hash`
is parsed; query parameters are never accepted as tokens. Fragments are not sent
in HTTP requests. Never put an invitation in a query or path: a server receives
those before client code can intervene. The copy button and local QR encode the
same canonical link, without shortening. Oversized invitations show a QR capacity
message; the full link remains available. Only intended recipients should receive
these bearer invitations. Do not log or persist their contents in diagnostics.

The browser bundle imports the existing `parseAndVerifyInviteToken` from core.
An esbuild-only `node:crypto` adapter uses locally bundled Noble Ed25519
(strict RFC 8032 verification) and SHA-256. A small Buffer adapter supports
base64url. Core's RFC 8785 canonicalization, digest and metadata checks, DID
decoding, signed agent card/delegation verification, relay restrictions and expiry
rules are reused unchanged. Private-key and encryption operations throw if
called; the browser can only verify. No protocol or wire format is changed.

The page never fetches a relay or sends a token, writes storage, or logs input.
`connect-src 'none'` provides an additional browser enforcement boundary.
All scripts/styles are local files; no inline script is allowed. `_headers`
sets `default-src 'self'`, `frame-ancestors 'none'`, `form-action 'none'`,
`base-uri 'none'`, `Referrer-Policy: no-referrer` and other defensive headers.
Do not add Cloudflare Web Analytics, browser insights, script injection,
third-party fonts, or other fragment-reading integrations on either host.

Verification proves possession of signing keys, not a real-world identity.
The offline page cannot check revocation or current availability. Those checks
belong to the connection workflow. No contact is saved or job approved in the
browser. After signature verification, the page guides the requester through the
one-line installer, creating a requester key once, and saving a local `code.diff`.
Its `sealbridge delegate --to "https://sealbridge.app/i#..." --input-file code.diff`
example targets the verified reviewer directly. The CLI rechecks the invite and
sends the diff encrypted through the relay. The reviewer approves the request;
the requester reads the result before final approval. Opening the page sends no
task and grants no approval.

## Tests

```sh
pnpm --filter @sealbridge/sites exec playwright install chromium
pnpm --filter @sealbridge/sites test
```

The three-OS CI matrix runs the site build, browser tests and existing conformance
suite. Tests use synthetic, ephemeral identities: valid, tampered and expired
invites, delegated agents, fragment changes, malicious display text, QR capacity,
network/console/storage privacy, copy behavior and deployment headers.

## Deployment handoff (requires separate authorization)

This change contains configuration only. After review, an authorized operator
can use Cloudflare Wrangler to upload the static assets with the respective
`--config sites/wrangler.site.jsonc` or `--config sites/wrangler.invite.jsonc`.
Attach sealbridge.dev to `sealbridge-site` and sealbridge.app to
`sealbridge-invite` in the existing Cloudflare account in a separately approved
operation. The files intentionally contain no routes, account credentials or
DNS edits. Workers development and preview URLs are disabled. Check `/`, `/ja/`,
a generated document, `/i` and a synthetic invitation on the real hosts before
announcing availability. Verify the response CSP and referrer policy, and ensure
no account-level script injection has been enabled. See Cloudflare's
[static asset headers](https://developers.cloudflare.com/workers/static-assets/headers/)
and [routing configuration](https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/).

## Relay compatibility

Recommend `https://relay.sealbridge.dev` for new configuration. The existing
`https://acp-relay.agent-collab.workers.dev` remains available on the same relay
and data. Keep existing signed invitations unchanged and allow their original
relay host. MCP relay allowlists must explicitly allow the chosen host; matching
data does not make the two origins interchangeable for origin-bound auth.
