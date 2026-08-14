/**
 * The impure layer that connects Task 1's pure `AppState` operations
 * (state/documents.ts) to the one real `EditorView` and the filesystem.
 * Nothing here duplicates state/documents.ts's decisions about which tab
 * activates or what goes on the reopen stack — this module only ever calls
 * into those functions and then does the CodeMirror/IPC side effect that
 * follows from the result.
 *
 * This file and `files/fileops.ts` import each other (see fileops.ts's
 * header comment for why that is safe) — this one for `saveDocument` and
 * `displayName`, so `closeDocumentWithPrompt` saves the exact document it was
 * asked about rather than whatever happens to be on screen.
 */
import { EditorState } from '@codemirror/state';
import { ReadFile, SetActiveDocumentDir } from '../../wailsjs/go/app/App';
import { buildExtensions, publishActiveFormats } from '../editor/extensions';
import { confirmSave } from '../ui/confirmdialog';
import { createUntitledDocument, isDirty, type Document } from '../state/document';
import { activateDocument, addDocument, closeDocument, takeReopenPath } from '../state/documents';
import { getEditorView, store } from '../state/appcontext';
import { displayName, saveDocument } from './fileops';

/**
 * The shape `openDocumentInNewTab` needs from a freshly read file. Structurally
 * compatible with `app.FileContents` (wailsjs/go/models.ts), which is what
 * `ReadFile` actually returns — `FileContents` additionally carries `mixed`,
 * which this module has no use for, so the parameter type only names what it
 * reads.
 */
export interface FileContentsLike {
  path: string;
  content: string;
  encoding: string;
  lineEnding: string;
}

/**
 * Keeps Go's asset handler pointed at the active document's folder, which is
 * what relative image paths in the preview resolve against (design §5.7). An
 * unsaved document has no folder, and the empty string is how the handler is
 * told to refuse everything.
 *
 * Fire-and-forget: a failure here means local images do not load, which the
 * preview already renders as a placeholder. It must never block a tab switch.
 */
export function documentDirOf(filePath: string | null): string {
  if (filePath === null) return '';

  const cut = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'));
  // No separator at all: a bare filename has no directory to resolve against.
  // The dialogs always return absolute paths, so this is defensive.
  if (cut === -1) return '';

  // `C:\post.md` must give `C:\`, not `C:`. A bare drive letter is a
  // *drive-relative* path on Windows, so `filepath.Join("C:", "x.png")` yields
  // `C:x.png`, which the OS resolves against the process working directory --
  // measured serving a file from the repo folder rather than the document's.
  // Keeping the separator makes it absolute. `/post.md` needs the same
  // treatment for the same reason on the Linux build.
  const dir = filePath.slice(0, cut);
  return dir === '' || /^[A-Za-z]:$/.test(dir) ? filePath.slice(0, cut + 1) : dir;
}

export function publishActiveDocumentDir(filePath: string | null): void {
  void SetActiveDocumentDir(documentDirOf(filePath));
}

/** Mints an untitled document with a real `EditorState`, ready to become a new tab. */
export function makeUntitledDocument(): Document {
  return createUntitledDocument(
    EditorState.create({ doc: '', extensions: buildExtensions(store.getState().isDark) }),
  );
}

/**
 * Swaps `id`'s `EditorState` into the single shared view and makes it the
 * active tab, preserving scroll position across the switch.
 *
 * "Outgoing" is identified by which document's `EditorState` the view is
 * *currently* holding (`d.editorState === view.state`), not by
 * `state.activeDocumentId`. Those two can already disagree by the time this
 * runs: `openDocumentInNewTab` calls `addDocument`, which activates the new
 * tab in the store, before ever calling this function — reading
 * `activeDocumentId` at that point would identify the *incoming* document as
 * its own outgoing one and file its scroll snapshot against the wrong
 * document. The view is the ground truth for what's actually on screen.
 *
 * An unknown `id` is a no-op, matching `activateDocument`'s own contract.
 */
