# セキュリティ証明 / レッドチーム敵対スイート

[English (SECURITY_PROOF.md)](./SECURITY_PROOF.md) | **日本語**

> **位置づけ（形式的証明ではなく敵対的セキュリティテストスイート）：** この文書の各「証明」は、具体的な脅威の種類を、参照実装における強制機構と、`conformance/security-proofs.test.ts`（および P0〜P2 の適合性テスト）の実行可能な敵対的回帰テストへ対応づけます。これらは CI で `pnpm test:security-proof` として実行する経験的なセキュリティおよびレッドチームの回帰テストであり、機械検査された形式的・数学的証明（たとえば TLA+、Coq、Lean、記号的なプロトコル検証）ではありません。

懐疑的な検証者は、本番関数を直接叩く敵対的テストを次の1コマンドで再実行できます。

```sh
pnpm test:security-proof
```

中身は `vitest run conformance/security-proofs.test.ts` です。CI のステップ **Run Security Proof Suite (Red-Team Adversarial Tests)** も同じコマンドを、通常の `pnpm test` のあとに実行します。合格が確認そのものです。秘密情報の漏えい、注入コマンドの実行、他セッションの読取り、偽造署名の受理が1件でも起きると失敗します。全体の回帰は `pnpm test` のままです。

行の読み方: 「脅威」は再現する攻撃、「制御」は止めるコード、「テスト」は `conformance/security-proofs.test.ts` の `describe` / `it` 名です。テスト名は英語のまま検索してください。

### 証明 1 — メモリと環境変数からの秘密情報持ち出し

侵害されたワーカー作業が `process.env` をダンプしたり、資格情報ブローカーを覗いたり、期限切れ・偽造・別タスクのハンドルを引き換えたりして、`OPENAI_API_KEY` や `GITHUB_TOKEN` などのホスト秘密を回収しようとする攻撃です。PHP2Shell 以後のメモリ開示、および `CVE-2026-109618` / `CVE-2026-109619` と同じ類の脅威です。生のプロバイダー鍵はホストプロセスに残します。

| 脅威                                         | 制御                                                                                                                                                                                                                              | テスト                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| コマンドワーカーがホスト環境をダンプする     | `packages/sandbox/src/index.ts` の `sanitizedEnvironment` が許可リストを新規に作る。`packages/adapters/src/command.ts` の `CommandAgentAdapter.executeCommand` は、そのリストに `PATH` と `TASK_INPUT_FILE` だけを足して渡す。    | `Proof 1: memory and environment secret exfiltration` の command worker env |
| ゲスト JavaScript が `process` を読む        | `runSandbox` はタスクコードをプロトタイプ無しの `node:vm` で評価するので、そのスクリプトは `process` を受け取らない。Node.js の文書では `node:vm` はセキュリティ機構ではない。ホストの秘密は、`sanitizedEnvironment` が子プロセスへコピーしないことで外に出さない。 | 同じ証明の sandbox guest                                                    |
| 本物のプロバイダー鍵と、タスク単位のハンドル | `packages/adapters/src/credential-proxy.ts` の `startCredentialProxy` がランダムなループバックトークンを発行する。`ClaudeCodeAdapter.executeTask` は子プロセスへそのトークンだけを置き、本物の鍵はホストの `fetch` にだけ付ける。 | 同じ証明の credential proxy と Claude adapter                               |
| 偽造・別タスク・クローズ済みハンドル         | プロキシは `Authorization` / `x-api-key` をそのタスクのトークンと比較し、`close()` までしか待たない。                                                                                                                             | 同じ証明の forged, other-task, and closed handles                           |
| リレーのエラー本文がパスやトークンを漏らす   | `packages/relay/src/fetch.ts` の `sanitizeRelayErrorCode` と `mapRelayError` は、許可リストのプロトコルコードだけを返す。`startLocalRelay` は Node HTTP の catch と WebSocket の `message` catch に同じフィルタを使う。それ以外の例外は HTTP 500 `RELAY_INTERNAL_ERROR`。壊れた JSON と不正な URL は HTTP 400 `INVALID_REQUEST`。 | `conformance/p2-10-relay-error-sanitization.test.ts` |

### 証明 2 — コマンド注入とパストラバーサル

タスク入力やアダプタ引数に `$(touch …)`、`` `id` ``、`; rm -rf /`、`| cat /etc/passwd`、`../../etc/passwd`、`__proto__` を入れる攻撃です。

