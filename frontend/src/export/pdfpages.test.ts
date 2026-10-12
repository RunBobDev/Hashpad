/**
 * The arithmetic that decides which pages get a canvas. Pure, so it runs
 * without a layout engine; harness/pdfpages.html shows it against real pdf.js.
 * Page n (1-based) sits at top = gap + (n - 1) * (pageHeight + gap).
 */
import { describe, expect, it } from 'vitest';
import { pageAt, visiblePages } from './pdfpages';

const H = 100; // page height
const G = 16; // gap

describe('visiblePages', () => {
  it('finds the pages in a viewport at the top', () => {
    // Page 3 starts at 16 + 232 = 248, just inside a 250 px viewport.
    expect(visiblePages(0, 250, H, G, 10, 0)).toEqual({ first: 1, last: 3 });
  });

  it('drops a page once it has scrolled fully past', () => {
    // Page 1 ends at 116; at 117 it is gone.
    expect(visiblePages(117, 100, H, G, 10, 0).first).toBe(2);
    expect(visiblePages(115, 100, H, G, 10, 0).first).toBe(1);
  });

  it('adds overscan on both sides, within the document', () => {
    expect(visiblePages(0, 250, H, G, 10, 1)).toEqual({ first: 1, last: 4 });
    expect(visiblePages(9 * 116, 250, H, G, 10, 1)).toEqual({ first: 9, last: 10 });
  });

  it('is empty for an empty document', () => {
    expect(visiblePages(0, 500, H, G, 0)).toEqual({ first: 1, last: 0 });
  });

  it('scales: a thousand pages cost the same as ten', () => {
    const r = visiblePages(500 * 116, 400, H, G, 1000, 1);
    expect(r.last - r.first).toBeLessThan(8);
  });
});

describe('pageAt', () => {
  it('names the page under the top third of the viewport', () => {
    expect(pageAt(0, 300, H, G, 10)).toBe(1);
    // The line at 116 + 100 = 216 lies in page 2 (132..232).
    expect(pageAt(116, 300, H, G, 10)).toBe(2);
  });

  it('stays within the document', () => {
    expect(pageAt(1e6, 300, H, G, 10)).toBe(10);
    expect(pageAt(-50, 300, H, G, 10)).toBe(1);
  });
});
