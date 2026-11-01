# Sealbridge Protocol Specification (`spec/`)

[English (README.md)](./README.md) | **日本語**

**結論**: 本ディレクトリはプログラミング言語に依存しないプロトコル仕様と JSON Schema (Draft 2020-12) の正本（Single Source of Truth）を定義する。すべてのプロトコルオブジェクトは **RFC 8785 (JCS: JSON Canonicalization Scheme)** で正規化されたバイト列に対して **SHA-256 ダイジェスト** と **Ed25519 署名** を計算する。

---

## 1. 共通暗号・シリアライズ規則

1. **エンコーディング**: UTF-8 JSON（I-JSON サブセット準拠、浮動小数点の誤差を避けるため金額・トークン数・秒数はすべて整数 `integer` で表現する）。
2. **正規化（Canonicalization）**: 署名およびハッシュ計算の対象となるJSONオブジェクトは、[RFC 8785 (JCS)](https://www.rfc-editor.org/info/rfc8785/) に従ってキーを辞書順ソートし空白を除去した決定論的バイト列に変換する。
3. **識別子（Principal ID）**: オーナーおよびエージェントの識別子は W3C `did:key` 形式（Ed25519公開鍵のMultibase base58btcエンコード、例: `did:key:z6Mk...`）を使用する。
4. **ダイジェスト表記**: `"sha256:<64文字の16進小文字>"`（例: `"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"`）。
5. **署名表記**: `"ed25519:<base64urlまたは128文字の16進小文字>"`。署名計算時は対象オブジェクトから `signature` / `signatures` フィールドを除いた状態でJCS正規化を行う。

---

## 2. コアスキーマ一覧

| ファイル名                                                 | ステータス              | 役割                                                                                                                                                                            |
| :--------------------------------------------------------- | :---------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`task-manifest.schema.json`](./task-manifest.schema.json) | **Draft v0.1 (検証済)** | 依頼側（Requester）が提示するタスク仕様・入出力JSON Schema・受入基準・検証方法・予算上限・付与Capability・隔離要件の定義                                                        |
| `capability-token.schema.json`                             | Planned (M0)            | UCAN/Biscuit風の減衰可能スコープトークン定義（`issuer`, `audience`, `taskId`, `resources`, `allowedTools`, `argConstraints`, `maxInvocations`, `maxDelegationDepth`, `proofs`） |
| `envelope.schema.json`                                     | Planned (M0)            | Relay通過用の署名付きメッセージエンベロープ（`envelopeId`, `taskId`, `seq`, `eventType`, `senderDid`, `recipientDid`, `payload`, `signature`）および受領確認 `AckReceipt`       |
| `audit-entry.schema.json`                                  | Planned (M0)            | 双方向署名ハッシュチェーン台帳エントリおよび `UsageReceipt` / `ApprovalReceipt`                                                                                                 |

---

## 3. スキーマ検証コマンド

### マニフェストのプロトコル版

版別の0.1.0/0.2.0スキーマは `task-manifest` ディスパッチャーで選択し、下のコマンドで両者を参照します。
0.1.0の規則と元のサンプルは引き続き有効です。レジストリ・署名付きカードの例・互換方針は
[プロトコル版](../docs/connections/protocol-versions.ja.md)を参照してください。

```bash
npx --yes -p ajv-cli@5 -p ajv-formats@3 ajv validate \
  --spec=draft2020 \
  -c ajv-formats \
  -s spec/task-manifest.schema.json \
  -r 'spec/task-manifest.*.schema.json' \
  -d spec/examples/sample-task-manifest.json
```

## M0–M1 実行可能なワイヤプロファイル

新しい `capability-token`、`usage-receipt`、`approval-receipt`、`ack-receipt`、`envelope`、`audit-entry` のスキーマは実装済みです。`pnpm validate:schemas` を実行すると、Ajv Draft 2020-12 で全スキーマをコンパイルし、すべてのサンプルを検証します。

署名付きプロトコルオブジェクトは `{ "payload": <object>, "signature": <block> }` です。`D = "sha256:" + hex(SHA256(UTF8(JCS(payload))))` とします。ブロックには `signerDid`、`canonicalization: "RFC8785-JCS"`、`payloadDigest: D`、`signedAt`、パディング無しの `signature: "ed25519:" + base64url(64-byte-signature)` が入ります。Ed25519 署名の正確なプレイメージは次のとおりです。

```text
UTF8(JCS({payload, signerDid, canonicalization, payloadDigest, signedAt}))
```

これはペイロードと署名メタデータを覆い、署名バイトそのものは署名しません。上の草案にある一般規則を、この形に精密化しています。JCS の入力は、有効な Unicode を持つ有限の JSON データでなければなりません。`undefined`、循環、疎な配列、非有限数、独自のオブジェクトインスタンス、孤立サロゲートは拒否します。JSON 成果物のコンテンツアドレスは `SHA256(UTF8(JCS(data)))` です。バイナリそのものには `digestBytes` を使います。did:key は Ed25519 公開鍵を、マルチコーデックのバイト `ed 01` と base58btc マルチベース `z` で符号化します。

Capability の証明は、根から葉へ並んだ署名付きトークンの配列です。各子は、完全に署名された親の SHA-256 ダイジェストへ `parentHash` を束縛し、発行者を親の audience に変え、タスク束縛を保ち、リソース・ツール・引数スキーマを狭め、maxCalls と期限を上げず、notBefore を過去へ戻さず、maxDepth を少なくとも 1 減らします。深さが 0 なら、さらに子を作れません。ワイヤ上の `maxCalls` / `maxDepth` は、マニフェストの付与である `maxInvocations` / `maxDelegationDepth` に対応します。引数スキーマはツール名をキーにします。同一スキーマか、直接の `allOf` 継承だけを受理します。対応するスコープとスキーマ構文はセキュリティモデルを見てください。

