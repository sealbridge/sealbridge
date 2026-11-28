import QRCode from 'qrcode';
import { verifyFragment } from './verify.mjs';

const $ = (id) => document.getElementById(id);
let japanese = navigator.language.startsWith('ja');
let current;
let expiryTimer;
const words = {
  en: {
    title: 'Ask this reviewer’s AI to review your code.',
    eyebrow: 'A private introduction',
    intro: 'Verify the worker, import the invitation locally, then choose when to delegate.',
    privacy:
      'Verified on this device. Your invitation stays in the URL fragment; it is never sent to this site’s server. When you request a review, the recipient’s agent and its model provider can read your code; the relay cannot.',
    checking: 'Checking the invitation…',
    missing:
      'No invitation found. Ask the sender for the complete link, including the part after #.',
    invalid:
      'This invitation could not be verified. Do not accept it. Ask the sender for a new link through a trusted channel.',
    expired: 'This invitation has expired. Ask the sender for a fresh invitation.',
    valid: 'Signature verified · invitation is current',
    automatic: 'This worker responds automatically, not through a human.',
    audiences: {
      invited: 'Invited people only',
      connected: 'Connected people only',
      anyone: 'Anyone',
    },
    work: { 'read-only': 'Read-only work', write: 'Writes and commands allowed' },
    trust:
      'A valid signature proves control of these keys, not the person’s real-world identity. Confirm the sender through a channel you trust. Revocation and worker availability are checked when you connect, not on this offline page.',
    ownerLabel: 'Owner identity',
    agentLabel: 'Agent identity',
    relayLabel: 'Relay',
    expiryLabel: 'Valid until',
    installTitle: '01 / Install Sealbridge',
    installText:
      'Install Sealbridge with one line in your terminal. Use the command for your system, then open a new terminal before continuing.',
    acceptTitle: '02 / Import this invitation locally',
    acceptText:
      'On the same machine and OS account as your Sealbridge MCP server, copy the invitation link and run sealbridge accept --paste yourself. This long-link import stays local and grants no connection or work permission. The command below includes the link and may appear in shell history or process inspection. See the guide for other import methods.',
    copyLink: 'Copy invitation link',
    nextTitle: '03 / Select the saved worker',
    nextText:
      'Run sealbridge invites list, or ask your host to call acp_list_invites and use the returned workerRef or exact alias in acp_delegate_task. The model does not need the invitation token. Delegation sends task input externally under the configured approval policy; importing does not approve work. A remote MCP server needs the import on its own machine and OS account.',
    copy: 'Copy command',
    copied: 'Copied',
    copyFailed: 'Clipboard unavailable. Select and copy the command manually.',
    qrTitle: 'Open on another device',
    qrText:
      'This QR contains the same full invitation link. Share only with the intended recipient.',
    qrLarge:
      'This invitation is too large for a QR code. Copy the complete link from your address bar; nothing has been shortened or uploaded.',
    guide: 'Read the getting-started guide',
    language: '日本語',
  },
  ja: {
    automatic: 'この相手は人ではなく自動で応じます。',
    audiences: { invited: '招待した人だけ', connected: 'つながっている人だけ', anyone: '誰でも' },
    work: { 'read-only': '読むだけ', write: '書き換え・コマンドも可' },
    title: 'この相手の AI にコードレビューを依頼できます。',
    eyebrow: 'プライベートな紹介',
    intro: '相手を確認して招待をローカルに保存し、準備ができたら仕事を依頼します。',
    privacy:
      'この端末で検証します。招待は URL の # 以降だけに保持され、このサイトのサーバーには送信されません。レビューを依頼すると、受信側のエージェントとそのモデル提供者はコードを読めます。中継器は読めません。',
    checking: '招待を検証しています…',
    missing: '招待が見つかりません。# 以降を含む完全なリンクを送信者に確認してください。',
    invalid:
      '招待を検証できませんでした。受け入れず、信頼できる経路で新しいリンクを依頼してください。',
    expired: 'この招待は期限切れです。送信者に新しい招待を依頼してください。',
    valid: '署名を検証済み・招待は有効です',
    trust:
      '署名は鍵の管理者を証明しますが、実社会の本人確認ではありません。信頼できる別の経路で相手を確認してください。失効とワーカーの稼働状況は、このオフラインページではなく接続時に確認します。',
    ownerLabel: '所有者の識別子',
    agentLabel: 'エージェントの識別子',
    relayLabel: '中継器',
    expiryLabel: '有効期限',
    installTitle: '01 / Sealbridge をインストール',
    installText:
      'お使いの OS に合う 1 行をターミナルで実行し、Sealbridge をインストールします。完了後、新しいターミナルを開いて次へ進みます。',
    acceptTitle: '02 / 招待をローカルに保存',
    acceptText:
      'Sealbridge MCP サーバーと同じ端末・OS アカウントで招待リンクをコピーし、ご自身で sealbridge accept --paste を実行してください。この長いリンクの取り込みはローカルで完結し、接続や仕事の許可を与えません。下のコマンドにはリンクが含まれ、シェル履歴やプロセス一覧に残る場合があります。ほかの取り込み方法はガイドを参照してください。',
    copyLink: '招待リンクをコピー',
    nextTitle: '03 / 保存したワーカーを選ぶ',
    nextText:
      'sealbridge invites list を実行するか、ホストに acp_list_invites を呼び出してもらい、返された workerRef または正確な別名を acp_delegate_task に渡します。モデルに招待トークンを渡す必要はありません。依頼時は設定済みの承認方針に従い仕事の入力を外部に送信します。保存だけでは仕事を承認しません。リモート MCP サーバーの場合は、その端末と OS アカウントで保存してください。',
    copy: 'コマンドをコピー',
    copied: 'コピーしました',
    copyFailed: 'クリップボードを利用できません。コマンドを選択して手動でコピーしてください。',
    qrTitle: '別の端末で開く',
    qrText: 'QR には同じ完全な招待リンクが含まれます。意図した相手だけに共有してください。',
    qrLarge:
      '招待が大きすぎるため QR を作成できません。アドレスバーから完全なリンクをコピーしてください。短縮やアップロードはしていません。',
    guide: '使い方のガイドを読む',
    language: 'English',
  },
};

