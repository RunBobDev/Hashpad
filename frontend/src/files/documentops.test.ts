// @vitest-environment jsdom
/**
 * `switchToDocument` and `openDocumentInNewTab` swap real `EditorState`s into
 * a real `EditorView`, and jsdom does construct one (Checkpoint B's
 * extensions.test.ts established this) -- so this whole file uses a real
 * view rather than stubbing the one thing that makes "did the right text end
 * up on screen" a provable assertion instead of a guess.
 *
 * `closeDocumentWithPrompt`'s public signature is fixed at `(id: string)` --
 * it does not take `confirmSave`/save as injected parameters the way
 * `resolveDocumentsBeforeQuit` does, because callers (the tab bar, keyboard
 * shortcuts) need to invoke it with just an id. The equivalent of injecting
 * those collaborators here is `vi.mock`-ing the two real boundaries it
 * crosses -- the confirm dialog and the Go IPC calls underneath
 * `saveDocument` -- so no actual `<dialog>` (jsdom can't `showModal()` one
 * anyway) or real file IPC is ever touched.
 */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmSave } from '../ui/confirmdialog';
import { ReadFile, WriteFile } from '../../wailsjs/go/app/App';
import { buildExtensions } from '../editor/extensions';
import { getEditorView, setEditorView, store } from '../state/appcontext';
import { createUntitledDocument, isDirty, type Document } from '../state/document';
import {
  closeDocumentWithPrompt,
  documentDirOf,
  makeUntitledDocument,
  openDocumentInNewTab,
  reopenLastClosed,
  switchToDocument,
} from './documentops';

vi.mock('../ui/confirmdialog', () => ({ confirmSave: vi.fn() }));
vi.mock('../../wailsjs/go/app/App', () => ({
  ConfirmQuit: vi.fn(),
  LoadSettings: vi.fn(),
  ReadFile: vi.fn(),
  SaveSettings: vi.fn(),
  ShowOpenDialog: vi.fn(),
  ShowSaveDialog: vi.fn(),
  WriteFile: vi.fn(),
}));

/** A clean document with real, CodeMirror-usable extensions and the given text. */
function cleanDoc(id: string, text: string): Document {
  const editorState = EditorState.create({ doc: text, extensions: buildExtensions(false) });
  return { ...createUntitledDocument(editorState), id };
}

/** A dirty document (editorState has diverged from savedDoc), optionally with a path. */
function dirtyDoc(id: string, filePath: string | null = null): Document {
  const original = EditorState.create({ doc: 'hello', extensions: buildExtensions(false) });
  const changed = original.update({ changes: { from: 5, insert: '!' } }).state;
  return { ...createUntitledDocument(original), id, filePath, editorState: changed };
}

let view: EditorView;

beforeEach(() => {
  view = new EditorView({
    state: EditorState.create({ doc: '', extensions: buildExtensions(false) }),
    parent: document.createElement('div'),
  });
  setEditorView(view);
  store.setState(() => ({
    documents: [],
    activeDocumentId: null,
    isDark: false,
    closedPaths: [],
    activeFormats: '',
    pinnedToolbarCommands: [],
    previewSplitRatio: 0.5,
    syncScroll: true,
  }));
  vi.clearAllMocks();
});

afterEach(() => {
  view.destroy();
});

describe('makeUntitledDocument', () => {
  it('mints an empty, clean, never-saved document with no scroll history', () => {
    const doc = makeUntitledDocument();
    expect(doc.filePath).toBeNull();
    expect(doc.editorState.doc.toString()).toBe('');
    expect(doc.scrollSnapshot).toBeNull();
    expect(isDirty(doc)).toBe(false);
  });

  it('mints a fresh id every call', () => {
    expect(makeUntitledDocument().id).not.toBe(makeUntitledDocument().id);
  });
});

