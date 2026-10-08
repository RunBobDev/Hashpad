/**
 * Copy as Rich Text (SPEC §7.3) -- the deliberate stand-in for DOCX and ODT
 * export: HTML and plain text on the clipboard, so a paste into Word,
 * LibreOffice, Docs or an email arrives formatted.
 *
 * Three things a paste does differently from a page, and what this does about
 * each:
 *
 * - **It keeps inline styles and drops stylesheets.** So the few properties
 *   that carry structure -- table borders, the code font, the quote's rule --
 *   are written onto the elements, read from the light container's *computed*
 *   style. That also keeps every colour in variables.css (SPEC §5.3).
 * - **Word reads MathML, not KaTeX's HTML.** So math is typeset as MathML
 *   alone, which Word turns into an equation.
 * - **Word processors do not take inline SVG.** So each diagram is drawn to a
 *   canvas and goes as a PNG.
 */
import { DIAGRAM_CLASS } from '../preview/rules/mermaid';
import { getEditorView, store } from '../state/appcontext';
import { activeDocument } from '../state/documents';
import { activeSource, buildExport, runExport } from './build';
import { embedLocalImages, revealRemoteImages } from './html';
import { markdownToPlainText } from './plaintext';

/** What survives a paste, per element: the structure, not the decoration. */
const INLINE: [string, string[]][] = [
  ['table', ['border-collapse']],
  [
    'th, td',
    ['border-top', 'border-right', 'border-bottom', 'border-left', 'padding', 'text-align'],
  ],
  ['th', ['font-weight', 'background-color']],
  ['pre', ['background-color', 'padding', 'font-family', 'font-size']],
  ['code', ['font-family', 'background-color']],
  ['blockquote', ['border-left', 'padding-left', 'margin-left', 'color']],
  ['mark', ['background-color', 'color']],
];

/** `live` and `copy` have the same shape, so a selector finds the same elements in each. */
function inlineStyles(live: HTMLElement, copy: HTMLElement): void {
  for (const [selector, properties] of INLINE) {
    const targets = copy.querySelectorAll<HTMLElement>(selector);
    live.querySelectorAll(selector).forEach((element, i) => {
      const computed = getComputedStyle(element);
      for (const property of properties) {
        const value = computed.getPropertyValue(property);
        if (value !== '') targets[i]!.style.setProperty(property, value);
      }
    });
  }
}

/**
 * A drawn diagram as a PNG data URI on `background`, or `null` if it cannot be
 * drawn. Opaque, because a transparent picture pasted somewhere dark loses its
 * dark lines -- and exports are light.
 */
async function asPicture(
  svg: SVGSVGElement,
  background: string,
): Promise<{ src: string; width: number; height: number } | null> {
  const { width, height } = svg.getBoundingClientRect();
  if (width === 0 || height === 0) return null;
  try {
    // Mermaid sizes its SVG to its container; as an image it needs a size of its own.
    const sized = svg.cloneNode(true) as SVGSVGElement;
    sized.setAttribute('width', String(width));
    sized.setAttribute('height', String(height));
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      new XMLSerializer().serializeToString(sized),
    )}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    // Twice the size, so a pasted diagram is not blurry on a high-DPI screen.
    canvas.width = Math.ceil(width * 2);
    canvas.height = Math.ceil(height * 2);
    const context = canvas.getContext('2d');
    if (context === null) return null;
    context.scale(2, 2);
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return {
      src: canvas.toDataURL('image/png'),
      width: Math.round(width),
      height: Math.round(height),
    };
  } catch {
    // Kept as SVG, which some paste targets show and the rest drop.
    return null;
  }
}

async function diagramsAsPictures(live: HTMLElement, copy: HTMLElement): Promise<void> {
  const selector = `.${DIAGRAM_CLASS} svg`;
  const targets = copy.querySelectorAll(selector);
  const drawn = [...live.querySelectorAll<SVGSVGElement>(selector)];
  // The light container's own background, so no colour is written here (SPEC §5.3).
  const background = getComputedStyle(live).backgroundColor;
  await Promise.all(
    drawn.map(async (svg, i) => {
      const picture = await asPicture(svg, background);
      if (picture === null) return;
      const img = copy.ownerDocument.createElement('img');
      img.setAttribute('src', picture.src);
      img.setAttribute('width', String(picture.width));
      img.setAttribute('height', String(picture.height));
      img.setAttribute('alt', 'Diagram');
      targets[i]!.replaceWith(img);
    }),
  );
}

/**
 * The clipboard's HTML for a built export. `root` is read -- its computed
 * style and its diagrams' sizes -- and never changed; the copy is made in an
 * inert document, as `html.ts` does and for the same reason.
 */
export async function richHtml(root: HTMLElement): Promise<string> {
  const copy = document.implementation.createHTMLDocument('').importNode(root, true);
  inlineStyles(root, copy);
  await diagramsAsPictures(root, copy);
  revealRemoteImages(copy);
  await embedLocalImages(copy);
  return copy.innerHTML;
}

/**
 * Both flavours through one `copy` event. Captured on the window and stopped
 * there, so CodeMirror's own copy handler -- which would put the markdown on
 * as plain text over ours -- never sees it.
 *
 * Answers whether the event came at all: Chromium fires it only within a user
 * gesture, and refuses quietly otherwise.
 */
export function writeClipboard(html: string, text: string): boolean {
  let written = false;
  const onCopy = (event: ClipboardEvent): void => {
    if (event.clipboardData === null) return;
    event.clipboardData.setData('text/html', html);
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
    event.stopImmediatePropagation();
    written = true;
  };
  window.addEventListener('copy', onCopy, true);
  try {
    document.execCommand('copy');
  } finally {
    window.removeEventListener('copy', onCopy, true);
  }
  return written;
}

/**
 * The selection's markdown when the editor is showing and has one; otherwise
 * the whole document. Reading view shows no editor, so no selection the user
 * can see -- and a plain Ctrl+C on a selection in the preview already copies it
 * formatted.
 */
function markdownToCopy(whole: string): string {
  const doc = activeDocument(store.getState());
  if (doc === null || doc.viewMode === 'preview') return whole;
  const { state } = getEditorView();
  const { from, to } = state.selection.main;
  return from === to ? whole : state.sliceDoc(from, to);
}

/** Edit > Copy as Rich Text */
export function copyActiveAsRichText(): Promise<void> {
  return runExport('copy', async () => {
    const source = activeSource();
    if (source === null) return;
    const markdown = markdownToCopy(source.text);
    const root = await buildExport(markdown, source.documentDir, 'mathml');
    try {
      const html = await richHtml(root);
      if (!writeClipboard(html, markdownToPlainText(markdown))) {
        throw new Error('the clipboard did not take it');
      }
    } finally {
      root.remove();
    }
  });
}
