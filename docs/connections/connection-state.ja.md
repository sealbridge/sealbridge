# つながりの状態と永続化（準備段階）

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

所有者のローカル操作用APIです。呼び出し側が所有者の承認、検証済みの申し込み・承認通知、
解析・検証済みで失効していない招待を渡します。通信・審査・実際の受付との接続は別途行います。
既存の `level`・`decide`、CLI・MCP・board の動作は変更しません。
運用上の既定値は、独立した4つの基盤PRがマージされた後の切り替えPRまで変わりません。

読み取りでは鍵・ファイルの作成、書き換え、移行を行いません。新しいつながりAPIで明示的に
更新したときだけ、既存の署名付き `intake.json` をv1からv2へ移行します。
期限付き許可はつながりに変換せず、元の期限を維持します。残っている承認・許可は再同意用の
候補一覧に保持します。削除済みの履歴は復元できず、旧記録から正確な承認時刻は取得できません。
ファイル上限は従来の1 MiBで、有効なつながりを容量確保のために削除しません。
旧版はv2を読めないため、旧版に戻す必要があれば更新前にv1のバックアップを保存してください。
旧版と新版で同じストアを同時更新しないでください。
