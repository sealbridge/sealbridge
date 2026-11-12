# 持ち主が設定する自動受付

[English](auto-accept.md)

すべてのワーカーで同じ設定を使います。新規導入時の既定は「つながっている相手から、読むだけの仕事を自動受付」です。未接続の依頼は、持ち主が対象を変更するまで保留します。公開登録や `--allow-local-pc` は受付の許可ではありません。接続への同意と依頼側の承認も別です。

```sh
sealbridge config auto-accept                        # 表示のみ
sealbridge config auto-accept connected read-only    # 既定
sealbridge config auto-accept invited read-only      # 招待した相手
sealbridge config auto-accept anyone read-only       # 未接続も明示的に許可
sealbridge config auto-accept connected write        # 書き換え・コマンドを明示的に許可
sealbridge config auto-accept off                    # 人による承認
```

設定変更後はワーカーを再起動してください。既存の `<data-root>/config.json` に、他の項目を保持してアトミックに保存します。

```json
{
  "version": 1,
  "relays": ["https://relay.sealbridge.dev"],
  "autoAccept": {
    "version": 1,
    "enabled": true,
    "from": "connected",
    "work": "read-only",
    "limits": {}
  }
}
```

`invited` は、このワーカーの検証済み招待で成立した有効な接続が対象です。現行の最初の所有者への紐付け、期限・失効の規則を維持します。共用招待は追加しません。`connected` は有効な 0.2.0 接続が対象です。`anyone` は未接続でも受け付けますが、接続への同意は作りません。ブロック、明示した相手・依頼者の許可リスト、能力・仕事の範囲・予算・レートの検査はすべて維持します。以前保留した試行は自動で再開せず、新しい依頼を明示的に送る必要があります。

読むだけかどうかは依頼文の自己申告ではなく、ホストが保証する実行特性で判定します。アダプターが `taskAccess: 'read-only'` を保証し、許可されたツールがすべて `readOnly: true` であり、再委譲や実行可能な検証コマンドを含まない場合だけです。API のみの OpenAI 互換アダプターは該当します。任意のコマンド・CLI・MCP・sandbox アダプターは保守的に `write` または人の承認が必要です。組込み側で読むだけを保証するアダプターは宣言できます。この宣言自体は OS サンドボックスや依頼文の解析ではありません。成果物とローカル監査の保存は、持ち主の資源の書き換えには数えません。

ルールに合う依頼は毎回の検査・人の操作なしで実行します。合わない依頼には従来の検査・承認を使います。ワーカー起動時の `--auto-accept`・`--auto-approve`・`--yes` は設定対象を広げず、書き換えをオンにしません。従来の LLM 許可リスト必須条件は廃止します。独自の `PolicyAutoApprovalProvider` や旧 trusted grant も、条件に合わない依頼の自動承認には使えません。書き換え・コマンドを行う組込みアダプターの自動受付には、`autoAccept.work: "write"` の明示が必要です。

署名付き紹介カードにルール全体を載せ、CLI と MCP の依頼者確認画面には「この相手は人ではなく自動で応じます」と表示します。依頼側の送信・最終検収の承認は維持します。古いカードはこの項目を持たず、相手の表示設定がローカルの受付権限を変更することもありません。

自動受付の署名付き `ApprovalReceipt.authorization` に `kind: "auto-policy"`、`ruleVersion: 1`、ルール全体の SHA-256 `ruleDigest` を残し、双方向監査の `ACCEPT` に含めます。`--audit` は従来のタスク別保存を使います。未指定時も `<data-root>/workers/<worker-DID-hash>/auto-accept-audit/` に保存し、保存できなければ受け付けません。保持期間・整理は持ち主が管理します。

組込み API の `autoAcceptStateGuard(context, policy)` は今後の上限の検査・予約境界です。件数などの状態をアトミックに読んで予約し、正確に `true` を返した場合だけ自動承認できます。拒否・読取不能・例外なら自動承認に進まず、別の自動承認 provider にも迂回しません。#255〜#258 の DID 別日次上限、月額上限、呼出前サイズ確認、共用招待は実装せず、`limits` に設定の差込み先だけ用意します。空でない上限や未対応の版は、黙って制限なしにせず拒否します。#248 の相手別常設承認、公式ワーカーの配備、リレーの変更も含みません。
