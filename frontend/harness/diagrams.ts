/**
 * Do the diagrams actually *draw*?
 *
 * **This page is not a convenience, it is the only place Mermaid can be tested
 * at all.** `mermaid.render` calls `getBBox` on an SVG node to measure laid-out
 * text, and jsdom does not implement it -- measured: the call throws before
 * doing anything, so `diagrams.test.ts` can cover the placeholder, the cache
 * and the connected check against a stub and nothing else. Every claim about a
 * real diagram is made here.
 *
 * Four questions, in order of how badly they need a browser:
 *
 * 1. Does a flowchart draw, and does a bad one fail *in place* rather than
 *    taking the document with it?
 * 2. Under `securityLevel: 'strict'`, does a hostile label stay inert? Mermaid's
 *    SVG is inserted past our own sanitiser (design §4.29), so its strict mode
 *    is the only thing between a document and the pane.
 * 3. Does the cache actually prevent a second render? That is what makes a
 *    document with diagrams typeable, and it is invisible without counting.
 * 4. Do the colours follow the theme? Mermaid bakes them into the SVG, so a
 *    flip is a re-render rather than a restyle.
 */
import { renderMarkdown } from '../src/preview/render';
import { cacheForTests, onDiagramsLoaded, renderDiagramsIn } from '../src/preview/diagrams';
import '../src/styles/app.css';

const FENCE = '```';

const DOC = [
  '# Diagrams',
  '',
  'A flowchart:',
  '',
  `${FENCE}mermaid`,
  'graph TD;',
  '  A[Start] --> B{Is it working?};',
  '  B -->|yes| C[Ship it];',
  '  B -->|no| D[Read the harness];',
  '  D --> B;',
  FENCE,
  '',
  'A sequence diagram:',
  '',
  `${FENCE}mermaid`,
  'sequenceDiagram',
  '  Editor->>Pane: document changed',
  '  Pane->>Mermaid: render(source)',
  '  Mermaid-->>Pane: svg',
  FENCE,
  '',
  '## A broken one',
  '',
  'The rest of the page must survive this:',
  '',
  `${FENCE}mermaid`,
  'graph TD;',
  '  A --> ;;;',
  FENCE,
  '',
  'Text after the broken diagram. If you can read this, the failure was',
  'contained.',
  '',
  '## Hostile labels',
  '',
  `${FENCE}mermaid`,
  'graph TD;',
  '  A["<img src=x onerror=alert(1)>"] --> B["<script>alert(2)</script>"];',
  FENCE,
  '',
  '## Not a diagram',
  '',
  `${FENCE}js`,
  "const notADiagram = 'this fence must still be syntax-highlighted';",
  FENCE,
  '',
  `${FENCE}`,
  'an infoless fence, untouched',
  FENCE,
].join('\n');

const app = document.querySelector('#app')!;
app.setAttribute(
  'style',
  'display:flex;flex-direction:column;gap:8px;padding:12px;max-width:100%;min-width:0;box-sizing:border-box',
);

const bar = document.createElement('div');
bar.style.cssText = 'font:12px sans-serif;color:#888';
bar.textContent = 'renderMarkdown → DOMPurify → renderDiagramsIn';
app.append(bar);

const pane = document.createElement('div');
pane.className = 'preview-pane';
// Constrained the way `.editor-split` constrains it in the app -- see
// harness/math.ts for why a free-growing pane makes the layout rules untestable.
pane.style.cssText =
  'flex:1 1 auto;min-width:0;width:100%;overflow:auto;border:1px solid #999;max-height:820px';
app.append(pane);

let dark = false;

function drawPane(): void {
  pane.innerHTML = renderMarkdown(DOC, { documentDir: null });
  void renderDiagramsIn(pane, dark);
}

onDiagramsLoaded(drawPane);
drawPane();

interface Report {
  /** Placeholders that became an `<svg>`. */
  drawn: number;
  /** Still showing their source: zero once the chunk has landed. */
  pending: number;
  /** Diagrams that failed, rendered in place. */
  errors: number;
  /** Non-mermaid fences, which must still be highlighted rather than eaten. */
  codeFences: number;
  /** Any of these is a security failure. */
  imgs: number;
  scripts: number;
  handlers: number;
  /** Mermaid's measuring scratch nodes, which it does not always clean up. */
  leftovers: number;
  /** Entries in the SVG cache. */
  cached: number;
}

