/**
 * `==highlight==` for the editor's grammar. SPEC §6.8 lists it as supported
 * markdown and SPEC §6.5 gives it a toolbar button and a shortcut, but
 * `@lezer/markdown` has no node for it — CommonMark and GFM both stop at
 * `~~`. Without a node, the Highlight button could not show active state the
 * way the other four inline marks do, and `==text==` would sit unstyled in the
 * editor while the preview (Checkpoint F, via markdown-it-mark) rendered it.
 *
 * Modelled directly on the package's own `Strikethrough` extension: the same
 * `defineNodes` + `parseInline` + `addDelimiter` shape, with `==` in place of
 * `~~`. `after: "Emphasis"` keeps `*` and `_` resolving first, so `**==a==**`
 * nests the way a reader expects.
 */
import { Tag, tags } from '@lezer/highlight';
import type { MarkdownConfig } from '@lezer/markdown';

/**
 * A tag of our own rather than reusing e.g. `tags.special(tags.content)`
 * (which is what lezer-markdown's Superscript picks): a dedicated tag can be
 * targeted by `markdownHighlightStyle` with no chance of colliding with
 * another construct that happens to share a generic tag later.
 */
export const highlightTag = Tag.define();

/**
 * `@lezer/markdown` keeps its own `Punctuation` regex module-private
 * (dist/index.js:1389), so this is a copy. The flanking rules below are the
 * CommonMark left/right-flanking delimiter run rules, which are what stop
 * `a == b == c` from becoming a highlight.
 */
const Punctuation = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\xA1‐-‧]/;

const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };

export const HighlightMarkExtension: MarkdownConfig = {
  defineNodes: [
    { name: 'Highlight', style: { 'Highlight/...': highlightTag } },
    { name: 'HighlightMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        // 61 is '='. Require exactly two: `===` is a Setext heading underline
        // in other contexts and should not start a highlight here either.
        if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;

        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const spaceBefore = /\s|^$/.test(before);
        const spaceAfter = /\s|^$/.test(after);
        const punctBefore = Punctuation.test(before);
        const punctAfter = Punctuation.test(after);

        return cx.addDelimiter(
          HighlightDelim,
          pos,
          pos + 2,
          !spaceAfter && (!punctAfter || spaceBefore || punctBefore),
          !spaceBefore && (!punctBefore || spaceAfter || punctAfter),
        );
      },
      after: 'Emphasis',
    },
  ],
};
