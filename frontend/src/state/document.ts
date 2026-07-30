import type { EditorState, StateEffect, Text } from '@codemirror/state';

/**
 * Dirty state is derived (`!editorState.doc.eq(savedDoc)`), never stored as a
 * flag — that avoids an entire category of bugs where the flag and reality
 * drift apart. CodeMirror owns the text; this model deliberately does not
 * duplicate it.
 */
export interface Document {
  id: string;
  filePath: string | null;
  editorState: EditorState;
  savedDoc: Text;
  viewMode: 'source' | 'live' | 'split';
  encoding: 'utf-8' | 'utf-8-bom' | 'utf-16le';
  lineEnding: 'lf' | 'crlf';
  /**
   * CodeMirror's scroll position, captured as a StateEffect when this document
   * is switched away from and replayed when it comes back. Design §4.4 dropped
   * a numeric scrollTop in favour of this — the effect survives document
   * changes that a raw pixel offset would not.
   */
  scrollSnapshot: StateEffect<unknown> | null;
}

export interface AppState {
  documents: Document[];
  activeDocumentId: string | null;
  /** Resolved light/dark, whatever the source (manual or system). */
  isDark: boolean;
  /**
   * File paths of recently closed documents, most recent first, for
   * Ctrl+Shift+T. Only paths — never buffers. Reopening re-reads from disk, so
   * a tab closed with Don't Save cannot resurrect the discarded text, which
   * SPEC §6.3 requires to be gone.
   */
  closedPaths: string[];
}

export function isDirty(doc: Document): boolean {
  return !doc.editorState.doc.eq(doc.savedDoc);
}

/** A never-saved, empty document — what the app opens with. */
export function createUntitledDocument(editorState: EditorState): Document {
  return {
    id: crypto.randomUUID(),
    filePath: null,
    editorState,
    savedDoc: editorState.doc,
    viewMode: 'source',
    encoding: 'utf-8',
    lineEnding: 'crlf',
    scrollSnapshot: null,
  };
}
