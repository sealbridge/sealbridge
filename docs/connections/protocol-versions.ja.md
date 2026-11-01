# マニフェストのプロトコル版

[English](protocol-versions.md) | **日本語**

`@acp/core` は 0.1.0 と 0.2.0 のマニフェストを版別スキーマで検証します。
`validateManifest` は `protocolVersion` で選択し、
`validateSchema('task-manifest', value)` は互換ディスパッチャーを使います。
スキーマ・契約・オフライン監査の検証には版の引退時刻を適用しません。
未対応の明示的な版は `PROTOCOL_VERSION_UNSUPPORTED`、対応する版の形式不一致は
`SCHEMA_VIOLATION` です。

`spec/task-manifest.0.1.0.schema.json` は従来のv0.1スキーマIDと規則を保持します。
`spec/task-manifest.0.2.0.schema.json` は別のv0.2 IDと厳密な0.2.0の版を持ち、他の欄は同じです。
`spec/task-manifest.schema.json` は独自のIDで両者を参照し、従来の `task-manifest` 検索名を維持します。
`spec/examples/protocol-versions/` は署名付きカードの `protocolVersions` とスキルの
`taskTypes` の例です。公開カードスキーマには、既存の出力にある `accessMode` と `openPolicy` も含めます。

純粋関数 `supportedSendVersions`・`supportedReceiveVersions`・`selectProtocolVersion`・
`assertInboundProtocolVersion` は `ProtocolCompatibilityPolicy` とミリ秒の時計を受け取ります。
公開プロトコル 0.2.0 のリリース時刻は呼び出し側が指定し、この PR で日付は設定しません。
1日は 86,400,000 ms、リリースから90日未満は両版を送受信、90日以降は送信を0.2.0のみ、
180日以降は受信も0.2.0のみにします。境界の瞬間から切り替わります。
不正な方針・リリース前の時計は `PROTOCOL_POLICY_INVALID` です。
カードの `protocolVersions` 省略は0.1.0のみを意味し、将来の版の文字列は署名内に保持しても
ローカルでは選びません。カードの `version`・A2A・パッケージの版とは独立です。

`@acp/runtime` の `ProtocolPeerStore` は既存のローカル鍵とデータルート指定を受け取り、
`<data-root>/protocol-peers/<sha256-local-owner-DID>.json` に所有者署名付きで保存します。
`observe(ownerDid, agentDid, cards)` は呼び出し側から渡された現在のディレクトリ一覧で
有効な最新カードを選び、理解できる最高の版・署名付きカードのダイジェスト・観測時刻を記録します。
一覧の取得は行いません。古いカードでは記録した版を下げません。
`floor`・`snapshot` は読み取りのみで、鍵やファイルを作成しません。
`observePolicy(policy)` はそのリリース時刻で観測した最大段階を保存し、時計が戻っても
段階を維持する方針を返します。ライブ方針に適用する前に保存してください。
保存済みリリース時刻の変更には別途明示的な移行が必要です。タスクの許可は付与しません。
上限は1 MiB・相手の所有者とエージェントの組1,000件で、記録した版は自動削除しません。
永続化の失敗は `PROTOCOL_STORE_INVALID`・`PROTOCOL_STORE_BUSY`・
`PROTOCOL_STORE_UNWRITABLE` で返します。POSIX はディレクトリ0700・ファイル0600、
Windows は親ACLを継承し、その内容は検証しません。

これは独立した4本のつながり基盤の1本です。運用の既定・既存ファイル・CLIフラグ・MCPツール・
board・既定の0.1.0送信は変わりません。4本のマージ後のPR5でリリース時刻とライブ方針を結び付けます。
