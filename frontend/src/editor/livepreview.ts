/**
 * SPEC §7.1's live preview, first slice: **inline marks hide themselves unless
 * the cursor is on the line they sit on.** Type `**bold**`, move the cursor
 * away, and the asterisks vanish while the word stays bold; move back and they
 * return, so the formatting stays editable. One pane, still fully typeable --
 * that is what makes this different from the preview.
 *
 * `blockquote.ts` said in its header that it was written as the worked example
 * for this, and it was right: same `RangeSetBuilder` over `syntaxTree`, same
 * restriction to `view.visibleRanges`, same `ViewPlugin` shape. The two
 * differences are what is built (`Decoration.replace` over a range, not
 * `Decoration.line` at a position) and when it is rebuilt (also on
 * `selectionSet`, because here the cursor is an input).
 *
 * **Scope, as of K.3 -- everything §7.1 names.** The five inline marks (K.1);
 * ATX heading hashes, inline link brackets and URLs, and bullet-list markers
 * (K.2); the reading view's typography, the rule under h1 and h2, and the
 * Setext collapse (K.2a/b); images as inline thumbnails and table columns
 * aligned by padding (K.3). Nested emphasis has worked since K.1 and by
 * construction -- nothing here stops descending, so `***both***` reaches the
 * inner node on its own terms. Fenced code keeps its fence permanently -- §7.1
 * is explicit that hiding it is confusing.
 *
 * **The reveal rule is per line, not per mark**, and that is a decision rather
 * than a convenience. See `revealedAt`.
 */
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { Facet, RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state';
import { tags } from '@lezer/highlight';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type PluginValue,
  type ViewUpdate,
} from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { INLINE_MARK_NODES } from './marks';
import { ASSET_ROUTE } from '../preview/rules/images';

/**
 * An empty `replace` spec: the range is removed from the rendered line with
 * nothing put in its place. Not `Decoration.mark` with `display: none` -- a
 * hidden inline element still occupies a position the caret can land on, which
 * is exactly the "cursor disappears into an invisible asterisk" bug this
 * feature is otherwise famous for.
 */
const hidden = Decoration.replace({});

/**
 * **The reveal rule: by line, not by character.**
 *
 * §7.1 phrases it as "the line where the cursor sits", and that is also the
 * only version that meets its own "no visible reflow jitter" requirement.
 * Revealing only the mark the caret is literally inside would re-lay-out the
 * line on every arrow press *within* a formatted word, and the text would
 * shuffle sideways as the caret crossed each boundary. Per line, the reflow
 * happens once on entering the line and once on leaving it.
 *
 * The span tested is the node's whole *line* extent, not the node's own range.
 * Emphasis can straddle a soft newline inside a paragraph, and revealing the
 * opening `**` while leaving the closing one hidden looks like a bug rather
 * than a feature.
 *
 * A selection spanning the region reveals it for free -- a range is tested by
 * intersection, so `r.from`/`r.to` covering any part of those lines counts,
 * which is §7.1's second requirement with no extra branch.
 */
function revealedAt(state: EditorState, from: number, to: number): boolean {
  const { doc, selection } = state;
  const lineFrom = doc.lineAt(from).from;
  const lineTo = doc.lineAt(to).to;
  return selection.ranges.some((range) => range.from <= lineTo && range.to >= lineFrom);
}

/**
 * One range to hide or replace. `decoration` rather than always `hidden`
 * because K.2's list marker is the first thing that is *substituted* rather
 * than removed.
 */
interface Span {
  from: number;
  to: number;
  decoration: Decoration;
}

/**
 * The bullet a `-`, `*` or `+` becomes (§7.1). A widget rather than CSS on a
 * line decoration: the marker's width has to change with it, and a `::before`
 * on a line whose real `-` is hidden leaves the glyph and the text fighting
 * over the same cell.
 *
 * `eq` is unconditionally true because every instance draws the same
 * character; without it CodeMirror rebuilds the DOM node on each recompute,
 * which now happens on every cursor move.
 */
export const BULLET = '•';

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-live-bullet';
    span.textContent = BULLET;
    return span;
  }
}

const bullet = Decoration.replace({ widget: new BulletWidget() });

/**
 * What a node contributes, if anything. Each handler tests its own reveal
 * scope, because the right scope differs by node and getting it wrong is
 * invisible until you edit something long.
 *
 * An inline mark asks about its whole node: emphasis can straddle a soft line
 * break and revealing half of it looks broken. A list item must **not** --
 * `ListItem` spans every line of the item, so a whole-node test would put the
 * `-` back while you typed on line eight of it. Block markers ask about the
 * marker.
 */
