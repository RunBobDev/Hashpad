/**
 * Markdown *source-mode* syntax highlighting (SPEC §6.6/§6.13, checkpoint D
 * task 4). "Source mode" is the operative word: the raw markup stays in the
 * document and on screen -- this is styling, not hiding. Phase 2's live
 * preview is the feature that contextually hides markers near the cursor;
 * everything here exists so that feature has something to sit on top of
 * rather than a plain-text editor it has to build source mode into first.
 *
 * Every colour below is a `var(--syn-*)` custom property from
 * variables.css -- SPEC §5.3 makes that file the only place colours are
 * defined, and a `HighlightStyle` is not an exception just because its
 * values are consumed by style-mod rather than a CM6 `EditorView.theme`
 * object.
 */
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

/**
 * Heading sizes step down from 1.6em to 1.0em (about the visual range a
 * markdown reader expects from h1 to h6) with shrinking increments -- the
 * jump from h1 to h2 is the one that has to read clearly as "one level down
 * the outline", while h4-h6 are rare in practice and mostly need to be
 * distinguishable from body text, not from each other.
 */
export const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.6em', fontWeight: 'bold', color: 'var(--syn-heading)' },
  { tag: tags.heading2, fontSize: '1.4em', fontWeight: 'bold', color: 'var(--syn-heading)' },
  { tag: tags.heading3, fontSize: '1.25em', fontWeight: 'bold', color: 'var(--syn-heading)' },
  { tag: tags.heading4, fontSize: '1.15em', fontWeight: 'bold', color: 'var(--syn-heading)' },
  { tag: tags.heading5, fontSize: '1.08em', fontWeight: 'bold', color: 'var(--syn-heading)' },
  { tag: tags.heading6, fontSize: '1.0em', fontWeight: 'bold', color: 'var(--syn-heading)' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  {
    tag: tags.monospace,
    fontFamily: 'var(--font-editor)',
    backgroundColor: 'var(--syn-code-bg)',
    color: 'var(--syn-code-fg)',
  },
  { tag: [tags.link, tags.url], color: 'var(--syn-link)' },
  { tag: tags.quote, color: 'var(--syn-quote-fg)' },
  // The defining rule of source mode: literal marker characters (`#`, `*`,
  // `>`, backticks, list bullets -- see @lezer/markdown's own
  // `markdownHighlighting`, which tags `HeaderMark QuoteMark ListMark
  // EmphasisMark CodeMark` etc. with this one tag) get a dim colour, never
  // `display: none` or a zero-width class. `--syn-marker` was tuned in an
  // earlier checkpoint specifically to clear WCAG AA as *readable text*,
  // not decoration -- do not lower it, and do not hide what it colours.
  { tag: tags.processingInstruction, color: 'var(--syn-marker)' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
]);

/**
 * Language + highlighting, ready to drop into `buildExtensions`. Uses
 * `markdownLanguage` (GFM: tables, task lists, autolinks, strikethrough)
 * rather than the bare CommonMark base -- `tags.strikethrough` above would
 * have nothing to colour under CommonMark alone, since `~~text~~` isn't part
 * of that grammar.
 *
 * Deliberately NOT configured with `codeLanguages` here: per-language fenced
 * code highlighting is Task 5's addition (and `@codemirror/language-data`'s
 * dictionary of grammars is a bundle-size decision that belongs to that task,
 * not this one).
 */
export function markdownSupport(): Extension[] {
  return [markdown({ base: markdownLanguage }), syntaxHighlighting(markdownHighlightStyle)];
}
