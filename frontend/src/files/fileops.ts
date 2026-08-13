/**
 * Open/save orchestration against the single central store and the Go IPC
 * bindings. This is the layer the menu and the keyboard both call into (see
 * editor/extensions.ts and main.ts) so there is exactly one implementation of
 * "what Ctrl+O does" no matter which trigger fired it.
 *
 * `store` and the active view (via `getEditorView()`) come from
 * `state/appcontext.ts`, not from `main.ts` — main.ts imports the
 * orchestration functions below to route `hashpad:command` events, so
 * importing them back from main.ts would recreate the circular dependency
 * that module used to have with this one.
 *
 * This file and `files/documentops.ts` import each other (this one for
 * `openDocumentInNewTab`, so `openFiles` has exactly one implementation of
 * "add a tab" to call; documentops.ts for `saveDocument`/`displayName`, so
 * `closeDocumentWithPrompt` saves the right buffer). That is safe: every
 * binding crossing the cycle is a hoisted `function` export, never a `const`
 * evaluated at module-load time, and nothing on either side calls into the
 * other at module scope — only from inside functions invoked later, by which
 * point both modules have finished initialising.
 */
import type { Text } from '@codemirror/state';
import { ReadFile, ShowOpenDialog, ShowSaveDialog, WriteFile } from '../../wailsjs/go/app/App';
import { openDocumentInNewTab, publishActiveDocumentDir } from './documentops';
import type { SaveChoice } from '../ui/confirmdialog';
import { isDirty, type Document } from '../state/document';
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

/** Looks up a document by id without assuming it is the active one. */
function findDocument(id: string): Document | null {
  return store.getState().documents.find((doc) => doc.id === id) ?? null;
}

/**
 * The text that should be written for `doc` right now. The active document's
 * authoritative text lives in the live `EditorView` — that is what the user is
 * looking at and typing into. Every other document's text was last written
 * into its own `editorState` by the update listener (editor/extensions.ts)
 * the moment before it stopped being active, and nothing touches it again
 * until it becomes active once more, so `doc.editorState.doc` is exactly as
 * current for a background document as `view.state.doc` is for the active
 * one. Reading the wrong one of these two sources for a given document is
 * the single easiest way to save a stale or wrong buffer.
 */
function currentText(doc: Document): Text {
  return doc.id === store.getState().activeDocumentId
    ? getEditorView().state.doc
    : doc.editorState.doc;
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
 * File > Open. Checkpoint C: each opened file becomes its own tab via
 * `documentops.ts`'s `openDocumentInNewTab` — opening a file no longer
 * discards anything, so there is nothing to confirm first.
 */
export async function openFiles(): Promise<void> {
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

    openDocumentInNewTab(contents);
  }
}

/**
 * Saves the document identified by `id`, whether or not it is the active
 * tab. This is the fix for a latent wrong-file write: an earlier version of
 * this module only ever saved whichever document the store considered
 * active, which was safe only while there was exactly one document.
 * `closeDocumentWithPrompt` (documentops.ts) may be asked to save a
 * background tab, and `resolveDocumentsBeforeQuit` iterates every dirty
 * document in the list — both need to save the document they were actually
 * given, not whatever happens to be on screen.
 *
 * Returns false whenever the file did not end up written — an unknown id, a
 * cancelled Save As, or a rejected write. Callers use the return value to
 * decide whether it is safe to treat the document as no-longer-dirty, so a
 * failed write must never report true.
 */
export async function saveDocument(id: string): Promise<boolean> {
  const doc = findDocument(id);
  if (!doc) return false;
  if (doc.filePath === null) return saveDocumentAs(id);

  // Captured once, before the IPC round trip: if this read the text again
  // after the `await` instead, and the user kept typing while the write was
  // in flight, `savedDoc` would end up recording text that was never
  // actually written to disk — the document would look clean while still
  // holding unsaved changes.
  const snapshot = currentText(doc);
  try {
    await WriteFile(doc.filePath, snapshot.toString(), doc.encoding, doc.lineEnding);
  } catch (error) {
    console.error(`hashpad: failed to save ${doc.filePath}`, error);
    return false;
  }

  markSaved(doc.id, snapshot);
  return true;
}

/** File > Save. Thin wrapper: saves whichever document is currently active. */
export async function saveActive(): Promise<boolean> {
  const id = store.getState().activeDocumentId;
  if (id === null) return false;
  return saveDocument(id);
}

/**
 * Save As for the document identified by `id`. `ShowSaveDialog` returns `""`
 * on cancel — a normal outcome, not an error.
 */
export async function saveDocumentAs(id: string): Promise<boolean> {
  const doc = findDocument(id);
  if (!doc) return false;

  let path: string;
  try {
    path = await ShowSaveDialog(displayName(doc));
  } catch (error) {
    console.error('hashpad: save dialog failed', error);
    return false;
  }
  if (path === '') return false;

  // Same reasoning as saveDocument: capture the snapshot once, before the
  // WriteFile round trip, and use that exact snapshot for both the bytes
  // written and the recorded savedDoc.
  const snapshot = currentText(doc);
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

  // Save As can move a document to a different folder, and relative image
  // paths in the preview resolve against Go's copy of that folder (design
  // §5.7). Every *other* way the active document changes funnels through
  // `switchToDocument`, which republishes there -- this is the one path that
  // changes the directory without changing which document is active, so it
  // has to say so itself. Only when this document is the active one: saving a
  // background tab must not re-point the handler away from what is on screen.
  if (store.getState().activeDocumentId === doc.id) {
    publishActiveDocumentDir(path);
  }
  return true;
}

/** File > Save As. Thin wrapper: saves-as whichever document is currently active. */
export async function saveActiveAs(): Promise<boolean> {
  const id = store.getState().activeDocumentId;
  if (id === null) return false;
  return saveDocumentAs(id);
}

/**
 * The save-prompt sequence run before the window is allowed to close
 * (main.ts's `app:close-requested` handler). Pulled out as a pure function,
 * taking `prompt` and `save` as arguments rather than calling `confirmSave`/
 * `saveDocument` directly, so the one rule that matters here -- Cancel, or a
 * failed/cancelled Save, aborts the *entire* quit rather than merely skipping
 * that document -- is exercisable with plain stubs (fileops.test.ts), with no
 * DOM and no IPC involved.
 *
 * Written as a loop even though Checkpoint B only ever passed one document:
 * Checkpoint C adds tabs, and every dirty document in the list must be saved
 * to *its own* path -- see main.ts's `saveDocumentForQuit`, which is what
 * closes over each document's own id rather than reading the active one.
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