type Handler = (state: EditorState, node: SyntaxNode, out: Span[]) => void;

const HANDLERS = new Map<string, Handler>();

// The five inline marks, from the table `marks.ts` already keeps.
for (const { node: nodeName, mark: markName } of Object.values(INLINE_MARK_NODES)) {
  HANDLERS.set(nodeName, (state, node, out) => {
    if (revealedAt(state, node.from, node.to)) return;
    for (const mark of node.getChildren(markName)) {
      out.push({ from: mark.from, to: mark.to, decoration: hidden });
    }
  });
}

/**
 * `#` goes, the size stays -- the size is a `HighlightStyle` on the heading
 * node, which the decoration does not touch.
 *
 * The run of spaces after the hashes goes with them. Hiding only the `#`
 * leaves the heading indented by one space against every other line, which
 * reads as a bug rather than as a heading.
 *
 * **ATX only, because a Setext heading has no hashes to hide.** Its underline
 * is handled by `headingLineDecorations` instead, which hides that line
 * outright and gives the text line the rule the `===` was drawing by hand.
 */
const headingHandler: Handler = (state, node, out) => {
  for (const mark of node.getChildren('HeaderMark')) {
    if (revealedAt(state, mark.from, mark.to)) continue;

    // **Both marks, because CommonMark allows a closing sequence.**
    // `## Title ##` has two, and hiding only the first leaves `Title ##` on
    // screen -- worse than leaving it alone. The opening mark takes the spaces
    // after it, the closing one the spaces before it; each stops at its own
    // end of the line so neither can eat the text between them.
    const line = state.doc.lineAt(mark.from);
    let { from, to } = mark;
    if (from === line.from) {
      while (to < line.to && state.doc.sliceString(to, to + 1) === ' ') to++;
    } else {
      while (from > line.from && state.doc.sliceString(from - 1, from) === ' ') from--;
    }
    out.push({ from, to, decoration: hidden });
  }
};

for (const level of [1, 2, 3, 4, 5, 6]) {
  HANDLERS.set(`ATXHeading${String(level)}`, headingHandler);
}

/**
 * `[text](url)` shows `text` (§7.1: "show the text, hide the URL until
 * focused"). The brackets, the parentheses, the URL and any title all go.
 *
 * **Inline links only.** A reference link (`[text][ref]`) has no `URL` child,
 * and hiding its brackets alone would run the label into the text and produce
 * `textref`. The `URL` test is what excludes it. Images are excluded for free:
 * `![alt](url)` parses as `Image`, a different node, and inline thumbnails are
 * K.3's job.
 */
HANDLERS.set('Link', (state, node, out) => {
  const url = node.getChild('URL');
  if (url === null) return;
  if (revealedAt(state, node.from, node.to)) return;

  // **One span from the URL to the end of the title, not two.** `[t](u "T")`
  // has a space between the URL and the title, and hiding the two nodes
  // separately leaves that space behind -- the link rendered as `t ` with a
  // trailing gap. Covering the gap is what removes it.
  const title = node.getChild('LinkTitle');
  const destinationTo = title?.to ?? url.to;

  // CommonMark allows a line break between the destination and the title, and
  // the builder refuses a replacement that crosses one -- it has to, because
  // CodeMirror throws on it. The builder's guard alone would drop this span and
  // keep the bracket spans, rendering `t/url "Title"`: worse than the markdown
  // it replaced. So the whole link declines rather than half of it.
  if (state.doc.lineAt(url.from).to < destinationTo) return;

  for (const mark of node.getChildren('LinkMark')) {
    out.push({ from: mark.from, to: mark.to, decoration: hidden });
  }
  out.push({ from: url.from, to: destinationTo, decoration: hidden });
});

/**
 * **The folder relative image paths resolve against** -- the one thing the
 * editor has never needed to know about the document it is showing.
 *
 * A facet rather than a store read from inside the decoration builders, which
 * take an `EditorState` precisely so they can be tested without an app around
 * them. Empty string for a document that has never been saved, matching
 * `documentDirOf`, whose answer this is; `extensions.ts` owns the compartment
 * that sets it.
 */
export const documentDir = Facet.define<string, string>({
  combine: (values) => values[0] ?? '',
});

/**
 * Anything with a URL scheme, copied from `preview/rules/images.ts` for the
 * reason spelled out there: **two or more characters before the colon**, so
 * that `C:/docs/pic.png` is treated as the Windows path it is rather than as a
 * `c:` URL.
 */
