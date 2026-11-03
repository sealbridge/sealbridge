# Official site and private invite receiver

**English** | [日本語](sites.ja.md)

`sites/` builds two independent Cloudflare Workers asset bundles. The official
site also includes a small Worker for `/media/*` byte ranges. Nothing is deployed
by a build or CI. There is no analytics, external font, CDN script, or remote QR service.

| Intended host | Assets | Configuration |
| --- | --- | --- |
| sealbridge.dev | `sites/dist/site` | `sites/wrangler.site.jsonc` (`sealbridge-site`) |
| sealbridge.app | `sites/dist/invite` | `sites/wrangler.invite.jsonc` (`sealbridge-invite`) |

The English and Japanese landing pages include a 30-second code-review demo
with no audio below the hero, with English captions in the frames and a text transcript.
The audio tracks were removed by stream copy, leaving the video unchanged.
The build copies the video-only WebM and MP4 and unchanged poster from `docs/media/` to the
official site's `/media/` directory. Playback controls remain available, and a
local script pauses playback and disables autoplay when reduced motion is requested.
Production and preview serve media MIME types and byte ranges for playback and seeking.

`sites/connect-agent.txt` is copied unchanged to `/connect-agent.txt` and served
as `text/plain; charset=utf-8` by the headers file. Landing/install pages link
to it. It describes local setup, host reload, human-run invite import and open
worker discovery, distinguishing local state from relay traffic. These commands
and tools are available from sealbridge 0.3.0 (CLI 0.3.0 and later). No site runtime or
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

The three-OS CI matrix runs the site build, Node unit tests, browser tests and existing
conformance suite. `pnpm --filter @sealbridge/sites test:unit` runs the production
Worker tests independently, including range bodies, GET/HEAD parity, ETag handling,
and equality with every header in the `_headers` global policy.
Browser tests use synthetic, ephemeral identities: valid, tampered and expired
invites, delegated agents, fragment changes, malicious display text, QR capacity,
network/console/storage privacy, copy behavior and deployment headers.

## Deployment handoff (requires separate authorization)

After review, an authorized operator can use Cloudflare Wrangler to upload the
official site's Worker and assets, or the invitation receiver's static assets, with the respective
`--config sites/wrangler.site.jsonc` or `--config sites/wrangler.invite.jsonc`.
The official site config uses `main: "./site-worker.mjs"`, an `ASSETS` binding,
and `run_worker_first: ["/media/*"]`. Other routes remain asset-first; the
invitation receiver remains assets-only. The output stays in `sites/dist/site`;
Worker source modules live outside it and are not uploaded as public assets.

For existing `/media/*` assets, GET supports one `bytes=a-b`, `bytes=a-`, or
`bytes=-N` range with `206`, `Content-Range: bytes a-b/size`, and the selected
`Content-Length`. Ends beyond the asset are clamped; oversized suffixes select
the whole asset with `206`. A start at or beyond the size or a zero suffix gets
an empty `416` with `Content-Range: bytes */size` and `Content-Length: 0`.
No Range, malformed fields (including reversed bounds), and multi-range fields
use full `200` responses. All these responses advertise `Accept-Ranges: bytes`.
HEAD follows the same status and headers without a body. If-Range enables a
range only for an exact matching strong ETag; weak tags, dates and mismatches
use full `200`. Other conditional requests and asset errors retain their status.

The Worker fetches the full asset through `env.ASSETS`, removing Range and
If-Range and requesting identity encoding. It buffers range requests to slice
the current roughly 3 MB video files; ordinary full GET responses stream.
Full HEAD responses retain the asset's Content-Length, or measure its body when
that header is absent, then return no body.
Content-Type, ETag and other asset headers are retained. Cloudflare does not
automatically apply `_headers` to Worker-generated responses, so the Worker
explicitly attaches the equivalent CSP, Referrer-Policy, X-Content-Type-Options,
X-Frame-Options and Permissions-Policy, including on errors. Keep its policy
in sync with `sites/_headers`; unit tests check equality.

To verify the production path locally after the site build, use Wrangler 4.156.1
(verified with the configured `2026-10-29` compatibility date). Wrangler 4.151.1's
bundled workerd rejects this date locally.

```sh
cd sites
wrangler dev --config wrangler.site.jsonc --local --port 8787
```

From another terminal, check GET and HEAD against
`http://127.0.0.1:8787/media/sealbridge-demo.mp4`, including `Range: bytes=0-1`,
`bytes=-100` and `bytes=99999999-`. This uses the configured `2026-10-29`
compatibility date. Changes take effect in production only after a separately
approved site deploy.

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
