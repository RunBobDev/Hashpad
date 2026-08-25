import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OUTLINE_WIDTH,
  createUntitledDocument,
  EMPTY_STATUS,
  type AppState,
  type Document,
  DEFAULT_BEHAVIOUR,
} from './document';
import {
  activateDocument,
  dropScratchDocuments,
  activeDocument,
  addDocument,
  closeDocument,
  documentAtPosition,
  neighbourId,
  REOPEN_STACK_LIMIT,
  reorderDocument,
  setViewMode,
  takeReopenPath,
} from './documents';

/** A document with a stable id and optional path, so assertions can name it. */
function doc(id: string, filePath: string | null = null, text = ''): Document {
  return {
    ...createUntitledDocument(EditorState.create({ doc: text })),
    id,
    filePath,
  };
}

function stateWith(documents: Document[], activeId: string | null = null): AppState {
  return {
    documents,
    activeDocumentId: activeId ?? documents[0]?.id ?? null,
    isDark: false,
    closedPaths: [],
    activeFormats: '',
    pinnedToolbarCommands: [],
    previewSplitRatio: 0.5,
    syncScroll: true,
    wordWrap: true,
    editorBehaviour: DEFAULT_BEHAVIOUR,
    defaultViewMode: 'source',
    status: EMPTY_STATUS,
    outlineWidth: DEFAULT_OUTLINE_WIDTH,
  };
}

const untitledFactory = (): Document => doc('fresh');

describe('addDocument', () => {
  it('appends and activates the new document', () => {
    const next = addDocument(stateWith([doc('a')]), doc('b'));
    expect(next.documents.map((d) => d.id)).toEqual(['a', 'b']);
    expect(next.activeDocumentId).toBe('b');
  });

  it('does not mutate the input state', () => {
    const before = stateWith([doc('a')]);
    addDocument(before, doc('b'));
    expect(before.documents).toHaveLength(1);
  });
});

describe('closeDocument', () => {
  it('removes the document', () => {
    const next = closeDocument(stateWith([doc('a'), doc('b')]), 'a', untitledFactory);
    expect(next.documents.map((d) => d.id)).toEqual(['b']);
  });

  it('activates the tab to the right when closing the active one', () => {
    const next = closeDocument(
      stateWith([doc('a'), doc('b'), doc('c')], 'b'),
      'b',
      untitledFactory,
    );
    expect(next.activeDocumentId).toBe('c');
  });

  it('activates the tab to the left when closing the rightmost active one', () => {
    const next = closeDocument(stateWith([doc('a'), doc('b')], 'b'), 'b', untitledFactory);
    expect(next.activeDocumentId).toBe('a');
  });

  it('leaves the active document alone when closing a different one', () => {
    const next = closeDocument(stateWith([doc('a'), doc('b')], 'a'), 'b', untitledFactory);
    expect(next.activeDocumentId).toBe('a');
  });

  it('substitutes a fresh untitled document when the last tab closes', () => {
    const next = closeDocument(stateWith([doc('a')]), 'a', untitledFactory);
    expect(next.documents.map((d) => d.id)).toEqual(['fresh']);
    expect(next.activeDocumentId).toBe('fresh');
  });

  it('remembers a closed document that had a file path', () => {
    const next = closeDocument(
      stateWith([doc('a', 'C:\\notes\\a.md'), doc('b')]),
      'a',
      untitledFactory,
    );
    expect(next.closedPaths).toEqual(['C:\\notes\\a.md']);
  });

  it('does not remember a closed untitled document', () => {
    const next = closeDocument(stateWith([doc('a'), doc('b')]), 'a', untitledFactory);
    expect(next.closedPaths).toEqual([]);
  });

  it('pushes most-recently-closed to the front', () => {
    let s = stateWith([doc('a', 'a.md'), doc('b', 'b.md'), doc('c')]);
    s = closeDocument(s, 'a', untitledFactory);
    s = closeDocument(s, 'b', untitledFactory);
    expect(s.closedPaths).toEqual(['b.md', 'a.md']);
  });

  it('caps the reopen stack', () => {
    let s = stateWith(
      Array.from({ length: REOPEN_STACK_LIMIT + 3 }, (_, i) => doc(`d${i}`, `d${i}.md`)),
    );
    for (let i = 0; i < REOPEN_STACK_LIMIT + 2; i++) {
      s = closeDocument(s, `d${i}`, untitledFactory);
    }
    // Asserting identity, not just length: trimming from the wrong end would
    // still leave exactly REOPEN_STACK_LIMIT entries while throwing away the
    // most recent closes — the ones Ctrl+Shift+T is most likely to want.
    expect(s.closedPaths).toHaveLength(REOPEN_STACK_LIMIT);
    expect(s.closedPaths[0]).toBe('d11.md');
    expect(s.closedPaths.at(-1)).toBe('d2.md');
  });

  it('ignores an unknown id', () => {
    const before = stateWith([doc('a')]);
    const next = closeDocument(before, 'nope', untitledFactory);
    // By id, not by count: mistakenly taking the last-document branch would
    // also leave one document — but it would be a fresh untitled one, having
    // silently thrown away the document the user still had open.
    expect(next.documents.map((d) => d.id)).toEqual(['a']);
  });

  it('does not mutate the input state', () => {
    const before = stateWith([doc('a', 'a.md'), doc('b')]);
    closeDocument(before, 'a', untitledFactory);
    expect(before.documents.map((d) => d.id)).toEqual(['a', 'b']);
    expect(before.closedPaths).toEqual([]);
  });
});

