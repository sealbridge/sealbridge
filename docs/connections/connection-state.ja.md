# つながりの状態と永続化

`@acp/runtime` は、つながりの型・状態検証と
`connectionPersistencePort(WorkerTrustStore)` を公開します。ストアには
`connectionState`、`connectionLevel`、`listConnections`、`listPriorApprovedPeers`、
`recordOutgoing`、`recordIncoming`、`approveConnection`、`applyAccepted`、
`rejectConnection`、`disconnect`、`block`、`unblock`、`bindInviteFirstUse` と、
承認通知の outbox 一覧・配達確認を追加します。connected は期限なしの limited に対応し、
trusted を付与しません。申し込みは最長14日、受信申し込みを断った後は同じ相手からの
申し込みを7日間受け付けません。招待は解析済み内容のダイジェストと認証済み依頼者の
所有者DIDに結び付け、解除・ブロック後も招待の有効期限まで保持します。
招待の結び付け・ローカルの同意・承認通知の保存は一括で行います。

所有者のローカル操作用APIを、ライブ受付・制御通知の交換・人間用 CLI に接続しています。
`StoredConnectionExchange` は、接続の状態と制御通知の outbox を同じストアのロック内で保存します。
従来の有限の許可は履歴として保持し、保留を省略しません。

読み取りでは鍵・ファイルの作成、書き換え、移行を行いません。新しいつながりAPIで明示的に
更新したときだけ、既存の署名付き `intake.json` をv1からv2へ移行します。
期限付き許可はつながりに変換せず、元の期限を維持します。残っている承認・許可は再同意用の
候補一覧に保持します。削除済みの履歴は復元できず、旧記録から正確な承認時刻は取得できません。
ファイル上限は従来の1 MiBで、有効なつながりを容量確保のために削除しません。
旧版はv2を読めないため、旧版に戻す必要があれば更新前にv1のバックアップを保存してください。
旧版と新版で同じストアを同時更新しないでください。

ライブ経路は[接続の受付](admission.ja.md)に統合しています。既定の検査は利用不可で、内容は保留します。

接続記録・`ConnectionPeer`・`ConnectionSummary`・`ConnectionOffer`・`PriorApprovedPeer` は、
任意の `peerDisplayName`（空でない文字列）を受け付けます。同じ所有者 DID の最初に判明した
表示名を保持し、名前のない申し込みで消しません。表示名は情報であり、識別や同意の判断には
使いません。DID を基準とし、同名の相手を統合したり、鍵の変更と推定したりしません。
表示名も既存ストアのバイト数上限の対象で、実行する内容ではありません。

受信する制御交換では、検証済み申し込みの署名付きエージェントカードから名前を取得します。
送信側の招待確認では検証済み招待から取得します。`ConnectionService.request` は検索などで
取得済みのカードを渡す任意の `peerAgentCard` も受け付け、署名・現在の有効期限・所有者 DID・
relay を所有者の同意と送信より前に検証します。依頼者は検索済みカードをこのローカル API に
渡します。タスク受付では、一致する検証済み検索カードがあればその名前を使い、
マニフェストの表示名は使いません。カードのない DID だけの依頼は名前なしのままです。
承認通知に表示名の項目は追加せず、通信形式・プロトコルスキーマは変更しません。

`WorkerTrustStore.listConnections()`・`connectionStatus()`・`connections list`・
`connections status`・`acp_list_connections`・
`acp_list_connection_requests` はこの任意項目を返します。過去の承認候補は同じ所有者 DID の
接続 metadata にある既知の名前を保持し、`listPriorApprovedPeers()` と
`connections prior-approved` が返します。表示名によって承認履歴や接続を作成しません。
招待の削除では接続の名前を消しません。表示名のない旧 v1/v2 記録は書き換えずに読めます。
受信交換の次の更新時には同意の照合を変えず、不足する名前を補えます。署名付きストアの版は
2 のままです。未知の記録項目を拒否する旧版は表示名付き記録を読めないため、新版の読み取りを
使い、異なる版で同時に書き込まないでください。

`ConnectionStatus.peerDisplayName` は任意項目で、保存済みの接続または該当する最新の申し込みから
取得します。ローカルに残る無効化済みの申し込みも対象です。状態照会は招待トークンの解決・
記録の書き換え・送信を行いません。`sealbridge/sdk` は他の接続型とともに `ConnectionPeer` と
`ConnectionStatus` も公開します。確認待ちの取り込みは招待確認の前に保存を確定し、
検証済み招待の表示名を記録します。未確認取り込みの整理では成立済みの接続 metadata を変更しません。
