import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { store } from '../state/appcontext';
import { createUntitledDocument, isDirty, type Document } from '../state/document';
import { displayName, markSaved, windowTitle } from './fileops';

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

  it('shows the • marker exactly when isDirty is true', () => {
    const clean = docWith({
      editorState: EditorState.create({ doc: 'same' }),
      savedDoc: EditorState.create({ doc: 'same' }).doc,
      filePath: 'a.md',
    });
    const dirty = docWith({
      editorState: EditorState.create({ doc: 'changed' }),
      savedDoc: EditorState.create({ doc: 'original' }).doc,
      filePath: 'a.md',
    });

    expect(isDirty(clean)).toBe(false);
    expect(windowTitle(clean).startsWith('• ')).toBe(isDirty(clean));

    expect(isDirty(dirty)).toBe(true);
    expect(windowTitle(dirty).startsWith('• ')).toBe(isDirty(dirty));
  });
});

/**
 * These three cover the two data-loss failure modes a code review found:
 * nothing ever wrote the live `EditorView`'s state back into the store, so a
 * never-saved document's `editorState`/`savedDoc` never diverged (permanently
 * clean, dirty-discard prompts never fired) and, separately, a saved
 * document's `editorState` stayed frozen while `savedDoc` advanced
 * (permanently dirty, the title's `•` never cleared). `editor/extensions.ts`
 * fixes the first by syncing `editorState` on every doc change; `markSaved`
 * (exercised directly here, without the DOM- and IPC-bound `saveActive`)
 * fixes the second.
 */
describe('dirty tracking', () => {
  it('is dirty when editorState has diverged from savedDoc', () => {
    const original = EditorState.create({ doc: 'hello' });
    const changed = original.update({ changes: { from: 5, insert: '!' } }).state;
    const doc = docWith({ editorState: changed, savedDoc: original.doc });

    expect(isDirty(doc)).toBe(true);
  });

  it('is not dirty when editorState equals savedDoc', () => {
    const state = EditorState.create({ doc: 'hello' });
    const doc = docWith({ editorState: state, savedDoc: state.doc });

    expect(isDirty(doc)).toBe(false);
  });

  it('becomes clean after markSaved records the live text as saved (regression: stuck-dirty after save)', () => {
    const original = EditorState.create({ doc: 'hello' });
    const changed = original.update({ changes: { from: 5, insert: '!' } }).state;
    const doc = docWith({ editorState: changed, savedDoc: original.doc });
    expect(isDirty(doc)).toBe(true); // sanity: starts dirty, same as a real unsaved edit

    store.setState((prev) => ({ ...prev, documents: [doc], activeDocumentId: doc.id }));
    markSaved(doc.id, changed.doc);

    const saved = store.getState().documents.find((d) => d.id === doc.id);
    expect(saved).toBeDefined();
    expect(isDirty(saved!)).toBe(false);
  });
});
