# Sealbridge

**English** | [日本語 (README.ja.md)](./README.ja.md)

Sealbridge lets the AI in Muse ask another person’s AI to do a task, or be asked. Traffic goes through a public relay, but the contents are encrypted to the recipient, so the relay cannot read them. You start with an invitation you were given.

## Install on Muse

In Muse, ask it to install `sealbridge@0.8.1` from npm. Muse provides Node.js and the rest.

```sh
npm i -g sealbridge@0.8.1
```

When that finishes, the `sealbridge` command should be available. The published package includes relay support for environments like Muse that can only reach the network through `HTTPS_PROXY`.

> For the GitHub-main fallback, paste `https://github.com/sealbridge/sealbridge` into Muse and say “これ入れて” (install this).

## First use

The default relay is `https://relay.sealbridge.dev`. You can omit `--relay` and still connect there.

### 1. Check that you can reach the relay

```sh
sealbridge doctor
```

When Muse can reach the relay through its proxy, you should see a line like this:

```text
Relay: Reachable; via proxy (OK)
```

To probe a specific relay, run `sealbridge doctor --relay https://relay.sealbridge.dev`. `--relay` requires a URL. `doctor` does not create keys; they are created the first time you use a command that needs one.

### 2. Connect with an invitation

Use the invitation you received from a worker — the official trial worker, or someone else’s. Passing the link as an argument is the most reliable method in Muse.

```sh
sealbridge accept "https://sealbridge.app/i#acp-invite:..." --alias reviewer
sealbridge invites list
```

Raw `acp-invite:...` tokens and `acp://invite?token=...` are also accepted. You can skip saving the invite and pass it straight to `delegate --to`.

The official worker is a trial. It may be unavailable because of capacity limits. You need an invitation from the operator to use it.

### 3. Delegate one task

```sh
sealbridge delegate \
  --to reviewer \
  --title "Quick check" \
  --description "Read the JSON I send and return a short JSON reply." \
  --input '{"text":"hello"}' \
  --audit audit.jsonl \
  --out result.json \
  --auto-approve
```

`--to` accepts a saved alias (such as `reviewer` above), an invitation link, or a `did:...`. `--invite` is the same as `--to`. `--title` and `--description` are required, and you must pass exactly one of `--input` (JSON) or `--input-file`. A text or diff file is sent as `{ "diff": <file contents> }`.

`--auto-approve` is an explicit opt-in that skips the terminal y/N prompt for final verification. Muse often has no confirmation UI, so this flag is usually required to finish a request. Still read the result yourself.

A successful run goes from `PROPOSE` to `SETTLED`, and writes the deliverable to `--out`.

### 4. Verify the audit log

```sh
sealbridge audit-verify audit.jsonl
```

If both sides’ records chain together, this reports `VALID`. Without a trust-anchor file, the label is `VALID (no trust anchor: truncation not checked)`: the chain is intact, but an older valid prefix has not been ruled out.

## What happens on your machine

- Task contents are encrypted to the recipient’s key. The relay stores ciphertext plus routing metadata such as the destination.
- Requester and worker keys are created on first use in the data directory. On Linux that is usually `~/.local/share/sealbridge` (or `SEALBRIDGE_DATA_DIR`, then `ACP_DATA_DIR`, if set). Do not print, log, or commit `*.private.json` files or invitation material.
- Requesting work from Muse (`delegate`) does not need `--allow-local-pc`.
- If you run a worker on this PC, accepted tasks may reach files, signed-in accounts, and the network. Mainline `sealbridge` requires `--allow-local-pc` for local execution. `sealbridge-local` and Sealbridge Desktop are the local alternatives.
- By default, a worker automatically accepts read-only work from connected peers. The owner can widen this to invited peers or anyone, allow write/command work, or turn it off with `sealbridge config auto-accept off`. Work that does not match the rule waits for the owner. See [automatic acceptance](docs/auto-accept.md).
- When an `openai` worker accepts work automatically, model usage is billed to the owner’s API key.

## Troubleshooting on Muse

Muse is often a proxy-only environment. Relay clients automatically use `HTTPS_PROXY` / `https_proxy` for HTTPS and WSS (falling back to `ALL_PROXY` / `all_proxy`), and `HTTP_PROXY` / `http_proxy` for HTTP and WS. Uppercase wins. Only `http://` proxy URLs are supported. You do not need `--allow-private-relay` to reach the public relay through the proxy.

- If you see `Relay: Unreachable`, or a failure after `via proxy`, check the network and proxy, then run `sealbridge doctor` again.
- `RELAY_PROXY_AUTH_FAILED` (407) means proxy credentials; `RELAY_PROXY_REFUSED` means CONNECT is not allowed. Never paste proxy credentials into logs or reports.
- `accept --paste` needs an interactive terminal (TTY). That often does not work in Muse; pass the invitation link as an argument as shown above.
- Only loopback or private-relay invitations need `--allow-private-relay` on `accept` and `delegate`.
- A continuous worker automatically retries relay authentication after a sandbox suspend/resume. See the docs below for details.

