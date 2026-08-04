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
import { Tag } from '@lezer/highlight';
import type { MarkdownConfig } from '@lezer/markdown';

/**
 * A tag of our own rather than reusing e.g. `tags.special(tags.content)`
 * (which is what lezer-markdown's Superscript picks): a dedicated tag can be
 * targeted by `markdownHighlightStyle` with no chance of colliding with
 * another construct that happens to share a generic tag later.
 */
export const highlightTag = Tag.define();

/**
 * A second dedicated tag for the `==` marks themselves, deliberately NOT
 * `tags.processingInstruction` (what every other marker in the grammar gets).
 * `{ 'Highlight/...': highlightTag }` below uses Lezer's inherit-mode style
 * spec (the `/...` suffix), which applies `highlightTag`'s class to every
 * descendant node -- including `HighlightMark`. If `HighlightMark` also
 * carried `tags.processingInstruction`, it would carry both tags, and
 * `markdownHighlightStyle`'s cascade (styles later in the list win, per
 * `@codemirror/language`'s `HighlightStyle.define` docs) would decide which
 * one paints the marker -- accidentally, based on array order, not on
 * purpose. A tag that only `HighlightMark` carries lets `highlight.ts` give
 * the marks their own rule instead.
 */
export const highlightMarkTag = Tag.define();

/**
 * `@lezer/markdown` keeps its own `Punctuation` regex module-private
 * (dist/index.js:1389), so this is a copy -- including the `try`/overwrite
 * immediately below it (dist/index.js:1390-1393). The ASCII literal is only
 * ever the *fallback*: every JS engine this app ships on supports the
 * `\p{...}` Unicode-property escape, so the `new RegExp(...)` assignment
 * always succeeds and the literal is replaced before first use. Keeping only
 * the ASCII literal here would make `x==「y」==z` open a highlight (the copy
 * would call `「` non-punctuation) where the real package's `~~` would not,
 * silently breaking the "modelled on Strikethrough" claim above for any
 * non-ASCII punctuation. The flanking rules below are the CommonMark
 * left/right-flanking delimiter run rules, which are what stop
 * `a == b == c` from becoming a highlight.
 */
let Punctuation = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\xA1‐-‧]/;
try {
  Punctuation = new RegExp('[\\p{S}|\\p{P}]', 'u');
} catch {
  // Fall back to the ASCII literal above on an engine with no Unicode
  // property escape support -- unreachable in practice, but this is exactly
  // what the package itself does, and diverging here is the bug being fixed.
}

const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };

export const HighlightMarkExtension: MarkdownConfig = {
  defineNodes: [
    { name: 'Highlight', style: { 'Highlight/...': highlightTag } },
    { name: 'HighlightMark', style: highlightMarkTag },
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
