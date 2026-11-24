import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Heading {
  level: number;
  line: number;
  text: string;
}

function extractHeadingLevels(markdown: string): Heading[] {
  const headings: Heading[] = [];
  let fence: string | undefined;
  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    if (fence) {
      const closer = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(line)?.[1];
      if (closer && closer[0] === fence[0] && closer.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (opener && (opener[1][0] !== '`' || !opener[2].includes('`'))) {
      fence = opener[1];
      continue;
    }
    const heading = /^ {0,3}(#{1,6})([\t ].*|)$/.exec(line);
    if (heading) {
      headings.push({
        level: heading[1].length,
        line: index + 1,
        text: heading[2].replace(/[\t ]+#+[\t ]*$/, '').trim(),
      });
    }
  }
  return headings;
}

function compareHeadingLevels(english: Heading[], japanese: Heading[]): string | null {
  const display = (filename: string, heading: Heading): string =>
    `${filename}:${heading.line} "${'#'.repeat(heading.level)}${heading.text ? ` ${heading.text}` : ''}" (level ${heading.level})`;
  const shared = Math.min(english.length, japanese.length);
  for (let index = 0; index < shared; index++) {
    if (english[index].level !== japanese[index].level) {
      return `Heading ${index + 1} level mismatch: ${display('README.md', english[index])}; ${display('README.ja.md', japanese[index])}`;
    }
  }
  if (english.length !== japanese.length) {
    const extra = english.length > shared ? english[shared] : japanese[shared];
    const filename = english.length > shared ? 'README.md' : 'README.ja.md';
    return `Heading count mismatch: README.md has ${english.length}, README.ja.md has ${japanese.length}; first extra heading ${shared + 1}: ${display(filename, extra)}`;
  }
  return null;
}

describe('README heading parity', () => {
  it('keeps the nonempty heading level sequences aligned across translations', () => {
    const english = extractHeadingLevels(
      readFileSync(new URL('../README.md', import.meta.url), 'utf8'),
    );
    const japanese = extractHeadingLevels(
      readFileSync(new URL('../README.ja.md', import.meta.url), 'utf8'),
    );
    expect(english.length, 'README.md must contain ATX headings').toBeGreaterThan(0);
    expect(japanese.length, 'README.ja.md must contain ATX headings').toBeGreaterThan(0);
    expect(compareHeadingLevels(english, japanese)).toBeNull();
  });

  it.each(['\n', '\r\n'])('extracts only ATX headings with %j line endings', (newline) => {
    expect(
      extractHeadingLevels(
        [
          '# Title ###  ',
          ' ## Second',
          '  ###\tThird',
          '   #### Fourth',
          '##### Fifth#',
          '######',
          '#hashtag',
          '    # Indented code',
          '####### Too deep',
          'Setext title',
          '============',
          '## ###',
        ].join(newline),
      ),
    ).toEqual([
      { level: 1, line: 1, text: 'Title' },
      { level: 2, line: 2, text: 'Second' },
      { level: 3, line: 3, text: 'Third' },
      { level: 4, line: 4, text: 'Fourth' },
      { level: 5, line: 5, text: 'Fifth#' },
      { level: 6, line: 6, text: '' },
      { level: 2, line: 12, text: '' },
    ]);
  });

  it.each(['`', '~'])('skips %s fences with languages and requires a valid closer', (marker) => {
    const fence = marker.repeat(4);
    const other = marker === '`' ? '~' : '`';
    expect(
      extractHeadingLevels(
        [
          '# Before',
          `   ${fence}typescript`,
          '# Inside',
          marker.repeat(3),
          '# After short closer',
          other.repeat(4),
          '# After wrong marker',
          `${fence} trailing text`,
          '# After trailing text',
          `    ${fence}`,
          '# After indented closer',
          `  ${marker.repeat(5)} \t`,
          '## After',
          `${marker.repeat(3)}sh`,
          '# Unclosed fence',
        ].join('\n'),
      ),
    ).toEqual([
      { level: 1, line: 1, text: 'Before' },
      { level: 2, line: 13, text: 'After' },
    ]);
  });

  it('compares levels without comparing translated text or line numbers', () => {
    expect(
      compareHeadingLevels(
        extractHeadingLevels('# Hello\n## Usage'),
        extractHeadingLevels('\n# こんにちは\n\n## 使い方'),
      ),
    ).toBeNull();
  });

  it('reports the first shared level mismatch before any count mismatch', () => {
    expect(
      compareHeadingLevels(
        extractHeadingLevels('# Title\n\n## Usage\n### Later\n## Extra'),
        extractHeadingLevels('# 題名\n### 使い方\n## 後で'),
      ),
    ).toBe(
      'Heading 2 level mismatch: README.md:3 "## Usage" (level 2); README.ja.md:2 "### 使い方" (level 3)',
    );
  });

  it('reports counts and the first extra English heading after the shared prefix', () => {
    expect(
      compareHeadingLevels(
        extractHeadingLevels('# Title\n\n## Extra\n### More'),
        extractHeadingLevels('# 題名'),
      ),
    ).toBe(
      'Heading count mismatch: README.md has 3, README.ja.md has 1; first extra heading 2: README.md:3 "## Extra" (level 2)',
    );
  });

  it('reports counts and the first extra Japanese heading after the shared prefix', () => {
    expect(
      compareHeadingLevels(
        extractHeadingLevels('# Title'),
        extractHeadingLevels('# 題名\n\n## 追加\n### 続き'),
      ),
    ).toBe(
      'Heading count mismatch: README.md has 1, README.ja.md has 3; first extra heading 2: README.ja.md:3 "## 追加" (level 2)',
    );
  });
});