describe('activateDocument', () => {
  it('activates an existing document', () => {
    expect(activateDocument(stateWith([doc('a'), doc('b')]), 'b').activeDocumentId).toBe('b');
  });

  it('ignores an unknown id rather than blanking the active document', () => {
    const next = activateDocument(stateWith([doc('a')], 'a'), 'nope');
    expect(next.activeDocumentId).toBe('a');
  });

  it('does not mutate the input state', () => {
    const before = stateWith([doc('a'), doc('b')], 'a');
    activateDocument(before, 'b');
    expect(before.activeDocumentId).toBe('a');
  });
});

describe('reorderDocument', () => {
  it('moves a document later', () => {
    const next = reorderDocument(stateWith([doc('a'), doc('b'), doc('c')]), 'a', 2);
    expect(next.documents.map((d) => d.id)).toEqual(['b', 'c', 'a']);
  });

  it('moves a document earlier', () => {
    const next = reorderDocument(stateWith([doc('a'), doc('b'), doc('c')]), 'c', 0);
    expect(next.documents.map((d) => d.id)).toEqual(['c', 'a', 'b']);
  });

  it('keeps the same document active after a move', () => {
    const next = reorderDocument(stateWith([doc('a'), doc('b')], 'a'), 'a', 1);
    expect(next.activeDocumentId).toBe('a');
  });

  it('clamps an out-of-range target index', () => {
    const next = reorderDocument(stateWith([doc('a'), doc('b')]), 'a', 99);
    expect(next.documents.map((d) => d.id)).toEqual(['b', 'a']);
  });

  it('is a no-op when the index does not change anything', () => {
    const next = reorderDocument(stateWith([doc('a'), doc('b')]), 'a', 0);
    expect(next.documents.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('is a no-op for the only document, whatever index is asked for', () => {
    const next = reorderDocument(stateWith([doc('a')]), 'a', 5);
    expect(next.documents.map((d) => d.id)).toEqual(['a']);
  });

  it('does not mutate the input state', () => {
    const before = stateWith([doc('a'), doc('b'), doc('c')]);
    reorderDocument(before, 'a', 2);
    expect(before.documents.map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('neighbourId', () => {
  it('wraps forward past the end', () => {
    expect(neighbourId(stateWith([doc('a'), doc('b')], 'b'), 1)).toBe('a');
  });

  it('wraps backward past the start', () => {
    expect(neighbourId(stateWith([doc('a'), doc('b')], 'a'), -1)).toBe('b');
  });

  it('returns the only document when there is one tab', () => {
    expect(neighbourId(stateWith([doc('a')], 'a'), 1)).toBe('a');
  });
});

describe('documentAtPosition', () => {
  it('is 1-based', () => {
    expect(documentAtPosition(stateWith([doc('a'), doc('b')]), 1)?.id).toBe('a');
    expect(documentAtPosition(stateWith([doc('a'), doc('b')]), 2)?.id).toBe('b');
  });

  it('is null past the end, so Ctrl+Alt+9 with two tabs does nothing', () => {
    expect(documentAtPosition(stateWith([doc('a')]), 9)).toBeNull();
  });

  // Position 0 and below cannot arrive from the Ctrl+Alt+1..9 bindings, but the
  // function is exported and the correct answer relies on a negative array index
  // yielding undefined rather than wrapping. Pin it so a future guard-clause
  // rewrite cannot quietly turn it into "the last tab".
  it.each([0, -1, -5])('is null for out-of-range position %i', (position) => {
    expect(documentAtPosition(stateWith([doc('a'), doc('b')]), position)).toBeNull();
  });
});

describe('takeReopenPath', () => {
  it('pops the most recent path and removes it', () => {
    const s: AppState = { ...stateWith([doc('a')]), closedPaths: ['b.md', 'a.md'] };
    const { state, path } = takeReopenPath(s);
    expect(path).toBe('b.md');
    expect(state.closedPaths).toEqual(['a.md']);
  });

  it('returns null when nothing was closed', () => {
    expect(takeReopenPath(stateWith([doc('a')])).path).toBeNull();
  });

  it('does not mutate the input state', () => {
    const before: AppState = { ...stateWith([doc('a')]), closedPaths: ['b.md', 'a.md'] };
    takeReopenPath(before);
    expect(before.closedPaths).toEqual(['b.md', 'a.md']);
  });
});

describe('setViewMode', () => {
  it('sets the mode on the named document only', () => {
    const next = setViewMode(stateWith([doc('a'), doc('b')]), 'a', 'split');
    expect(next.documents.map((d) => d.viewMode)).toEqual(['split', 'source']);
  });

  /**
   * The whole reason `remember` is a separate argument. Toggling the preview
   * on records the mode being interrupted; toggling it off must not overwrite
   * that record with 'split', or a document that was in live mode comes back
   * as source and stays there.
   */
  it('records the mode to come back to only when asked', () => {
    const on = setViewMode(stateWith([doc('a')]), 'a', 'split', 'live');
    expect(on.documents[0]!.previousViewMode).toBe('live');

    const off = setViewMode(on, 'a', 'live');
    expect(off.documents[0]!.previousViewMode).toBe('live');
  });

  it('is a no-op for an unknown id', () => {
    const before = stateWith([doc('a')]);
    const next = setViewMode(before, 'nope', 'split');
    expect(next.documents[0]!.viewMode).toBe('source');
  });

  it('does not mutate the input state', () => {
    const before = stateWith([doc('a')]);
    setViewMode(before, 'a', 'split');
    expect(before.documents[0]!.viewMode).toBe('source');
  });
});

describe('activeDocument', () => {
  it('finds the active document', () => {
    expect(activeDocument(stateWith([doc('a'), doc('b')], 'b'))?.id).toBe('b');
  });

  it('is null when nothing is active', () => {
    expect(activeDocument(stateWith([], null))).toBeNull();
  });
});

/**
 * Opening a file into a fresh window used to leave the blank tab the app starts
 * with sitting beside it forever. Reported by the owner: "even if I don't touch
 * this document and I open another document, the empty default document is
 * still opened in another tab".
 */
describe('dropScratchDocuments', () => {
  it('drops an untouched blank tab when a real document arrives', () => {
    const state = stateWith([doc('blank'), doc('opened', 'C:/notes/post.md', '# Post')], 'opened');

    expect(dropScratchDocuments(state, 'opened').documents.map((d) => d.id)).toEqual(['opened']);
  });

  it('keeps a blank tab that has been typed into', () => {
    const state = stateWith([doc('typed', null, 'draft'), doc('opened', 'C:/a.md', 'x')], 'opened');

    expect(dropScratchDocuments(state, 'opened').documents.map((d) => d.id)).toEqual([
      'typed',
      'opened',
    ]);
  });

  // An empty file on disk is not scratch: it has somewhere to be saved back to,
  // and closing it would lose the user's place rather than tidy up after them.
  it('keeps a saved document even when it is empty', () => {
    const state = stateWith([doc('empty', 'C:/empty.md'), doc('opened', 'C:/a.md', 'x')], 'opened');

    expect(dropScratchDocuments(state, 'opened').documents.map((d) => d.id)).toEqual([
      'empty',
      'opened',
    ]);
  });

  /**
   * The incoming document is untitled and empty for as long as it takes
   * `addDocument` to run, and opening a genuinely empty file leaves it that way.
   * Without the exemption it would delete itself on open.
   */
  it('never drops the document it was told to keep', () => {
    const state = stateWith([doc('blank'), doc('alsoBlank')], 'alsoBlank');

    expect(dropScratchDocuments(state, 'alsoBlank').documents.map((d) => d.id)).toEqual([
      'alsoBlank',
    ]);
  });

  it('repoints the active id when it named a tab that has gone', () => {
    const state = stateWith([doc('blank'), doc('opened', 'C:/a.md', 'x')], 'blank');

    expect(dropScratchDocuments(state, 'opened').activeDocumentId).toBe('opened');
  });

  it('leaves a state with nothing to drop alone', () => {
    const state = stateWith([doc('a', 'C:/a.md', 'x'), doc('b', 'C:/b.md', 'y')], 'a');

    expect(dropScratchDocuments(state, 'a').documents).toEqual(state.documents);
    expect(dropScratchDocuments(state, 'a').activeDocumentId).toBe('a');
  });
});
