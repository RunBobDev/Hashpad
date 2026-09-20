/**
 * Does the math actually *appear*?
 *
 * `preview/math.test.ts` proves which elements get typeset and that nothing
 * executable comes out the far side, which is the whole of the logic. It says
 * nothing about whether a fraction has a bar across it, whether the glyphs are
 * KaTeX's faces or a fallback, or whether a display equation is centred -- all
 * of which are layout, and jsdom has none.
 *
 * **The font question is the one that needs a real browser most.** KaTeX's
 * output is a stack of absolutely-positioned boxes sized in `em` against
 * `KaTeX_Main` and friends; served the wrong face, or none, it does not fail --
 * it renders, wrongly, and looks like a KaTeX bug. `window.mathFonts()` reports
 * which families the browser actually resolved.
 *
 * This runs the real pipeline: `renderMarkdown` (markdown-it plus the sanitiser
 * that strips `style`) and then `renderMathIn` on the result, which is exactly
 * the two steps `preview/pane.ts` performs.
 */
import { renderMarkdown } from '../src/preview/render';
import { onMathLoaded, renderMathIn } from '../src/preview/math';
import '../src/styles/app.css';

const DOC = [
  '# Math',
  '',
  'Inline: mass-energy is $E = mc^2$, in a sentence, mid-line.',
  '',
  'A fraction inline $\\frac{a}{b}$ should not push the line apart much.',
  '',
  'Display, on its own line:',
  '',
  '$$',
  '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
  '$$',
  '',
  'A one-line display block:',
  '',
  '$$ \\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2} $$',
  '',
  'Inline display $$\\alpha + \\beta$$ inside a sentence keeps the paragraph.',
  '',
  '## The cases that must NOT be math',
  '',
  'I paid $5 and $10 for it, and it now costs$20 more.',
  '',
  'An escaped \\$5 stays a dollar sign.',
  '',
  'In code: `$PATH$` and a fence:',
  '',
  '```sh',
  'echo $HOME$',
  '```',
  '',
  '## Errors and hostility',
  '',
  'A malformed one: $\\frac{1}{$ — renders red, in place, and the rest survives.',
  '',
  'Hostile: $\\href{javascript:alert(1)}{click}$ must not be a link.',
  '',
  'Also hostile: $\\text{<img src=x onerror=alert(1)>}$.',
  '',
  '## A very long one, for the overflow rule',
  '',
  '$$',
  'f(x) = a_0 + a_1 x + a_2 x^2 + a_3 x^3 + a_4 x^4 + a_5 x^5 + a_6 x^6 + a_7 x^7 + a_8 x^8 + a_9 x^9 + a_{10} x^{10}',
  '$$',
].join('\n');

const app = document.querySelector('#app')!;
// `max-width` as well as the flex column: without it the column is free to grow
// to its widest child, which for this document is a very long equation.
app.setAttribute(
  'style',
  'display:flex;flex-direction:column;gap:8px;padding:12px;max-width:100%;min-width:0;box-sizing:border-box',
);

const bar = document.createElement('div');
bar.style.cssText = 'font:12px sans-serif;color:#888';
bar.textContent = 'the real pipeline: renderMarkdown → DOMPurify → renderMathIn';
app.append(bar);

const pane = document.createElement('div');
// The pane's own class, so `preview.css` applies exactly as it does in the app.
pane.className = 'preview-pane';
// **`width` and `min-width: 0`, not `flex: 1 1 auto` alone**, and the reason is
// the whole point of the overflow rule. In the app the pane is a flex child of
// `.editor-split`, which sets `min-width: 0` on purpose -- app.css says
// "`min-width` is the one that bites" -- so an unbreakable 1,200px equation is
// *constrained* and has to scroll inside itself. The first version of this
// harness left the pane free to grow, so the equation pushed the whole page
// sideways and the rule under test never fired. A harness that cannot reproduce
// the constraint cannot test what depends on it.
pane.style.cssText =
  'flex:1 1 auto;min-width:0;width:100%;overflow:auto;border:1px solid #999;max-height:760px';
app.append(pane);

function draw(): void {
  pane.innerHTML = renderMarkdown(DOC, { documentDir: null });
  renderMathIn(pane);
}

// The same subscription `pane.ts` makes: the first pass starts the load and
// renders nothing, and this brings it back once the chunk lands.
onMathLoaded(draw);
draw();

interface Report {
  /** How many placeholders KaTeX actually filled in. */
  typeset: number;
  /** Still showing LaTeX source -- should be 0 once the chunk has landed. */
  pending: number;
  /** Malformed expressions rendered in place. */
  errors: number;
  /** Anything that became a link or an image is a security failure. */
  anchors: number;
  images: number;
  handlers: number;
}

