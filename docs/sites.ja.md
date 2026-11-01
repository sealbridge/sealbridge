# 公式サイトとプライベート招待受信ページ

[English](sites.md) | **日本語**

`sites/` は独立した 2 つの Cloudflare Workers 静的アセットを生成します。
ビルドや CI は公開しません。サーバーアプリ、解析、外部フォント、CDN スクリプト、
外部 QR サービスは使用しません。

| 想定ホスト | アセット | 設定 |
| --- | --- | --- |
| sealbridge.dev | `sites/dist/site` | `sites/wrangler.site.jsonc`（`sealbridge-site`） |
| sealbridge.app | `sites/dist/invite` | `sites/wrangler.invite.jsonc`（`sealbridge-invite`） |

`sites/connect-agent.txt` を変更せず `/connect-agent.txt` へコピーし、ヘッダーで
`text/plain; charset=utf-8` を指定します。トップ・インストールページからリンクします。
ローカル設定、ホスト再読込、人間による招待取込、オープンワーカー検索と通信範囲を記載します。
別途提供のコマンド・ツールは対応リリースが必要です。この経路に新しい実行環境や公開操作はありません。

## ビルドとプレビュー

Node.js 22 と pnpm 10 を使い、リポジトリ直下で実行します。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @sealbridge/sites preview
```

公式サイトは `http://127.0.0.1:4173`、招待受信は `http://127.0.0.1:4174/i`
で確認できます。終了は Ctrl-C。リクエストをログに出力せず、アセットの `_headers`
と同じポリシーを適用しますが、Cloudflare のルーティング全体を再現するものではありません。

サイトだけの再ビルドは `pnpm --filter @sealbridge/sites build` です。
紹介ページの文言は `sites/build.mjs` にあります。文書はルートの README、UX_LAYER、
SECURITY、SECURITY_PROOF と日本語版、および `docs/` 以下の全 Markdown から
ビルド時に生成します。生成 HTML ではなく原本を編集してください。文書間リンクを
生成ページに変換し、コードへのリンクは GitHub に向けます。HTML はサニタイズし、
外部画像は省きます。言語切り替えは対応訳があれば開き、未翻訳なら原文の言語を明記します。

## 招待の検証とプライバシー

標準リンクは `https://sealbridge.app/i#acp-invite:…` です。`location.hash` だけを
読み取り、クエリをトークンとして受け付けません。フラグメントは HTTP 通信には
含まれません。クエリやパスはページの処理前にサーバーへ届くため、招待を入れないでください。
コピーとローカル QR は同じ完全なリンクを使い、短縮しません。容量超過なら QR の代わりに
案内を表示します。リンクはそのまま利用できます。招待は意図した相手だけに共有し、
診断ログやストレージへ内容を保存しないでください。

ブラウザーバンドルは既存 core の `parseAndVerifyInviteToken` を使用します。
esbuild 専用の `node:crypto` アダプターはローカル同梱の Noble Ed25519
（厳密な RFC 8032 検証）と SHA-256 を使い、小さな Buffer アダプターが base64url を
扱います。core の RFC 8785 正規化、ダイジェストとメタデータ、DID、カードと委任署名、
中継 URL 制限、有効期限の検証は変更せず再利用します。秘密鍵・暗号化の操作は呼び出すと
失敗します。ブラウザーは検証専用です。プロトコルやワイヤー形式は変えません。

ページは中継器への fetch、トークン送信、ストレージ保存、入力のログ出力を行いません。
`connect-src 'none'` でも通信を制限します。スクリプトと CSS はすべてローカルで、
インラインスクリプトを許可しません。`_headers` に `default-src 'self'`、
`frame-ancestors 'none'`、`form-action 'none'`、`base-uri 'none'`、
`Referrer-Policy: no-referrer` などを設定します。Cloudflare Web Analytics、
browser insights、スクリプト挿入、外部フォントなどをホストに追加しないでください。

署名は鍵の管理を証明し、実社会の本人確認はしません。このオフラインページでは失効や
現在の稼働状況は分からず、接続時に確認します。ブラウザーは連絡先保存や仕事の承認を
行いません。署名検証後、依頼者に 1 行インストール、初回の鍵作成、ローカルの
`code.diff` 保存を案内します。`sealbridge delegate --to "https://sealbridge.app/i#..."
--input-file code.diff` の例は、検証した相手に直接レビューを依頼します。CLI が招待を
再検証し、差分を暗号化して中継器経由で送ります。相手が依頼を承認し、依頼者は結果を
読んでから最終承認します。ページを開くだけでは依頼の送信や承認は行いません。

## テスト

```sh
pnpm --filter @sealbridge/sites exec playwright install chromium
pnpm --filter @sealbridge/sites test
```

3 OS の CI はビルド、ブラウザーテスト、既存の適合テストを実行します。
テスト用の一時的な鍵で、有効・改ざん・期限切れの招待、別エージェントへの委任、
フラグメント変更、悪意のある表示文字列、QR 容量、通信・ログ・ストレージの非漏洩、
コピー動作、公開用ヘッダーを確認します。

## 公開の引き継ぎ（別途承認が必要）

この変更は設定のみです。レビュー後、承認された担当者が Cloudflare Wrangler の
`--config sites/wrangler.site.jsonc` または `--config sites/wrangler.invite.jsonc`
でアセットをアップロードできます。既存アカウントで sealbridge.dev を `sealbridge-site`、
sealbridge.app を `sealbridge-invite` に接続する操作は別途承認を受けてください。
設定にはルート、アカウント認証情報、DNS 変更を含めず、Workers 開発・プレビュー URL は
無効です。公開後は `/`、`/ja/`、生成文書、`/i`、テスト用招待を実際のホストで確認してから
案内します。レスポンスの CSP と referrer policy、およびアカウント側でスクリプトが
挿入されないことを確認してください。Cloudflare の
[静的アセットヘッダー](https://developers.cloudflare.com/workers/static-assets/headers/) と
[ルーティング設定](https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/)
を参照してください。

## 中継 URL の互換性

新規設定は `https://relay.sealbridge.dev` を推奨します。
従来の `https://acp-relay.agent-collab.workers.dev` も同じ中継器とデータで利用できます。
署名済み招待は編集せず、元のホストを許可してください。MCP の許可リストには使用する
ホストを明示します。同じデータでも、オリジンに結合した認証では両 URL を交換できません。
