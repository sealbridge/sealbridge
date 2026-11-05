import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../browser/join.mjs', import.meta.url), 'utf8');

test('join actions leave the fragment opaque and run only after a click', async () => {
  const fragment = '#v=1&k=opaque%3Cfragment&r=never-contact.example';
  const listeners = new Map(), calls = [], status = { textContent: '' };
  const location = { hash: fragment, set href(value) { calls.push(['open', value]); } };
  const deny = () => { throw new Error('Unexpected outbound operation'); };
  const sandbox = {
    document: { querySelector: id => id === '#action-status' ? status : { addEventListener: (event, callback) => { assert.equal(event, 'click'); listeners.set(id, callback); } } },
    location,
    navigator: { clipboard: { writeText: async value => { calls.push(['copy', value]); } }, share: async data => { calls.push(['share', data.url]); } },
    fetch: deny, XMLHttpRequest: deny, WebSocket: deny,
    localStorage: new Proxy({}, { get: deny }), sessionStorage: new Proxy({}, { get: deny }),
    console: { log: deny, error: deny },
  };
  runInNewContext(source, sandbox);
  assert.deepEqual(calls, []);
  await listeners.get('#copy-link')();
  await listeners.get('#share-link')();
  listeners.get('#open-app')();
  assert.deepEqual(calls, [
    ['copy', 'https://sealbridge.app/j' + fragment],
    ['share', 'https://sealbridge.app/j' + fragment],
    ['open', 'sealbridge://join' + fragment],
  ]);
  assert.equal(location.hash, fragment);
  delete sandbox.navigator.share;
  await listeners.get('#share-link')();
  assert.match(status.textContent, /コピーして PC/);
  sandbox.navigator.clipboard.writeText = async () => { throw new Error('clipboard denied'); };
  await listeners.get('#copy-link')();
  assert.match(status.textContent, /アドレス欄/);
});

test('both built /j pages retain CSP, referrer policy and only local script/style resources', async () => {
  const headers = await readFile(new URL('../_headers', import.meta.url), 'utf8');
  assert.match(headers, /connect-src 'none'/);
  assert.match(headers, /Referrer-Policy: no-referrer/);
  assert.doesNotMatch(source, /decodeURIComponent|JSON\.parse|URLSearchParams|fetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|console\./);
  for (const target of ['site', 'invite']) {
    const html = await readFile(new URL(`../dist/${target}/j/index.html`, import.meta.url), 'utf8');
    assert.match(html, /name="referrer" content="no-referrer"/);
    assert.deepEqual([...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]), ['/style.css', '/join.js', 'https://sealbridge.dev/ja/install/']);
    assert.match(html, /このページは招待の中身を読まず/);
    assert.match(html, /INVITE_LINK_TOKEN_REQUIRED/);
    assert.equal(await readFile(new URL(`../dist/${target}/_headers`, import.meta.url), 'utf8'), headers);
  }
});
