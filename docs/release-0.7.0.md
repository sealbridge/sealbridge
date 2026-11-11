# 0.7.0 publication record and follow-up / 公開記録と残作業

Published on 2026-11-11. The completed items below record the owner's release.
This follow-up authorizes no merge, tag, publication, npm configuration change,
workflow dispatch, environment approval or deployment.
2026-11-11 公開済みです。以下は所有者による公開の記録です。
今回のフォローアップではマージ・タグ・公開・npm 設定変更・ワークフローの手動実行・
環境承認・デプロイを行いません。

## Completed publication / 公開済みの項目

- [x] `v0.7.0` targets `77c6140c75e5fec89428727de00aca217a4cbb0c` (#229).
  The annotated tag object is `cf086c4e`.
- [x] `sealbridge@0.7.0` was published by `publish.yml` through Trusted Publishing,
  with provenance.
- [x] `sealbridge-local@0.7.0` was first published manually by the owner, without
  provenance as expected; its `latest` dist-tag is 0.7.0.
- [x] [GitHub Release v0.7.0](https://github.com/sealbridge/sealbridge/releases/tag/v0.7.0)
  was created as Latest on 2026-11-11 at 20:08 JST (11:08 UTC).
- [x] https://sealbridge.dev/ and https://sealbridge.app/ were updated on
  2026-11-11 at 20:09 JST (11:09 UTC). The installers were verified to install
  both distributions at 0.7.0.

本流は Trusted Publishing で provenance 付き、ローカル版の初回は所有者による
手動公開で provenance なしです。両 npm 配布物・Release・サイトの公開は完了済みです。

## Remaining follow-up / 残作業

- [ ] Merge this documentation/installer wording follow-up after review and CI,
  under separate authorization. README prepared/pending wording is updated here
  with the actual publication date, 2026-11-11 UTC.
- [ ] After this PR is merged, rebuild/test and deploy the site documentation
  derived from the READMEs and the updated installer wording. The earlier site
  deployment above does not include this follow-up. No deployment in this PR.
- [ ] Configure/verify the local package's Trusted Publisher near its next real
  release, including the two-day OIDC validation requirement described below.
  npm configuration is outside this PR.

この PR のマージ後、README 由来のサイト文書とインストーラー文言をサイトへ反映する
必要があります。ローカル版の Trusted Publisher 設定と次回実公開での検証は残作業です。
リレーのデプロイと X の告知は今回の対象外です。

## First publication of sealbridge-local (historical procedure)

Steps 1–3 below describe the completed initial publication; steps 4–5 remain
operator follow-up for the next local release. Do not repeat the 0.7.0 publication.
以下の 1〜3 は完了した初回公開の手順、4〜5 は次回公開に向けた残作業です。

As checked on 2026-11-11, npm's [Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/)
requires configuring a publisher from the package's Settings page. It documents no
pending-publisher registration for a nonexistent package. Consequently, a 404 name
cannot be bootstrapped by the current OIDC-only workflow: the owner must first
publish the real package manually, then configure its publisher. This conclusion
is inferred from the documented package-settings prerequisite, not an explicit
promise about future registry support. A dry-run does not verify OIDC authorization.

公式手順は既存パッケージの Settings からの設定です。未作成パッケージ用の事前登録は
記載されていないため、現行 OIDC ワークフローだけで初回公開はできないと判断します。
これは設定手順からの判断であり、将来の対応についての断定ではありません。
名前の予約用ダミーパッケージは公開しません。認証情報は本 PR で参照・変更しません。

1. After release approval, use the exact merged/tagged source, install with the
   frozen lockfile, build, typecheck, validate schemas, run tests and
   `pnpm run check:protocol-release`, then `node scripts/package-cli.mjs`.
2. Freeze both real payloads with `npm pack --ignore-scripts` and
   `npm pack ./dist-local --ignore-scripts`. Inspect both tarballs and run
   `npm pack <tarball> --dry-run --ignore-scripts` and
   `npm publish <tarball> --dry-run --access public` for each. The main publish
   root is the repository root, whose files include `dist/`; `dist/package.json`
   is an internal ESM/version manifest, not a separate publishable distribution.
3. The owner, in their own authenticated terminal with required 2FA, publishes
   the actual `sealbridge-local-0.7.0.tgz` using
   `npm publish ./sealbridge-local-0.7.0.tgz --access public`.
   Do not add `--provenance` on a local terminal without a supported CI provider.
   This initial manual publication will not have OIDC-generated provenance.
   See [npm publish](https://docs.npmjs.com/commands/npm-publish/).
4. In npm package Settings → Trusted Publisher, configure GitHub Actions:
   owner `sealbridge`, repository `sealbridge`, workflow `publish.yml`, environment
   `npm-publish`. Explicitly permit direct `npm publish`; current npm defaults may
   permit only staged publishing. Check the existing mainline publisher separately.
5. New publisher configurations must complete a successful OIDC publish within
   two days per the current official documentation. The workflow skips an already
   published 0.7.0 local package, so that skip does not validate the new publisher.
   Configure it near the next real local release or recreate an expired
   configuration before that release; do not invent a version merely to validate it.

初回のみ所有者が実体の tarball を手動公開し、その後パッケージ単位で上記 OIDC を設定します。
初回の手動公開には OIDC provenance が付かない点を公開記録に明記します。
新規設定の2日以内の検証要件にも注意し、公開済み版のスキップを検証成功と見なしません。

## Tag → npm → Release → site (historical procedure)

The release sequence below is retained for reference; the completed publication
and remaining documentation deployment are recorded above.
以下は公開時の手順を履歴として残したものです。完了項目と残作業は上記を参照してください。

This follows the 0.6.2/0.6.3 release records: npm publication, GitHub Release,
then installers/site reflecting published packages. References:
[0.6.2](https://github.com/sealbridge/sealbridge/releases/tag/v0.6.2),
[0.6.3](https://github.com/sealbridge/sealbridge/releases/tag/v0.6.3).

1. Review/merge the version PR only under separate authorization; verify all six
   checks on its final head, and the merged main checks. Confirm date and both
   package versions, then the owner creates and pushes `v0.7.0` at that commit.
2. The tag starts `publish.yml`; the owner reviews/approves the `npm-publish`
   environment only when both payloads and the initial-local-publication plan
   above are ready. The initial local manual publish can be completed from the
   exact tag while this job waits for approval. Do not dispatch a second job.
3. Confirm paired tarball preflight succeeded. The workflow publishes pending
   names through OIDC and skips already published names. If only one succeeds,
   inspect registry integrity and retry the failed run after correcting its
   cause; never overwrite a version, move a tag or assume pairwise atomicity.
4. Verify `npm view sealbridge@0.7.0` and `npm view sealbridge-local@0.7.0`:
   versions, dist-tags, tarball integrity, repository and provenance where
   applicable. Install each in a clean temporary prefix and check both binaries'
   `--version` is 0.7.0; mainline requires the local flag, local edition preserves
   owner consent and shared data. Do not run workers against real identities for a smoke test.
5. Create GitHub Release `v0.7.0 — Sealbridge` from the tag with bilingual
   CHANGELOG highlights, both npm links, migration commands, protocol versions
   0.1.0/0.2.0 and unchanged release clock, and the initial local provenance caveat.
6. Only after both npm packages are available, build/test the static site with
   `pnpm --filter @sealbridge/sites build` and `pnpm --filter @sealbridge/sites test`.
   The site derives documentation from the READMEs. The operator deploys using
   `sites/wrangler.site.jsonc` (and `sites/wrangler.invite.jsonc` only if its assets
   need updating), following the existing Cloudflare procedure. Verify live
   install.sh/install.ps1 pin both names at 0.7.0 and EN/JA pages show accurate
   publication status. Update the README prepared/pending status with actual
   publication dates after verification. No relay deployment is required by P7.

日付と CI を確認してタグ → npm の両配布物を確認 → GitHub Release → サイトの順です。
初回ローカル版の手動公開はタグと同じソースを使い、環境承認前に済ませられます。
片方だけの公開成功を完了とせず、両方の版・実行ファイル・integrity を検証します。
本 PR ではマージ・タグ・公開・環境承認・デプロイを実行しません。
