# 招待とローカルの役割

[English](invite-and-roles.md)

招待は二者のつながりを作るためのもので、worker/requester の役割を割り当てるものではありません。
署名済み招待のペイロードに role フィールドはありません。取り込み・プレビューだけでは、接続への同意もタスク実行の承認も与えません。

仕事を受けるかはローカル設定で決まります。宛先の鍵で worker が起動している必要があり、
`config auto-accept` が自動で開ける仕事を制御します。ローカルの alias は相手を選ぶ名前で、
worker の起動や権限付与ではありません。識別には DID を使います。表示名は情報であり、同名の別人も存在します。
alias は受け取った側がローカルで設定・保存し、相手から指定される識別子ではありません。

## 現在の実装

未移行のフォルダでは別々の worker/requester 鍵と従来動作を維持します。CLI の `invite create` は worker 鍵、
MCP の `acp_create_invite` は MCP サーバーの owner 鍵（既定は requester 鍵）で署名します。
MCP の既定表示名が `Sealbridge Worker` でも、委任の宛先はその招待の owner DID です。
別の既定 worker 鍵へ表示名で転送されることはありません。同じ owner 鍵と対応する agent 識別情報で受信する worker が必要です。
MCP の招待作成だけでは worker は起動しません。明示した MCP owner と同じ鍵で動く worker は受信できるため、
署名鍵を一律に置き換えるとその宛先が変わります。`invite open` の返信招待も importer/requester 鍵で署名し、受信処理は起動しません。

### owner gateway と delegate 鍵への明示的な移行

既存の file-backed requester/worker 鍵が同じ data root にある状態で実行します。
適用前に旧 worker と同じ store に書き込むプロセスを停止してください。
接続・保留・配信・監査の同じ store を旧新プロセスで同時に書き込まないでください。

```sh
sealbridge worker migrate --dry-run
sealbridge worker migrate --apply
sealbridge worker start
```

起動時の adapter・承認・relay オプションは従来どおり指定します。
`--apply` 省略時も dry run です。計画を読み取り表示するだけで、ファイル・ディレクトリ・鍵の作成や通信はしません。
apply は元の鍵のバイト列と元パスを `<data-root>/worker-delegation/backups/<uuid>/` に保存してから delegate を作ります。
元の鍵は置換・削除しません。新しい鍵は `worker-delegation/<uuid>.private.json` に保存し、owner 署名の
`active.json` を最後に排他的・原子的に公開して有効化します。再実行では鍵・バックアップを維持します。
中断で未選択の新しい鍵やバックアップが残っても、未完成の設定を有効化しません。使用中の lock を自動で奪いません。
このコマンドは keychain 移行に未対応です。既存の両方の鍵がない場合も書き込み前に停止します。

移行後は既存 requester 鍵を公開上の owner とし、**新しい** delegate 鍵を実行 agent の識別に使います。
owner が招待・agent card に署名し、delegate は既存の agent-card delegation 文に署名します。
`worker start` はこの agent を使う owner gateway を起動します。MCP 招待、CLI 招待、起動時の招待は
同じ owner/delegate の組を公開します。招待作成だけでは受信処理を起動しません。

gateway が owner 鍵で relay の受信認証・復号と、session envelope・承認・双方の監査エントリーの署名を担当します。
実行 adapter に渡すのはタスク context であり秘密鍵ではありません。delegate 鍵だけが漏れても owner として署名・
owner の inbox の読み取り・owner 宛て envelope の復号はできません。owner 鍵を持つ gateway は引き続き信頼境界内です。
delegate 単独のプロセスに owner の inbox を許可する機能でも、新しい OS sandbox 境界でもありません。
公開 relay は受信先 DID による認証で、別 DID への inbox 権限付与はありません。owner gateway を残すため
relay の変更・デプロイは不要で、プロトコル版や招待の role フィールドも変更しません。

接続記録は移動・再署名しません。旧 worker の inbox と鍵・鍵ごとの記録を残し、新 owner の inbox と一緒に受信します。
過去の worker 招待・接続同意・Muse の手順と自動受付ルールを維持します。新 owner の接続は owner の既存 store に記録し、
worker 側の同意を owner へ自動移譲しません。owner 側の確認には `connections ... --role requester` と
`tasks ... --role requester`、旧記録には `--role worker` を使います。
明示的な `--key FILE` は引き続きその鍵を使い、移行設定で宛先を変更しません。
旧受信口の明示 audit/inbox パスには `.legacy` が付き、owner 側は指定パスを使います。
`--once` は一回の試行で両方の受信口を停止します。

```sh
sealbridge worker revoke-delegate --dry-run
sealbridge worker revoke-delegate --apply
```

失効は activation をバックアップしてから owner 署名のローカル失効記録を公開します。
起動中の CLI gateway は受付前に activation と失効を確認します。以降の既定起動・招待作成も停止し、旧 identity へ
自動で切り替えません。再実行は安全です。鍵は削除せず、無関係な過去の worker 招待や実行中の仕事は失効しません。
実行中の仕事も止めるには worker を停止してください。これはローカル gateway の許可であり、新しい通信上の失効種別ではありません。

`invite open` の返信招待は引き続き requester-as-agent です。移行済み gateway は owner-as-agent も受け付けるため、
旧 MCP 招待と返信招待の宛先を維持します。open だけで受信処理や双方向の依頼を有効化しません。

現在の Muse の流れは、Muse が招待を作り、Grok Bot がローカルに保存して、起動中の Muse worker に委任するものです。
現在の接続記録は worker 側です。**一度の招待で双方から依頼できる機能はまだありません。**

`peerRef` は `workerRef` と同じ保存済み参照値を持つ、役割を限定しない別名です。
MCP の委任・削除はどちらも受け付け、両方指定する場合は同じ値が必要です。
TypeScript の `DelegateOptions` でも両方使えます（アプリ側で保存済み招待を `to` に解決する点は従来どおりです）。
CLI の委任には `--peer-ref <peerRef>` を追加し、従来の `--to <workerRef>` と `--invite` も維持します。
併用時の値は一致させてください。InviteStore メソッドと CLI の位置引数には、どちらの変数名でも同じ参照値を渡せます。
解決先は引き続き保存済み招待で、期限も確認します。接続一覧からの解決には変えていません。

## 後続の変更

双方向接続、受け手の既定設定、受け付けない相手への送信前警告、MCP 一覧の追加変更、
Desktop 対応は別の段階で扱います。この準備では有効化せず、自動受付やプロトコル版も変更しません。
