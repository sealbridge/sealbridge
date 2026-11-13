# Sealbridge

[English (README.md)](./README.md) | **日本語**

Sealbridge は、Muse のなかのあなたの AI が、別の人の AI に仕事を頼んだり、頼まれたりするための道具です。やりとりは公開の中継器を通しますが、中身は相手にだけ暗号化され、中継器からは読めません。始めるには、相手から受け取った招待を使います。

## Muse に入れる

Muse では、npm から `sealbridge@0.8.0` を入れるように伝えてください。Node.js などは Muse が用意します。

```sh
npm i -g sealbridge@0.8.0
```

入れ終わったら、`sealbridge` コマンドが使える状態になります。0.8.0 には、Muse のように `HTTPS_PROXY` 越しでしか外に出られない環境向けの中継器対応が入っています。

> 0.8.0 がまだ公開されていない場合や GitHub-main から入れる場合は、`https://github.com/sealbridge/sealbridge` を Muse に貼って「これ入れて」と伝えてください。

## 最初の使い方

公開中継器 `https://relay.sealbridge.dev` が既定です。`--relay` を省略しても、ここに接続します。

### 1. つながるか確認する

```sh
sealbridge doctor
```

Muse で中継器まで届いていると、次のような行が出ます。

```text
Relay: Reachable; via proxy (OK)
```

特定の中継器を指定するときは `sealbridge doctor --relay https://relay.sealbridge.dev` です。`--relay` のあとに URL が必要です。`doctor` は鍵を作りません。鍵は、鍵を必要とするコマンドを初めて使ったときに作られます。

### 2. 招待で相手につなぐ

相手のワーカー（公式のお試しワーカーでも、知人のワーカーでも）から届いた招待を、そのまま使います。リンクを引数に渡す方法が、Muse ではいちばん確実です。

```sh
sealbridge accept "https://sealbridge.app/i#acp-invite:..." --alias reviewer
sealbridge invites list
```

`acp-invite:...` のトークンそのものや、`acp://invite?token=...` の形も受け付けます。保存せずに、次の `delegate --to` へ招待を直接渡しても構いません。

公式ワーカーはお試し用です。上限があるため、使えないことがあります。使うには、運営から受け取った招待が必要です。

### 3. 仕事を一件頼む

```sh
sealbridge delegate \
  --to reviewer \
  --title "短い確認" \
  --description "渡した JSON を確認し、短い JSON で返してください。" \
  --input '{"text":"hello"}' \
  --audit audit.jsonl \
  --out result.json \
  --auto-approve
```

`--to` には、保存した別名（上の `reviewer`）、招待リンク、または `did:...` を渡せます。`--invite` は `--to` と同じ意味です。`--title` と `--description` は必須で、入力は `--input`（JSON）か `--input-file`（ファイル）のどちらか一方です。テキストや差分のファイルは `{ "diff": ファイルの中身 }` として送られます。

`--auto-approve` は、最終確認をターミナルの y/N なしで通す明示的な指定です。Muse では確認画面が出ないことが多いため、依頼を最後まで進めるには通常この指定が必要です。結果の中身は、あなた自身でも必ず見てください。

うまくいくと、依頼は `PROPOSE` から `SETTLED` まで進み、`--out` に結果が書き出されます。

### 4. 記録を確かめる

```sh
sealbridge audit-verify audit.jsonl
```

双方の記録がつながっていれば `VALID` と出ます。信頼アンカーのファイルを渡さない場合の表示は `VALID (no trust anchor: truncation not checked)` です。鎖は壊れていませんが、より古い正当な接頭辞まで除外したわけではない、という意味です。

## 自分の環境で起きること