/**
 * `view.setState` reinitialises the view's plugins instead of running a
 * transaction, so it constructs no `ViewUpdate` and no `updateListener` fires
 * -- `switchToDocument` already relies on that for `syncActiveDocument`. For
 * `syncActiveFormats` the same fact is a hole: without an explicit republish,
 * the store would keep advertising the *outgoing* document's formatting until
 * the user next typed, and the toolbar would light the wrong buttons on every
 * tab switch.
 */
describe('switchToDocument keeps the published active formats in step', () => {
  /** A document whose caret sits inside the given mark, ready to switch to. */
  function docWithCaretIn(id: string, text: string, at: number): Document {
    const base = EditorState.create({ doc: text, extensions: buildExtensions(false) });
    const editorState = base.update({ selection: { anchor: at } }).state;
    return { ...createUntitledDocument(base), id, editorState };
  }

  it('republishes on switch rather than leaving the previous document’s formats', () => {
    const bolded = docWithCaretIn('bold-doc', '**bold**', 4);
    const plain = docWithCaretIn('plain-doc', 'plain text', 3);
    store.setState((prev) => ({ ...prev, documents: [bolded, plain], activeDocumentId: null }));

    switchToDocument('bold-doc');
    expect(store.getState().activeFormats).toBe('bold');

    // The load-bearing half: switching away must clear it. Without the
    // republish this still reads 'bold' while the caret is in plain text.
    switchToDocument('plain-doc');
    expect(store.getState().activeFormats).toBe('');

    switchToDocument('bold-doc');
    expect(store.getState().activeFormats).toBe('bold');
  });
});

describe('switchToDocument', () => {
  it('swaps the view to the target document and activates it', () => {
    const a = cleanDoc('a', 'doc A');
    const b = cleanDoc('b', 'doc B');
    store.setState(() => ({
      documents: [a, b],
      activeDocumentId: 'a',
      isDark: false,
      closedPaths: [],
      activeFormats: '',
      pinnedToolbarCommands: [],
      previewSplitRatio: 0.5,
      syncScroll: true,
    }));
    view.setState(a.editorState);

    switchToDocument('b');

    expect(store.getState().activeDocumentId).toBe('b');
    expect(getEditorView().state.doc.toString()).toBe('doc B');
  });

  it('is a no-op for an unknown id', () => {
    const a = cleanDoc('a', 'doc A');
    store.setState(() => ({
      documents: [a],
      activeDocumentId: 'a',
      isDark: false,
      closedPaths: [],
      activeFormats: '',
      pinnedToolbarCommands: [],
      previewSplitRatio: 0.5,
      syncScroll: true,
    }));
    view.setState(a.editorState);

    switchToDocument('does-not-exist');

    expect(store.getState().activeDocumentId).toBe('a');
    expect(getEditorView().state).toBe(a.editorState);
  });

  it('does nothing extra when switching to the tab already on screen', () => {
    const a = cleanDoc('a', 'doc A');
    store.setState(() => ({
      documents: [a],
      activeDocumentId: 'a',
      isDark: false,
      closedPaths: [],
      activeFormats: '',
      pinnedToolbarCommands: [],
      previewSplitRatio: 0.5,
      syncScroll: true,
    }));
    view.setState(a.editorState);

    switchToDocument('a');

    // Same EditorState reference: no needless setState, and no scroll
    // snapshot manufactured for a document that never left the screen.
    expect(getEditorView().state).toBe(a.editorState);
    expect(store.getState().documents.find((d) => d.id === 'a')?.scrollSnapshot).toBeNull();
  });

  it('captures a scroll snapshot for the outgoing document and can replay it on the way back', () => {
    const a = cleanDoc('a', 'doc A');
    const b = cleanDoc('b', 'doc B');
    store.setState(() => ({
      documents: [a, b],
      activeDocumentId: 'a',
      isDark: false,
      closedPaths: [],
      activeFormats: '',
      pinnedToolbarCommands: [],
      previewSplitRatio: 0.5,
      syncScroll: true,
    }));
    view.setState(a.editorState);

    switchToDocument('b');
    const aAfterLeaving = store.getState().documents.find((d) => d.id === 'a');
    expect(aAfterLeaving?.scrollSnapshot).not.toBeNull();

    // Switching back must not throw while replaying that snapshot, and must
    // land back on 'a's own text.
    switchToDocument('a');
    expect(store.getState().activeDocumentId).toBe('a');
    expect(getEditorView().state.doc.toString()).toBe('doc A');
  });

  it('preserves undo history across a round trip through another tab', () => {
    const a = cleanDoc('a', 'doc A');
    const b = cleanDoc('b', 'doc B');
    store.setState(() => ({
      documents: [a, b],
      activeDocumentId: 'a',
      isDark: false,
      closedPaths: [],
      activeFormats: '',
      pinnedToolbarCommands: [],
      previewSplitRatio: 0.5,
      syncScroll: true,
    }));
    view.setState(a.editorState);
    view.dispatch({ changes: { from: 5, insert: '!' } });
    expect(view.state.doc.toString()).toBe('doc A!');

    // The update listener (editor/extensions.ts) writes the live state back
    // into the store on every change, so the document object switchToDocument
    // reads afterward already reflects the edit above.
    switchToDocument('b');
    switchToDocument('a');

    expect(getEditorView().state.doc.toString()).toBe('doc A!');
  });
});

