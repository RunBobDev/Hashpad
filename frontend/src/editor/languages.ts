/**
 * The languages `codeLanguages` (highlight.ts) offers for fenced-block
 * highlighting -- checkpoint D task 5.
 *
 * This started as a name-filtered subset of `@codemirror/language-data`'s
 * ~140 `LanguageDescription`s (JavaScript, Python, Rust, ... about 20 of
 * them), on the assumption -- stated in the task brief -- that Vite embeds
 * every one of language-data's dynamic `import()`s in the build, so
 * shrinking the list at the source would shrink the build. That assumption
 * was measured, not assumed (see task-5-report.md for the full comparison):
 * a build with the 21-name filter and a build passing `languages` through
 * unfiltered came out within 4 bytes of each other, both in the main entry
 * chunk and in the total `dist/` output. The reason is that Rollup's code
 * splitting follows the *static* `import()` call sites in language-data's own
 * module -- one per language, all ~140 always present in that one file -- not
 * which array elements survive a `.filter()` call at runtime. Every grammar
 * chunk gets built regardless of whether our own code ever references that
 * particular `LanguageDescription`; filtering the array we hold a reference
 * to cannot un-emit a chunk Rollup already decided to build from the
 * dependency's source.
 *
 * With the size rationale gone, the name-filtering only cost complexity (a
 * hand-maintained list that has to track upstream renames) for a strictly
 * worse result (fewer fenced-code languages actually highlight, for a build
 * that is the same size either way regardless). So this now passes
 * `languages` straight through.
 */
import type { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

export const MARKDOWN_CODE_LANGUAGES: LanguageDescription[] = languages;
