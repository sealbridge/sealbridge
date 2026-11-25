# A second opinion from a friend's AI / 友だちの AI にもコードレビューを

Script for a silent, captioned 40-second demo: Alice uses Claude Code; her friend Bob runs a Codex worker. Produce separate English and Japanese caption tracks using the same shots. Timing includes edited waits, not a promise of review speed. This document covers the script portion of [#247](https://github.com/sealbridge/sealbridge/issues/247); recording and deployment are separate work.

無音・字幕付きの40秒デモ台本です。Alice は Claude Code、友だちの Bob は Codex ワーカーを使います。同じ映像に英語版・日本語版それぞれの字幕を付けます。待ち時間は編集で短縮する想定で、レビュー速度の保証ではありません。[#247](https://github.com/sealbridge/sealbridge/issues/247) の台本部分を扱い、録画・公開は別作業です。

## Shot list / カット割り

| Time / 秒 | Screen / 画面                                                                                                                                                                   | English caption                                                              | 日本語字幕                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 0–4       | Title; Alice (Claude Code) and Bob (Codex). / タイトルと2人の名前・環境。                                                                                                       | Want a second opinion from a friend's AI?                                    | 友だちの AI にも見てもらいたい？                               |
| 4–8       | Bob's terminal: worker command below. / Bob の端末で下記の起動コマンド。                                                                                                        | Bob runs a reviewer on Codex.                                                | Bob は Codex でレビュー役を起動。                              |
| 8–11      | Bob shares an invite in chat; replace the entire link with `[private invite]`. / チャットで招待を共有。リンク全体を `[非公開の招待]` に置換。                                   | He sends Alice a private invite.                                             | Alice に招待リンクを送る。                                     |
| 11–17     | Alice's terminal alongside Claude Code: import, then delegate; show her send confirmation. / Claude Code と並べた端末で取り込み・依頼・送信確認。                               | Alice, on Claude, asks for a diff review. Importing is not approval.         | Claude の Alice が差分レビューを依頼。取り込みは承認ではない。 |
| 17–21     | Bob inspects and approves the exact task with his passkey; conceal approval links and authenticator details. / Bob が依頼内容を確認してパスキーで承認。リンクと認証情報は隠す。 | Bob reviews the request and approves.                                        | Bob が依頼内容を確認して承認。                                 |
| 21–25     | Result JSON excerpt, then Alice's final review/confirmation; label edited waiting time. / 結果 JSON の抜粋と Alice の検収。待ち時間の省略を明示。                               | Signed findings return. Alice checks them.                                   | 署名付きの指摘を Alice が確認。                                |
| 25–29     | Both terminals run audit verification with their own file paths; retain actual JSON output. / 双方の端末で各自のログを検証。実際の JSON 出力を表示。                            | Both sides can verify their audit logs.                                      | 双方が監査ログを検証できる。                                   |
| 29–34     | Privacy card, first line. / プライバシーカード前半。                                                                                                                            | The relay cannot read the code. It sees routing metadata.                    | 中継器はコードを読めません。配送情報は見えます。               |
| 34–40     | Privacy card, second line; `sealbridge.dev`. / プライバシーカード後半と `sealbridge.dev`。                                                                                      | Bob's agent and model provider read it. Share only code you trust them with. | Bob の AI とモデル提供者は読みます。見せてよいコードだけを。   |

## Commands and preparation / コマンドと事前準備

These are shot references for a future owner-operated run, not an automated recording script. Use two owner-controlled environments with Sealbridge installed, Bob's Codex CLI installed and OPENAI_API_KEY configured in his host environment, and Alice's Claude Code ready. Use synthetic code, fresh audit filenames in an existing private working directory, and an unused `bob` alias. Keep Bob's worker running. The default relay is `https://relay.sealbridge.dev`.

以下は持ち主が操作する際の撮影用コマンドで、自動録画スクリプトではありません。双方の環境に Sealbridge を導入し、Bob は Codex CLI を導入してホスト環境に OPENAI_API_KEY を設定し、Alice は Claude Code の準備を済ませます。架空のコード、既存の非公開作業ディレクトリ内の未使用ログ名、未使用の `bob` エイリアスを使います。Bob のワーカーは起動したままにします。既定の中継器は `https://relay.sealbridge.dev` です。

Bob starts the worker / Bob がワーカーを起動:

```sh
sealbridge worker start --adapter codex --allow-local-pc --name "Bob (Codex)" --audit bob-review.jsonl
```

`--allow-local-pc` permits local execution; it does not approve incoming work or provide OS isolation. Prepare Bob's passkey using the [owner approval guide](../passkey-approval.md), and ensure the approval service is available before a future take. Codex is a write-capable adapter, so the default passkey flow requires owner approval even when the prompt only asks for review. Do not replace that scene with automatic acceptance. Connection consent is separate; resolve any connection/held-request gates under each owner's control before the take. A terminally held request needs an explicit fresh submission.

`--allow-local-pc` はローカル実行の許可であり、受信依頼の承認や OS による隔離ではありません。[持ち主承認ガイド](../passkey-approval.md) に沿って Bob のパスキーを準備し、撮影前に承認サービスを利用できる状態にします。Codex は書き込み可能なアダプターなので、レビューだけの依頼でも既定のパスキーフローでは本人の承認が必要です。この場面を自動受付に置き換えません。接続への同意は別です。接続・保留の処理は双方の持ち主が撮影前に確認し、終了済みの保留依頼は明示的に新しく送り直します。

Alice imports the invitation at a human terminal; paste privately at the prompt / Alice が人間の端末で招待を取り込み、プロンプトに非公開で貼り付け:

```sh
sealbridge accept --paste --alias bob
```

Alice then runs this in a terminal with interactive stdin and stderr, confirms sending, and later checks the result before final acceptance / 続いて stdin・stderr が対話可能な端末で送信を確認し、結果を読んでから検収:

```sh
sealbridge delegate --to bob --title "Review my diff" --description "Review the supplied synthetic diff for correctness and edge cases. Return findings with explanations; do not modify files." --input-file diff.json --audit alice-review.jsonl --out review-result.json
```

Prepare `diff.json` locally with synthetic content such as the following. This is input data, not a command. Do not imply that the requester prompt restricts the worker's actual permissions. This CLI shot is human-operated alongside Claude Code, not an MCP tool call; `accept --paste` requires a human TTY. Do not add `--auto-approve` to make it run unattended.

`diff.json` は次のような架空のデータで事前に用意します。これは入力データであり、コマンドではありません。依頼文でワーカーの実際の権限を制限できるとは説明しません。CLI 操作は Claude Code と並行して人間が行い、MCP のツール呼び出しとしては見せません。`accept --paste` には人間の TTY が必要です。無人実行のために `--auto-approve` を足しません。

```json
{
  "diff": "--- a/average.js\n+++ b/average.js\n@@ -1,3 +1,3 @@\n export function average(values) {\n-  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;\n+  return values.reduce((sum, value) => sum + value, 0) / values.length;\n }\n"
}
```

Show only findings actually returned; their number and wording vary. Any storyboard placeholder must be labeled “Illustrative result” / 「結果の例」. The signature identifies the signing agent, not the correctness of its review.

指摘の数・文面は変わるため、実際に返った結果だけを見せます。仮の結果には必ず「結果の例」と表示します。署名が示すのは署名したエージェントであり、レビュー内容の正しさではありません。

After completion, Alice and Bob each verify their own saved ledger / 完了後、Alice と Bob がそれぞれ保存したログを検証:

```sh
# Alice
sealbridge audit-verify alice-review.jsonl
# Bob
sealbridge audit-verify bob-review.jsonl
```

The CLI emits JSON, not a standalone `VALID` banner. Keep the actual verification status visible. Subsequent worker attempts use task-suffixed audit paths: use the path for the completed task. Without independent expected-head/closure evidence, verification does not prove completeness; it also does not prove that the findings are correct. See the [audit guarantees](../../AGENTS.md#requester-flow--発注側).

CLI の出力は JSON であり、単独の `VALID` 表示ではありません。実際の検証状態を見せます。ワーカーの2回目以降の試行ではタスク接尾辞付きのログ名になるため、完了した依頼のパスを使います。独立した期待ヘッド・終了状態の証拠なしでは完全性を証明できず、指摘の正しさも保証しません。[監査の説明](../../AGENTS.md#requester-flow--発注側)を参照してください。

## Privacy and factual references / プライバシーと根拠

Never expose real invitation or approval links, private keys, credentials, private diffs, local account paths, or unredacted audit content in a take. Encryption protects task content from the relay, which still handles routing metadata. Bob's agent and its model provider can read the content; encryption cannot prevent the receiving side from retaining or reusing it. Keep both closing privacy cards in every language version.

実際の招待・承認リンク、秘密鍵、認証情報、非公開の差分、ローカルのアカウントパス、未加工の監査ログを撮影素材に出しません。暗号化は中継器から本文を守りますが、中継器は配送情報を扱います。Bob のエージェントとモデル提供者は本文を読むことができ、受信側での保存・再利用は暗号化で防げません。締めの2枚のプライバシーカードは日英どちらにも残します。

Command and claim references / コマンド・説明の確認先:

- [CLI parsing, delegation and audit paths / CLI 引数・依頼・ログのパス](../../cli/src/network.ts)
- [Audit verification output / 監査検証の出力](../../cli/src/index.ts)
- [Privacy / プライバシー](../../README.md#privacy)
- [Acceptance rules / 受付ルール](../auto-accept.md) and [日本語](../auto-accept.ja.md)
- [Passkey approval / パスキー承認](../passkey-approval.md)

The existing `sealbridge demo` exercises a CVE-summary fixture; it is not this code-review scenario. This script does not change that fixture or any video, website, or deployment.

既存の `sealbridge demo` は CVE 要約のフィクスチャを使うため、このコードレビューとは別のシナリオです。この台本でフィクスチャ、動画、サイト、デプロイは変更しません。
