# 0.9.1 preparation / 公開準備

Preparation only. This PR authorizes no merge, tagging, npm publication, GitHub
Release, workflow dispatch, environment approval, site or relay deployment.
公開・デプロイは別途所有者が判断します。

- Base: `origin/main` at `80271917` (includes #297–#300), following #295 / #278.
- Both `sealbridge` and generated `sealbridge-local`, all versioned workspace
  packages, MCP/A2A server metadata and installer pins are 0.9.1.
- CHANGELOG preserves every entry under 0.9.1 with an empty Unreleased header.
  EN/JA summaries cover atomic shared `--max-uses` invitations (#297), shared-limit
  guards and 1–1000 validation (#298), and the MCP behavior change (#299–#300).
- **Behavior change:** default unmigrated `acp_create_invite` now refuses with
  `INVITE_REQUESTER_LISTENER_REQUIRED` (isError, no token, no shared-limit record).
  #300 supersedes #299's warning-and-minting behavior. Explicit `options.owner`,
  `mcp-server --key` / `explicitKeyPath`, and migrated delegated identities bypass
  this guard. 未移行の既定 MCP 招待は警告付き発行から拒否へ変わります。
- Shared-invite stores with multiple owners bound to one invite cannot be read
  by 0.9.0 and earlier, even alone. Back up before upgrading or using shared
  invitations; restore that backup to downgrade. 0.9.1 reads the new store.
  共用招待の利用前にバックアップし、旧版へ戻す際は復元してください。
- Verified `git diff v0.9.0..origin/main -- packages/relay` is empty at this base.
  Relay deployment is unnecessary; only its workspace manifest version is bumped.
- The release date is 2026-11-18; correct it before a future tag if publication
  occurs on another date. Historical publication records remain.
- Source installers pin 0.9.1. Hosted installers require separately authorized
  deployment. Site documentation is generated from the READMEs.
- The private, unversioned sites tooling package has no release version to bump.
- Internal dependencies retain `workspace:*`; lockfile regeneration produces no
  version-driven changes. Generated `sealbridge-local` inherits the root version.
- Ubuntu conformance runs on ubuntu-24.04; the required check name stays
  `conformance (ubuntu-latest)`. CI uses Node 22; local validation uses Node 24.
  Target: three conformance and three installer jobs (6/6).

## Future publication checklist / 将来の公開時の確認

- [ ] An operator must verify `sealbridge-local`'s npm Trusted Publisher on
  npmjs.com before future 0.9.1 publication: repository `sealbridge/sealbridge`,
  workflow filename `publish.yml` (filename only), environment name exactly
  `npm-publish`, and Allowed actions including **npm publish**. Configurations
  created after 2026-09-03 default to `npm stage publish` only.
  `sealbridge` OIDC Trusted Publishing works; `sealbridge-local` failed CI OIDC
  with E403 "OIDC permission denied for this action" on both 0.8.1 and 0.9.0 and
  was published manually. This is a separate operator prerequisite.
- [ ] Verify both packages' Trusted Publisher settings and environment approval.
  This preparation does not inspect or change npm credentials or configuration.
- [ ] Use the unchanged paired preflight in `publish.yml`: frozen install, build,
  typecheck, schema validation, tests, `check:protocol-release`, package generation,
  then freeze both tarballs and dry-run both before any future registry write.
  Dry-runs do not establish Trusted Publisher/OIDC authorization.
- [ ] Obtain separate owner authorization for tagging, publication, GitHub Release
  creation and any site/relay deployment. Never change the protocol version here.

今回は PR と CI の確認までです。日付・npm の認証設定・公開サイトへの反映は、
将来の公開時に別途確認してください。
