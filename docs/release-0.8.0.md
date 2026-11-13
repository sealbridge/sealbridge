# 0.8.0 publication record and follow-up / 公開記録と残作業

Published on 2026-11-13. The completed items below record the maintainer's release.
This follow-up is limited to a PR and CI; it authorizes no merge, tag, publication,
npm configuration change, workflow dispatch, environment approval or deployment.
2026-11-13 公開済みです。以下はメンテナーによる公開の記録です。
今回のフォローアップは PR と CI のみで、マージ・タグ・公開・npm 設定変更・
ワークフローの手動実行・環境承認・デプロイは行いません。

## Completed publication / 公開済みの項目

- [x] `v0.8.0` targets `10d8e9df4ed0c875a3481800e58f24dc1506924b`
  ([#274](https://github.com/sealbridge/sealbridge/pull/274)); the tag was pushed
  on 2026-11-13.
- [x] `sealbridge@0.8.0` was published on 2026-11-13 by the Publish to npm
  workflow ([run 43409767611](https://github.com/sealbridge/sealbridge/actions/runs/43409767611)),
  with provenance. Its `latest` dist-tag is 0.8.0.
- [x] `sealbridge-local@0.8.0` was published manually by the maintainer on
  2026-11-13, without npm provenance. The tarball was packed from the `v0.8.0`
  checkout using `node scripts/package-cli.mjs` then `npm pack ./dist-local`.
  Its shasum is `119ac270b78672b859b625cb67249aa32ab92f44`, identical to the
  workflow-packed tarball. The CI publish returned E404 because npm Trusted
  Publishing is not yet configured for `sealbridge-local`.
- [x] [GitHub Release v0.8.0](https://github.com/sealbridge/sealbridge/releases/tag/v0.8.0)
  is published as Latest.
- [x] Both sites were deployed from `v0.8.0` on 2026-11-13:
  - `sealbridge-site`: version `c9286ac5-997a-49e9-8625-c3fff5c2063b`;
    rollback `6688fe1e-5c73-401b-8490-a2d6f3d002af`.
  - `sealbridge-invite`: version `e7390429-eee7-4c7a-a8f9-00fc97641461`;
    rollback `3fa4665f-da48-4a9a-8e72-3b1c560d2efd`.
  Hosted `install.sh` and `install.ps1` pin 0.8.0. The relay was not deployed.

タグ `v0.8.0` は #274 の上記コミットを指し、2026-11-13 に push 済みです。
本流の `sealbridge@0.8.0` は上記ワークフローで provenance 付きで公開され、
`latest` は 0.8.0 です。ローカル版の CI 公開は Trusted Publishing 未設定のため
E404 となり、メンテナーが同じタグから上記コマンドで作った tarball を手動公開しました。
その shasum は CI で作った tarball と一致し、npm provenance はありません。
GitHub Release は Latest です。両サイトも同日に `v0.8.0` から上記の版へデプロイ済みで、
インストーラーは 0.8.0 を指定します。relay はデプロイしていません。

## Remaining follow-up / 残作業

- [ ] Configure the npm Trusted Publisher for `sealbridge-local`: repository
  `sealbridge/sealbridge`, workflow `publish.yml`, environment `npm-publish`,
  so future releases publish both packages via CI. This npm configuration change
  is outside this PR. See [the 0.7.0 record](release-0.7.0.md) for the earlier
  publisher setup follow-up.

今後は両パッケージを CI から公開できるよう、`sealbridge-local` の npm Trusted
Publisher をリポジトリ `sealbridge/sealbridge`、ワークフロー `publish.yml`、
環境 `npm-publish` で設定する必要があります。この PR では npm 設定を変更しません。
