// SPDX-License-Identifier: Apache-2.0
const reasons: [RegExp, string][] = [
  [/ACCESS_MODE_REMOVED/, '旧モードの指定は廃止しました。connections と一般の --max-*、--allow-task-type を使ってください。'],
  [/INSPECTION_INCOMPLETE|INSPECTION_UNAVAILABLE/, 'タスク検査プロバイダーを設定した組み込みアプリで検査してください。単体 CLI はタスクを検査できず、requests show と既定の approve は検査完了まで使えません。requests list で保留情報を確認できます。接続申し込みは connections review list で確認してください。接続審査だけではタスクを検査・開封しません。所有者の確認には別途対話式 TTY が必要です。--auto-accept は検査や接続同意を代替しません。'],
  [/CONNECTION_NOT_PENDING/, 'この ID に一致する審査可能な署名付き接続申し込みはありません。通常のタスクが作るのはタスク由来の保留項目だけで、審査可能な接続申し込みではありません。同じ役割・鍵で connections review list を確認し、一覧の ID を使ってください。空なら招待・接続フロー（connections confirm-invite）で署名付き申し込みを交換してください。接続審査だけではタスクを検査・開封しません。所有者の確認には対話式 TTY が必要で、--auto-accept は検査や接続同意を代替しません。'],
  [/CONNECTION_REQUIRED/, 'この操作には選択した所有者 DID の接続が必要です。connections を確認してください。'],
  [/CONNECTION_OPENING_REQUIRED/, 'limited の依頼には検査と所有者が開く操作が必要です。alwaysAsk:true にしてください。'],
  [/PROTOCOL_VERSION_UNSUPPORTED|PROTOCOL_DOWNGRADE_REFUSED/, '相手の署名済み対応版とリリース方針を確認してください。別の版へ自動で再送しません。'],
  [/PROTOCOL_RELEASE_UNSET/, '公開リリース前に保守者がリリース時刻を設定してください。'],
  [/SETUP_HOST_REQUIRED|SETUP_HOST_UNSUPPORTED|SETUP_INVALID_ARGUMENT/, 'setup --help を確認し、対応ホストを --host で指定してください。'],
  [/SETUP_RUNTIME_UNSTABLE/, '永続的な場所にインストールするか、ビルド済みチェックアウトから実行してください。'],
  [/SETUP_APPROVAL_MODE_CONFLICT/, '既存の Sealbridge 登録は承認モードが異なります。--update-existing --dry-run で確認し、--update-existing でバックアップ付きで置換してください。従来の自動承認は --no-require-approval で選択できます。'],
  [/SETUP_ENTRY_CONFLICT/, '既存の Sealbridge 登録が異なります。--update-existing --dry-run で確認し、--update-existing でその登録だけをバックアップ付きで置換してください。'],
  [/SETUP_/, 'ホストの設定画面を閉じ、設定とバックアップを確認してから再実行してください。'],
  [/PENDING_OWNER_APPROVAL/, 'ワーカー所有者による依頼者の審査待ちです。タスクは受諾されていません。自動再試行せず、審査後に所有者が新しい依頼を開始してください。'],
  [/RELAY_AUTH_RECOVERY_EXHAUSTED/, 'システム時計が同期されていることと、鍵が登録された DID と一致することを確認してください。'],
  [/ADAPTER_PROXY_NOT_USED/, 'Codex からタスク用プロキシへの認証済みリクエストを確認できないため、成果物を返せません。プロバイダー設定とワーカーログを確認してください。'],
  [/CODEX_PROXY_/, 'Codex のプロキシ設定を確認できません。@openai/codex の 0.163.0 以降をインストールし、プロバイダー設定を変更する追加オプションを外して再実行してください。'],
  [/AGENT_AUTH_REQUIRED|AUTH|CREDENTIAL|UNAUTHORIZED|FORBIDDEN/, '認証を利用できません。ホスト側の API キー設定とログイン状態を確認して再実行してください。'],
  [/INVITE_LINK_TOKEN_REQUIRED/, '招待リンクにトークンがありません。# 以降を含む完全なリンクを相手に依頼してください。'],
  [/INVITE_EXPIRED|TOKEN_REVOKED/, '招待の期限が切れたか失効しています。相手に新しい招待を依頼してください。'],
  [/INVITE_STDIN_REQUIRES_PIPE/, '--stdin はパイプまたはファイルから入力してください。端末では --paste を使ってください。'],
  [/INVITE_INPUT_TOO_LARGE/, '標準入力は 68 KiB 以内にして、招待リンクを 1 件だけ渡してください。'],
  [/INVITE_INPUT_EMPTY|INVITE_INPUT_MULTIPLE_LINES/, '標準入力に完全な招待リンクを 1 行だけ渡してください。'],
  [/INVITE_INPUT_TIMEOUT/, '標準入力を 10 秒以内に完了し、パイプを閉じて EOF を送ってください。'],
  [/TIMEOUT|TIMED_OUT|DEADLINE/, '待機または実行の制限時間を超えました。相手の稼働状況と時間制限の設定を確認してください。'],
  [/ABORT|CANCEL/, '処理が中断されました。相手の稼働状況と中断理由を確認してから再実行してください。'],
  [/APPROVAL|HITL|VERIFICATION_REJECTED/, '所有者の承認が得られませんでした。依頼内容と承認画面を確認し、所有者が操作してください。'],
  [/BUDGET|QUOTA|LIMIT/, '設定された予算または利用上限に達しました。依頼を小さくするか、所有者と上限を確認してください。'],
  [/EXECUTION_FAILED|ADAPTER_|CLAUDE_TASK_FAILED|CODEX_/, 'AI の実行に失敗しました。CLI のインストール、認証、ワーカーのログを確認してください。'],
  [/RELAY_REQUIRED/, '接続先の中継器がありません。完全な招待リンクを使うか --relay を指定してください。'],
  [/ENOENT|EACCES|EPERM/, 'ファイルまたはコマンドを利用できません。指定したパスとアクセス権を確認してください。'],
  [/INVALID|MISSING|CONFLICTING|Missing |Unexpected |Duplicate |Unknown option/, '入力または設定が正しくありません。ファイル内容とオプションを --help で確認してください。'],
  [/RELAY|CONNECT|ECONN|FETCH|NETWORK/i, '中継器に接続できません。URL、ネットワーク、相手の稼働状況を確認してください。'],
];

