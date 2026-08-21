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

/**
 * SPEC §6.4's recognised extensions. Kept here and not shared with Go's
 * `markdownFilters`: that list is a Windows dialog *filter* string, this is a
 * membership test, and pushing one through the other's shape costs more than
 * the duplication. They are both spelled out from the same SPEC line.
 */
export const SUPPORTED_EXTENSIONS = [
  '.md',
  '.markdown',
  '.mdown',
  '.mkd',
  '.mdx',
  '.qmd',
  '.rmd',
  '.txt',
] as const;

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
): () => void {
  register((_x, _y, paths) => {
    const wanted = supportedPaths(paths);
    if (wanted.length === 0) return;
    // Deliberately not awaited: Wails' callback is not async-aware, and there
    // is nothing to do with the result. Failures are already reported per-path
    // by `openPaths`; this catch is only here so a rejection cannot surface as
    // an unhandled promise.
    void Promise.resolve(open(wanted)).catch((error: unknown) => {
      console.error('hashpad: failed to open dropped files', error);
    });
  }, false);

  return unregister;
}
