import { describe, expect, it } from 'vitest';
import {
  cssString,
  DEFAULT_PRINT_OPTIONS,
  markDate,
  pageCss,
  pageLabel,
  pageMarks,
  pageSizeMm,
  printableWidthMm,
  shortTitle,
  type PrintOptions,
} from './printpage';

const opts = (change: Partial<PrintOptions> = {}): PrintOptions => ({
  ...DEFAULT_PRINT_OPTIONS,
  ...change,
});
const META = { date: '12/10/2026, 14:03', title: 'Notes' };

describe('pageLabel', () => {
  it('numbers every page from 1 by default', () => {
    expect([1, 2, 3].map((p) => pageLabel(p, opts()))).toEqual(['1', '2', '3']);
  });

  /** "Start counting on page 2": page 2 is number 1 (confirmed by the owner). */
  it('counts from the chosen page', () => {
    expect([1, 2, 3].map((p) => pageLabel(p, opts({ countFrom: 2 })))).toEqual(['', '1', '2']);
  });

  it('shows nothing before the first numbered page, and counts through it', () => {
    const o = opts({ countFrom: 2, firstShown: 3 });
    expect([1, 2, 3, 4].map((p) => pageLabel(p, o))).toEqual(['', '', '2', '3']);
  });

  it('shows nothing when page numbers are off', () => {
    expect(pageLabel(5, opts({ numbers: false }))).toBe('');
  });
});

describe('pageMarks', () => {
  it('carries each part only while its switch is on', () => {
    expect(pageMarks(2, opts(), META)).toEqual({ date: META.date, title: 'Notes', number: '2' });
    expect(pageMarks(2, opts({ title: false, date: false }), META)).toEqual({
      date: '',
      title: '',
      number: '2',
    });
  });
});

describe('paper', () => {
  it('turns landscape sideways', () => {
    expect(pageSizeMm(opts())).toEqual({ width: 210, height: 297 });
    expect(pageSizeMm(opts({ paper: 'letter', orientation: 'landscape' }))).toEqual({
      width: 279.4,
      height: 215.9,
    });
  });

  it('prints inside 16 mm a side', () => {
    expect(printableWidthMm(opts())).toBe(178);
  });
});

describe('cssString', () => {
  /** A title comes from the document's first heading: anything may be in it. */
  it('quotes quotes, backslashes and line breaks', () => {
    expect(cssString('a "b" \\ c\nd')).toBe('"a \\"b\\" \\\\ c\\A d"');
  });
});

describe('shortTitle', () => {
  it('keeps one line, and a long title to 80 characters', () => {
    expect(shortTitle('  Two\n lines ')).toBe('Two lines');
    const long = shortTitle('x'.repeat(200));
    expect(long).toHaveLength(80);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('markDate', () => {
  it('has no seconds', () => {
    expect(markDate(new Date(2026, 9, 12, 14, 3, 59))).not.toMatch(/59/);
  });
});

describe('pageCss', () => {
  it('sets paper, margins and a white page, with no marks for the preview', () => {
    const css = pageCss(opts(), META, 10, false);
    expect(css).toContain('size: 210mm 297mm;');
    expect(css).toContain('margin: 20mm 16mm 20mm;');
    expect(css).toContain('background: #fff;');
    expect(css).not.toMatch(/@top-|@bottom-|counter-style/);
  });

  it('puts date top left, title top right and the number bottom right', () => {
    const css = pageCss(opts(), META, 3, true);
    expect(css).toMatch(/@top-left \{ content: "12\/10\/2026, 14:03";/);
    expect(css).toMatch(/@top-right \{ content: "Notes";/);
    expect(css).toMatch(/@bottom-right \{ content: counter\(page, hashpad-pages\);/);
  });

  it('labels exactly as many pages as the document has', () => {
    const css = pageCss(opts({ countFrom: 2 }), META, 1032, true);
    const symbols = /symbols: (.*);/.exec(css)![1]!.match(/"[^"]*"/g)!;
    expect(symbols).toHaveLength(1032);
    expect(symbols[0]).toBe('"​"');
    expect(symbols[1031]).toBe('"1031"');
  });

  it('leaves out each part that is switched off', () => {
    const css = pageCss(opts({ title: false, date: false, numbers: false }), META, 3, true);
    expect(css).not.toMatch(/@top-|@bottom-|counter-style/);
  });
});
