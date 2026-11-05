// Treat the fragment as opaque text, only on a user's button click.
// No decoding, verification, relay requests, logging, or persistent storage.
const status = document.querySelector('#action-status');
document.querySelector('#open-app').addEventListener('click', () => {
  location.href = 'sealbridge://join' + location.hash;
});
document.querySelector('#copy-link').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText('https://sealbridge.app/j' + location.hash); status.textContent = 'リンクをコピーしました。'; }
  catch { status.textContent = 'アドレス欄からリンクをコピーしてください。'; }
});
document.querySelector('#share-link').addEventListener('click', async () => {
  if (!navigator.share) { status.textContent = 'リンクをコピーして PC に送ってください。'; return; }
  try { await navigator.share({ url: 'https://sealbridge.app/j' + location.hash }); }
  catch { status.textContent = '共有を閉じました。'; }
});
