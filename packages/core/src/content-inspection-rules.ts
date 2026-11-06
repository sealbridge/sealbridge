// SPDX-License-Identifier: Apache-2.0
import { digest } from './crypto.js';

export type RuleInspectionKind = 'size' | 'format' | 'invisible_text' | 'injection' | 'url' |
  'secret_request' | 'secret_present' | 'executable';
export interface RuleInspectionRule {
  readonly id: string;
  readonly kind: RuleInspectionKind;
  readonly severity: 'info' | 'warn' | 'block';
  readonly detector: 'bounds' | 'unicode' | 'phrase' | 'url' | 'secret' | 'code' | 'base64';
  readonly noteCode: string;
  readonly pattern?: string;
  readonly flags?: string;
  readonly terms?: readonly string[];
}
export const CONTENT_INSPECTION_LIMITS = Object.freeze({
  maxBytes: 256 * 1024, maxDepth: 32, maxNodes: 100_000, maxStringLength: 64 * 1024,
  maxFindings: 100, maxDecodedBytes: 64 * 1024,
});
export const CONTENT_INSPECTION_RULESET_VERSION = '1.0.0';
// Descriptors and detector implementation are versioned together. No caller-supplied rules.
const descriptors: RuleInspectionRule[] = [
  { id: 'bounds', kind: 'size', severity: 'block', detector: 'bounds', noteCode: 'CONTENT_BOUND' },
  { id: 'format', kind: 'format', severity: 'block', detector: 'bounds', noteCode: 'JSON_FORMAT' },
  { id: 'unicode', kind: 'invisible_text', severity: 'warn', detector: 'unicode', noteCode: 'INVISIBLE_TEXT',
    pattern: '[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\ufeff\\u{e0000}-\\u{e007f}]', flags: 'gu' },
  { id: 'instruction-phrases', kind: 'injection', severity: 'warn', detector: 'phrase', noteCode: 'INSTRUCTION_PHRASE',
    pattern: 'ignore\\s+(?:all\\s+)?previous\\s+instructions|system\\s+prompt|以前の指示を無視|あなたは今から', flags: 'giu' },
  { id: 'url', kind: 'url', severity: 'warn', detector: 'url', noteCode: 'URL_FORM',
    pattern: '(?:[a-z][a-z0-9+.-]*://|(?:https?|ftp|file|mailto|tel|ssh|wss?|data|javascript):|www\\.)[^\\s<>"\\x60]+', flags: 'giu',
    terms: ['bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'is.gd', 'buff.ly', 'ow.ly'] },
  { id: 'secret-request', kind: 'secret_request', severity: 'warn', detector: 'secret', noteCode: 'SECRET_REQUEST',
    pattern: 'api[ _-]?(?:key|キー)|\\.env\\b|~?/\\.ssh\\b|id_rsa|token|password|トークン|パスワード|秘密鍵|認証情報', flags: 'giu',
    terms: ['send', 'paste', 'disclose', 'share', 'reveal', 'upload', '送', '貼', '開示', '教え', '共有'] },
  { id: 'secret-present', kind: 'secret_present', severity: 'warn', detector: 'secret', noteCode: 'SECRET_FORM',
    pattern: '-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----|(?:AKIA|ASIA)[A-Z0-9]{16}\\b|gh[pousr]_[A-Za-z0-9]{36,255}\\b|github_pat_[A-Za-z0-9_]{22,255}\\b|npm_[A-Za-z0-9]{36}\\b|sk-(?:proj-)?[A-Za-z0-9_-]{20,255}\\b', flags: 'gu' },
  { id: 'code', kind: 'executable', severity: 'warn', detector: 'code', noteCode: 'CODE_FORM',
    pattern: '^#![^\\r\\n]+|```|<script\\b|\\b(?:bash|sh|zsh)\\s+(?:-c\\b|[^\\s]+\\.sh\\b)|\\b(?:powershell|pwsh)(?:\\.exe)?\\s+-|\\b(?:Invoke-Expression|Start-Process)\\b|\\b(?:curl|wget)\\b[^\\r\\n|]{0,256}\\|\\s*(?:ba)?sh\\b', flags: 'gimu' },
  { id: 'base64', kind: 'executable', severity: 'warn', detector: 'base64', noteCode: 'BASE64_FORM',
    pattern: '(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{80,}={0,2}(?![A-Za-z0-9+/=])', flags: 'gu' },
  { id: 'binary-magic', kind: 'executable', severity: 'block', detector: 'base64', noteCode: 'BINARY_OR_ARCHIVE' },
];
export const CONTENT_INSPECTION_RULES: readonly RuleInspectionRule[] = Object.freeze(descriptors.map(rule =>
  Object.freeze({ ...rule, ...(rule.terms ? { terms: Object.freeze([...rule.terms]) } : {}) })));
export const CONTENT_INSPECTION_RULESET_DIGEST = digest({
  detectorVersion: CONTENT_INSPECTION_RULESET_VERSION, rules: CONTENT_INSPECTION_RULES, limits: CONTENT_INSPECTION_LIMITS,
});