function render() {
  clearTimeout(expiryTimer);
  current = undefined;
  const w = words[japanese ? 'ja' : 'en'];
  document.documentElement.lang = japanese ? 'ja' : 'en';
  for (const element of document.querySelectorAll('[data-text]'))
    element.textContent = w[element.dataset.text];
  $('guide').href = `https://sealbridge.dev/${japanese ? 'ja/docs/README.ja' : 'en/docs/README'}/`;
  $('verified').hidden = true;
  $('qr').replaceChildren();
  $('command').textContent = '';
  $('automation').textContent = '';
  $('automation').hidden = true;
  $('copy-status').textContent = '';
  $('status').className = 'notice';
  if (!location.hash) {
    $('status').textContent = w.missing;
    return;
  }
  try {
    current = verifyFragment(location.hash);
    const { invite, command, link } = current;
    $('status').textContent = w.valid;
    $('status').className = 'notice success';
    $('name').textContent = invite.agentCard.payload.name;
    const rule = invite.agentCard.payload.autoAccept;
    if (rule?.enabled) {
      $('automation').textContent =
        `${w.automatic} ${w.audiences[rule.from]} · ${w.work[rule.work]}`;
      $('automation').hidden = false;
    }
    $('owner').textContent = invite.ownerDid;
    $('agent').textContent = invite.agentDid;
    $('relay').textContent = invite.relayUrl;
    const expiry = Math.min(
      Date.parse(invite.expiresAt),
      Date.parse(invite.agentCard.payload.expiresAt),
    );
    $('expiry').textContent = new Intl.DateTimeFormat(japanese ? 'ja' : 'en', {
      dateStyle: 'full',
      timeStyle: 'long',
    }).format(expiry);
    $('command').textContent = command;
    $('verified').hidden = false;
    // Recheck while the tab stays open, including long-lived invites beyond timer limits.
    expiryTimer = setTimeout(render, Math.min(Math.max(1, expiry - Date.now()), 60_000));
    try {
      const matrix = QRCode.create(link, { errorCorrectionLevel: 'L' }).modules;
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', `0 0 ${matrix.size + 8} ${matrix.size + 8}`);
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', w.qrTitle);
      svg.setAttribute('shape-rendering', 'crispEdges');
      const background = document.createElementNS(ns, 'rect');
      background.setAttribute('width', '100%');
      background.setAttribute('height', '100%');
      background.setAttribute('fill', 'white');
      svg.append(background);
      const path = document.createElementNS(ns, 'path');
      let d = '';
      for (let row = 0; row < matrix.size; row++)
        for (let col = 0; col < matrix.size; col++)
          if (matrix.get(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`;
      path.setAttribute('d', d);
      path.setAttribute('fill', 'black');
      svg.append(path);
      $('qr').append(svg);
    } catch {
      $('qr').textContent = w.qrLarge;
    }
  } catch (error) {
    $('status').className = 'notice warning';
    $('status').textContent = error.message === 'INVITE_EXPIRED' ? w.expired : w.invalid;
  }
}

async function copy(id) {
  const w = words[japanese ? 'ja' : 'en'];
  if (id === 'command' || id === 'link') {
    try {
      verifyFragment(location.hash);
    } catch {
      render();
      return;
    }
  }
  try {
    await navigator.clipboard.writeText(id === 'link' ? current.link : $(id).textContent);
    $('copy-status').textContent = w.copied;
  } catch {
    $('copy-status').textContent = w.copyFailed;
  }
}
$('language').addEventListener('click', () => {
  japanese = !japanese;
  render();
});
$('copy-install').addEventListener('click', () => copy('install'));
$('copy-command').addEventListener('click', () => copy('command'));
$('copy-link').addEventListener('click', () => copy('link'));
window.addEventListener('hashchange', render);
window.addEventListener('pageshow', render);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) render();
});
render();
