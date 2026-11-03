# 公式サイトとプライベート招待受信ページ

[English](sites.md) | **日本語**

`sites/` は独立した 2 つの Cloudflare Workers アセットを生成します。公式サイトには
`/media/*` のバイト範囲を処理する小さな Worker も含みます。ビルドや CI は公開しません。
解析、外部フォント、CDN スクリプト、外部 QR サービスは使用しません。

| 想定ホスト | アセット | 設定 |
| --- | --- | --- |
| sealbridge.dev | `sites/dist/site` | `sites/wrangler.site.jsonc`（`sealbridge-site`） |
| sealbridge.app | `sites/dist/invite` | `sites/wrangler.invite.jsonc`（`sealbridge-invite`） |

英語・日本語のトップページでは、ヒーローの直下に30秒のコードレビュー実演を表示します。
動画に音声はありません。英語字幕は映像に含まれ、文字起こしも読めます。
音声トラックはストリームコピーで除去し、映像は変更していません。ビルドは `docs/media/` の
映像のみの WebM・MP4 と変更のないポスターを公式サイトの `/media/` にコピーします。再生コントロールを
表示し、動きを減らす設定ではローカルスクリプトが再生を停止して自動再生を無効にします。
本番とプレビューは再生とシーク用のメディア MIME 型とバイト範囲リクエストに対応します。

`sites/connect-agent.txt` を変更せず `/connect-agent.txt` へコピーし、ヘッダーで
`text/plain; charset=utf-8` を指定します。トップ・インストールページからリンクします。
ローカル設定、ホスト再読込、人間による招待取込、オープンワーカー検索と通信範囲を記載します。
これらのコマンド・ツールは sealbridge 0.3.0（CLI 0.3.0 以降）から利用できます。この経路に新しい実行環境や公開操作はありません。

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

3 OS の CI はビルド、Node 単体テスト、ブラウザーテスト、既存の適合テストを実行します。
`pnpm --filter @sealbridge/sites test:unit` で本番 Worker のテストだけを実行できます。
範囲の本文、GET/HEAD の一致、ETag 処理、`_headers` の共通ポリシーにある全ヘッダーの一致を確認します。
ブラウザーテストは一時的な鍵で、有効・改ざん・期限切れの招待、別エージェントへの委任、
フラグメント変更、悪意のある表示文字列、QR 容量、通信・ログ・ストレージの非漏洩、
コピー動作、公開用ヘッダーを確認します。

## 公開の引き継ぎ（別途承認が必要）

レビュー後、承認された担当者が Cloudflare Wrangler の
`--config sites/wrangler.site.jsonc` または `--config sites/wrangler.invite.jsonc`
で公式サイトの Worker とアセット、または招待受信の静的アセットをアップロードできます。
公式サイトは `main: "./site-worker.mjs"`、`ASSETS` バインディング、
`run_worker_first: ["/media/*"]` を設定します。他の経路はアセット優先のままで、
招待受信は静的アセットのみです。出力先は `sites/dist/site` のままです。
Worker のソースモジュールはその外に置き、公開アセットには含めません。

既存の `/media/*` アセットへの GET は単一の `bytes=a-b`、`bytes=a-`、`bytes=-N`
に対して `206`、`Content-Range: bytes a-b/size`、選択範囲の `Content-Length` を返します。
末尾がサイズを超える場合は切り詰め、大きすぎる接尾範囲は全体を `206` で返します。
開始位置がサイズ以上、または接尾範囲がゼロなら、空の `416`、
`Content-Range: bytes */size`、`Content-Length: 0` を返します。Range なし、不正な指定
（開始・終了の逆転を含む）、複数範囲は全体の `200` にフォールバックします。
これらはすべて `Accept-Ranges: bytes` を付けます。HEAD は本文なしで GET と同じ状態と
ヘッダーを返します。If-Range は強い ETag が完全一致する場合だけ範囲を適用し、
弱いタグ、日付、不一致は全体の `200` にします。他の条件付きリクエストとアセットの
エラーは元の状態を保ちます。

Worker は Range と If-Range を除き、identity エンコードを指定して `env.ASSETS` から
全体を取得します。範囲指定時は現在約 3 MB の動画をバッファーして切り出し、通常の
全体 GET はストリームで返します。Content-Type、ETag、その他のアセットヘッダーを保持します。
全体 HEAD はアセットの Content-Length を保持し、ヘッダーがなければ本文を計測した後、
本文なしで返します。
Cloudflare は Worker が生成した応答に `_headers` を自動適用しないため、CSP、
Referrer-Policy、X-Content-Type-Options、X-Frame-Options、Permissions-Policy と
同等の値をエラー時も明示的に付けます。`sites/_headers` と Worker のポリシーを
同期してください。単体テストで一致を確認します。

サイトをビルド後、Wrangler 4.156.1 で本番経路をローカル確認できます。
設定済みの互換性日付 `2026-10-29` で動作確認済みです。
Wrangler 4.151.1 に同梱された workerd は、この日付をローカルで拒否します。

```sh
cd sites
wrangler dev --config wrangler.site.jsonc --local --port 8787
```

別の端末から `http://127.0.0.1:8787/media/sealbridge-demo.mp4` へ GET と HEAD を送り、
`Range: bytes=0-1`、`bytes=-100`、`bytes=99999999-` などを確認します。
互換性日付は設定済みの `2026-10-29` を使います。本番への反映は別途承認された
サイトのデプロイ後です。

既存アカウントで sealbridge.dev を `sealbridge-site`、
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
