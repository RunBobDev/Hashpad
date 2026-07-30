/**
 * Open/save/save-as orchestration against the single central store and the
 * one shared CodeMirror view. This is the layer the menu and the keyboard
 * both call into (see editor/extensions.ts and main.ts) so there is exactly
 * one implementation of "what Ctrl+O does" no matter which trigger fired it.
 *
 * `store` and the active view (via `getEditorView()`) come from
 * `state/appcontext.ts`, not from `main.ts` — main.ts imports the
 * orchestration functions below to route `hashpad:command` events, so
 * importing them back from main.ts would recreate the circular dependency
 * that module used to have with this one.
 */
import { EditorState, type Text } from '@codemirror/state';
import {
  ReadFile,
  ShowOpenDialog,
  ShowSaveDialog,
  WriteFile,
} from '../../wailsjs/go/app/App';
import { buildExtensions } from '../editor/extensions';
import { confirmSave, type SaveChoice } from '../ui/confirmdialog';
import { createUntitledDocument, isDirty, type Document } from '../state/document';
import { getEditorView, store } from '../state/appcontext';

/** Basename of a path, or `Untitled` for a document never saved to disk. */
export function displayName(doc: Document): string {
  if (doc.filePath === null) return 'Untitled';

  // Split on both separators: `ShowOpenDialog`/`ShowSaveDialog` always return
  // native Windows paths in this app, but the pure-function unit tests (and a
  // possible future Linux port) exercise POSIX paths too.
  const parts = doc.filePath.split(/[\\/]/);
  // split() on a non-empty string always yields at least one element, so pop()
  // only returns undefined for an empty array — unreachable here. The `??`
  // fallback exists purely to satisfy noUncheckedIndexedAccess.
  return parts.pop() ?? doc.filePath;
}

/**
 * What the OS window title bar shows. This is the only feedback the user has
 * for dirty state until Checkpoint C's tab bar lands, so the marker matters.
 */
export function windowTitle(doc: Document | null): string {
  if (!doc) return 'Hashpad';
  const marker = isDirty(doc) ? '• ' : '';
  return `${marker}${displayName(doc)} — Hashpad`;
}

/** Reads the store's one active document. Never null once the app has booted. */
function activeDocument(): Document | null {
  const state = store.getState();
  return state.documents.find((doc) => doc.id === state.activeDocumentId) ?? null;
}

/**
 * Gate shared by every action that would blow away the active document's
 * buffer (opening a file, starting a new one). Checkpoint B has one view and
 * no tabs, so "replace" really does destroy unsaved work unless this runs
 * first.
 *
 * Resolves to whether it is safe to proceed: true if the document was
 * already clean, the user chose Don't Save, or Save succeeded; false on
 * Cancel, or when the user chose Save but the save itself failed or was
 * cancelled — a failed save is never treated as permission to discard.
 */
async function confirmDiscardActive(): Promise<boolean> {
  const doc = activeDocument();
  if (!doc || !isDirty(doc)) return true;

  const choice = await confirmSave(displayName(doc));
  if (choice === 'cancel') return false;
  if (choice === 'dontsave') return true;
  return saveActive();
}

/**
 * Swaps in `doc` as the (sole) active document and loads its text into the
 * one shared view. Checkpoint C turns this into opening a new tab instead of
 * clobbering the current one — there is nowhere else to put it until then.
 *
 * Order matters here, though not for the reason it might look like: CodeMirror's
 * `EditorView.setState` fully reinitialises the view's plugins from scratch
 * rather than running them through the normal dispatch/update path, so it
 * never invokes `EditorView.updateListener` (verified against
 * `@codemirror/view`'s source — `setState` never constructs a `ViewUpdate`
 * or reads the `updateListener` facet; only `update()`, the dispatch path,
 * does). The editor/extensions.ts update listener therefore cannot fire
 * between these two lines. Even if a future CodeMirror version changed that,
 * `store.setState` below replaces `documents` wholesale (`[doc]`, not a map
 * over the previous array), so any write the listener made to the outgoing
 * document in between would be discarded here regardless. `view.setState`
 * still runs first so the view is never left holding a state that doesn't
 * match `activeDocumentId` for any observable tick.
 */
function replaceActiveDocument(doc: Document): void {
  getEditorView().setState(doc.editorState);
  store.setState((prev) => ({
    ...prev,
    documents: [doc],
    activeDocumentId: doc.id,
  }));
}

/**
 * Writes `savedDoc` back into the store so `isDirty` for that document goes
 * false. Exported (rather than kept module-private) purely so
 * fileops.test.ts can exercise it directly against the store without going
 * through the DOM-/IPC-bound `saveActive`/`saveActiveAs`.
 */
export function markSaved(id: string, savedDoc: Text): void {
  store.setState((prev) => ({
    ...prev,
    documents: prev.documents.map((doc) => (doc.id === id ? { ...doc, savedDoc } : doc)),
  }));
}

/**
 * File > Open. Checkpoint B has one editor view and no tabs, so each opened
 * file replaces the currently active document rather than appending — a
 * multi-file selection ends with only the last path actually on screen.
 * Checkpoint C turns this loop into "append a new tab per path" instead.
 */