const REMOTE = /^[a-z][a-z0-9+.-]+:/i;

/**
 * What an `<img>` in the editor should point at, or `null` for "leave the
 * markdown alone".
 *
 * **Three answers, and they are `rules/images.ts`'s three**, because the policy
 * belongs to the app rather than to a view: `data:` passes through, a remote URL
 * is never fetched (design §3 beats SPEC §6.7, and the CSP's `img-src` omits
 * `https:` permanently), and a relative path becomes the same-origin asset route
 * Wails forwards to the Go handler. That handler is the *only* place path
 * traversal is checked -- this function does no security checking and must not
 * start, for the same reason `rules/images.ts` says so in its own header.
 *
 * **`null` rather than a placeholder for the two cases that cannot load.** The
 * reading view draws a dashed box because it has replaced the markdown and owes
 * the reader something in its place; here the markdown is still there, and
 * showing `![alt](https://…)` as itself is both more honest and more useful --
 * the URL is what you would want to see, and it stays selectable.
 *
 * **No `normalizeLinkText` here, unlike the preview rule.** By the time that
 * rule runs, markdown-it has already percent-encoded the source, so it has to
 * decode before re-encoding. A `URL` node holds raw document text, so encoding
 * it once is the whole job.
 */
function imageSource(state: EditorState, url: SyntaxNode): string | null {
  let raw = state.doc.sliceString(url.from, url.to);
  // CommonMark's pointy-bracket form, `![a](<my pic.png>)`. The brackets are
  // part of the `URL` node and are delimiters, not path characters.
  if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1);

  if (raw === '') return null;
  if (raw.startsWith('data:')) return raw;
  if (REMOTE.test(raw)) return null;

  const dir = state.facet(documentDir);
  if (dir === '') return null;
  return `${ASSET_ROUTE}?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(raw)}`;
}

/**
 * The same dashed card `rules/images.ts` renders, built as DOM rather than as a
 * string. `app.css` imports `preview.css` globally, so the class is already
 * styled here; duplicating the rule in this file's theme would let the two drift.
 *
 * `alt` becomes the accessible name when there is one, for the reason that rule
 * gives: "Image not found" tells a screen reader nothing about what is missing.
 */
function brokenImage(alt: string, src: string): HTMLElement {
  const label = 'Image not found';
  const box = document.createElement('span');
  box.className = 'preview-image-placeholder';
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', alt.trim() === '' ? label : `${alt} -- ${label}`);
  box.textContent = label;

  const detail = document.createElement('span');
  detail.className = 'preview-image-placeholder__detail';
  detail.textContent = src;
  box.append(detail);
  return box;
}

/**
 * §7.1's inline thumbnail.
 *
 * **The first widget whose height is not known when it is built**, which is the
 * thing that makes images different from every other decoration here. The line's
 * height changes when the file arrives, after CodeMirror has already measured
 * and positioned everything below it; `requestMeasure` on `load` is what makes
 * it re-read the geometry. Without it the image paints over the following lines
 * until something else happens to trigger a measure pass.
 *
 * `error` is handled for the same reason it has to be: a broken path is a
 * spelling mistake, not a crash, and the default broken-image glyph says
 * nothing. Swapping the element in place rather than dispatching a state change
 * keeps the failure a rendering detail -- a document does not become dirty, or
 * even different, because a file is missing.
 */
class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-live-image';

    const img = document.createElement('img');
    img.src = this.src;
    img.alt = this.alt;
    img.addEventListener('load', () => {
      view.requestMeasure();
    });
    img.addEventListener('error', () => {
      img.remove();
      wrap.append(brokenImage(this.alt, this.src));
      view.requestMeasure();
    });

    wrap.append(img);
    return wrap;
  }
}

/**
 * `![alt](pic.png)` becomes the picture (§7.1: "render inline thumbnails").
 *
 * **A different node from `Link`**, which is why K.2's link handler needed no
 * exclusion for images and why this one needs no exclusion for links.
 *
 * The whole node is replaced, alt text included -- the alt is what you read
 * *instead of* the picture, so showing both would be showing it twice. That
 * replacement overlaps any inline mark inside the alt (`![**a**](x.png)`
 * contributes a `StrongEmphasis` span of its own); the builder's overlap pass
 * resolves it, and the image wins because it starts first.
 *
 * A reference image (`![alt][ref]`) has no `URL` child and is left alone, as
 * reference links are.
 */
