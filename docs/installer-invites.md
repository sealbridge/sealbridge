# Optional invitation import after installation

[日本語](installer-invites.ja.md)

After a successful installation from a saved script in an interactive terminal,
the installer offers to import an invitation. Enter skips. Pasting alone does
not submit it: a second, hidden confirmation requires exactly `y`. Enter, EOF,
`n`, `yes`, or any other response skips import. Every input uses the same gate,
including unrecognized strings, so URL spelling or whitespace cannot bypass it.

The confirmation explains the pinned 0.10.1 CLI's two behaviors:

- A normal token (including its long `/i` link or `acp://invite` form) imports
  locally and creates no connection.
- A short `/j` or `sealbridge://join` link contacts the relay, consumes the link,
  and immediately requests connection to the inviter, signing connection consent.
  Work permission remains separate; connection may remain pending.

Both installers still pin `sealbridge@0.10.1` / `sealbridge-local@0.10.1`.
To disable this optional step, use `sh install.sh --no-accept` or
`& ./install.ps1 -NoAccept`. CI, redirected input/output/error, pipelines,
and missing terminal access skip the prompt. Thus `curl ... | sh` and
`irm ... | iex` install without prompting. Use `sealbridge accept --paste`
afterward in your own terminal, or run the saved installer script interactively.
The standalone CLI's `--paste` input behavior is separate from the installer's
hidden-input implementation; this change does not alter the CLI.

On macOS/Linux, all three standard streams must be terminals and `/dev/tty`
must be available. The installer reads from `/dev/tty`, disables echo for both
inputs, and restores the original terminal settings on completion, EOF, or
handled HUP/INT/TERM. It skips when shell tracing, verbose mode, or automatic
variable export is enabled. It requires a shell-builtin `printf`, so the link
cannot become an external command argument. As with any terminal application,
unhandleable termination such as SIGKILL cannot run cleanup.

On Windows, run the saved script in Windows PowerShell 5.1 or PowerShell 7
ConsoleHost. The installer skips `-NonInteractive`, non-console hosts, and
in-memory/pipeline execution. Both reads use `Read-Host -AsSecureString` (masked
input). A .NET helper starts the selected Node with only the installed entry
path and `accept --stdin` in its arguments, converts the secure value in memory,
and writes UTF-8 directly to stdin. PowerShell never holds a plaintext string.
The helper drains and discards child output and bounds the wait at 60 seconds.

Neither installer places the pasted link in command arguments, environment
variables, shell history, temporary files, or diagnostic output. The CLI's normal
identity/invitation storage still applies after consent. CLI output is suppressed
because errors and peer metadata might contain sensitive text. On import failure
only a fixed `accept --paste` instruction is printed; the installed files and
installation status are preserved. An interrupted/failed short-link operation
may already have consumed the link or saved state; failure does not undo it.

## Verification and review evidence

The annotated `v0.10.1` tag peels to merged preparation PR
[#330](https://github.com/sealbridge/sealbridge/pull/330), commit
`f8eac9f5a7b5035b24b1545dd9cfb27e8cefd6bd`, tree
`a8c3b3d17577146ccd07ee4eee7bfafc006820d8`. The preflight used an archive of that
exact source, frozen dependency installation, `pnpm run package:cli`, and
`npm pack --ignore-scripts`, then unpacked the local tarball. At the initial
check npm returned E404 for 0.10.1 and there was no GitHub release. This is
local-package evidence, not verification of a published artifact.

Run `node scripts/verify-installer-invite-package.mjs /path/to/unpacked/package`
to repeat the preflight. It checks actual packaged CLI stdin with a synthetic
signed token, invalid input, empty input, and multiline input: no prompt or echo,
success only for the valid token. It also runs packaged acceptance code against
an injected in-memory relay (no external requests) for token, long link, ACP URI,
and both short-link forms, checking local-only versus relay/connection consent
behavior. It prints booleans/status only and removes its disposable state.

`conformance/installer-invite.test.ts` exercises POSIX PTYs and Windows ConPTY
with real hidden input and synthetic data, as well as redirected streams,
explicit skips, CI, EOF, interrupt cleanup, declined confirmation and failures.
The fake CLI deliberately echoes its input to both output streams to verify
suppression. Windows tests cover PowerShell 5.1/7 and tracing/transcription.
`installer-node.test.ts` also covers complete noninteractive installation,
reinstallation, runtime selection and failure behavior. The Installer workflow
runs both suites and complete package installation on Ubuntu, macOS and Windows.

No browser behavior or the privacy promises in [sites.md](sites.md) change:
no `/j` network calls, preview endpoint, analytics, deployment or publication
is introduced by this installer step.
