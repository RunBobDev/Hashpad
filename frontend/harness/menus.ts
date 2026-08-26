/**
 * Do the menu separators actually look like separators?
 *
 * H.7 added them, and jsdom can prove only that a `div[role=separator]` is in
 * the right place in the DOM. Whether the line spans the popup, whether it is
 * visible against the surface, and whether it survives the dark theme are all
 * questions with no answer there -- `menubar.test.ts` would pass on a rule that
 * resolved to nothing.
 *
 * One theme flipped on the root, not two panels side by side: variables.css
 * scopes its dark block to `:root[data-theme='dark']`, so the attribute means
 * nothing anywhere else (see harness/settings.ts, which learned that the hard
 * way, and harness/gutter.ts, which still has the flaw).
 */
import { mountMenuBar } from '../src/ui/menubar';
import '../src/styles/app.css';

const root = document.querySelector<HTMLElement>('#app')!;
root.style.cssText =
  'min-height:100vh;background:var(--bg-app);color:var(--fg-primary);font-family:var(--font-ui)';

// Every toggle on, so the indicator column is populated and the separators are
// judged against a realistic menu rather than an empty one.
mountMenuBar(root, () => true);

declare global {
  interface Window {
    __setTheme: (theme: 'light' | 'dark') => void;
    __openMenu: (label: string) => void;
    __separatorReport: () => Record<string, unknown>;
  }
}

window.__setTheme = (theme) => {
  document.documentElement.dataset.theme = theme;
};

window.__openMenu = (label) => {
  const trigger = [...root.querySelectorAll('button')].find(
    (button) => button.textContent === label,
  );
  trigger?.click();
};

/**
 * A CSS colour resolved to real sRGB by painting it, because `--border` may be
 * a `color-mix()` and parsing the computed string drops the minus signs out of
 * an `oklab()` -- see harness/settings.ts, where that produced a contrast
 * failure that was not real.
 */
const canvas = document.createElement('canvas');
canvas.width = 1;
canvas.height = 1;
const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

function srgb(css: string): [number, number, number] {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!];
}

function luminance([r, g, b]: [number, number, number]): number {
  const [lr, lg, lb] = [r, g, b].map((value) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(srgb(a)), luminance(srgb(b))].sort((x, y) => y - x);
  return Math.round(((hi! + 0.05) / (lo! + 0.05)) * 100) / 100;
}

window.__separatorReport = () => {
  const popup = document.querySelector<HTMLElement>('.menu-popup')!;
  const dividers = [...popup.querySelectorAll<HTMLElement>('.menu-separator')];
  const popupBox = popup.getBoundingClientRect();
  const round = (n: number): number => Math.round(n);

  return {
    theme: document.documentElement.dataset.theme,
    items: popup.querySelectorAll('button').length,
    dividers: dividers.length,
    // A divider inset inside the popup's own 4px padding reads as a dash rather
    // than a divide, which is what the negative inline margin is for. Each
    // number is the line's width less the popup's: 0 means flush.
    overhangEachSide: dividers.map((d) => round(d.getBoundingClientRect().width - popupBox.width)),
    heights: dividers.map((d) => round(d.getBoundingClientRect().height * 100) / 100),
    // Against the popup's own surface. A hairline needs to be *visible*, not
    // WCAG-compliant text contrast -- 1.3 or so is the point below which it
    // stops reading as a line at all.
    contrastOnSurface: dividers.map((d) =>
      contrast(getComputedStyle(d).backgroundColor, getComputedStyle(popup).backgroundColor),
    ),
    // A popup taller than the window scrolls (there is a `max-height`), so the
    // dividers must not be what pushes it over.
    popupHeight: round(popupBox.height),
    popupScrolls: popup.scrollHeight > popup.clientHeight,
  };
};
