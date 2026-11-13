# Changelog

Notable changes to Sealbridge are documented here, following Keep a Changelog conventions.

## [Unreleased]

## [0.8.1] - 2026-11-14

- Preserve an in-flight leased task response when the delivery-status reader initializes or refreshes, fixing first-invite delegation sequence gaps and incomplete bilateral audits without retries or weaker replay checks.
- Restore Muse's argument-based invitation import instructions, retain Grok Bot's stdin import, and clarify that automatic synthetic DNS support requires 0.8.1 or later.
- Pin detected synthetic TLS egress to the validated 198.18/15 DNS answers instead of resolving again at connection time.
- Detect Grok Bot synthetic DNS for TLS relay connections while retaining URL guards and SSRF diagnostics in doctor.
- Refuse noninteractive delegation before sending unless automatic approval is explicit; explain `DATA_DIR_PERMISSIONS` private directory permissions and share contacts data-root selection.
- Document Grok Bot installation and stdin invitation import in English and Japanese.

## [0.8.0] - 2026-11-13

### Breaking

- **Breaking:** Existing `codex`, `claude`, and `command` configurations that automatically executed work from peers trusted through contacts or legacy grants now reject work outside the owner-configured rule with `APPROVAL_CHANNEL_UNAVAILABLE`. This change is not triggered by `--allow-requester`. Contact trust and legacy grants do not necessarily establish a connection: to continue automatic execution, explicitly enable writes with `sealbridge config auto-accept connected write` for connected peers, or `sealbridge config auto-accept anyone write` when those peers are not connected, then restart the worker. `anyone` broadens the automatic audience; retain an explicit requester allowlist when needed. (#259, #260)
- **破壊的変更:** 連絡先の信頼設定や旧 grant で許可した相手の仕事を自動実行していた `codex`・`claude`・`command` の構成は、持ち主の自動受付ルール外の仕事を今後 `APPROVAL_CHANNEL_UNAVAILABLE` で拒否します。きっかけは `--allow-requester` ではありません。連絡先や旧 grant で信頼した相手は接続済みとは限らないため、自動実行を続けるには、接続済みなら `sealbridge config auto-accept connected write`、未接続の相手には `sealbridge config auto-accept anyone write` が必要になる場合があります。持ち主が書き換え許可を明示設定し、ワーカーを再起動してください。`anyone` は受付対象を広げるため、必要に応じて依頼者の明示的な許可リストを維持してください。(#259, #260)
- Existing `openai` workers automatically accept read-only tasks from connected peers after updating, incurring charges on the owner's API key; disable this with `sealbridge config auto-accept off` and restart the worker. (#259, #260)
- 既存の `openai` ワーカーは更新後、接続済みの相手の読むだけの仕事を自動で受け、持ち主の API キーに費用が発生します。無効にするには `sealbridge config auto-accept off` を実行し、ワーカーを再起動してください。(#259, #260)

### Changed

- Muse-first English/Japanese onboarding using npm 0.8.0, with GitHub main as a fallback; prepare paired sealbridge/sealbridge-local 0.8.0 distributions.
- Muse を起点にした日英の導入案内で npm 0.8.0 を主経路にし、GitHub main を代替経路にしました。両配布物の 0.8.0 を準備します。

### Added

- Add opt-in pre-call input-size caps (default unlimited), an official-worker preset of 400 lines / 48 KiB of serialized JSON / 10 files, individual and grouped off settings, and signed audit records for refusals only. Always bound the complete HTTP model prompt against the approved input-token budget. Requester CLI/MCP use ordinary fixed bilingual text by default; monthly-limit-message trial-reviewer explicitly selects trial size wording. Keep MONTHLY_MODEL_UNSUPPORTED neutral. (#263)
- AI を呼ぶ前のサイズ上限を持ち主の明示選択で設定できます（既定は上限なし）。公式向け400行・JSON化した入力48 KiB・10ファイルのプリセット、個別／一括の off、拒否時だけの署名付き監査記録を追加しました。HTTP モデルのプロンプト全体と入力トークン予算の検証は常に維持します。依頼側 CLI／MCP は通常の固定日英文を既定とし、お試しのサイズ拒否文言は monthly-limit-message trial-reviewer で明示選択します。MONTHLY_MODEL_UNSUPPORTED は中立文を維持します。(#263)

- Add `autoAccept.limits.maxMonthlyUsd` and `config auto-accept max-monthly-usd USD|off`: worker-wide token-priced accounting including manually approved tasks, signed monthly append histories/checkpoints, fail-closed storage access and published closed cards. Interrupted/unreported calls settle using persisted tokens or the saved maximum token budget, including after crashes, without poisoning future admissions. Reset on the 1st at 00:00 UTC; running tasks finish and can overshoot. Price only gpt-6-luna ($0.10/$0.50 per million input/output tokens; official cap initially $20/month); reject unsupported models before execution without an unfinished row. Generic fixed text is the default; `monthly-limit-message trial-reviewer` explicitly selects official trial/demo/invitation guidance. Support decimal caps such as 19.99 and document signed-history recovery. (#262)
- `autoAccept.limits.maxMonthlyUsd` と `config auto-accept max-monthly-usd USD|off` を追加しました。手動承認もワーカー ID 全体で合算し、月別の署名付き追記履歴・checkpoint、保存障害時の拒否、公開を維持する受付終了カードに対応します。中断・未報告・プロセス落ちは報告済みトークンか保存した最大予算で精算し、受付を停止したままにしません。毎月1日 UTC 0時に戻り、実行中の完了分だけ超過する場合があります。料金表は gpt-6-luna だけ（100万トークンあたり入力 $0.10・出力 $0.50、公式上限は最初月 $20）で、未知モデルは未完了記録を作らず実行前に拒否します。既定は通常の固定文、公式向け demo・招待案内は `monthly-limit-message trial-reviewer` で明示選択します。19.99 などの小数上限と、履歴を消さない復旧手順にも対応します。(#262)
- Daily counters now use persistent `.lock/` directories with PID claims. Downgrading to an older file-lock client can leave the counter reporting BUSY; stop all workers sharing that counter, then remove its lock directory to recover. Temporary-file cleanup failures still release the current claim. (#261, #262)
- 日次カウンターのロックは PID ごとの claim を持つ永続 `.lock/` ディレクトリになりました。古いファイルロック方式の版に戻すと BUSY のままになる場合があります。共有する全ワーカーを止めてから、該当カウンターのロック用ディレクトリを削除して復旧します。一時ファイルの削除が失敗しても現在の claim を解放します。(#261, #262)

- Recover daily-counter lock claims only after OS-confirmed owner process death, keeping live/unverifiable/legacy locks fail closed; validate advertised daily DID limits against the public AgentCard schema and report repeated task IDs separately from unavailable state. (#261)
- 日次カウンターの残存ロックは OS で所有プロセスの不存在を確認できた場合だけ回収し、生存中・確認不能・旧形式のロックは拒否を維持します。公開 AgentCard スキーマに DID 別日次上限を追加し、同一タスク ID の再送を状態利用不能とは別に報告します。(#261)

- Add owner-configured `autoAccept.limits.maxTasksPerDayPerDid` and `config auto-accept max-tasks-per-day-per-did N|off`: persistent automatic-admission counters per requester owner DID, resetting at 00:00 UTC (09:00 Japan time), fixed bilingual exhaustion messages and fail-closed state access. Default unlimited; official workers explicitly set 3. (#261)
- 自動受付に所有者 DID ごとの日次上限 `autoAccept.limits.maxTasksPerDayPerDid` と `config auto-accept max-tasks-per-day-per-did N|off` を追加しました。件数を保存し、UTC 0時（日本時間の朝9時）にリセットします。上限時は固定の英日メッセージを返し、状態の読み書き失敗時は拒否します。既定は上限なし、公式ワーカーは明示的に3件を設定します。(#261)

- Add owner-configured automatic acceptance for every worker: invited/connected/anyone audiences, read-only by default, explicit write opt-in, signed rule provenance in per-task audit, advertised rules and requester notices. Reserve fail-closed hooks for future limits; remove the LLM-only allowlist gate. (#259, #260)
- すべてのワーカーに持ち主設定の自動受付を追加しました。招待・接続・誰でもの対象、既定の読み取り専用と明示的な書き換え許可、タスクごとの署名付きルール監査、紹介カードと依頼側の告知に対応します。今後の上限には fail closed の差込み先を用意し、LLM だけの許可リスト必須条件を廃止しました。(#259, #260)

### Fixed

- Keep proxied tunnels alive on the wire and retry initial sends; preserve sanitized failure stage/errno diagnostics. Persistent workers survive authentication recovery exhaustion and duplicate admission without closing the listener. (#269, #271, #273)
- プロキシトンネルの実通信を維持し初回送信を再試行します。失敗段階と errno を安全に表示し、常駐ワーカーは認証復旧の失敗や重複依頼のあとも待受を維持します。(#269, #271, #273)

- Recover relay authentication across sandbox suspension using the full default recovery window and uncached nonces. Continuous workers stay unavailable and reconnect after exhaustion while preserving interrupted-session audit safety. Reject and acknowledge invalid proposals without occupying execution capacity; report clock-aware authentication diagnostics and sanitized requester poll retry codes, and propagate peer TASK_INTERRUPTED immediately. (#267)
- サンドボックスの停止・再開に対し、既定の認証回復時間枠全体とキャッシュしない nonce を使用します。常駐ワーカーは回復失敗後も unavailable のまま再接続し、中断セッションの監査と再実行禁止を維持します。不正な提案は実行枠を使わず拒否して ack し、時計の差を考慮した認証診断と秘密を含まない依頼側ポーリング理由コードを表示します。相手の TASK_INTERRUPTED は直ちに伝播します。(#267)

- Honor HTTP proxy environment variables and NO_PROXY for relay HTTP, poll, SSE, WebSocket and doctor, with authenticated CONNECT, verified TLS, credential-safe diagnostics and unchanged direct SSRF pinning. Proxy-only sandboxes such as Muse no longer need `--allow-private-relay` for public relays. (#265)
- 中継器の HTTP・ポーリング・SSE・WebSocket・doctor がプロキシ環境変数と NO_PROXY に対応しました。認証付き CONNECT と TLS 検証、認証情報を含まない診断を使い、直接接続の SSRF 検証・固定は維持します。Muse などのプロキシ専用環境でも、公開中継器に `--allow-private-relay` は不要です。(#265)

- Let Docker and Smithery inherit the CLI public relay fallback instead of pinning the legacy host; preserve explicit relay overrides and guard distribution files against relay URL drift. (#235)
- Docker と Smithery が旧ホストを固定せず CLI の公開中継器フォールバックを使うよう修正しました。明示的な中継指定を維持し、配布ファイルの URL の不一致を回帰テストで検出します。

- Reject out-of-enum MCP minimumIsolationLevel as invalid params before sending, and report unsupported worker isolation with ISOLATION_LEVEL_UNSUPPORTED instead of EXECUTION_FAILED. (#234)
- MCP minimumIsolationLevel の列挙外の値を送信前に invalid params で拒否し、ワーカーの未対応の隔離を ISOLATION_LEVEL_UNSUPPORTED で報告します。(#234)

- Use the distribution CLI name in root and subcommand usage help; confirm doctor already reports the 0.7.0 publication. (#234)
- ルートとサブコマンドの Usage を配布物の CLI 名に合わせました。doctor の 0.7.0 公開済み表示も確認しました。(#234)

- Clarify terminal-only persistent local-PC consent and per-invocation `--allow-local-pc` for scripts; use local-distribution consent errors without mainline migration guidance. (#234)
- ローカルPCの保存許可には端末が必要で、非対話では毎回 `--allow-local-pc` を使うことを明記し、ローカル版の同意エラーを修正しました。(#234)

## [0.7.0] - 2026-11-11

<!-- If the publication date changes, update this date before creating the tag.
公開日が変わる場合は、タグを打つ前にこの日付を修正してください。 -->

### Breaking

- Mainline local workers (`claude`, `codex`, `command`, and host sandbox including subprocess/OCI), receive hooks and relay wake commands now require `--allow-local-pc`, without a warning-only grace period. Environment/config opt-ins are not accepted. Add the flag to existing local commands, or after npm publication install `npm i -g sealbridge-local@0.7.0` and replace `sealbridge worker start` with `sealbridge-local worker start`; keys and data are reused. The local distribution asks once with stdin/stderr TTY, or use `sealbridge-local config local-pc on`; inspect/revoke with `status`/`off`. Mainline ignores this saved permission. Owner approval, content inspection and LLM auto-accept restrictions remain; requester/MCP delegation is unchanged. The isolated runtime remains in preparation. (P6a, #227; P6b, #228)
- 本流のローカルワーカー（subprocess/OCI sandbox を含む）、receive hook、relay wake command は `--allow-local-pc` が必須です。猶予期間はなく環境変数・設定では許可できません。既存コマンドにフラグを付けるか、npm 公開後に `npm i -g sealbridge-local@0.7.0` を実行し、`sealbridge worker start` を `sealbridge-local worker start` に置換します。鍵とデータは再利用します。ローカル版は TTY 端末で初回確認、または `sealbridge-local config local-pc on` で許可し、`status`/`off` で確認・撤回できます。本流は保存許可を使いません。承認・検査・LLM 自動受付制限は維持し、依頼側と MCP 委譲は変更しません。隔離ランタイムは準備中です。(#227, #228)

### Added

- `sealbridge-local` distribution with persistent local-PC consent, shared identities/data, installer selection and paired publication preflight. Opted-in worker startup warns and records signed `LOCAL_PC_OPT_IN` audit evidence; sandbox startup explicitly defers isolation attestation to task execution. (P6a/P6b, #227, #228)
- 保存許可、共通の鍵・データ、インストーラー選択、両配布物の公開前検証を備えた `sealbridge-local` を追加しました。許可した起動時に警告と署名付き `LOCAL_PC_OPT_IN` を記録し、sandbox 隔離証明はタスク実行時に行います。(#227, #228)
- Injectable `ExecutionBackend` and behavior-preserving `HostBackend`; separate `packages/runtime-local` for local adapters, credential storage and hooks, preserving legacy imports and `sealbridge/sdk`. (P4/P5, #225, #226)
- 差し替え可能な `ExecutionBackend` と従来動作を保つ `HostBackend`、ローカルアダプター・資格情報ストア・hook を分離する `packages/runtime-local` を追加しました。既存 import と SDK は維持します。(#225, #226)
- Desktop embedding dependencies (`signApproval` and protocol peer storage APIs/types) exported through `sealbridge/sdk`, preserving legacy build paths. (#219)
- Desktop 組み込み用の `signApproval` とプロトコル peer ストアの API・型を SDK から公開します。従来パスは維持します。(#219)

### Fixed

- Close the verifier isolation gap at every protocol level: reject delivery below contracted isolation, including wasm/microvm requirements and unknown attested levels, preserving default and explicit OCI fallback behavior. (R1, #224)
- 全プロトコル版で検証器の隔離の穴を修正し、wasm/microvm 要求や不明な証明レベルを含め契約より低い隔離の納品を拒否します。既定動作と明示的な OCI フォールバックは維持します。(R1, #224)

## [0.6.3] - 2026-11-09

### Fixed

- Report interrupted worker handshakes as `INTERRUPTED / TASK_INTERRUPTED`, with the wait phase and a Japanese interruption reason, instead of an AI execution failure. (#216, #217)

## [0.6.2] - 2026-11-09

### Changed

- Aligned the architecture diagram with AES-256-GCM, described encryption as required by default, and corrected hosted relay envelope retention to 24 hours. (#213)

### Fixed

- After `tasks approve` closes an interrupted first-contact approval, the same worker session accepts the next task. A stale outbox index left by an undelivered notification is refreshed outside the signer lock. A store that stays busy is reported as `OUTBOX_STORE_BUSY` to the owner and as a terminal error to the requester. (#210, #211)
- By default (local format 1), `tasks approve` and `tasks reject` seal an in-progress `OWNER_APPROVAL` or `ACCEPT_ACK_WAIT` prefix while the worker is still running. The record is `AuditInterruption` reason `HELD_ATTEMPT_CLOSED`. `audit-verify` then exits 2 (`UNILATERALLY_CLOSED` / `WORKER_ONLY_INTERRUPTION`). No flag or library option is required; explicit format 1 remains supported. Older audit readers must be updated. A sealed file is not extended, and the next task stays on its own sidecar. (#194, #212, #214)

## [0.6.1] - 2026-11-08

### Fixed

- `acp_verify_audit_bundle` declares `type: object` on its output schema so Glama and MCP `tools/list` accept the tool. (#208)

## [0.6.0] - 2026-11-08

### Added

- Opt-in offline content rules and a task review provider with bounded child inspection, in-memory reports, and existing owner-opening requirements. Related to the desktop context-pooling wiring design (C-W1). (#203)
- Verified task-only extraction through runtime and `sealbridge/sdk`, with envelope signature/digest checks and existing CLI display behavior. Related to the desktop context-pooling wiring design (C-W2). (#202)

### Changed

- Quarantine retention also ends at a grant expiry the caller already read, when that is earlier than the request deadline and the 24-hour cap. Held records stay version 1 and do not store the grant expiry as its own field. (C-W4) (#206)

### Fixed

- Rule content inspector child startup under Electron, related to desktop content inspection. (#204)
- Identical key-store updates that fail on `.config.lock` are retried and succeed when the requested store is already committed. Switching between file and keychain remains an exclusive write. (#205)

## [0.5.0] - 2026-11-06

### Added

- CP5a signed DelegationLink delivery attachments for one approved child edge, literal declaration narrowing, owner-reviewed SDK child dispatch, and child-attempt recovery records. Depth-one proof checks apply to contracts carrying a ContextGrant; contracts without a ContextGrant retain their existing behavior. Manifest required fields and protocol versions are unchanged. (#200)
- SI1 core and SDK short-invite link primitives for key derivation, padded token encryption, strict fragment parsing, relay storage encoding, and six-digit verification numbers; relay authentication accepts the additional `invite-manage` action. (#198)
- SI1 relay short-invite link creation, single-winner claims with 120-second same-nonce recovery, owner status/cancellation, expiry cleanup, and per-link, IP, and owner limits. CLI adds `invite create --share link`, output/QR options, `invite links list|cancel`, short-link import with `--no-network`, and verification numbers on create/accept; the default remains the offline token. A static `/j` page provides app, copy, and sharing actions without contacting the relay. Hosted endpoints require a separate operator update. (#199)
- CP1 optional ContextGrant declarations on 0.2.0 task manifests for depth-zero view-only and hand-over delivery, with consistency checks, opt-in SDK builders, and digest-only context lifecycle audit events. (#197)

### Fixed

- Added opt-in worker AuditInterruption terminals for PROPOSE-only approval waits, with separate offline verification and restart recovery; bilateral audit results remain distinct. (#196; related to #194)
- Audit parsing and verification diagnostics identify task IDs, entry sequences and hashes, and JSONL physical lines where available, including the last entry when a checkpoint is missing. (#195; related to #194)

## [0.4.2] - 2026-11-05

### Fixed

- CLI `--help` and `-h` print help without creating identities, invitations, or stores; missing required arguments are checked before local writes.
- Fixed delegation to connected peers by DID, saved invitation alias, or workerRef, retaining the observed protocol version when no directory card is available.

## [0.4.1] - 2026-11-05

### Fixed

- Added standalone CLI task display and per-task held review with separate live owner approval on fresh submissions; kept connection consent separate and listed unaccepted signed offers for already connected peers. (#178)

## [0.4.0] - 2026-11-05

### Changed

- **Breaking:** Updated `@a2a-js/sdk` to 1.3.0; the SDK-backed A2A helpers `agentCard`, `a2aTask`, `a2aMessage`, `wrapA2A`, and `unwrapA2A` now use A2A 1.0 card, message, and task output shapes, including signed A2A payloads. (#177)
- Clarified CLI errors, help, and quickstarts with next steps for embedder-only task inspection and signed connection offer review. (#178)

### Fixed

- `keygen`, `validate`, and `demo` now print usage and exit successfully for standalone `--help` or `-h`; `keygen` rejects option-like output paths before generating or writing keys. (#179)
- Aligned delegate usage/help with required flags and accepted `--invite` as an alias of `--to`, rejecting differing values. (#180)
- `sealbridge accept` recognizes `--allow-private-relay` for importing loopback/private relay invitations through positional links, `--paste`, and `--stdin`; imports remain blocked by default. (#181)

## [0.3.1] - 2026-11-04

### Changed

- Dated the 0.3.0 changelog entry. (#169)
- Updated stale documentation version notes to state availability from 0.3.0. (#171)

### Fixed

- In a fresh environment with no configuration and no keys, `doctor` warned with `APP_CONFIG_INVALID` or `IDENTITY_INVALID`; missing keys are now reported as optional. (#170)

## [0.3.0] - 2026-11-03

### Added

- A typed ESM embedding entry point, `sealbridge/sdk`, for invitation, identity and secret stores, connection review, and MCP hosting APIs. Existing deep import paths remain available. (#154)
- Persistent encrypted gateway outboxes, recipient receipts, message metadata, and default worker task checkpoints. Pending sends resume after gateway restart with the same envelope IDs until relay admission or the original deadline; recovery does not repeat owner decisions or reconstruct a task session. (#149)
- Optional persistent `idempotencyKey` support for `acp_delegate_task`, `acp_delegate_multi`, and `acp_resubmit_pending_request`. Matching calls retain their original result and IDs across restarts; changed requests return `IDEMPOTENCY_CONFLICT`. Results are retained for seven days after the original deadline. (#150)
- Recipient-signed, content-free delivery observations for validated manifest `0.2.0` tasks, including held, opened, adapter handoff, and closed states. Initially unknown peers receive only held and closed observations. Both gateways need support; handoff does not establish reading or execution. (#151)
- `acp_message_status` to read retained sender-local observations by message ID or task ID, independently of a cached send result, without sending or polling. (#152)
- `InviteStore.import(..., { pendingConfirmation: true })`, `listUnconfirmed()`, `retain()`, and `removeUnconfirmed({ olderThan })` for explicit cleanup of unconfirmed imports. Existing saves remain outside this cleanup; pending references require retention before use. (#155)
- `WorkerTrustStore.connectionStatus()` and `connections status` for local connection observations, including pending states and acknowledgement progress. (#156)
- `ConnectionAdmissionReview` and `connections review list|approve|reject` for owner review of inbound connection metadata. Explicit approval grants limited connection consent; task inspection and opening remain separate. (#157)
- Optional `peerDisplayName` in connection and prior approval metadata, derived from verified invitations and agent cards and retained after invite removal. DIDs remain authoritative; older records may omit the name. (#158)
- Local `setup` for identity, relay defaults, and MCP host registration, with preview modes and agent-readable connection instructions; `doctor --offline` for local inspection. (#119, #128)
- Saved invitation aliases with `accept`, `invites`, `acp_list_invites`, and `acp_remove_invite`, including piped invitation import through `accept --stdin`. (#122, #132)
- Pluggable identity key stores, persistent `config key-store file|keychain` selection, and optional keychain invitation storage with explicit migration. Store selection does not automatically move existing identities or invitations. (#131, #136, #137)
- Worker invitation output routing through `--invite-output`, with metadata events and file or POSIX descriptor output options. (#135)
- Persistent connection state, signed connection exchange and invite redemption, encrypted held-content review APIs, and retained requester requests with explicit resubmission. (#126, #130, #139, #140, #141, #142)
- Manifest `0.1.0`/`0.2.0` compatibility schemas, peer version observations, and live version negotiation. (#138, #142)
- Linked README demo previews and an audio-free landing page demo. (#145, #146)

### Changed

- New relay admissions default to 24-hour retention; existing stored expiries are preserved. Capacity refusals return HTTP 429 `RELAY_RETRY_LATER` with a 60-second retry hint, and local relay commands expose queue and envelope limits. Hosted behavior requires an operator relay update. (#144)
- Gateway outbox retries follow 1-minute, 5-minute, 15-minute, and 1-hour delays, then hourly, while the original deadline still applies. Persistence covers process restart after completed writes and atomic publication; power-loss persistence is not guaranteed. (#149, #150, #151)
- MCP `--require-approval` uses advertised host forms before transmission and for final verification. Setup registers this mode by default; hosts without form support return `APPROVAL_CHANNEL_UNAVAILABLE` before sending. (#118, #133)
- Commands reuse persistent role identities and default to `https://relay.sealbridge.dev`. Relay configuration can retain ordered candidates while operating one active route. (#119, #124)
- Live manifest sending prefers `0.2.0` when both peers advertise it; peers without version declarations retain `0.1.0` behavior. The protocol release instant is set to `2026-11-03T12:22:18Z`, intended as the 0.3.0 npm publish time. (#138, #142)
- Unconnected requests return terminal `PENDING_OWNER_APPROVAL` and are not retried automatically. Connections grant limited consent, with inspection and owner opening for each task; the default inspection provider is unavailable. (#126, #130, #142)
- MCP discovery lists current verified published cards with skill and task-type filters. The removed `accessMode` argument returns JSON-RPC -32602; publication alone grants no admission consent. (#120, #142)

### Fixed

- `InviteStore.remove()` deletes and verifies invitation secrets before publishing metadata removal, allowing failures to be retried with the same reference. (#155)
- Delivery-store validation discards cached records after changes, missing files, or read errors. (#159)
- Idempotency orphan cleanup refreshes both indexes under the signer lock and waits for the configured lease age. Indexes also track a shared store generation for consistent updates across writers. (#161, #160)
- Shared task journals load and publish recovery state under the signer lock, handle incomplete writes consistently, and recheck source contents before background compaction. Windows journal handles are released between operations. (#162)
- Connection offers and requests, worker cards, and CLI invitation cards use one clock snapshot for bounded lifetimes. (#153)
- Setup honors the selected key store. (#134)
- Installers fall back to a user-local Node installation with bundled npm when an existing Node lacks a usable co-installed npm. (#116)
- Relay authentication recovery after HTTP 401 uses bounded retries and reports exhaustion. (#117)
- Production site media delivery supports byte-range requests. (#147)

[0.8.0]: https://github.com/sealbridge/sealbridge/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/sealbridge/sealbridge/compare/v0.6.3...v0.7.0
[0.6.3]: https://github.com/sealbridge/sealbridge/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/sealbridge/sealbridge/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/sealbridge/sealbridge/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/sealbridge/sealbridge/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/sealbridge/sealbridge/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/sealbridge/sealbridge/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/sealbridge/sealbridge/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/sealbridge/sealbridge/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/sealbridge/sealbridge/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/sealbridge/sealbridge/compare/v0.2.2...v0.3.0
