/**
 * Open/save/save-as orchestration against the single central store and the
 * one shared CodeMirror view. This is the layer the menu and the keyboard
 * both call into (see editor/extensions.ts and main.ts) so there is exactly
 * one implementation of "what Ctrl+O does" no matter which trigger fired it.
 *
 * `store` and `view` are imported from `main.ts`, which in turn imports the
 * orchestration functions below to route `hashpad:command` events — a real
 * circular dependency between the two modules. That is fine at runtime: ES
 * module bindings are live references resolved lazily, and nothing here (or
 * in main.ts) touches `store`/`view` at module-evaluation time, only from
 * inside function bodies that run later. main.ts guards its own DOM setup so
 * merely importing it (as this module's import of `store`/`view` requires)
 * never throws in a DOM-less context such as this file's own unit tests.
 */
import { EditorState, type Text } from '@codemirror/state';
import {
  ReadFile,
  ShowOpenDialog,
  ShowSaveDialog,
  WriteFile,
} from '../../wailsjs/go/app/App';
import { buildExtensions } from '../editor/extensions';
import { confirmSave } from '../ui/confirmdialog';
import { createUntitledDocument, isDirty, type Document } from '../state/document';
import { store, view } from '../main';

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
 */
function replaceActiveDocument(doc: Document): void {
  view.setState(doc.editorState);
  store.setState((prev) => ({
    ...prev,
    documents: [doc],
    activeDocumentId: doc.id,
  }));
}

/** Writes `savedDoc` back into the store so `isDirty` for that document goes false. */
function markSaved(id: string, savedDoc: Text): void {
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

  try {
    await WriteFile(doc.filePath, view.state.doc.toString(), doc.encoding, doc.lineEnding);
  } catch (error) {
    console.error(`hashpad: failed to save ${doc.filePath}`, error);
    return false;
  }

  markSaved(doc.id, view.state.doc);
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

  try {
    await WriteFile(path, view.state.doc.toString(), doc.encoding, doc.lineEnding);
  } catch (error) {
    console.error(`hashpad: failed to save ${path}`, error);
    return false;
  }

  const savedDoc = view.state.doc;
  store.setState((prev) => ({
    ...prev,
    documents: prev.documents.map((d) => (d.id === doc.id ? { ...d, filePath: path, savedDoc } : d)),
  }));
  return true;
}
