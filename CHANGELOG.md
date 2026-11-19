# Changelog

Notable changes to Sealbridge are documented here, following Keep a Changelog conventions.

## [Unreleased]

## [0.9.2] - 2026-11-19

Contributor onboarding and GitHub issue/PR templates are in the repository (#302). Node 22 remains the minimum, with workspace engines, CI and publish builds aligned to Node 22 and 24 (#303). Type-aware Promise lint rules are required in CI (#304). Sandbox tasks wait for IPC results before treating a child as finished, and concurrent outbox cleanup no longer reports a disappeared record as store corruption (#305). The repository is formatted with Prettier, and `format:check` is required in the lint job (#306). No breaking changes; engines stay Node >=22, and protocol 0.2.0 is unchanged.

貢献者向けの案内と GitHub の issue/PR ひな型を追加しました（#302）。必要な Node はこれまでどおり 22 以上で、ワークスペースの engines・CI・公開ビルドを Node 22 と 24 に揃えました（#303）。Promise の型付き lint ルールを CI の必須チェックにしました（#304）。サンドボックスは子プロセス終了の前に IPC の結果を受け取り、並行する outbox の掃除で消えたレコードをストア破損として扱わないようにしました（#305）。リポジトリ全体を Prettier で整え、lint ジョブで `format:check` を必須にしました（#306）。破壊的変更はなく、engines は Node >=22、プロトコル 0.2.0 は維持します。

### Added

- Bilingual CONTRIBUTING guides, bug and feature issue forms, a PR checklist, and repository-wide CODEOWNERS. Prefer GitHub private vulnerability reporting when available; security@sealbridge.dev remains an alternative. (#302)
- 英日の CONTRIBUTING、バグ・機能の issue フォーム、PR チェックリスト、リポジトリ全体の CODEOWNERS を追加しました。可能なときは GitHub の非公開脆弱性報告を使い、security@sealbridge.dev は代替の連絡先として残します。(#302)

### Fixed

- Align all workspace package engines to `>=22`, test Node 22 and 24 on Ubuntu, macOS and Windows, and build published packages on Node 22. Installers still pin Node 22.22.0 when they install Node, and reuse an existing Node 22+. (#303)
- ワークスペースの engines をすべて `>=22` に揃え、Ubuntu・macOS・Windows で Node 22 と 24 を試験し、公開パッケージのビルドを Node 22 で行うようにしました。インストーラーが Node を入れるときは引き続き 22.22.0 を固定し、既にある Node 22 以上はそのまま使います。(#303)

- Drain sandbox IPC results before handling child close, so a completed echo task is not rejected as `EXECUTION_FAILED`. Treat an outbox record that disappears during an unlocked read as completed cleanup instead of `OUTBOX_STORE_INVALID`. (#305)
- サンドボックスは子プロセスの close を扱う前に IPC の結果を受け取り、完了した echo タスクが `EXECUTION_FAILED` で拒否されないようにしました。ロックなしの読み取り中に消えた outbox レコードは、ストア破損 `OUTBOX_STORE_INVALID` ではなく掃除完了として扱います。(#305)

### Changed

- Require type-aware `@typescript-eslint/no-floating-promises` and `no-misused-promises` in the lint CI job. (#304)
- 型付きの `@typescript-eslint/no-floating-promises` と `no-misused-promises` を lint CI ジョブの必須ルールにしました。(#304)

- Format the repository with Prettier and require `pnpm format:check` in the existing lint job. (#306)
- リポジトリ全体を Prettier で整形し、既存の lint ジョブで `pnpm format:check` を必須にしました。(#306)

## [0.9.1] - 2026-11-18

Shared invitations now support atomic maximum-user limits through CLI `--max-uses`, MCP and the SDK (#297), with shared-limit guards and 1–1000 validation (#298). **Behavior change:** default unmigrated MCP invite creation now fails with `INVITE_REQUESTER_LISTENER_REQUIRED` (isError, no token or shared-limit record); #300 supersedes #299's warning-and-minting behavior. Explicit `options.owner`, `mcp-server --key` / `explicitKeyPath`, and migrated delegated identities still mint. After multiple owners bind a shared invitation, 0.9.0 and earlier cannot read that connection store; back up before upgrading or using shared invites and restore that backup to downgrade. Ubuntu conformance uses the ubuntu-24.04 runner while retaining the required check name `conformance (ubuntu-latest)` (#300).

共用招待に CLI `--max-uses`・MCP・SDK から原子的な最大利用人数を設定できるようになりました（#297）。共用上限のガードと1～1000の検証を追加しました（#298）。**動作変更:** 未移行の既定 MCP 招待作成は `INVITE_REQUESTER_LISTENER_REQUIRED` で失敗し、isError を返してトークンも共用上限レコードも作成しません。#299 の警告付き発行は #300 の拒否に置き換わりました。明示した `options.owner`・`mcp-server --key` / `explicitKeyPath`・移行済みの委任 ID では引き続き発行できます。同じ共用招待に複数の所有者が結び付いたストアは 0.9.0 以前では読めません。アップグレードや共用招待の利用前にバックアップし、ダウングレード時はそれを復元してください。Ubuntu の conformance 実行環境は ubuntu-24.04 に固定し、必須チェック名 `conformance (ubuntu-latest)` は維持します（#300）。

### Added

- Shared invitation codes with issuer-signed persistent maximum-user limits: `invite create --max-uses N`, MCP `acp_create_invite.maxUses`, and `WorkerSession.invite(3600, { maxUses: N })`. Distinct-owner redemption is atomic; exhausted shared invites return `INVITE_USES_EXHAUSTED`. Default single-owner invitations, token format and protocol 0.2.0 are unchanged.
- 発行側の署名付き永続メタデータで最大使用人数を制限する共用招待コードを追加しました。CLI `invite create --max-uses N`、MCP `acp_create_invite.maxUses`、`WorkerSession.invite(3600, { maxUses: N })` に対応します。異なる所有者の利用を原子的に記録し、使い切りは `INVITE_USES_EXHAUSTED` を返します。既定の1人向け招待・トークン形・プロトコル 0.2.0 は維持します。

### Fixed

- Reject shared `--share link` invitations before issuance or relay access: short `/j` links remain single-claim; use a token or long `/i` link. CLI, MCP and session maximum-user limits now share the 1–1000 validation rule. CLI `--max-uses` accepts decimal integer strings only; exponent, hexadecimal, whitespace and empty values are rejected. Disconnecting or blocking does not free a place.
- 共用招待と `--share link` の併用を発行・リレー接続前に拒否します。短い `/j` は1回限りのため、トークンか長い `/i` を使ってください。CLI・MCP・session の最大使用人数を共通の1〜1000の整数に制限します。CLI の `--max-uses` は十進整数文字列だけを受け付け、指数表記・十六進表記・空白付き・空の値は拒否します。切断・ブロックでは枠は空きません。

### Changed

- Default unmigrated MCP normal/shared invite creation now fails with `INVITE_REQUESTER_LISTENER_REQUIRED` before minting a token or recording shared limits, instead of minting with a warning. The error includes receiving DIDs and guidance for explicit `options.owner` / `mcp-server --key <file>`, requester listeners, worker-key invites or migrated gateways. Explicit owner/key and migrated identities still mint; signing identity, shared limits and protocol versions are unchanged.
- 未移行の既定 MCP 通常・共用招待は、警告付き発行から `INVITE_REQUESTER_LISTENER_REQUIRED` による拒否へ変更しました。トークン発行・共用上限の記録前に停止し、受信先 DID と `options.owner` / `mcp-server --key <file>` の明示設定・requester 待受・worker 鍵の招待・移行済みゲートウェイの案内を返します。所有者・鍵の明示指定と移行済み ID は引き続き発行でき、署名 ID・共用上限・プロトコル版は維持します。

- Downgrade warning: after two or more owners bind the same shared invitation, 0.9.0 and earlier cannot read that connection store, even when running alone. They require one binding per invite digest: `connections list` fails with `INTAKE_STORE_INVALID`, and old workers may time out tasks or exit. Back up the data directory before upgrading or starting to use shared invitations. To downgrade, restore that backup. Merely avoiding simultaneous old/new processes is insufficient. The existing #297 store format is retained to preserve signed bindings; neither the AgentInvite token nor protocol 0.2.0 changes.
- ダウングレードの注意: 同じ共用招待に2人以上の所有者が結び付いた接続ストアは、0.9.0 以前では単独起動でも読み取れません。旧版は招待ダイジェストごとに結び付きを1件に制限するため、`connections list` は `INTAKE_STORE_INVALID` となり、旧ワーカーのタスクがタイムアウトしたり、ワーカーが終了したりします。アップグレード前、または共用招待を使い始める前に、データディレクトリをバックアップしてください。ダウングレードするときは、そのバックアップを戻してください。古いバイナリと新しい書き込みの同時実行を避けるだけでは不十分です。署名付きの結び付きを失わないよう #297 の保存形式を維持し、AgentInvite トークンとプロトコル 0.2.0 は変更しません。

## [0.9.0] - 2026-11-16

Role-neutral invitations and named bilateral connections now work across CLI/MCP, with owner gateways, delegated workers, explicit migration and importer acceptance controls. Concurrent outbox access and Muse ↔ Grok Bot end-to-end coverage improve reliability.

Invitation records retain the older signed format, so older releases can still read them after downgrade; explicit alias intent lives in a separate signed sidecar that older readers do not use. This does not make the new connection/owner-delegate features available in older releases. Previously saved unmarked aliases need re-acceptance with `--alias` before first connect. In accept JSON, `aliasExplicit: false` means explicit alias intent could not be saved; test for the value `true`, not key presence.

役割に縛られない招待と名前による双方向の接続を CLI/MCP に追加し、持ち主ゲートウェイ・代理ワーカーへの明示的な移行と取り込み側の受け入れ設定に対応しました。同じ ID の outbox 同時アクセスと Muse ↔ Grok Bot の e2e 検証で信頼性を改善しました。

招待の署名付きレコードは旧形式を維持するため、古い版に戻しても読み取れます。ただし、明示した別名の意図は別の署名付き sidecar に保存され、古い版はこれを使いません。新しい接続・持ち主／代理の機能まで古い版で使えるわけではありません。印のない保存済み別名は、初回接続前に `--alias` 付きで再取り込みしてください。accept JSON の `aliasExplicit: false` は、明示した別名の意図を保存できなかった意味です。キーの有無ではなく値が `true` かを確認してください。

- Keep the outbox Windows sharing-violation test's real files under its native OS temporary directory and existing teardown; simulate only the Windows I/O policy. CI now checks for tracked changes and untracked files immediately after the full conformance suite. No product behavior changes.

### Invite and role series

- Windows installer tests resolve the first shell executable directly instead of waiting for an exhaustive `where.exe` PATH scan, which timed out in CI after already printing a valid match. Regression tests ensure later PATH entries are never probed after a match; required missing shells still fail explicitly.

- Fix a CI-observed quorum fixture timing assumption: successful minority completion gets 5 seconds rather than 100ms for final verification and checkpoint signing/persistence. A 200ms final-verification regression still requires all three verified receipts; deliberately missing/invalid checkpoints retain their short negative-test budget.

- Avoid premature alias-metadata warnings when accept repairs owner-held mode bits; report the nearest existing directory for every write failure, including OS error paths naming missing directories or lock files and the parent of an existing file, with bilingual write-access guidance. Document `aliasExplicit: false` and preserve old signed records and saved buddy names. Add elapsed-time and fixture diagnostics for slow exchange/proxy tests; only those two files use a 60-second test budget, while the suite default remains 20 seconds, without skips or retries.
- accept が所有者の印ファイルの権限を修復できた場合は警告しません。書き込み失敗は、OS エラーのパスも含め、最も近い既存フォルダと修復方法を日英で案内します。存在しないフォルダやロックファイルなら既存の親までさかのぼり、存在するファイルなら親フォルダを表示します。`aliasExplicit: false` の意味を明記し、旧形式と buddy の保存名を維持します。時間切れの診断を追加し、接続交換・プロキシの2ファイルだけ上限を60秒にし、全体の既定は20秒を維持します。skip や retry は追加しません。

- Report `aliasExplicit: false` when explicit invitation alias intent cannot be saved, with the existing English/Japanese warning; repair owner-held sidecar permissions to 0600 during writes when possible. Limit blocked read-time legacy migration to one attempt per store instance; explicit writes can retry. Translate permission and read-only invitation writes into `INVITE_STORE_UNWRITABLE` with folder-specific English/Japanese recovery guidance. Preserve signed invite formats and old-reader compatibility; add child timeout stream diagnostics and allow 60 seconds for downgrade and alias end-to-end tests.
- 明示した招待別名の印を保存できなかった場合は、日英の警告と `aliasExplicit: false` を返します。読み取り時の旧形式移行はストアごとに一度だけ試し、明示的な書き込みでは再試行できます。書き込み権限がない場合は `INVITE_STORE_UNWRITABLE` と対象フォルダ・修復方法を日英で案内します。旧版との互換を維持し、子プロセスの時間切れ診断とテストの待ち時間を改善しました。

- Keep verified inline alias intent usable when read-time migration is blocked by a live lock or a read-only directory; retry migration later. Bind sidecar marks per invite so unrelated old-version writes preserve explicit aliases, and publish intent before replacing the store. Warn once in English/Japanese for unavailable sidecar metadata and repair the Japanese compatibility notes.

- Keep explicit invite-alias intent in a separate signed sidecar; migrate inline `aliasExplicit` markers so invite records stay readable by older releases. Missing/unreadable intent metadata falls back to derived names. Previously saved unmarked aliases need re-acceptance with `--alias` before first connect. CLI/MCP `connectionRecorded.alias` now includes derived connection names.

- Use only explicitly owner-supplied invitation aliases for new connection names; automatic and legacy unmarked import aliases retain display-name defaults. Add Japanese collision warnings and document explicit invitation selection on different-DID name conflicts.

- New importer connections use the saved invitation alias across CLI and MCP recording. Preserve existing names and owner renames; report different-DID alias collisions and use a derived fallback without changing identity or consent.

- Continue accepted tasks when importer-side connection recording fails; report bilingual stderr and JSON `connectionRecordWarning` (`CONNECTION_RECORD_FAILED`) with recovery guidance. Prefer local names in successful connection notices, retaining DIDs in JSON.

- **Behavior change:** explicit non-interactive CLI delegation to an invite peer now records the importer-side connection after verifying the matching peer’s signed task ACCEPT. Incoming read/write acceptance stays off until `connections allow`. Use `--no-connect` for one-off sends. TTY/MCP consent is unchanged; recording emits a bilingual notice and JSON `connectionRecorded`. Correct delegate `--invite` and worker `--name` help.

- Invitations establish connections; local owner policy controls work in either direction. Add role-neutral `peerRef` / `--peer-ref`, local connection aliases and `delegate --to`, preserving old names, MCP arguments and per-key consent without a protocol change.
- **Behavior change:** new importer-side connections no longer auto-accept by default. Owners opt in per peer with `connections allow <name>` (read-only) or `connections allow <name> write`; `disallow` restores owner approval. Creator and legacy policies remain unchanged. Connection sends include a soft approval warning; CLI scripts can suppress stderr with `--quiet-approval-warning`.
- **Behavior change:** an unknown `delegate --to` name now returns `CONNECTION_NOT_FOUND` (previously `INVITE_NOT_FOUND`), with corrected English/Japanese guidance. Add MCP `acp_delegate_task.to`; ambiguous names and different-DID conflicts fail closed, while an expired same-DID invite alias can fall back to its connected peer.
- **Behavior change:** `acp_list_connections` lists connections belonging to both existing requester and worker keys, with aliases, DIDs, local acceptance and advisory fields. Explicit owner/key selection restricts scope. Existing output fields remain available.
- Add explicit, backed-up owner/delegate migration, revocation and recovery with `worker migrate` / `worker revoke-delegate`, including `--create-owner` for worker-key-only folders. Preserve old keys/invites and legacy listeners with separate `*.legacy.jsonl` audit/inbox files. Unmigrated requester receiving remains opt-in with `--also-requester` and separate acceptance.
- Migrated workers' MCP invitations now target the owner key with a separate delegated execution identity, while legacy worker invitations keep working.
- Add real-process Muse ↔ Grok Bot MCP/CLI end-to-end coverage for both identity layouts, permission changes, target errors, expiry fallback, audit verification and clean shutdown; rewrite English/Japanese onboarding with Muse repository-link installation first.
- Keep same-folder worker and concurrent sends reliable: bounded outbox contention retries, atomic replacement reads, contained background status-drain errors and recovered audit checkpoints.
- Abort stalled status-check drains when their readers stop, so stopped readers do not leave a drain running.

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
