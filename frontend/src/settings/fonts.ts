/**
 * The settings dialog's font dropdowns (design §4.37), from the installed
 * families Go reports.
 *
 * Go has already left out what text cannot use -- raster, symbol and icon
 * fonts, and names Windows cut short -- and marked the monospaced ones
 * (platform/fonts_windows.go). Windows still names every weight as a family of
 * its own, so here each one is folded into its family, and names the font
 * setting cannot carry are dropped.
 *
 * Nothing is measured in the page. A first version kept the fonts a canvas
 * could draw, which loaded every installed font into the renderer: 1.35 s cold
 * and 35 MB for the rest of the session (both measured).
 */
import { InstalledFonts } from '../../wailsjs/go/app/App';
import type { platform } from '../../wailsjs/go/models';
import { isFontName } from './typography';

export interface FontCatalog {
  /** Every glyph the same width: what the editor's list offers first. */
  readonly monospaced: readonly string[];
  readonly other: readonly string[];
}

export const NO_FONTS: FontCatalog = { monospaced: [], other: [] };

/** The words Windows appends to a family to name one weight or width of it. */
const STYLE_WORDS = new Set([
  'thin',
  'hairline',
  'extralight',
  'ultralight',
  'light',
  'semilight',
  'demilight',
  'book',
  'regular',
  'normal',
  'medium',
  'semibold',
  'demibold',
  'bold',
  'extrabold',
  'ultrabold',
  'heavy',
  'black',
  'extrablack',
  'condensed',
  'semicondensed',
  'extracondensed',
  'ultracondensed',
  'narrow',
  'expanded',
  'semiexpanded',
  'italic',
  'oblique',
]);

export function catalogFonts(fonts: readonly platform.Font[]): FontCatalog {
  const families = new Set(fonts.map((font) => font.name));
  const monospaced: string[] = [];
  const other: string[] = [];
  for (const font of [...fonts].sort((a, b) => byName(a.name, b.name))) {
    if (!isFontName(font.name) || isWeightOf(font.name, families)) continue;
    (font.monospaced ? monospaced : other).push(font.name);
  }
  return { monospaced, other };
}

/** "Segoe UI Light" when "Segoe UI" is listed; "Bahnschrift Light Condensed" when either shorter one is. */
function isWeightOf(name: string, families: ReadonlySet<string>): boolean {
  const words = name.split(' ');
  for (let end = words.length - 1; end > 0; end--) {
    if (!STYLE_WORDS.has(words[end]!.toLowerCase())) return false;
    if (families.has(words.slice(0, end).join(' '))) return true;
  }
  return false;
}

/** Both lists as one, alphabetical: the preview's dropdown. */
export function allFonts(catalog: FontCatalog): string[] {
  return [...catalog.monospaced, ...catalog.other].sort(byName);
}

function byName(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'base' });
}

let catalog: Promise<FontCatalog> | null = null;

/**
 * The catalog, asked of Go once per session (about 0.3 s, in Go). No list --
 * Linux until its checkpoint, or any failure -- is `NO_FONTS`, and is not
 * kept: the next dialog asks again.
 */
export function loadFontCatalog(): Promise<FontCatalog> {
  // From a resolved promise, so a binding that throws outright (no Wails
  // runtime) lands in the catch below like any other failure.
  catalog ??= Promise.resolve()
    .then(() => InstalledFonts())
    .then(catalogFonts)
    .catch((error: unknown) => {
      catalog = null;
      console.info('hashpad: no font list; the font settings stay text fields', error);
      return NO_FONTS;
    });
  return catalog;
}
