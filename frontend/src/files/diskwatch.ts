/**
 * SPEC §7.4: what happens when an open file changes on disk.
 *
 * Go watches the files (internal/app/watch.go) and pushes what it finds, with
 * the file already read and decoded. This module tells Go which files are open,
 * and decides what each change means for the document holding it. Every
 * decision is synchronous -- nothing can be typed between looking at the buffer
 * and acting on it -- which is why Go sends the contents rather than a bare
 * path for this side to read back.
 */
import { isolateHistory } from '@codemirror/commands';
import type { Text } from '@codemirror/state';
import { SetWatchedFiles } from '../../wailsjs/go/app/App';
import { EventsOn } from '../../wailsjs/runtime/runtime';
import { getEditorView, store } from '../state/appcontext';
import type { AppState, DiskFile, Document } from '../state/document';
import type { FileContentsLike } from './documentops';
import { currentText } from './fileops';

export const FILE_CHANGED_EVENT = 'file:changed';
export const FILE_DELETED_EVENT = 'file:deleted';

function findDocument(id: string): Document | undefined {
  return store.getState().documents.find((doc) => doc.id === id);
}

function findByPath(path: string): Document | undefined {
  return store.getState().documents.find((doc) => doc.filePath === path);
}

function update(id: string, patch: Partial<Document>): void {
  store.setState((prev) => ({
    ...prev,
    documents: prev.documents.map((doc) => (doc.id === id ? { ...doc, ...patch } : doc)),
  }));
}

/**
 * The single change that turns `before` into `after`: whatever the two share at
 * the start and at the end is left alone. Null when they are equal.
 */
export function minimalChange(
  before: string,
  after: string,
): { from: number; to: number; insert: string } | null {
  if (before === after) return null;

  const shorter = Math.min(before.length, after.length);
  let start = 0;
  while (start < shorter && before.charCodeAt(start) === after.charCodeAt(start)) start++;

  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)
  ) {
    endBefore--;
    endAfter--;
  }
  return { from: start, to: endBefore, insert: after.slice(start, endAfter) };
}

/**
 * Replaces `doc`'s buffer with `file` and records it as saved.
 *
 * One minimal change rather than the whole text, so the caret and the scroll
 * position stay put whenever the edit was somewhere else -- nearly always. And
 * an ordinary transaction, so Ctrl+Z takes it back, which is what makes the
 * Reload button safe to have clicked by mistake.
 *
 * **Its own undo step, always.** CodeMirror folds edits made within half a
 * second of each other into one, so without `isolateHistory` a Reload clicked
 * just after typing undid together with the typing -- one Ctrl+Z, and the
 * edits Reload discarded were gone too. Typing straight after a silent reload
 * would merge the other way.
 */
function applyDiskFile(doc: Document, file: DiskFile): void {
  const change = minimalChange(
    currentText(doc).toString(),
    doc.editorState.toText(file.content).toString(),
  );
  const spec = change && { changes: change, annotations: isolateHistory.of('full') };
  const settled = {
    encoding: file.encoding,
    savedEncoding: file.encoding,
    lineEnding: file.lineEnding,
    savedLineEnding: file.lineEnding,
    mixedLineEndings: file.mixed,
    diskChange: null,
  };

  if (doc.id === store.getState().activeDocumentId) {
    // The active document's text is the view's (fileops.ts `currentText`).
    // Dispatching writes the store too, through syncActiveDocument; writing the
    // store alone would be overwritten by the view on the next keystroke.
    const view = getEditorView();
    if (spec) view.dispatch(spec);
    update(doc.id, { ...settled, savedDoc: view.state.doc });
    return;
  }

  const editorState = spec ? doc.editorState.update(spec).state : doc.editorState;
  update(doc.id, { ...settled, editorState, savedDoc: editorState.doc });
}

/**
 * A watched file now holds `incoming`. In order:
 *
 * 1. The buffer already says exactly this: the disk caught up with it. Record
 *    it as saved; there is nothing to tell anyone.
 * 2. The disk says what it said when last read or saved -- a touch, or a change
 *    reverted. Any conflict it had raised is over. Go reports the first event
 *    on any path it has no record for, so without this a touch under unsaved
 *    edits would raise a bar over nothing.
 * 3. The buffer has no edits of its own: reload silently, as §7.4 says.
 * 4. Both sides changed. Hold the disk's version and let the bar ask.
 */
