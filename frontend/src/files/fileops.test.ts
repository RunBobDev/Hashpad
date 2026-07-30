import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createUntitledDocument, type Document } from '../state/document';
import { displayName, windowTitle } from './fileops';

function docWith(overrides: Partial<Document>): Document {
  const base = createUntitledDocument(EditorState.create({ doc: 'hello' }));
  return { ...base, ...overrides };
}

describe('displayName', () => {
  it('is Untitled for a never-saved document', () => {
    expect(displayName(docWith({}))).toBe('Untitled');
  });

  it('is the basename of a Windows path', () => {
    expect(displayName(docWith({ filePath: 'C:\\notes\\todo.md' }))).toBe('todo.md');
  });

  it('is the basename of a POSIX path', () => {
    expect(displayName(docWith({ filePath: '/home/user/notes/todo.md' }))).toBe('todo.md');
  });

  it('handles a bare filename with no directory', () => {
    expect(displayName(docWith({ filePath: 'todo.md' }))).toBe('todo.md');
  });
});

describe('windowTitle', () => {
  it('names the app when nothing is open', () => {
    expect(windowTitle(null)).toBe('Hashpad');
  });

  it('shows a clean document without a marker', () => {
    const state = EditorState.create({ doc: 'hello' });
    const doc = docWith({ editorState: state, savedDoc: state.doc, filePath: 'a.md' });
    expect(windowTitle(doc)).toBe('a.md — Hashpad');
  });

  it('marks a dirty document', () => {
    const doc = docWith({
      editorState: EditorState.create({ doc: 'changed' }),
      savedDoc: EditorState.create({ doc: 'original' }).doc,
      filePath: 'a.md',
    });
    expect(windowTitle(doc)).toBe('• a.md — Hashpad');
  });
});
