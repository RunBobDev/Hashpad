/**
 * Export as HTML (SPEC §7.3): one file that opens anywhere with nothing beside
 * it. Stylesheets inlined, local images as data URIs, KaTeX's fonts embedded
 * when -- and only when -- there is math.
 *
 * **Internet images go out as plain `<img src="https://…">`**: the reader's
 * browser loads them. Hashpad never does (design §3), and embedding them would
 * mean fetching them.
 *
 * Assembled in an inert document (`createHTMLDocument`), not the app's: an
 * `<img>` in the app's document starts loading the moment it has a `src`. The
 * CSP would refuse an internet one, but there is no reason to ask.
 */
import variablesCss from '../styles/variables.css?inline';
import previewCss from '../styles/preview.css?inline';
import katexCss from 'katex/dist/katex.min.css?inline';
import { ShowExportDialog, WriteFile } from '../../wailsjs/go/app/App';
import { codeHighlightStyle } from '../editor/codetheme';
import { ASSET_ROUTE } from '../preview/rules/images';
import { activeSource, buildExport, runExport } from './build';

/**
 * The exported file's own policy. Nothing in it can run as it stands -- the
 * content is the sanitised preview plus KaTeX's and Mermaid's output -- so this
 * is a second wall rather than the first, for a file that will be opened by
 * people and programs Hashpad knows nothing about.
 */
const EXPORT_CSP =
  "default-src 'none'; img-src data: http: https:; style-src 'unsafe-inline'; font-src data:";

/**
 * The syntax colours. Not in any `.css` file: CodeMirror generates the class
 * names and style-mod injects the rules at runtime (`preview/codehighlight.ts`
 * mounts them), so they have to be asked for. Without this every code block in
 * an export came out in one colour.
 */
const CODE_CSS = codeHighlightStyle.module?.getRules() ?? '';

/** What a page in a browser needs that a pane inside the app does not. */
const PAGE_CSS = `
body { margin: 0; background: var(--bg-editor); }
main.preview-pane { max-width: 860px; margin: 0 auto; overflow: visible; }
`;

const WEB = /^https?:/i;

export function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('could not read the data'));
    reader.readAsDataURL(blob);
  });
}

/** Same-origin only: Go's asset route and the app's own bundled files. */
async function fetchAsDataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${String(response.status)}`);
  return dataUrl(await response.blob());
}

export async function embedLocalImages(root: ParentNode): Promise<void> {
  const images = [...root.querySelectorAll<HTMLImageElement>(`img[src^="${ASSET_ROUTE}"]`)];
  await Promise.all(
    images.map(async (img) => {
      try {
        img.setAttribute('src', await fetchAsDataUrl(img.getAttribute('src')!));
      } catch {
        // The route's query carries the document's folder. A broken image
        // shows its alt; it must not carry a local path into the file.
        img.removeAttribute('src');
      }
    }),
  );
}

/** The placeholders `rules/images.ts` leaves for internet images, as images again. */
export function revealRemoteImages(root: ParentNode): void {
  for (const span of root.querySelectorAll('.preview-image-placeholder[data-src]')) {
    const src = span.getAttribute('data-src') ?? '';
    if (!WEB.test(src)) continue;
    const img = span.ownerDocument.createElement('img');
    img.setAttribute('src', src);
    img.setAttribute('alt', span.getAttribute('data-alt') ?? '');
    span.replaceWith(img);
  }
}

/** Every `url(….woff2)` in `css`, fetched and inlined as a data URI. */
export async function inlineFontUrls(css: string): Promise<string> {
  const urls = [
    ...new Set([...css.matchAll(/url\(["']?([^"')]+\.woff2)["']?\)/g)].map((match) => match[1]!)),
  ];
  const data = await Promise.all(urls.map(fetchAsDataUrl));
  return urls.reduce((text, url, i) => text.replaceAll(url, data[i]!), css);
}

/** About 250 kB once embedded, and the same every time, so built once a session. */
let katexEmbedded: Promise<string> | null = null;

function katexWithFonts(): Promise<string> {
  katexEmbedded ??= inlineFontUrls(katexCss).catch((error: unknown) => {
    katexEmbedded = null;
    throw error;
  });
  return katexEmbedded;
}

export function documentTitle(root: ParentNode, fallback: string): string {
  return root.querySelector('h1')?.textContent?.trim() || fallback;
}

/** The whole file. `root` is a built export; it is copied, never changed. */
export async function standaloneHtml(root: HTMLElement, title: string): Promise<string> {
  const inert = document.implementation.createHTMLDocument('');
  const content = inert.importNode(root, true);
  revealRemoteImages(content);
  await embedLocalImages(content);
  const math = content.querySelector('.katex') === null ? '' : await katexWithFonts();
  // Through the DOM, so the title is escaped by the serialiser rather than by hand.
  const heading = inert.createElement('title');
  heading.textContent = title;

  return [
    '<!doctype html>',
    '<html lang="en" data-theme="light">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    heading.outerHTML,
    `<style>\n${variablesCss}\n${previewCss}\n${CODE_CSS}\n${math}\n${PAGE_CSS}</style>`,
    '</head>',
    '<body>',
    `<main class="preview-pane">${content.innerHTML}</main>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** File > Export as HTML… */
export function exportActiveAsHtml(): Promise<void> {
  return runExport('export', async () => {
    const source = activeSource();
    if (source === null) return;
    const path = await ShowExportDialog(`${source.stem}.html`, 'html');
    if (path === '') return;
    const root = await buildExport(source.text, source.documentDir);
    try {
      const html = await standaloneHtml(root, documentTitle(root, source.stem));
      await WriteFile(path, html, 'utf-8', source.lineEnding);
    } finally {
      root.remove();
    }
  });
}
