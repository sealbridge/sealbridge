import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { headerRules, headersFor } from '../header-rules.mjs';
test('approval CSP detaches the inherited offline policy; invitation pages keep it', async () => {
  const rules = headerRules(await readFile(new URL('../_headers', import.meta.url), 'utf8'));
  const headers = headersFor(rules, '/approve');
  assert.match(headers['Content-Security-Policy'], /connect-src https:/);
  assert.doesNotMatch(headers['Content-Security-Policy'], /connect-src 'none'/);
  assert.equal(headers['Content-Security-Policy'].includes(','), false);
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  for (const path of ['/i', '/j'])
    assert.match(headersFor(rules, path)['Content-Security-Policy'], /connect-src 'none'/);
});
test('duplicate headers append unless an ordered detach removes the inherited value', () => {
  assert.equal(
    headersFor(headerRules('/*\n  X-Test: a\n/page\n  X-Test: b'), '//none')['X-Test'],
    'a',
  );
  assert.equal(
    headersFor(headerRules('/*\n  X-Test: a\n/page\n  X-Test: b'), '/page')['X-Test'],
    'a, b',
  );
  assert.equal(
    headersFor(headerRules('/*\n  X-Test: a\n/page\n  ! X-Test\n  X-Test: b'), '/page')['X-Test'],
    'b',
  );
});
