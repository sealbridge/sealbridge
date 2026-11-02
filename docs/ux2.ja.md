# 招待共有と公開ジョブ掲示板

[English](./ux2.md) | **日本語**

Sealbridge UX-2 は、ローカル招待 QR・リンク、署名付き
メタデータ掲示板、公開ワーカー設定、永続の日次受諾上限を追加します。
支払い・評価は対象外です。

## 招待共有

```text
sealbridge invite share --file invite.txt --host https://sealbridge.app/i --png invite.png --svg invite.svg
sealbridge invite open --file received-link.txt
sealbridge invite open --file received-link.txt --save-contact "友人" --key recipient.private.json
```

トークンは URL フラグメントに格納します。外部 QR サービスや HTTP 通信は使いません。
`sites/` に sealbridge.app 向け静的受信ページを同梱します（公開は別作業）。
ブラウザー内で既存の検証コードを使い、署名・期限・識別子の結合を確認します。
フラグメントの送信やログ、第三者スクリプトは使用しません。
CLI では完全なリンクをファイルに保存して `invite open --file` を実行します。

署名、所有者・エージェント DID の結合、中継 URL、招待とカードの有効期限を再検証し、
接続相手を表示します。連絡先保存は許可リスト登録や仕事の自動承認を伴いません。
期限はローカル時刻と残り時間で表示し、`expiresAt` に機械向け ISO 値を残します。
検証後、未作成の場合だけデータディレクトリの `owner.private.json` に鍵を作成します
（`--key` で変更可能）。既存鍵は再利用し、破損・不一致は拒否します。
招待者を自動承認なしの連絡先に保存し、24時間有効の返信用招待を鍵と同じ場所に保存します。
`--out` で未使用の保存先を指定できます。出力の `local.keyFile` と
`local.reciprocalInviteFile` を使い、信頼できる経路で返信用ファイルを相手に渡してください。
返信カードは組み込みの `json-task` を提示します。受信にはその鍵と relay で sandbox ワーカーを開始します
（`worker start --key ... --relay ... --adapter sandbox`）。開くだけでは送信・ワーカー起動・公開登録・相手の能力の複製は行いません。
秘密鍵・返信トークンは出力しません。
自動承認フラグは拒否します。リンク・画像は招待情報なので意図した相手にだけ共有します。

```text
sealbridge invite request-reissue --file expired-link.txt --key recipient.private.json --out request.json
sealbridge invite reissue --file old-invite.txt --key issuer.private.json --request request.json --out fresh-invite.txt
```

署名付き依頼ファイルを既存の信頼できる経路で発行者へ渡します。依頼は24時間有効です。
発行者は確認プロンプトで承認します。`--yes` は使えません。古い招待を発行時刻で検証し、
発行者の鍵で新しいカードと24時間の招待を署名します。発行者から開始する場合は
`--request` を省略できます。別鍵カードには `--agent-key agent.private.json` を指定します。
所有者がカードと招待を署名し、対応するエージェント鍵が新期限に結び付いた委任を更新します。
鍵の欠落・不一致は拒否します。古い招待の期限・失効は変えません。

### QR 容量

ローカルエンコーダーは誤り訂正 L、余白4モジュールを使います。公開 Sealbridge relay と JSON
スキルを持つ実際の署名済み招待で、トークン1,986バイト・リンク2,013バイト、長い表示名で
リンク2,048バイトを測定しました。両方とも version 33、149×149モジュールです。
カード情報・URL・別鍵の委任署名が長いと増大します。version 40 / L のバイト容量は
2,953バイトで、実際の収容可否はエンコーダーが判定します。超過時は
`QR_CAPACITY_EXCEEDED` とし、切り詰めません。先に表示する完全なリンクを共有できます。
高密度の端末表示は読み取りづらいため、大きな SVG またはリンク共有を利用してください。

## メタデータ掲示板と公開設定

候補は署名・期限・スキル・中継器を確認し、選択した投稿者のローカル接続に照らして表示します。
claim/dispatch は connected が必要で、未接続なら `CONNECTION_REQUIRED` です。接続だけでは
依頼やリースを承認しません。serve は投稿者の requester DID と永続化ストアを使い、
検査と所有者が開く操作を要求します。版と接続の確認前にはリースを消費しません。
送信開始後は自動再試行しません。一度だけの入場券と応募キューは後続の検討です。

`worker public --settings settings.json --preview` はローカルの公開設定、一般の予算、検査の利用状況を表示します。
`public:true` は `--publish` だけを設定し、種別は `--allow-task-type`、予算は `--max-*`、
頻度は `--max-requests-per-minute`、日次件数は `--max-tasks-per-day` です。
`alwaysAsk:true` を指定します。false は `CONNECTION_OPENING_REQUIRED` です。
旧 `--open*` の指定は `ACCESS_MODE_REMOVED` です。旧カードの方針から予算を推測しません。

[所有者の接続・招待・保留の手順](connections/admission.ja.md)を参照してください。

## 永続の日次上限

`worker start --max-tasks-per-day N` は公開設定なしでも使えます。保存先は contacts と同じ
プラットフォームのデータディレクトリ内の `daily-tasks.json` で、`ACP_DATA_DIR` で変更できます。
同じディレクトリを使う依頼者 DID・ワーカー鍵・プロセスで共通の上限です。`--contacts` では
保存先を変えません。参加するすべてのワーカーで同じ上限と保存先を設定してください。
任意設定であり、OS 全体の強制境界ではありません。

日付はローカルの時刻に関係なく **UTC 00:00** に切り替わります。所有者の有効な承認の後、
inbox 書き込み・ACCEPT 送信・実行の前に1枠を消費し、その後の失敗では返却しません。
事前検証の失敗や所有者の拒否では消費しません。重複 task ID・時計の巻き戻り・不正な状態・
ロック競合を拒否し、排他ロックと原子的な置換で再起動・並行更新を扱います。
中断されたロックは、保持するプロセスの停止を確認してから運用者が復旧します。
ファイルや設定を変更できる所有者は、状態の削除・時計や保存先の変更・上限の無効化ができます。
件数は設定されたホストのデータディレクトリに属し、遠隔 DID には依存しません。
