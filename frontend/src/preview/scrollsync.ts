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
    if (!Number.isInteger(line) || line < 1) continue;
    if (!byLine.has(line)) byLine.set(line, offset);
  }

  let ceiling = -Infinity;
  return [...byLine.entries()]
    .sort(([a], [b]) => a - b)
    .map(([line, offset]) => {
      ceiling = Math.max(ceiling, offset);
      return { line, offset: ceiling };
    });
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
