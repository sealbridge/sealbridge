# Sealbridge への貢献

[English](CONTRIBUTING.md)

## 開発環境

Sealbridge は Node.js 22 以降をサポートし（現在の実効的な最低バージョンは 22）、CI は Node 22 と Node 24 でテストし、公開パッケージは Node 22 でビルドし、インストーラーは Node を導入する際に 22.22.0 に固定しますが、動作する同梱 npm がある既存の Node 22 以降は再利用します。

Git、Node.js 22 以降、pnpm 10 を用意してください。`package.json` が指定する
`pnpm@10.34.6` を使い、リポジトリ直下で実行します。

```sh
git clone https://github.com/sealbridge/sealbridge.git
cd sealbridge
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck
pnpm validate:schemas
```

`pnpm conformance` と `pnpm test` は同じ Vitest のテストを実行します。
個別のテストは `pnpm exec vitest run conformance/doctor.test.ts`、
セキュリティ検証は `pnpm test:security-proof` で実行できます。
ソースからの CLI の確認には `pnpm sealbridge --help` を使います。
ビルド済み CLI のテストが使うソースを変更したら再ビルドしてください。

## 変更と検証

最新の `main` から作業ブランチを作り、変更の目的を絞ってください。
動作を変更する場合は関連テストを追加・更新し、日英の文書を揃えます。
秘密鍵、認証情報、有効な招待トークン、非公開の仕事の内容をコミットせず、
テスト用データを使い、ログから機密情報を削除してください。

PR を作る前に上記のチェックを実行し、未実行のものを明記します。
PR は Node.js 22 と 24 を使う macOS・Ubuntu・Windows の必須 conformance CI を
すべて通過する必要があります。CI は実際の Codex のプロキシ経路、静的サイト、
セキュリティ検証、デモも確認します。インストーラーのチェックは別途実行されます。
正確な手順は [CI ワークフロー](.github/workflows/conformance.yml) を参照してください。
ローカルの検証に加え、必須 CI の通過が必要です。

コミットの件名は `fix: 利用者に影響する修正内容` や `docs: セットアップの説明を改善`
のような Conventional Commits 形式にします。コミットと PR の目的を絞り、
問題、利用者から見た変更後の動作、関連 Issue、テスト結果と検証の制約を記載します。
動作やセットアップを変更したら文書も更新してください。

## Issue とセキュリティ

セキュリティ以外の問題にはバグ報告・機能要望フォームを使います。
バグ報告にはバージョンまたはコミットと最小限の再現手順を記載してください。
**未修正の脆弱性を公開 Issue や PR で報告しないでください。**
非公開の報告方法は [セキュリティ報告方針](SECURITY.ja.md) を参照してください。
GitHub の非公開フォームが利用できない場合のメール窓口も記載しています。
