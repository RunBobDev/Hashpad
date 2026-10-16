// @vitest-environment jsdom
/**
 * The font dropdowns' lists (design §4.37). Go has already left out what text
 * cannot use and marked the monospaced fonts (platform/fonts_windows.go); what
 * is left here is folding weights into their family, dropping names the font
 * setting cannot carry, and splitting by pitch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allFonts, catalogFonts } from './fonts';

const proportional = (name: string): { name: string; monospaced: boolean } => ({
  name,
  monospaced: false,
});
const monospaced = (name: string): { name: string; monospaced: boolean } => ({
  name,
  monospaced: true,
});

describe('catalogFonts', () => {
  it('folds each weight and width into its family', () => {
    const catalog = catalogFonts([
      proportional('Segoe UI'),
      proportional('Segoe UI Light'),
      proportional('Segoe UI Emoji'),
      proportional('Segoe UI Variable Text'),
      proportional('Bahnschrift'),
      proportional('Bahnschrift Light'),
      proportional('Bahnschrift Light Condensed'),
      proportional('Arial'),
      proportional('Arial Black'),
      monospaced('Cascadia Code'),
      monospaced('Cascadia Code SemiBold'),
    ]);

    expect(catalog).toEqual({
      monospaced: ['Cascadia Code'],
      // Emoji and Variable Text are not weights: they stay.
      other: ['Arial', 'Bahnschrift', 'Segoe UI', 'Segoe UI Emoji', 'Segoe UI Variable Text'],
    });
  });

  /** A weight word alone is a family when nothing it could belong to is listed. */
  it('keeps a styled name whose family is not installed', () => {
    expect(catalogFonts([proportional('Bahnschrift Light')]).other).toEqual(['Bahnschrift Light']);
  });

  it('splits by pitch and sorts without regard to case', () => {
    const catalog = catalogFonts([
      monospaced('monofur'),
      monospaced('Consolas'),
      monospaced('Cascadia Code'),
      proportional('Arial'),
    ]);

    expect(catalog).toEqual({
      monospaced: ['Cascadia Code', 'Consolas', 'monofur'],
      other: ['Arial'],
    });
  });

  /** A name `fontStack` would refuse would be offered and then silently not apply. */
  it('leaves out names the font setting cannot carry', () => {
    expect(catalogFonts([proportional('Font & Co'), proportional('Arial')]).other).toEqual([
      'Arial',
    ]);
  });

  it('lists every font once for the preview, alphabetically', () => {
    const catalog = catalogFonts([monospaced('Consolas'), proportional('arial')]);

    expect(allFonts(catalog)).toEqual(['arial', 'Consolas']);
  });
});

describe('loadFontCatalog', () => {
  afterEach(() => {
    vi.doUnmock('../../wailsjs/go/app/App');
    vi.resetModules();
  });

  async function fresh(installed: () => Promise<unknown>): Promise<{
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
    const { load, calls } = await fresh(() =>
      Promise.resolve([monospaced('Consolas'), proportional('Arial')]),
    );

    expect(await load()).toEqual({ monospaced: ['Consolas'], other: ['Arial'] });
    await load();

    expect(calls()).toBe(1);
  });

  /** Linux until its checkpoint, or any failure: the dialog keeps text fields. */
  it('answers with no fonts when Go has no list, and asks again next time', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { load, calls } = await fresh(() => Promise.reject(new Error('not implemented')));

    expect(await load()).toEqual({ monospaced: [], other: [] });
    await load();

    expect(calls()).toBe(2);
    info.mockRestore();
  });
});