HANDLERS.set('Image', (state, node, out) => {
  const url = node.getChild('URL');
  if (url === null) return;
  if (revealedAt(state, node.from, node.to)) return;

  const src = imageSource(state, url);
  if (src === null) return;

  // Between `![` and `]`, taken from the marks rather than by offset from the
  // URL: CommonMark allows whitespace after the `(`, so `![a](  x.png)` puts
  // the URL two characters further along than the arithmetic would expect and
  // an offset-based slice reads `a]` as the alt.
  const marks = node.getChildren('LinkMark');
  const alt = marks.length >= 2 ? state.doc.sliceString(marks[0]!.to, marks[1]!.from) : '';

  out.push({
    from: node.from,
    to: node.to,
    decoration: Decoration.replace({ widget: new ImageWidget(src, alt) }),
  });
});

/**
 * `-` becomes `•`. Bullet lists only: §7.1 asks for exactly that, and an
 * ordered list's `1.` is already the glyph it should be -- replacing it would
 * throw away the number.
 */
HANDLERS.set('ListItem', (state, node, out) => {
  const mark = node.getChild('ListMark');
  if (mark === null) return;
  // The marker's own line, not the item's: a `ListItem` spans every line of a
  // multi-line item, so testing the node would restore the `-` while the caret
  // sat three paragraphs below it.
  if (revealedAt(state, mark.from, mark.to)) return;
  if (!/^[-*+]$/.test(state.doc.sliceString(mark.from, mark.to))) return;

  out.push({ from: mark.from, to: mark.to, decoration: bullet });
});

/**
 * Builds the set for exactly the ranges given. The plugin passes
 * `view.visibleRanges`, for the reason `blockquote.ts` spells out: an
 * unbounded `iterate` walks every node in the document, and at §7.1's
 * 5,000-line target that cost would be paid on every keystroke *and* now every
 * cursor move, overwhelmingly on lines nobody is looking at.
 *
 * **Takes a state and ranges rather than a view, so it is testable at all.**
 * jsdom has no layout: an `EditorView` there reports zero height, so
 * `visibleRanges` is whatever a viewport calculation makes of that rather than
 * anything a test can state an expectation about. Exported for the same reason.
 */
export function inlineMarkDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const spans: Span[] = [];

  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      // Not `return false` anywhere below: a revealed `**_a_**` must reveal the
      // nested Emphasis too, and descending lets each node reach that
      // conclusion on its own terms rather than inheriting one.
      enter: (node) => {
        const handler = HANDLERS.get(node.name);
        handler?.(state, node.node, spans);
      },
    });
  }

  // Nesting visits parents before children, so `***both***` contributes the
  // outer `**` before the inner `*` -- descending order at the same start
  // position. Two visible ranges either side of a fold can also each enter a
  // node that straddles the gap, yielding exact duplicates. `RangeSetBuilder`
  // requires sorted, non-overlapping input and throws on either, so both are
  // resolved here rather than hoped away: sort once, then keep only spans that
  // start at or after the end of the last one kept.
  spans.sort((a, b) => a.from - b.from || a.to - b.to);
  let end = -1;
  for (const span of spans) {
    if (span.from < end) continue;
    // **A replacement may not cross a line break, and CodeMirror throws rather
    // than ignoring one**: "Decorations that replace line breaks may not be
    // specified via plugins" -- the same restriction the Setext underline works
    // around with `display: none` (see `headingLineDecorations`). A state field
    // is allowed to do it; a `ViewPlugin` is not, and a state field cannot see
    // the viewport.
    //
    // Two handlers can produce one. An image's alt text may wrap
    // (`![alt\ntext](p.png)`), and CommonMark allows a line break between a
    // link's destination and its title (`[t](/url\n"Title")`) -- **the second
    // has been reachable since K.2 and was found by looking for siblings of the
    // first**, not by a report. Guarded here rather than in each handler so a
    // future one cannot reintroduce it: this is the only place a span becomes a
    // decoration.
    //
    // The consequence is that the markdown stays visible for those two, which
    // is the same answer this file already gives whenever it cannot render
    // something.
    if (state.doc.lineAt(span.from).to < span.to) continue;
    builder.add(span.from, span.to, span.decoration);
    end = span.to;
  }
  return builder.finish();
}

