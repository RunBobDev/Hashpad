import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { createUntitledDocument, isDirty } from './document';

describe('isDirty', () => {
  it('is false for a freshly created document', () => {
    const doc = createUntitledDocument(EditorState.create({ doc: 'hello' }));

    expect(isDirty(doc)).toBe(false);
  });

  it('is true once the editor state diverges from the saved doc', () => {
    const doc = createUntitledDocument(EditorState.create({ doc: 'hello' }));
    const changed = doc.editorState.update({ changes: { from: 5, insert: '!' } }).state;
    const edited = { ...doc, editorState: changed };

    expect(isDirty(edited)).toBe(true);
  });

  it('is false again once savedDoc is updated to match the edited text', () => {
    const doc = createUntitledDocument(EditorState.create({ doc: 'hello' }));
    const changed = doc.editorState.update({ changes: { from: 5, insert: '!' } }).state;
    const edited = { ...doc, editorState: changed };
    const saved = { ...edited, savedDoc: changed.doc };

    expect(isDirty(saved)).toBe(false);
  });
});