describe('openDocumentInNewTab', () => {
  it('adds a new tab, activates it, and loads its text into the view', () => {
    const a = cleanDoc('a', 'doc A');
    store.setState(() => ({
      documents: [a],
      activeDocumentId: 'a',
      isDark: false,
      closedPaths: [],
      activeFormats: '',
      pinnedToolbarCommands: [],
      previewSplitRatio: 0.5,
      syncScroll: true,
    }));
    view.setState(a.editorState);

    openDocumentInNewTab({
      path: 'C:\\notes\\b.md',
      content: 'doc B',
      encoding: 'utf-8',
      lineEnding: 'lf',
    });

    const state = store.getState();
    expect(state.documents).toHaveLength(2);
    const added = state.documents[1]!;
    expect(added.filePath).toBe('C:\\notes\\b.md');
    expect(added.encoding).toBe('utf-8');
    expect(added.lineEnding).toBe('lf');
    expect(state.activeDocumentId).toBe(added.id);
    expect(getEditorView().state.doc.toString()).toBe('doc B');
  });

  it("files the outgoing tab's scroll snapshot correctly even though addDocument already reassigned activeDocumentId first", () => {
    // Regression check for the ordering hazard: addDocument (called inside
    // openDocumentInNewTab, before switchToDocument runs) already points
    // activeDocumentId at the new tab. If switchToDocument identified
    // "outgoing" by reading activeDocumentId instead of view identity, it
    // would file the snapshot against the new tab instead of 'a'.
    const a = cleanDoc('a', 'doc A');
    store.setState(() => ({
      documents: [a],
      activeDocumentId: 'a',
      isDark: false,
      closedPaths: [],
      activeFormats: '',
      pinnedToolbarCommands: [],
      previewSplitRatio: 0.5,
      syncScroll: true,
    }));
    view.setState(a.editorState);

    openDocumentInNewTab({ path: 'b.md', content: 'doc B', encoding: 'utf-8', lineEnding: 'lf' });

    const aAfter = store.getState().documents.find((d) => d.id === 'a');
    expect(aAfter?.scrollSnapshot).not.toBeNull();
  });
});

/**
 * The startup tab, replaced rather than left behind. Reported by the owner:
 * "even if I don't touch this document and I open another document, the empty
 * default document is still opened in another tab".
 *
 * Here rather than only in `documents.test.ts` because the pure function knows
 * nothing about being called -- deleting the `dropScratchDocuments` line from
 * `openDocumentInNewTab` leaves every one of those unit tests green.
 */