declare global {
  interface Window {
    diagrams: () => Report;
    diagramsReady: () => Promise<void>;
    redraw: () => Promise<Report>;
    setDark: (value: boolean) => Promise<Report>;
    diagramColours: () => string[];
    paneText: () => string;
  }
}

window.diagrams = () => ({
  drawn: pane.querySelectorAll('.preview-mermaid-done svg').length,
  pending: pane.querySelectorAll('.preview-mermaid:not(.preview-mermaid-done)').length,
  errors: pane.querySelectorAll('.preview-mermaid-error').length,
  codeFences: pane.querySelectorAll('pre > code').length,
  imgs: pane.querySelectorAll('img').length,
  scripts: pane.querySelectorAll('script').length,
  handlers: [...pane.querySelectorAll('*')].filter((element) =>
    [...element.attributes].some((attribute) => attribute.name.startsWith('on')),
  ).length,
  // **Outside the pane only.** Mermaid prefixes every id *inside* the SVG it
  // produces with the render id -- markers, gradients, clip paths -- so a
  // document-wide count reported 54 "leftovers" for three diagrams that had
  // cleaned up perfectly. What matters is a scratch node that never made it
  // into the pane, which is what this counts.
  leftovers: [
    ...document.querySelectorAll('[id^="hashpad-mermaid-"], [id^="dhashpad-mermaid-"]'),
  ].filter((node) => !pane.contains(node)).length,
  cached: cacheForTests.size,
});

/**
 * Resolves once every placeholder has either drawn or failed.
 *
 * **Not `pending === 0`, which was the first version and raced.**
 * `renderDiagramsIn` marks every placeholder done *synchronously*, before it
 * yields, so that a second pass cannot start the same render twice -- so
 * `pending` reaches zero the instant the call returns, long before Mermaid has
 * drawn anything. Measured: the probe reported two diagrams of three, and two
 * scratch nodes still in flight, purely because it asked too early.
 *
 * What actually settles is content: every placeholder ends up holding either an
 * `<svg>` or an error card.
 */
window.diagramsReady = async () => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const placeholders = [...pane.querySelectorAll('.preview-mermaid')];
    const settled = placeholders.filter(
      (node) => node.querySelector('svg, .preview-mermaid-error') !== null,
    );
    if (placeholders.length > 0 && settled.length === placeholders.length) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // rAF raced against a timer: a hidden Browser pane never fires the frame
  // callback, which hung an earlier harness until the tool timed out.
  await Promise.race([
    new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
    new Promise((resolve) => setTimeout(resolve, 60)),
  ]);
};

/**
 * Re-renders the pane exactly as a keystroke would, and reports.
 *
 * **The cache check lives here.** A second pass over an unchanged document must
 * draw every diagram again *from the cache* -- same `drawn` count, no growth in
 * `cached`. If `cached` climbs, the key is wrong and every keystroke is paying
 * for a fresh Mermaid render.
 */
window.redraw = async () => {
  drawPane();
  await window.diagramsReady();
  return window.diagrams();
};

window.setDark = async (value) => {
  dark = value;
  document.documentElement.setAttribute('data-theme', value ? 'dark' : 'light');
  drawPane();
  await window.diagramsReady();
  return window.diagrams();
};

/**
 * The fill colours Mermaid actually used, so a theme flip can be seen as a
 * change rather than assumed. Deduplicated and capped: a flowchart has dozens
 * of shapes and they mostly share two or three colours.
 */
window.diagramColours = () => {
  const seen = new Set<string>();
  for (const node of pane.querySelectorAll('.preview-mermaid-done svg *')) {
    const fill = getComputedStyle(node).fill;
    if (fill !== '' && fill !== 'none') seen.add(fill);
  }
  return [...seen].slice(0, 8);
};

window.paneText = () => pane.textContent ?? '';
