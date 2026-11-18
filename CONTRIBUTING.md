# Contributing to Sealbridge

[日本語](CONTRIBUTING.ja.md)

## Development setup

Sealbridge supports Node.js 22 and later (the current effective minimum is 22); CI tests Node 22 and Node 24, published packages are built on Node 22, and the installer pins Node 22.22.0 when installing Node but reuses an existing Node 22+ runtime with working bundled npm.

Use Git, Node.js 22 or later and pnpm 10. The repository pins `pnpm@10.34.6` in
`package.json`; use that version for reproducible installs.

```sh
git clone https://github.com/sealbridge/sealbridge.git
cd sealbridge
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck
pnpm validate:schemas
pnpm format:check
pnpm lint
```

Run commands from the repository root. `pnpm conformance` is an alias for
`pnpm test` (both run Vitest). For a focused test, use
`pnpm exec vitest run conformance/doctor.test.ts`. Run
`pnpm test:security-proof` for security proof tests and `pnpm sealbridge --help`
for the source CLI. Rebuild after changing source used by built CLI tests.

Run `pnpm format` to apply formatting, `pnpm format:check` to check it, and
`pnpm lint` for type-aware Promise checks. CI requires the `lint` job on Ubuntu with Node 22 in addition to the conformance matrix.
ESLint enables only `no-floating-promises` and `no-misused-promises`, both as errors.
The existing tree is not fully formatted: `format:check` currently reports that backlog
and is not required in CI. A dedicated follow-up PR should format the repository
and then enable required `prettier --check`. Format files you change for now.

## Changes and verification

Create a focused branch from current `main`. Add or update relevant tests for
behavior changes and keep English and Japanese documentation aligned. Never
commit private keys, credentials, live invite tokens or private task payloads;
use synthetic fixtures and redact logs.

Before opening a PR, run the setup checks above and describe any checks you
could not run. PRs must pass the required three-OS conformance CI on macOS,
Ubuntu and Windows using Node.js 22 and 24. CI also checks real Codex proxy routing,
static sites, security proofs and the demo; installer checks run separately.
See [the CI workflow](.github/workflows/conformance.yml) for the exact steps.
Local checks do not replace the required CI checks.

Use conventional commit subjects such as `fix: explain the user-visible fix`
or `docs: clarify setup`. Keep commits and PRs focused. In the PR, explain the
problem, the resulting user-visible change, related issues and test results
(including limitations). Update docs when behavior or setup changes.

## Issues and security

Use the bug report or feature request form for non-security issues. Include the
version or commit and a minimal reproduction for bugs.
**Do not report unpatched vulnerabilities in public issues or PRs.** Follow
[the security reporting policy](SECURITY.md) for private reporting, including
the email fallback when GitHub's private advisory form is unavailable.