| 脅威                         | 制御                                                                                                                                                                                                      | テスト                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| argv のシェルメタ文字        | `runCommand` は `shell: true` なしで `spawn` する。配列形式のコマンドが子プロセス実行器である。`resolveCommand` は相対パスを `COMMAND_MUST_BE_ABSOLUTE_OR_ON_PATH` で拒否し、未知の名前も拒否する。       | `Proof 2: command injection and path traversal` の `runCommand` と `resolveCommand` |
| タスク入力をシェルへ継ぎ足す | `CommandAgentAdapter` は入力を `workspaceDir/input.json` と子プロセスの標準入力へ書く。`argv` へは連結しない。文字列の `command` はオーナーが書いた `/bin/sh -c` であり、入力はやはり標準入力だけに届く。 | 同じ証明の adapter argv と workspace listing                                        |
| スキーマとプロトタイプ汚染   | `packages/core/src/schema.ts` の `validateOutput` と、`parseJsonDeliverable` が使う `JSON.parse`。                                                                                                        | 同じ証明の schema と `__proto__`                                                    |

LLM の CLI アダプタ（`claude`、`codex`、`openai`）も、遠隔のピアから信頼できない入力を受け取ります。`packages/adapters/src/command.ts` の `ClaudeCodeAdapter` / `ClaudeCodeCliAdapter` は、既定で `--tools Read,Glob,Grep`、`--disallowedTools Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch`、`--permission-mode dontAsk` を渡し、シェル実行、ファイル書き込み、Web ツールを無効にします。`CodexCliAdapter` は既定で `--sandbox read-only` を渡します。`extraArgs` または明示的なアダプタオプションは、そのフラグを1つだけ置き換え、同じフラグを重ねて出しません。運用者は、これらのアダプタを OCI コンテナの中で動かす（`--isolation oci`）か、信頼できる依頼者 DID にタスクを制限する（`--allow-requester <did>`）かしなければなりません。既定値、緩和、モック実行ファイルが実際に受け取る引数は `conformance/p1-3-adapter-tool-restrictions.test.ts` が固定します（`pnpm test`）。

### 証明 3 — セッション間の漏えいと隔離レベルの格下げ

並行する主体が互いの受信箱を読んだり、終わったタスクの状態が残ったり、実行は子プロセスなのに `oci_container` や `container` だと主張したりする攻撃です。`CVE-2026-109619` と `CVE-2026-115419` に対応づけています。

| 脅威                                   | 制御                                                                                                                                                                                                                                                                           | テスト                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 別の鍵による受信箱のポーリング         | `packages/relay/src/fetch.ts` の `InMemoryRelay.authenticate` / `openInbox` は、`packages/core/src/relay-auth.ts` の受信者署名 `RelayAuth` を要求する。                                                                                                                        | `Proof 3: cross-session state bleed and isolation downgrade` の concurrent inboxes |
| 別リレーのオリジンへの `RelayAuth` 再生 | `normalizeRelayOrigin` は `ws:` を `http:`、`wss:` を `https:` に写す。`HttpRelayClient`、`SseRelayClient`、`WebSocketRelayClient` はそのオリジンをトークンへ署名する。`createRelayFetchHandler` とローカル WebSocket サーバはそれを要求する。別オリジンは HTTP 401 `RELAY_AUTH_ORIGIN_MISMATCH`。`origin` が無いトークンは、`allowUnboundRelayAuth: true` でない限り HTTP 401 `RELAY_AUTH_ORIGIN_REQUIRED`。 | `conformance/p2-9-relay-auth-origin.test.ts` |
| `?auth=` のベアラトークン               | `extractRelayAuthToken` は、リレーが `allowQueryAuth: true` でない限り `auth` クエリを HTTP 401 `RELAY_QUERY_AUTH_DISABLED` で拒否する。`Authorization: Bearer` と `x-acp-relay-auth` は受け付ける。 | `conformance/p2-9-relay-auth-origin.test.ts` |
| 古いキューとエンベロープの再生         | `receive` は一度だけ取り出す。`send` は同じ `envelopeId` を `REPLAYED_ENVELOPE` で拒否する。                                                                                                                                                                                   | 同じ証明の stale queue                                                             |
| タスクコードが隔離レベルを自分で名乗る | `packages/sandbox/src/container.ts` と `packages/adapters/src/sandbox.ts` の `runContainerOrSubprocessSandbox` / `SandboxAgentAdapter` は、実行経路から `effectiveIsolationLevel` を決める。`runtime: null` は `subprocess_restricted` に落ち、その文字列を報告する。          | 同じ証明の runner label                                                            |
| 契約より低い隔離の証明                 | `packages/runtime/src/verifier.ts` の `VerificationEngine.verify` は、`oci_container` 契約の署名付き証明が `oci_container` でなければ拒否する。例外は `sandboxPolicy.allowSubprocessFallback: true`（`ISOLATION_LEVEL_MISMATCH`）。署名の1バイト改ざんでは主張を上げられない。 | 同じ証明の verifier                                                                |

