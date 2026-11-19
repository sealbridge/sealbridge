// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const HEAD_LINES = 30;

const ENGLISH_TITLE = '# Security Proof / Red-Team Adversarial Suite';
const ENGLISH_SWITCHER = '**English** | [日本語 (SECURITY_PROOF.ja.md)](./SECURITY_PROOF.ja.md)';
const JAPANESE_TITLE = '# セキュリティ証明 / レッドチーム敵対スイート';
const JAPANESE_SWITCHER = '[English (SECURITY_PROOF.md)](./SECURITY_PROOF.md) | **日本語**';

function linesOf(name: string): string[] {
  return readFileSync(new URL('../' + name, import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n');
}

function head(name: string): string {
  return linesOf(name).slice(0, HEAD_LINES).join('\n');
}

describe('P2-14 security proof scope notice', () => {
  it('keeps the English language switcher and disclaims a formal proof', () => {
    const lines = linesOf('SECURITY_PROOF.md');
    expect(lines[0]).toBe(ENGLISH_TITLE);
    expect(lines[2]).toBe(ENGLISH_SWITCHER);
    const notice = head('SECURITY_PROOF.md');
    expect(notice).toContain(
      '**Scope note (Adversarial Security Test Suite, not a formal proof):**',
    );
    expect(notice.indexOf(ENGLISH_SWITCHER)).toBeLessThan(
      notice.indexOf('**Scope note (Adversarial Security Test Suite, not a formal proof):**'),
    );
    expect(notice).toContain('conformance/security-proofs.test.ts');
    expect(notice).toContain('P0–P2');
    expect(notice).toContain('pnpm test:security-proof');
    expect(notice).toContain('empirical');
    expect(notice).toContain('adversarial');
    expect(notice).toContain('red-team');
    expect(notice).toContain('not machine-checked formal or mathematical proofs');
    for (const tool of ['TLA+', 'Coq', 'Lean', 'symbolic protocol verification']) {
      expect(notice).toContain(tool);
    }
  });

  it('keeps the Japanese language switcher and disclaims a formal proof', () => {
    const lines = linesOf('SECURITY_PROOF.ja.md');
    expect(lines[0]).toBe(JAPANESE_TITLE);
    expect(lines[2]).toBe(JAPANESE_SWITCHER);
    const notice = head('SECURITY_PROOF.ja.md');
    expect(notice).toContain(
      '**位置づけ（形式的証明ではなく敵対的セキュリティテストスイート）：**',
    );
    expect(notice.indexOf(JAPANESE_SWITCHER)).toBeLessThan(
      notice.indexOf('**位置づけ（形式的証明ではなく敵対的セキュリティテストスイート）：**'),
    );
    expect(notice).toContain('conformance/security-proofs.test.ts');
    expect(notice).toContain('P0〜P2');
    expect(notice).toContain('pnpm test:security-proof');
    expect(notice).toContain('経験的');
    expect(notice).toContain('敵対的');
    expect(notice).toContain('レッドチーム');
    expect(notice).toContain('形式的・数学的証明');
    for (const tool of ['TLA+', 'Coq', 'Lean', '記号的なプロトコル検証']) {
      expect(notice).toContain(tool);
    }
  });

  it('lists this regression in the conformance README', () => {
    const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
    expect(readme).toContain('p2-14-security-proof-scope-notice.test.ts');
    expect(readme).toContain('not a machine-checked formal');
  });
});
