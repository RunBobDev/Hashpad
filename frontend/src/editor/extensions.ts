import {
  EditorView,
  type ViewUpdate,
  drawSelection,
  highlightActiveLine,
  keymap,
} from '@codemirror/view';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { Prec, type Extension } from '@codemirror/state';
import { darkThemeCompartment, hashpadTheme } from './theme';
import { COMMAND_EVENT } from '../ui/menubar';
import { store } from '../state/appcontext';

/**
 * Builds a CodeMirror command that dispatches the given `hashpad:command` id
 * on `document` instead of calling a file-operation function directly. The
 * menu bar (ui/menubar.ts) dispatches the exact same event for the exact same
 * ids, so File > Save and Ctrl+S run through one implementation
 * (files/fileops.ts's `saveActive`, wired up in main.ts) rather than two —
 * the pattern the toolbar will reuse in a later checkpoint. Returning `true`
 * marks the key as handled, which stops CodeMirror from also trying its own
 * bindings for the same chord and prevents the browser's default action
 * (e.g. Ctrl+S's save-page-as).
 */
function dispatchCommand(id: string): () => boolean {
  return () => {
    document.dispatchEvent(new CustomEvent<string>(COMMAND_EVENT, { detail: id }));
    return true;
  };
}

/**
 * The store's `Document.editorState` is only ever set at the moment a
 * document is created, opened, or saved — nothing pushes the live view's
 * state back into it as the user types, which is what let `isDirty` (see
 * state/document.ts) stay permanently false for a never-saved document and
 * permanently true after a save. This listener is the fix: it writes the
 * updated `EditorState` into whichever document is currently active.
 *
 * Two guards keep this cheap and safe:
 * - `update.docChanged` filters out pure selection/cursor moves, which don't
 *   affect dirty state and would otherwise wake the store on every arrow key.
 * - The active document is looked up fresh from the store each time
 *   (`store.getState().activeDocumentId`) rather than captured in a closure,
 *   so this always targets whatever document the view is currently showing.
 *   That matters because the view is shared and reused across documents
 *   (see files/documentops.ts's `switchToDocument`, which calls
 *   `view.setState(...)` to swap documents in place) — a stale captured id
 *   would let this write into the wrong document across a swap.
 *
 * No debounce needed: the title subscription in main.ts selects a `{
 * filePath, dirty }` pair, and the store's `Object.is`/shallow-equal check
 * (state/store.ts) already skips re-notifying when neither actually
 * changed, so a burst of keystrokes that keeps `dirty` at `true` only
 * notifies once, on the first keystroke that flips it.
 */
function syncActiveDocument(update: ViewUpdate): void {
  if (!update.docChanged) return;

  const activeId = store.getState().activeDocumentId;
  if (activeId === null) return;

  store.setState((prev) => ({
    ...prev,
    documents: prev.documents.map((doc) =>
      doc.id === activeId ? { ...doc, editorState: update.state } : doc,
    ),
  }));
}

/**
 * Assembled deliberately rather than using the `basicSetup` bundle: basicSetup
 * pulls in line numbers, fold gutters, autocompletion, and bracket matching,
 * most of which SPEC §6.13 has off by default and all of which cost bundle size.
 *
 * A factory rather than a module-level constant array: a shared array bakes
 * `darkThemeCompartment.of(...)` in with whatever `isDark` was passed the one
 * time the array was built, so every `EditorState` constructed from it —
 * including ones created later, e.g. for a newly opened tab — would carry
 * that same value forever. `setEditorDark` only reconfigures the compartment
 * on the view's *current* state, it does not change what new states are
 * seeded with. Calling `buildExtensions(isDark)` fresh for every new
 * `EditorState` is what keeps future tabs in sync with the theme at the
 * moment they're created; `setEditorDark` remains the way to flip the theme
 * on a state that already exists. Both are needed — one seeds, one updates.
 */
export function buildExtensions(isDark: boolean): Extension[] {
  return [
    history(),
    drawSelection(),
    highlightActiveLine(),
    // Word wrap is on by default (SPEC §6.6). Checkpoint G makes it a toggle.
    EditorView.lineWrapping,
    // High precedence so these file-command shortcuts always win, regardless
    // of what defaultKeymap does or gains in a future CodeMirror version.
    Prec.high(
      keymap.of([
        { key: 'Mod-o', run: dispatchCommand('file.open') },
        { key: 'Mod-s', run: dispatchCommand('file.save') },
        { key: 'Mod-Shift-s', run: dispatchCommand('file.saveAs') },
        { key: 'Mod-n', run: dispatchCommand('file.new') },
      ]),
    ),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    hashpadTheme,
    darkThemeCompartment.of(EditorView.darkTheme.of(isDark)),
    EditorView.updateListener.of(syncActiveDocument),
  ];
}
