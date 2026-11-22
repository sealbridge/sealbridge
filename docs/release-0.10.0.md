# 0.10.0 release preparation

Prepare paired `sealbridge` and generated `sealbridge-local` distributions from main at `054ce794`, following the 0.9.2 bump PR #307. Includes #308-#314. This PR changes release metadata and documentation only; it does not merge, tag, publish, create a Release or deploy.

- All versioned workspace packages, MCP/A2A metadata, fixtures and source installer pins are 0.10.0. The unversioned sites tooling package stays unversioned. Generated `sealbridge-local` inherits the root version.
- Internal dependencies remain `workspace:*`. Regenerate the lockfile; workspace package versions alone produce no version-driven lockfile diff.
- Node >=22 and protocol 0.2.0 stay unchanged. CI checks Node 22/24 on Ubuntu, macOS and Windows, plus lint/format and three installer jobs (10 checks).
- CHANGELOG 0.10.0 covers opt-in isolation, short-link connection/defaults, background read-only auto-accept, notifications, passkey approval and pinned HTTP body framing. See its **Upgrade notes / breaking changes** before upgrading workers.
- Workers now default to passkeys; terminal integrations need `--tty-approval`. Paid automatic work requires a monthly cap and charges its maximum token cost up front. First-key enrollment trusts the first credential within a ten-minute worker-startup window; an agent in that window can still register first. Recommend `keyStore: keychain`.
- The owner reports production `relay.sealbridge.dev` already supports approval routes. Self-hosted relays need `APPROVALS`, migration `v3-owner-approvals` and `RATE_LIMITER`; approval-site assets are also required. This preparation performs no deployment. See [passkey approval](passkey-approval.md).
- Source installers pin 0.10.0. Hosted installer/site updates require separate deployment approval. READMEs generate site documentation. Keep previous release records unchanged.
- The changelog date is 2026-11-22; verify it at any later publication.

## Future publication checklist (not performed)

- [ ] Confirm both npm Trusted Publisher settings: repository `sealbridge/sealbridge`, workflow filename `publish.yml`, environment `npm-publish`, Allowed actions including **npm publish**. Both distributions published via this workflow on 0.9.1; earlier `sealbridge-local` OIDC E403 failures mean authorization must still be checked. Do not change credentials/settings as part of this PR.
- [ ] Use the unchanged paired publish preflight: frozen install, build, typecheck, schema validation, tests, protocol-release check and package generation. Freeze and dry-run both tarballs before registry writes; a dry-run does not prove OIDC authorization. Never approve the npm-publish environment through the API.
- [ ] Obtain separate authorization before merging, tagging, publishing, creating a GitHub Release or deploying relay/site/installer assets. Do not change protocol versions.
