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
import { HighlightStyle, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';
import { HighlightMarkExtension, highlightMarkTag, highlightTag } from './highlightmark';
import { MARKDOWN_CODE_LANGUAGES } from './languages';

/**
 * Heading sizes step down from 1.6em to 1.0em (about the visual range a
 * markdown reader expects from h1 to h6) with shrinking increments -- the
 * jump from h1 to h2 is the one that has to read clearly as "one level down
 * the outline", while h4-h6 are rare in practice and mostly need to be
 * distinguishable from body text, not from each other.
 */
export const markdownHighlightStyle = HighlightStyle.define(
  [
    // `tags.heading` is the parent of `heading1`..`heading6`, and GFM also
    // hangs `TableHeader/...` off it. Claimed here for one reason: without a
    // rule of our own, `defaultHighlightStyle`'s `tags.heading` entry supplies
    // `text-decoration: underline`, and because the two styles *union* per
    // property rather than compete, every heading in the editor was underlined
    // -- along with every GFM table header cell and the `|` delimiters around
    // it. Ours sets the property explicitly so the answer is a decision rather
    // than an inheritance.
    //
    // This rule alone is NOT enough, and the reason is easy to get wrong:
    // `HighlightStyle.style()` returns the *most specific* matching rule, not
    // every matching rule, so an `ATXHeading1` node resolves to the
    // `tags.heading1` entry below and never sees this one. Ours therefore
    // covers only what has no more specific entry -- GFM's table headers --
    // while each of the six levels has to carry `textDecoration` itself.
    // Measured: with this rule alone, table headers came out clean and every
    // real heading was still underlined.
    { tag: tags.heading, fontWeight: 'bold', textDecoration: 'none' },
    {
      tag: tags.heading1,
      fontSize: '1.6em',
      fontWeight: 'bold',
      textDecoration: 'none',
      color: 'var(--syn-heading)',
    },
    {
      tag: tags.heading2,
      fontSize: '1.42em',
      fontWeight: 'bold',
      textDecoration: 'none',
      color: 'var(--syn-heading)',
    },
    {
      tag: tags.heading3,
      fontSize: '1.28em',
      fontWeight: 'bold',
      textDecoration: 'none',
      color: 'var(--syn-heading)',
    },
    {
      tag: tags.heading4,
      fontSize: '1.17em',
      fontWeight: 'bold',
      textDecoration: 'none',
      color: 'var(--syn-heading)',
    },
    {
      tag: tags.heading5,
      fontSize: '1.08em',
      fontWeight: 'bold',
      textDecoration: 'none',
      color: 'var(--syn-heading)',
    },
    {
      tag: tags.heading6,
      fontSize: '1.0em',
      fontWeight: 'bold',
      textDecoration: 'none',
      color: 'var(--syn-heading)',
    },
    { tag: tags.strong, fontWeight: 'bold' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    {
      tag: tags.monospace,
      fontFamily: 'var(--font-editor)',
      backgroundColor: 'var(--syn-code-bg)',
      color: 'var(--syn-code-fg)',
    },
    // `textDecoration` is not decoration here, it is a claim: without it,
    // `defaultHighlightStyle`'s own `tags.link` rule supplies
    // `text-decoration: underline` and the two styles union per property, the
    // same way they did on headings. That underlined every inline `[t](u)`
    // and `![alt](u)` -- brackets, parens and title included -- while leaving
    // `<autolink>` and `[label]: url` alone, since those carry `url` without
    // `link`. An underline nobody chose, applied inconsistently. The colour
    // already distinguishes a link, and source mode shows the `[](...)`
    // syntax anyway.
    { tag: [tags.link, tags.url], color: 'var(--syn-link)', textDecoration: 'none' },
    { tag: tags.quote, color: 'var(--syn-quote-fg)' },
    // The defining rule of source mode: literal marker characters (`#`, `*`,
    // `>`, backticks, list bullets -- see @lezer/markdown's own
    // `markdownHighlighting`, which tags `HeaderMark QuoteMark ListMark
    // EmphasisMark CodeMark` etc. with this one tag) get a dim colour, never
    // `display: none` or a zero-width class. `--syn-marker` was tuned in an
    // earlier checkpoint specifically to clear WCAG AA as *readable text*,
    // not decoration -- do not lower it, and do not hide what it colours.
    { tag: tags.processingInstruction, color: 'var(--syn-marker)' },
    // A horizontal rule's `---` is `tags.contentSeparator`, not
    // `processingInstruction`, so it needs its own entry -- and without one it
    // does not fall back to the document's foreground. `defaultHighlightStyle`
    // (registered below, in `markdownSupport`) claims `contentSeparator` with a
    // hard-coded `#219`, which rendered every rule dark blue in *both* themes:
    // 13.06:1 on the light background, but **1.33:1** on the dark one, i.e.
    // invisible. `--syn-marker` because a rule is exactly that -- a marker
    // character standing alone -- and it carries the AA-cleared pair already
    // recorded in variables.css (4.5:1 light, 4.6:1 dark).
    { tag: tags.contentSeparator, color: 'var(--syn-marker)' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },

    // The rest of the same gap `contentSeparator` closed: tags the markdown
    // grammar emits that this style had no opinion on, so
    // `defaultHighlightStyle` supplied one of CodeMirror's built-in colours --
    // all tuned for a white page, none from variables.css. Measured against
    // `--bg-editor` before the fix:
    //
    //   CodeInfo, LinkLabel  labelName   #219  1.33:1 dark
    //   TaskMarker           atom        #219  1.33:1 dark
    //   LinkTitle            string      #a11  2.32:1 dark
    //   Comment (inline)     comment     #940  2.64:1 dark
    //   Entity               character   #a11  2.32:1 dark
    //   Escape               escape      #e40  4.54:1 dark, but 3.84:1 light
    //
    // These names are generic -- `string`, `atom`, `comment` and friends are
    // emitted by every nested code grammar too -- which is exactly why the
    // whole style is scoped to `markdownLanguage` (see the `scope` option
    // below). Unscoped, they would repaint the contents of every fenced block.
    //
    // `--syn-marker` for all but the title because each is syntax rather than
    // prose: a fence's language name, a checkbox literal, a backslash escape,
    // an HTML entity and a comment are all markup the reader needs to see but
    // not read as content. That is what the token is for.
    //
    // These sit BEFORE the `highlightTag` rule below, and must stay there.
    // Later entries win, and `'Highlight/...'` is an inherit-mode spec, so an
    // `Entity` or `Escape` *inside* `==marked==` carries both this rule and
    // `highlightTag`. Placed after, they flipped such a span's foreground from
    // `--syn-highlight-fg` to `--syn-marker` -- 2.27:1 on the highlight wash,
    // which is the precise failure `--syn-highlight-marker` exists to prevent.
    { tag: tags.labelName, color: 'var(--syn-marker)' },
    { tag: tags.atom, color: 'var(--syn-marker)' },
    { tag: [tags.escape, tags.character], color: 'var(--syn-marker)' },
    // Reaches an *inline* `<!-- comment -->` only. A block-level comment and
    // any HTML block are mounted HTML sub-trees, so the scope below excludes
    // them and they keep `defaultHighlightStyle`'s colour -- see that comment.
    { tag: tags.comment, color: 'var(--syn-marker)' },
    // A link's title (`[x](u "title")`) is part of the link, so it takes the
    // link colour like the URL beside it. Only reference definitions reach
    // this rule in practice -- a title inside an inline `Link` node is already
    // covered by the `tags.link` rule above, which applies to every descendant.
    { tag: tags.string, color: 'var(--syn-link)' },

    {
      tag: highlightTag,
      backgroundColor: 'var(--syn-highlight-bg)',
      color: 'var(--syn-highlight-fg)',
    },
    // `HighlightMark` (the `==` characters) carries BOTH `highlightTag` (via
    // the inherit-mode `'Highlight/...'` style spec in highlightmark.ts, which
    // applies to every descendant of a `Highlight` node) and its own
    // `highlightMarkTag`. `HighlightStyle.define` gives later entries higher
    // CSS precedence for a node that matches more than one rule, so this rule
    // MUST come after the `highlightTag` rule above -- swapping the order
    // would make the marks render in `--syn-highlight-fg` again, indistinguishable
    // from the marked text, rather than dim like every other marker in source
    // mode. `--syn-highlight-marker` is its own token (not `--syn-marker`,
    // which reads as text on this wash but fails 4.5:1 against it -- see the
    // token's comment in variables.css) so the marks stay dim-but-readable
    // (SPEC §6.6) specifically against the highlight wash, not against
    // `--bg-editor`.
    { tag: highlightMarkTag, color: 'var(--syn-highlight-marker)' },
  ],
  {
    /**
     * Our style styles *markdown*; CodeMirror's `defaultHighlightStyle` styles
     * the code embedded in it. Without this the two overlap on every generic
     * tag -- `string`, `atom`, `comment`, `labelName`, `escape` -- and since
     * ours is registered to win the ties (see `markdownSupport`), the rules
     * above would repaint the contents of every fenced code block.
     *
     * `@lezer/highlight` applies the filter at `type.isTop` and again at each
     * mounted sub-language (`highlightRange`, dist/index.js:384 and :402), so
     * this reaches every node of the markdown tree and stops at any embedded
     * grammar. Verified both directions.
     *
     * Two consequences worth knowing, both measured rather than assumed:
     *
     * - `parseCode` (@lezer/markdown) mounts only `HTMLBlock`, `HTMLTag` and
     *   `CommentBlock`. Those three are outside this scope and keep
     *   `defaultHighlightStyle`'s colours. An *inline* `<!-- comment -->` is a
     *   plain `Comment` node with no mount, so the `tags.comment` rule above
     *   does reach it -- which is the only reason that rule can exist without
     *   also recolouring the comments inside every fenced code block.
     * - The filter is `h.scope(mounted.tree.type)`, and every language built
     *   by `@codemirror/lang-markdown`'s `mkLang` shares one module-level
     *   `data` facet. So a mounted *markdown* sub-tree -- a ```markdown fence
     *   -- passes the filter and is still fully styled by us. Unchanged from
     *   before the scope, and arguably right, but it is not "stops at every
     *   embedded grammar".
     */
    scope: markdownLanguage,
  },
);

/**
 * Language + highlighting, ready to drop into `buildExtensions`. Uses
 * `markdownLanguage` (GFM: tables, task lists, autolinks, strikethrough)
 * rather than the bare CommonMark base -- `tags.strikethrough` above would
 * have nothing to colour under CommonMark alone, since `~~text~~` isn't part
 * of that grammar.
 *
 * `codeLanguages` gives ```` ```python ```` (and every other language
 * `@codemirror/language-data` knows -- see languages.ts for why this isn't
 * filtered down to a hand-picked subset) its own grammar for fenced-block
 * highlighting -- without it, `@lezer/markdown` still recognises the fence
 * but renders its contents as undifferentiated text. The fence markers
 * themselves are unaffected by this option: they're `CodeMark` nodes from
 * the markdown grammar itself, so they keep getting
 * `tags.processingInstruction` above regardless of which (if any) inner
 * grammar highlights the fenced content -- source mode's markers stay
 * visible either way.
 *
 * `defaultHighlightStyle` is what actually colours the tokens *inside* a
 * fenced block -- `markdownHighlightStyle` only names markdown-level tags
 * (heading, strong, link, ...), not the generic `keyword`/`string`/
 * `comment`/... tags a nested grammar like `@codemirror/lang-python`
 * produces. Verified empirically (see task-5-report.md): without this line,
 * a loaded Python grammar parses a fenced block into real
 * `keyword`/`variableName` nodes but nothing paints them, so the block still
 * renders as one undifferentiated colour. This adds no colours of our own --
 * `defaultHighlightStyle` is CodeMirror's own built-in style with its own
 * baked-in values, not a new `--syn-*` variable, so it doesn't touch
 * variables.css's status as the one place colours live.
 *
 * Deliberately NOT registered with `{ fallback: true }`: `getHighlighters`
 * (`@codemirror/language`'s internal facet combiner) treats "fallback" as
 * all-or-nothing across the *whole* document -- if even one non-fallback
 * highlighter is active anywhere (and `markdownHighlightStyle` always is),
 * every fallback highlighter is ignored outright, not just where the
 * non-fallback style has no opinion. Confirmed empirically: with `{
 * fallback: true }` here, fenced code silently stopped being coloured at all.
 * Registering both as ordinary (non-fallback) highlighters instead makes
 * CodeMirror union their output per the tag each applies to (the behaviour
 * `syntaxHighlighting`'s own doc comment describes for "multiple
 * (non-fallback) styles") -- markdownHighlightStyle's rules (e.g.
 * `tags.processingInstruction` on a `CodeMark` fence) and
 * defaultHighlightStyle's rules (e.g. `tags.keyword` inside the fence) don't
 * overlap, so the union is exactly "each tag gets whichever of the two has
 * an opinion on it".
 */
export function markdownSupport(): Extension[] {
  return [
    markdown({
      base: markdownLanguage,
      codeLanguages: MARKDOWN_CODE_LANGUAGES,
      extensions: [HighlightMarkExtension],
    }),
    syntaxHighlighting(markdownHighlightStyle),
    syntaxHighlighting(defaultHighlightStyle),
  ];
}
