import { describe, expect, it } from 'vitest';
import { MARKDOWN_CODE_LANGUAGES } from './languages';

describe('MARKDOWN_CODE_LANGUAGES', () => {
  // Measured (task-5-report.md): a name-filtered ~20-language subset and the
  // full `@codemirror/language-data` array produce builds within 4 bytes of
  // each other, because Rollup's code splitting is driven by the *static*
  // import() call sites in language-data's own module, not by which array
  // elements a runtime `.filter()` keeps. So this is deliberately a
  // pass-through, not a curated subset -- these tests check that the
  // pass-through actually happened (not an empty or truncated array) rather
  // than asserting an exact count, which would just make this test fail on
  // every otherwise-unremarkable `@codemirror/language-data` version bump.
  it('is not empty or accidentally truncated', () => {
    // language-data ships ~140 languages (143 in the pinned 6.5.2); "many
    // dozens" is a loose enough floor to survive upstream additions/removals
    // while still catching "this resolved to the wrong export" or similar.
    expect(MARKDOWN_CODE_LANGUAGES.length).toBeGreaterThan(100);
  });

  it('contains no duplicate names', () => {
    const names = MARKDOWN_CODE_LANGUAGES.map((lang) => lang.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // Spot-check the languages Hashpad's own manual test checklist exercises
  // (docs/testing.md's fenced ```python check) and the ones whose exact
  // spelling was easy to get wrong by guessing rather than checking the
  // installed package -- C++ is "C++" (not "Cpp"), C# is "C#" (not
  // "CSharp"), and Shell (alias bash/sh/zsh) is "Shell", not "Bash".
  it.each(['Python', 'JavaScript', 'TypeScript', 'C++', 'C#', 'Shell', 'Markdown'])(
    'includes %s',
    (name) => {
      expect(MARKDOWN_CODE_LANGUAGES.some((lang) => lang.name === name)).toBe(true);
    },
  );
});
