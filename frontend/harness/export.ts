/**
 * Does an export come out right in a real browser?
 *
 * jsdom has no layout, no cascade worth the name and no `getBBox`, so
 * `export/*.test.ts` can check structure and nothing about appearance. Three
 * questions only a browser answers:
 *
 * 1. **Is the export light inside a dark app?** The page is `data-theme="dark"`;
 *    the builder's container must still compute the light palette.
 * 2. **Did math and diagrams finish before the builder resolved?** Real KaTeX
 *    layout, real Mermaid -- in the light theme, though the page is dark.
 * 3. **Does the standalone file render on its own?** Shown in an iframe with
 *    nothing of the app around it.
 * 4. **Does rich copy turn diagrams into pictures?** Only a real canvas can
 *    say, and only an untainted one can hand back a PNG (`copyReport`).
 *
 * Local images cannot be checked here -- Go's asset route does not exist under
 * Vite -- so the fixture has none; the real exe covers them.
 */
import { buildExport } from '../src/export/build';
import { standaloneHtml } from '../src/export/html';
import { richHtml } from '../src/export/richtext';
import '../src/styles/app.css';

const FENCE = '```';

const DOC = [
  '# Export check',
  '',
  'A paragraph with **bold**, *italic*, `code`, ==marked== and a [link](https://example.com).',
  '',
  '- one',
  '- two',
  '  - nested',
  '- [x] done',
  '',
  '> A quote.',
  '',
  `${FENCE}js`,
  'const answer = 42;',
  FENCE,
  '',
  '| Column | Other |',
  '|---|---|',
  '| a | b |',
  '| c | d |',
  '',
  'Inline $e^{i\\pi} + 1 = 0$ and display:',
  '',
  '$$',
  '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
  '$$',
  '',
  `${FENCE}mermaid`,
  'graph TD;',
  '  A[Start] --> B{Light?};',
  '  B -->|yes| C[Ship it];',
  FENCE,
  '',
  '![a remote cat](https://example.com/cat.png)',
].join('\n');

interface Report {
  /** The container's text colour, and the dark page's, which must differ. */
  exportColour: string;
  pageColour: string;
  /** What `.theme-light` should resolve `--fg-primary` to. */
  lightFg: string;
  katex: number;
  displayMath: number;
  diagrams: number;
  /** Fill of the first Mermaid node: light theme's is #ECECFF. */
  nodeFill: string;
  htmlBytes: number;
  remoteImgInHtml: boolean;
}

declare global {
  interface Window {
    exportReport: () => Promise<Report>;
  }
}

const app = document.querySelector('#app')!;
app.setAttribute('style', 'padding:12px;font:12px sans-serif;color:var(--fg-primary)');
const out = document.createElement('pre');
const frame = document.createElement('iframe');
frame.style.cssText = 'width:100%;height:900px;border:1px solid #999;background:#fff';
app.append(out, frame);

window.exportReport = async () => {
  const root = await buildExport(DOC, null);
  try {
    const probe = document.createElement('div');
    probe.className = 'theme-light';
    probe.style.color = 'var(--fg-primary)';
    document.body.append(probe);
    const lightFg = getComputedStyle(probe).color;
    probe.remove();

    const html = await standaloneHtml(root, 'Export check');
    frame.srcdoc = html;

    const report: Report = {
      exportColour: getComputedStyle(root).color,
      pageColour: getComputedStyle(document.body).color,
      lightFg,
      katex: root.querySelectorAll('.katex').length,
      displayMath: root.querySelectorAll('.katex-display').length,
      diagrams: root.querySelectorAll('.preview-mermaid svg').length,
      nodeFill: getComputedStyle(root.querySelector('.preview-mermaid svg .node rect')!).fill,
      htmlBytes: html.length,
      remoteImgInHtml: html.includes('<img src="https://example.com/cat.png"'),
    };
    out.textContent = JSON.stringify(report, null, 2);
    return report;
  } finally {
    root.remove();
  }
};

interface CopyReport {
  /** MathML, which Word turns into an equation, and none of KaTeX's HTML. */
  mathml: number;
  katexHtml: number;
  /** Every diagram a PNG -- which proves the canvas was not tainted. */
  pngs: number;
  svgs: number;
  /** Inline borders, since a paste drops stylesheets. */
  styledCells: number;
}

declare global {
  interface Window {
    copyReport: () => Promise<CopyReport>;
  }
}

const picture = document.createElement('div');
app.append(picture);

window.copyReport = async () => {
  const root = await buildExport(DOC, null, 'mathml');
  try {
    const html = await richHtml(root);
    const copy = document.createElement('div');
    copy.innerHTML = html;
    const pngs = copy.querySelectorAll('img[src^="data:image/png"]');
    const report: CopyReport = {
      mathml: copy.querySelectorAll('math').length,
      katexHtml: copy.querySelectorAll('.katex-html').length,
      pngs: pngs.length,
      svgs: copy.querySelectorAll('.preview-mermaid svg').length,
      styledCells: copy.querySelectorAll('td[style*="border"]').length,
    };
    // The first diagram, as a paste would get it -- for a screenshot. A clone,
    // and after counting: moving the original out first counted it as missing.
    picture.replaceChildren(...[...pngs].slice(0, 1).map((img) => img.cloneNode()));
    return report;
  } finally {
    root.remove();
  }
};

void window.exportReport();