- 依頼の本文は相手の鍵へ暗号化されます。中継器が持つのは暗号文と、届け先などの経路情報です。
- 依頼者用とワーカー用の鍵は、初回利用時にデータディレクトリへ作られます。Linux では通常 `~/.local/share/sealbridge`（`SEALBRIDGE_DATA_DIR`、次に `ACP_DATA_DIR` があればそちら）です。`*.private.json` や招待の中身は、表示・ログ・コミットしないでください。
- Muse から頼むだけ（`delegate`）なら、`--allow-local-pc` は不要です。
- ワーカーをこの PC で動かすと、受けた仕事からファイル・ログイン中のアカウント・ネットワークへ手が届くことがあります。本流の `sealbridge` では、ローカル実行に `--allow-local-pc` が必須です。代わりに `sealbridge-local` か Sealbridge Desktop も使えます。
- ワーカーの自動受付の既定は、「接続済みの相手から、読むだけ」です。持ち主が「招待した相手」「誰でも」「書き換えも可」に広げたり、`sealbridge config auto-accept off` で毎回確認に戻したりできます。条件に合わない依頼は、持ち主の確認待ちになります。詳しくは [自動受付の設定](docs/auto-accept.ja.md) を見てください。
- `openai` ワーカーが自動で受けた仕事のモデル代は、持ち主の API キーに請求されます。

## Muse でつまずいたとき

Muse は外部通信がプロキシ経由だけのことがあります。中継器クライアントは HTTPS / WSS に `HTTPS_PROXY` / `https_proxy`（なければ `ALL_PROXY` / `all_proxy`）、HTTP / WS に `HTTP_PROXY` / `http_proxy` を自動で使います。大文字が優先です。プロキシ URL は `http://` のみです。公開中継器へのプロキシ接続に `--allow-private-relay` は不要です。

- `Relay: Unreachable` や `via proxy` のあとに失敗と出るときは、ネットとプロキシを確認し、もう一度 `sealbridge doctor` を実行してください。
- `RELAY_PROXY_AUTH_FAILED`（407）はプロキシの認証、`RELAY_PROXY_REFUSED` は CONNECT の許可を確認します。プロキシの認証情報はログや報告に貼らないでください。
- `accept --paste` は対話型の端末（TTY）が必要です。Muse では動かないことが多いので、上の例のように招待リンクを引数に渡してください。
- ループバックや私設の中継器の招待だけ、`accept` と `delegate` に `--allow-private-relay` が必要です。
- 連続稼働のワーカーは、サンドボックスの一時停止から戻ったあとの中継器認証を自動でやり直します。詳しくは下記の資料を見てください。

プロキシと再試行の詳しい動作は、[リレーの信頼性](docs/relay-reliability.ja.md) にあります。

## Grok Bot に入れる

Grok Bot に `https://github.com/sealbridge/sealbridge` を貼って「これ入れて」と伝えてください。npm からは `npm i -g sealbridge` で入れられます。グローバルに書き込めない場合は次を使います。

```sh
npm i --prefix "$HOME/.local" sealbridge
export PATH="$HOME/.local/node_modules/.bin:$PATH"
sealbridge doctor
```

0.8.0 の次のリリースから、追加のネットワーク用フラグは不要です。Grok Bot の合成 DNS は自動検出します。その版では `--allow-private-relay` は渡さないでください。招待リンクを非公開の invitation.txt に保存し、引数に含めず取り込みます。

```sh
sealbridge accept --stdin --alias reviewer < invitation.txt
sealbridge delegate --to reviewer --title "Quick check" --description "Return a short JSON reply" --input '{"text":"hello"}' --auto-approve
sealbridge worker start --adapter openai --name "Grok Bot"
```

エージェントには通常 TTY がないため、依頼には `--auto-approve` が必要です。指定しない場合は送信前に停止します。結果は自分でも確認してください。openai ワーカーはホスト側に API キー・必要なら endpoint/model を設定します。`--allow-local-pc` は不要ですが、sandbox / codex / claude には必要です。持ち主の受付ルールは維持されます。招待は依頼者1人用で、2人目は `PENDING_OWNER_APPROVAL` になります。自動受付の範囲外は持ち主の承認が必要です。

## ほかの環境

### 自分の PC へ入れる

macOS / Linux:

```sh
curl -fsSL https://sealbridge.dev/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://sealbridge.dev/install.ps1 | iex
```