/**
 * Every line of a fenced block or a GFM table, marked so the typography below
 * can hold it at fixed pitch while the prose around it goes proportional.
 *
 * **A line decoration is the only mechanism that reaches these.** Inline code
 * needs nothing -- `highlight.ts` pins `var(--font-editor)` on the
 * `tags.monospace` span itself -- but a fenced block's contents are highlighted
 * by the *nested* language, so they never pass through that tag and carry no
 * class a stylesheet could hang a font on. A table's rows are ordinary text to
 * the styler.
 */
const monoLine = Decoration.line({ class: 'cm-live-mono' });

export function monoBlockLines(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  const positions: number[] = [];
  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'FencedCode' && node.name !== 'Table') return;
        // Clipped to the visible range, as in `blockquote.ts`: either construct
        // can start above the viewport and end below it.
        const first = state.doc.lineAt(Math.max(node.from, from)).number;
        const last = state.doc.lineAt(Math.min(node.to, to)).number;
        for (let n = first; n <= last; n++) positions.push(state.doc.line(n).from);
      },
    });
  }

  positions.sort((a, b) => a - b);
  const builder = new RangeSetBuilder<Decoration>();
  let previous = -1;
  for (const pos of positions) {
    // A table inside a list item, or two visible ranges either side of a fold,
    // can each offer the same line; `RangeSetBuilder` rejects a repeat.
    if (pos === previous) continue;
    builder.add(pos, pos, monoLine);
    previous = pos;
  }
  return builder.finish();
}

const monoBlocks = ViewPlugin.fromClass(
  class implements PluginValue {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = monoBlockLines(view.state, view.visibleRanges);
    }

    update(update: ViewUpdate): void {
      // No `selectionSet` clause, unlike the marker plugin: which lines are
      // code does not depend on where the caret is.
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = monoBlockLines(update.view.state, update.view.visibleRanges);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/**
 * §7.1's "tables: align columns visually", which K.2a made possible without
 * doing: a table's lines are already held at fixed pitch by `cm-live-mono`, so
 * every character is one cell wide and columns line up **if the source is
 * padded**. `|a|bb|` still renders as `|a|bb|`. This is what pads it.
 *
 * **Padding, not hiding, and that is what makes the reveal rule unnecessary.**
 * Nothing here is removed, so the text on screen is exactly the text in the
 * document plus some space before each `|`. Editing a cell widens its column and
 * every row follows -- which is what alignment *is*, rather than jitter.
 *
 * `PadWidget` renders the spaces (or dashes) themselves rather than a width in
 * `ch`: a widget with a border-box width has to be measured, and the whole point
 * of a fixed-pitch line is that the browser already knows how wide `n`
 * characters are.
 */
class PadWidget extends WidgetType {
  constructor(
    readonly count: number,
    readonly fill: string,
  ) {
    super();
  }

  eq(other: PadWidget): boolean {
    return other.count === this.count && other.fill === this.fill;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-live-pad';
    span.textContent = this.fill.repeat(this.count);
    return span;
  }
}

/**
 * One column's worth of one row: the run of text between two `|`, and where
 * padding for it goes.
 *
 * `pad` is separate from `to` for the delimiter row alone, where the fill has to
 * land after the last dash rather than at the end -- appending to `:--:` gives
 * `:--:---`, which silently turns a centred column into a left-aligned one.
 */
interface Segment {
  from: number;
  to: number;
  pad: number;
  fill: string;
}

/** A run of fill characters to insert at `pos`. */
interface Pad {
  pos: number;
  count: number;
  fill: string;
}

/**
 * Drops the empty segments a leading or trailing `|` produces, and only those.
 *
 * GFM makes the outer pipes optional (`a | b` is a valid row), so the text
 * before the first `|` is a column when there is no leading pipe and nothing
 * when there is. An *interior* empty segment -- the middle of `|a||b|` -- is a
 * real empty cell and stays.
 */
function trimEdges(segments: Segment[], from: number, to: number): Segment[] {
  const out = segments.slice();
  if (out.length > 0 && out[0]!.from === out[0]!.to && out[0]!.from === from) out.shift();
  const last = out.at(-1);
  if (out.length > 0 && last!.from === last!.to && last!.to === to) out.pop();
  return out;
}

/** A header or body row: its `TableDelimiter` children are the column edges. */
function cellRowSegments(row: SyntaxNode): Segment[] {
  const cuts: { from: number; to: number }[] = [];
  for (let child = row.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === 'TableDelimiter') cuts.push({ from: child.from, to: child.to });
  }

  const segments: Segment[] = [];
  let start = row.from;
  for (const cut of cuts) {
    segments.push({ from: start, to: cut.from, pad: cut.from, fill: ' ' });
    start = cut.to;
  }
  segments.push({ from: start, to: row.to, pad: row.to, fill: ' ' });
  return trimEdges(segments, row.from, row.to);
}

/**
 * The `|---|:--:|` row, which is **one flat `TableDelimiter` node with no
 * `TableCell` children** -- checked against the app's own grammar, not assumed.
 * So it is split by hand, on the same rule as a cell row.
 *
 * Filled with `-` rather than spaces: a delimiter row padded with blanks is
 * aligned but looks broken, and lengthening the dashes is what a person doing
 * this by hand would do. The fill goes after the last dash so a trailing `:`
 * stays where it belongs.
 */
function delimiterRowSegments(state: EditorState, node: SyntaxNode): Segment[] {
  const text = state.doc.sliceString(node.from, node.to);
  const segments: Segment[] = [];

  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i !== text.length && text[i] !== '|') continue;
    const slice = text.slice(start, i);
    const lastDash = slice.lastIndexOf('-');
    segments.push({
      from: node.from + start,
      to: node.from + i,
      pad: node.from + start + (lastDash === -1 ? slice.length : lastDash + 1),
      fill: '-',
    });
    start = i + 1;
  }
  return trimEdges(segments, node.from, node.to);
}