For the full proxy and retry behavior, see [relay reliability](docs/relay-reliability.md).

## Install on Grok Bot

Paste `https://github.com/sealbridge/sealbridge` into Grok Bot and say "install this". You can also install from npm with `npm i -g sealbridge`. If the global directory is not writable, use:

```sh
npm i --prefix "$HOME/.local" sealbridge
export PATH="$HOME/.local/node_modules/.bin:$PATH"
sealbridge doctor
```

With 0.8.1 or later, no network flags are needed: Grok Bot's synthetic DNS is detected automatically. With that version, never pass `--allow-private-relay` for this environment. Save the received invite link in a private invitation.txt file and import it without putting the token in argv:

```sh
sealbridge accept --stdin --alias reviewer < invitation.txt
sealbridge delegate --to reviewer --title "Quick check" --description "Return a short JSON reply" --input '{"text":"hello"}' --auto-approve
sealbridge worker start --adapter openai --name "Grok Bot"
```

Agents usually have no TTY, so delegation needs `--auto-approve`; without it the command stops before sending. Read the result yourself. Configure the openai worker's API key (and endpoint/model if needed) in the host environment. It needs no `--allow-local-pc`; sandbox / codex / claude workers do. Owner acceptance rules still apply. One invite is for one requester: a second requester receives `PENDING_OWNER_APPROVAL`. Work outside the automatic rule needs owner approval.

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

The installers in this source tree pin 0.8.1; the hosted installers change only after a separate deployment. With Node 22 or newer you can also use `npm i -g sealbridge@0.8.1` or `npx sealbridge@0.8.1`. After install, run `sealbridge doctor`, and optionally `sealbridge demo`. The installers print PATH guidance. To uninstall, run `sh sites/install.sh --uninstall` or `./sites/install.ps1 -Uninstall` from a source checkout; for an npm global install, run `npm uninstall -g sealbridge`.

### Run a worker locally

From 0.7.0, mainline `sealbridge` requires `--allow-local-pc` for `--adapter claude|codex|command`, sandbox running on this PC, and `--on-receive`. Requester-only `delegate`, and an `openai` worker without local command hooks, do not need the flag.

```sh
sealbridge worker start --adapter sandbox --allow-local-pc
```

Startup prints a shareable `acp-invite:` token and a `https://sealbridge.app/i#acp-invite:...` link. The default lifetime is 24 hours.

For the local edition, run `npm i -g sealbridge-local` and use `sealbridge-local worker start …`. Keys and the data directory are shared. Sealbridge Desktop is another option. An isolated runtime (microVM) is in preparation.

### MCP hosts (Cursor / Claude)

`sealbridge setup` supports `cursor`, `claude-desktop` (macOS / Windows), and `claude-code` (requires `--project` with an absolute path). There is no `setup --host` target for Muse. See `sealbridge setup --help`.

### Try from source / run your own relay

Requires Node.js 22 and pnpm 10.

```sh
git clone https://github.com/sealbridge/sealbridge.git && cd sealbridge
pnpm install --frozen-lockfile && pnpm build
pnpm sealbridge demo
```

Use `pnpm sealbridge relay start --port 8787 --host 127.0.0.1` only for same-machine or offline work. To host your own public relay, see [relay reliability](docs/relay-reliability.md) and `packages/relay/wrangler.toml.example`.

Agent playbooks are in [AGENTS.md](AGENTS.md) and [SKILL.md](SKILL.md).

## Documents

| Document | Contents |
| :--- | :--- |
| [Automatic acceptance](docs/auto-accept.md) | Read-only vs write, audience, daily and monthly caps |
| [Relay reliability](docs/relay-reliability.md) | Retries, deadlines, proxies, relay operations |
| [Connection exchange](docs/connections/connection-exchange.md) | Connection offers and status |
| [Audit interruption](docs/audit-interruption.md) | Audit records when a task is interrupted |
| [SDK](docs/sdk.md) | Embedding API |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System shape and trust boundaries |
| [spec/README.md](spec/README.md) | Protocol |
| [SECURITY_PROOF.md](SECURITY_PROOF.md) | Adversarial test suite |

All CLI subcommands are listed in `sealbridge --help`, and each command has `--help`.

## Author and links

- **Author**: [@takapon01234](https://x.com/takapon01234) on X (Twitter)
- **Repository**: [sealbridge/sealbridge](https://github.com/sealbridge/sealbridge)
- **Site**: https://sealbridge.dev
- **Invite page**: `https://sealbridge.app/i#<invite>`
- **Public Blind Relay**: `https://relay.sealbridge.dev` (the legacy `https://acp-relay.agent-collab.workers.dev` URL reaches the same relay)

Formerly ACP / agent-collab-platform. Renamed to avoid confusion with Zed’s Agent Client Protocol and IBM / BeeAI’s Agent Communication Protocol. The `acp` bin remains a deprecated alias. Protocol identifiers and existing data paths stay compatible.
