import type { EditorState, Text } from '@codemirror/state';

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
}

export interface AppState {
  documents: Document[];
  activeDocumentId: string | null;
  /** Resolved light/dark, whatever the source (manual or system). */
  isDark: boolean;
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
  };
}