const nextSteps: [RegExp, string][] = [
  [/INSPECTION_INCOMPLETE|INSPECTION_UNAVAILABLE/, 'Use an embedding app configured with a task inspection provider. The standalone CLI cannot inspect tasks; requests show and default requests approve require completed inspection. Use sealbridge requests list to check pending metadata. For signed connection offers, check sealbridge connections review list; connection review does not inspect or open tasks. Human confirmation separately requires an interactive TTY; --auto-accept does not provide inspection or connection consent.'],
  [/CONNECTION_NOT_PENDING/, 'No reviewable signed connection offer matches this ID. A plain task creates only a pending task-derived item, not a reviewable connection offer. Run sealbridge connections review list with the same role/key and use a listed ID. If the list is empty, use the invitation/connect flow (connections confirm-invite) to exchange a signed offer. Connection review does not inspect or open tasks. Human confirmation requires an interactive TTY; --auto-accept does not provide inspection or connection consent.'],
];

export function japaneseErrorReason(message: string): string | undefined {
  return reasons.find(([pattern]) => pattern.test(message))?.[1];
}
export function formatCliError(error: unknown): string {
  const pending = error as { code?: string; pendingId?: string; pendingStoreError?: string; originalTaskId?: string; nextStep?: string } | null;
  if (pending?.code === 'PENDING_OWNER_APPROVAL') return JSON.stringify({ error: pending.code, retryable: false,
    pendingId: pending.pendingId, originalTaskId: pending.originalTaskId, pendingStoreError: pending.pendingStoreError,
    nextStep: pending.nextStep ?? 'After worker owner review, explicitly submit a fresh task. Do not retry automatically.' });
  const message = String(error);
  const detail = error instanceof Error ? error.message : message;
  const nextStep = nextSteps.find(([pattern]) => pattern.test(detail))?.[1];
  const reason = japaneseErrorReason(detail);
  return message + (nextStep ? '\n' + nextStep : '') + (reason ? '\n' + reason : '');
}