/**
 * Every column of a table padded to the width of its widest cell.
 *
 * **Columns are measured between delimiters, not from `TableCell` nodes.** An
 * empty cell (`| |`) produces no `TableCell` at all, so measuring cells would
 * drop a column and misalign every row after it. The gap between two `|` always
 * exists.
 *
 * The delimiter row is measured along with the rest rather than skipped: a
 * column declared as `|:--------:|` is wider than its contents, and leaving it
 * out of the maximum would make that one row overhang.
 */
function alignTable(state: EditorState, table: SyntaxNode, out: Pad[]): void {
  const rows: Segment[][] = [];
  for (let child = table.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === 'TableHeader' || child.name === 'TableRow') {
      rows.push(cellRowSegments(child));
    } else if (child.name === 'TableDelimiter') {
      rows.push(delimiterRowSegments(state, child));
    }
  }

  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((segment, column) => {
      widths[column] = Math.max(widths[column] ?? 0, segment.to - segment.from);
    });
  }

  for (const row of rows) {
    row.forEach((segment, column) => {
      const count = widths[column]! - (segment.to - segment.from);
      if (count > 0) out.push({ pos: segment.pad, count, fill: segment.fill });
    });
  }
}

export function tableAlignDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  const pads: Pad[] = [];
  const seen = new Set<number>();

  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'Table') return;
        // **The one walk in this file that is not clipped to the viewport.**
        // A column width measured from the visible rows alone would change as
        // the table scrolled past the edge, and the columns would visibly
        // shuffle. The cost is bounded by the table rather than the document;
        // K.4 is where that got measured.
        if (seen.has(node.from)) return;
        seen.add(node.from);
        alignTable(state, node.node, pads);
      },
    });
  }

  // One pad per segment and segments never share an end position, so sorting is
  // enough -- there is nothing to deduplicate beyond the whole-table guard above.
  pads.sort((a, b) => a.pos - b.pos);
  const builder = new RangeSetBuilder<Decoration>();
  for (const pad of pads) {
    builder.add(
      pad.pos,
      pad.pos,
      // `side: 1` so the padding sits after anything else at this point, which
      // for a cell end means between the text and the `|`.
      Decoration.widget({ widget: new PadWidget(pad.count, pad.fill), side: 1 }),
    );
  }
  return builder.finish();
}