export function switchToDocument(id: string): void {
  const state = store.getState();

  const incoming = state.documents.find((d) => d.id === id);
  if (!incoming) return;

  // Resolved only once an incoming document is confirmed to exist: a caller
  // handed a stale or unknown id should get a clean no-op even if that
  // happened to run before the view was ever constructed, rather than a
  // throw from getEditorView() over an id this function was going to reject
  // anyway.
  const view = getEditorView();
  const outgoing = state.documents.find((d) => d.editorState === view.state) ?? null;
  // Nothing to swap when the requested tab is already the one on screen
  // (e.g. a caller that already activated it, or a redundant switch to the
  // current tab) -- doing the swap anyway would replay a stale scroll
  // snapshot and pointlessly reinitialise the view's plugins.
  const switchingView = outgoing === null || outgoing.id !== incoming.id;

  // Capture the outgoing document's scroll position before anything else
  // changes, and key the store write off `outgoing.id` (resolved above, from
  // view identity) rather than re-deriving it after activateDocument runs --
  // that call is what reassigns activeDocumentId, so capturing afterward off
  // that field would file the snapshot against the wrong document.
  if (switchingView && outgoing) {
    const scrollSnapshot = view.scrollSnapshot();
    store.setState((prev) => ({
      ...prev,
      documents: prev.documents.map((doc) =>
        doc.id === outgoing.id ? { ...doc, scrollSnapshot } : doc,
      ),
    }));
  }

  store.setState((prev) => activateDocument(prev, id));

  if (switchingView) {
    // CodeMirror's `setState()` fully reinitialises the view's plugins from
    // scratch rather than running an update through the normal dispatch
    // path, so it never invokes `EditorView.updateListener` (Checkpoint B's
    // review verified this against `@codemirror/view`'s source: `setState`
    // never constructs a `ViewUpdate` or reads the `updateListener` facet;
    // only `update()`, the dispatch path, does). `editor/extensions.ts`'s
    // `syncActiveDocument` therefore cannot fire between this call and the
    // `activateDocument` above and write the outgoing document's state into
    // whatever `activeDocumentId` now points at.
    view.setState(incoming.editorState);
    if (incoming.scrollSnapshot) view.dispatch({ effects: incoming.scrollSnapshot });

    // The other side of that same coin: `syncActiveFormats` is an
    // updateListener too, so it does not fire here either -- and unlike
    // `syncActiveDocument`, it needs to. Without this the toolbar keeps
    // showing the outgoing document's active formatting until the user types.
    publishActiveFormats(view.state);

    // Same reasoning again: Go's asset handler (design §5.7) must track
    // whichever document is now on screen, and this is the one place every
    // caller of this function -- new tab, tab-bar click, Ctrl+Tab, a tab
    // closing into whatever is next -- funnels through.
    publishActiveDocumentDir(incoming.filePath);
  }
}

/** Builds a new tab from freshly read file contents and switches to it. */
export function openDocumentInNewTab(contents: FileContentsLike): void {
  const editorState = EditorState.create({
    doc: contents.content,
    extensions: buildExtensions(store.getState().isDark),
  });

  const doc: Document = {
    id: crypto.randomUUID(),
    filePath: contents.path,
    editorState,
    savedDoc: editorState.doc,
    viewMode: 'source',
    previousViewMode: 'source',
    // FileContentsLike widens Go's Encoding/LineEnding enums to plain
    // `string` (mirrors wailsjs/go/models.ts's widening of app.FileContents),
    // but Go only ever sends one of Document's literal members — the cast
    // just restores what the binding's typing lost.
    encoding: contents.encoding as Document['encoding'],
    lineEnding: contents.lineEnding as Document['lineEnding'],
    scrollSnapshot: null,
  };

  store.setState((prev) => addDocument(prev, doc));
  switchToDocument(doc.id);
}

/**
 * Closes `id` after resolving any unsaved changes, and switches the view to
 * whatever ends up active. Resolves to false exactly when the user cancelled
 * — either directly, or by a Save that failed or was itself cancelled (e.g. a
 * cancelled Save As), which must never be treated as permission to discard.
 *
 * Saves through `saveDocument(id)`, not `saveActive()`: `id` may name a
 * background tab, and saving the active document instead would silently
 * write the wrong tab's text over this one's file — the exact latent bug
 * this task exists to fix (see fileops.ts's `saveDocument` doc comment).
 */
export async function closeDocumentWithPrompt(id: string): Promise<boolean> {
  const doc = store.getState().documents.find((d) => d.id === id);
  if (!doc) return true; // already gone -- nothing to cancel

  if (isDirty(doc)) {
    const choice = await confirmSave(displayName(doc));
    if (choice === 'cancel') return false;
    if (choice === 'save' && !(await saveDocument(id))) return false;
  }

  store.setState((prev) => closeDocument(prev, id, makeUntitledDocument));

  const activeId = store.getState().activeDocumentId;
  if (activeId !== null) switchToDocument(activeId);

  return true;
}

/**
 * Ctrl+Shift+T: pops the most-recently-closed path off the reopen stack and
 * opens it in a new tab. A path that no longer reads (deleted or moved since
 * it was closed) is logged and dropped rather than retried — it is already
 * off the stack by the time the read is attempted, so a missing file can't
 * wedge the command for next time.
 */
export async function reopenLastClosed(): Promise<void> {
  const { state, path } = takeReopenPath(store.getState());
  store.setState(() => state);
  if (path === null) return;

  let contents;
  try {
    contents = await ReadFile(path);
  } catch (error) {
    console.error(`hashpad: failed to reopen ${path}`, error);
    return;
  }

  openDocumentInNewTab(contents);
}