依頼側が信頼するのは、ホストが報告したレベルに対するワーカーの署名です。信頼できないタスク出力そのものはレベルではありません。`packages/runtime/src/session.ts` は `reportIsolation` を署名付き証明へコピーします。サンドボックス実行器が渡した `sandboxBoundary` も、そのとき一緒に入ります。

### 子プロセスの境界と OCI

`subprocess_restricted` は別の OS プロセスです。環境変数は許可リストだけ（資格情報や `NODE_OPTIONS` は渡さない）、作業ディレクトリは一時スクラッチで、時間切れのあと SIGTERM と SIGKILL、出力にはバイト上限があります。`detectNodePermissionFlag` は Node.js 22.13 以上と Node.js 23 以降では `--permission` を、それより前の Node.js 20 / 22 では `--experimental-permission` を選びます。`resolveNodePermissionArgs` はそのフラグと、スクラッチディレクトリだけを対象にした `--allow-fs-read` と `--allow-fs-write` を組にします。どちらのフラグも無いバイナリでは `--allow-fs-*` を付けず、`sandboxBoundary.permissionModelActive` は偽です。この権限モデルはファイルシステム、子プロセス、ワーカースレッド、ネイティブアドオンを制限します。`fetch`、`node:net`、`node:http`、`node:https`、`node:dns`、`node:dgram` は止めません。カーネルのネットワーク名前空間でもありません。

タスクコードは同じプロセスの `node:vm` で評価します。Node.js の文書は、`node:vm` は信頼できないコードに対するセキュリティ機構ではないと述べています。プロトタイプ無しのコンテキストから `process` や `require` を外すこと、ラッパーで `globalThis.fetch` と `WebSocket` を消すことは、ゲストから見える API を狭めるだけです。

信頼できない第三者コードの実行には `oci_container` が必要です。呼び出し側は `isolationLevel: 'oci_container'` を指定します（適合テストのヘルパーはこれを `requireOci: true` と呼びます）。その経路は Podman または Docker で `--network none`、`--read-only`、`--cap-drop ALL`、`--security-opt no-new-privileges`、PID とメモリの上限を付けます。`ExecutionAttestation.effectiveIsolationLevel` は実際に走った経路です。契約が `oci_container` を要求し、`allowSubprocessFallback` が真でないとき、`VerificationEngine` はそれより低い証明を拒否します。`sandboxBoundary.kernelNetworkIsolated` が真になるのは `oci_container` だけです。その経路では Node の権限フラグではなくコンテナ実行器が境界なので、`permissionModelActive` は偽です。フラグ選択とこの記述は `conformance/p2-13-sandbox-boundary-accuracy.test.ts` が固定します。

### 証明 4 — リソース枯渇と SSRF

256 KiB を超えるリレー本体、キューの洪水、ノンス再生、インスタンスメタデータ・ループバック・`file:` を狙ったリレー URL です。`CVE-2026-109618` の枯渇側に対応づけています。

