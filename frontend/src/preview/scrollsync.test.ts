/**
 * No environment docblock: this module is DOM-free, so it runs under the
 * default `node` environment (vite.config.ts). That is the point of the split
 * between this and pane.ts -- everything below is geometry that jsdom, having
 * no layout engine, could never produce for real.
 */
import { describe, expect, it } from 'vitest';
import {
  farEndHeight,
  lineForOffset,
  normalizeAnchors,
  offsetForLine,
  type AnchorOffset,
} from './scrollsync';

/**
 * Line 10 sits only 40px down despite being 60% of the way through the source:
 * a tall image occupies lines 5-9. This is the shape that makes proportional
 * mapping wrong and is why the sync is line-anchored (design §2.1).
 */
const DIVERGENT: AnchorOffset[] = [
  { line: 1, offset: 0 },
  { line: 5, offset: 40 },
  { line: 10, offset: 600 },
  { line: 16, offset: 640 },
];

describe('offsetForLine', () => {
  it('returns an anchor exactly when the line is one', () => {
    expect(offsetForLine(DIVERGENT, 5)).toBe(40);
  });

  it('interpolates between the bracketing anchors', () => {
    // Halfway from line 10 to line 16 is line 13 -> halfway from 600 to 640.
    expect(offsetForLine(DIVERGENT, 13)).toBeCloseTo(620, 5);
  });

  it('clamps below the first anchor', () => {
    expect(offsetForLine(DIVERGENT, 0)).toBe(0);
  });

  it('clamps above the last anchor', () => {
    expect(offsetForLine(DIVERGENT, 99)).toBe(640);
  });

  it('does not fall for the proportional answer', () => {
    // Proportional would put line 10 of 16 at 62.5% of 640 = 400px.
    expect(offsetForLine(DIVERGENT, 10)).toBe(600);
    expect(offsetForLine(DIVERGENT, 10)).not.toBeCloseTo(400, 0);
  });

  it('returns 0 for an empty anchor list rather than throwing', () => {
    expect(offsetForLine([], 5)).toBe(0);
  });
});

describe('lineForOffset', () => {
  it('inverts offsetForLine at the anchors', () => {
    for (const anchor of DIVERGENT) {
      expect(lineForOffset(DIVERGENT, anchor.offset)).toBe(anchor.line);
    }
  });

  it('interpolates between anchors', () => {
    expect(lineForOffset(DIVERGENT, 620)).toBeCloseTo(13, 5);
  });

  it('clamps below the first anchor', () => {
    expect(lineForOffset(DIVERGENT, -50)).toBe(1);
  });

  it('clamps above the last anchor', () => {
    expect(lineForOffset(DIVERGENT, 9999)).toBe(16);
  });

  /**
   * `normalizeAnchors` clamps offsets to be non-decreasing, which deliberately
   * produces ties, so a run of lines really can share one offset. Every value
   * in and around such a run must still come back finite -- see interpolate's
   * header for why no division by zero is reachable here.
   */
  it('answers finitely across a run of lines that share an offset', () => {
    const tied: AnchorOffset[] = [
      { line: 1, offset: 0 },
      { line: 4, offset: 100 },
      { line: 9, offset: 100 },
      { line: 12, offset: 300 },
    ];
    // Landing exactly on the tie takes the earlier of the two lines.
    expect(lineForOffset(tied, 100)).toBe(4);
    for (const offset of [99, 100, 101, 200]) {
      expect(Number.isFinite(lineForOffset(tied, offset))).toBe(true);
    }
  });
});