export async function openFiles(): Promise<void> {
  if (!(await confirmDiscardActive())) return;

  let paths: string[];
  try {
    paths = await ShowOpenDialog();
  } catch (error) {
    console.error('hashpad: open dialog failed', error);
    return;
  }

  for (const path of paths) {
    let contents;
    try {
      contents = await ReadFile(path);
    } catch (error) {
      console.error(`hashpad: failed to read ${path}`, error);
      continue;
    }

    const editorState = EditorState.create({
      doc: contents.content,
      extensions: buildExtensions(store.getState().isDark),
    });

    replaceActiveDocument({
      id: crypto.randomUUID(),
      filePath: contents.path,
      editorState,
      savedDoc: editorState.doc,
      viewMode: 'source',
      // FileContents' generated TS type widens Go's Encoding/LineEnding enums
      // to plain `string` (see wailsjs/go/models.ts), but Go only ever sends
      // one of Document's literal members — the cast just restores what the
      // binding's typing lost.
      encoding: contents.encoding as Document['encoding'],
      lineEnding: contents.lineEnding as Document['lineEnding'],
    });
  }
}

/**
 * File > New. Still "replace the active document" for the same reason
 * `openFiles` is: Checkpoint B has one view and no tabs, so a fresh untitled
 * document goes through the identical discard-then-swap path.
 */
export async function newDocument(): Promise<void> {
  if (!(await confirmDiscardActive())) return;

  const editorState = EditorState.create({
    doc: '',
    extensions: buildExtensions(store.getState().isDark),
  });
  replaceActiveDocument(createUntitledDocument(editorState));
}

/**
 * File > Save. Returns false whenever the file did not end up written —
 * either the user cancelled the Save As this delegates to for an untitled
 * document, or the write itself rejected. Callers use the return value to
 * decide whether it is safe to treat the document as no-longer-dirty, so a
 * failed write must never report true.
 */
export async function saveActive(): Promise<boolean> {
  const doc = activeDocument();
  if (!doc) return false;
  if (doc.filePath === null) return saveActiveAs();

  // Captured once, before the IPC round trip: if this read `view.state.doc`
  // again after the `await` instead, and the user kept typing while the
  // write was in flight, `savedDoc` would end up recording text that was
  // never actually written to disk — the document would look clean while
  // still holding unsaved changes.
  const snapshot = getEditorView().state.doc;
  try {
    await WriteFile(doc.filePath, snapshot.toString(), doc.encoding, doc.lineEnding);
  } catch (error) {
    console.error(`hashpad: failed to save ${doc.filePath}`, error);
    return false;
  }

  markSaved(doc.id, snapshot);
  return true;
}

/** File > Save As. `ShowSaveDialog` returns `""` on cancel — a normal outcome, not an error. */
export async function saveActiveAs(): Promise<boolean> {
  const doc = activeDocument();
  if (!doc) return false;

  let path: string;
  try {
    path = await ShowSaveDialog(displayName(doc));
  } catch (error) {
    console.error('hashpad: save dialog failed', error);
    return false;
  }
  if (path === '') return false;

  // Same reasoning as saveActive: capture the snapshot once, before the
  // WriteFile round trip, and use that exact snapshot for both the bytes
  // written and the recorded savedDoc.
  const snapshot = getEditorView().state.doc;
  try {
    await WriteFile(path, snapshot.toString(), doc.encoding, doc.lineEnding);
  } catch (error) {
    console.error(`hashpad: failed to save ${path}`, error);
    return false;
  }

  store.setState((prev) => ({
    ...prev,
    documents: prev.documents.map((d) =>
      d.id === doc.id ? { ...d, filePath: path, savedDoc: snapshot } : d,
    ),
  }));
  return true;
}

/**
 * The save-prompt sequence run before the window is allowed to close
 * (main.ts's `app:close-requested` handler). Pulled out as a pure function,
 * taking `prompt` and `save` as arguments rather than calling `confirmSave`/
 * `saveActive` directly, so the one rule that matters here -- Cancel, or a
 * failed/cancelled Save, aborts the *entire* quit rather than merely skipping
 * that document -- is exercisable with plain stubs (fileops.test.ts), with no
 * DOM and no IPC involved.
 *
 * Written as a loop even though Checkpoint B only ever passes one document:
 * Checkpoint C adds tabs, and a single-document special case here would only
 * have to be unpicked then.
 */
export async function resolveDocumentsBeforeQuit(
  documents: Document[],
  prompt: (name: string) => Promise<SaveChoice>,
  save: (doc: Document) => Promise<boolean>,
): Promise<boolean> {
  for (const doc of documents) {
    if (!isDirty(doc)) continue;

    const choice = await prompt(displayName(doc));
    if (choice === 'cancel') return false;
    if (choice === 'dontsave') continue;

    // choice === 'save'. A save that failed, or a Save As the user cancelled,
    // must abort the quit exactly like Cancel would -- treating it as
    // permission to proceed would close the window over a document whose
    // text was never actually written to disk.
    if (!(await save(doc))) return false;
  }
  return true;
}