| 脅威                                                                            | 制御                                                                                                                                                                                                                                                                                                                                               | テスト                                              |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 256 KiB 超、受信箱上限（既定256件）超過、受信者数の上限                         | `packages/relay/src/fetch.ts` の `InMemoryRelay.send` は、JSON バイト長が `maxEnvelopeBytes`（既定 `262144`）を超える、受信者キューが `maxQueueSize`（既定 `256`）に達する、`maxQueues` を使い切ると `RELAY_CAPACITY` で拒否する。受信箱のバイト予算（`maxQueueBytesPerRecipient`、既定 4 MiB）を超えると `QUEUE_BYTES_EXCEEDED`（HTTP 429）で拒否する。 | `Proof 4: resource exhaustion and SSRF` の capacity |
| 保持窓の内側でのノンス再生                                                      | `authenticate` は `recipientDid:nonce` を保存し、二度目を拒否する。`maxAuthSeenEntries` が FIFO 窓を上限にし、集合は際限なく増えない。窓の中にあるノンスは拒否されたままになる。                                                                                                                                                                   | 同じ証明の nonce replay                             |
| `http://169.254.169.254`、厳格モードの `http://127.0.0.1`、`file:///etc/passwd` | `packages/core/src/discovery.ts` の `validateRelayEndpointUrl` と `parseAndVerifyInviteToken`。リンクローカル、メタデータ、未指定アドレスは常に `SSRF_BLOCKED_RELAY_URL`。ループバックとその他のプライベート範囲は既定で、および `allowPrivateRelay: false` のとき拒否。`file:` は許可プロトコルではない。`packages/runtime/src/session.ts` の `RequesterClient.delegate` は接続前に同じ検査をし、Node クライアントは検証済みアドレスへソケットを固定する。 | 同じ証明の SSRF                                     |
| プロバイダー URL `file:///etc/passwd`                                           | `startCredentialProxy` は HTTP(S) 以外のベース URL を `INVALID_PROVIDER_URL` で拒否する。                                                                                                                                                                                                                                                          | 同じ証明の provider URL                             |

公開の `http:` と `ws:` のリレー端点は、いまも許可されています。`conformance/security-hardening.test.ts` の `accepts public http: endpoints` がその方針を固定しています。この証明は、平文の公開 HTTP を拒否するとは主張しません。

`packages/runtime/src/mcp-server.ts` の `AcpMcpServer` は、Claude Desktop や Cursor などの MCP ホストにも同じ外向きの境界を適用します。`acp_delegate_task` と `acp_delegate_multi` は招待トークンをローカルで検証します。接続する前に、`allowedWorkerDids` に無いワーカー DID を `MCP_WORKER_NOT_ALLOWED` で拒否し、`allowedRelayUrls` に無いリレー URL を `MCP_RELAY_NOT_ALLOWED` で拒否します。素のワーカー DID は一覧と一致する必要があります。招待は `agentDid` または `ownerDid` のどちらかが一覧にあれば一致します。設定済みリレー、ツール引数、招待トークン内のリレー URL は、末尾スラッシュを除いたオリジンとパスへ正規化します。設定したリレーは、`allowAnyRelay` があるか、新しい URL が許可リストに入っているとき以外は置き換わりません。`approvalWebhookUrl` は `{ taskId, summaryHash, reason, approverDid }` を POST し、ウェブフックが `{ approved: true }` を返したときだけ所有者の決定に署名します。`{ approved: false }` と 2xx 以外は、タスク入力を送る前に `APPROVAL_REJECTED` になります。ツールの説明には、入力が外部へ送信されることが書かれています。`acp_discover_workers` はディレクトリを読む前に、同じリレー許可リストと `validateRelayEndpointUrl` を使い、タスク入力は送りません。これらの検査は `conformance/p1-7-mcp-outbound-policy.test.ts` が固定します（`pnpm test`）。

### 証明 5 — エンベロープと成果物の改ざん

署名済み `TaskContract` の予算やスコープ、成果物ハッシュ / `UsageReceipt`、`RelayAuth` の時刻や署名を、1バイトまたは1フィールドだけ書き換える攻撃です。正規化は RFC 8785 JCS、署名アルゴリズムは Ed25519 です（`packages/core/src/crypto.ts`）。

| 脅威                                            | 制御                                                                                                                                                                                                        | テスト                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 署名後の予算またはスコープの改変                | `packages/core/src/contract.ts` の `verifyContract` は `digest(manifest) === digest(proposal.payload)` と、JCS ペイロードに対する有効な Ed25519 署名を要求する。                                            | `Proof 5: cryptographic envelope and artifact tampering` の contract |
| 成果物バイトまたは `digest`、利用レシートの改変 | `VerificationEngine.verify` は成果物・実行証明・利用レシートの `verifySigned` と、`digest(data) === artifact.payload.digest` を要求する。このスイートが検査するタスクレシートは、その署名付き成果物である。 | 同じ証明の artifact and usage                                        |
| 古い、または1バイト改ざんした `RelayAuth`       | `verifyRelayAuthToken` は、ずれが5分を超える時刻と、検証に通らない署名バイトを拒否する。                                                                                                                    | 同じ証明の RelayAuth                                                 |

