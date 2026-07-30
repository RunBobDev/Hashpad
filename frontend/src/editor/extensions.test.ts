// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { store, setEditorView } from '../state/appcontext';
import { createUntitledDocument, isDirty } from '../state/document';
import { buildExtensions } from './extensions';

/**
 * The rest of the suite runs under Vitest's default DOM-less `node`
 * environment (see vite.config.ts), because CodeMirror's `EditorView`
 * genuinely needs a `document` to construct itself — it always builds its
 * own DOM subtree even when given no `parent` to mount into. This file
 * opts into jsdom (the `// @vitest-environment jsdom` docblock above, which
 * must stay on line 1) specifically so it can construct a real `EditorView`
 * and prove the update listener registered in `buildExtensions` actually
 * fires end-to-end, rather than asserting only that the right callback was
 * passed to `EditorView.updateListener.of(...)`.
 */
describe('syncActiveDocument update listener', () => {
  afterEach(() => {
    // Reset the shared appcontext store so this file's writes don't leak
    // into other tests that happen to run in the same worker.
    store.setState(() => ({ documents: [], activeDocumentId: null, isDark: false, closedPaths: [] }));
  });

  it('writes a document change back into the store, flipping the active document dirty', () => {
    const initialState = EditorState.create({ doc: 'hello', extensions: buildExtensions(false) });
    const view = new EditorView({ state: initialState, parent: document.createElement('div') });
    setEditorView(view);

    // Mirrors main.ts's bootstrap: the document's EditorState is the same
    // instance the view was constructed with, so the two start in sync.
    const doc = createUntitledDocument(initialState);
    store.setState((prev) => ({ ...prev, documents: [doc], activeDocumentId: doc.id }));
    expect(isDirty(store.getState().documents[0]!)).toBe(false);

    view.dispatch({ changes: { from: 5, insert: '!' } });

    const updated = store.getState().documents.find((d) => d.id === doc.id);
    expect(updated).toBeDefined();
    expect(updated!.editorState.doc.toString()).toBe('hello!');
    expect(isDirty(updated!)).toBe(true);

    view.destroy();
  });

  it('does not touch the store on a selection-only update', () => {
    const initialState = EditorState.create({ doc: 'hello', extensions: buildExtensions(false) });
    const view = new EditorView({ state: initialState, parent: document.createElement('div') });
    setEditorView(view);

    const doc = createUntitledDocument(initialState);
    store.setState((prev) => ({ ...prev, documents: [doc], activeDocumentId: doc.id }));

    view.dispatch({ selection: { anchor: 1 } });

    const updated = store.getState().documents.find((d) => d.id === doc.id);
    expect(updated).toBeDefined();
    // Same EditorState reference: the listener never fired a store write.
    expect(updated!.editorState).toBe(doc.editorState);
    expect(isDirty(updated!)).toBe(false);

    view.destroy();
  });
});
