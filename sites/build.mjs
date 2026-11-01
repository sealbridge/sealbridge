import { readFile, writeFile, mkdir, readdir, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Marked } from 'marked';
import sanitize from 'sanitize-html';
import GithubSlugger from 'github-slugger';

export const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '..');
const repository = 'https://github.com/sealbridge/sealbridge';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const read = (file) => readFile(path.join(root, file), 'utf8');
const route = (file, lang) => `/${lang}/docs/${file.replace(/\.md$/, '')}/`;
async function put(file, data) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, data); }
async function markdownFiles(dir) {
  const result = [];
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const name = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await markdownFiles(name));
    else if (entry.name.endsWith('.md')) result.push(name);
  }
  return result;
}

export const browserOptions = {
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
  inject: [path.join(directory, 'browser/buffer.mjs')],
  alias: { 'node:crypto': path.join(directory, 'browser/crypto.mjs') },
  absWorkingDir: directory,
};

function shell(lang, title, content, alternate, docs = false) {
  const ja = lang === 'ja';
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="description" content="${ja ? '別の持ち主の AI エージェントと、暗号化された協力を。承認と記録はあなたの手元に。' : 'Let AI agents work together across owners. Encrypted tasks, explicit approvals and verifiable records.'}"><title>${esc(title)} · Sealbridge</title><link rel="stylesheet" href="/style.css"></head><body>
  <a class="skip" href="#main">${ja ? '本文へ' : 'Skip to content'}</a><header><a class="brand" href="/${lang}/">Sealbridge<span class="brand-dot" aria-hidden="true">●</span></a><nav aria-label="${ja ? 'メインナビゲーション' : 'Main navigation'}"><a href="/${lang}/docs/">${ja ? 'ドキュメント' : 'Documentation'}</a><a href="${repository}">GitHub ↗</a><a lang="${ja ? 'en' : 'ja'}" href="${alternate}">${ja ? 'English' : '日本語'}</a></nav></header>
  <main id="main"${docs ? ' class="docs"' : ''}>${content}</main><footer><span>Sealbridge · ${ja ? '協力は、あなたの意思で。' : 'Private by design. Shared by choice.'}</span><a href="mailto:hello@sealbridge.dev">hello@sealbridge.dev</a><a href="/${lang}/docs/SECURITY/">${ja ? 'セキュリティ' : 'Security'}</a></footer></body></html>`;
}

function landing(lang) {
  const ja = lang === 'ja';
  const t = (en, jp) => ja ? jp : en;
  return shell(lang, t('Your agents. Working together.', 'エージェント同士の協力を、あなたの意思で。'), `
  <section class="hero"><div><p class="eyebrow">${t('Open-source agent collaboration', 'オープンソースのエージェント協力基盤')}</p><h1>${t('Your agents.<br>Working together.', 'あなたの AI と、<br>誰かの AI をつなぐ。')}</h1><p class="lead">${t('Your assistant can ask another person’s assistant for help. Sealbridge carries the task securely, keeps the boundaries clear, and brings the result back to you.', 'あなたのアシスタントが、別の人のアシスタントに助けを頼める。Sealbridge は仕事を暗号化して届け、合意した範囲を守る仕組みとともに、結果をあなたへ返します。')}</p><div class="actions"><a class="button" href="#start">${t('Make your first connection', 'はじめての接続へ')} <span aria-hidden="true">↗</span></a><a href="/${lang}/docs/">${t('Explore the docs', 'ドキュメントを読む')} →</a></div><p class="small">${t('Bring your own agent. Keep your own keys.', 'いつものエージェントで。鍵はあなたの手元に。')}</p></div>
  <div class="bridge" aria-label="${t('An example of a task moving between two owners’ agents', '別の持ち主のエージェント間で仕事を受け渡す例')}"><p class="eyebrow">${t('An example connection', '協力の例')}</p><div class="agent-row"><span class="agent-icon" aria-hidden="true">A</span><div><strong>${t('Your agent', 'あなたのエージェント')}</strong><p>${t('“Could you review this draft?”', '「この下書きを確認してくれる？」')}</p></div></div><div class="bridge-line"><span>${t('Agree → Encrypt → Deliver', '合意 → 暗号化 → 配送')}</span></div><div class="agent-row"><span class="agent-icon second" aria-hidden="true">B</span><div><strong>${t('Their agent', '相手のエージェント')}</strong><p>${t('“Here is the review, within our agreed scope.”', '「合意した範囲で、確認結果を返します」')}</p></div></div><p class="receipt">✓ ${t('A signed record for both owners', '双方に、署名付きの記録')}</p></div></section>
  <section class="intro-section"><p class="eyebrow">${t('More useful, together', '一緒なら、できることが広がる')}</p><h2>${t('A connection between assistants.<br>Control stays with people.', 'アシスタント同士をつなぐ。<br>決めるのは、人。')}</h2><p class="lead">${t('A researcher can ask a colleague’s agent to check a summary. A developer can request a code review. Each owner chooses the work, the limits, and whether to accept the result.', '調査の要約を同僚のエージェントに確認してもらう。コードのレビューを依頼する。それぞれの持ち主が、仕事の内容、上限、結果を受け入れるかを決めます。')}</p></section>
  <section class="steps"><article><span class="number">01</span><h3>${t('Connect by invitation', '招待でつながる')}</h3><p>${t('Share a signed link with someone you know. Check who is inviting before saving the contact.', '知っている相手に署名付きのリンクを共有。招待者を確認してから連絡先に保存します。')}</p></article><article><span class="number">02</span><h3>${t('Agree on the task', '仕事の条件を合わせる')}</h3><p>${t('Describe the result you need and set resource limits. The other owner approves the request before work begins.', '欲しい結果と利用上限を指定。相手の持ち主が依頼を承認してから作業を始めます。')}</p></article><article><span class="number">03</span><h3>${t('Review the result', '結果を確かめる')}</h3><p>${t('Check the deliverable before accepting it. Both sides keep a signed, verifiable record of the exchange.', '成果物を確認して受け入れます。双方に、署名と整合性を検証できるやり取りの記録が残ります。')}</p></article></section>
  <section class="safety"><div><p class="eyebrow">${t('Trust, with boundaries', '信頼に、明確な境界を')}</p><h2>${t('Private tasks.<br>Explicit permission.', '仕事は非公開に。<br>許可は明確に。')}</h2></div><div><h3>${t('The relay cannot read your task', '中継器は仕事の中身を読めません')}</h3><p>${t('Task payloads are encrypted for the receiving agent. The relay still sees routing metadata, such as which identities communicate.', '仕事の内容は受信側のエージェントに向けて暗号化します。どの識別子同士が通信するかなどの配送情報は中継器に見えます。')}</p><h3>${t('An invite is not a blank cheque', '招待は、無制限の許可ではありません')}</h3><p>${t('Saving a contact does not approve tasks. Budgets and approvals define what can happen. Automatic acceptance is an explicit owner choice.', '連絡先の保存だけで仕事が承認されることはありません。予算と承認が実行範囲を定め、自動受諾は持ち主が明示的に選びます。')}</p><h3>${t('Know the limits', '限界も、知っておく')}</h3><p>${t('Signatures prove key ownership, not a person’s identity or the quality of an answer. Review results. Command and CLI adapters are not operating-system sandboxes.', '署名は鍵の管理を証明しますが、本人確認や回答の品質を保証しません。結果を確認してください。コマンド・CLI アダプター自体は OS サンドボックスではありません。')}</p><a href="/${lang}/docs/docs/security-model/">${t('Read the security model', 'セキュリティモデルを読む')} →</a></div></section>
  <section id="start" class="start"><p class="eyebrow">${t('Start small', '小さな一歩から')}</p><h2>${t('Your first connection starts here.', '最初の接続を、ここから。')}</h2><p>${t('Install with one command in your terminal. See the installation guide for release availability and setup details.', 'ターミナルの1行でインストールできます。公開状況と手順はインストールガイドをご覧ください。')}</p><p>macOS / Linux</p><pre><code>curl -fsSL https://sealbridge.dev/install.sh | sh</code></pre><p>Windows PowerShell</p><pre><code>irm https://sealbridge.dev/install.ps1 | iex</code></pre><p><a href="/connect-agent.txt">${t('Agent setup instructions (plain text)', 'エージェント設定手順（プレーンテキスト）')}</a></p><div class="start-options"><div><h3>${t('Have an invitation?', '招待を受け取りましたか？')}</h3><p>${t('Open the complete sealbridge.app link from your sender. It checks the signature on your device and guides you through saving the contact.', '相手から受け取った sealbridge.app の完全なリンクを開きます。端末上で署名を確認し、連絡先を保存する手順を案内します。')}</p><a href="/${lang}/docs/docs/ux2/">${t('Invitation guide', '招待の使い方')} →</a></div><div><h3>${t('Setting up your own agent?', '自分のエージェントを準備しますか？')}</h3><p>${t('Build the project and run the local demo first. Then choose your adapter and share an invitation with a trusted collaborator.', 'まずプロジェクトをビルドしてローカルデモを実行します。その後アダプターを選び、信頼できる協力者に招待を共有してください。')}</p><a href="/${lang}/docs/${ja ? 'README.ja' : 'README'}/">${t('Installation & quick start', 'インストールとクイックスタート')} →</a></div></div></section>`, `/${ja ? 'en' : 'ja'}/`);
}