改ざん前の契約、配送、新しいトークンは、先に受理されることを確認します。何でも拒否する検証器は、この対照で失敗します。

### 証明 9 — ペイロードのエンドツーエンド暗号化（ゼロ知識のブラインドリレー）

好奇心のある、または侵害されたリレー運用者が、キューや保存スナップショットからタスク入力、`CapabilityToken`、タスク結果を読む攻撃です。第三者が暗号文をコピーする、または別の `taskId` や `seq` へ載せ替えて復号しようとする場合も含みます。

| 脅威                                          | 制御                                                                                                                                                                                                                                                         | テスト                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| リレーが保存したセッションペイロードを読む    | `packages/runtime/src/session-audit.ts` の `SessionWire` は、すべてのペイロードを相手の `did:key` へ暗号化する。`packages/core/src/crypto.ts` の `encryptEnvelopePayload` は、封筒ごとに新しい X25519 鍵、HKDF-SHA256、AES-256-GCM を使う。HKDF の info は、正規化したヘッダに加え、一時 X25519 公開鍵と受信者 X25519 公開鍵を束縛する。 | `Proof 9: end-to-end payload encryption` の hides task input, capability tokens, and results from the relay |
| 第三者が傍受した封筒を復号する                | X25519 スカラーを導出できるのは受信者のシードだけである。`decryptEnvelopePayload` は `ENVELOPE_DECRYPTION_FAILED` を投げる。                                                                                                                                 | 同じ証明の rejects a third party and a ciphertext moved to another header                                   |
| 暗号文を別の `taskId` または `seq` に移植する | AES-GCM の追加認証データは、正規化したヘッダ（`taskId`、`seq`、`eventType`、`senderDid`、`recipientDid`）である。HKDF の info は、そのヘッダに加え、一時 X25519 公開鍵と受信者 X25519 公開鍵を束縛する。HKDF の salt は 12 バイトの AES-GCM nonce である。 | 同じ証明の transplanted header、および `P2-11 HKDF info binds both X25519 public keys` |
| 平文のセッション封筒が E2EE なしで受理される  | `decryptEnvelopePayload` は `requireEncrypted` の既定を true とし、`UNENCRYPTED_ENVELOPE_REJECTED` を投げる。`WorkerNode`、`RequesterClient`、`VerificationEngine` もその既定を使う。`{ requireEncrypted: false }` または `allowUnencryptedEnvelopes: true` は、レガシー向けの明示的なオプトアウトである。 | 同じ証明の legacy cleartext envelope、および `P1-8 require encrypted envelopes`                            |

外側の Ed25519 署名は暗号文を覆う。リレーは復号鍵なしで封筒の形を検査できる。`decryptEnvelopePayload`、`WorkerNode`、`RequesterClient`、`VerificationEngine` は、既定で暗号化された封筒を要求し（`requireEncrypted: true`）、平文のセッション封筒を `UNENCRYPTED_ENVELOPE_REJECTED` で拒否する。呼び出し側が `{ requireEncrypted: false }` または `allowUnencryptedEnvelopes: true` を明示したときだけ、レガシーのメモリ内フィクスチャとして平文を開ける。経路のメタデータは見えたままである。

HKDF-SHA256 の salt は 12 バイトの AES-GCM nonce である。info は、正規化した封筒ヘッダに、一時 X25519 公開鍵と受信者 X25519 公開鍵を加えたものである。どちらの公開鍵も、生の 32 バイトを base64url にした値である。AES-GCM の追加認証データは、正規化したヘッダのままである。ヘッダだけの info で導出した AES 鍵、または一時公開鍵や受信者公開鍵を差し替えた暗号文は、`decryptEnvelopePayload` が `ENVELOPE_DECRYPTION_FAILED` で拒否する（`conformance/p2-11-hkdf-key-binding.test.ts`）。

## 証明 10 — トークン失効と実行中の取り消し

脅威: 発行者が失効させたあとに、盗まれた招待や能力が提示される。第三者が `RevocationNotice` を偽造する。依頼者が、監査ログに署名のない穴を残さず、実行中のサンドボックスを止める。

