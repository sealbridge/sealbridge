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
このコマンドは keychain 移行に未対応です。worker 鍵がなければ書き込み前に停止します。
worker 鍵だけのフォルダーは移行せず従来どおり使えます。移行を選ぶ場合は
`sealbridge worker migrate --create-owner` で確認し、
`sealbridge worker migrate --create-owner --apply` で適用します。
元の worker 鍵をバックアップしてから、別の requester owner 鍵と新しい delegate を作成します。
worker 鍵を owner に転用・置換しないため、旧招待の識別を維持します。
requester 鍵がなく、このオプションもない場合、エラーは上の実行コマンドを表示します。
owner 作成後に中断した場合、その新しい鍵を保持して再試行できます。

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
旧受信口の明示 audit/inbox パスは `.jsonl` の前に `.legacy` を挿入します。
`audit.jsonl` は `audit.legacy.jsonl`、`inbox.jsonl` は `inbox.legacy.jsonl` です。
`.jsonl` がないパスには `.legacy.jsonl` を付けます。owner 側は指定パスを維持します。
鍵ごとの task journal と監査チェーンを共有しないため、別ファイルが必要です。
明示的に移行した後は通知 watcher を `inbox.jsonl` と `inbox.legacy.jsonl` の両方、
または `inbox*.jsonl` に設定してください。未移行なら変更不要です。
`audit-verify` は内容で JSON/JSONL を判定し、過去の `audit.jsonl.legacy` も検証できます。
`--once` は一回の試行で両方の受信口を停止します。

```sh
sealbridge worker revoke-delegate --dry-run
sealbridge worker revoke-delegate --apply
```

失効は activation をバックアップしてから owner 署名のローカル失効記録を公開します。
起動中の CLI gateway は受付前に activation と失効を確認します。以降の既定起動・招待作成も停止し、旧 identity へ
自動で切り替えません。再実行は安全です。鍵は削除せず、無関係な過去の worker 招待や実行中の仕事は失効しません。
実行中の仕事も止めるには worker を停止してください。これはローカル gateway の許可であり、新しい通信上の失効種別ではありません。

失効後の復旧は worker を停止してから実行します。

```sh
sealbridge worker migrate              # 復旧計画を確認（dry run）
sealbridge worker migrate --apply      # バックアップ後、新しい delegate を発行
sealbridge worker start                # 従来の起動オプションを指定
```

復旧では元の owner/worker 鍵、以前の activation、delegate 鍵、失効の証拠を
バックアップしてから owner 署名の新しい activation を公開します。
原子的に置換するのは activation metadata だけで、鍵と署名済み失効記録は保持します。
毎回新しい delegate を生成し、古い activation に戻しても失効済み delegate は拒否します。
再度の失効・復旧でも過去の失効を保持し、旧 `revoked.json` 形式にも対応します。
バックアップ・書き込みに失敗しても失効中の activation を維持し、手動の削除や編集は不要です。
owner 宛ての既存招待は引き続き届きますが、失効した delegate を公開する招待は
新しい実行 identity を公開するため再発行してください。

`invite open` の返信招待は引き続き requester-as-agent です。移行済み gateway は owner-as-agent も受け付けるため、
旧 MCP 招待と返信招待の宛先を維持します。open だけで受信処理や双方向の依頼を有効化しません。

## 双方向接続とローカルの名前

Muse が招待を作り、Grok Bot がローカルに保存して、起動中の Muse worker に委任する
従来の手順は維持します。`accept` は引き続きローカル保存です（既存の短縮リンクの解決を除く）。
接続交換を送信せず、保存だけでは接続同意やタスク承認を与えません。

接続記録を作るタイミングは、既存の署名付き接続交換に従います。

- `connections confirm-invite <peerRef-or-workerRef>` はローカル所有者に接続への同意を別途確認し、
  送信前に outgoing の保留記録を保存します。作成側の起動中の受信処理が申し込みを
  検証・検査して招待を受理すると、作成側に接続済み記録ができます。
  保存側は署名付き受諾を受信・検証した時点で接続済みとなり、最後の ACK で配送を確認します。
  遅れて届く受諾には保存側で受信処理または
  `connections sync --role requester --relay <URL>` を動かしてください。
- 招待を使う初回 delegate も、既存の独立した接続同意の確認後に同じ申し込みを添付できます。
  作成側は検証済みタスクが招待を使用した時点で接続記録を作り、依頼側は署名付き接続受諾を
  受信した時点で逆方向の接続記録を作ります。同意を断った場合や接続確認チャネルがない場合も
  従来の招待タスクの経路は維持しますが、依頼側の接続同意を勝手に作りません。
  `--auto-approve`・`--auto-accept` は接続同意の確認に回答しません。