const tableAlign = ViewPlugin.fromClass(
  class implements PluginValue {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = tableAlignDecorations(view.state, view.visibleRanges);
    }

    update(update: ViewUpdate): void {
      // No `selectionSet`, like `monoBlocks` and unlike the other two: padding
      // hides nothing, so there is nothing for the caret to reveal.
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = tableAlignDecorations(update.view.state, update.view.visibleRanges);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/**
 * The rule reading view draws under h1 and h2 (`preview.css`, "only the top two
 * levels get a rule, which is what makes it read as a section break"), and the
 * line decoration that lets a Setext heading finally render like one.
 *
 * **These two belong together, and that is why Setext works now when K.2 gave
 * up on it.** The objection then was that hiding `=====` leaves an empty line
 * where it used to be. It does -- but an h1 with a rule under it is *exactly*
 * what `Title` over `=====` was drawing in ASCII, so the underline is not
 * deleted so much as promoted: the characters go, and the border that replaces
 * them lands in the same place.
 *
 * `display: none` on the whole line, rather than a `replace` decoration over
 * the characters. A replacement spanning the newline is what would truly
 * collapse the two lines, and CodeMirror forbids exactly that from a
 * `ViewPlugin` -- decorations that replace line breaks have to come from a
 * state field, which cannot see the viewport and so would walk the whole
 * document on every keystroke. Hiding the line sidesteps the restriction and
 * keeps the walk viewport-limited.
 */
const headingLine = Decoration.line({ class: 'cm-live-heading' });
// Two class names on one decoration rather than two decorations at one
// position: `RangeSetBuilder` takes a single value per point, and stacking
// line decorations to combine their classes is more machinery than a space.
const headingRuleLine = Decoration.line({ class: 'cm-live-heading cm-live-heading-rule' });
const setextHiddenLine = Decoration.line({ class: 'cm-live-setext-hidden' });

/** The levels reading view draws a rule under (`preview.css`: "only the top two"). */
const RULED_LEVELS = new Set(['1', '2']);

export function headingLineDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  const spans: { pos: number; decoration: Decoration }[] = [];

  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const setext = node.name.startsWith('SetextHeading');
        const atx = node.name.startsWith('ATXHeading');
        if (!setext && !atx) return;
        const level = node.name.slice(-1);

        // **Every heading level gets the tighter leading, only h1 and h2 get
        // the rule.** Reading view sets `line-height: 1.25` on all six; the
        // editor's own 1.6 left a visible gap between a heading and the rule
        // under it, which is what made the two views disagree even once the
        // font and the scale matched.
        //
        // The decoration sits on the heading's *first* line either way, which
        // for a Setext heading is the text rather than the underline. Drawn
        // whether or not the caret is here: it is a rendering, not a marker,
        // and flickering a section break on and off as the caret passed would
        // be worse than either state.
        spans.push({
          pos: state.doc.lineAt(node.from).from,
          decoration: RULED_LEVELS.has(level) ? headingRuleLine : headingLine,
        });

        if (!setext) return;
        const mark = node.node.getChild('HeaderMark');
        if (mark === null) return;
        // Revealed from either of the heading's two lines, like any other
        // marker -- otherwise the `=====` would be unreachable to edit.
        if (revealedAt(state, node.from, node.to)) return;
        spans.push({ pos: state.doc.lineAt(mark.from).from, decoration: setextHiddenLine });
      },
    });
  }

  spans.sort((a, b) => a.pos - b.pos);
  const builder = new RangeSetBuilder<Decoration>();
  for (const span of spans) builder.add(span.pos, span.pos, span.decoration);
  return builder.finish();
}