declare global {
  interface Window {
    math: () => Report;
    mathFonts: () => Record<string, number>;
    mathBoxes: () => {
      width: number;
      height: number;
      centred: boolean;
      overflows: boolean;
    }[];
    // Declared to match `harness/about.ts`, which already augments `Window` with
    // this name -- the harness pages share one global scope as far as TypeScript
    // is concerned, so a second declaration has to agree with the first.
    setTheme: (theme: 'light' | 'dark') => string;
    paneText: () => string;
    mathReady: () => Promise<void>;
  }
}

/**
 * Resolves once KaTeX has landed *and* the fonts it needs are resolved.
 *
 * Exists because every measurement taken without it was wrong: the first draw
 * happens before the chunk arrives, `onMathLoaded` replaces the pane's HTML
 * when it does, and a probe run in between measures elements that are about to
 * be thrown away. A fixed timeout hid that rather than fixing it -- two runs
 * reported zero-width display blocks and a third reported real numbers, from
 * identical code.
 */
window.mathReady = async () => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (pane.querySelector('.katex') !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await document.fonts.ready;
  // One frame, so the reflow the fonts caused has been laid out before anything
  // calls `getBoundingClientRect` -- **raced against a timer, because
  // `requestAnimationFrame` does not fire in a hidden tab.** The Browser pane
  // is hidden for most of these measurements, and waiting on rAF alone hung
  // until the tool timed out at 45 seconds. Layout still happens either way;
  // only the frame callback is withheld.
  await Promise.race([
    new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
    new Promise((resolve) => setTimeout(resolve, 60)),
  ]);
};

window.math = () => ({
  typeset: pane.querySelectorAll('.katex').length,
  // A placeholder that never got filled still carries the marker class without
  // the done class -- the same selector `renderMathIn` uses to find work.
  pending: pane.querySelectorAll('.preview-math:not(.preview-math-done)').length,
  errors: pane.querySelectorAll('.katex-error').length,
  anchors: pane.querySelectorAll('a').length,
  images: pane.querySelectorAll('img').length,
  handlers: [...pane.querySelectorAll('*')].filter((element) =>
    [...element.attributes].some((attribute) => attribute.name.startsWith('on')),
  ).length,
});

/**
 * Which font families the browser actually resolved inside the typeset output,
 * and how many elements use each.
 *
 * **The check that only a real browser can answer.** KaTeX sizes everything
 * against its own metrics; if the woff2 files did not arrive -- and the build
 * now ships *only* woff2, with the woff and ttf fallbacks stripped -- the
 * layout is still produced, just wrong. Seeing `KaTeX_Main` here is what says
 * the fonts are being served.
 */
window.mathFonts = () => {
  const counts: Record<string, number> = {};
  for (const element of pane.querySelectorAll('.katex *')) {
    const family = getComputedStyle(element).fontFamily.split(',')[0]!.replace(/["']/g, '').trim();
    if (family === '') continue;
    counts[family] = (counts[family] ?? 0) + 1;
  }
  return counts;
};

/**
 * Measured boxes, for the centring and overflow rules that have no test.
 *
 * **`centred` asks about the equation inside its own container**, not about the
 * container inside the pane. The first version asked the second question and
 * answered `false` for equations that are plainly centred on screen: a display
 * block is full-width by design, so its own gaps are the pane's padding, which
 * says nothing about the math. What matters is where the `.katex` box sits in
 * the block that holds it.
 *
 * `overflows` is the other half: a long equation does not wrap -- KaTeX lays it
 * out as one unbreakable row -- so the container must scroll rather than the
 * pane. Only visible at a width narrow enough to force it.
 */
window.mathBoxes = () =>
  [...pane.querySelectorAll<HTMLElement>('div.preview-math-display')].map((element) => {
    const box = element.getBoundingClientRect();
    const inner = element.querySelector('.katex-display, .katex');
    const innerBox = inner?.getBoundingClientRect() ?? box;
    const leftGap = innerBox.left - box.left;
    const rightGap = box.right - innerBox.right;
    return {
      width: Math.round(box.width),
      height: Math.round(box.height),
      // Within a couple of pixels either side counts as centred. An equation
      // wider than its container is not centred and cannot be; it scrolls.
      centred: innerBox.width <= box.width && Math.abs(leftGap - rightGap) < 3,
      overflows: element.scrollWidth > element.clientWidth,
    };
  });

/** `:root[data-theme]` is what `variables.css` keys off, so this is the root. */
window.setTheme = (theme) => {
  document.documentElement.setAttribute('data-theme', theme);
  return theme;
};

window.paneText = () => pane.textContent ?? '';