承認レシートのゲート名は、マニフェストのゲート名へ次のように対応します。

| レシートのゲート     | マニフェストのゲート      |
| -------------------- | ------------------------- |
| contract_acceptance  | GATE_CONTRACT_ACCEPT      |
| external_side_effect | GATE_EXTERNAL_SIDE_EFFECT |
| budget_increase      | GATE_BUDGET_OVERRUN       |
| redelegation         | GATE_SUB_DELEGATION       |
| final_verification   | GATE_DELIVERY_ACCEPT      |

オーナー署名の承認レシートは、タスク、ゲート、対象ダイジェストそのもの、APPROVED / REJECTED の決定を束縛します。ゲートのインスタンスはレシートの再生を拒否します。署名付き遷移は、契約ダイジェスト、タスク、直前の状態、0 始まりのシーケンスを束縛します。M1 の遷移プロファイルは PROPOSED、ACCEPTED、IN_PROGRESS、DELIVERED、VERIFY_ACCEPT、VERIFY_REJECT、SETTLED、CANCELLED、DISPUTED です。網羅表は `conformance/state-transitions.json` にあります。PROPOSE が PROPOSED を確立します。アーキテクチャにある交渉、再試行、タイムアウト専用の状態は、後の拡張です。

監査本体のフィールドは `taskId`、0 始まりの `seq`、`prevEntryHash`（起源では null）、`actorDid`、`receiverDid`、`eventType`、`payload` です。`entryHash = digest(body)` です。`actorSignature` は本体に署名し、`counterSignature` はそのハッシュ、タスク、双方を束縛する署名付き AckReceipt です。最終の署名付きチェックポイントは件数、head、行為者を固定し、相手がもう一度署名します。JSONL は `{"entry": ...}` レコードのあとに、1件の `{"checkpoint": ...}` レコードが続きます。バンドルは `{entries, checkpoint}` です。オフライン検証にはチェックポイントが必要です。より古い有効なバンドルへの巻き戻しを検出するには、独立して入手した最新の head が必要です。

妥当な `reportProgress` は途中の `metrics` を含められます。その使用量は、進捗フレームをキューへ入れる前にセッションのクォータへ計上されます。不正な `reportProgress` ペイロード（`INVALID_PROGRESS`）は、その `metrics` を適用しません。返された Promise は直ちに拒否され、セッションは粘着的な失敗を記録するため、その後の成果物で `SETTLED` にはなりません。アダプタが Promise 拒否を catch しても、依頼者は `PEER_REJECTED: {"code":"INVALID"}` を観測し、ワーカーは `INVALID_PROGRESS` で失敗します。

A2A の AgentCard、Task、Message、Artifact は SDK のワイヤ形を保ち、署名付き Sealbridge エンベロープの中に載ります。ブリッジは、インストール済みの A2A SDK 0.3 のワイヤプロファイルを使います。Sealbridge の契約とレシートは、A2A を書き換えるのではなく、オーバーレイのペイロードです。MCP の `tools/call` の要求と結果は公式 SDK を使い、サンドボックスの外で物理的にプロキシされます。未知のツールと、メタデータの無い迂回は拒否します。

## M2/M3 追加のディスカバリとセッションプロファイル

M0/M1 の JSON スキーマとサンプルは変更していません。署名付き AgentCard と招待は、同じ `Signed<T>` のプレイメージを使います。`AgentCard` には ownerDid、agentDid、relayEndpoint、skills（任意の JSON 入出力スキーマを含む）、costModes、name、description、version が入ります。カードに署名するのはオーナーです。`AgentInvite` は、完全に署名されたカードを、同じ ownerDid / agentDid と relayUrl、および issuedAt / expiresAt に束縛します。パーサは、無効な署名、一致しない識別子や経路、未来の発行時刻、期限切れを拒否します。URI の符号化は `acp-invite:<base64url(JSON(Signed<AgentInvite>))>` または `acp://invite?token=<same-base64url>` です。

セッションのエンベロープは、送信者ごとに単調なシーケンス番号を持ちます。各アプリケーションイベントのあとに、署名付き監査本体を運ぶ `AUDIT_ENTRY` エンベロープが続き、受信者は署名付き AckReceipt を運ぶ `AUDIT_ACK` を返します。双方が同一の AuditEntry を追記します。`CHECKPOINT` と `CHECKPOINT_ACK` は、最終の署名付きチェックポイントと副署を交換します。DELIVER には成果物、利用量、実行証明、およびその署名付き遷移が含まれます。証明は `effectiveIsolationLevel` と `sandboxBoundary`（`nodePermissionFlag`、`permissionModelActive`、`kernelNetworkIsolated`）を追加できます。`node:vm` はセキュリティ機構ではないです。Node の `--permission` / `--experimental-permission` は `fetch`、`node:net`、`node:http`、`node:https`、`node:dns`、`node:dgram` を止めません。`kernelNetworkIsolated` が真になるのは `oci_container`（`isolationLevel: 'oci_container'`）だけで、その経路はカーネルのネットワーク境界です（`--network none`、`--read-only`、`--cap-drop ALL`、`no-new-privileges`）。`subprocess_restricted` は権限フラグと `--allow-fs-read`、`--allow-fs-write` を組にすることがあります。元の M1 証明も有効なままです。