describe('normalizeAnchors', () => {
  /**
   * The routine case, not an edge one: markdown-it stamps the same line on a
   * blockquote and on the paragraph inside it, and the pane measures both.
   */
  it('keeps the first element measured for a repeated line', () => {
    expect(
      normalizeAnchors([
        { line: 1, offset: 0 },
        { line: 1, offset: 12 },
        { line: 3, offset: 60 },
      ]),
    ).toEqual([
      { line: 1, offset: 0 },
      { line: 3, offset: 60 },
    ]);
  });

  it('sorts by line', () => {
    expect(
      normalizeAnchors([
        { line: 7, offset: 90 },
        { line: 2, offset: 20 },
      ]),
    ).toEqual([
      { line: 2, offset: 20 },
      { line: 7, offset: 90 },
    ]);
  });

  /**
   * Without the clamp `lineForOffset` searches a list whose keys jump
   * backwards, and its "is this the first anchor at or past the value" scan
   * then answers from the wrong side of the document -- a confident jump to the
   * wrong place rather than an imprecise one.
   */
  /**
   * The shape that was actually breaking documents, rather than a synthetic one.
   *
   * markdown-it-footnote moves every footnote *definition* to the bottom of the
   * rendered output and keeps its original source line, so a footnote defined a
   * third of the way down produces an anchor claiming that line sits at the very
   * end of the pane. Confirmed against the real renderer: in the project's own
   * fixture exactly one anchor is out of DOM order, line 47, and it is the one
   * inside `.footnotes`.
   *
   * With the old clamp every line after 47 inherited that offset, so the preview
   * jumped to the bottom a third of the way down and stayed there however far
   * the editor scrolled -- traced in the running app as `to` reaching the last
   * anchor's 4636 at line 49.5 of 158 and never changing again.
   */
  it('survives a footnote definition rendered at the bottom', () => {
    const paneEnd = 4636;
    const normalized = normalizeAnchors([
      { line: 1, offset: 0 },
      { line: 20, offset: 800 },
      // The footnote definition: an early line, rendered last.
      { line: 47, offset: paneEnd },
      { line: 60, offset: 1500 },
      { line: 158, offset: 4300 },
    ]);

    expect(normalized.map((a) => a.line)).toEqual([1, 20, 60, 158]);
    // The lines after the footnote keep their own positions instead of being
    // flattened onto its offset, so the mapping still moves out here.
    expect(offsetForLine(normalized, 60)).toBe(1500);
    expect(offsetForLine(normalized, 100)).toBeGreaterThan(1500);
    expect(offsetForLine(normalized, 100)).toBeLessThan(4300);
  });

  it('drops an anchor whose offset runs ahead of a later one', () => {
    const normalized = normalizeAnchors([
      { line: 1, offset: 0 },
      { line: 2, offset: 500 },
      { line: 3, offset: 100 },
      { line: 4, offset: 900 },
    ]);
    // Line 2 is the outlier -- its offset runs past line 3's -- so line 2 is
    // what goes, and lines 3 and 4 keep the positions they actually have.
    //
    // The earlier version raised line 3 to 500 instead, which is the behaviour
    // that broke real documents: markdown-it-footnote relocates a footnote
    // *definition* to the bottom of the output while keeping its source line, so
    // one displaced anchor a third of the way down dragged every line after it
    // to the bottom of the pane. Clamping up propagates the outlier; dropping it
    // contains it.
    expect(normalized).toEqual([
      { line: 1, offset: 0 },
      { line: 3, offset: 100 },
      { line: 4, offset: 900 },
    ]);
    // Offsets ascend, so the search still terminates in order.
    expect(lineForOffset(normalized, 500)).toBeCloseTo(3.5, 5);
  });

  it('answers an empty list with an empty list', () => {
    expect(normalizeAnchors([])).toEqual([]);
  });

  /**
   * The pane reads its lines out of a `data-source-line` attribute and DOMPurify
   * keeps `data-*`, so a document with raw HTML in it can put any string there.
   * A `NaN` line would make the comparator return `NaN` for every comparison it
   * takes part in, leaving the order of the whole list up to the engine.
   */
  it('drops a line that is not a positive number', () => {
    expect(
      normalizeAnchors([
        { line: 1, offset: 0 },
        { line: Number.NaN, offset: 30 },
        { line: 0, offset: 40 },
        { line: -3, offset: 50 },
        { line: 4, offset: 90 },
      ]),
    ).toEqual([
      { line: 1, offset: 0 },
      { line: 4, offset: 90 },
    ]);
  });

  /**
   * A fractional line is **kept**, and that is deliberate rather than an
   * oversight in the filter above. `pane.ts` adds an endpoint anchor at the last
   * source position the editor can actually scroll to, which lands part-way
   * through a line; rounding it to a whole number left the preview stopping
   * short of its own bottom by whatever that fraction was worth. Nothing in a
   * `data-source-line` attribute is fractional, so this costs the real anchors
   * nothing.
   */
  it('keeps a fractional line, which the endpoint anchors rely on', () => {
    expect(
      normalizeAnchors([
        { line: 1, offset: 0 },
        { line: 2.5, offset: 60 },
        { line: 4, offset: 90 },
      ]),
    ).toEqual([
      { line: 1, offset: 0 },
      { line: 2.5, offset: 60 },
      { line: 4, offset: 90 },
    ]);
  });
});

/**
 * The far end of the editor's scroll range, in document coordinates.
 *
 * `pane.ts` needs it to pin "the editor's last scroll position" to "the pane's
 * last scroll position". It used to come from `view.contentHeight`, which is
 * CodeMirror's *estimate* for lines outside the rendered viewport, while the
 * live mapping uses the scroller's real geometry -- so the two disagreed by
 * about a line and the anchor named a line the editor could never reach.
 * Everything past that anchor is discarded, so whatever sat in the gap was
 * unreachable in the preview. Owner report: a tall image at the end of a
 * document left the pane 2311px short of its own bottom.
 *
 * Measured in `frontend/harness/scrollsync.html` -- jsdom reports every scroll
 * dimension as 0, so `endpoints` returns nothing there and the clamp cannot be
 * exercised in place. This is the arithmetic lifted out so it can be.
 */
describe('farEndHeight', () => {
  /** A scroller 3000px of content in a 800px window, sitting 100px down the page. */
  function geometryAt(scrollTop: number) {
    return {
      // Both move with the scroll, and by the same amount, which is why the
      // difference between them is the scroll position in document space.
      rectTop: 100,
      documentTop: 100 - scrollTop,
      scrollHeight: 3000,
      clientHeight: 800,
      scrollTop,
    };
  }

  /**
   * **The invariant the bug broke.** The far end of the range does not depend on
   * where the editor currently is, so every scroll position must give the same
   * answer -- and the old version's did not, because it mixed an estimate of the
   * total height with a live measurement of the position.
   */
  it('answers the same wherever the editor currently sits', () => {
    const answers = [0, 250, 1000, 2199, 2200].map((top) => farEndHeight(geometryAt(top)));

    expect(new Set(answers).size).toBe(1);
  });

  /**
   * And the answer is the position the editor actually reaches: at the last
   * scroll position, "the far end" and "where I am" are the same place. This is
   * the half that makes the anchor land on a reachable line.
   */
  it('agrees with the live measurement once the editor is at the end', () => {
    const max = 3000 - 800;
    const atEnd = geometryAt(max);

    expect(farEndHeight(atEnd)).toBe(atEnd.rectTop - atEnd.documentTop);
  });

  /** A document shorter than its window cannot scroll, so the far end is the top. */
  it('is the top of an unscrollable document', () => {
    expect(farEndHeight({ ...geometryAt(0), scrollHeight: 400, clientHeight: 800 })).toBe(-400);
  });
});