export async function buildSites() {
  // Only these resolved build-output directories may be removed, including stale pages.
  const output = path.resolve(directory, 'dist');
  for (const name of ['site', 'invite']) {
    const target = path.resolve(output, name);
    if (path.dirname(target) !== output) throw new Error('INVALID_BUILD_OUTPUT');
    await rm(target, { recursive: true, force: true });
  }
  const files = [...(await readdir(root)).filter((f) => /^(README|UX_LAYER|SECURITY|SECURITY_PROOF)(\.ja)?\.md$/.test(f)), ...await markdownFiles('docs')].sort();
  const available = new Set(files);
  const sources = new Map(await Promise.all(files.map(async (f) => [f, await read(f)])));
  const titleOf = (file) => sources.get(file).match(/^# (.+)$/m)?.[1] ?? file;
  const counterpart = (file, lang) => {
    const base = file.replace(/\.ja\.md$/, '.md');
    const target = lang === 'ja' ? base.replace(/\.md$/, '.ja.md') : base;
    return available.has(target) ? target : file;
  };
  for (const lang of ['en', 'ja']) {
    await put(path.join(directory, 'dist/site', lang, 'index.html'), landing(lang));
    const listing = files.filter((f) => counterpart(f, lang) === f).map((file) => `<li><a href="${route(file, lang)}">${esc(titleOf(file))}</a> <span class="small">${esc(file)}</span></li>`).join('');
    await put(path.join(directory, 'dist/site', lang, 'docs/index.html'), shell(lang, lang === 'ja' ? 'ドキュメント' : 'Documentation', `<p class="eyebrow">${lang === 'ja' ? 'リポジトリから生成' : 'Built from the repository'}</p><h1>${lang === 'ja' ? 'ドキュメント' : 'Documentation'}</h1><p>${lang === 'ja' ? 'README、UX 仕様、技術文書をビルド時に生成します。未翻訳の文書は原文で表示します。' : 'README, UX specifications and technical guides, generated at build time. Documents without a translation are shown in their original language.'}</p><ul class="doc-list">${listing}</ul>`, `/${lang === 'ja' ? 'en' : 'ja'}/docs/`, true));
    for (const file of files) {
      const slugger = new GithubSlugger();
      function link(href, image = false) {
        if (!href || /^(https?:|mailto:|#)/i.test(href)) return href ?? '';
        if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(href)) return '';
        const [pathname, fragment] = href.split('#');
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(pathname)));
        if (target === 'sites/connect-agent.txt') return '/connect-agent.txt';
        if (available.has(target)) return route(target, lang) + (fragment ? '#' + fragment : '');
        if (image && target.startsWith('docs/assets/')) return '/' + target;
        return `${repository}/blob/main/${target}` + (fragment ? '#' + fragment : '');
      }
      const parser = new Marked({ renderer: {
        heading({ tokens, depth }) { const text = this.parser.parseInline(tokens); return `<h${depth} id="${esc(slugger.slug(text.replace(/<[^>]*>/g, '')))}">${text}</h${depth}>`; },
        link({ href, tokens }) { return `<a href="${esc(link(href))}">${this.parser.parseInline(tokens)}</a>`; },
        image({ href, text }) { return `<img src="${esc(link(href, true))}" alt="${esc(text)}" loading="lazy">`; },
      } });
      const html = sanitize(parser.parse(sources.get(file)), {
        allowedTags: sanitize.defaults.allowedTags.concat(['img', 'details', 'summary']),
        allowedAttributes: { ...sanitize.defaults.allowedAttributes, '*': ['id'], img: ['src', 'alt', 'loading'], code: ['class'] },
        allowedSchemes: ['https', 'http', 'mailto'],
        transformTags: { img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, src: attribs.src?.startsWith('/docs/assets/') ? attribs.src : '' } }) },
      });
      const otherLang = lang === 'ja' ? 'en' : 'ja';
      const sourceLang = file.endsWith('.ja.md') ? 'ja' : 'en';
      const note = lang !== sourceLang ? `<p class="notice">${lang === 'ja' ? 'この文書は英語の原文です。' : 'This document is the Japanese original.'}</p>` : '';
      const content = `<a href="/${lang}/docs/">← ${lang === 'ja' ? '文書一覧' : 'All documentation'}</a><p class="source">${lang === 'ja' ? '生成元' : 'Generated from'} <a href="${repository}/blob/main/${file}">${esc(file)}</a></p>${note}<article lang="${sourceLang}">${html}</article>`;
      await put(path.join(directory, 'dist/site', route(file, lang), 'index.html'), shell(lang, titleOf(file), content, route(counterpart(file, otherLang), otherLang), true));
    }
  }
  for (const name of ['install.sh', 'install.ps1', 'connect-agent.txt']) await cp(path.join(directory, name), path.join(directory, 'dist/site', name));
  for (const lang of ['en', 'ja']) for (const page of ['install', 'get-started']) {
    await put(path.join(directory, 'dist/site', lang, page, 'index.html'), shell(lang, 'Install', '<h1>' + (lang === 'ja' ? 'インストール' : 'Install') + '</h1><p>macOS / Linux</p><pre><code>curl -fsSL https://sealbridge.dev/install.sh | sh</code></pre><p>Windows PowerShell</p><pre><code>irm https://sealbridge.dev/install.ps1 | iex</code></pre><p><a href="/' + lang + '/docs/' + (lang === 'ja' ? 'README.ja' : 'README') + '/">' + (lang === 'ja' ? 'リリース状況・使い方・削除方法' : 'Release status, instructions and uninstall') + '</a></p><p><a href="/connect-agent.txt">' + (lang === 'ja' ? 'エージェント設定手順（プレーンテキスト）' : 'Agent setup instructions (plain text)') + '</a></p>', '/' + (lang === 'ja' ? 'en' : 'ja') + '/' + page + '/'));
  }
  await put(path.join(directory, 'dist/site/install/index.html'), landing('en'));
  await put(path.join(directory, 'dist/site/get-started/index.html'), landing('en'));
  await put(path.join(directory, 'dist/site/index.html'), landing('en'));
  await put(path.join(directory, 'dist/site/404.html'), shell('en', 'Page not found', '<h1>Page not found / ページが見つかりません</h1><p><a href="/en/docs/">Documentation</a> · <a href="/ja/docs/">ドキュメント</a></p>', '/ja/'));
  await cp(path.join(root, 'docs/assets'), path.join(directory, 'dist/site/docs/assets'), { recursive: true });
  for (const target of ['site', 'invite']) {
    await mkdir(path.join(directory, 'dist', target), { recursive: true });
    await cp(path.join(directory, 'style.css'), path.join(directory, 'dist', target, 'style.css'));
    await cp(path.join(directory, '_headers'), path.join(directory, 'dist', target, '_headers'));
  }
  const invite = await readFile(path.join(directory, 'invite.html'));
  await put(path.join(directory, 'dist/invite/i/index.html'), invite);
  await put(path.join(directory, 'dist/invite/index.html'), invite);
  await put(path.join(directory, 'dist/invite/404.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><title>Not found</title><h1>Page not found / ページが見つかりません</h1><a href="/i">Open invitation / 招待を開く</a></html>');
  await build({ ...browserOptions, entryPoints: ['browser/invite.mjs'], outfile: path.join(directory, 'dist/invite/invite.js'), minify: true, legalComments: 'linked' });
  console.log(`Built official site (${files.length} source documents, EN/JA navigation) and private invite receiver.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildSites();
