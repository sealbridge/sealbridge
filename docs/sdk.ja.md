# 組み込み SDK

[English](sdk.md)

`sealbridge/sdk` は既存の Sealbridge API を組み込むための公開 ESM 入口です。
sealbridge 0.3.0 から利用できます。Node.js 22 以降と、TypeScript の
`NodeNext` など package exports に対応した解決方式を使います。JavaScript と型宣言を
同梱し、利用側にワークスペースパッケージを要求しません。

```ts
import { InviteStore, resolveStoredIdentity } from 'sealbridge/sdk';
import type { InviteStoreOptions, SavedInvite } from 'sealbridge/sdk';
```

## 契約と互換性

以下の明示的な exports と型宣言の公開シグネチャが SDK の契約です。互換リリースで
項目を追加できます。0.x の破壊的変更は minor リリースとリリースノートを必要とし、
patch リリースでは互換性を維持します。既存の `sealbridge/dist/...` は引き続き解決
できますが、内部配置はこの契約の対象外です。組み込み側は `sealbridge/sdk` に移行
してください。CommonJS の入口はありません。

import だけでは、鍵の作成・招待の読み取り・待受開始・relay への通信を行いません。
各操作の動作・保存形式・承認要件・既定値は従来どおりです。relay の配備は不要です。

## 公開する値と型

すべて既存実装の直接の再 export で、ラッパーはありません。

| 分野 | 値 |
| --- | --- |
| 保存済み招待 | `InviteStore` |
| 招待文字列 | `KeychainSecretStore`, `openKeychainSecretStore` |
| 鍵の選択 | `FileKeyStore`, `KeychainKeyStore`, `inspectStoredIdentity`, `resolveStoredIdentity`, `selectKeyStore`, `keyStoreSelection`, `keychainService`, `resolveDataRoot` |
| 設定 | `readApplicationConfig`, `setApplicationKeyStore` |
| 接続の metadata | `WorkerTrustStore`（`listConnections` を含む）, `workerIntakePath` |
| 接続交換 | `ConnectionService`, `ConnectionRouter`, `StoredConnectionExchange`, `syncConnections` |
| 所有者の確認コマンド | `connectionsCommand`, `connectionHumanReview` |
| 保留の審査 | `ConnectionAdmissionReview`, `HeldRequestReview`, `unavailableHeldContentReviewProvider`, `createRuleBasedContentReviewProvider` |
| 検証済みタスク内容 | `taskContent` |
| 検索・招待 | `createSignedAgentCard`, `verifySignedAgentCard`, `createInviteToken`, `inviteTokenFromUri`, `isInviteTarget`, `parseAndVerifyInviteToken`, `discoverAgentCards`, `findDiscoveredAgentCard` |
| 鍵の生成 | `generateKeyPair` |
| MCP のホスト | `AcpMcpServer`, `mcpServerCommand`, `parseMcpServerArgs`, `mcpServerOptionsFromArgs` |
| 内容のルール検査 | `inspectRuleContent`, `CONTENT_INSPECTION_RULES`, `CONTENT_INSPECTION_RULESET_VERSION`, `CONTENT_INSPECTION_RULESET_DIGEST`, `CONTENT_INSPECTION_LIMITS` |

名前付きの型 exports:

- 招待: `SavedInvite`, `InviteStoreOptions`, `SecretStore`。
- 鍵・設定: `DataRootOptions`, `LocalIdentityOptions`, `IdentityRole`,
  `IdentityStoreOptions`, `StoredIdentity`, `KeyStore`, `KeyStoreDescription`,
  `KeyStoreSelection`, `KeyringEntry`, `KeyringModule`, `ApplicationConfig`,
  `ApplicationConfigOptions`, `RelaySelectionOptions`。
- 接続: `ConnectionState`, `ConnectionTrust`, `ConnectionRecord`,
  `ConnectionSummary`, `PriorApprovedPeer`, `ConnectionServiceOptions`,
  `ConnectionServiceResult`, `ConnectionHumanReviewProvider`,
  `ConnectionInspectionPort`, `ConnectionPersistencePort`, `ConnectionOffer`,
  `ConnectionConsent`, `ConnectionOutboxEntry`, `ConnectionAcceptanceCommit`,
  `ConnectionRedemptionCommit`, `ConnectionTransport`, `ConnectionFrame`,
  `ConnectionRouterOptions`, `ConnectedEvent`, `ConnectionsCommandOptions`。
