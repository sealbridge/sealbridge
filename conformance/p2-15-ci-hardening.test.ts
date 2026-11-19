// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const MUTABLE_REF = /@(?:v[^#\s]+|main|master)\b/;

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

/** Action refs on `uses:` lines, ignoring a trailing `# vX.Y.Z` comment. */
function actionRefs(workflow: string): string[] {
  const refs: string[] = [];
  for (const raw of workflow.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const match = /^-?\s*uses:\s*(\S+)\s*$/.exec(line);
    if (!match) continue;
    const spec = match[1];
    const at = spec.lastIndexOf('@');
    expect(at, spec).toBeGreaterThan(0);
    refs.push(spec.slice(at + 1));
  }
  return refs;
}

describe('P2-15 CI hardening', () => {
  it('pins every action to a commit SHA, limits contents to read, and covers three operating systems', () => {
    const workflow = read('../.github/workflows/conformance.yml');
    expect(workflow).toMatch(/^permissions:\n  contents: read$/m);
    expect(workflow).toContain('strategy:');
    expect(workflow).toContain('matrix:');
    expect(workflow).toContain('name: conformance (${{ matrix.label }})');
    expect(workflow).toContain('include:');
    const runners = [...workflow.matchAll(/^\s*- label: (\S+)\n\s+os: (\S+)$/gm)].map(
      ([, label, os]) => ({ label, os }),
    );
    expect(runners).toEqual([
      { label: 'ubuntu-latest', os: 'ubuntu-24.04' },
      { label: 'macos-latest', os: 'macos-latest' },
      { label: 'windows-latest', os: 'windows-latest' },
    ]);
    expect(workflow).toContain('runs-on: ${{ matrix.os }}');
    const refs = actionRefs(workflow);
    expect(refs.length).toBeGreaterThanOrEqual(3);
    for (const ref of refs) expect(ref).toMatch(COMMIT_SHA);
    expect(workflow).not.toMatch(MUTABLE_REF);
    expect(workflow).not.toContain('actions/checkout@v');
    expect(workflow).not.toContain('pnpm/action-setup@v');
    expect(workflow).not.toContain('actions/setup-node@v');
  });

  it('schedules Dependabot updates for github-actions and npm', () => {
    const dependabot = read('../.github/dependabot.yml');
    expect(dependabot).toMatch(/^version:\s*2$/m);
    for (const ecosystem of ['github-actions', 'npm']) {
      expect(dependabot).toMatch(new RegExp(`package-ecosystem:\\s*(['"])${ecosystem}\\1`));
    }
    expect(dependabot.match(/directory:\s*(['"])\/\1/g)?.length).toBeGreaterThanOrEqual(2);
    expect(dependabot.match(/interval:\s*(['"])weekly\1/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('lists this regression in the conformance README', () => {
    const readme = read('./README.md');
    expect(readme).toContain('p2-15-ci-hardening.test.ts');
    expect(readme).toContain('.github/workflows/conformance.yml');
    expect(readme).toContain('.github/dependabot.yml');
    expect(readme).toContain('ubuntu-24.04');
    expect(readme).toContain('conformance (ubuntu-latest)');
    expect(readme).toContain('conformance (macos-latest)');
    expect(readme).toContain('conformance (windows-latest)');
    expect(readme).toContain('macos-latest');
    expect(readme).toContain('windows-latest');
    expect(readme).toContain('contents: read');
  });
});
