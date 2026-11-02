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
