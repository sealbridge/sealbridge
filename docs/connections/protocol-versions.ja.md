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
`taskTypes` の例です。新しいカードは運用モードを出力せず、旧カードの署名済み原本は検証用に保持します。

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

ライブ経路は `LiveProtocol` を使い、CLI/MCP は相手の版の観測を保存します。
`buildTaskManifest` の既定は0.2.0で、送信は署名前に相互の対応版を選びます。
カードのない DID は0.1.0のみと判断し、対応しない指定済みマニフェストは書き換えず拒否します。
明示的な保留再送は版を選び直します。0.1.0の依頼は接続があっても接続由来の入場を認めません。
過去の監査検証にリリース時計は適用しません。

`packages/runtime/src/protocol-release.ts` の `PROTOCOL_020_RELEASED_AT` は現在 `null` です。
これは公開前の状態を表し、両版を受け付け、相互に対応する最新の版で送ります。今日を起点にはしません。
`npm pack` を含むパッケージ作成は、公開前の未設定状態でも実行できます。
保守者は0.2.0の公開を有効にする実際のUTC時刻を設定し、公開前に `pnpm run check:protocol-release` を実行します。
このコマンドはビルド後に `assertProtocolReleaseConfigured` を呼び、未設定・不正な時刻を拒否します。
`npm publish`（`--dry-run` を含む）でも `prepublishOnly` により同じ確認を実行します。
ホスト・テストは `protocolPolicy` と `now` を
注入できます。CLI/MCP の利用者ごとに起点を変えるフラグはありません。保存済み起点の変更は明示的な移行が必要です。
登録時に受信対応版を計算し、期間が変わればカードを署名し直します。古いカードで現在の方針は変わりません。

[接続の受付と移行](admission.ja.md)も参照してください。
