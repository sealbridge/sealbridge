import assert from 'node:assert/strict';
import test from 'node:test';
import { Marked } from 'marked';
import { headingRenderer } from '../build.mjs';

const render = (source) => new Marked({ renderer: { heading: headingRenderer() } }).parse(source);

test('heading text rendering preserves inline markup and duplicate IDs', () => {
  assert.equal(
    render('# **Bold** *em* ~~old~~ [link](https://example.com) `code`\n\n# Bold em old link code'),
    '<h1 id="bold-em-old-link-code"><strong>Bold</strong> <em>em</em> <del>old</del> <a href="https://example.com">link</a> <code>code</code></h1>' +
      '<h1 id="bold-em-old-link-code-1">Bold em old link code</h1>',
  );
});

test('inline HTML code and anchor contents contribute text without tag attributes', () => {
  assert.equal(
    render('# <code>some code</code> <a href="https://example.com" title="a > b">a link</a>'),
    '<h1 id="some-code-a-link"><code>some code</code> <a href="https://example.com" title="a > b">a link</a></h1>',
  );
});

test('inline HTML and nested markdown use the actual marked token structure', () => {
  assert.equal(
    render('# <span title="a > b">**bold**</span> <code>*literal*</code> <a href="/">*em*</a>'),
    '<h1 id="bold-literal-em"><span title="a > b"><strong>bold</strong></span> <code><em>literal</em></code> <a href="/"><em>em</em></a></h1>',
  );
});

test('each document starts a fresh heading sequence', () => {
  assert.equal(render('# Same\n\n# Same'), '<h1 id="same">Same</h1><h1 id="same-1">Same</h1>');
  assert.equal(render('# Same'), '<h1 id="same">Same</h1>');
});
