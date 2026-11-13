# 0.8.0 preparation / 公開準備

Preparation only. This PR authorizes no tagging, npm publication, GitHub Release,
site deployment or relay deployment. 公開・デプロイは別途所有者が判断します。

- Base: `origin/main` at `166e619` (after `v0.7.0`).
- Both `sealbridge` and generated `sealbridge-local`, all versioned workspace
  packages, MCP/A2A server metadata and installer pins are 0.8.0.
- CHANGELOG retains automatic-acceptance migration and API billing notices,
  daily/monthly/input caps, proxy support and persistent-worker recovery fixes
  from #234, #235, #259, #260, #261, #262, #263, #265, #267, #269, #271 and #273.
- The planned changelog date is 2026-11-13; correct it before any future tag if
  publication occurs on another date. Historical 0.7.0 publication records remain.
- Source installers pin 0.8.0. Hosted installers remain unchanged until a separately
  authorized deployment. Site documentation is generated from the READMEs.
- The private, unversioned sites tooling package has no release version to bump.

Use the existing paired preflight from `publish.yml`: frozen install, build,
typecheck, schema validation, tests, `check:protocol-release`, package generation,
then freeze both tarballs and dry-run both before any future registry write.
Dry-runs do not establish Trusted Publisher/OIDC authorization. The local package's
publisher setup described in [the 0.7.0 record](release-0.7.0.md) remains a separate
operator prerequisite; this preparation does not inspect or change credentials.

今回は PR と CI の確認までです。日付・npm の認証設定・公開サイトへの反映は、
将来の公開時に別途確認してください。