describe('opening a document over the startup tab', () => {
  function seed(documents: Document[], activeId: string): void {
    store.setState(() => ({
      documents,
      activeDocumentId: activeId,
      isDark: false,
      closedPaths: [],
      activeFormats: '',
      pinnedToolbarCommands: [],
      previewSplitRatio: 0.5,
      syncScroll: true,
    }));
    view.setState(documents.find((d) => d.id === activeId)!.editorState);
  }

  const opened = {
    path: 'C:' + String.fromCharCode(92) + 'notes' + String.fromCharCode(92) + 'b.md',
    content: 'doc B',
    encoding: 'utf-8',
    lineEnding: 'lf',
  };

  it('closes the untouched blank tab and leaves only the opened file', () => {
    const blank = makeUntitledDocument();
    seed([blank], blank.id);

    openDocumentInNewTab(opened);

    const state = store.getState();
    expect(state.documents).toHaveLength(1);
    expect(state.documents[0]!.filePath).toBe(opened.path);
    expect(state.activeDocumentId).toBe(state.documents[0]!.id);
  });

  it('leaves a blank tab alone once it has been typed into', () => {
    const typed = cleanDoc('typed', 'a draft');
    typed.filePath = null;
    seed([typed], 'typed');

    openDocumentInNewTab(opened);

    expect(store.getState().documents.map((d) => d.id)).toContain('typed');
    expect(store.getState().documents).toHaveLength(2);
  });
});

