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
| 保留の審査 | `ConnectionAdmissionReview`, `HeldRequestReview`, `unavailableHeldContentReviewProvider` |
| 検索・招待 | `createSignedAgentCard`, `verifySignedAgentCard`, `createInviteToken`, `inviteTokenFromUri`, `isInviteTarget`, `parseAndVerifyInviteToken`, `discoverAgentCards`, `findDiscoveredAgentCard` |
| 鍵の生成 | `generateKeyPair` |
| MCP のホスト | `AcpMcpServer`, `mcpServerCommand`, `parseMcpServerArgs`, `mcpServerOptionsFromArgs` |

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
  `InboundConnectionSummary`。
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
既定の検査 provider は利用不可です。[接続交換](connections/connection-exchange.ja.md)と
[保留内容の審査](connections/held-content.ja.md)を参照してください。

`ConnectionAdmissionReview` は保留中の受信接続に `list()`・`approve(id)`・`reject(id)` を
提供します。判断は所有者の明示操作に結び付けます。`InboundConnectionSummary` は既知のとき
任意の `peerDisplayName` を含み、表示名は情報として扱います。組み込み検査の対象は接続情報だけです。
[受信接続の審査](connections/admission.ja.md#受信接続の審査)を参照してください。

## MCP のライフサイクル

専用の stdio MCP プロセスでは `mcpServerCommand(args, identityOptions)` が既存 CLI
のライフサイクルを実行します。ホストがストリームを管理する場合は `AcpMcpServer`
を作成し、`startDelivery()`、`serve(readable, writable)` の順に待ち、`finally` で
`stopDelivery()` を呼びます。ホストのフォーム承認には
`requireInteractiveApproval: true` を指定するか、`approvalProvider` を注入します。
無指定時の policy-auto の既定値は変わりません。送信前の承認と最終検収は別です。
接続の審査には別の `connectionReview` を使います。[MCP の説明](../README.ja.md)も
参照してください。
