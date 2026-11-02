# つながりによる受付

[English](admission.md)

状態は所有者の端末ごとの `none`・`pending`・`connected`・`blocked` です。
connected は期限なしの limited 同意です。すべてのアダプターで、limited の依頼は
検査完了と所有者が開く操作を経てから受諾します。自動承認方針では省略できません。
既定の検査器は `unavailable` を返すため、内容は保留のままです。公開リリース前に
検査プロバイダーが必要です。

未接続の相手からの有効な依頼は、暗号化済み封筒として最大24時間または依頼の期限まで
保存し、終端の `PENDING_OWNER_APPROVAL`・`retryable:false`・CLI 終了値3を返します。
自動再試行はしません。署名・スキーマ・能力・申告予算・公開スキル・運用者の制限は
保存や招待の結び付けより前に確認します。新しい受付情報には題名・説明のプレビューを
保存しません。未検査の `requests show` は `INSPECTION_INCOMPLETE` です。
平文の受信箱と受信フックは、検査と所有者が開く操作の後だけ使います。

```sh
sealbridge worker start --adapter sandbox --publish --allow-task-type json --max-input-tokens 50000
sealbridge discover --skill json-task
sealbridge requests list
sealbridge requests show REQUEST_ID
sealbridge requests approve REQUEST_ID
sealbridge requests discard REQUEST_ID
sealbridge requests deny REQUEST_ID
```

`--publish` はディレクトリへの掲載だけを行います。未掲載のワーカーも同じ受付規則です。
`--allow-requester` は対象を制限するだけで信頼を付けません。予算は
`--max-input-tokens`・`--max-output-tokens`・`--max-tool-invocations`・
`--max-wall-clock-seconds`、頻度は `--max-requests-per-minute` で設定します。
公開設定の `public` は掲載だけを制御し、`alwaysAsk:false` は
`CONNECTION_OPENING_REQUIRED` を返します。

招待は発行者だけが同意済みの接続申し込みで、最初に使った所有者 DID に結び付きます。
別の所有者が同じ有効な招待を使うと保留です。接続解除後も招待の期限まで結び付けを保持します。
期限切れ・相手の不一致・失効した招待は保存前に拒否します。成立済みの接続は招待の期限や
失効では消えません。後続の依頼は古いトークンを添付せず、確認済みの相手 DID を使います。
保存済み `workerRef` は引き続き招待を選び、使うたびに期限を確認します。
取り込みやプレビューだけでは、どちらの役割にも接続同意を付けません。

```sh
sealbridge accept --paste --alias reviewer
sealbridge connections confirm-invite reviewer --role requester
sealbridge connections request --to PEER_DID --relay https://relay.sealbridge.dev --role worker
sealbridge connections list --role worker
sealbridge connections approve REQUEST_ID --role worker
sealbridge connections reject REQUEST_ID
sealbridge connections withdraw REQUEST_ID
sealbridge connections disconnect PEER_DID
sealbridge connections block PEER_DID
sealbridge connections unblock PEER_DID
sealbridge connections prior-approved
sealbridge connections connect-prior PEER_DID --relay https://relay.sealbridge.dev
sealbridge connections sync --role requester --relay https://relay.sealbridge.dev --once
```

判断には人間の TTY または注入された人間用審査プロバイダーが必要で、`--yes` はありません。
ローカルの役割・DID と相手の所有者 DID を確認してください。requester と worker の既定鍵は別です。
送信側の同意は送信前に保存し、申し込みは14日で失効します。reject は申し込みだけを7日間
受け付けなくし、その間も依頼は保留できます。discard は内容だけを削除し、deny はブロックです。
ブロックは片方向で、相手に応答しません。解除・ブロックは次の受付から効き、受諾済みの仕事は
明示的な CANCEL で止めます。同時の申し込みは2つの DID を昇順にして同じ接続 ID を導きます。
承認・ACK の状態を保存してからリレー受信確認を返します。sync は依頼を再送しません。
内容の24時間と送信済み同意の14日は別の期限です。

依頼の承認と接続への同意は別の判断です。CLI や MCP フォームで順に確認でき、明示的な
接続同意がなければ申し込みを添付しません。相手の署名付き同意がない保留依頼を承認した場合、
こちらから申し込みます。こちらの判断だけで相手の同意は作りません。接続の確認後は依頼者の
所有者が新しい依頼を明示的に開始します。`pending resubmit` も未使用の監査・出力パスを使い、
新しい依頼として改めて検査し、所有者が開きます。

既存の署名付き受付・招待ファイルは読み取れ、一覧・読み取りで書き換えません。従来の有限の
許可は保留を省略せず、接続へ自動変換しません。残っている承認履歴は `prior-approved` から
所有者の操作で申し込みます。相手の同意も必要です。従来の拒否はブロックとして残ります。
CLI の明示的な contacts 設定は独立して維持します。`requests approve ID --trust trusted` は
別系統の従来の24時間許可です。接続の操作から trusted は作りません。最初の変更で v2 に進むため、
旧版へ戻す必要があれば事前に v1 を保存してください。新旧の書き込み処理は併用しません。
接続・版の記録は1,000件・1 MiBの境界を維持し、成立済みの記録を自動削除しません。

廃止した CLI の `--open`・`--access-mode`・`--open-*`・`--allow-any-requester` と JS の
`accessMode`・`openPolicy`・`allowAnyRequester` は移行案内付きの `ACCESS_MODE_REMOVED` です。
MCP 検索の旧 `accessMode` 引数は JSON-RPC -32602 です。検索は署名と期限を確認した
最新の掲載カードすべてを返し、運用モードの欄は返しません。旧カードの署名済み原本は保持します。
`acp_list_connections {}`・`acp_list_connection_requests {}` は鍵を作らず、サーバーの署名者の
ローカル情報だけを返します。所有者の判断は人間用 CLI で行います。

board の claim と dispatch は、選択した投稿者の現在の接続が必要です。
未接続なら `CONNECTION_REQUIRED` で、接続だけでは依頼・リースを承認しません。
接続と版を確認してからリースを消費し、送信開始後の結果が不明でも自動再試行しません。
一度だけの入場券と別の応募キューは後続の検討です。

[プロトコル版とリリース時計](protocol-versions.ja.md)も参照してください。
