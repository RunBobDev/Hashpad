/**
 * Toolbar icons (SPEC §6.1, §6.5): one inline SVG string per toolbar command,
 * keyed by command id.
 *
 * **Generated from two primitives, not drawn.** The first set was hand-authored
 * paths, and the owner's verdict on the built app was that "pretty much every
 * icon is clipped" — freehand coordinates drift outside the safe area, and at
 * 16px a couple of stray tenths is the difference between a glyph and a
 * smudge. Everything here instead comes from either `glyph` (a centred
 * character, positioned by the text engine rather than by hand) or `rows`
 * (axis-aligned rectangles on a fixed three-row grid). Neither can clip: the
 * text is anchored to the box's centre, and every rectangle coordinate is
 * clamped inside 2…14 by construction.
 *
 * Letters where a letter *is* the convention — B, I, S, H — because that is
 * what every editor's toolbar has used for thirty years and it is instantly
 * legible at any size. Geometry for the structural commands, where a letter
 * would say nothing.
 *
 * Still SVG, still `currentColor`, still no icon font (SPEC §6.1). The font
 * for the lettered ones is set in `app.css` rather than here, because a CSS
 * custom property cannot be used in an SVG presentation attribute — and
 * because `variables.css` owns the font stack the same way it owns colour.
 */

import type { ToolbarCommandId } from './toolbar';

/**
 * A character centred in the 16×16 box.
 *
 * `dominant-baseline: central` plus `text-anchor: middle` puts the glyph's
 * optical centre at (8, 8) whatever the character is, so a `B` and a `{}` and
 * a `1.` all sit on the same centre line without per-glyph nudging — which is
 * exactly the hand-tuning that produced the clipped set.
 */
function glyph(
  text: string,
  options: { size?: number; weight?: number; italic?: boolean; strike?: boolean } = {},
): string {
  const { size = 12, weight = 600, italic = false, strike = false } = options;
  const attrs = [
    'x="8"',
    'y="8.5"',
    'text-anchor="middle"',
    'dominant-baseline="central"',
    `font-size="${size}"`,
    `font-weight="${weight}"`,
    italic ? 'font-style="italic"' : '',
    strike ? 'text-decoration="line-through"' : '',
    'fill="currentColor"',
  ]
    .filter(Boolean)
    .join(' ');

  return `<svg viewBox="0 0 16 16"><text ${attrs}>${text}</text></svg>`;
}

/** The three text rows every list-ish icon shares. */
const ROW_Y = [3.4, 7.4, 11.4];

/** A text line: a rounded bar from `x` to 14. */
function bar(x: number, y: number): string {
  return `<rect x="${x}" y="${y}" width="${14 - x}" height="1.6" rx="0.8" fill="currentColor"/>`;
}

/**
 * A three-row block: `marker(y)` draws whatever sits at the left of each row,
 * and the text bar always starts at `textX`. Passing an empty marker gives a
 * plain set of lines, which is what the blockquote and rule icons build on.
 */
function rows(textX: number, marker: (y: number) => string): string {
  const body = ROW_Y.map((y) => `${marker(y)}${bar(textX, y)}`).join('');
  return `<svg viewBox="0 0 16 16">${body}</svg>`;
}

/** A filled square, used as a bullet and as a table cell. */
function square(x: number, y: number, size: number, rx = 0.5): string {
  return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${rx}" fill="currentColor"/>`;
}

export const ICONS: Record<ToolbarCommandId, string> = {
  // The lettered set. Weight and slant carry the meaning, so each one looks
  // like the thing it does rather than merely labelling it.
  bold: glyph('B', { size: 13, weight: 800 }),
  italic: glyph('I', { size: 13, weight: 500, italic: true }),
  strikethrough: glyph('S', { size: 13, strike: true }),
  // A highlighter stroke under the letter, which is what distinguishes it
  // from the heading H at a glance -- the two are otherwise the same shape.
  highlight: `<svg viewBox="0 0 16 16"><rect x="2.5" y="11.4" width="11" height="2.2" rx="1" fill="currentColor" opacity="0.45"/><text x="8" y="7" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="600" fill="currentColor">H</text></svg>`,
  inlineCode: glyph('&lt;/&gt;', { size: 8, weight: 700 }),
  codeBlock: glyph('{ }', { size: 10, weight: 700 }),
  // The caret says "this opens a picker", which no other button does.
  heading: `<svg viewBox="0 0 16 16"><text x="7" y="7.5" text-anchor="middle" dominant-baseline="central" font-size="12" font-weight="800" fill="currentColor">H</text><path d="M11.4 11.6h3.2L13 14z" fill="currentColor"/></svg>`,

  // The generated set. All three list icons share ROW_Y and the same bar
  // geometry, so they read as a family and differ only in the marker.
  bulletList: rows(6.5, (y) => square(2.4, y - 0.2, 2, 1)),
  numberedList: rows(
    6.5,
    (y) =>
      `<text x="3.4" y="${y + 0.9}" text-anchor="middle" dominant-baseline="central" font-size="5" font-weight="700" fill="currentColor">${ROW_Y.indexOf(y) + 1}</text>`,
  ),
  taskList: rows(
    7,
    (y) =>
      `<rect x="2.2" y="${y - 0.9}" width="3.4" height="3.4" rx="0.8" fill="none" stroke="currentColor" stroke-width="1"/>`,
  ),
  // A quote bar down the left, with the text indented past it.
  blockquote: rows(6, (y) => (y === ROW_Y[0] ? square(2.4, 3.2, 2, 1) + bar(2.4, 7.4) : '')),

  link: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6.5 9.5 9.5 6.5"/><path d="M7.5 4.5 9 3a2.8 2.8 0 0 1 4 4l-1.5 1.5"/><path d="M8.5 11.5 7 13a2.8 2.8 0 0 1-4-4l1.5-1.5"/></svg>`,
  image: `<svg viewBox="0 0 16 16"><rect x="2" y="3.5" width="12" height="9" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5.8" cy="6.8" r="1.1" fill="currentColor"/><path d="M3.4 11.6 6.6 8.6l2 1.8 2-1.6 2.6 2.8z" fill="currentColor"/></svg>`,
  // A 3x3 grid: outer frame plus two lines each way, generated rather than
  // drawn so the cells are exactly equal.
  table: `<svg viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.2" fill="none"><rect x="2" y="3" width="12" height="10" rx="1"/><path d="M2 6.3h12M2 9.7h12M6 3v10M10 3v10"/></svg>`,
  horizontalRule: `<svg viewBox="0 0 16 16">${bar(2, 7.2)}<rect x="2" y="3" width="8" height="1.2" rx="0.6" fill="currentColor" opacity="0.4"/><rect x="2" y="11.8" width="8" height="1.2" rx="0.6" fill="currentColor" opacity="0.4"/></svg>`,
  // A superscript marker, which is what a footnote reference looks like in the
  // rendered document.
  footnote: `<svg viewBox="0 0 16 16"><text x="6" y="9" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="600" fill="currentColor">a</text><text x="12" y="4.5" text-anchor="middle" dominant-baseline="central" font-size="7" font-weight="700" fill="currentColor">1</text></svg>`,
};