describe('closeDocumentWithPrompt', () => {
  it('closes a clean document without prompting', async () => {
    const a = cleanDoc('a', 'doc A');
    const b = cleanDoc('b', 'doc B');
    store.setState(() => ({
      documents: [a, b],
      activeDocumentId: 'b',
      isDark: false,
      closedPaths: [],
      activeFormats: '',
      pinnedToolbarCommands: [],
      previewSplitRatio: 0.5,
      syncScroll: true,
    }));
    view.setState(b.editorState);

    const result = await closeDocumentWithPrompt('b');

    expect(result).toBe(true);
    expect(confirmSave).not.toHaveBeenCalled();
    expect(store.getState().documents.map((d) => d.id)).toEqual(['a']);
  });

  it('returns true immediately for an id that is already gone', async () => {
    const a = cleanDoc('a', 'doc A');
    store.setState(() => ({
      documents: [a],
      activeDocumentId: 'a',
      isDark: false,
      closedPaths: [],
      activeFormats: '',
      pinnedToolbarCommands: [],
      previewSplitRatio: 0.5,
      syncScroll: true,
    }));
    view.setState(a.editorState);

    const result = await closeDocumentWithPrompt('does-not-exist');

    expect(result).toBe(true);
    expect(confirmSave).not.toHaveBeenCalled();
  });

  it('returns false and leaves the document open when the user cancels', async () => {
    const a = dirtyDoc('a');
    store.setState(() => ({
      documents: [a],
      activeDocumentId: 'a',
      isDark: false,
      closedPaths: [],
      activeFormats: '',
      pinnedToolbarCommands: [],
      previewSplitRatio: 0.5,
      syncScroll: true,
    }));
    view.setState(a.editorState);
    vi.mocked(confirmSave).mockResolvedValue('cancel');

    const result = await closeDocumentWithPrompt('a');

    expect(result).toBe(false);
    expect(WriteFile).not.toHaveBeenCalled();
    expect(store.getState().documents.map((d) => d.id)).toEqual(['a']);
  });

  it("closes without saving when the user picks Don't Save", async () => {
    const a = dirtyDoc('a');
    const b = cleanDoc('b', 'doc B');
    store.setState(() => ({
      documents: [a, b],
      activeDocumentId: 'a',
      isDark: false,
      closedPaths: [],
      activeFormats: '',
      pinnedToolbarCommands: [],
      previewSplitRatio: 0.5,
      syncScroll: true,
    }));
    view.setState(a.editorState);
    vi.mocked(confirmSave).mockResolvedValue('dontsave');

    const result = await closeDocumentWithPrompt('a');

    expect(result).toBe(true);
    expect(WriteFile).not.toHaveBeenCalled();
    expect(store.getState().documents.map((d) => d.id)).toEqual(['b']);
  });

  it('aborts and leaves the document open when Save is chosen but the write fails', async () => {
    const a = dirtyDoc('a', 'C:\\notes\\a.md');
    store.setState(() => ({
      documents: [a],
      activeDocumentId: 'a',
      isDark: false,
      closedPaths: [],
      activeFormats: '',
      pinnedToolbarCommands: [],
      previewSplitRatio: 0.5,
      syncScroll: true,
    }));
    view.setState(a.editorState);
    vi.mocked(confirmSave).mockResolvedValue('save');
    vi.mocked(WriteFile).mockRejectedValue(new Error('disk full'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await closeDocumentWithPrompt('a');

    expect(result).toBe(false);
    expect(WriteFile).toHaveBeenCalledTimes(1);
    expect(store.getState().documents.map((d) => d.id)).toEqual(['a']);

    errorSpy.mockRestore();
  });

  it('saves then closes when Save is chosen and the write succeeds', async () => {
    const a = dirtyDoc('a', 'C:\\notes\\a.md');
    const b = cleanDoc('b', 'doc B');
    store.setState(() => ({
      documents: [a, b],
      activeDocumentId: 'a',
      isDark: false,
      closedPaths: [],
      activeFormats: '',
      pinnedToolbarCommands: [],
      previewSplitRatio: 0.5,
      syncScroll: true,
    }));
    view.setState(a.editorState);
    vi.mocked(confirmSave).mockResolvedValue('save');
    vi.mocked(WriteFile).mockResolvedValue(undefined);

    const result = await closeDocumentWithPrompt('a');

    expect(result).toBe(true);
    expect(WriteFile).toHaveBeenCalledWith('C:\\notes\\a.md', 'hello!', 'utf-8', 'crlf');
    expect(store.getState().documents.map((d) => d.id)).toEqual(['b']);
  });

  /**
   * The regression this task exists to fix: an earlier version of the save
   * path always saved whichever document the store considered *active*,
   * regardless of which id it was asked about. Closing a dirty background
   * tab while a different tab is on screen must write the background tab's
   * own buffer to its own path -- never the visible document's text.
   */
  it('saves the target background tab, not whichever tab is active and on screen', async () => {
    const active = cleanDoc('active', 'visible text');
    const background = dirtyDoc('background', 'C:\\notes\\background.md');
    store.setState(() => ({
      documents: [active, background],
      activeDocumentId: 'active',
      isDark: false,
      closedPaths: [],
      activeFormats: '',
      pinnedToolbarCommands: [],
      previewSplitRatio: 0.5,
      syncScroll: true,
    }));
    view.setState(active.editorState);
    vi.mocked(confirmSave).mockResolvedValue('save');
    vi.mocked(WriteFile).mockResolvedValue(undefined);

    const result = await closeDocumentWithPrompt('background');

    expect(result).toBe(true);
    expect(WriteFile).toHaveBeenCalledWith('C:\\notes\\background.md', 'hello!', 'utf-8', 'crlf');
    // The active tab must be untouched: still active, and the view still
    // shows its text rather than having been swapped or reset.
    expect(store.getState().activeDocumentId).toBe('active');
    expect(getEditorView().state.doc.toString()).toBe('visible text');
  });
});

describe('reopenLastClosed', () => {
  it('does nothing when the reopen stack is empty', async () => {
    const a = cleanDoc('a', 'x');
    store.setState(() => ({
      documents: [a],
      activeDocumentId: 'a',
      isDark: false,
      closedPaths: [],
      activeFormats: '',
      pinnedToolbarCommands: [],
      previewSplitRatio: 0.5,
      syncScroll: true,
    }));
    view.setState(a.editorState);

    await reopenLastClosed();

    expect(ReadFile).not.toHaveBeenCalled();
    expect(store.getState().documents).toHaveLength(1);
  });

  it('reads the most recently closed path and opens it in a new tab', async () => {
    const a = cleanDoc('a', 'x');
    store.setState(() => ({
      documents: [a],
      activeDocumentId: 'a',
      isDark: false,
      closedPaths: ['C:\\notes\\b.md'],
      activeFormats: '',
      pinnedToolbarCommands: [],
      previewSplitRatio: 0.5,
      syncScroll: true,
    }));
    view.setState(a.editorState);
    vi.mocked(ReadFile).mockResolvedValue({
      path: 'C:\\notes\\b.md',
      content: 'reopened text',
      encoding: 'utf-8',
      lineEnding: 'lf',
      mixed: false,
    });

    await reopenLastClosed();

    expect(store.getState().closedPaths).toEqual([]);
    expect(store.getState().documents).toHaveLength(2);
    expect(getEditorView().state.doc.toString()).toBe('reopened text');
  });

  it('drops the path and logs when the file can no longer be read, without wedging the stack', async () => {
    const a = cleanDoc('a', 'x');
    store.setState(() => ({
      documents: [a],
      activeDocumentId: 'a',
      isDark: false,
      closedPaths: ['C:\\notes\\gone.md'],
      activeFormats: '',
      pinnedToolbarCommands: [],
      previewSplitRatio: 0.5,
      syncScroll: true,
    }));
    view.setState(a.editorState);
    vi.mocked(ReadFile).mockRejectedValue(new Error('not found'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await reopenLastClosed();

    expect(store.getState().closedPaths).toEqual([]);
    expect(store.getState().documents).toHaveLength(1);

    errorSpy.mockRestore();
  });
});

/**
 * The directory Go's asset handler resolves the preview's relative image paths
 * against (design §5.7). `preview/pane.ts` calls this per render and puts the
 * answer in the URL, so a wrong answer here is a wrong `dir=` on every image —
 * and nothing in the rendered output reveals it, because a 404 image looks the
 * same as one that was never there.
 *
 * These used to assert the same answers through a `SetActiveDocumentDir` IPC
 * call. That call is gone; the answers still matter, so they are asserted on
 * the function that produces them.
 */
describe('documentDirOf', () => {
  it('returns the folder of a saved document', () => {
    expect(documentDirOf('C:\\docs\\notes\\post.md')).toBe('C:\\docs\\notes');
  });

  // An untitled buffer has no folder. `pane.ts` maps this empty string to the
  // `null` that makes rules/images.ts render its placeholder instead of a URL,
  // and the handler refuses an empty `dir` besides.
  it('returns the empty string for a document that has never been saved', () => {
    expect(documentDirOf(null)).toBe('');
  });

  // The dialogs always return absolute paths, so this is defensive -- but a
  // bare filename has no directory, and guessing one would aim the handler at
  // whatever the process working directory happens to be.
  it('returns the empty string for a bare filename with no separator', () => {
    expect(documentDirOf('post.md')).toBe('');
  });

  // A document saved at a drive root. `C:` alone is drive-*relative* on
  // Windows: Go would resolve images against the process working directory
  // and every containment check would still pass -- measured serving a file
  // from the wrong folder. The separator is what makes it absolute.
  it.each([
    [
      'a Windows drive root',
      'C:' + String.fromCharCode(92) + 'post.md',
      'C:' + String.fromCharCode(92),
    ],
    ['a POSIX root', '/post.md', '/'],
  ])('keeps the separator for %s', (_label, filePath, expected) => {
    expect(documentDirOf(filePath)).toBe(expected);
  });

  it('handles a forward-slash path as well as a backslash one', () => {
    expect(documentDirOf('/home/user/notes/post.md')).toBe('/home/user/notes');
  });
});