| 脅威クラス | アーキテクチャ上の制御 | 敵対テスト |
| --- | --- | --- |
| 失効した招待が `PROPOSE` で提示される | `WorkerNode` は `ACCEPT` の前に、招待 URI とその JCS ダイジェストへ `RevocationRegistry.assertNotRevoked` を呼ぶ。 | `Proof 10: token revocation and live cancellation` の revoked invites |
| 失効した能力がツールに提示される | `CapabilityGuard.authorize` は、`MCPProxy` がバックエンドを呼ぶ前に `TOKEN_REVOKED` を投げる。 | 同じ証明の revoked capabilities |
| 発行者以外が署名した `RevocationNotice` | `verifyRevocationNotice` は Ed25519 の署名者が `issuerDid` であることを要求する。`revoke(notice, expectedIssuer)` は不一致を `INVALID_REVOCATION` で拒否する。 | 同じ証明の forged notice |
| オフラインのワーカーが `PROPOSE` より前の `REVOKE` を取りこぼす | `deliverRevocation` は暗号化された `SignedRevocationNotice` を並べる。`WorkerNode` は `runOnce`、`start`、`pumpUntil` で、次の `PROPOSE` の前に先頭の `REVOKE` を取り込む。失効した招待または能力は `ACCEPT` の前に `TOKEN_REVOKED` になる。 | `conformance/offline-revocation-inbox.test.ts` の offline worker |
| 第三者が他人のトークンを `REVOKE` する | 送信者は `issuerDid` でなければならない。招待の通知はワーカー所有者からのものだけを保存する。能力の通知は、その発行者がトークンを発行または委任したときだけ適用する。それ以外は無視し、保存しない。 | 同じファイルの spoofed revocation |
| 依頼者が実行中のサンドボックスを中断する | `CANCEL` は署名、暗号化、相互署名される。ワーカーはタスクを中断し、子プロセスへ `SIGTERM` のあと `SIGKILL` を送る。封印されたログは `CANCEL` を含み `VALID` になる。 | 同じ証明の cancels a running sandbox |

## 証明 11 — 暗号化された進捗とビザンチン・クォーラム

脅威: リレーが `PROGRESS` を読む。侵害されたワーカーが、検証は通るが汚染された成果物を返し、それを結果にしようとする。

| 脅威クラス | アーキテクチャ上の制御 | 敵対テスト |
| --- | --- | --- |
| リレーが進捗フレームを読む | `PROGRESS` は `SessionWire` のペイロード暗号を使う。イベント種別は見える。本文は直列化した封筒に現れない。 | `Proof 11: encrypted progress and Byzantine quorum` の keeps PROGRESS plaintext off the relay |
| 1 人のワーカーが別の検証済み出力を返す | `delegateMulti({ mode: 'quorum' })` は RFC 8785 JCS の SHA-256 で出力をまとめる。一致した正直なダイジェストが勝つ。少数派を含む検証済み受領は残る。 | 同じ証明の outvotes a poisoned worker |

## 監査ログの末尾切断

脅威: 運用者が `sealbridge audit-verify` の `VALID` を、そのファイルが最新のログである証拠だと受け取る。より古いが内部整合した双方監査束（自分のチェックポイントを持つ接頭辞）も同じように検証を通る。ハッシュ鎖だけでは最新の head を特定できない。

| 脅威クラス | アーキテクチャ上の制御 | テスト |
| --- | --- | --- |
| 末尾切断を最新ログと取り違える | `packages/ledger/src/index.ts` の `verifyAudit` は、`expectedLastEntryHash`、`expectedEntryCount`、`expectedFinalState`、`head`、`taskId` / `actors`、または `trustAnchor` が渡されて一致しない限り、`statusLabel` を `VALID (no trust anchor: truncation not checked)` にし、`trustAnchorVerified` と `truncationChecked` を false にする。`sealbridge audit-verify` は位置引数のトラストアンカーに加え、`--expect-final-state`、`--expect-last-hash`、`--expect-entry-count` を受ける。`acp_verify_audit_bundle` も同じフィールドを受ける。一致しない接頭辞は `INVALID` になる。 | `conformance/p2-12-audit-verify-trust-anchor-notice.test.ts`（`pnpm test`） |

この確認は `pnpm test` に含まれる。`pnpm test:security-proof` には含まれない。

ビルド済みのチェックアウト（Node.js 22 以降、pnpm 10）で、リポジトリ直下から次を実行してください。

```sh
pnpm test:security-proof
```

`conformance/security-proofs.test.ts` のすべてのテストが通ることを確認します。
