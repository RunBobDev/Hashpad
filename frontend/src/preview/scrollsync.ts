/**
 * Mapping between a source line and a vertical offset in the rendered preview.
 *
 * Pure and DOM-free on purpose: the pane measures the elements, this decides
 * where to go. That split is what lets the interesting case -- rendered height
 * diverging from source height -- be tested without a layout engine, which
 * jsdom does not have. Nothing here imports from `@codemirror/*` either, so the
 * whole module runs under Vitest's default `node` environment.
 */
export interface AnchorOffset {
  /** 1-based source line. */
  line: number;
  /** How far below the top of the pane's scrollable content that line renders. */
  offset: number;
}

/**
 * The contract `interpolate` needs, made true by construction: both keys
 * ascend, and no line appears twice.
 *
 * Neither is a hypothetical. markdown-it stamps `data-source-line` on every
 * block token, so an outer block and the first block nested inside it carry the
 * *same* line -- a blockquote and its paragraph, a list and its first item.
 * `querySelectorAll` returns both. The first in document order is the outer
 * element, whose top is where that line actually begins, so first wins.
 *
 * The offsets are then clamped to be non-decreasing rather than trusted.
 * Sorting by line does not sort by offset: any element taken out of normal flow
 * -- floated, absolutely positioned -- reports a top that need not follow its
 * document order, and `lineForOffset` searches on offset. One anchor out of
 * order there makes the search return a value from the wrong side of the
 * document rather than clamp, which is a silently wrong jump instead of a
 * merely imprecise one.
 *
 * A line that is not a positive integer is dropped. The pane reads its lines out
 * of a `data-source-line` attribute, and DOMPurify keeps `data-*` attributes, so
 * a document containing raw HTML can put any string it likes there. `NaN` makes
 * the comparator below return `NaN` for every comparison it takes part in, which
 * leaves the sort's result up to the engine's implementation -- so this is
 * dropped here, next to the sort that depends on it, rather than at the call
 * site. `render.ts`'s `anchorsIn` guards the same way for the same reason.
 */
export function normalizeAnchors(anchors: readonly AnchorOffset[]): AnchorOffset[] {
  const byLine = new Map<number, number>();
  for (const { line, offset } of anchors) {
    // Finite and at least 1, not necessarily whole. The job here is rejecting
    // the `NaN` that `Number(element.dataset.sourceLine)` yields for a missing
    // or malformed attribute, and lines below the first -- not enforcing
    // integers. `pane.ts`'s endpoint anchors are deliberately fractional: the
    // editor's last reachable scroll position lands part-way through a line, and
    // rounding it to a whole one left the preview stopping short of its own
    // bottom by whatever that fraction was worth.
    if (!Number.isFinite(line) || line < 1) continue;
    if (!byLine.has(line)) byLine.set(line, offset);
  }

  const sorted = [...byLine.entries()]
    .sort(([a], [b]) => a - b)
    .map(([line, offset]) => ({ line, offset }));

  // Discard anchors whose offset runs ahead of anything later, keeping the
  // ascending subsequence. Sorting by line does not make the offsets ascend,
  // because the renderer is free to move a block somewhere else entirely --
  // markdown-it-footnote relocates every footnote *definition* to the bottom of
  // the output while it keeps its original source line. A document with a
  // footnote defined at line 47 therefore has an anchor claiming line 47 sits
  // at the very end of the pane.
  //
  // The previous version raised each offset to the running maximum instead, and
  // that turned one displaced anchor into a broken document: every line after
  // 47 was clamped to the footnote's offset, so a third of the way down the
  // preview jumped to the bottom and stayed there however far the editor
  // scrolled. Measured in the running app before this changed -- `to` hit the
  // last anchor's 4636 at line 49.5 of 158 and never moved again.
  //
  // Dropping the outlier rather than the lines after it is what the reverse pass
  // buys: a displaced anchor is compared against everything to its right, so it
  // is the one that loses. The lines it used to flatten keep their own
  // positions, and the footnote block simply has no anchor -- which is correct,
  // since there is no scroll position that puts it where its source line is.
  const kept: AnchorOffset[] = [];
  let floor = Infinity;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const anchor = sorted[i]!;
    if (anchor.offset >= floor) continue;
    kept.push(anchor);
    floor = anchor.offset;
  }
  return kept.reverse();
}

