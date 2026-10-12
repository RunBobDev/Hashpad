/**
 * The one renderer every export goes through (SPEC §7.3), so an export can
 * never disagree with the preview: the same `renderMarkdown`, the same KaTeX
 * pass, the same Mermaid pass.
 *
 * Into a real, attached element, because Mermaid measures laid-out text and
 * `display: none` would break it -- placed off-screen by `.export-root` in
 * app.css -- and `.theme-light`, because exports are light whatever the app is.
 *
 * **It resolves only once code, math and diagrams are finished.** The pane can
 * show a plain fence or LaTeX source for a moment and fill it in later; a file
 * written at that moment keeps it for good.
 */
import { languagesSettled } from '../preview/codehighlight';
import { renderMarkdown } from '../preview/render';
import { loadMath, renderMathIn, type MathOutput } from '../preview/math';
import { loadDiagrams, renderDiagramsIn } from '../preview/diagrams';
import { MATH_DISPLAY_CLASS, MATH_INLINE_CLASS } from '../preview/rules/math';
import { DIAGRAM_CLASS } from '../preview/rules/mermaid';
import { documentDirOf } from '../files/documentops';
import { currentText, displayName } from '../files/fileops';
import { store } from '../state/appcontext';
import { activeDocument } from '../state/documents';
import type { LineEnding } from '../state/document';
import { showNotice } from '../ui/confirmdialog';

export const EXPORT_CLASS = 'export-root';

/** Attached to the page; the caller removes it when done. */
export async function buildExport(
  text: string,
  documentDir: string | null,
  math: MathOutput = 'htmlAndMathml',
): Promise<HTMLElement> {
  const root = document.createElement('div');
  root.className = `preview-pane theme-light ${EXPORT_CLASS}`;
  root.setAttribute('aria-hidden', 'true');
  // Sanitised by renderMarkdown, exactly as the pane's is.
  let html = renderMarkdown(text, { documentDir });
  // That render started a load for every code language not yet here, and drew
  // those fences plain. Wait for the grammars and draw them again.
  const languages = languagesSettled();
  if (languages !== null) {
    await languages;
    html = renderMarkdown(text, { documentDir });
  }
  root.innerHTML = html;
  document.body.append(root);
  try {
    await Promise.all([typeset(root, math), draw(root)]);
    // A web font loads when text first needs it, and the engine prints text
    // in a font still loading as blank: with no math on screen yet, KaTeX's
    // fonts had never been asked for and an equation printed as empty space.
    // Layout asks for them; `ready` waits for them.
    root.getBoundingClientRect();
    if ('fonts' in document) await document.fonts.ready;
    return root;
  } catch (error) {
    root.remove();
    throw error;
  }
}

/** Skipped outright without math, so a plain document never loads KaTeX. */
async function typeset(root: HTMLElement, output: MathOutput): Promise<void> {
  if (root.querySelector(`.${MATH_INLINE_CLASS}, .${MATH_DISPLAY_CLASS}`) === null) return;
  await loadMath();
  renderMathIn(root, output);
}

async function draw(root: HTMLElement): Promise<void> {
  if (root.querySelector(`.${DIAGRAM_CLASS}`) === null) return;
  await loadDiagrams();
  await renderDiagramsIn(root, false);
}

export interface ExportSource {
  text: string;
  documentDir: string | null;
  /** The file name without its extension, for titles and suggested names. */
  stem: string;
  lineEnding: LineEnding;
}

export function activeSource(): ExportSource | null {
  const doc = activeDocument(store.getState());
  if (doc === null) return null;
  // `''` is documentops' spelling of "no folder"; the renderer's is `null`.
  const dir = documentDirOf(doc.filePath);
  return {
    text: currentText(doc).toString(),
    documentDir: dir === '' ? null : dir,
    stem: displayName(doc).replace(/\.[^.]+$/, '') || 'Untitled',
    lineEnding: doc.lineEnding,
  };
}

let busy = false;

/**
 * One export at a time -- a second Ctrl+P while the first is still building
 * would stack a second dialog on the first -- and a failure reaches the user,
 * not just the console. `what` finishes the sentence: "Couldn't export: …".
 */
export async function runExport(what: string, task: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await task();
  } catch (error) {
    console.error(`hashpad: ${what} failed`, error);
    // Wails rejects a bound call with a bare string, not an Error.
    const reason = error instanceof Error ? error.message : String(error);
    await showNotice(`Couldn't ${what}: ${reason}`);
  } finally {
    busy = false;
  }
}