CLI は署名付き接続申し込みの metadata をタスク本文と別に検査し、非対話 worker でも
発行者自身の招待を受理して署名付き受諾を送れます。タスク検査の完了や実行承認にはならず、
受理可能な招待のない申し込みには引き続き所有者の同意が必要です。

交換が受諾されれば双方にそれぞれの接続記録があり、元の招待作成者からも仕事を送れます。
受信側では宛先の identity で worker が起動し、その仕事を受け付ける必要があります。
接続同意で worker が起動したり、タスク実行が承認されたりはしません。
作成側の自動受付は維持し、新しい保存側接続には相手別の許可が必要です。

接続は交換に参加した DID の既存の署名付き**鍵ごとの接続ストア**に保存します。
未移行で鍵が別の場合、作成側の記録は worker 鍵、保存側の記録は requester 鍵に属します。
未移行の既定 `worker start` は従来どおり worker 鍵だけで受信します。
既存の別 requester 鍵でも返信を受ける場合だけ `--also-requester` を明示してください。
追加 listener の自動受付は**オフ**で、`--auto-accept` やフォルダの設定を継承しません。
所有者が別途 `--requester-auto-accept read-only|write` または相手別の `allow` を指定すると、接続済みの相手から
その種類の仕事を自動受付します。requester 鍵は新規作成しません。
`--also-requester` と `--key` は併用できず、owner 宛てをすでに受信する移行済み環境でも不要なため拒否します。
追加 listener の明示的な監査・inbox パスは `*.requester.jsonl` となり、
元の worker パスは維持します。`--key FILE` はその identity だけを選びます。
移行済み owner/delegate は owner のストアを使い、旧 listener と `*.legacy.jsonl` を維持します。
記録のコピー・移動・読み取り時の書き換えはなく、移行操作も不要です。

```sh
sealbridge connections list
sealbridge connections list --role requester
sealbridge connections alias <peer-DID-or-current-alias> reviewer
sealbridge delegate --to reviewer --title "Review" --description "Review input" --input-file input.json
```

`connections list` は既存の両ローカル identity について、ローカル別名、`peerOwnerDid`、
`localOwnerDid`、接続状態を表示します。`--role worker`・`--role requester`・`--key FILE` で
絞れます。従来のトップレベル `role`・`localOwnerDid` は選択・既定 identity（既定 worker）を示し、
`scope: "all"` が全体一覧を表します。各行の `localOwnerDid` でその接続の所属を判断してください。
別名変更はローカルだけで完結し、通信せず、相手の DID や接続同意を変更しません。
名前が曖昧な場合は相手 DID と role/key を指定してください。

既定別名は保持済みの相手表示名を小文字にし、ASCII 英数字以外の連続を `-` に置換し、
両端のハイフンを除いて最大64文字とします。空なら `peer` です。
変更後の別名は小文字 ASCII 英数字・`_`・`-` の1〜64文字で、先頭は英数字です。
同じ表示名から同じ既定別名ができた場合は**曖昧エラー**とし、勝手な採番・選択はしません。
表示名と別名は識別子ではなく、識別には DID を使います。変更した別名は owner 署名付きの
`<data-root>/connection-aliases/<sha256-local-owner-DID>.json` に保存します。
接続記録と別ファイルにすることで、未知フィールドを拒否する旧ストアリーダーとの共有を維持します。

表示名は相手が設定できます。既定別名を使う前に相手 DID を確認し、必要ならローカルで変更してください。
曖昧な場合は常に拒否します。クラッシュ後に別名ストアのロックが残ると、エラーが正確なパスを表示します。
書き込みプロセスが存在しないことを確認してから手動でそのロックだけを削除してください。
動作中の書き込みロックを自動削除することはありません。

### `--to` の解決と互換性

1. 招待リンク・トークンと `did:...` は従来どおり解釈します。
   `saved:...` は必ず招待ストアで期限を検査して解決します。
2. 通常の `--to <name>` は既存 requester/worker の接続別名を検索します
   （`--key FILE` ならその鍵だけ）。一意な接続済み候補から相手 DID、記録済みの relay/agent DID、
   その接続を持つローカル署名 identity を選びます。公開ディレクトリへの登録は不要です。
3. 保存済み招待別名との衝突判定には接続済み別名だけを使い、保留・ブロックの別名で招待を隠しません。
   保存済み招待と接続候補が**同じ相手 DID**なら、有効な間は確認待ち検査を含む招待解決を優先します。
   期限切れなら同じ DID の一意な接続済み候補に切り替えます。明示的な保存参照は期限検査を維持します。
   **異なる相手 DID**の接続候補があれば `CONNECTION_TARGET_CONFLICT` です。
   保存済み招待がなく接続済み候補が複数なら `CONNECTION_ALIAS_AMBIGUOUS` とします。
   接続別名を変更するか DID / `saved:...` を指定して区別してください。
