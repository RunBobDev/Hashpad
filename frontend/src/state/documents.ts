/**
 * Pure multi-document state operations. Every function here takes an
 * `AppState` and returns a new one; none mutates its argument or anything
 * reachable from it. Keeping this file free of CodeMirror (no `EditorState`
 * import) and the DOM is what makes tab semantics — closing the right
 * neighbour, not losing the reopen stack, off-by-ones in reorder — testable
 * exhaustively without a mounted editor. UI tasks (menu commands, the tab
 * bar, keyboard shortcuts) call into this module and trust its semantics
 * rather than re-deriving them.
 */
import type { AppState, Document } from './document';

/**
 * Cap on `closedPaths` (Ctrl+Shift+T's reopen stack). Unbounded growth would
 * turn a long session of opening and closing files into an ever-growing
 * array for a feature that only ever looks at the front of it.
 */
export const REOPEN_STACK_LIMIT = 10;

/** Appends `doc` and makes it the active tab — the shape of both File > New and File > Open. */
export function addDocument(state: AppState, doc: Document): AppState {
  return {
    ...state,
    documents: [...state.documents, doc],
    activeDocumentId: doc.id,
  };
}

/**
 * Closes the document with `id`. `makeUntitled` is invoked only when this
 * removes the last remaining document — the app is never left with zero
 * tabs — and its result becomes both the sole document and the active one.
 * The factory is a parameter (rather than this module importing
 * `createUntitledDocument` and building an `EditorState` itself) precisely so
 * this file never needs CodeMirror.
 *
 * An unknown `id` is a no-op: it must never blank `activeDocumentId`.
 */
export function closeDocument(state: AppState, id: string, makeUntitled: () => Document): AppState {
  const closedIndex = state.documents.findIndex((d) => d.id === id);
  if (closedIndex === -1) return { ...state };

  const closed = state.documents[closedIndex]!;
  const remaining = state.documents.filter((d) => d.id !== id);

  // Only a path ever goes on the reopen stack (SPEC §6.3: discarded buffers
  // must not resurrect). An untitled document has nothing to reopen.
  const closedPaths =
    closed.filePath !== null
      ? [closed.filePath, ...state.closedPaths].slice(0, REOPEN_STACK_LIMIT)
      : state.closedPaths;

  if (remaining.length === 0) {
    const fresh = makeUntitled();
    return {
      ...state,
      documents: [fresh],
      activeDocumentId: fresh.id,
      closedPaths,
    };
  }

  // Only reassign activeDocumentId when the closed tab was the active one --
  // closing a background tab must never move focus. Prefer the successor
  // that slid into the closed tab's index (the tab now to its right); if the
  // closed tab was rightmost, that index is past the end, so fall back to
  // the new last element.
  const activeDocumentId =
    state.activeDocumentId === id
      ? (remaining[closedIndex] ?? remaining[remaining.length - 1])!.id
      : state.activeDocumentId;

  return { ...state, documents: remaining, activeDocumentId, closedPaths };
}

/** Switches the active tab to `id`. An unknown `id` is a no-op, not a blank. */
export function activateDocument(state: AppState, id: string): AppState {
  if (!state.documents.some((d) => d.id === id)) return { ...state };
  return { ...state, activeDocumentId: id };
}

/**
 * Moves the document `id` to `toIndex` in the tab strip (drag-to-reorder).
 * `toIndex` is clamped into range rather than rejected, so a drop past the
 * last tab still lands somewhere sensible instead of doing nothing.
 * `activeDocumentId` is a document id, not an index, so reordering the array
 * around it already preserves which document is active without any extra
 * bookkeeping here.
 */
export function reorderDocument(state: AppState, id: string, toIndex: number): AppState {
  const fromIndex = state.documents.findIndex((d) => d.id === id);
  if (fromIndex === -1) return { ...state };

  const clampedIndex = Math.max(0, Math.min(toIndex, state.documents.length - 1));
  if (clampedIndex === fromIndex) return { ...state };

  const documents = [...state.documents];
  const [moved] = documents.splice(fromIndex, 1);
  documents.splice(clampedIndex, 0, moved!);

  return { ...state, documents };
}

/**
 * The id of the tab `delta` positions from the active one (Ctrl+Tab /
 * Ctrl+Shift+Tab), wrapping past either end. With a single open document
 * that document is its own neighbour in both directions, rather than this
 * returning null and the caller having to special-case it.
 */
export function neighbourId(state: AppState, delta: 1 | -1): string | null {
  const { documents, activeDocumentId } = state;
  if (documents.length === 0) return null;

  const index = documents.findIndex((d) => d.id === activeDocumentId);
  if (index === -1) return null;

  const wrapped = (index + delta + documents.length) % documents.length;
  return documents[wrapped]!.id;
}

/** The document at 1-based `position` (Ctrl+Alt+1..9), or null past the end. */
export function documentAtPosition(state: AppState, position: number): Document | null {
  return state.documents[position - 1] ?? null;
}

/**
 * Pops the most-recently-closed path off the reopen stack for Ctrl+Shift+T.
 * Returns the updated state alongside the path (rather than requiring a
 * separate mutation) so the caller can't read the path without also
 * committing its removal.
 */
export function takeReopenPath(state: AppState): { state: AppState; path: string | null } {
  const [path, ...rest] = state.closedPaths;
  if (path === undefined) return { state: { ...state }, path: null };
  return { state: { ...state, closedPaths: rest }, path };
}

/** The currently active document, or null if there is none. */
export function activeDocument(state: AppState): Document | null {
  return state.documents.find((d) => d.id === state.activeDocumentId) ?? null;
}
