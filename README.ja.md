# Sealbridge

[English (README.md)](./README.md) | **日本語**

**友だちの AI エージェントに、自分のコードをレビューしてもらえます。相手のモデルが違っても大丈夫です。**

あなたのエージェントがレビューを依頼します。友だちのエージェント（Claude、Codex、OpenAI のモデルなど）がレビューし、署名付きの結果を返します。間の中継器は暗号化されたデータを運ぶだけで、コードを読めません。ただし、レビューする相手のエージェントとそのモデル提供者はコードを読めます。両者に共有してよいコードだけを送ってください。

## 友だちのエージェントにコードレビューを頼む

友だちがまだ Sealbridge を入れていなければ、先に[自分の PC へ入れる](#自分の-pc-へ入れる)を参照してください。

1. レビューする側が AI の adapter と持ち主の受付ルールを設定してワーカーを起動し、招待リンクを送ります。
2. あなたは `sealbridge accept` でリンクを取り込み、`sealbridge delegate`（または MCP クライアント）でレビューを依頼します。
3. 結果はご自身で確認します。双方で `--audit` を指定して署名付きの監査ログを保存し、`sealbridge audit-verify` で検証できます。

何を受けるかは、それぞれの持ち主が決めます。招待を取り込んだだけでは、何も承認されません。相手の識別には名前ではなく DID を使います。ほかの使い方（複数ワーカー、ジョブボード、ローカルのワーカーなど）は、この下の節と [docs](docs/) にあります。

開発環境と PR の手順: [貢献ガイド](CONTRIBUTING.ja.md)。

Muse や Grok Bot からも使えます。

## Muse に入れる

`https://github.com/sealbridge/sealbridge` を Muse に貼って **「これ入れて」** と伝えてください。Muse が Node.js などを用意し、ソースからインストールします。0.10.1 は npm 公開準備中です。公開後は Node.js 22 以上があれば `npm i -g sealbridge@0.10.1` または `npx sealbridge@0.10.1` を使えます。公開インストーラーは[後述](#自分の-pc-へ入れる)します。

### 招待を作る側（例: Muse）

「招待を作って、ワーカーを動かして」と頼みます。すでに使っているワーカーがあれば、その起動方法のままで構いません。移行は不要です。コマンドで試す場合:

```sh
sealbridge doctor
sealbridge config auto-accept invited write
sealbridge worker start --adapter sandbox --allow-local-pc --name Muse
```

表示された招待リンクを相手に渡し、ワーカーを動かしたままにします。この例は招待した相手の仕事を明示的に許可し、入力 JSON を返す sandbox で動作確認します。sandbox は読み取り専用アクセスを宣言します。既定のパスキー承認では、フォルダーの自動受付ルールを `write` にしても sandbox の読み取り専用へ制限されます。より強いローカル PC・書き込み経路を明示的に許可しない限り、書き込み作業には持ち主の承認が必要です。実際の作業には、使う AI の adapter と持ち主の受付ルールを設定します。`--allow-local-pc` はローカル実行とその環境へのアクセスを許す明示指定です。

### 招待を受け取る側

Muse ではリンクを引数に渡す方法が使えます。自分の環境だけの名前を付けます。

```sh
sealbridge accept "https://sealbridge.app/i#acp-invite:..." --alias muse
sealbridge delegate --to muse --title "短い確認" --description "入力を確認して JSON で返してください" --input '{"text":"hello"}' --auto-approve --audit audit.jsonl
sealbridge connections list
sealbridge audit-verify audit.jsonl
```

保存だけでは接続同意や仕事の許可にはなりません。非対話 CLI で招待先へ明示的に依頼を送ると、その送信が接続への同意になります。招待と一致する DID から署名付き ACCEPT を受信・検証した後、取り込んだ側にも接続を記録します。到達前の失敗、DID 不一致、`CONNECTION_TARGET_CONFLICT` では記録しません。単発送信には `--no-connect` を指定します。記録時は日英の通知と JSON の `connectionRecorded` が出ます。受信許可は **off** のままです。TTY の接続確認と MCP の `connect: true` フォームは従来どおりです。

接続記録は失敗しても受諾済みの作業を中断しません。日英の stderr と JSON の `connectionRecordWarning`（コード `CONNECTION_RECORD_FAILED`）で、delegate の再実行または TTY/MCP の確認で記録するよう案内します。失敗時は `connectionRecorded` を出しません。成功通知は既知のローカル名を使い、JSON には DID を保持します。stderr だけのリダイレクトでも非対話になります（stdin と stderr の両方が TTY である必要があります）。

`connections list` で相手 DID とローカル別名を確認してください。招待作成側の受付ルールは維持します。成功は `SETTLED`、検証済み監査は `VALID` です。信頼アンカーなしでは古い正当な記録への切り詰めは検査しません。

`--auto-approve` は送信と最終検収の確認を省く明示指定です。TTY の接続確認や相手側の実行許可は代行しません。非対話 CLI の接続同意は上記の明示的な送信によります。結果は自分でも確認してください。`--to` は保存した招待名・接続名・招待リンク・DID に対応します。古い `workerRef` / `peerRef` も使えます。`--invite` は招待ストアを使う従来の指定で、接続名を探す `--to` と完全に同じではありません。

### 逆向きにも頼む

上記の非対話 CLI で接続を記録した後、`connections list` で確認してください。取り込んだ側の新しい接続は、既定で自動受付が **off** です。接続していても、持ち主が許可するまで逆向きの仕事は保留になります。送信側には「相手の承認待ちになるかもしれない」という警告が出ます。保留は自動再試行しません。

取り込んだ側で受けるなら、接続を持つ DID のワーカーも動かします。未移行で requester / worker が別の鍵なら `worker start` に `--also-requester` を付けます（requester 鍵がすでに必要）。移行済みの owner gateway には不要です。接続名は `accept --alias` で保存した名前を使い、明示された保存名がなければ相手の表示名から作ります。通知と `connections list` は実際の名前を表示します。別の DID が保存名を使用中なら表示名から作った名前に切り替え、通知・JSON で衝突を案内します。以下は一覧の接続名が `muse` の例です。持ち主が必要な範囲だけ許可します。

```sh
sealbridge connections allow muse        # 読むだけ
sealbridge connections allow muse write  # 書き換えも許可
sealbridge connections disallow muse     # また持ち主の確認待ちに戻す
```

許可はそのローカル接続だけに適用され、ワーカーの起動や上限の解除はしません。招待を作った側も、相手の接続名を `--to` に渡して依頼できます。詳しくは [招待と役割](docs/connections/invite-and-roles.ja.md) を見てください。

## Grok Bot に入れる

同じリポジトリリンクを貼って「これ入れて」と伝えてください。ソースの導入には Node.js 22 以降と pnpm 10 が必要です。チェックアウト内で `pnpm install --frozen-lockfile` と `pnpm build` を実行した後、POSIX シェルでは次の関数で現在のシェルからソースのコマンドを使えます。グローバルへのインストールは不要です。

```sh
sealbridge_source="$PWD"
sealbridge() { node "$sealbridge_source/cli/dist/index.js" "$@"; }
sealbridge --version
```

チェックアウトはその場所に残してください。別のシェルでは絶対パスを指定して関数を再定義します。MCP はこのシェル関数ではなく、下の実行ファイル・パス指定で登録します。`sealbridge doctor` で通信を確認します。

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

非対話 CLI は招待先の署名付き ACCEPT を検証して取り込んだ側にも接続を記録します（`--no-connect` で省略）。逆向きに頼む前に、記録時の通知か `connections list` に表示された接続名で `connections allow <接続名>` を実行します。接続名は `accept --alias` で保存した名前を使い、明示された保存名がなければ相手の表示名から作ります。通知と `connections list` は実際の名前を表示します。別の DID が保存名を使用中なら表示名から作った名前に切り替え、通知・JSON で衝突を案内します。`openai` adapter で受ける場合はホスト環境に API キー、必要なら endpoint/model を設定します。モデル代は持ち主負担です。`openai` はローカルのコマンド hook を使わなければ `--allow-local-pc` は不要です。sandbox / codex / claude では必要です。

## 接続確認のために MCP を登録する

MCP `acp_create_invite` は未移行の既定設定では通常・共用（`maxUses`）招待の発行を `isError: true`・`error: INVITE_REQUESTER_LISTENER_REQUIRED` で拒否し、トークンも共用上限も作成しません。通常の `worker start` は別の worker 鍵だけで待ち受けるため、requester 鍵の招待を受信できません。発行するには `options.owner` または `mcp-server --key <file>` で受信 ID を明示するか、移行済み所有者ゲートウェイを使ってください。requester ID を明示して発行した後は、同じデータルート・鍵ストア設定で通常の adapter/relay オプションに `--also-requester` を追加してワーカーを起動してください。自動受付を選ぶ場合は `--requester-auto-accept read-only` または `--requester-auto-accept write` も追加します。それ以外は所有者の承認が必要です。代わりに `sealbridge invite create` で通常の `worker start` が受信できる worker 鍵の招待を発行できます。発行は待受を起動・検出しません。署名 ID・共用上限・プロトコル版は維持します。

MCP 対応ホストに、stdio コマンド `sealbridge mcp-server` を登録します。ホストは **確認フォームの elicitation**（`elicitation/create`）に対応し、持ち主へ接続確認を表示する必要があります。サーバーを起動しただけでは同意になりません。`acp_delegate_task`（例: `{ "peerRef": "muse", "title": "確認", "input": { "text": "hello" } }`）で依頼し、別の接続フォームで持ち主が `connect: true` に同意します。招待を取り込んだ CLI と同じ OS アカウント・データディレクトリ・鍵ストアの設定を使います。

ソースのチェックアウトを使う場合の一般的な登録例です。絶対パスを置き換えてください。設定形式はホストによって異なります。

```json
{
  "mcpServers": {
    "sealbridge": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/sealbridge/cli/dist/index.js", "mcp-server"]
    }
  }
}
```

Windows では `C:/path/to/node.exe` と `C:/path/to/sealbridge/cli/dist/index.js` などを指定します。中継器の環境で必要な場合だけ `args` に `--allow-private-relay` を加えます。ホストを再読込し、`acp_list_invites` に取り込んだ別名が出ることを確認してから、最初の依頼を送り、接続フォームで同意します。Muse / Grok Bot でこの stdio サーバーを登録でき、確認フォームも表示できるかは、ここでは検証できていません。利用ホストの MCP 設定を確認してください。MCP が使えない場合も、上記の非対話 CLI の手順で接続できます。TTY では接続確認に持ち主本人が回答します。

### 通信でつまずいたとき

プロキシ経由で接続できると、`sealbridge doctor` は次のように表示します。

```text
Relay: Reachable; via proxy (OK)
```

Muse のプロキシ設定は自動で利用します。公開中継器 `https://relay.sealbridge.dev` は既定なので `--relay` を省略できます。Grok Bot の合成 DNS（198.18/15）は 0.8.1 以降で自動検出します。それ以外の私設アドレスへ解決される環境や私設・ループバックの中継器では、接続先を確認した上で `accept` / `delegate` / `invite create` / `worker start` / `mcp-server` の該当コマンドに `--allow-private-relay` が必要です。メタデータ用アドレスは許可されません。

`accept --paste` は TTY が必要です。Muse では引数、Grok Bot では上の標準入力が使えます。`RELAY_PROXY_AUTH_FAILED` はプロキシ認証、`RELAY_PROXY_REFUSED` は CONNECT の許可を確認してください。認証情報をログへ貼らないでください。詳しくは [リレーの信頼性](docs/relay-reliability.ja.md)。

共用招待は `sealbridge invite create --max-uses N`（1〜1000の整数。例: 50）で発行し、再利用できるトークンか長い `/i#acp-invite:` リンクを共有します。発行側は署名付きの上限を保存し、異なる認証済み所有者 DID の人数を原子的に数えます。同じ DID の再利用で枠は増えず、切断してもブロックしても空きません。上限到達後の新しい所有者には `INVITE_USES_EXHAUSTED` を返します。省略時と `1` は最初の1人に結び付く従来の動きです。短い `/j` リンクの主張は1回のままで、1を超える `--max-uses` とは併用できません。招待は接続だけを作り、役割の指定や取り込み側の自動受付は行いません。[受付の説明](docs/connections/admission.ja.md)を参照してください。

ダウングレードの注意: 同じ共用招待に2人以上の所有者が結び付いた接続ストアは、0.9.0 以前では単独起動でも読み取れません。旧版は招待ダイジェストごとに結び付きを1件に制限するため、`connections list` は `INTAKE_STORE_INVALID` となり、旧ワーカーのタスクがタイムアウトしたり、ワーカーが終了したりします。アップグレード前、または共用招待を使い始める前に、データディレクトリをバックアップしてください。ダウングレードするときは、そのバックアップを戻してください。古いバイナリと新しい書き込みの同時実行を避けるだけでは不十分です。署名付きの結び付きを失わないよう #297 の保存形式を維持し、AgentInvite トークンとプロトコル 0.2.0 は変更しません。

## プライバシー

依頼と結果は宛先の鍵へ暗号化され、中継器は暗号文と届け先などの経路情報を扱います。受信する AI と、その AI が利用するモデル提供者は依頼の本文を読みます。暗号化しても、受信側が読んだ内容を保存・再利用することは防げません。仕事に不要な個人情報やアカウントへのアクセスをワーカーに与えないでください。鍵と招待は非公開で保管します。

サンドボックスの実行では、入力とコードをローカルの一時ファイルへ平文で保存します。OCI の後片付けは、プロセスの解放とコンテナーの削除を確認し、ディレクトリーとファイルの同一性を検査したうえで、Sealbridge 自身が作成した固定名のファイルだけを一度ずつ削除します。ゲストが作成したファイル、入れ子の出力、キャッシュ、ログは再帰削除しません。所有関係が未確認、使用中、置換済み、削除失敗、I/O 未完了の場合、平文が残ることがあります。既存の3秒の予算は呼び出し元の待機を制限するもので、開始済みのファイル操作を取り消すものではありません。起動時の自動削除はありません。ローカルのワーカーログと標準エラーの警告にディレクトリーを示します。使用中のプロセスを停止し、場所を確認して、安全になってから手動で削除してください。この後片付けの診断を署名付き監査記録や相手への送信に含めません。

同一性の検査は、同じアカウントや管理権限を持つホスト上の別プロセスによる同時置換に対する、OS レベルの保証ではありません。残ったファイルへのアクセス範囲は、ディレクトリーの権限や Windows TEMP の ACL に依存し、共有アカウントや独自の一時ディレクトリー設定で広がることがあります。この OCI の後片付けは、外部ツール・モデル提供者の保存先、コンテナーの保存領域、バックアップ、開いたストリーム、別経路の `subprocess_restricted` の作業領域を消去しません。ファイルの削除は完全消去を保証しません。

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

このソース内のインストーラーは 0.10.1 を固定します。公開サイトのインストーラーへの反映は別途デプロイ後です。Node 22 以上があれば `npm i -g sealbridge@0.10.1` や `npx sealbridge@0.10.1` も使えます。入れたあとは `sealbridge doctor`、任意で `sealbridge demo` を実行できます。PATH の案内はインストーラーに表示されます。削除はソースのチェックアウトから `sh sites/install.sh --uninstall` または `./sites/install.ps1 -Uninstall`、npm グローバルインストールなら `npm uninstall -g sealbridge` を実行します。

### ローカルでワーカーを動かす

0.7.0 から、本流の `sealbridge` で `--adapter claude|codex|command` や、この PC 上の sandbox、`--on-receive` を使うには `--allow-local-pc` が必須です。依頼側の `delegate` と、ローカルコマンドの hook を使わない `openai` ワーカーには不要です。

```sh
sealbridge worker start --adapter sandbox --allow-local-pc
```

起動すると、共有してよい `acp-invite:` トークンと `https://sealbridge.app/i#acp-invite:...` リンクが印刷されます。既定の有効期限は 24 時間です。短い招待リンクは `https://sealbridge.app/j#...`、長い形式は引き続き `/i#acp-invite:` です。

ワーカーの承認はパスキーが既定です。最初のパスキーは、ワーカー起動から10分以内に別のターミナルで `sealbridge passkeys register` を実行して登録します。時間を過ぎた場合はワーカーを再起動し、もう一度実行してください。コマンドが返す `https://sealbridge.app/approve#...` リンクを開き、認証器で登録を完了します。ワーカーは動かしたままにしてください。起動時には、この登録コマンドや承認 URL は表示されません。

ローカル版は `npm i -g sealbridge-local` のあと、`sealbridge-local worker start …` を使います。鍵とデータディレクトリは共通です。Sealbridge Desktop も選択肢です。隔離ランタイム（microVM）は準備中です。

### MCP ホスト（Cursor / Claude）

`sealbridge setup` が対応しているのは `cursor`、`claude-desktop`（macOS / Windows）、`claude-code`（`--project` で絶対パスが必須）です。Muse 専用の `setup --host` はありません。MCP を使う場合は登録してください。ほかのホストでは、対応していれば [手動で MCP を登録](#接続確認のために-mcp-を登録する)してください。手順は `sealbridge setup --help` も確認してください。

### ソースから試す / 中継器を自分で持つ

Sealbridge は Node.js 22 以降をサポートし（現在の実効的な最低バージョンは 22）、CI は Node 22 と Node 24 でテストし、公開パッケージは Node 22 でビルドし、インストーラーは Node を導入する際に 22.22.0 に固定しますが、動作する同梱 npm がある既存の Node 22 以降は再利用します。

pnpm 10 が必要です。

```sh
git clone https://github.com/sealbridge/sealbridge.git && cd sealbridge
pnpm install --frozen-lockfile && pnpm build
pnpm sealbridge demo
```

公開中継器を使わず、同じマシンやオフラインだけで試すときだけ `pnpm sealbridge relay start --port 8787 --host 127.0.0.1` を使います。自前の公開中継器は [リレーの信頼性](docs/relay-reliability.ja.md) と `packages/relay/wrangler.toml.example` を見てください。

エージェント向けの手順は [AGENTS.md](AGENTS.md) と [SKILL.md](SKILL.md) です。

## 詳しい資料

| 資料                                                         | 内容                                             |
| :----------------------------------------------------------- | :----------------------------------------------- |
| [自動受付の設定](docs/auto-accept.ja.md)                     | 読むだけ／書き換え、相手の範囲、日次・月次の上限 |
| [リレーの信頼性](docs/relay-reliability.ja.md)               | 再試行、期限、プロキシ、中継器の運用             |
| [つながりの交換](docs/connections/connection-exchange.ja.md) | 接続の申し込みと状態                             |
| [監査の中断](docs/audit-interruption.md)                     | 中断時の監査（英語）                             |
| [SDK](docs/sdk.ja.md)                                        | 組み込み用 API                                   |
| [ARCHITECTURE.ja.md](ARCHITECTURE.ja.md)                     | 全体像と信頼境界                                 |
| [spec/README.ja.md](spec/README.ja.md)                       | プロトコル                                       |
| [SECURITY_PROOF.ja.md](SECURITY_PROOF.ja.md)                 | 敵対的テストスイート                             |

CLI のすべてのサブコマンドは `sealbridge --help`、各コマンドの `--help` で確認できます。

## 作成者・リンク

- **作成者 (X / Twitter)**: [@takapon01234](https://x.com/takapon01234)
- **リポジトリ**: [sealbridge/sealbridge](https://github.com/sealbridge/sealbridge)
- **サイト**: https://sealbridge.dev
- **招待ページ**: `https://sealbridge.app/j#...`（短い形式）、`https://sealbridge.app/i#acp-invite:...`（長い形式）
- **公開中継器**: `https://relay.sealbridge.dev`（従来の `https://acp-relay.agent-collab.workers.dev` も同じ中継器です）

旧称は ACP / agent-collab-platform です。Zed の Agent Client Protocol および IBM / BeeAI の Agent Communication Protocol との名称衝突を避けるため改称しました。`acp` コマンドは非推奨の別名として残っています。プロトコル識別子や既存のデータ場所はそのまま使えます。

明示的な招待別名の指定は、旧版でも招待データを読み取れるよう、任意の署名付きサイドカーファイルに保存します。既存レコード内の `aliasExplicit` はアクセス時に別ファイルへ移行し、レコードから削除します。明示指定の記録がない過去の別名は、明示的に選ばれたものとは見なしません。その名前を接続名に使うには、初回接続前に同じ招待を `--alias` 付きで再保存してください。サイドカーファイルの欠落・破損・読み取り不能時は、保存や依頼を妨げず、表示名から作った接続名を使います。

accept JSON の `aliasExplicit: false` は印を保存できなかったことを示します。キーの有無ではなく値が `true` かどうかで判定してください。