/**
 * Linear interpolation between two anchors, clamped at both ends. Assumes the
 * list came from `normalizeAnchors`.
 *
 * Only one of those clamps is a branch. The brief had a matching
 * `value >= from(last)` early return; it is not here because it cannot fail --
 * mutation-tested, and removing it left every test in the suite green. A value past the
 * last key never satisfies the scan's condition, so the loop runs out and its
 * exit *is* the upper clamp. Two ways to reach one answer, one of which no test
 * can hold to account, is worse than one.
 *
 * The brief's version also guarded the division against `span === 0`, for the tie
 * `normalizeAnchors` deliberately creates. That guard is unreachable and is not
 * here: the scan takes the *first* anchor whose key is at or past `value`, so
 * its predecessor's key is always strictly below `value` -- otherwise the
 * predecessor would have been taken instead, and the `value <= from(first)`
 * clamp above has already handled the one index that has no predecessor. Two
 * equal keys therefore never end up as the pair being divided between.
 * Confirmed by exhausting every 4-anchor key list over {0,1,2,3}, sorted or
 * not, against values on a half-step grid: 2816 cases, zero hits. Landing
 * exactly on a tie is fine and takes the earlier of the two lines.
 */
function interpolate(
  anchors: readonly AnchorOffset[],
  value: number,
  from: (a: AnchorOffset) => number,
  to: (a: AnchorOffset) => number,
): number {
  if (anchors.length === 0) return 0;
  const first = anchors[0]!;
  if (value <= from(first)) return to(first);

  for (let i = 1; i < anchors.length; i++) {
    const upper = anchors[i]!;
    if (from(upper) < value) continue;
    const lower = anchors[i - 1]!;
    const span = from(upper) - from(lower);
    return to(lower) + ((value - from(lower)) / span) * (to(upper) - to(lower));
  }
  // Past the last anchor, so clamp there. This is the upper clamp.
  return to(anchors[anchors.length - 1]!);
}

export function offsetForLine(anchors: readonly AnchorOffset[], line: number): number {
  return interpolate(
    anchors,
    line,
    (a) => a.line,
    (a) => a.offset,
  );
}

export function lineForOffset(anchors: readonly AnchorOffset[], offset: number): number {
  return interpolate(
    anchors,
    offset,
    (a) => a.offset,
    (a) => a.line,
  );
}

/** The scroller geometry `farEndHeight` needs, named so a test can supply it. */
export interface ScrollerGeometry {
  /** `getBoundingClientRect().top` of the editor's scroller. */
  rectTop: number;
  /** `EditorView.documentTop` -- the document origin's screen position. */
  documentTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

/**
 * The document-space height the editor will report once it is scrolled as far
 * as it goes.
 *
 * `pane.ts` needs this to place the anchor that pins "the editor's last scroll
 * position" to "the pane's last scroll position". It used to derive that from
 * `view.contentHeight`, which is CodeMirror's **estimate** for lines outside the
 * rendered viewport, while the live mapping uses the scroller's real geometry.
 * The two disagreed by about a line, so the anchor named a line the editor could
 * never reach -- and anything in that gap became unreachable in the preview. A
 * tall image at the end of a document put 2311px there.
 *
 * Everything below is measured, not estimated: `height` is linear in `scrollTop`
 * with slope 1, because `documentTop` moves with the scroll, so the value at the
 * far end is the current one plus whatever is left to scroll. The invariant that
 * makes this correct -- and that the tests below pin -- is that the answer does
 * not depend on where the editor currently happens to be.
 */
export function farEndHeight(geometry: ScrollerGeometry): number {
  const remaining = geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop;
  return geometry.rectTop - geometry.documentTop + remaining;
}