- 審査: `HeldRequestReviewOptions`, `HeldContentReviewProvider`,
  `HeldInspectionContext`, `InspectionCompletion`, `ConnectionAdmissionReviewOptions`,
  `InboundConnectionSummary`, `HeldTaskContent`。
- MCP: `AcpMcpServerOptions`, `ApprovalProvider`, `ParsedMcpServerArgs`。
- core・転送: `KeyPair`, `Json`, `Signed`, `SignedEnvelope`, `Invite`,
  `AgentSkill`, `DiscoveryAgentCard`, `CreateAgentCardOptions`, `SignedAgentCard`,
  `RelayEndpointPolicy`, `ConnectionRequest`, `ConnectionAccepted`, `ConnectionAck`,
  `ConnectionControl`, `RelayTransport`。

## 鍵と招待の保存

同じ所有者の操作には同じ鍵・データルートの options を渡します。requester と worker
の鍵は別です。`resolveDataRoot` はパスの解決だけを行い、`inspectStoredIdentity` は
鍵を作らず検査し、`resolveStoredIdentity` は必要なら作成します。`WorkerTrustStore`
は鍵の options ではなく `path` を受け取るため、
`workerIntakePath(owner.did, identityOptions)` を使います。

OS 保管庫を使う場合は `keyStore: 'keychain'` を明示し、`InviteStore.open` を使います。
任意のネイティブ backend を runtime から利用できるようにしてください。
[鍵の保存](../README.ja.md)も参照してください。ホストは公開 options 型の
`keyStore`・`keyringLoader`・`secretStore` を注入できます。既定は file で、既存の
inline 招待は自動移行しません。`SavedInvite` は metadata のみです。`resolve` が返す
招待文字列はローカルで扱い、ログや MCP 引数へ渡さず、MCP の委任には `workerRef`
または正確な alias を使います。

以下はホストの招待入力処理内で動かす関数です。データルートはホストが管理する
絶対パスとし、入力文字列はメモリ内で扱います。

```ts
import { InviteStore, resolveStoredIdentity } from 'sealbridge/sdk';

async function saveInvitation(link: string, dataRoot: string) {
  const identityOptions = {
    env: { ...process.env, SEALBRIDGE_DATA_DIR: dataRoot },
    keyStore: 'keychain' as const,
  };
  const owner = await resolveStoredIdentity('requester', identityOptions);
  const invites = await InviteStore.open(owner, identityOptions);
  return invites.import(link); // SavedInvite: UI には metadata だけを返します。
}
```

## 所有者の確認と接続

`connectionsCommand(['confirm-invite', workerRef], options)` は既存のコマンド処理です。
`ConnectionsCommandOptions.identityOptions` でローカルの鍵を選び、`review(summary)`
で正確な判断内容を所有者本人へ示し、その操作に対する返答を返します。`output` は
JSON の metadata・イベントを受け取ります。`now`・`transportFactory`・
`inspectionProvider` を注入できます。review の省略時は既存の TTY 規則を使い、
同意したとは扱いません。

独自のホスト処理では `ConnectionService` に永続化・転送・検査・
`ConnectionHumanReviewProvider` の各 port を渡せます。`ConnectionRouter` と
`StoredConnectionExchange` は既存ストアと保留の審査を service へ接続します。
取込・プレビューは同意ではありません。招待の確認はローカルの同意と要求の送信であり、
相手側の完了を示しません。署名付き交換を受信した後に
`WorkerTrustStore.listConnections()` を読み取るか、明示的に `syncConnections` を
使います。接続後も limited で、各タスクは検査と所有者が開く操作を必要とします。
ライブラリ既定の検査 provider は利用不可です。単体 CLI は `tasks list/show` と対話式
ワーカーで内容を表示し、検査記録を残します。表示は実行承認ではなく、新しい limited タスクは
毎回ライブの所有者承認を必要とします。`tasks approve/reject` は終端の保留内容だけを閉じます。
独自ホストは引き続き検査 provider を設定します。接続審査は署名付き申し込みだけが対象で、
接続済みの相手の未承認申し込みも選択できます。CLI の所有者確認には対話式 TTY が必要です。
[接続交換](connections/connection-exchange.ja.md)と
[保留内容の審査](connections/held-content.ja.md)を参照してください。

