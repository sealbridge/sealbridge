// SPDX-License-Identifier: Apache-2.0
const reasons: [RegExp, string][] = [
  [/PENDING_OWNER_APPROVAL/, 'ワーカー所有者による依頼者の審査待ちです。タスクは受諾されていません。自動再試行せず、審査後に所有者が新しい依頼を開始してください。'],
  [/RELAY_AUTH_RECOVERY_EXHAUSTED/, 'システム時計が同期されていることと、鍵が登録された DID と一致することを確認してください。'],
  [/ADAPTER_PROXY_NOT_USED/, 'Codex からタスク用プロキシへの認証済みリクエストを確認できないため、成果物を返せません。プロバイダー設定とワーカーログを確認してください。'],
  [/CODEX_PROXY_/, 'Codex のプロキシ設定を確認できません。@openai/codex の 0.163.0 以降をインストールし、プロバイダー設定を変更する追加オプションを外して再実行してください。'],
  [/AGENT_AUTH_REQUIRED|AUTH|CREDENTIAL|UNAUTHORIZED|FORBIDDEN/, '認証を利用できません。ホスト側の API キー設定とログイン状態を確認して再実行してください。'],
  [/INVITE_LINK_TOKEN_REQUIRED/, '招待リンクにトークンがありません。# 以降を含む完全なリンクを相手に依頼してください。'],
  [/INVITE_EXPIRED|TOKEN_REVOKED/, '招待の期限が切れたか失効しています。相手に新しい招待を依頼してください。'],
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

export function japaneseErrorReason(message: string): string | undefined {
  return reasons.find(([pattern]) => pattern.test(message))?.[1];
}
export function formatCliError(error: unknown): string {
  const pending = error as { code?: string; pendingId?: string; pendingStoreError?: string; originalTaskId?: string; nextStep?: string } | null;
  if (pending?.code === 'PENDING_OWNER_APPROVAL') return JSON.stringify({ error: pending.code, retryable: false,
    pendingId: pending.pendingId, originalTaskId: pending.originalTaskId, pendingStoreError: pending.pendingStoreError,
    nextStep: pending.nextStep ?? 'After worker owner review, explicitly submit a fresh task. Do not retry automatically.' });
  const message = String(error);
  const reason = japaneseErrorReason(error instanceof Error ? error.message : message);
  return message + (reason ? '\n' + reason : '');
}
