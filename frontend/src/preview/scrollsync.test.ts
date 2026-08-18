/**
 * No environment docblock: this module is DOM-free, so it runs under the
 * default `node` environment (vite.config.ts). That is the point of the split
 * between this and pane.ts -- everything below is geometry that jsdom, having
 * no layout engine, could never produce for real.
 */
import { describe, expect, it } from 'vitest';
import { lineForOffset, normalizeAnchors, offsetForLine, type AnchorOffset } from './scrollsync';

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
  it('clamps an offset that goes backwards up to the one before it', () => {
    const normalized = normalizeAnchors([
      { line: 1, offset: 0 },
      { line: 2, offset: 500 },
      { line: 3, offset: 100 },
      { line: 4, offset: 900 },
    ]);
    expect(normalized).toEqual([
      { line: 1, offset: 0 },
      { line: 2, offset: 500 },
      { line: 3, offset: 500 },
      { line: 4, offset: 900 },
    ]);
    // The search now terminates in order: 300 is between anchors 1 and 2.
    expect(lineForOffset(normalized, 300)).toBeCloseTo(1.6, 5);
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
