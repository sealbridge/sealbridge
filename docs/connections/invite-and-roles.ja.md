# 招待とローカルの役割

[English](invite-and-roles.md)

招待は二者のつながりを作るためのもので、worker/requester の役割を割り当てるものではありません。
署名済み招待のペイロードに role フィールドはありません。取り込み・プレビューだけでは、接続への同意もタスク実行の承認も与えません。

仕事を受けるかはローカル設定で決まります。宛先の鍵で worker が起動している必要があり、
`config auto-accept` が自動で開ける仕事を制御します。ローカルの alias は相手を選ぶ名前で、
worker の起動や権限付与ではありません。識別には DID を使います。表示名は情報であり、同名の別人も存在します。
alias は受け取った側がローカルで設定・保存し、相手から指定される識別子ではありません。

## 現在の実装

現在は入り口によって別々の worker/requester 鍵を使います。CLI の `invite create` は worker 鍵、
MCP の `acp_create_invite` は MCP サーバーの owner 鍵（既定は requester 鍵）で署名します。
MCP の既定表示名が `Sealbridge Worker` でも、委任の宛先はその招待の owner DID です。
別の既定 worker 鍵へ表示名で転送されることはありません。同じ owner 鍵と対応する agent 識別情報で受信する worker が必要です。
MCP の招待作成だけでは worker は起動しません。明示した MCP owner と同じ鍵で動く worker は受信できるため、
署名鍵を一律に置き換えるとその宛先が変わります。`invite open` の返信招待も importer/requester 鍵で署名し、受信処理は起動しません。

現在の Muse の流れは、Muse が招待を作り、Grok Bot がローカルに保存して、起動中の Muse worker に委任するものです。
現在の接続記録は worker 側です。**一度の招待で双方から依頼できる機能はまだありません。**

`peerRef` は `workerRef` と同じ保存済み参照値を持つ、役割を限定しない別名です。
MCP の委任・削除はどちらも受け付け、両方指定する場合は同じ値が必要です。
TypeScript の `DelegateOptions` でも両方使えます（アプリ側で保存済み招待を `to` に解決する点は従来どおりです）。
CLI の委任には `--peer-ref <peerRef>` を追加し、従来の `--to <workerRef>` と `--invite` も維持します。
併用時の値は一致させてください。InviteStore メソッドと CLI の位置引数には、どちらの変数名でも同じ参照値を渡せます。
解決先は引き続き保存済み招待で、期限も確認します。接続一覧からの解決には変えていません。

## 後続の変更

owner/delegate 鍵、双方向接続、受け手の既定設定、受け付けない相手への送信前警告、MCP 一覧の追加変更、
Desktop 対応は別の段階で扱います。この準備では有効化せず、自動受付やプロトコル版も変更しません。
