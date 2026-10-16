// @vitest-environment jsdom
/**
 * The font dropdowns' lists (design §4.37).
 *
 * jsdom has no canvas, so every case hands `catalogFonts` a fake `measure` that
 * behaves the way the renderer does: a family it can draw has widths of its
 * own; one it cannot falls back to the generic after it, so every width matches
 * that generic's. Whether the real canvas behaves so is checked on the exe.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogFonts, type Measure } from './fonts';

/** What the fake renderer can draw, and whether each glyph is the same width. */
const DRAWN: Record<string, 'mono' | 'prop'> = {
  Arial: 'prop',
  'Arial Black': 'prop',
  Bahnschrift: 'prop',
  'Bahnschrift Light': 'prop',
  'Bahnschrift Light Condensed': 'prop',
  'Cascadia Code': 'mono',
  'Cascadia Code SemiBold': 'mono',
  Consolas: 'mono',
  'Font & Co': 'prop',
  monofur: 'mono',
  'Segoe UI': 'prop',
  'Segoe UI Emoji': 'prop',
  'Segoe UI Light': 'prop',
  'Segoe UI Variable Text': 'prop',
};

/** Icon fonts: glyphs for the space and symbols, none for letters. */
const ICONS = new Set(['Segoe MDL2 Assets']);

/** Per character, as the renderer does: a glyph the family lacks comes from the generic after it. */
const fakeMeasure: Measure = (font, text) => {
  const named = /^40px '([^']+)', ([\w-]+)$/.exec(font);
  const generic = named ? named[2]! : font.replace('40px ', '');
  const family = named ? named[1]! : null;
  let width = 0;
  for (const char of text) {
    const own = family !== null && (family in DRAWN || (ICONS.has(family) && !/[a-z]/i.test(char)));
    const kind = own ? (DRAWN[family!] ?? 'mono') : generic === 'monospace' ? 'mono' : 'prop';
    const glyph = kind === 'mono' ? 10 : char === 'i' ? 4 : char === 'W' ? 14 : 8;
    // A drawn family is never exactly a generic's size.
    width += own ? glyph * (1 + family!.length / 100) : glyph;
  }
  return width;
};

describe('catalogFonts', () => {
  it('keeps only the families the renderer can draw', () => {
    // GDI lists raster fonts and names it cut at 31 characters; neither draws.
    const catalog = catalogFonts(
      ['Arial', 'Fixedsys', 'Segoe UI Variable Display Semib'],
      fakeMeasure,
    );

    expect(catalog).toEqual({ monospaced: [], other: ['Arial'] });
  });

  it('folds each weight and width into its family', () => {
    const catalog = catalogFonts(
      [
        'Segoe UI',
        'Segoe UI Light',
        'Segoe UI Emoji',
        'Segoe UI Variable Text',
        'Bahnschrift',
        'Bahnschrift Light',
        'Bahnschrift Light Condensed',
        'Arial',
        'Arial Black',
        'Cascadia Code',
        'Cascadia Code SemiBold',
      ],
      fakeMeasure,
    );

    expect(catalog).toEqual({
      monospaced: ['Cascadia Code'],
      // Emoji and Variable Text are not weights: they stay.
      other: ['Arial', 'Bahnschrift', 'Segoe UI', 'Segoe UI Emoji', 'Segoe UI Variable Text'],
    });
  });

  /** A weight word alone is a family when nothing it could belong to is listed. */
  it('keeps a styled name whose family is not installed', () => {
    expect(catalogFonts(['Bahnschrift Light'], fakeMeasure).other).toEqual(['Bahnschrift Light']);
  });

  it('splits by pitch and sorts without regard to case', () => {
    const catalog = catalogFonts(['monofur', 'Consolas', 'Cascadia Code', 'Arial'], fakeMeasure);

    expect(catalog).toEqual({
      monospaced: ['Cascadia Code', 'Consolas', 'monofur'],
      other: ['Arial'],
    });
  });

  /**
   * Segoe MDL2 Assets and friends have a space and a few symbols but no
   * letters; measured with a space in the sample they passed as monospaced
   * fonts on the VM.
   */
  it('leaves out icon fonts, which have no letters', () => {
    expect(catalogFonts(['Segoe MDL2 Assets', 'Arial'], fakeMeasure)).toEqual({
      monospaced: [],
      other: ['Arial'],
    });
  });

  /** A name `fontStack` would refuse would be offered and then silently not apply. */
  it('leaves out names the font setting cannot carry', () => {
    expect(catalogFonts(['Font & Co', 'Arial'], fakeMeasure).other).toEqual(['Arial']);
  });
});

describe('loadFontCatalog', () => {
  afterEach(() => {
    vi.doUnmock('../../wailsjs/go/app/App');
    vi.resetModules();
  });

  async function fresh(installed: () => Promise<string[]>): Promise<{
    load: typeof import('./fonts').loadFontCatalog;
    calls: () => number;
  }> {
    const InstalledFonts = vi.fn(installed);
    vi.resetModules();
    vi.doMock('../../wailsjs/go/app/App', () => ({ InstalledFonts }));
    const { loadFontCatalog } = await import('./fonts');
    return { load: loadFontCatalog, calls: () => InstalledFonts.mock.calls.length };
  }

  it('asks Go once per session', async () => {
    const { load, calls } = await fresh(() => Promise.resolve(['Consolas', 'Arial']));

    expect(await load(fakeMeasure)).toEqual({ monospaced: ['Consolas'], other: ['Arial'] });
    await load(fakeMeasure);

    expect(calls()).toBe(1);
  });

  /**
   * A font's first measure loads it on the page's thread -- 1.35 s for the
   * VM's fonts, cold -- so they are loaded in idle slices: here, slices with
   * no time left, so one font each.
   */
  it('loads each font in its own idle slice when the slices are short', async () => {
    const slices: number[] = [];
    vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
      slices.push(slices.length);
      setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 0 }), 0);
      return slices.length;
    });
    const measured: string[] = [];
    const spy: Measure = (font, text) => {
      measured.push(font);
      return fakeMeasure(font, text);
    };
    const { load } = await fresh(() =>
      Promise.resolve(['Arial', 'Consolas', 'Segoe UI', 'Segoe UI Light']),
    );

    expect(await load(spy)).toEqual({ monospaced: ['Consolas'], other: ['Arial', 'Segoe UI'] });

    // Three families, three slices; the weight is never loaded at all.
    expect(slices).toHaveLength(3);
    expect(measured.some((font) => font.includes('Segoe UI Light'))).toBe(false);
    vi.unstubAllGlobals();
  });

  /** Linux until its checkpoint, or any failure: the dialog keeps text fields. */
  it('answers with no fonts when Go has no list, and asks again next time', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { load, calls } = await fresh(() => Promise.reject(new Error('not implemented')));

    expect(await load(fakeMeasure)).toEqual({ monospaced: [], other: [] });
    await load(fakeMeasure);

    expect(calls()).toBe(2);
    info.mockRestore();
  });
});