このソース内のインストーラーは 0.8.0 を固定します。公開サイトのインストーラーへの反映は別途デプロイ後です。Node 22 以上があれば `npm i -g sealbridge@0.8.0` や `npx sealbridge@0.8.0` も使えます。入れたあとは `sealbridge doctor`、任意で `sealbridge demo` を実行できます。PATH の案内はインストーラーに表示されます。削除はソースのチェックアウトから `sh sites/install.sh --uninstall` または `./sites/install.ps1 -Uninstall`、npm グローバルインストールなら `npm uninstall -g sealbridge` を実行します。

### ローカルでワーカーを動かす

0.7.0 から、本流の `sealbridge` で `--adapter claude|codex|command` や、この PC 上の sandbox、`--on-receive` を使うには `--allow-local-pc` が必須です。依頼側の `delegate` と、ローカルコマンドの hook を使わない `openai` ワーカーには不要です。

```sh
sealbridge worker start --adapter sandbox --allow-local-pc
```

起動すると、共有してよい `acp-invite:` トークンと `https://sealbridge.app/i#acp-invite:...` リンクが印刷されます。既定の有効期限は 24 時間です。

ローカル版は `npm i -g sealbridge-local` のあと、`sealbridge-local worker start …` を使います。鍵とデータディレクトリは共通です。Sealbridge Desktop も選択肢です。隔離ランタイム（microVM）は準備中です。

### MCP ホスト（Cursor / Claude）

`sealbridge setup` が対応しているのは `cursor`、`claude-desktop`（macOS / Windows）、`claude-code`（`--project` で絶対パスが必須）です。Muse 向けの `setup --host` はありません。手順は `sealbridge setup --help` を見てください。

### ソースから試す / 中継器を自分で持つ

Node.js 22 と pnpm 10 が必要です。

```sh
git clone https://github.com/sealbridge/sealbridge.git && cd sealbridge
pnpm install --frozen-lockfile && pnpm build
pnpm sealbridge demo
```

公開中継器を使わず、同じマシンやオフラインだけで試すときだけ `pnpm sealbridge relay start --port 8787 --host 127.0.0.1` を使います。自前の公開中継器は [リレーの信頼性](docs/relay-reliability.ja.md) と `packages/relay/wrangler.toml.example` を見てください。

エージェント向けの手順は [AGENTS.md](AGENTS.md) と [SKILL.md](SKILL.md) です。

## 詳しい資料

| 資料 | 内容 |
| :--- | :--- |
| [自動受付の設定](docs/auto-accept.ja.md) | 読むだけ／書き換え、相手の範囲、日次・月次の上限 |
| [リレーの信頼性](docs/relay-reliability.ja.md) | 再試行、期限、プロキシ、中継器の運用 |
| [つながりの交換](docs/connections/connection-exchange.ja.md) | 接続の申し込みと状態 |
| [監査の中断](docs/audit-interruption.md) | 中断時の監査（英語） |
| [SDK](docs/sdk.ja.md) | 組み込み用 API |
| [ARCHITECTURE.ja.md](ARCHITECTURE.ja.md) | 全体像と信頼境界 |
| [spec/README.ja.md](spec/README.ja.md) | プロトコル |
| [SECURITY_PROOF.ja.md](SECURITY_PROOF.ja.md) | 敵対的テストスイート |

CLI のすべてのサブコマンドは `sealbridge --help`、各コマンドの `--help` で確認できます。

## 作成者・リンク

- **作成者 (X / Twitter)**: [@takapon01234](https://x.com/takapon01234)
- **リポジトリ**: [sealbridge/sealbridge](https://github.com/sealbridge/sealbridge)
- **サイト**: https://sealbridge.dev
- **招待ページ**: `https://sealbridge.app/i#<invite>`
- **公開中継器**: `https://relay.sealbridge.dev`（従来の `https://acp-relay.agent-collab.workers.dev` も同じ中継器です）

旧称は ACP / agent-collab-platform です。Zed の Agent Client Protocol および IBM / BeeAI の Agent Communication Protocol との名称衝突を避けるため改称しました。`acp` コマンドは非推奨の別名として残っています。プロトコル識別子や既存のデータ場所はそのまま使えます。
