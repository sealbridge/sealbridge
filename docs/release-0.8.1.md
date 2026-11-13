# 0.8.1 preparation / 公開準備

Preparation only. This PR authorizes no tagging, npm publication, GitHub Release,
site deployment or relay deployment. 公開・デプロイは別途所有者が判断します。

- Base: `origin/main` at `03c11537` (includes #275, #276 and #277).
- Both `sealbridge` and generated `sealbridge-local`, all versioned workspace
  packages, MCP/A2A server metadata and installer pins are 0.8.1.
- CHANGELOG records Grok Bot zero-config synthetic-DNS detection and DNS pinning,
  doctor SSRF diagnostics, non-TTY delegation failing before send,
  `DATA_DIR_PERMISSIONS` guidance, contacts data-root selection, the first-invite
  delegation fix, and Muse/Grok Bot onboarding guidance.
- The planned changelog date is 2026-11-14; correct it before any future tag if
  publication occurs on another date. Historical publication records remain.
- Source installers pin 0.8.1. Hosted installers remain unchanged until a separately
  authorized deployment. Site documentation is generated from the READMEs.
- The private, unversioned sites tooling package has no release version to bump.
- Internal dependencies retain `workspace:*`; regenerating the lockfile requires
  no changes because workspace links do not encode package versions.

## Future publication checklist / 将来の公開時の確認

- [ ] Configure/verify `sealbridge-local`'s npm Trusted Publisher for repository
  `sealbridge/sealbridge`, workflow `publish.yml`, environment `npm-publish` before
  its first OIDC publication. Its 0.8.0 publication was manual; see
  [the 0.8.0 record](release-0.8.0.md). This is a separate operator prerequisite.
- [ ] Verify both packages' Trusted Publisher settings and environment approval.
  This preparation does not inspect or change credentials or npm configuration.
- [ ] Use the unchanged paired preflight in `publish.yml`: frozen install, build,
  typecheck, schema validation, tests, `check:protocol-release`, package generation,
  then freeze both tarballs and dry-run both before any future registry write.
  Dry-runs do not establish Trusted Publisher/OIDC authorization.
- [ ] Obtain separate owner authorization for tagging, publication, GitHub Release
  creation and any site/relay deployment.

今回は PR と CI の確認までです。日付・npm の認証設定・公開サイトへの反映は、
将来の公開時に別途確認してください。
