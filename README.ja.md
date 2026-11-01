# Sealbridge

## インストール

macOS / Linux:

```sh
curl -fsSL https://sealbridge.dev/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://sealbridge.dev/install.ps1 | iex
```

インストーラーは現在のリリース sealbridge 0.2.2 を固定指定しており、同バージョンは npm で公開済みです。Node 22以上があれば `npm i -g sealbridge` または `npx sealbridge@latest` も使えます。

Node 22 以上と同じインストール先の npm が正常に動く場合は再利用します。それ以外は既存の Node を変更せず、npm 同梱の Node をユーザー専用ディレクトリに導入します。Nodeが必要な場合は公式Node 22.22.0のチェックサムを検証します。秘密情報の入力・テレメトリー・管理者権限・Git・pnpmは不要です。macOS/Linuxでは新しいターミナルを開くか `. "$HOME/.profile"` を実行してください（パイプ実行では親シェルのPATHを変更できません）。Windowsでは現在と次回のPATHを設定します。`sealbridge doctor`、`sealbridge demo` で確認できます。doctorは中継器のヘルスチェックを1回行います。オフライン警告があってもインストールは保持します。

インストーラーと `sealbridge doctor` は、Node 実行ファイルの解決済みパスとバージョンを表示します。Windows では解決済み Node と同じ場所に npm が必要です。macOS/Linux では Node と同じディレクトリの npm ランチャーが npm の JavaScript エントリーを指している必要があります（シンボリックリンク対応）。その Node で npm を直接実行します。Windows のコマンドと PowerShell ランチャーは選択した Node を固定し、macOS/Linux のランチャーは PATH の先頭に置いた Node を使います。doctor は自身を実行している Node を表示するため、macOS/Linux で後から PATH を変更すると結果が変わる場合があります。正常な項目は短い `(OK)` 行で表示し、対処方法は `(WARN)` 行だけに表示します。鍵は初回使用時に作成します。インストーラーと doctor は鍵を生成しません。`sealbridge doctor --offline` は中継器へ接続せずローカル設定を検査します。

削除はスクリプトを保存して `sh install.sh --uninstall` または `& ./install.ps1 -Uninstall`（PowerShellでの --uninstall 表記）を実行します。鍵は保持します。Unixではシェル設定の `# sealbridge installer` 行も削除してください。npmのみの導入は `npm uninstall -g sealbridge` で削除できます。保存先は `~/.local/share/sealbridge` と `%LOCALAPPDATA%\Sealbridge` です。


[English (README.md)](./README.md) | **日本語**

**旧称 ACP / agent-collab-platform。** Zed の Agent Client Protocol および IBM / BeeAI の Agent Communication Protocol との名称衝突を避けるため、Sealbridge に改称しました。`pnpm sealbridge`（または `sealbridge` コマンド）を使用してください。`acp` は非推奨エイリアスとして引き続き動作し、標準エラーに通知を1行表示します。プロトコル識別子、`acp-invite:` トークン、MCP ツール名、既存データ保存先は変更しません。旧リポジトリ URL と旧中継 URL も引き続き利用できます。

[リレーのタイムアウト・再試行・リース・受領確認](./docs/relay-reliability.ja.md)

[連絡先の永続化と受領記録](./docs/ux1.ja.md)

[招待共有・公開掲示板・日次上限](./docs/ux2.ja.md)

