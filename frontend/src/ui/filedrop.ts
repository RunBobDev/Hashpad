/**
 * Dropping files on the window opens them as tabs (SPEC §6.4).
 *
 * **The paths come from Wails, not from the DOM**, and that is the whole reason
 * this module is not four lines of `addEventListener('drop')`. A webview hands
 * JavaScript `File` objects with no filesystem path -- browsers withhold it on
 * purpose -- so a DOM handler can see that files were dropped and read their
 * bytes, but cannot name the file to open. Wails resolves the real paths
 * natively and re-emits them; `main.go` turns that on with `EnableFileDrop`.
 *
 * `useDropTarget` is false, so the whole window accepts a drop. The alternative
 * is Wails' `--wails-drop-target: drop` CSS opt-in, which would mean every
 * region that should accept a file -- editor, preview, outline, tab strip, the
 * gaps between them -- carrying the declaration, and any new one silently not.
 * SPEC says the window, so the window it is.
 */
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { OnFileDrop, OnFileDropOff } from '../../wailsjs/runtime/runtime';
import { openPaths } from '../files/fileops';
import { dropImages, isImagePath } from '../files/imageops';
import { getEditorView } from '../state/appcontext';

/**
 * SPEC §6.4's recognised extensions. Kept here and not shared with Go's
 * `markdownFilters`: that list is a Windows dialog *filter* string, this is a
 * membership test, and pushing one through the other's shape costs more than
 * the duplication. They are both spelled out from the same SPEC line.
 */
export const MARKDOWN_EXTENSIONS = [
  '.md',
  '.markdown',
  '.mdown',
  '.mkd',
  '.mdx',
  '.qmd',
  '.rmd',
] as const;

/**
 * Everything Hashpad will open, which is the markdown extensions plus `.txt`.
 *
 * **`.txt` is separated out rather than listed alongside them**, because the
 * difference matters somewhere: a text file is not markdown, so rendering it
 * joins its lines into paragraphs -- correct CommonMark, and nonsense for a text
 * file. `documentops.ts` uses `isMarkdownPath` to keep `.txt` out of reading
 * mode, which was reported as "everything is stitched together".
 */
export const SUPPORTED_EXTENSIONS = [...MARKDOWN_EXTENSIONS, '.txt'] as const;

/** Whether this path is one reading mode can sensibly render. */
export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * The paths worth opening, in the order they were dropped.
 *
 * Unrecognised files are **dropped silently rather than opened as text**. Every
 * file this app opens is decoded as markdown, so a dropped `.png` or `.zip`
 * would become a tab full of mojibake -- SPEC §6.4 lists the extensions it
 * means, and "opens it in a new tab" reads against that list, not against
 * anything at all on disk.
 *
 * Exported and pure because this is the part with the decisions in it. Wails'
 * dispatcher builds its path list with `strings.Split(msg, "\n")`, which yields
 * `[""]` rather than an empty slice for an empty payload, so an empty string has
 * to be handled here -- it has no recognised extension, and falls out for free.
 */
export function supportedPaths(paths: readonly string[]): string[] {
  return paths.filter((path) => {
    const lower = path.toLowerCase();
    return SUPPORTED_EXTENSIONS.some((extension) => lower.endsWith(extension));
  });
}

/**
 * Stops CodeMirror opening the dropped file *into the current document*.
 *
 * `@codemirror/view`'s built-in `drop` handler reads any dropped file with a
 * `FileReader` and inserts its text at the cursor. That is a reasonable default
 * for an editor with no file model; here it means dropping `notes.md` on the
 * editor both pastes its contents into whatever tab is open and opens a second
 * tab -- two outcomes, one of which quietly edits a document the user did not
 * mean to touch.
 *
 * Returning true claims the event, and CodeMirror's dispatcher stops at the
 * first handler that does: extension handlers are registered ahead of the
 * built-ins (`computeHandlers` pushes plugin handlers first, then its own), so
 * this one runs first and the built-in never does. Claiming it calls
 * `preventDefault`, which does **not** stop propagation -- Wails' listener is on
 * `window` and still hears the drop, which is what opens the tab.
 *
 * Only when files are involved. A drag *within* the document is text, and
 * CodeMirror's handling of that is exactly right.
 */
export function suppressEditorFileDrop(): Extension {
  return EditorView.domEventHandlers({
    drop: (event) => (event.dataTransfer?.files.length ?? 0) > 0,
  });
}

/**
 * Adds dropped images to the document, at the point they were dropped.
 *
 * `posAtCoords` is what makes the position meaningful: an image dropped halfway
 * down the text belongs there, not wherever the caret was left. It returns null
 * when the coordinates are outside the editor -- dropped on the preview, the
 * outline, the status bar -- and then the caret is the only sensible answer, so
 * `undefined` is passed on and `dropImages` replaces the selection instead.
 */
function insertDroppedImages(x: number, y: number, paths: readonly string[]): Promise<void> {
  const view = getEditorView();
  return dropImages(view, paths, view.posAtCoords({ x, y }) ?? undefined);
}

/** Wails' registrar, narrowed to what this module uses. */
type Register = (
  callback: (x: number, y: number, paths: string[]) => void,
  useDropTarget: boolean,
) => void;

/**
 * Subscribes to drops and returns a teardown.
 *
 * Both Wails calls are injectable so the wiring is testable without a runtime:
 * `wailsjs/runtime` is a real module even under Vitest, but its `OnFileDrop`
 * reaches for `window.runtime`, which only the injected desktop runtime
 * provides.
 */
export function mountFileDrop(
  open: (paths: readonly string[]) => void | Promise<void> = openPaths,
  register: Register = OnFileDrop,
  unregister: () => void = OnFileDropOff,
  insert: (
    x: number,
    y: number,
    paths: readonly string[],
  ) => void | Promise<void> = insertDroppedImages,
): () => void {
  register((x, y, paths) => {
    // A drop may hold both. Markdown becomes tabs, images go into the document
    // the user dropped them on -- doing one or the other would make a mixed
    // drop silently lose half of itself.
    const documents = supportedPaths(paths);
    if (documents.length > 0) run(open(documents), 'open dropped files');

    const images = paths.filter(isImagePath);
    if (images.length > 0) run(insert(x, y, images), 'add dropped images');
  }, false);

  return unregister;
}

/**
 * Runs one half of a drop without letting it reject into nowhere.
 *
 * Wails' callback is not async-aware, so a rejection has no caller to reach --
 * it would surface as an unhandled promise, which in a packaged app is an error
 * nobody sees and a drop that appeared to do nothing.
 */
function run(work: void | Promise<void>, what: string): void {
  void Promise.resolve(work).catch((error: unknown) => {
    console.error(`hashpad: failed to ${what}`, error);
  });
}
