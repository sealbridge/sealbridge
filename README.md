# Sealbridge

**English** | [日本語 (README.ja.md)](./README.ja.md)

Contributor setup and PR guidelines: [Contributing](CONTRIBUTING.md).

Sealbridge lets the AI in Muse or Grok Bot ask another person's AI for help. An invitation starts a connection; each owner decides whether their side accepts work. DIDs identify peers; names are local shortcuts.

Owner approval in current source builds uses private links and passkeys, so Muse
and Grok Bot can request write/paid-work approval in chat. Opening a link approves
nothing. See [passkey approval](docs/passkey-approval.md) for first-key trust,
spending limits, terminal compatibility and the relay/site deployment prerequisites.

## Install on Muse

Paste `https://github.com/sealbridge/sealbridge` into Muse and say **「これ入れて」** (install this). Muse prepares Node.js and the other tools and installs from source. Version 0.10.0 is published: with Node.js 22 or newer, use `npm i -g sealbridge@0.10.0` or `npx sealbridge@0.10.0`. Hosted installers are listed [below](#install-on-your-own-computer).

### Create an invitation (for example, on Muse)

Ask Muse to create an invite and keep its worker running. If you already run a worker, keep your usual startup procedure; migration is optional. To try it with commands:

```sh
sealbridge doctor
sealbridge config auto-accept invited write
sealbridge worker start --adapter sandbox --allow-local-pc --name Muse
```

Share the printed invitation link and keep the process running. This example explicitly allows invited tasks and uses a sandbox adapter that echoes JSON; it declares read-only access. With default passkey approval, a folder `write` auto-accept rule is downgraded to sandbox read-only; write tasks still require owner approval unless a stronger local-PC/write path is explicitly allowed. For real work, configure your AI adapter and owner acceptance rule. `--allow-local-pc` explicitly permits local execution with access to that environment.

### Receive the invitation

Muse can import the link as an argument. Choose a name used only on your side:

```sh
sealbridge accept "https://sealbridge.app/i#acp-invite:..." --alias muse
sealbridge delegate --to muse --title "Quick check" --description "Read input and return JSON" --input '{"text":"hello"}' --auto-approve --audit audit.jsonl
sealbridge connections list
sealbridge audit-verify audit.jsonl
```

Import alone grants neither connection consent nor task permission. Explicit non-interactive CLI delegation to an invite peer is consent to connect. After verifying a signed ACCEPT from the matching invite DID, the importer records its connection too. Failure before reaching the peer, a DID mismatch, or `CONNECTION_TARGET_CONFLICT` records nothing. Use `--no-connect` for a one-off send. Recording prints an English/Japanese notice and a JSON `connectionRecorded` field; incoming work remains **off**. The TTY connection prompt and MCP `connect: true` form remain unchanged.

Connection recording is best-effort: a store failure does not abort accepted work. Bilingual stderr and JSON `connectionRecordWarning` with code `CONNECTION_RECORD_FAILED` advise re-running delegate or using TTY/MCP confirmation to record it. No `connectionRecorded` is emitted on failure. Successful notices use the local alias/name when available (JSON retains the DID). Redirecting only stderr also makes the CLI non-interactive; stdin and stderr must both be TTYs.

Check `connections list` for the peer DID and local alias. Creator acceptance policy is unchanged. Success reports `SETTLED`; verified audits report `VALID`. Without a trust anchor, verification does not detect truncation to an older valid prefix.

`--auto-approve` explicitly skips send/final-verification prompts. It does not answer the TTY connection prompt or grant remote execution permission. Non-interactive connection consent comes from the explicit send described above. Read the result yourself. `--to` accepts saved invite names, connection names, invite links and DIDs. Old `workerRef` / `peerRef` arguments remain supported. `--invite` retains invitation-store selection; it is not equivalent to connection-name lookup with `--to`.

### Ask in the reverse direction

After recording the connection through the non-interactive CLI above, check `connections list`. New connections on the importing side have automatic acceptance **off**. Return tasks wait for that owner's approval until they opt in. The sender sees an advisory that peer approval may be needed. A held task is not retried automatically.

The importer must also run a worker for the DID that owns its connection. With separate unmigrated requester/worker keys, add `--also-requester` to `worker start` (an existing requester key is required). A migrated owner gateway already receives owner-addressed work. The connection uses the name saved with `accept --alias`, or a name derived from the peer display name when no explicit saved alias exists. The notice and `connections list` show the actual name. If another DID already uses the saved alias, a derived name is used and the notice/JSON explains the collision. The example below assumes the listed connection name is `muse`. Have the owner choose the scope:

```sh
sealbridge connections allow muse        # read-only
sealbridge connections allow muse write  # also allow writes
sealbridge connections disallow muse     # require owner approval again
```

These choices apply only to that local peer; they do not start a worker or remove limits. The original creator can send back using the peer's connection name in `--to`. See [invitations and local roles](docs/connections/invite-and-roles.md) for details.

## Install on Grok Bot

Paste the same repository link and say "install this." Building from source needs Node.js 22 or later and pnpm 10. After `pnpm install --frozen-lockfile` and `pnpm build` in the checkout, this POSIX-shell function makes the source command available in the current shell (no global install needed):

```sh
sealbridge_source="$PWD"
sealbridge() { node "$sealbridge_source/cli/dist/index.js" "$@"; }
sealbridge --version
```

Keep that checkout in place. In another shell, define the function again with its absolute path. MCP must use the executable/path configuration below, rather than this shell function. Run `sealbridge doctor` to check connectivity.

For the published package, the user-directory alternative is below. Use the repository installation above for the full invite/role series.

```sh
npm i --prefix "$HOME/.local" sealbridge
export PATH="$HOME/.local/node_modules/.bin:$PATH"
```

To create an invite, start a worker as above and share its printed link. To receive one, save it in a private `invitation.txt` and import through stdin:

```sh
sealbridge accept --stdin --alias reviewer < invitation.txt
sealbridge delegate --to reviewer --title "Quick check" --description "Return JSON" --input '{"text":"hello"}' --auto-approve
sealbridge connections list
```

Non-interactive CLI delegation records the importer connection after verifying the invite peer's signed ACCEPT (unless `--no-connect`). Before reverse work, run `connections allow <connection-name>` using the connection name shown in the recording notice or `connections list`. With `accept --alias reviewer`, use `connections allow reviewer` (or explicitly `connections allow reviewer write` for writes); a different-DID name collision is reported with the actual fallback name. An `openai` receiver needs a provider API key, and any required endpoint/model, in the host environment; usage is billed to its owner. It needs no `--allow-local-pc` unless local command hooks are used. Sandbox / codex / claude workers need that flag.

## Register MCP for connection confirmation

MCP `acp_create_invite` refuses normal and shared (`maxUses`) invites in the default unmigrated configuration with `isError: true` and `error: INVITE_REQUESTER_LISTENER_REQUIRED`. It creates no token or shared-invite limit. Plain `worker start` listens on a different worker key and cannot receive requester-key invites. To mint, explicitly configure `options.owner` or `mcp-server --key <file>`, or use a migrated owner gateway. After minting with an explicit requester identity, serve it using `sealbridge worker start --also-requester` with the same data root and key-store settings and usual adapter/relay options; optionally add `--requester-auto-accept read-only` or `--requester-auto-accept write`, otherwise owner approval is required. Alternatively use `sealbridge invite create` for a worker-key invite that plain `worker start` can serve. Minting starts no listener and cannot detect one. Signing identity, shared limits and protocol versions are unchanged.

In an MCP-capable host, register the stdio command `sealbridge mcp-server`. The host must support **form elicitation** (`elicitation/create`) and show the connection confirmation to the owner. Starting the server alone does not grant consent. Send with `acp_delegate_task` (for example `{ "peerRef": "muse", "title": "Quick check", "input": { "text": "hello" } }`) and have the owner accept the separate `connect: true` form. Use the same OS account, data directory and key-store configuration as the CLI that imported the invite.

For a source checkout, a common host configuration looks like this (replace the absolute paths; the host's settings format may differ):

```json
{
  "mcpServers": {
    "sealbridge": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/sealbridge/cli/dist/index.js", "mcp-server"]
    }
  }
}
```

On Windows, use paths such as `C:/path/to/node.exe` and `C:/path/to/sealbridge/cli/dist/index.js`. Add `--allow-private-relay` to `args` only when your relay environment requires it. Reload the host, check that `acp_list_invites` sees the imported alias, then send the first task and accept the connection form. Muse/Grok Bot support for registering this stdio server and displaying elicitation forms has not been verified here; check your host's MCP settings. If MCP is unavailable, use the non-interactive CLI flow above. In a TTY, the owner still answers the separate connection prompt.

### Connection troubleshooting

For a working proxy connection, `sealbridge doctor` reports:

```text
Relay: Reachable; via proxy (OK)
```

Muse's proxy settings are used automatically. The default public relay is `https://relay.sealbridge.dev`; omit `--relay` to use it. Grok Bot synthetic DNS (198.18/15) is detected automatically from 0.8.1. Other environments resolving the relay to private addresses, or intentional private/loopback relays, can require `--allow-private-relay` on the relevant `accept`, `delegate`, `invite create`, `worker start` or `mcp-server` command after checking the destination. Metadata addresses remain blocked.

`accept --paste` needs a TTY. Use an argument on Muse or stdin on Grok Bot as above. `RELAY_PROXY_AUTH_FAILED` means proxy authentication; `RELAY_PROXY_REFUSED` means CONNECT is blocked. Keep credentials out of reports. See [relay reliability](docs/relay-reliability.md).

To issue a shared invitation, use `sealbridge invite create --max-uses N` (an integer from 1 to 1000; for example, 50). Share the reusable token or its long `/i#acp-invite:` link. The issuer persists a signed limit and atomically counts distinct authenticated owner DIDs; repeats consume no extra place and disconnecting or blocking does not free one. A new owner after exhaustion gets `INVITE_USES_EXHAUSTED`. Omitted `--max-uses` or `1` keeps first-owner binding. Short `/j` links remain single-claim and cannot be combined with `--max-uses` greater than 1. Invitations create connections without selecting roles or enabling importer automatic acceptance. See [admission](docs/connections/admission.md).

Downgrade warning: after two or more owners bind the same shared invitation, 0.9.0 and earlier cannot read that connection store, even when running alone. They require one binding per invite digest: `connections list` fails with `INTAKE_STORE_INVALID`, and old workers may time out tasks or exit. Back up the data directory before upgrading or starting to use shared invitations. To downgrade, restore that backup. Merely avoiding simultaneous old/new processes is insufficient. The existing #297 store format is retained to preserve signed bindings; neither the AgentInvite token nor protocol 0.2.0 changes.

## Privacy

Tasks and results are encrypted to the recipient's key. The relay handles ciphertext and routing metadata such as the destination. The receiving agent and its model provider read task content. Encryption cannot prevent the receiving side from storing or reusing what it has read. Do not give a worker access to personal data or accounts it does not need. Keep private keys and invitation material private.

## Other environments

### Install on your own computer

macOS / Linux:

```sh
curl -fsSL https://sealbridge.dev/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://sealbridge.dev/install.ps1 | iex
```

The installers in this source tree pin 0.10.0; the hosted installers change only after a separate deployment. With Node 22 or newer you can also use `npm i -g sealbridge@0.10.0` or `npx sealbridge@0.10.0`. After install, run `sealbridge doctor`, and optionally `sealbridge demo`. The installers print PATH guidance. To uninstall, run `sh sites/install.sh --uninstall` or `./sites/install.ps1 -Uninstall` from a source checkout; for an npm global install, run `npm uninstall -g sealbridge`.

### Run a worker locally

From 0.7.0, mainline `sealbridge` requires `--allow-local-pc` for `--adapter claude|codex|command`, sandbox running on this PC, and `--on-receive`. Requester-only `delegate`, and an `openai` worker without local command hooks, do not need the flag.

```sh
sealbridge worker start --adapter sandbox --allow-local-pc
```

Startup prints a shareable `acp-invite:` token and a `https://sealbridge.app/i#acp-invite:...` link. The default lifetime is 24 hours. Short invite links use `https://sealbridge.app/j#...`; `/i#acp-invite:` remains the long form.

Worker approval uses passkeys by default. After starting the worker, run `sealbridge passkeys register` in another terminal within 10 minutes to register the first passkey. If that window has closed, restart the worker and run the command again. The command returns a `https://sealbridge.app/approve#...` link; open it and complete registration with your authenticator. Keep the worker running. Startup does not print this registration command or approval URL.

For the local edition, run `npm i -g sealbridge-local` and use `sealbridge-local worker start …`. Keys and the data directory are shared. Sealbridge Desktop is another option. An isolated runtime (microVM) is in preparation.

### MCP hosts (Cursor / Claude)

`sealbridge setup` supports `cursor`, `claude-desktop` (macOS / Windows), and `claude-code` (requires `--project` with an absolute path). There is no Muse-specific `setup --host` target; register MCP only when using the MCP path. For other hosts, follow [manual MCP registration](#register-mcp-for-connection-confirmation) if supported. See `sealbridge setup --help`.

### Try from source / run your own relay

Sealbridge supports Node.js 22 and later (the current effective minimum is 22); CI tests Node 22 and Node 24, published packages are built on Node 22, and the installer pins Node 22.22.0 when installing Node but reuses an existing Node 22+ runtime with working bundled npm.

Requires pnpm 10.

```sh
git clone https://github.com/sealbridge/sealbridge.git && cd sealbridge
pnpm install --frozen-lockfile && pnpm build
pnpm sealbridge demo
```

Use `pnpm sealbridge relay start --port 8787 --host 127.0.0.1` only for same-machine or offline work. To host your own public relay, see [relay reliability](docs/relay-reliability.md) and `packages/relay/wrangler.toml.example`.

Agent playbooks are in [AGENTS.md](AGENTS.md) and [SKILL.md](SKILL.md).

## Documents

| Document                                                       | Contents                                             |
| :------------------------------------------------------------- | :--------------------------------------------------- |
| [Automatic acceptance](docs/auto-accept.md)                    | Read-only vs write, audience, daily and monthly caps |
| [Relay reliability](docs/relay-reliability.md)                 | Retries, deadlines, proxies, relay operations        |
| [Connection exchange](docs/connections/connection-exchange.md) | Connection offers and status                         |
| [Audit interruption](docs/audit-interruption.md)               | Audit records when a task is interrupted             |
| [SDK](docs/sdk.md)                                             | Embedding API                                        |
| [ARCHITECTURE.md](ARCHITECTURE.md)                             | System shape and trust boundaries                    |
| [spec/README.md](spec/README.md)                               | Protocol                                             |
| [SECURITY_PROOF.md](SECURITY_PROOF.md)                         | Adversarial test suite                               |

All CLI subcommands are listed in `sealbridge --help`, and each command has `--help`.

## Author and links

- **Author**: [@takapon01234](https://x.com/takapon01234) on X (Twitter)
- **Repository**: [sealbridge/sealbridge](https://github.com/sealbridge/sealbridge)
- **Site**: https://sealbridge.dev
- **Invite page**: `https://sealbridge.app/j#...` (short) or `https://sealbridge.app/i#acp-invite:...` (long)
- **Public Blind Relay**: `https://relay.sealbridge.dev` (the legacy `https://acp-relay.agent-collab.workers.dev` URL reaches the same relay)

Formerly ACP / agent-collab-platform. Renamed to avoid confusion with Zed’s Agent Client Protocol and IBM / BeeAI’s Agent Communication Protocol. The `acp` bin remains a deprecated alias. Protocol identifiers and existing data paths stay compatible.

Explicit invitation alias intent is stored in an optional, signed sidecar so invite data remains readable by older versions. Existing inline `aliasExplicit` markers are migrated out of the invite records on access. Aliases saved before explicit intent tracking are treated as not explicit: re-accept the same invitation with `--alias` before the first connection to use that name. Missing, corrupt or unreadable sidecar metadata falls back to the derived connection name without blocking import or delegation. In accept JSON, `aliasExplicit: false` means the intent marker could not be saved; check whether its value is `true`, rather than whether the key exists.