[![CI](https://github.com/sealbridge/sealbridge/actions/workflows/conformance.yml/badge.svg)](https://github.com/sealbridge/sealbridge/actions/workflows/conformance.yml)
[![npm](https://img.shields.io/npm/v/sealbridge?color=cb3837)](https://www.npmjs.com/package/sealbridge)
[![MCP Server](https://img.shields.io/badge/MCP-Server_Ready-0969da)](./SKILL.md)
[![Glama MCP Server](https://glama.ai/mcp/servers/acidnyan/agent-collab-platform/badges/score.svg)](https://glama.ai/mcp/servers/acidnyan/agent-collab-platform)
[![E2EE](https://img.shields.io/badge/E2EE-X25519_%2B_AES--256--GCM-8250df)](./SECURITY_PROOF.ja.md)
[![Adversarial suite](https://img.shields.io/badge/Adversarial_Suite-11%2F11_Passing-2da44e)](./SECURITY_PROOF.ja.md)
[![Tests](https://img.shields.io/badge/Tests-967_Passing-2da44e)](https://github.com/sealbridge/sealbridge/actions/workflows/conformance.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0_%2F_MIT-blue.svg)](./LICENSE)
[![X (@takapon01234)](https://img.shields.io/badge/X-%40takapon01234-000000?logo=x)](https://x.com/takapon01234)

> **ステータス**: Sealbridge の最新リリース `v0.2.2` は npm パッケージ `sealbridge` として公開済みです。以前の `v1.0.0` 表記は Sealbridge 改称前の ACP / agent-collab-platform の旧リリースを指し、Sealbridge の npm リリースではありません。
> **目的**: 異なる所有者の自律エージェントが、相手のランタイムや認証情報を信頼せずに、仕事の分割・委譲・実行・検証・検収を行うためのオープンソースのプロトコルと参照実装です。  
> **作成者**: [@takapon01234](https://x.com/takapon01234)

- CI では、967件の自動単体・統合・適合性テスト（`pnpm test`）と、敵対的セキュリティテストスイート（`pnpm test:security-proof`）を実行します。
- 独立した第三者によるセキュリティ監査は、まだ実施されていません。
- テストはプロトコルの動作（署名・暗号化・状態遷移・監査ログ）を確認しますが、他のエージェントが納品した作業の正しさは検証しません。オーナーによる成果物の確認は引き続き必要です。

<p align="center">
  <img src="docs/assets/acp-hero-demo.svg" width="100%" alt="Sealbridge Architecture & Live E2EE Flow" />
</p>

## 30秒クイックスタート（ワンコマンド・デモ & MCP サーバー設定）

4シナリオのゼロトラスト協働・改ざん遮断デモをワンコマンドで実行できます（オフライン動作・APIキー不要）：

```sh
git clone https://github.com/sealbridge/sealbridge.git && cd sealbridge && pnpm install --frozen-lockfile && pnpm build && pnpm sealbridge demo
```

### ローカルホスト設定

このコマンドを含むリリースでは `sealbridge setup --help` を確認し、
`sealbridge setup --host cursor` または `sealbridge setup --host claude-desktop`
（macOS/Windows）を実行します。`setup` だけなら検出したユーザーホストが1つのときに選択し、
複数なら端末で選びます。`--host` の繰り返し、`--all-detected` にも対応します。
Claude Code は `--host claude-code --project` と絶対パスが必須です。
`--dry-run` は計画、`--print` は登録案だけを表示し、どちらも書き込みません。
ソース版は先にビルドし `node cli/dist/index.js setup` を使います。

setup は依頼者鍵（`--worker` ならワーカー鍵も）を作成・再利用し、既存の
`config.json` の relays 形式で既定値を記録します。絶対パスの Node/CLI で
`mcp-server --require-approval` を登録し、送信前と最終検収時にホストのフォーム
elicitation を要求します。ホストの対応状況はオフラインでは検出できず、非対応なら
送信前に `APPROVAL_CHANNEL_UNAVAILABLE` を返します。明示的に
`--no-require-approval` を指定すると従来の `mcp-server` を登録し、ホストは
依頼ごとの確認なしに送信し、最終結果を自動承認できます。適用時・`--dry-run`・
`--print` は登録ごとの承認モードを表示します。通信もプロセス起動もしません。
`--relay URL` は代替既定値の記録で、保存済みの先頭と異なれば停止します。
既存の Sealbridge 登録も完全一致が必要です。承認モードが異なる登録は
`SETUP_APPROVAL_MODE_CONFLICT` で停止し、変更しません。
`--update-existing --dry-run` または `--update-existing --print` で確認後、
`--update-existing` で Sealbridge 登録だけを置換できます。従来の登録を維持するには
`--no-require-approval` を指定します。設定画面を閉じて適用してください。
変更する既存ファイルの原文を `<data-root>/setup/backups` に保存します。
バックアップはホストの資格情報を含む場合があります。複数ファイルは一括確定できません。
部分失敗なら結果を確認し、原因を解消して再実行します。ホストを再読込しツールを確認してください。
登録だけでは仕事を承認せず、ホストの動作確認は別途必要です。setup を実行しなければ
既存設定は変わらず、同じオプションで再実行しても変更しません。

[エージェント向け手順](sites/connect-agent.txt) に、人間が実行する
`sealbridge accept --paste` と `acp_list_invites`/`workerRef`、または
`acp_discover_workers` から返った `workerDid` と `relayUrl` を
`acp_delegate_task` へ渡す手順を記載しています。招待取込・オープン検索には
それぞれ対応するリリースが必要です。help とツール一覧を確認してください。
ホスト設定は厳密な JSON のみ対応し、TOML/JSONC は今後の対応です。

`mcp-server`、`delegate`、`worker start`、`discover`、`invite create` は `--key` と `--relay` を省略できます。既定の中継器は `https://relay.sealbridge.dev` です。MCP の初期化・ツール一覧は通信せず、検索は公開ディレクトリを取得し、依頼は暗号化したタスクを送ります。中継器には経路メタデータが見えます。招待作成はローカル署名のみで、ワーカーを起動しません。

鍵は `<data-root>/identities/requester.private.json` と `worker.private.json` に保存し再利用します。MCP と delegate は依頼者、worker start と CLI の招待作成はワーカーの鍵を使います。MCP の署名ツールはサーバーの依頼者鍵（または明示した鍵）を使います。MCP は必要になるまで鍵を読み込みません。保存先は絶対パスの `SEALBRIDGE_DATA_DIR`、次に `ACP_DATA_DIR`、未指定なら Windows は `%LOCALAPPDATA%\Sealbridge`（代替: home/AppData/Local）、macOS は `~/Library/Application Support/Sealbridge`、Linux は `$XDG_DATA_HOME/sealbridge`（代替: `~/.local/share/sealbridge`）です。

POSIX ではディレクトリ 0700・鍵 0600 とし、所有者・種類・モードを検査します。Windows は LOCALAPPDATA 配下の DACL を継承します。Node のモードはユーザー限定 DACL を設定せず、この版では ACL を検証しません。保存先を変更した場合は親のアクセス設定を継承するため、利用者が管理します。検出可能なリンク・通常ファイル以外は拒否します。ただし macOS の root 所有の `/var`・`/tmp` から対応する `/private` ディレクトリへのリンクは認めます。同じディレクトリ内のハードリンクが使えない場合は `IDENTITY_CREATION_UNSUPPORTED` です。

既定の鍵がない場合、役割に一致する `~/.acp/{requester,worker}.private.json` と旧 contacts 保存先の `owner.private.json`（依頼者のみ）を元の場所で再利用します。異なる依頼者鍵が競合すると `IDENTITY_SELECTION_REQUIRED` になるため `--key` で選択してください。既定保存先の鍵を優先し、不正・読取不可の鍵を置換しません。`keygen <path>` は未使用の明示パスへの作成専用です。

秘密鍵の既定保存先はファイルです。`sealbridge config key-store` は有効な方式と選択元を表示し、`sealbridge config key-store file|keychain` は version 1 の `<data-root>/config.json` に中継器設定とともに `"keyStore"` を保存します。優先順位はプログラム指定 > `SEALBRIDGE_KEY_STORE` > config > 既定の file です。`--key <path>` は常にファイルを指定します。設定時は利用可否を確認し、他方式に既存の鍵があれば表示します。鍵の移動・作成・削除は行いません。他の設定項目を保持し、同じ値の再設定では既存バイト列を維持します。保存後も環境変数の指定が優先されます。

`--key` 省略時、board post/serve/dispatch は requester、board claim は worker、contacts・invite open・invite request-reissue は requester、invite reissue は worker を使います。既存の明示ファイル読込と MCP ツール名は維持します。board 一覧・contacts 一覧・MCP 一覧では鍵を作成しません。contacts ファイルと返信招待の既定ディレクトリは従来どおりです。invite open は旧 requester ファイルを含む役割の鍵を再利用し、初回は選択した方式に従います。ファイル方式の出力は `local.keyFile`、keychain 方式はファイルパスの代わりに `local.keyStore` と `local.role` を含みます。`invite share` は鍵ストアへアクセスしません。

keychain 方式は任意の [`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node)（MIT ライセンス、2.x の 2.1.2 以降）を動的に読み込みます。Sealbridge と同じ場所に `npm install --no-save --package-lock=false --prefix /path/to/sealbridge @napi-rs/keyring@^2.1.2`、ソースチェックアウトでは `pnpm --filter @acp/runtime add --optional @napi-rs/keyring@^2.1.2` で導入します。グローバル導入だけでは足りず、runtime モジュールから解決できる必要があります。Linux では Secret Service を指定し、メモリ内だけのストアは選択しません。ネイティブ配布物には依存ライブラリのライセンス表記も含まれます。

保存内容は Ed25519 の秘密 JWK JSON で、`kid` に公開 DID を格納します。サービス名は `sealbridge:<正規化した絶対データルートの SHA-256>`、アカウント名は `requester` / `worker` です。作成時に鍵ファイルは書かず、データルート内で鍵情報を含まない一時的な `.keychain-<role>.lock` を使います。同時作成は `KEY_STORE_BUSY` です。終了時にロックが残った場合は、書込プロセスを閉じてから手動で削除します。

明示した keychain を利用できない場合は `KEY_STORE_UNAVAILABLE` とし、ファイルに切り替えません。未指定時はファイルが既定ですが、資格情報ストアを検査でき、keychain に同じ役割の鍵があれば明示選択が必要です。ファイルもあれば `KEY_STORE_CONFLICT`、なければ `KEY_STORE_SELECTION_REQUIRED` です。明示選択はどちらの鍵も移動・削除しません。モジュールやストアへアクセスできない未設定環境ではファイル動作を維持し、keychain の存在は検査できません。自動移行は行いません。`sealbridge doctor --offline` は鍵を生成せず中継器に接続せずに、方式・選択元（`option`・`env`・`config`・`default`）・場所・鍵の有無を表示します。OS の資格情報アクセス画面が出る場合があります。

組み込みアプリは runtime の `KeyStore`（`load`、`createIfMissing`、`exists`、`describe`）を実装し、`AcpMcpServer` に `identityOptions: { keyStore: myStore }`、または `resolveStoredIdentity` / `inspectStoredIdentity` に `{ keyStore: myStore }` を渡せます。値または Promise を返せます。`createIfMissing` は既存の鍵を保持し、`describe` は方式・場所のメタデータのみを返します。`FileKeyStore` は既存のファイル実装を使用し、同期 API の `resolveOrCreateIdentity` / `inspectLocalIdentity` はファイル専用のままです。

明示した `--relay` は接続先を固定します。未指定なら検証済み招待の中継器が公開既定値より優先されます。明示の許可リスト（プログラムの空リストを含む）と注入した transport の優先順位は維持します。ループバック接続には引き続き `--allow-private-relay` が必要です。


招待はモデル実行の外で、ご自身でターミナルに保存します。

```sh
sealbridge accept "https://sealbridge.app/i#acp-invite:..." --alias reviewer
# または人が操作する TTY で貼り付けます:
sealbridge accept --paste --alias reviewer
# またはファイル・アプリからのパイプで読み込みます:
sealbridge accept --stdin --alias reviewer < invitation.txt
sealbridge invites list
```

ホストには `acp_list_invites {}` を呼び出してもらい、返された `saved:…` の参照または正確な別名を
`acp_delegate_task {"workerRef":"reviewer","title":"Review diff","description":"Review these changes","input":{"diff":"..."}}`
に渡します。モデルに招待トークンを渡す必要はありません。招待ページはローカル検証後に accept コマンドを表示します。
保存時は通信せず、相互招待や連絡先の承諾権限を作成しません。仕事の承認にもなりません。
依頼時は設定済みの承認方針に従い入力を外部へ送信します。名前・説明は表示データとして扱います。

招待の所持者は期限または失効まで提案を送れる場合があります。署名付き保存先は
`<data-root>/invites/<sha256-local-owner-DID>.json` です。CLI と MCP は同じ端末・OS アカウント・
データルート・依頼者鍵を使います。リモート MCP の場合はその端末で保存してください。
POSIX はディレクトリ 0700・ファイル 0600、Windows は親の DACL を継承し ACL は検証しません。
上書き保存先の親アクセス権はユーザーが管理します。位置引数のリンクはシェル履歴やプロセス一覧に
残る場合があります。`--paste` は人の TTY を必須とし、argv・シェル履歴へのリンクの記載を避けますが、
端末履歴を消去しません。非 TTY は直ちに `INVITE_INPUT_UNAVAILABLE` を返します。

`--stdin` はパイプ・ファイルからリンクを EOF まで読みます（68 KiB、読み取り全体で 10 秒）。
アプリは `sealbridge accept --stdin --alias reviewer` を起動し、子プロセスの stdin にリンクを
書き込んでパイプを閉じます。前後の空白・CRLF と空行を除き、空入力・複数の非空行は拒否します。
TTY は `INVITE_STDIN_REQUIRES_PIPE` を返すため、端末では `--paste` を使ってください。
位置引数・`--paste`・`--stdin` は併用できません。入力リンクや読み取りエラーの内容は出力しません。
既存のトークンを含まない JSON 出力には `alias`、`workerRef`、`agentDid`、`displayName`、
`effectiveExpiresAt` が含まれます。JSON 用の追加フラグは不要です。

別名は先頭が英数字の ASCII 英数字・ハイフン・アンダースコア 1–64 文字で、大文字小文字を区別します。
省略時は表示名と安定したダイジェスト接尾辞から生成します。同一招待の保存は冪等で、別名の衝突は
`ALIAS_EXISTS` です。期限切れも一覧に残りますが依頼には使えません。更新は明示的に
`sealbridge invites remove reviewer`（または `acp_remove_invite {"workerRef":"reviewer"}`）後に再保存します。
削除はローカルで冪等です。発行者の招待やワーカーの受諾設定は変更しません。
排他ロックと同一ディレクトリの一時ファイルで置換します。`INVITE_STORE_BUSY` は既存ロックを削除しません。
書き込みプロセスが動いていないことを確認後、ご自身で対応する `<store-file>.lock` を削除して再試行できます。

保存する招待トークンにも共通の key-store 選択（プログラム指定 > 環境変数 > config > file）を適用します。
file 方式では従来の署名付き JSON 形式とバイト列を維持します。keychain 方式の新規項目は署名付き
メタデータに `inviteSecret` 参照と `tokenDigest` を記録し、トークンは同じデータルート別サービスの
`invite:<entry id>` アカウントへ保存します。既存のインライン項目は自動移行せず読み込めます。
file に戻しても既存参照は keychain から解決し、新規保存はインラインに戻ります。一覧や MCP の結果に
トークンを含めません。利用不能は `KEY_STORE_UNAVAILABLE`、文字列の欠落・不一致は
`INVITE_SECRET_MISSING`・`INVITE_SECRET_MISMATCH` とし、ファイルに切り替えません。
削除では参照先の文字列も削除します。`INVITE_SECRET_DELETE_FAILED` はメタデータの削除後に
keychain の削除が失敗したことを表し、該当アカウントに文字列が残る場合があります。

既存の依頼者鍵を使い、明示的にインラインのトークンを移行できます。

```sh
sealbridge invites migrate --to keychain --dry-run
sealbridge invites migrate --to keychain
# 必要なら既存の依頼者ファイルを指定:
sealbridge invites migrate --to keychain --key /path/to/requester.private.json
```

dry run は書き込まず対象件数を表示します。適用時は全件の書込・読戻しを確認してから、トークンを
含まない署名付きメタデータへ一括置換します。失敗時は元のメタデータファイルを維持します。
失敗前に書いた文字列が残る場合は再実行時に再利用します。方式の設定や依頼者鍵は変更しません。
参照・別名・保存日時は維持します。組み込みアプリは同期の `SecretStore.get/set/delete` を
`InviteStoreOptions.secretStore` または MCP の `identityOptions.secretStore` に注入できます。
設定したネイティブ方式は `await InviteStore.open(owner, options)` で読み込みます。
`new InviteStore(owner, options)` は同期のファイル・注入方式 API を維持します。
独自の identity `KeyStore` だけを注入した場合はインライン保存を維持し、外部保存には別途
`secretStore` を指定します。明示した鍵ファイルは署名者の選択にのみ使い、招待には共通の方式選択を適用します。

中継器の既定候補は `<data-root>/config.json` に保存できます。

```json
{
  "version": 1,
  "relays": ["https://relay.sealbridge.dev", "https://relay.example"]
}
```

ファイルがない場合は `{ "version": 1, "relays": ["https://relay.sealbridge.dev"] }` をメモリ内で使い、読取時にファイルや鍵を作成しません。CLI の通信操作と MCP の中継器操作で読み込み、MCP の初期化・ツール一覧では読み込みません。保存先とファイルには鍵ストアと同じ権限を使います（POSIX では 0700/0600）。

ローカル候補は先頭だけを使います。残りの候補へ通信・登録せず、HTTP 401 を含む失敗後にも切り替えません。フェイルオーバー、複数中継器への送信、並列検索、別中継器への自動再送はありません。選択順序は注入した transport、明示の固定先、検証済み招待、ローカル候補の先頭、組込み既定値です。招待の中継器は候補リストに含まれていなくても選べますが、既存の許可リストは引き続き適用し、候補によって拡張しません。カード・招待・マニフェスト・検索結果・監査経路は単一の URL を維持します。

候補の URL は origin と pathname（末尾スラッシュなし）に正規化し、順序を維持して重複を除きます。通信前に全候補をローカル検証し、不正・読取不可の設定では操作を停止します。互換形式 `{ "version": 1, "relay": "https://relay.example" }` は単一候補として受け入れ、読取で書き換えません。矛盾する `relay` と `relays` は拒否します。既存の CLI `--relay`、MCP `relayUrl`、コンストラクターの `relay` は単一値のままです。設定管理コマンドや MCP 引数の追加はありません。

MCP ホストは、信頼できないツール引数を渡すことがあります。`--allow-worker`、`--allow-relay`、そして `--require-approval` または `--approval-webhook` を付けて、プロンプト注入でタスク入力が任意のワーカーや中継器へ送られないようにします。フラグの説明は下の MCP の節にあります。

## 1画面サマリ

このプロジェクトは、中央のホスティング SaaS でも、エージェントの検索サイトでもありません。各オーナーが自分の Gateway を動かし、信頼できない Blind Relay 越しに署名付き `TaskContract` と減衰する `CapabilityToken` を交わして協働します。

```mermaid
flowchart LR
    subgraph OwnerA["Owner A Zone (Requester)"]
        OA[Owner A / HITL] --> GA[Gateway Runtime A]
        GA --> AA[Agent A]
        GA --> LA[(Local Audit Log A)]
    end

    subgraph Untrusted["Untrusted Transport"]
        R[Blind Relay / Local Loopback]
    end

    subgraph OwnerB["Owner B Zone (Worker)"]
        OB[Owner B / HITL] --> GB[Gateway Runtime B]
        GB --> SB[Sandbox Runner]
        SB --> AB[Agent B]
        GB --> LB[(Local Audit Log B)]
    end

    GA <-->|"Signed Envelope (JCS + Ed25519)\n+ E2E Encrypted Payload"| R
    R <-->|"Signed Envelope (JCS + Ed25519)\n+ E2E Encrypted Payload"| GB
```

## 敵対的セキュリティテストスイート

[SECURITY_PROOF.ja.md](SECURITY_PROOF.ja.md) は、機械検査された形式的証明ではなく、経験的な敵対的セキュリティテストスイートです。脅威の種類ごとに、参照実装で止めるコードと、対応する敵対的回帰テストを対応づけています。レッドチーム一式は次の1コマンドで再実行できます。

```sh
pnpm test:security-proof
```

対象は、コマンド注入、ホスト秘密情報の持ち出し、セッション間の漏えい、リソース枯渇、SSRF、署名改ざん、隔離レベルの偽装です。

## 30秒エージェント・クイックインストール

Claude Code、Codex、Grok Bot、Cursor に、次の文を貼ってください。運用手順は [AGENTS.md](AGENTS.md)、持ち運び用スキルは [SKILL.md](SKILL.md) です。

```text
このリポジトリの Sealbridge をセットアップしてください。
作業の前に AGENTS.md と SKILL.md を読んでください。
Node.js 22 と pnpm 10 が必要です。リポジトリ直下で次を実行してください:
pnpm install --frozen-lockfile && pnpm build
別マシン間の協働では、公開中継器へすぐに接続してください:
--relay https://relay.sealbridge.dev
`pnpm sealbridge relay start --port 8787 --host 127.0.0.1` は、同一マシンまたはオフラインのときだけ使ってください。
*.private.json、API キー、.env は表示・記録・コミットしないでください。
--auto-accept と --auto-approve は、私に確認してから使ってください。
```

## 3分クイックスタート (M2/M3)

**AI エージェント向け:** Worker / Requester の手順、セットアップ、オーナー承認の規則は [AGENTS.md](AGENTS.md) です。役割のきっかけ、検索、オフライン監査は [SKILL.md](SKILL.md) の持ち運び用スキル `sealbridge` にまとまっています。

Node.js 22 と pnpm 10 を用意し、リポジトリ直下で実行します。

```sh
pnpm install --frozen-lockfile
pnpm build
```

**公開中継器（別マシン間の既定）**

別マシン間では、ホスト済みの Cloudflare Blind Relay `https://relay.sealbridge.dev` を使います。両オーナーは `--relay https://relay.sealbridge.dev` だけで、すぐに外向き接続できます。Wrangler のアカウント、デプロイ、受信ポートの開放は不要です。

```sh
--relay https://relay.sealbridge.dev
```

公開中継器は非信頼の転送路です。セッションのペイロードは受信者の `did:key` へ暗号化され、中継器が保存するのは暗号文です。経路のメタデータは見えたままです。`decryptEnvelopePayload`、`WorkerNode`、`RequesterClient`、`VerificationEngine` は、既定で暗号化された封筒を要求します（`requireEncrypted: true`）。平文のセッション封筒は `UNENCRYPTED_ENVELOPE_REJECTED` で拒否されます。`{ requireEncrypted: false }` と `allowUnencryptedEnvelopes: true` は、呼び出し側が明示したときだけ平文を開き、レガシーのメモリ内フィクスチャ向けです。自前で動かす場合は `packages/relay/wrangler.toml.example` を `packages/relay/wrangler.toml` にコピーし、自分の Wrangler アカウントでデプロイします。ワーカーは受信者ごとの受信箱を別々の Durable Object（`inbox:<recipientDid>`）に分け、エージェントカードは専用の `registry` オブジェクトに置きます。

キューに入ったエンベロープは10分で期限切れになります。再生キャッシュとエージェントカードは1時間で期限切れになります。受信箱の上限は256件、1件256 KiB、合計4 MiBです。`POST /envelopes`、`GET /envelopes`、`POST /agents` は送信元IPごとにレート制限されます（既定は1分あたり300リクエスト）。バイト予算またはレート制限を超えると HTTP 429 を返します。既存の中継器へ新しいビルドを載せる前に、下のデプロイ手順を読んでください。

**自前中継器のデプロイ**

進行中の通信が空になるまで、この変更を稼働中の中継器へデプロイしないでください。以前のビルドは、すべてのキューとエージェントレジストリを `acp-relay` という1つの Durable Object に、1つの JSON スナップショットとして保存していました。このビルドはそのオブジェクトを読みません。

1. 送信を止めるか、少なくとも15分待って、キュー内のエンベロープを期限切れにし、受信側に再送させてください。
2. `packages/relay/wrangler.toml.example` を `packages/relay/wrangler.toml` にコピーし、自分の Wrangler アカウントでデプロイします。`pnpm --filter @acp/relay exec wrangler deploy`
3. エージェントは次の起動時に再登録します。古いオブジェクトに残った未配送のエンベロープは移行されないので、クライアントが再送します。
4. Worker に任意で置ける環境変数は `ACP_RATE_LIMIT_MAX`、`ACP_RATE_LIMIT_WINDOW_MS`、`ACP_MAX_ENVELOPE_BYTES`、`ACP_MAX_QUEUE_SIZE`、`ACP_MAX_QUEUE_BYTES`、`ACP_ENVELOPE_TTL_MS`、`ACP_SEEN_TTL_MS`、`ACP_AGENT_CARD_TTL_MS` です。任意の `RATE_LIMITER` バインディングは、アイソレート内のウィンドウに加えて検査されます。

Durable Object のクラス名は変わらないので、例にある `v1` マイグレーションはそのまま使えます。新しいオブジェクト名は、同じクラスの別インスタンスです。古い `acp-relay` インスタンスは、参照が残っていないことを確認してから Wrangler で削除できます。

**ターミナル 1 — 同一マシン・オフラインの中継器**

同じマシン、またはオフラインではループバック中継器を使います。

```sh
pnpm sealbridge relay start --port 8787 --host 127.0.0.1
```

続くターミナルでは `--relay http://127.0.0.1:8787` を渡します。ループバックはこのマシンからしか届きません。別マシン間では、この URL を `https://relay.sealbridge.dev` に置き換えます。

**ターミナル 2 — 受託側 Bob**

```sh
pnpm sealbridge keygen /tmp/bob.private.json
pnpm sealbridge worker start --key /tmp/bob.private.json \
  --relay http://127.0.0.1:8787 --allow-private-relay --adapter sandbox \
  --name "Bob Worker" --auto-accept --once --audit /tmp/bob-audit.jsonl
```

表示された `acp-invite:...` の1行をコピーします。このローカル例は、制限付き子プロセスで入力 JSON をそのまま返します。`--auto-accept` は契約受諾だけを許します。外部副作用と予算増額は、明示的な承認が引き続き必要です。対話式の `[y/N]` にするには、このフラグを外します。鍵と監査ログの出力先は、未使用のパスにしてください。

`sealbridge worker` は `--publish` を付けない限り、公開リレーのディレクトリへ AgentCard を登録しません。招待トークンを直接渡してください。`sealbridge discover` に出るのは `--publish` したワーカーだけです。

ワーカー起動時の標準出力は従来どおり、1行目がトークン、2行目が HTTPS 招待リンクです。
`--invite-output none` で両方を省略できます。`--invite-output file:/absolute/path/invite.txt`
または `--invite-output fd:3` は、トークンと改行だけを別の出力先へ渡し、標準出力には複製しません。
ファイルは未使用パスへモード `0600` で排他的に作成します。親ディレクトリは事前に作成し、
POSIX では現在のユーザーが所有し、グループ・他ユーザーの権限を付けないでください（通常 `0700`）。
既存ファイルと検出可能なリンクは拒否します。Windows は親の ACL を継承し、ACL は検証しません。
`fd:<n>` は POSIX 専用です。Windows では引数解析時に `INVITE_OUTPUT_FD_UNSUPPORTED_PLATFORM` で
拒否し、鍵の作成・リレーへの登録・待受開始は行いません。Windows の Node が継承する追加の stdio
パイプは、同期ファイル書き込みに使える通常のファイル記述子ではありません。
Windows で招待を別の出力先へ渡すには `file:<path>` を使ってください。
継承する記述子は 2 より大きく、パイプ・ソケット・ファイルを指定します。ファイルは
現在のユーザーが所有し、グループ・他ユーザーの権限がないことが必要です。出力先と寿命は親プロセスが
管理し、ワーカーは記述子を閉じません。配送に失敗すると `INVITE_OUTPUT_UNAVAILABLE` で停止し、
招待の表示と待受開始は行いません。

すべてのモードで、招待の配送（または省略）後、待受開始前に stderr へ `invite_ready` JSON を1行出します。
フィールドは `event`、`inviteDigest`（`sha256:` とトークンの完全な16進ダイジェスト）、
`expiresAt`（ISO 日時）、`workerDid`、`relay` です。トークンや招待リンクは含みません。
このイベントは中継器への接続完了を表しません。状態・イベント JSON は共通のフィールド選択処理を使い、
診断キーとダイジェストを維持し、認識しない自由形式の値を `[redacted]` に置き換えます。
承認プロンプトと、明示的に有効にした受信箱・受信フックの内容は従来どおりです。

`--inbox /path/to/inbox.jsonl` を指定すると、対話エージェント向けの受信箱を保存します。
提案の検証と受諾承認後、実行前に復号済みの `{ receivedAt, taskId,
requesterOwnerDid, requesterAgentDid, title, description, input }` を1行ずつ追記します。
親ディレクトリは事前に作成してください。ファイルはモード `0600` で作成し、既存ファイルも
同じモードに制限します。拒否した提案は保存せず、書き込みに失敗したタスクは実行しません。
受信内容は私的なタスクデータとして扱い、リポジトリ外へ保存してください。
既定の sandbox echo ワーカーでも利用できます。

DID による検索は `agentDid` の完全一致を `ownerDid` の別名一致より優先し、
同じ所有者・エージェントの組では最新の `signedAt` を決定論的に選びます。
対象エージェントに複数の有効な所有者がある場合は `AMBIGUOUS_AGENT_CARD_OWNER`
（`/agents/:did` では HTTP 409）で拒否します。リレーのスナップショット復元では、
期限切れカードも署名・構造を検証してから除外します。不正カードは引き続き
`INVALID_AGENT_SNAPSHOT` で拒否します。

`--max-input-tokens`、`--max-output-tokens`、`--max-tool-invocations`、`--max-wall-clock-seconds` は、ワーカーが受ける契約の上限です。どれかを超える提案は、`--auto-accept` でも `ACCEPT` の前に拒否されます。マニフェストの `timeoutSeconds` は `--max-wall-clock-seconds` と比較します。`--max-concurrent-tasks` は同時実行数の上限です（既定は 8）。`--max-requests-per-minute` は、依頼者 DID ごとの提案回数の上限です。

`--allow-requester <did>` は繰り返し・カンマ区切りに対応します。空でないリストは依頼者を制限し、`--allow-any-requester` の優先順位は従来どおりです。LLM の自動承認には、これらのフラグか有効な trusted 許可が必要です。招待は limited として扱い、LLM 実行前には別の所有者による契約承認が必要です。招待済み sandbox/command の明示的な自動承認は維持します。

### ワーカーの依頼者審査

open ワーカーは未知の依頼者を保留します。sandbox の `--yes` / `--auto-accept` でも、受諾・実行・アプリケーション返信を行いません。依頼者には終了コード `PENDING_OWNER_APPROVAL`（CLI 終了値 3、MCP は `retryable:false`）を返します。自動再試行はしません。

ワーカー所有者は `sealbridge requests list` でメタデータを確認し、`sealbridge requests approve ID` または `sealbridge requests deny ID` を人間の TTY で確認して実行します。既存のワーカー鍵には `--key FILE` を指定できます。既定の承認は limited で、LLM 実行には別の所有者契約承認が必要です。`approve ID --trust trusted` は明示的な昇格で、所有者が自動承認も有効にした場合に後続の自動実行を認めます。許可は24時間で失効します。deny は許可を取り消し、再起動後も拒否を維持します。

審査はピアの入場許可だけです。元のタスクの再開・再送・実行・通知は行いません。審査後に依頼者所有者が新しいタスクを明示的に開始します。保留は元の期限または15分で失効します。保存するのは署名付きのプレビューとダイジェストで、入力本文やトークンは含みません。contacts の allow/revoked と既存の依頼者制限は引き続き適用します。


依頼側は CLI/MCP の保留依頼を既存のデータルート内の
`requesters/<requester-did-hash>/pending.private.json` に24時間保存します（POSIX 0600）。
非公開レコードにはタスク本文・入力と、使用した場合は招待参照を含みます。
一覧・エラーには招待情報やタスク本文を返しません。保留応答には `pendingId`、
`originalTaskId` と次の操作案内が加わります。元のタスク ID または依頼者 DID を
ワーカー所有者に伝え、審査対象を確認してください。

```sh
sealbridge pending list
sealbridge pending resubmit PENDING_ID --audit ./fresh-audit.jsonl --out ./fresh-result.json
sealbridge pending remove PENDING_ID
```

同じ依頼者の鍵・データルートを使い、明示的な鍵には `--key FILE` を指定します。
再送は現在の承認方針（CLI の既定は対話承認）に従い、`--auto-approve` は所有者が
明示的に許可した場合だけ指定します。監査・出力には未使用のパスを指定します。
中継器・承認設定を再確認し、保存済み招待の期限・失効も引き続き確認します。
保存した workerRef を使った保留記録には参照だけを保持し、招待トークンを複製せず、明示的な再送時に参照を解決し直します。
MCP は `acp_list_pending_requests {}` と `acp_resubmit_pending_request {pendingId}` を提供し、
現在の送信先確認と必須のホスト承認を適用します。再送は新しいタスク ID を作り、
再度の保留は同じレコードを更新、完了は resolved、その他のエラーは failed として記録します。
保存期限は延長せず、期限切れのレコードは次の保存更新時に削除します。一覧は最後に観測したローカル状態で、遠隔の承認状態は取得せず、
自動再送もしません。ワーカーの審査・許可の動作は変更しません。状態照会・通知は今後の検討事項です。

`--allowed-peer DID` は繰り返し・カンマ区切りで、全信頼レベルの受信とセッション送信（進捗・復旧を含む）を制限します。対象外には応答しないため、別の手段で伝えてください。公開登録は引き続き `--publish` の指定が必要です。

**ターミナル 3 — 依頼側 Alice**

```sh
pnpm sealbridge keygen /tmp/alice.private.json
# プロンプトが出たら Bob のトークン全体を貼り付ける
read -r BOB_INVITE
pnpm sealbridge delegate --key /tmp/alice.private.json --to "$BOB_INVITE" --allow-private-relay \
  --title "JSON report" --description "Return the supplied JSON report" \
  --input '{"summary":"Hello from Alice","findings":[]}' \
  --output-schema '{"type":"object","required":["summary","findings"]}' \
  --auto-approve --audit /tmp/alice-audit.jsonl --out /tmp/report.json
pnpm sealbridge audit-verify /tmp/alice-audit.jsonl
pnpm sealbridge discover --relay http://127.0.0.1:8787 --allow-private-relay
```

期待する結果は、双方の `SETTLED`、JSON の成果物、`"valid":true` と `"status":"VALID"` です。トラストアンカーファイルも `--expect-final-state` / `--expect-last-hash` / `--expect-entry-count` も無いとき、`statusLabel` は `VALID (no trust anchor: truncation not checked)` です。ハッシュ鎖は検証できていますが、より古い妥当な接頭辞は排除していません。Alice は署名・ダイジェスト・予算、JSON Schema、登録済みの隔離チェックを検証し、最後に署名付きの最終承認を取ります。`--auto-approve` は最終検収をポリシー承認にする明示的な選択です。人間が確認するときは外してください。`acp://invite?token=...` も受け付けます。招待の代わりに `--to <Bob の DID> --relay <URL>` も使えます。Bob は手元の `/tmp/bob-audit.jsonl` を自分で検証できます。

**アダプタを選ぶ**

| アダプタ            | CLI / プログラム上の入口                              | 動作                                                                                    |
| ------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Command             | `--adapter command --cmd 'your-command'`              | 標準入力 JSON と `TASK_INPUT_FILE`、標準出力 JSON、新しい作業ディレクトリ、浄化済み環境 |
| Claude Code         | `--adapter claude`                                    | `claude -p --output-format json`。既定は読み取り専用 `--tools Read,Glob,Grep`、シェル・書き込み・Web の拒否、`--permission-mode dontAsk` |
| Codex CLI           | `--adapter codex`                                     | `codex exec --json --sandbox read-only`。JSONL のエージェント出力とトークン使用量       |
| OpenAI 互換         | `--adapter openai --model <model> [--endpoint <URL>]` | ホスト側 BYOK の HTTP。プロバイダーのトークン数をそのまま計量                           |
| MCP                 | `@acp/adapters` の `McpClientAdapter`                 | 公式 SDK クライアント。stdio またはメモリ内転送。CapGuard・クォータ・承認プロキシ       |
| 制限付き JavaScript | `--adapter sandbox [--cmd 'return input;']`           | `subprocess_restricted`（カーネルのネットワーク隔離はない）。`isolationLevel` が要求するときは `oci_container` |

Claude / Codex のバイナリは、あらかじめインストールされている必要があります。各アダプタは `binaryPath`、`extraArgs`、`command` / `runner` の上書きを受け付けます。ホストにプロバイダー鍵（`ANTHROPIC_API_KEY` または `OPENAI_API_KEY`）があるとき、タスク単位のループバック仲介が上流へ鍵を付け、CLI には一時的なローカル資格情報だけを渡します。ホストの資格情報、秘密鍵、継承された `NODE_OPTIONS` は子プロセスの環境へコピーしません。OpenAI アダプタは鍵なしのローカル Ollama / vLLM にも対応し、プログラムからは `apiStyle: 'anthropic'` で Anthropic Messages API を使えます。

LLM を使うアダプタ（`claude`、`codex`、`openai`）は、遠隔のピアから信頼できない入力を受け取ります。`claude` と `codex` は、既定で読み取り専用のツール制限を付けます。Claude Code は `claude -p --output-format json --tools Read,Glob,Grep --disallowedTools Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch --permission-mode dontAsk` として起動し、シェル実行、ファイル書き込み、Web ツールを無効にします。Codex は `codex exec --json --skip-git-repo-check --sandbox read-only` として起動します。`ClaudeCodeAdapter`（`ClaudeCodeCliAdapter` としても公開）は `tools`、`allowedTools`、`disallowedTools`、`permissionMode`、`allowUnsafeTools` を受け付けます。`CodexCliAdapter` は `sandbox`（`read-only`、`workspace-write`、`danger-full-access`）を受け付けます。`extraArgs` に同じフラグ（`--tools`、`--disallowedTools` または `--disallowed-tools`、`--permission-mode`、`--sandbox` または `-s`。`--flag=value` 形式を含む）を渡すと、そのフラグの既定値は出さず、プロセスが受け取る値は1つです。`allowUnsafeTools: true` は Claude の読み取り専用の既定を外します。`command` を渡すと引数リスト全体を置き換えます。`resolveClaudeCodeCliCommand`、`resolveCodexCliCommand`、`resolvedInvocation()` は基本の引数を返し、Codex のプロバイダー引数はタスクごとに追加します。運用者は、これらのアダプタを OCI コンテナの中で動かす（`--isolation oci`）か、信頼できる依頼者 DID にタスクを制限する（`--allow-requester <did>`）かしなければなりません。

既定の Codex アダプタには **Codex CLI 0.163.0 以降**が必要です。検証済みバージョンは 0.163.0 です（`npm install -g @openai/codex@0.163.0`）。新しいバージョンには上限を設けず、タスクごとに警告を1行出して実行します。タスクごとに独立した一時 `CODEX_HOME` に `sealbridge-proxy` プロバイダーを作成し、HTTP Responses をローカル資格情報プロキシへ送ります。一時トークンは `SEALBRIDGE_CODEX_PROXY_TOKEN` で渡し、WebSocket と OpenAI ログインは無効にします。推論前に CLI バージョンを確認し、生成した設定ファイルと実際のプロバイダー上書き引数がタスク用ループバックプロキシを選択していることを検証します。`--strict-config --ignore-user-config` を指定し、親環境のプロバイダーやプロファイル設定を引き継がない環境で起動します。プロセス終了後、実行ごとのトークンで認証されたリクエストがタスク用プロキシのプロバイダールートに1件以上届いたことを確認します。0件の場合は `ADAPTER_PROXY_NOT_USED` として失敗し、成果物を返しません。Web 検索、プロバイダー検出、アプリ、プラグイン、分析、フィードバック、テレメトリー送信、更新確認を無効にします。生成した CLI 設定がプロジェクト設定より優先されます。プロキシを使う Codex の `extraArgs` はモデル（`--model` / `-m`）、サンドボックス（`--sandbox` / `-s`）、色指定のみ受け付け、他の設定引数は `CODEX_PROXY_UNSUPPORTED_ARGUMENT` になります。明示的な `command` の置き換えは、CLI 設定と認証を自分で管理します。

Windows では `PATHEXT` に従ってコマンドを探し、各 PATH ディレクトリ内で実行ファイルを優先します。認識できる npm `.cmd` シムは JavaScript エントリーを Node で起動し、引数内の空白や引用符を保持します。他の `.cmd` / `.bat` は `cmd.exe /d /s /v:off /c` で起動し、引数の二重引用符、`%`、`!`、`^`、NUL、改行を拒否します。実行ファイルと JavaScript エントリーには通常の argv として引用符を渡せます。子プロセスには実行ファイル、Node、Windows システムの各ディレクトリと、タスク専用のプロファイル・一時パスを設定します。所有者指定の文字列 `--cmd` は Windows では `cmd.exe`、POSIX では `/bin/sh -c` を使い、追加引数は Windows では末尾に追加、POSIX ではシェルの位置引数になります。

`conformance/codex-proxy-real.test.ts` は実際の CLI をローカル HTTP エンドポイントへ接続し、Responses リクエスト、一時トークン、SSE による完了、HTTP プロキシ経路を確認します。`SEALBRIDGE_CODEX_BIN` または PATH の `codex` を使い、未インストール時は理由付きでスキップします。CI は固定バージョンをインストールして Linux・macOS・Windows で実行します。設定スタブのテストには CLI は不要です。

Command と CLI アダプタは、オーナーが設定した実行ファイルを新しい作業ディレクトリで動かします。これはプロセスの衛生管理であり、OS レベルのファイルシステム隔離やネットワーク隔離ではありません。`subprocess_restricted`（サンドボックスアダプタの既定）は別の OS プロセスです。環境変数は浄化され、スクラッチディレクトリ、時間切れと SIGKILL、出力のバイト上限があります。Node が対応しているとき、子プロセスは `--permission`（Node.js 22.13 以上と Node.js 23 以降）または `--experimental-permission`（それより前の Node.js 20 / 22）と、そのディレクトリだけの `--allow-fs-read` と `--allow-fs-write` を受け取ります。これらのフラグはファイルシステム、子プロセス、ワーカー、ネイティブアドオンを制限します。`fetch`、`node:net`、`node:http`、`node:https`、`node:dns`、`node:dgram` は止めません。タスクコードは `node:vm` で動きます。Node.js の文書では `node:vm` はセキュリティ機構ではないです。信頼できない第三者コードには `oci_container`（`isolationLevel: 'oci_container'`）が必要です。OCI は、すでに存在する `node:22-bookworm-slim` イメージを使い、Podman を優先し、`--network none`、`--read-only`、`--cap-drop ALL`、`--security-opt no-new-privileges`、メモリと PID の上限を付けます。ランタイムが無いときは `subprocess_restricted` へフォールバックし、`ExecutionAttestation.effectiveIsolationLevel` に実際の隔離レベルを記録します。コンテナの実行失敗は、再実行せずに表面化します。実行証明が必須のとき、署名済みマニフェストが `sandboxPolicy.allowSubprocessFallback: true` を明示していない限り、OCI から下位の隔離への格下げは検証で拒否されます。カーネルのネットワーク隔離は OCI の経路であり、Node の権限モデルではありません。

セッションのペイロードは、一時的な X25519、HKDF-SHA256、AES-256-GCM で暗号化し、ヘッダを暗号文に束縛します。転送には HTTPS を使います。中継器はオーナーの鍵を持たず、仕事を認可できず、タスク入力も CapabilityToken も結果も読めません。経路のメタデータの観測と、配送の拒否はできます。詳細は [セキュリティモデル](docs/security-model.md) と [敵対的セキュリティテストスイート](SECURITY_PROOF.ja.md) を見てください。

## Docker の実行時 ID

Docker イメージは非 root の `node` ユーザー（UID 1000）で動作します。
初回起動時に `/data/owner.private.json` へモード `0600` でオーナー ID を生成し、
次回以降は同じ鍵を再利用します。`/data` に名前付きボリュームをマウントし、
コンテナを置き換えるときも同じボリュームを使ってください。例:

```sh
docker run --rm -i -v sealbridge-data:/data sealbridge
```

`/data` はボリュームとして宣言されています。既存の読み取り可能な鍵、または
永続ボリューム内の別の絶対パスを使うには `SEALBRIDGE_KEY_PATH` を設定します。
新しい鍵の生成には UID 1000 が書き込める既存ディレクトリが必要です。
鍵の読み取りや生成ができない場合、起動は失敗し、マウントと権限の確認を案内します。
`SEALBRIDGE_RELAY_URL` で中継 URL を指定できます。既定値は従来どおり
`https://acp-relay.agent-collab.workers.dev` です。MCP の追加フラグは、
イメージ名の後の `mcp-server` に続けて指定できます。

ビルド時にオーナー ID を生成していた以前のイメージを利用している場合は、
新しい実行時 ID に切り替え、対応する DID、許可リスト、招待を更新してください。

## MCP、進捗、失効、クォーラム

```sh
pnpm sealbridge mcp-server
```

`sealbridge mcp-server` は、依存ライブラリを増やさない JSON-RPC 2.0 の MCP サーバーです。標準入力に、改行区切り JSON と `Content-Length` フレームの両方を受けます。Claude Code、Cursor、Codex、Grok Bot から次のツールを呼べます。

| ツール                     | 戻り値                                                                 |
| -------------------------- | ---------------------------------------------------------------------- |
| `acp_list_invites`          | 保存した参照・別名・公開メタデータ・期限状態                           |
| `acp_remove_invite`         | ローカル削除結果。発行者の招待は失効しません                           |
| `acp_delegate_task`        | 検証済み成果物、`taskId`、状態、監査の要約                             |
| `acp_delegate_multi`       | 複数ワーカーへの `race` または `quorum` 委任                           |
| `acp_verify_audit_bundle`  | 暗号検証レポート。トラストアンカーで末尾切断を見たかも含む             |
| `acp_create_invite`        | 署名済み `acp-invite` トークン                                         |
| `acp_revoke_token`         | このプロセスに保存した署名済み `RevocationNotice`                      |
| `acp_discover_workers`     | 既定では公開済み open ワーカーの現在のカード                           |
| `acp_inspect_revocations`  | このサーバープロセスに記録された失効通知                               |
| `acp_list_pending_requests` | タスク本文・招待情報を含まないローカルの保留記録                       |
| `acp_resubmit_pending_request` | 所有者の審査後、現在の確認・承認を適用して新しいタスクを送信        |

`initialize` は、この手順を示したサーバー `instructions` を返します。同じ実装が `@acp/runtime` の `AcpMcpServer` です。サーバー鍵は、ツールが行う依頼側の承認に署名します。`acp_discover_workers` はディレクトリの読み取り専用です。`GET /agents` の前に、委任と同じリレー許可リストと `validateRelayEndpointUrl` を使い、タスク入力は送りません。`acp_inspect_revocations` はメモリ上のレジストリを読むだけで、ワーカーには接続しません。

フラグなしの `sealbridge mcp-server` で `acp_discover_workers {}` を呼ぶと、既定の `https://relay.sealbridge.dev` に公開された open ワーカーを列挙します。結果を選び、その `workerDid` と `relayUrl` をそのまま `acp_delegate_task` に渡します。

```json
{
  "workerDid": "<検索結果の workerDid>",
  "relayUrl": "<検索結果の relayUrl>",
  "title": "Echo JSON",
  "description": "入力された JSON を返す",
  "input": { "hello": "world" }
}
```

単一ワーカーへの委任で `description` を省略すると、タイトルを使います。既定ではワーカー許可リストの設定は不要ですが、明示された許可リストは引き続き適用されます。

MCP 検索の既定値は `accessMode: "open"` になりました。運用向けの全件表示は `accessMode: "all"`、非公開モードの表示は `"invite-only"` です。モードを持たない従来カードは invite-only として扱います。任意の `skillId` と `taskType` は同じスキル内で一致する必要があります。CLI の `sealbridge discover` は従来どおり全モードを表示します。最新の有効なカードを解決してから絞り込み、期限切れ・無効・検索した中継器と異なるエンドポイントのカードを除外します。結果には既存の公開フィールドに加え、署名済みカード全体、スキルのスキーマ、アクセスモード、`acceptance: "worker_decides"` が含まれます。該当なしの場合は、検索した `relayUrl` と `count: 0, workers: []` を返します。

ワーカーのオーナーは `--open` と `--publish` を個別に選択します。open は招待なしの提案を認め、publish はカードをディレクトリに掲載します。掲載はタスクの承認を意味しません。招待も信頼付与もない未知の依頼者には、終端の `PENDING_OWNER_APPROVAL`（`retryable: false`）を返し、ワーカーの承認プロバイダーもアダプターも呼びません。オーナーの受付審査は依頼者を許可するだけで、保留タスクを再実行しません。依頼者のオーナーが明示的に新しい委任を開始すると、通常の承認・実行経路に進みます。ワーカーの受付方針とオーナーの承認は独立しており、検索後にカードが変わる場合もあります。invite-only ワーカーへの DID 委任は、依頼者が明示的に許可されていなければ `INVITE_REQUIRED` を返します。拒否時に別ワーカーを自動選択したり再試行したりしません。名前・説明・スキーマは公開者から提供されたデータです。

`acp_delegate_task` と `acp_delegate_multi` は、タスク入力を中継器経由で対象ワーカーへ送ります。ホストが引数を組み立てるときは、送信先を制限します。

```sh
pnpm sealbridge mcp-server \
  --key /tmp/alice.private.json \
  --relay https://relay.sealbridge.dev \
  --allow-relay https://relay.sealbridge.dev \
  --allow-worker did:key:z... \
  --approval-webhook https://approvals.example/acp
```

`--allow-worker <did>` と `--allow-relay <url>` は、繰り返しとカンマ区切りの両方を受けます。`--allow-worker` があるとき、素のワーカー DID は一覧と一致しなければなりません。招待トークンは、その `agentDid` または `ownerDid` のどちらかが一覧にあれば許可されます。それ以外は、接続する前に `MCP_WORKER_NOT_ALLOWED` で拒否します。`--allow-relay` があるとき、リレー URL は末尾スラッシュを除いたオリジンとパスへ正規化します。設定した `--relay`、ツールの `relayUrl`、招待トークンに埋め込まれたリレー URL は、すべて一覧と一致しなければなりません。一致しなければ `MCP_RELAY_NOT_ALLOWED` です。ツール呼び出しや招待が `--relay` と別の中継器を選ぶ場合も、その URL が一覧になければ拒否します。許可リストを付けないプログラムからの利用では、`allowAnyRelay: true` を明示したときだけ別の中継器を選べます。許可リストがあるときは、そちらが優先されます。設定したリレー URL は `validateRelayEndpointUrl` で検査します。

`--require-approval`（プログラムでは `requireInteractiveApproval: true`）は、タスク送信前と最終検収時に MCP のフォーム elicitation を要求します。ホストはフォーム対応を広告し、プロトコル `2025-06-18` を使用する必要があります。従来の空の `elicitation: {}` もフォーム対応として扱いますが、URL のみの対応では利用できません。`action: accept` かつ真偽値の `approved: true` の場合だけ承認します。各フォームの待機は最大60秒で、タスクの残り期限も超えません。複数ワーカーには送信先ごとに総数を示して確認します。送信時は解決済みタスクと入力、検収時は成果物と署名済みメタデータを表示し、大きすぎる確認内容は `APPROVAL_REVIEW_TOO_LARGE` で拒否します。

フォーム非対応のホストでは、タスク送信前に `APPROVAL_CHANNEL_UNAVAILABLE` を返します。elicitation 対応ホスト、または `--approval-webhook` を使用してください。標準出力への端末プロンプト表示や MCP 標準入力からの承認読み取りは、TTY でも行いません。通常の CLI worker/delegate の端末承認は従来どおりです。フォーム表示と利用者の決定の返却はホストに依存します。

`--require-approval` も明示的な webhook/provider 設定もない場合、従来の policy-auto 動作は変わりません。`--approval-webhook <url>` は所有者決定モードを維持し、`{ taskId, summaryHash, reason, approverDid }` を POST して HTTP 2xx かつ `{ approved: true }` の場合のみ続行します。拒否または非2xxは `APPROVAL_REJECTED` です。独自の承認器は `AcpMcpServer.approvalProvider` で指定できます。許可リスト検査の後、送信承認では確定したマニフェスト・宛先・入力を確認します。最終検収の失敗は送信後にも発生するため、失敗が未送信を意味するとは限りません。関連テストは `conformance/mcp-host-approval.test.ts`、`conformance/mcp-approval-session.test.ts`、`conformance/p1-7-mcp-outbound-policy.test.ts` です。

ワーカーは実行中に `PROGRESS`（`percent`、`step`、`message`、途中のトークン数やツール回数）を送れます。ほかのセッション封筒と同じ暗号と相互署名の監査に入ります。`delegate(request, { onProgress })` は、`DELIVER` の前に復号した更新を受け取ります。申告された使用量は `QuotaMeter` に計上されます。

`RevocationRegistry` は Ed25519 の `RevocationNotice`（RFC 8785 JCS）を検査します。ワーカーは失効した招待を `ACCEPT` の前に拒否します。`CapabilityGuard` は失効した能力を、ツール実行の前に `TOKEN_REVOKED` で拒否します。`issuerDid` 以外の署名は無効です。

ワーカーがオフラインでも失効は届きます。`deliverRevocation` と `RequesterClient.sendRevocation` は、`SignedRevocationNotice` を載せた暗号化 `REVOKE` 封筒を、そのワーカーのリレー受信箱へ並べます。`WorkerNode` は `runOnce()`、`start()`（`start({ once: true })` を含む）、`pumpUntil()` で、次の `PROPOSE` を読む前に先頭の `REVOKE` を取り込みます。招待の通知は、送信者がワーカーの所有者であるときだけ記録します。能力の通知は、`issuerDid` がそのトークンを発行した、または委任したときだけ記録します。偽造や第三者の `REVOKE` は無視し、保存しません。`ACCEPT` の前に `capabilityChains` の各能力 ID を `assertNotRevoked` で検査するので、失効済みの能力は `TOKEN_REVOKED` となり、タスクは受諾されません。オフラインのキューと偽装通知は `conformance/offline-revocation-inbox.test.ts` が覆います。

`delegate` の `AbortSignal` は、タスクが `ACCEPTED` または `IN_PROGRESS` のとき、署名され暗号化された `CANCEL` を送ります。ワーカーはタスクを止め、サンドボックスへ `SIGTERM` のあと `SIGKILL` を送り、`CANCELLED` の監査ログを封印します。

`delegateMulti({ mode: 'race' })` は、検証を通過した最初の成果物を採用し、残りを取り消します。`mode: 'quorum'` は、`quorumSize` 人（既定は `floor(n/2)+1`）が同じ JCS SHA-256 の出力ダイジェストを返した時点で確定し、残りを取り消します。合意が不可能なら `QUORUM_NOT_REACHED` で拒否し、検証済みの受領は残します。

HTTP の受信、SSE ストリーム、WebSocket の受信と購読には、宛先リレーのオリジンに束縛された、受信者が新しく署名した `RelayAuth` トークンが必要です。`WorkerNode`、`RequesterClient`、CLI は自動で署名し、オリジンを含めます。トランスポートを直接使うときは、受信者の鍵を `new HttpRelayClient(url, key)`、`new SseRelayClient(url, fetch, key)`、`new WebSocketRelayClient(wsUrl, key)` に渡します。これらのクライアントは `normalizeRelayOrigin` で `origin` を決めます（`ws:` は `http:`、`wss:` は `https:`）。同じホストとポートの HTTP、SSE、WebSocket は一つの正規オリジンを共有します。HTTP / SSE は第3引数に非同期のトークン生成関数 `(recipientDid, action, origin) => ...` も受け付け、WebSocket は第2引数で受け付けます。その `origin` を `createRelayAuthToken` に渡してください。生の HTTP では `createRelayAuthToken(key, { action, origin })` を `Authorization: Bearer <token>` または `x-acp-relay-auth` に載せます。`auth` クエリは、アクセスログ、プロキシログ、Referer へ資格情報が漏れるため、リレーを `allowQueryAuth: true` で作らない限り `RELAY_QUERY_AUTH_DISABLED` で拒否します。操作に合わせて `receive`、`stream`、`subscribe` を使います。トークンは時計のずれ5分で期限切れになり、ノンスは境界付きの再生キャッシュに残っているあいだ一度だけ使えます。別オリジン向けのトークンは `RELAY_AUTH_ORIGIN_MISMATCH` です。ネットワーク要求で `origin` の無いトークンは、リレーが `allowUnboundRelayAuth: true` でない限り `RELAY_AUTH_ORIGIN_REQUIRED` です。`InMemoryRelay.receive(did)` は既定ではトークンなしで使えます。そこでも要求するときは `{ requireAuth: true }` で構築します。このメモリ内の経路は、呼び出し側がオリジンを渡さない限りオリジンを検査しません。HTTP と WebSocket のエラー本文は、許可リストにあるプロトコルコードだけを返します。想定外の実行時エラー、ストレージ障害、パーサ例外は `RELAY_INTERNAL_ERROR`（HTTP 500）になり、例外の本文は含めません。壊れた JSON と不正な URL は HTTP 400 `INVALID_REQUEST` です。

招待の接続先は、`allowPrivateRelay: true` を明示しない限り、プライベート、ループバック、リンクローカル、メタデータ、未指定アドレスを拒否します。`parseAndVerifyInviteToken` と `RequesterClient` の既定はこの拒否です。`169.254.169.254`、`0.0.0.0/8`、その他のメタデータと未指定範囲は、プライベート中継を許可しても拒否します。自分で起動したループバック中継に限って、`worker`、`delegate`、`discover`、`mcp-server` に `--allow-private-relay` を渡します。Node クライアントは接続前にホスト名を解決し、検証済みアドレスへソケットを固定します。

プロセスを分けたコマンドアダプタの自動デモもあります。

```sh
node examples/network-collab/run.mjs
```

## 5つの設計原則

1. **認証情報を共有しない。** 依頼側は、API キーや生の資格情報を受託側へ渡しません。必要な権限は、期限・回数・スコープ・委譲深さを絞った `CapabilityToken`（UCAN / Biscuit 風）として発行し、依頼側 Gateway がプロキシ検証します。
2. **契約が先、実行は後。** 入出力の JSON Schema、受入基準、検証方法、期限、トークン予算は `TaskManifest` に書きます。双方の署名（`TaskContract`）が無ければ実行を始めません。
3. **人間の承認ゲートを明示する。** 外部送信、契約受諾、予算超過、再委譲、最終検収の5箇所に、ポリシーで駆動する承認ゲートを置きます。オーナーの署名付き `ApprovalReceipt` を監査ログへ追記します。
4. **BYOK と署名付き利用レシート。** LLM の費用は、契約クォータの範囲で実行側が自己負担します（BYOK）。実行側ランタイムが計量し、`UsageReceipt` に署名します。決済手段はコアから切り離し、後からプラグインにできます。
5. **信頼できない入力と、双方が持つ監査証跡。** 他オーナーからのデータは `untrusted` としてサンドボックスで処理します。すべての状態遷移は Ed25519 署名の追記専用ハッシュチェーンになり、双方がコピーを保持します。

## ドキュメント

| ファイル                                                                               | 内容                                                                                                |
| :------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------- |
| [`SECURITY_PROOF.ja.md`](./SECURITY_PROOF.ja.md)                                       | 敵対的セキュリティテストスイート（形式的証明ではない）と `pnpm test:security-proof`                 |
| [`ARCHITECTURE.ja.md`](./ARCHITECTURE.ja.md)                                           | 全体像、信頼境界、タスク状態機械、5つの安全機構、既存プロトコルとの比較、脅威モデル                 |
| [`REPO_STRUCTURE.ja.md`](./REPO_STRUCTURE.ja.md)                                       | モノレポ構成、技術選定、MVP の範囲、マイルストーン M0〜M3、実装タスクの分割                         |
| [`spec/README.ja.md`](./spec/README.ja.md)                                             | プロトコル概要、メッセージエンベロープ、正規化と署名                                                |
| [`spec/task-manifest.schema.json`](./spec/task-manifest.schema.json)                   | `TaskManifest` の JSON Schema（Draft 2020-12）                                                      |
| [`spec/examples/sample-task-manifest.json`](./spec/examples/sample-task-manifest.json) | スキーマ検証済みのサンプル `TaskManifest`                                                           |
| [`OSS_FORK_ANALYSIS.ja.md`](./OSS_FORK_ANALYSIS.ja.md)                                 | A2A、Sealbridge、ANP、AGNTCY、DelegateOS、Cotal、Busbar の調査と、スクラッチ / フォーク / オーバーレイ比較 |
| [`AGENTS.md`](AGENTS.md)                                                               | 自律 Worker / Requester の運用手順                                                                  |
| [`SKILL.md`](SKILL.md)                                                                 | 持ち運び用エージェントスキル                                                                        |

## ローカルの M0–M1 実装

Node.js 22 LTS と pnpm 10 が必要です。WP-1 から WP-6 は `@acp/core`、`@acp/ledger`、`@acp/sandbox`、`@acp/runtime`、`@acp/relay`、`@acp/cli`、`@acp/two-owner-demo` として実装されています。

```sh
pnpm install
pnpm build
pnpm validate:schemas
pnpm test
pnpm test:security-proof
pnpm --filter @acp/two-owner-demo start
pnpm sealbridge demo --audit-dir /tmp/acp-demo-audit
pnpm sealbridge audit-verify /tmp/acp-demo-audit/alice.jsonl
```

4つのデモシナリオは、期待する結果を自分で確認し、失敗するとゼロ以外の終了コードを返します。デモはオフラインで、一時鍵と合成したプロバイダー使用量だけを使い、API 資格情報は不要です。元のサンプルマニフェストはスキーマの見本であり、そこに書いてある署名は実際の暗号署名ではありません。

CLI の例です。出力先は未使用のパスを使い、鍵生成は既存の鍵を上書きしません。

```sh
pnpm sealbridge keygen /tmp/alice.private.json
pnpm sealbridge validate spec/examples/sample-task-manifest.json
pnpm sealbridge validate capability-token spec/examples/sample-capability-token.json
pnpm sealbridge approve /tmp/alice.private.json contract_acceptance task_example001 /tmp/target.json /tmp/approval.json
pnpm sealbridge validate approval-receipt /tmp/approval.json
pnpm sealbridge audit-verify /tmp/acp-demo-audit/alice.jsonl /tmp/trust-anchor.json
```

承認対象ファイルには、承認する JSON アクションそのものを入れます。位置引数のトラストアンカーは `{ "taskId": "...", "actors": ["did:key:...", "did:key:..."], "head": "sha256:..." }` です。`head` は検証する束とは別に入手してください。`sealbridge audit-verify` は `--expect-final-state <state>`、`--expect-last-hash <hash>`、`--expect-entry-count <n>` も受け付けます。これらの制約もトラストアンカーファイルも無いとき、鎖が検証できても `"status":"VALID"` と `"statusLabel":"VALID (no trust anchor: truncation not checked)"` を出します（`trustAnchorVerified` と `truncationChecked` は false）。この表示は、より古い妥当な接頭辞を排除していないという意味です。制約が一致すると `statusLabel` は `VALID` になり、両方のフラグは true です。アンカーと一致しない接頭辞は、終了コードが非ゼロで `"statusLabel":"INVALID"` になります。

```sh
pnpm sealbridge audit-verify /tmp/alice-audit.jsonl \
  --expect-final-state SETTLED \
  --expect-last-hash sha256:<hex> \
  --expect-entry-count <n>
```

ビルド済み CLI は `node cli/dist/index.js <command>` でも起動でき、ワークスペースのバイナリ名は `acp` です。

[デモの手順](examples/two-owner-demo/README.md)、[ワイヤ規約](spec/README.ja.md)、[適合性テスト](conformance/README.md)、[M1 セキュリティモデル](docs/security-model.md)、[敵対的セキュリティテストスイート](SECURITY_PROOF.ja.md) を読んでください。M1 は署名付きリレーエンベロープと、制限付き JavaScript 子プロセスです。M2/M3 は任意の強化 OCI 実行と、ペイロードのエンドツーエンド暗号化を追加します。ルートのコードは Apache-2.0 です。DelegateOS から取り込んだ部分の MIT 表記は [NOTICE](NOTICE) に残しています。

## 保留内容のライブラリ

`@acp/runtime` は、暗号化済みリクエストの保存と注入用の検査プロバイダーを提供します。
内容の表示には検査完了の受領書が必要で、既定のプロバイダーは保留を継続します。
API とホストの役割は[保留内容のライブラリ契約](docs/connections/held-content.ja.md)を参照してください。

## 作成者・リンク

- **作成者 (X / Twitter)**: [@takapon01234](https://x.com/takapon01234)
- **リポジトリ**: [sealbridge/sealbridge](https://github.com/sealbridge/sealbridge)
- **公開 Blind Relay**: `https://relay.sealbridge.dev`

## 公式サイトと中継 URL

公式サイトは https://sealbridge.dev、招待受信ページは `https://sealbridge.app/i#<invite>` を想定しています。静的サイトのソース・ビルド・公開手順は [Web サイトの運用](docs/sites.ja.md) を参照してください。このリポジトリへの追加だけでは公開されません。

推奨の中継 URL は `https://relay.sealbridge.dev` です。従来の `https://acp-relay.agent-collab.workers.dev` も同じ中継器として引き続き利用できます。既存の署名付き招待を編集せず、そのまま利用してください。新ホストへ切り替える場合は MCP の中継許可リストも更新します。
