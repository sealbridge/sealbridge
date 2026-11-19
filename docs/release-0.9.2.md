# 0.9.2 preparation / 公開準備

Preparation of paired 0.9.2 distributions from origin/main at `4ae39076`
(includes #302–#306), following #301. This document records the bump
contents and publication caveats. 公開・デプロイの実施可否は所有者が判断します。

- Both `sealbridge` and generated `sealbridge-local`, all versioned workspace
  packages, MCP/A2A server metadata and installer pins are 0.9.2.
- CHANGELOG preserves every earlier entry under 0.9.1 with an empty
  Unreleased header. EN/JA summaries cover contributor templates (#302),
  Node 22+ alignment of engines, CI and publish builds (#303), required
  Promise lint rules (#304), sandbox IPC drain and concurrent outbox
  cleanup (#305), and repository-wide Prettier with required
  `format:check` (#306).
- No breaking changes. Engines stay Node `>=22`, the same as 0.9.1.
  Protocol 0.2.0 and the shared-invite store format are unchanged. The
  0.9.0 downgrade warning for multi-owner shared invitations still
  applies. 破壊的変更はなく、engines は Node >=22 のままです。
- `git diff v0.9.1..origin/main -- packages/relay` is not empty: #303
  widened the relay workspace engine range to `>=22`, #304 wrapped the
  local in-process HTTP listener for Promise lint (no protocol change),
  and #306 reformatted relay sources with Prettier. There is no relay
  protocol or product-behavior change intended for deployment. Relay
  deployment is out of scope for this release; only the workspace
  manifest version is bumped.
- The release date is 2026-11-19; correct it before a future tag if
  publication occurs on another date. Historical publication records
  remain.
- Source installers pin 0.9.2. Hosted installers require separately
  authorized deployment. Site documentation is generated from the
  READMEs.
- The private, unversioned sites tooling package has no release version
  to bump.
- Internal dependencies retain `workspace:*`; lockfile regeneration
  produces no version-driven changes. Generated `sealbridge-local`
  inherits the root version.
- Ubuntu conformance runs on ubuntu-24.04; the required Node 22 check
  name stays `conformance (ubuntu-latest)`. CI tests Node 22 and 24 on
  three OSes. Required checks are lint (including `format:check`), six
  conformance jobs, and three installer jobs (10/10). Local validation
  uses Node 24.

## Future publication checklist / 将来の公開時の確認

- [ ] Verify both packages' npm Trusted Publisher settings on npmjs.com:
      repository `sealbridge/sealbridge`, workflow filename `publish.yml`
      (filename only), environment name exactly `npm-publish`, and Allowed
      actions including **npm publish**. Configurations created after
      2026-09-03 default to `npm stage publish` only. `sealbridge` OIDC
      Trusted Publishing has worked for previous releases.
      `sealbridge-local` failed CI OIDC with E403 "OIDC permission denied
      for this action" on 0.8.1 and 0.9.0 and was published manually, but
      both packages published successfully through `publish.yml` on 0.9.1
      (run 44309223003). Confirm the same Trusted Publisher settings
      before 0.9.2 publication. This preparation does not inspect or
      change npm credentials or configuration.
- [ ] Use the unchanged paired preflight in `publish.yml`: frozen install,
      build, typecheck, schema validation, tests, `check:protocol-release`,
      package generation, then freeze both tarballs and dry-run both
      before any future registry write. Dry-runs do not establish Trusted
      Publisher/OIDC authorization. Never approve the `npm-publish`
      environment through the API.
- [ ] Obtain separate owner authorization for tagging, publication, GitHub
      Release creation and any site/relay deployment. Never change the
      protocol version here. This release does not deploy the relay.

日付・npm の認証設定・公開サイトへの反映は、公開時に別途確認してください。