`ConnectionAdmissionReview` は保留中の受信接続に `list()`・`approve(id)`・`reject(id)` を
提供します。判断は所有者の明示操作に結び付けます。`InboundConnectionSummary` は既知のとき
任意の `peerDisplayName` を含み、表示名は情報として扱います。組み込み検査の対象は接続情報だけです。
[受信接続の審査](connections/admission.ja.md#受信接続の審査)を参照してください。

## 保留タスク内容の検証と取り出し

`taskContent(envelope, owner, contentDigest, envelopeDigest?)` は
`HeldTaskContent` として `{manifest, input, capabilityChains}` だけを返します。
能力の既定値は `[]` です。復号前に封筒の署名と宛先を検証し、暗号化と自身の `input`
欄を必須とします。manifest と提案の署名、PROPOSE・連番0・タスク・依頼者・
ワーカー所有者・内容ダイジェストの対応も検証します。保留レコードの `envelopeDigest`
を渡すと封筒全体との一致も検証します。招待・接続・転送用の欄は返しません。
既存 CLI の内部パスからの import を含め、3引数の呼び出しも維持します。

結果は機微な平文をメモリ内に含みます。ログや永続保存に入れず、文字列データとして
表示してください。所有者向けに表示する呼び出し側は、`HeldRequestReview` による
検査完了（所有者・内容・封筒に結び付いた受領書を含む）を別途必須にしてください。
取り出し自体は検査状態を確認せず、開封・接続同意・実行を承認しません。
検査 provider は検査中にこの関数を使えます。能力チェーンの権限・信頼・現在の grant や
依頼期限の有効性は検証しません。期限を過ぎた終端タスクも内容を検証でき、
ライブ受付は従来の別の検証を維持します。構造と署名などの検証であり、
内容に対するヒューリスティックな検出・評価は行いません。

検証失敗は `INVALID_PROPOSAL`、暗号化入力の失敗は従来の
`UNENCRYPTED_ENVELOPE_REJECTED` または `ENVELOPE_DECRYPTION_FAILED` です。
スキーマやネイティブパーサーの詳細は返しません。検査受領書の作成・ファイル書き込み・
通信は行わず、プロトコル・スキーマ・必須欄・保存形式は変更しません。
[保留内容の審査](connections/held-content.ja.md)を参照してください。

## MCP のライフサイクル

専用の stdio MCP プロセスでは `mcpServerCommand(args, identityOptions)` が既存 CLI
のライフサイクルを実行します。ホストがストリームを管理する場合は `AcpMcpServer`
を作成し、`startDelivery()`、`serve(readable, writable)` の順に待ち、`finally` で
`stopDelivery()` を呼びます。ホストのフォーム承認には
`requireInteractiveApproval: true` を指定するか、`approvalProvider` を注入します。
無指定時の policy-auto の既定値は変わりません。送信前の承認と最終検収は別です。
接続の審査には別の `connectionReview` を使います。[MCP の説明](../README.ja.md)も
参照してください。

## 監査の中断証拠

`parseJsonl` / `verifyAudit` は双方署名の形式専用を維持します。`parseAuditJsonl` / `verifyAuditEvidence` は `AuditEvidence`（`AuditBundle | InterruptedAuditBundle`）を扱い、ワーカー単独の形式 1 の終端は、外部ピンが一致しても `UNILATERALLY_CLOSED`・`valid:false` です。`createAuditInterruption`・対応ストア・関連公開型も `sealbridge/sdk` から利用できます。[保存形式・ピン・永続化・依頼者との照合規則（英語）](audit-interruption.md)を参照してください。

## 明示的に選ぶオフラインの内容検査

`inspectRuleContent({manifest,input,capabilityChains?}, limits?, signal?)` は
core のメモリ上の検査器です。公開する型は `RuleInspectionInput`、
`RuleInspectionOptions`、`RuleInspectionRule`、`RuleInspectionKind`、
`RuleInspectionFinding`、`RuleInspectionDiagnosticCode`、`RuleInspectionReport`、
`RuleBasedContentReviewOptions` です。ルールと走査は core、子プロセス管理は runtime
が担当します。edge の入口は変えません。

保留中のタスクには、プロバイダを明示的に渡します。

```ts
import { HeldRequestReview, WorkerNode, createRuleBasedContentReviewProvider } from 'sealbridge/sdk';

const inspectionTimeoutMs = 5000;
const heldReview = new HeldRequestReview(owner, {
  ...identityOptions,
  inspectionTimeoutMs,
  provider: createRuleBasedContentReviewProvider({
    timeoutMs: inspectionTimeoutMs,
    onReport(recordId, report) {
      // 所有者向けの資料として、メモリ上で文字どおり表示する。
      renderInspection(recordId, report);
    },
  }),
});
const worker = new WorkerNode({ ...workerOptions, owner, heldReview });
```

`owner`・`identityOptions`・`workerOptions`・`renderInspection` は組み込み側が用意します。
プロバイダの制限時間は review 以下にします。両方の既定は5秒、指定範囲は1〜45,000 ms
です。中止、どちらかの時間切れ、失敗で子を終了します。コールバックの例外・拒否・中断・
時間超過でも完了になりません。コールバックへ渡すレポートは複製なので、変更しても受領の
内容は変わりません。これはホストの処理であり、任意のコードを隔離する口ではありません。

外側の封筒署名、暗号化された宛先、署名付き proposal、manifest、タスク・送信者・
ワーカーと保留ダイジェストの一致を確認してから、manifest・input・capabilities だけを
固定のビルド済み検査器へ IPC で渡します。所有者の鍵と通信用の資格情報は渡しません。
環境変数は許可リストから作り、結果は64 KiBまでとし、中止・時間切れ・失敗で子を終了します。
平文ファイルやログを書かず、ネットワーク要求・DNS照会・実行・アーカイブの展開をしません。
カーネルのネットワーク隔離ではなく、固定の信頼したコードです。外部プラグイン、ダウンロード
したルール、呼び出し側の正規表現・ソースコードは受け付けません。

変更不可の記述子・検出器の版・既定の上限から `CONTENT_INSPECTION_RULESET_DIGEST` を
作ります。既定は直列化した内容256 KiB、深さ32、ノードとキー合計100,000、文字列ごと
UTF-8で64 KiB、所見100件、base64復号合計64 KiBです。`limits` では下げることだけができます。
作業量・出力の上限超過は `error` とし、切り詰めて成功にはしません。manifest の全欄・
input・capabilities・文字列のキーを JSON Pointer 順で検査します。位置は元の文字列の
UTF-16単位です。パスは `~0`・`~1` でエスケープし、機微な内容の可能性があるキーは
`[redacted]` に置き換えます。所見の説明と診断は固定コードで、証拠の抜粋やURLの値は
含めません。通常のキーは位置に含まれるため、レポートも確認用の資料として扱います。

見えない文字・制御文字、英語と日本語の指示表現、URLの形、秘密を求める語と動詞の
組み合わせ、資格情報の典型的な形、コードの目印、長いbase64を検出します。復号は上限を
設けて1回だけ行い、実行形式・アーカイブの先頭バイトなら `block` にします。検出は
ヒューリスティックです。通常の引用文にも反応し、未対応の表現は通ることがあります。
資格情報をオンラインで確認しません。`pass` はこのルールで所見が出なかったことを示します。
`pass`・`warn`・`block` の完了はいずれも既存受領の `complete` になり、`block` は
所有者への最も強い注意です。実行許可や開封にはならず、その会期の人間による契約承認は
引き続き必要です。失敗は途中の所見より優先し `error` になり、検査完了前の表示を許可しません。

`contentDigest` は `digest({manifest,input})` です。capabilities と実効上限はレポートと
正確な封筒を通じて結び付けます。core 単体で上限内の JSON 複製を作る前に失敗した場合は、
不完全な値として `digest(null)` を返します。エラーレポートを内容の検証に使わないでください。
runtime は認証できた保留のダイジェストにエラーレポートを結び付けます。既存受領の
`reportDigest` は `{recordId,ownerDid,kind,contentDigest,envelopeDigest,report}` の
ハッシュです。保存するのはこのダイジェストだけで、レポート全体は `onReport` のメモリ内に
とどめます。既存受領に所見はなく、`HeldRequestReview.inspect` はキャッシュ済み完了を返す
場合があります。再起動後にレポートが必要なら、保存済み封筒と対応する inspection context
でプロバイダを明示的に再実行します。受領から所見なしと推定せず、ディスクにレポートの
キャッシュを作らないでください。

task 以外は `unavailable` です。既定の検査、CLI の表示、trusted の受付、MCP、自動承認の
動作は変わりません。protocol・schema・manifest 必須欄・通信形式・保存形式を変えません。
