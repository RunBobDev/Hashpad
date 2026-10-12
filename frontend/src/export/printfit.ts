/**
 * Display equations wider than the printed page, shrunk to fit it.
 *
 * An equation cannot wrap -- KaTeX lays it out as one row -- and paper has no
 * scrollbar: past the edge it is simply not printed. So each one is measured
 * in the hidden copy at the paper's printable width, before the engine
 * paginates it, and shrunk by exactly the factor it overflows.
 *
 * **By font size.** KaTeX sizes everything in em, so a smaller font is a
 * smaller equation, layout box and all.
 */
import { MATH_DISPLAY_CLASS } from '../preview/rules/math';

/** CSS pixels per millimetre: CSS fixes 96 px to the inch. */
export const PX_PER_MM = 96 / 25.4;

export function fitWideMath(root: HTMLElement, printableWidthMm: number): void {
  const { width, padding } = root.style;
  // The print rules zero the copy's padding; measure the way it will print.
  root.style.width = `${printableWidthMm * PX_PER_MM}px`;
  root.style.padding = '0';
  try {
    for (const box of root.querySelectorAll<HTMLElement>(`.${MATH_DISPLAY_CLASS}`)) {
      const content = box.firstElementChild;
      if (!(content instanceof HTMLElement)) continue;
      content.style.fontSize = '';
      const room = box.clientWidth;
      const needed = box.scrollWidth;
      if (room > 0 && needed > room) content.style.fontSize = `${(room / needed) * 100}%`;
    }
  } finally {
    root.style.width = width;
    root.style.padding = padding;
  }
}
