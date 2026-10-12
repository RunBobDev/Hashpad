/**
 * The print view's page model (design §4.34), with no DOM: each page's
 * number, and the CSS the engine prints from.
 *
 * **One set of values for two renderers.** The final PDF's header and footer
 * are CSS page-margin boxes the engine draws; the preview's are a layer the
 * view draws over pdf.js's pages. Both read the margins, font, size and colour
 * from here, so they cannot drift apart in Hashpad's own code.
 */
export type Paper = 'a4' | 'letter';
export type Orientation = 'portrait' | 'landscape';

export interface PrintOptions {
  title: boolean;
  date: boolean;
  numbers: boolean;
  /** The page counted as 1. */
  countFrom: number;
  /** The first page that shows its number. */
  firstShown: number;
  paper: Paper;
  orientation: Orientation;
}

export const DEFAULT_PRINT_OPTIONS: PrintOptions = {
  title: true,
  date: true,
  numbers: true,
  countFrom: 1,
  firstShown: 1,
  paper: 'a4',
  orientation: 'portrait',
};

const PAPER_MM: Record<Paper, readonly [number, number]> = {
  a4: [210, 297],
  letter: [215.9, 279.4],
};

/** Fixed. The header and footer sit centred in the top and bottom ones. */
export const MARGIN_MM = { top: 20, bottom: 20, side: 16 } as const;

export const MARK_STYLE = {
  fontFamily: '"Segoe UI", sans-serif',
  fontSizePt: 9,
  color: '#777777',
} as const;

export interface PageMeta {
  date: string;
  title: string;
}

export interface PageMarks {
  date: string;
  title: string;
  number: string;
}

export function pageSizeMm(o: Pick<PrintOptions, 'paper' | 'orientation'>): {
  width: number;
  height: number;
} {
  const [w, h] = PAPER_MM[o.paper];
  return o.orientation === 'portrait' ? { width: w, height: h } : { width: h, height: w };
}

export function printableWidthMm(o: Pick<PrintOptions, 'paper' | 'orientation'>): number {
  return pageSizeMm(o).width - 2 * MARGIN_MM.side;
}

/** The number page `position` (1-based) shows, or '' for none. */
export function pageLabel(position: number, o: PrintOptions): string {
  if (!o.numbers || position < o.firstShown) return '';
  const label = position - o.countFrom + 1;
  return label >= 1 ? String(label) : '';
}

export function pageMarks(position: number, o: PrintOptions, meta: PageMeta): PageMarks {
  return {
    date: o.date ? meta.date : '',
    title: o.title ? meta.title : '',
    number: pageLabel(position, o),
  };
}

const MAX_TITLE = 80;

/**
 * One line, at most 80 characters. A margin box and the drawn layer would
 * wrap a long title differently; a title that never wraps cannot.
 */
export function shortTitle(title: string): string {
  const line = title.replace(/\s+/g, ' ').trim();
  return line.length <= MAX_TITLE ? line : `${line.slice(0, MAX_TITLE - 1)}…`;
}

/** The local date and time, without seconds. */
export function markDate(now: Date): string {
  return now.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

/** A CSS string literal that holds `text` exactly. */
export function cssString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\A ')}"`;
}

/**
 * The page rules the engine prints from: without marks for the preview PDF,
 * with them for the final one. The margins are the same either way, so the
 * two paginate identically.
 *
 * `background: #fff` because without it the margins print in the dark theme's
 * colour -- the engine paints its own background there. `size` is for Windows'
 * print dialog; the engine's PDF ignores it and takes paper from MakePrintPdf.
 *
 * The numbers are a `@counter-style` with one label per page, because the
 * page counter is the page's position and cannot be offset: the symbols map
 * position to label, an invisible one where no number shows.
 */
export function pageCss(
  o: PrintOptions,
  meta: PageMeta,
  pageCount: number,
  withMarks: boolean,
): string {
  const { width, height } = pageSizeMm(o);
  const rules = [
    `size: ${width}mm ${height}mm;`,
    `margin: ${MARGIN_MM.top}mm ${MARGIN_MM.side}mm ${MARGIN_MM.bottom}mm;`,
    'background: #fff;',
  ];
  let counter = '';
  if (withMarks) {
    const font = `font-family: ${MARK_STYLE.fontFamily}; font-size: ${MARK_STYLE.fontSizePt}pt; color: ${MARK_STYLE.color};`;
    if (o.date && meta.date) rules.push(`@top-left { content: ${cssString(meta.date)}; ${font} }`);
    if (o.title && meta.title) {
      rules.push(`@top-right { content: ${cssString(meta.title)}; ${font} }`);
    }
    if (o.numbers && pageCount > 0) {
      const symbols = Array.from({ length: pageCount }, (_, i) =>
        cssString(pageLabel(i + 1, o) || '​'),
      ).join(' ');
      counter = `@counter-style hashpad-pages { system: fixed 1; symbols: ${symbols}; }\n`;
      rules.push(`@bottom-right { content: counter(page, hashpad-pages); ${font} }`);
    }
  }
  return `${counter}@page {\n  ${rules.join('\n  ')}\n}\n`;
}