4. 接続候補がなければ従来の招待別名・参照の解決をそのまま実行します。
   不明な名前は `INVITE_NOT_FOUND`、保留・ブロック状態の接続別名は `CONNECTION_NOT_CONNECTED` です。

`peerRef` は `workerRef` と同じ保存済み参照値を持つ、役割を限定しない別名です。
MCP の委任・削除はどちらも受け付け、両方指定する場合は同じ値が必要です。
TypeScript の `DelegateOptions` でも両方使えます（アプリ側で保存済み招待を `to` に解決する点は従来どおりです）。
CLI の委任には `--peer-ref <peerRef>` を追加し、従来の `--to <workerRef>` と `--invite` も維持します。
併用時の値は一致させてください。InviteStore メソッドと CLI の位置引数には、どちらの変数名でも同じ参照値を渡せます。
`--peer-ref`・`--invite` は期限検査を含む従来の招待ストア解決を維持します。
`--to <name>` のみ、上記の接続別名の解決を追加します。

## 相手別の自動受付（Q2）

この変更以降、招待の署名付き受諾を検証して新たに成立する**保存側**の接続は、
ローカルに `acceptance: "off"` を記録します。`accept` 自体は招待保存だけです。
招待作成側の自動受付は変わらず、Muse が招待を作り Grok Bot が保存して依頼する手順に追加操作はありません。

```sh
sealbridge connections allow reviewer             # 読み取り専用
sealbridge connections allow reviewer write       # 書き込みを明示許可
sealbridge connections disallow reviewer          # 所有者の承認へ戻す
sealbridge connections list
```

変更は選択したローカル接続の署名付き記録だけです。通信せず DID も変えません。
不明な名前は `CONNECTION_NOT_FOUND`、曖昧な名前は `CONNECTION_ALIAS_AMBIGUOUS` です。
相手 DID と `--role requester|worker` または `--key FILE` で選択してください。
保留・ブロック中の相手は許可できません。表示名・別名は識別子ではありません。
一覧は従来の項目を維持し、`acceptance` に `off`・`read-only`・`write`・
`folder-policy`（相手別設定なし）を追加します。

- 既存記録で任意フィールドがないものは、従来の `config auto-accept` の
  invited/connected/anyone、read-only/write、明示的な off をそのまま使います。
  読み取りで移行・書き換えはしません。
- 新しい保存側接続の `off` はフォルダの全 audience/work 設定、`--auto-accept`、
  `--requester-auto-accept`、旧 trusted 許可より優先します。タスクには検査と所有者の
  ライブ承認が必要で、できなければ `PENDING_OWNER_APPROVAL` で終わります。
- `allow` はその相手だけの明示的な許可です。enabled/audience/work を
  enabled/connected/read-only（明示時は write）に置き換え、フォルダが off でも有効です。
  予算・回数・サイズなど既存の制限は維持し、読み取り専用の host/adapter 検査も必要です。
  他の相手には影響しません。`disallow` は広いフォルダ設定でも所有者承認へ戻します。
- 宛先 identity の listener は引き続き必要です。未移行の別 requester 鍵には
  `--also-requester` を使い、追加 listener は主 worker の設定を継承しません。
  `--requester-auto-accept` は相手別設定がない接続に適用し、`allow` は指定相手だけを許可します。
  移行済み gateway は既に owner 宛てを受信します。相手別設定は各タスクで再読込します。

通信上の状態通知は追加しません。旧記録は移行不要ですが、新しい任意フィールドは
更新済みリーダーで検証します。新フィールドを使うストアに旧版 writer を同時起動しないでください。

## 送信前の警告（Q3）

`delegate --to <接続別名>` は、相手所有者の承認待ちになる**可能性**を stderr に表示し、
そのまま送信します。ローカル接続は識別と経路の根拠であり、相手の最新受付設定は不明です。
相手が後から `allow` / `disallow` したかは分からないため断定しません。
`--quiet-approval-warning` で stderr の警告を抑制できます。結果 JSON は従来項目を維持し、
抑制時も code `PEER_APPROVAL_MAY_BE_REQUIRED` と message を持つ `acceptanceWarning` を追加します。
明示的な招待・保存参照は従来の動作を維持し、新警告は出しません。

## 後続の変更

MCP の接続相手一覧・名前指定（PR5）、実際の Muse ↔ Grok Bot の end-to-end テストと
README ガイド（PR6）、Desktop は後続です。プロトコル版・招待 payload は変更しません。
