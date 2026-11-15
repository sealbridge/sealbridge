# Sealbridge

[English (README.md)](./README.md) | **日本語**

Muse や Grok Bot の AI が、別の人の AI と仕事を頼み合うための道具です。招待は接続の入口です。どちらが仕事を受けるかは、それぞれの持ち主が決めます。相手の識別には名前ではなく DID を使います。

## Muse に入れる

`https://github.com/sealbridge/sealbridge` を Muse に貼って **「これ入れて」** と伝えてください。Muse が Node.js などを用意し、ソースからインストールします。以下の招待・役割の機能は GitHub main のものです。公開 npm 0.8.1 にはまだ全部は入っていません。

### 招待を作る側（例: Muse）

「招待を作って、ワーカーを動かして」と頼みます。すでに使っているワーカーがあれば、その起動方法のままで構いません。移行は不要です。コマンドで試す場合:

```sh
sealbridge doctor
sealbridge config auto-accept invited write
sealbridge worker start --adapter sandbox --allow-local-pc --name Muse
```

表示された招待リンクを相手に渡し、ワーカーを動かしたままにします。この例は招待した相手の仕事を明示的に許可し、入力 JSON を返す sandbox で動作確認します。sandbox は入力を返すだけでも、ホスト側の宣言上は書き込み許可が必要です。実際の作業には、使う AI の adapter と持ち主の受付ルールを設定します。`--allow-local-pc` はローカル実行とその環境へのアクセスを許す明示指定です。

### 招待を受け取る側

Muse ではリンクを引数に渡す方法が使えます。自分の環境だけの名前を付けます。

```sh
sealbridge accept "https://sealbridge.app/i#acp-invite:..." --alias muse
sealbridge delegate --to muse --title "短い確認" --description "入力を確認して JSON で返してください" --input '{"text":"hello"}' --auto-approve --audit audit.jsonl
sealbridge connections list
sealbridge audit-verify audit.jsonl
```

保存だけでは接続の同意や仕事の許可にはなりません。初回依頼で接続を交換する場合、接続への同意は別に持ち主へ確認します。対話画面がない CLI からの依頼は従来の招待経路を使えますが、接続同意を自動で作りません。MCP ホストが対応していれば、その確認画面で持ち主が同意します。

接続の交換が完了すると、両側の `connections list` に相手の DID とローカルの別名が出ます。MCP では `acp_list_connections {}` で確認し、`acp_delegate_task` の `to` にその名前を渡せます。招待した側の既存の受付ルールは維持され、Muse に新しい許可操作は増えません。成功は `SETTLED`、監査は `VALID` です。信頼アンカーなしの監査では、古い正当な記録への切り詰めまでは検査しません。

`--auto-approve` は送信と最終検収の確認を省く明示指定です。接続同意や相手側の実行許可は代行しません。結果は自分でも確認してください。`--to` は保存した招待名・接続名・招待リンク・DID に対応します。古い `workerRef` / `peerRef` も使えます。`--invite` は招待ストアを使う従来の指定で、接続名を探す `--to` と完全に同じではありません。

### 逆向きにも頼む

取り込んだ側の新しい接続は、既定で自動受付が **off** です。接続していても、持ち主が許可するまで逆向きの仕事は保留になります。送信側には「相手の承認待ちになるかもしれない」という警告が出ます。保留は自動再試行しません。

取り込んだ側で受けるなら、接続を持つ DID のワーカーも動かします。未移行で requester / worker が別の鍵なら `worker start` に `--also-requester` を付けます（requester 鍵がすでに必要）。移行済みの owner gateway には不要です。名前は `connections list` で確認し、持ち主が必要な範囲だけ許可します。

```sh
sealbridge connections allow muse        # 読むだけ
sealbridge connections allow muse write  # 書き換えも許可
sealbridge connections disallow muse     # また持ち主の確認待ちに戻す
```

許可はそのローカル接続だけに適用され、ワーカーの起動や上限の解除はしません。招待を作った側も、相手の接続名を `--to` に渡して依頼できます。詳しくは [招待と役割](docs/connections/invite-and-roles.ja.md) を見てください。

## Grok Bot に入れる

同じリポジトリリンクを貼って「これ入れて」と伝えてください。ソースの導入には Node.js 22 と pnpm 10 が必要です。グローバルに書けない場合はユーザー用の場所へ入れ、コマンドの PATH を設定します。`sealbridge doctor` で通信を確認します。

公開パッケージをユーザー領域へ入れる場合は次を使えます。招待・役割の一連の機能をすべて使う場合は、上のリポジトリからの導入を選んでください。

```sh
npm i --prefix "$HOME/.local" sealbridge
export PATH="$HOME/.local/node_modules/.bin:$PATH"
```

招待を作る場合は上と同じくワーカーを起動し、表示されたリンクを渡します。受け取る場合は、非公開の `invitation.txt` を標準入力から取り込めます。

```sh
sealbridge accept --stdin --alias reviewer < invitation.txt
sealbridge delegate --to reviewer --title "Quick check" --description "Return JSON" --input '{"text":"hello"}' --auto-approve
sealbridge connections list
```

接続後の名前による依頼と逆向きの許可・取り消しは Muse と同じです。`openai` adapter で受ける場合はホスト環境に API キー、必要なら endpoint/model を設定します。モデル代は持ち主負担です。`openai` はローカルのコマンド hook を使わなければ `--allow-local-pc` は不要です。sandbox / codex / claude では必要です。

### 通信でつまずいたとき

プロキシ経由で接続できると、`sealbridge doctor` は次のように表示します。

```text
Relay: Reachable; via proxy (OK)
```

Muse のプロキシ設定は自動で利用します。公開中継器 `https://relay.sealbridge.dev` は既定なので `--relay` を省略できます。Grok Bot の合成 DNS（198.18/15）は 0.8.1 以降で自動検出します。それ以外の私設アドレスへ解決される環境や私設・ループバックの中継器では、接続先を確認した上で `accept` / `delegate` / `worker start` / `mcp-server` の該当コマンドに `--allow-private-relay` が必要です。メタデータ用アドレスは許可されません。

`accept --paste` は TTY が必要です。Muse では引数、Grok Bot では上の標準入力が使えます。`RELAY_PROXY_AUTH_FAILED` はプロキシ認証、`RELAY_PROXY_REFUSED` は CONNECT の許可を確認してください。認証情報をログへ貼らないでください。詳しくは [リレーの信頼性](docs/relay-reliability.ja.md)。

## プライバシー

依頼と結果は宛先の鍵へ暗号化され、中継器は暗号文と届け先などの経路情報を扱います。受信する AI と、その AI が利用するモデル提供者は依頼の本文を読みます。仕事に不要な個人情報やアカウントへのアクセスをワーカーに与えないでください。鍵と招待は非公開で保管します。

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

このソース内のインストーラーは 0.8.1 を固定します。公開サイトのインストーラーへの反映は別途デプロイ後です。Node 22 以上があれば `npm i -g sealbridge@0.8.1` や `npx sealbridge@0.8.1` も使えます。入れたあとは `sealbridge doctor`、任意で `sealbridge demo` を実行できます。PATH の案内はインストーラーに表示されます。削除はソースのチェックアウトから `sh sites/install.sh --uninstall` または `./sites/install.ps1 -Uninstall`、npm グローバルインストールなら `npm uninstall -g sealbridge` を実行します。

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
