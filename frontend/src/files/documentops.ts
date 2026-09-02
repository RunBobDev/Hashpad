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
import { ReadFile } from '../../wailsjs/go/app/App';
import { buildExtensions, publishActiveFormats, publishStatus } from '../editor/extensions';
import { confirmSave } from '../ui/confirmdialog';
import {
  createUntitledDocument,
  isDirty,
  previousViewModeFor,
  type Document,
  resolveViewMode,
} from '../state/document';
import {
  activateDocument,
  addDocument,
  closeDocument,
  dropScratchDocuments,
  takeReopenPath,
} from '../state/documents';
import { getEditorView, store } from '../state/appcontext';
import { displayName, saveDocument } from './fileops';

/**
 * The shape `openDocumentInNewTab` needs from a freshly read file. Structurally
 * compatible with `app.FileContents` (wailsjs/go/models.ts), which is what
 * `ReadFile` actually returns.
 *
 * `mixed` used to be omitted here as something this module had no use for. It
 * has one now: saving flattens a mixed file to a single convention, and the
 * status bar's line-ending segment says so in its tooltip. Optional rather than
 * required because `fileops.test.ts` and `main.test.ts` build these by hand,
 * and a missing flag should mean "not mixed" rather than a compile error in
 * every fixture.
 */
export interface FileContentsLike {
  path: string;
  content: string;
  encoding: string;
  lineEnding: string;
  mixed?: boolean;
}

/**
 * The folder relative image paths in the preview resolve against (design §5.7).
 * `preview/pane.ts` calls this at render time and puts the answer in the asset
 * URL, so no state is published anywhere and there is nothing to go stale. An
 * unsaved document has no folder, and the empty string says so.
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

/** Mints an untitled document with a real `EditorState`, ready to become a new tab. */
export function makeUntitledDocument(): Document {
  return createUntitledDocument(
    EditorState.create({
      doc: '',
      extensions: buildExtensions(
        store.getState().isDark,
        store.getState().wordWrap,
        store.getState().editorBehaviour,
      ),
    }),
    // Read from the store rather than defaulted, the same as the three above:
    // File > New in a window where the preview is open should keep it open.
    resolveViewMode(store.getState().defaultViewMode, store.getState().recentViewModes, false),
    // SPEC §6.13's `files.defaultEncoding`. Only untitled documents get it --
    // `openDocumentInNewTab` below takes the encoding Go detected, because
    // overriding a detected encoding with a default would transcode the file
    // the first time the user saved it.
    store.getState().defaultEncoding,
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

    // The other side of that same coin: `syncActiveFormats` and `syncStatus`
    // are updateListeners too, so neither fires here -- and unlike
    // `syncActiveDocument`, both need to. Without these the toolbar keeps
    // showing the outgoing document's active formatting until the user types,
    // and the status bar keeps showing its line, column and counts.
    publishActiveFormats(view.state);
    publishStatus(view.state);
  }
}

/**
 * Builds a new tab from freshly read file contents and switches to it — or
 * switches to the tab that already holds this file.
 *
 * **One tab per file.** Reported by the owner: opening a file that was already
 * open gave a second tab over the same path. That is worse than untidy — two
 * tabs over one file are two buffers that drift apart, and then whichever is
 * saved second silently wins.
 *
 * The existing tab is *focused* rather than the request being ignored. "Nothing
 * happens" is only right when that tab is already in front; when it is a
 * background tab, Open would otherwise appear to have done nothing at all.
 * `switchToDocument` already no-ops on a redundant switch to the current tab,
 * so the in-front case really does do nothing.
 *
 * Guarded here rather than in `openPaths`, which is where the dialog and the
 * drop meet: `reopenLastClosed` reaches this function without going through
 * that one, and it can produce a duplicate too -- close a file, open it again
 * from the dialog, then press Ctrl+Shift+T. One guard where every route
 * converges, rather than one per caller.
 *
 * **Exact string comparison, and that is a deliberate ceiling.** The same file
 * spelled differently -- `C:\A.md` against `C:\a.md`, or a path carrying `..`
 * -- would still open twice. Every route in arrives with a path the OS
 * produced: the file dialog, a native drop, and `reopenLastClosed`'s record of
 * a path that came from one of those. A non-canonical spelling cannot arise
 * from the UI, so normalising here would be guarding against nothing. If it
 * ever can, the fix is Go's `os.SameFile`, which compares file identity rather
 * than text and gets case, symlinks and short names right in one call.
 */
export function openDocumentInNewTab(contents: FileContentsLike): void {
  // No `doc.filePath !== null` guard beside this, and its absence is deliberate:
  // `contents.path` is typed `string` and Go always sends one, so an untitled
  // tab's `null` can never equal it. That guard was written, and mutation
  // testing removed it -- deleting it broke nothing, because it could not.
  const alreadyOpen = store.getState().documents.find((doc) => doc.filePath === contents.path);
  if (alreadyOpen !== undefined) {
    switchToDocument(alreadyOpen.id);
    return;
  }

  const editorState = EditorState.create({
    doc: contents.content,
    extensions: buildExtensions(
      store.getState().isDark,
      store.getState().wordWrap,
      store.getState().editorBehaviour,
    ),
  });

  // Not spelled `'source'` any more, which is what the owner reported: opening
  // a file with the preview showing closed it, because every tab was minted in
  // source mode regardless of the window it was opening into.
  // `openedViewMode`, not `defaultViewMode`, and `allowPreview` true: this is a
  // document that exists and has something to read, where a new empty one does
  // not (design §4.27a). Every route in reaches here -- Ctrl+O, File > Open, a
  // drop, Ctrl+Shift+T, and a file that launched Hashpad -- which is what makes
  // this one line the whole of the setting rather than a special case per route.
  const state = store.getState();
  const viewMode = resolveViewMode(state.openedViewMode, state.recentViewModes, true);

  const doc: Document = {
    id: crypto.randomUUID(),
    filePath: contents.path,
    editorState,
    savedDoc: editorState.doc,
    viewMode,
    previousViewMode: previousViewModeFor(viewMode),
    // FileContentsLike widens Go's Encoding/LineEnding enums to plain
    // `string` (mirrors wailsjs/go/models.ts's widening of app.FileContents),
    // but Go only ever sends one of Document's literal members — the cast
    // just restores what the binding's typing lost.
    encoding: contents.encoding as Document['encoding'],
    lineEnding: contents.lineEnding as Document['lineEnding'],
    // Freshly read, so what is on disk is exactly what was just detected --
    // the document opens clean, and only a later change to either makes it
    // dirty (see `isDirty`).
    savedEncoding: contents.encoding as Document['encoding'],
    savedLineEnding: contents.lineEnding as Document['lineEnding'],
    mixedLineEndings: contents.mixed ?? false,
    scrollSnapshot: null,
  };

  store.setState((prev) => addDocument(prev, doc));
  // The blank tab the app starts with has served its purpose the moment a real
  // document arrives, and leaving it behind is what the owner reported. Run
  // after `addDocument` so there is always something left to activate, and
  // before `switchToDocument` so the view swaps once rather than twice.
  store.setState((prev) => dropScratchDocuments(prev, doc.id));
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
