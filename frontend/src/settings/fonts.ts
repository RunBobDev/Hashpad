/**
 * The settings dialog's font dropdowns (design §4.37): the installed families
 * Go reports, cut down to the ones this webview can draw.
 *
 * Windows' list (GDI's) is not the renderer's. It names every weight as a
 * family of its own, cuts names at 31 characters and includes raster fonts
 * WebView2 cannot use. So each name is folded into its family when it is only
 * a weight of one, and kept only if a canvas actually draws it -- a family the
 * renderer cannot find falls back to the generic named after it, so its every
 * width matches that generic's.
 */
import { InstalledFonts } from '../../wailsjs/go/app/App';
import { isFontName } from './typography';

export interface FontCatalog {
  /** Every glyph the same width: what the editor's list offers first. */
  readonly monospaced: readonly string[];
  readonly other: readonly string[];
}

export const NO_FONTS: FontCatalog = { monospaced: [], other: [] };

/** A text's width in a CSS font: a canvas in the app, a fake in tests. */
export type Measure = (font: string, text: string) => number;

/** The words GDI appends to a family to name one weight or width of it. */
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

/**
 * Narrow and wide glyphs, so no drawn font can match a generic's width by
 * chance -- and letters only: icon fonts (Segoe MDL2 Assets) have a space and
 * a few symbols, and with those in the sample they passed as fonts.
 */
const SAMPLE = 'mmmmmmmmmmlliWQ';
const GENERICS = ['monospace', 'serif'];

export function catalogFonts(names: readonly string[], measure: Measure): FontCatalog {
  const monospaced: string[] = [];
  const other: string[] = [];
  for (const name of candidates(names)) {
    if (!draws(name, measure)) continue;
    (isMonospaced(name, measure) ? monospaced : other).push(name);
  }
  return { monospaced, other };
}

/** Each family once, sorted, less the names the setting cannot carry and the weights. */
function candidates(names: readonly string[]): string[] {
  const families = new Set(names);
  return [...families]
    .sort(byName)
    .filter((name) => isFontName(name) && !isWeightOf(name, families));
}

/** Two generics, because a drawn font can share one's widths (Consolas is monospace's) but not both. */
function draws(name: string, measure: Measure): boolean {
  return GENERICS.some(
    (generic) =>
      measure(`40px '${name}', ${generic}`, SAMPLE) !== measure(`40px ${generic}`, SAMPLE),
  );
}

function isMonospaced(name: string, measure: Measure): boolean {
  const font = `40px '${name}', monospace`;
  return measure(font, 'iiiiiiiiii') === measure(font, 'WWWWWWWWWW');
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
 * The catalog, asked of Go once per session -- main.ts starts it when the app
 * is idle after start, so Settings normally finds it ready. No list (Linux
 * until its checkpoint, or any failure) is `NO_FONTS`, and is not kept: the
 * next dialog asks again.
 */
export function loadFontCatalog(measure?: Measure): Promise<FontCatalog> {
  // From a resolved promise, so a binding that throws outright (no Wails
  // runtime) lands in the catch below like any other failure.
  catalog ??= Promise.resolve()
    .then(() => InstalledFonts())
    .then(async (names) => {
      if (names.length === 0) return NO_FONTS;
      const using = measure ?? canvasMeasure();
      if (using === null) throw new Error('no canvas to measure fonts with');
      await warmUp(candidates(names), using);
      return catalogFonts(names, using);
    })
    .catch((error: unknown) => {
      catalog = null;
      console.info('hashpad: no font list; the font settings stay text fields', error);
      return NO_FONTS;
    });
  return catalog;
}

/**
 * A font's first measure loads it, synchronously, on the page's thread: 1.35 s
 * for the VM's 97 families cold, 25 ms warm (measured). So each is touched once
 * in idle time, as many per slice as the slice allows and at least one, and
 * the catalog is then built warm.
 */
async function warmUp(names: readonly string[], measure: Measure): Promise<void> {
  let next = 0;
  while (next < names.length) {
    const deadline = await idle();
    do {
      measure(`40px '${names[next]!}', serif`, SAMPLE);
      next++;
    } while (next < names.length && deadline.timeRemaining() > 0);
  }
}

/** The next idle period; a timeout keeps it moving while the page is never idle. */
function idle(): Promise<IdleDeadline> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(resolve, { timeout: 250 });
    } else {
      setTimeout(() => resolve({ didTimeout: true, timeRemaining: () => 0 }), 0);
    }
  });
}

function canvasMeasure(): Measure | null {
  const context = document.createElement('canvas').getContext('2d');
  if (context === null) return null;
  return (font, text) => {
    context.font = font;
    return context.measureText(text).width;
  };
}