const headingLines = ViewPlugin.fromClass(
  class implements PluginValue {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = headingLineDecorations(view.state, view.visibleRanges);
    }

    update(update: ViewUpdate): void {
      // `selectionSet` here where `monoBlocks` does not need it: the Setext
      // underline is revealed by the caret, so this set depends on where it is.
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = headingLineDecorations(update.view.state, update.view.visibleRanges);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/**
 * **Live mode adopts the reading view's typography**, which is the point of the
 * mode: you are editing something that already looks like the finished
 * document. Source and split modes are untouched -- this lives in the
 * compartment that live preview is switched on with.
 *
 * The rule is copied from `preview.css`, not invented: line 46 sets
 * `--font-preview` on the pane and line 163 puts `code` and `pre` back to
 * `--font-editor` at `0.9em`. Reading view has always been proportional prose
 * with fixed-pitch code, so matching it is a question of applying the same two
 * rules rather than choosing a new look.
 *
 * **`font-size` is deliberately never forced onto descendants.** Heading sizes
 * are `em` multiples in `highlight.ts`; a flat pixel size on `.cm-content *`
 * flattens the whole heading scale, which is exactly the bug the owner spotted
 * in the mock-up this was chosen from.
 */
const liveTypography: Extension = [
  monoBlocks,
  tableAlign,
  headingLines,
  EditorView.theme({
    '.cm-content': {
      fontFamily: 'var(--font-preview)',
      fontSize: 'var(--size-preview)',
    },
    '.cm-line.cm-live-mono': {
      fontFamily: 'var(--font-editor)',
      fontSize: 'var(--size-editor)',
    },
    // `preview.css` gives every heading `line-height: 1.25`. Without it the
    // editor's 1.6 leaves leading below the text, and the rule below measured
    // 11px from the heading against reading view's 6px.
    '.cm-line.cm-live-heading': {
      lineHeight: '1.25',
    },
    // The same 6px gap and 1px rule `preview.css` puts under h1 and h2.
    //
    // **Drawn as a pseudo-element, not as `border-bottom` on the line.** A
    // `.cm-line` spans the full width of the content and carries the editor's
    // horizontal padding itself (`editor/theme.ts`: `padding: 0
    // var(--pad-editor)`), so a border on it runs edge to edge, past the text
    // on both sides -- reported as exactly that. Reading view's rule is inset
    // to its text, because there the padding is on the pane and the `h1` is a
    // block inside it. Insetting by the same token is what makes the two
    // agree, rather than a number chosen to look close.
    '.cm-line.cm-live-heading-rule': {
      position: 'relative',
      paddingBottom: '6px',
    },
    '.cm-line.cm-live-heading-rule::after': {
      content: '""',
      position: 'absolute',
      left: 'var(--pad-editor)',
      right: 'var(--pad-editor)',
      bottom: '0',
      borderBottom: '1px solid var(--border)',
    },
    '.cm-line.cm-live-setext-hidden': {
      display: 'none',
    },
    // **`pre`, not inherited.** With word wrap on, `.cm-line` is `pre-wrap`,
    // which drops a run of spaces that lands at a wrap point -- and column
    // padding lands at the end of a cell, which is exactly where a long table
    // row wraps. The columns came apart only on wrapped rows, which is the kind
    // of thing that looks like a measurement bug.
    '.cm-live-pad': {
      whiteSpace: 'pre',
    },
    // An inline thumbnail (§7.1). `inline-block` and `vertical-align: top` so
    // the line box grows to the picture instead of the picture hanging off the
    // text baseline.
    '.cm-live-image': {
      display: 'inline-block',
      maxWidth: '100%',
      verticalAlign: 'top',
    },
    // **A thumbnail, not the full-size image**, which is where this parts
    // company with the reading view (`preview.css` caps width only). A picture
    // taller than the editor would push the rest of the document off the screen
    // while you are trying to write it; reading view has no cursor to keep in
    // sight and so needs no cap.
    '.cm-live-image img': {
      display: 'block',
      maxWidth: '100%',
      maxHeight: '320px',
      borderRadius: 'var(--radius)',
    },
  }),
  // A second `HighlightStyle` rather than an edit to the shared one: these
  // sizes belong to live mode. `highlight.ts` keeps its own scale for source
  // and split, where the editor is a text editor rather than a page.
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: tags.monospace, fontSize: '0.9em' },
      // **The heading scale, copied from `preview.css` line for line.**
      // Matching the typeface was not enough: `highlight.ts` steps down
      // 1.6/1.42/1.28/1.17/1.08/1.0 and the preview steps down
      // 1.8/1.45/1.2/1.1/1.05/1.0, so live mode's h1 came out at 24px against
      // reading view's 27px -- visibly smaller, reported as exactly that.
      // Two scales for one document is the bug; live mode uses the reading
      // one because that is the view it is meant to resemble.
      { tag: tags.heading1, fontSize: '1.8em' },
      { tag: tags.heading2, fontSize: '1.45em' },
      { tag: tags.heading3, fontSize: '1.2em' },
      { tag: tags.heading4, fontSize: '1.1em' },
      { tag: tags.heading5, fontSize: '1.05em' },
      { tag: tags.heading6, fontSize: '1em' },
    ]),
  ),
];

export const hideInlineMarks = ViewPlugin.fromClass(
  class implements PluginValue {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = inlineMarkDecorations(view.state, view.visibleRanges);
    }

    update(update: ViewUpdate): void {
      // `selectionSet` is the clause `blockquote.ts` does not have and this
      // cannot do without: the whole feature is that moving the caret changes
      // what is drawn.
      //
      // The tree comparison is the one that only shows up on a big file.
      // Lezer parses large documents incrementally over several idle
      // callbacks, so the first render of a 5,000-line file sees a tree that
      // stops partway down; without this, everything below that point stays
      // unhidden until something else happens to trigger a rebuild.
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = inlineMarkDecorations(update.view.state, update.view.visibleRanges);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

/**
 * What the compartment holds when live preview is on: the markers hide
 * themselves, and the editor takes the reading view's typography.
 *
 * One exported extension rather than two wired separately, so there is no
 * arrangement in which a document is in live mode with only half of it
 * applied.
 */
export const livePreview: Extension = [hideInlineMarks, liveTypography];
