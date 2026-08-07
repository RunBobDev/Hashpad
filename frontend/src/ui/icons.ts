/**
 * Hand-drawn toolbar icons (SPEC §6.1, §6.5). One SVG string per toolbar
 * command, keyed by command id. Every icon shares `viewBox="0 0 16 16"` and
 * `currentColor` (fill or stroke, never a literal colour, per variables.css's
 * "colours live in one place" rule) and carries no `width`/`height` — CSS
 * (`.toolbar__button svg`) sizes them, so a single rule controls every icon at
 * once.
 *
 * These are markup, not glyphs: no emoji, no icon font, no Unicode symbol
 * standing in for a drawing. SPEC §6.1's mock uses placeholders like `❝ 🔗 🖼`
 * to describe *what* to draw, not what to ship.
 */
import type { ToolbarCommandId } from './toolbar';

export const ICONS: Record<ToolbarCommandId, string> = {
  bold: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 3h4.2a2.8 2.8 0 0 1 1.6 5.1A3 3 0 0 1 8.4 13H4V3zm2 2v3h2.1a1.5 1.5 0 0 0 0-3H6zm0 5v3h2.4a1.5 1.5 0 0 0 0-3H6z"/></svg>',

  italic:
    '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6 3h5v1.6H9.4l-2 7.8H9V14H4v-1.6h1.6l2-7.8H6V3z"/></svg>',

  // An S-shaped stroke crossed by a flat strike line -- the line is what
  // distinguishes this from a plain "S" and reads as "strike this out".
  strikethrough:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5 5.3c0-1.4 1.3-2.5 3-2.5s2.8.8 3 1.9"/><path d="M6 12.7c1.7 0 3-.9 3-2.4 0-1-.7-1.6-1.7-1.9"/><line x1="2.5" y1="8" x2="13.5" y2="8"/></svg>',

  // A chisel-tip marker stroke over a short highlighted underline -- a
  // highlighter pen, not a generic edit pencil.
  highlight:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M10.5 2.5l3 3-6 6-3.5 1 1-3.5z"/><line x1="2" y1="13.5" x2="8" y2="13.5"/></svg>',

  // Angle brackets -- deliberately without the middle slash real "</>"
  // glyphs use, so it reads as its own mark rather than a smaller codeBlock.
  inlineCode:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4L2.5 8 6 12"/><path d="M10 4l3.5 4-3.5 4"/></svg>',

  // Curly braces, not angle brackets -- shares the "code" idea with
  // inlineCode above but is a visibly different bracket family, for a block
  // rather than an inline span.
  codeBlock:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5c-1.5 0-2 .7-2 2v2c0 .8-.4 1.3-1.3 1.5.9.2 1.3.7 1.3 1.5v2c0 1.3.5 2 2 2"/><path d="M10 2.5c1.5 0 2 .7 2 2v2c0 .8.4 1.3 1.3 1.5-.9.2-1.3.7-1.3 1.5v2c0 1.3-.5 2-2 2"/></svg>',

  // Block capital H plus a small caret -- the caret signals this button
  // opens a dropdown (Task 7), not a plain toggle.
  heading:
    '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 2.5h1.8v4.4h3.4V2.5h1.8v9h-1.8V8.5H4.3v3H2.5v-9z"/><path d="M10.8 11l1.4 1.4 1.4-1.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',

  bulletList:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="2.5" cy="3.5" r="1" fill="currentColor" stroke="none"/><line x1="6" y1="3.5" x2="13.5" y2="3.5"/><circle cx="2.5" cy="8" r="1" fill="currentColor" stroke="none"/><line x1="6" y1="8" x2="13.5" y2="8"/><circle cx="2.5" cy="12.5" r="1" fill="currentColor" stroke="none"/><line x1="6" y1="12.5" x2="13.5" y2="12.5"/></svg>',

  // Small "1 2 3" numerals beside each line, in place of bulletList's dots.
  numberedList:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2.3l1-.6v3.1"/><line x1="6" y1="3.5" x2="13.5" y2="3.5"/><path d="M1.6 6.6c0-.5.5-.9 1-.9s1 .4 1 .8c0 .5-.4.8-1 1.4h1.1"/><line x1="6" y1="8" x2="13.5" y2="8"/><path d="M1.6 10.6c0-.5.5-.8 1-.8s1 .3 1 .7c0 .3-.2.5-.5.6.3.1.5.3.5.7 0 .5-.5.8-1 .8s-1-.3-1-.7"/><line x1="6" y1="12.5" x2="13.5" y2="12.5"/></svg>',

  // Checkbox squares (one checked) beside each line, in place of
  // bulletList's dots and numberedList's digits.
  taskList:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2" width="4" height="4" rx="0.8"/><path d="M2.3 4l1 1 1.8-2"/><line x1="7.5" y1="4" x2="13.5" y2="4"/><rect x="1.5" y="9.5" width="4" height="4" rx="0.8"/><line x1="7.5" y1="11.5" x2="13.5" y2="11.5"/></svg>',

  // Two quotation-comma shapes, echoing the mock's "❝" without shipping it
  // as a literal glyph -- drawn as vector paths instead.
  blockquote:
    '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3 4.5c-1.1 0-2 .9-2 2v2.3c0 .7.6 1.3 1.3 1.3H4V6.8H2.6c.1-.7.6-1.1 1.4-1.2V4.5zM9.5 4.5c-1.1 0-2 .9-2 2v2.3c0 .7.6 1.3 1.3 1.3h1.7V6.8H9.1c.1-.7.6-1.1 1.4-1.2V4.5z"/></svg>',

  // Two hooked links joined by a diagonal -- a standard chain-link mark.
  link: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 9.5l3-3"/><path d="M6 4.5L7.4 3a2.5 2.5 0 0 1 3.6 3.6L9.5 8"/><path d="M10 11.5L8.6 13a2.5 2.5 0 0 1-3.6-3.6L6.5 8"/></svg>',

  // A picture frame with a sun dot and a mountain fold -- the classic
  // "image" pictogram, distinct from table's plain grid.
  image:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"><rect x="2" y="2.5" width="12" height="11" rx="1"/><circle cx="5.5" cy="6" r="1.2" fill="currentColor" stroke="none"/><path d="M2.5 11l3.3-3.3a1 1 0 0 1 1.4 0L9.5 10l1.3-1.3a1 1 0 0 1 1.4 0l1.3 1.3"/></svg>',

  table:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="2" y="2.5" width="12" height="11" rx="1"/><line x1="2" y1="6.5" x2="14" y2="6.5"/><line x1="2" y1="10.5" x2="14" y2="10.5"/><line x1="6.5" y1="2.5" x2="6.5" y2="13.5"/><line x1="10.5" y1="2.5" x2="10.5" y2="13.5"/></svg>',

  horizontalRule:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2.5" y1="8" x2="13.5" y2="8"/></svg>',

  // A baseline text stroke with a small superscript numeral -- a footnote
  // reference mark.
  footnote:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="11" x2="9" y2="11"/><path d="M11.3 3.2l1-.5v3.6"/><line x1="10.6" y1="6.3" x2="13" y2="6.3"/></svg>',
};
