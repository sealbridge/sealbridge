// The fragment stays opaque and is used only after a user clicks an action.
// No verification, relay requests, logging, or persistent storage.
const $ = (id) => document.getElementById(id);
let japanese = navigator.language.startsWith('ja');
const words = {
  en: {
    language: '日本語',
    eyebrow: 'A private invitation',
    title: 'An invitation to get your code reviewed by another AI.',
    intro:
      'Send your code to the reviewer’s agent and get a review back, even across different models. Their agent and its model provider can read your code; the relay cannot.',
    installTitle: '01 / Install Sealbridge',
    installText: 'Run the line for your system on your PC, then open a new terminal.',
    copy: 'Copy command',
    installGuide: 'Installation guide',
    acceptTitle: '02 / Accept the invitation',
    acceptText:
      'Copy the invitation link, run the command below yourself, and paste at the prompt. Use the same machine and OS account as your Sealbridge MCP server. The CLI claims this single-use link through the relay and sends a connection request. Compare the six-digit confirmation number with the sender through a trusted channel. The number checks the invitation; it does not approve work.',
    copyLink: 'Copy invitation link',
    nextTitle: '03 / Request a code review',
    nextText:
      'Ask your MCP client to list saved invitations with acp_list_invites, then request a code review using the saved reference or alias. For CLI requests, use sealbridge delegate --to with the saved alias and your task. Sending a request shares its input with the recipient under your configured approval policy.',
    guide: 'Review and invitation guide',
    openApp: 'Open in Desktop',
    shareLink: 'Send this link to my PC',
    botText:
      'Using Muse or Grok Bot? Give it the short invitation link directly, then check the peer name and six-digit confirmation number in chat.',
    safetyTitle: 'Share safely',
    safety:
      'The official invitation host is sealbridge.app. Confirm the sender through a trusted channel. This short link is single-use and expires; share it only with the intended recipient. Browsers, extensions and chat history may retain the link. This page does not read the invitation contents or send them to a server; it cannot verify the sender or availability. Import it in Desktop or CLI on your PC.',
    copied: 'Copied.',
    copyFailed:
      'Clipboard unavailable. Copy the link from the address bar or select the command manually.',
    shareFallback: 'Copy the link and send it to your PC.',
    shareClosed: 'Sharing closed.',
  },
  ja: {
    language: 'English',
    eyebrow: 'プライベートな招待',
    title: '相手の AI にコードをレビューしてもらえる招待です。',
    intro:
      'あなたのコードを相手のエージェントに送り、レビュー結果を受け取れます。モデルが違っても使えます。相手のエージェントとモデル提供者はコードを読めます。中継器は読めません。',
    installTitle: '01 / Sealbridge をインストール',
    installText: 'PC でお使いの OS に合う 1 行を実行し、新しいターミナルを開いてください。',
    copy: 'コマンドをコピー',
    installGuide: 'インストール案内',
    acceptTitle: '02 / 招待を取り込む',
    acceptText:
      '招待リンクをコピーし、ご自身で下のコマンドを実行して、入力を求められたら貼り付けます。Sealbridge MCP サーバーと同じ端末・OS アカウントで実行してください。CLI が中継器からこの 1 回限りの招待を取得し、接続リクエストを送ります。6 桁の確認番号を信頼できる経路で送り手と照合してください。番号は招待を確認するもので、仕事の承認ではありません。',
    copyLink: '招待リンクをコピー',
    nextTitle: '03 / コードレビューを頼む',
    nextText:
      'MCP クライアントに acp_list_invites で保存した招待を一覧してもらい、その参照または別名でコードレビューを依頼します。CLI では sealbridge delegate --to に保存した別名と依頼内容を指定します。依頼の送信時に、設定済みの承認方針に従って入力を相手に共有します。',
    guide: 'レビューと招待のガイド',
    openApp: 'Desktop で開く',
    shareLink: 'このリンクを自分の PC に送る',
    botText:
      'Muse や Grok Bot では、この短い招待リンクを直接渡し、チャットで相手の名前と 6 桁の確認番号を確かめてください。',
    safetyTitle: '安全に共有する',
    safety:
      '公式の招待ホストは sealbridge.app です。信頼できる経路で送り手を確認してください。この短いリンクは 1 回限りで期限があります。意図した相手だけに送ってください。ブラウザや拡張機能、チャット履歴にリンクが残る場合があります。このページは招待の中身を読まず、サーバーにも送りません。送り手や稼働状況の検証はできません。PC の Desktop または CLI で取り込んでください。',
    copied: 'コピーしました。',
    copyFailed:
      'コピーできません。リンクはアドレス欄から、コマンドは選択して手動でコピーしてください。',
    shareFallback: 'リンクをコピーして PC に送ってください。',
    shareClosed: '共有を閉じました。',
  },
};
const text = () => words[japanese ? 'ja' : 'en'];
function render() {
  document.documentElement.lang = japanese ? 'ja' : 'en';
  document.title = text().title;
  for (const element of document.querySelectorAll('[data-text]'))
    element.textContent = text()[element.dataset.text];
  $('install-guide').href = `https://sealbridge.dev/${japanese ? 'ja' : 'en'}/install/`;
  $('guide').href = `https://sealbridge.dev/${japanese ? 'ja/docs/README.ja' : 'en/docs/README'}/`;
  $('action-status').textContent = '';
}
$('language').addEventListener('click', () => {
  japanese = !japanese;
  render();
});
$('open-app').addEventListener('click', () => {
  location.href = 'sealbridge://join' + location.hash;
});
for (const [button, command] of [
  ['copy-link', null],
  ['copy-install', 'install'],
  ['copy-windows', 'windows'],
  ['copy-accept', 'accept'],
]) {
  $(button).addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(
        command ? $(command).textContent : 'https://sealbridge.app/j' + location.hash,
      );
      $('action-status').textContent = text().copied;
    } catch {
      $('action-status').textContent = text().copyFailed;
    }
  });
}
$('share-link').addEventListener('click', async () => {
  if (!navigator.share) {
    $('action-status').textContent = text().shareFallback;
    return;
  }
  try {
    await navigator.share({ url: 'https://sealbridge.app/j' + location.hash });
  } catch {
    $('action-status').textContent = text().shareClosed;
  }
});
render();