export function handleDiskChange(incoming: FileContentsLike): void {
  const doc = findByPath(incoming.path);
  // Closed, or moved by Save As, since Go was last told.
  if (!doc) return;

  const file: DiskFile = {
    content: incoming.content,
    // Go only ever sends one of these members; the binding widened them.
    encoding: incoming.encoding as DiskFile['encoding'],
    lineEnding: incoming.lineEnding as DiskFile['lineEnding'],
    mixed: incoming.mixed ?? false,
  };
  const onDisk = doc.editorState.toText(file.content);
  const holds = (text: Text, encoding: string, lineEnding: string): boolean =>
    encoding === file.encoding && lineEnding === file.lineEnding && text.eq(onDisk);

  const buffer = currentText(doc);
  if (holds(buffer, doc.encoding, doc.lineEnding)) {
    update(doc.id, {
      savedDoc: buffer,
      savedEncoding: file.encoding,
      savedLineEnding: file.lineEnding,
      mixedLineEndings: file.mixed,
      diskChange: null,
    });
    return;
  }
  if (holds(doc.savedDoc, doc.savedEncoding, doc.savedLineEnding)) {
    update(doc.id, { diskChange: null });
    return;
  }
  const unedited =
    buffer.eq(doc.savedDoc) &&
    doc.encoding === doc.savedEncoding &&
    doc.lineEnding === doc.savedLineEnding;
  if (unedited) {
    applyDiskFile(doc, file);
    return;
  }
  update(doc.id, { diskChange: file });
}

/** A watched file is gone. The buffer is now the only copy -- see `isDirty`. */
export function handleDiskDeleted(path: string): void {
  const doc = findByPath(path);
  if (doc) update(doc.id, { diskChange: 'deleted' });
}

/** The bar's Reload: the disk's version replaces the buffer's edits, undoably. */
export function reloadFromDisk(id: string): void {
  const doc = findDocument(id);
  if (!doc || doc.diskChange === null || doc.diskChange === 'deleted') return;
  applyDiskFile(doc, doc.diskChange);
}

/**
 * The bar's Keep mine. The buffer stays as it is and the disk's version becomes
 * what it is measured against: `savedDoc` keeps meaning "what is on disk", so
 * the document stays dirty and the next save overwrites the file on purpose.
 */
export function keepMine(id: string): void {
  const doc = findDocument(id);
  if (!doc || doc.diskChange === null || doc.diskChange === 'deleted') return;
  const file = doc.diskChange;
  update(id, {
    savedDoc: doc.editorState.toText(file.content),
    savedEncoding: file.encoding,
    savedLineEnding: file.lineEnding,
    mixedLineEndings: file.mixed,
    diskChange: null,
  });
}

/** Every open file's path. An array of strings, which the store compares by element. */
function watchedPaths(state: AppState): string[] {
  return state.documents.flatMap((doc) => (doc.filePath === null ? [] : [doc.filePath]));
}

/**
 * Keeps Go's watch list equal to the open files, and listens for what it
 * reports. Returns a teardown.
 */
export function mountDiskWatch(
  on: typeof EventsOn = EventsOn,
  setWatched: (paths: string[]) => Promise<void> = SetWatchedFiles,
): () => void {
  const tell = (paths: string[]): void => {
    // Nothing waits on this. A watch that failed costs change detection, not
    // the edit in progress, and Go logs why.
    setWatched(paths).catch((error: unknown) => {
      console.error('hashpad: could not update the watched files', error);
    });
  };

  tell(watchedPaths(store.getState()));
  const unsubscribe = store.subscribe(watchedPaths, tell);
  const offChanged = on(FILE_CHANGED_EVENT, handleDiskChange);
  const offDeleted = on(FILE_DELETED_EVENT, handleDiskDeleted);

  return () => {
    unsubscribe();
    offChanged();
    offDeleted();
  };
}
