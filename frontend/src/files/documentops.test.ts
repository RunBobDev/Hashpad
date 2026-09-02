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
import {
  DEFAULT_OUTLINE_WIDTH,
  EMPTY_STATUS,
  createUntitledDocument,
  isDirty,
  type Document,
  DEFAULT_BEHAVIOUR,
} from '../state/document';
import { activeDocument } from '../state/documents';
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
    wordWrap: true,
    editorBehaviour: DEFAULT_BEHAVIOUR,
    defaultViewMode: 'source',
    openedViewMode: 'preview',
    recentViewModes: [],
    defaultEncoding: 'utf-8',
    autosave: false,
    autosaveDelayMs: 2000,
    status: EMPTY_STATUS,
    outlineWidth: DEFAULT_OUTLINE_WIDTH,
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

  /**
   * Half of what the owner reported: with the preview open, File > New gave a
   * tab with no preview. `viewMode` is per document, so a new one has to be
   * *given* the window's mode -- and the value that was being given was a
   * hard-coded `'source'`.
   *
   * Read from the store rather than passed in, for the same reason `wordWrap`
   * and `editorBehaviour` are: this is called from a command handler that
   * cannot await an IPC round trip to the settings file.
   */
  it('opens in the store’s default view mode', () => {
    store.setState((prev) => ({ ...prev, defaultViewMode: 'split' }));

    const doc = makeUntitledDocument();

    expect(doc.viewMode).toBe('split');
    // Derived, not copied: toggling the preview off on a tab that opened
    // straight into split has to land somewhere, and that somewhere is source.
    expect(doc.previousViewMode).toBe('source');
  });

  /**
   * SPEC §6.13's `files.defaultEncoding`. Untitled documents are the only ones
   * it reaches -- there is no file to have detected an encoding from yet, so
   * this is simply what Save As will write.
   */
  it('opens in the store’s default encoding, and opens clean', () => {
    store.setState((prev) => ({ ...prev, defaultEncoding: 'utf-16le' }));

    const doc = makeUntitledDocument();

    expect(doc.encoding).toBe('utf-16le');
    // `savedEncoding` too, or `isDirty` reports a document nobody has touched.
    expect(doc.savedEncoding).toBe('utf-16le');
    expect(isDirty(doc)).toBe(false);
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

  /**
   * The same hole, the same fix, for SPEC 6.11's status bar -- and a more
   * visible one, because the counts differ between any two documents while the
   * formats often do not. Without the republish the bar keeps showing the
   * outgoing document's line, column and word count until the user types.
   */
  it('republishes the status on switch', () => {
    const short = docWithCaretIn('short-doc', 'one two', 7);
    const long = docWithCaretIn('long-doc', 'a b c d e f', 3);
    store.setState((prev) => ({ ...prev, documents: [short, long], activeDocumentId: null }));

    switchToDocument('short-doc');
    expect(store.getState().status).toEqual({
      line: 1,
      col: 8,
      words: 2,
      chars: 7,
      selection: false,
    });

    switchToDocument('long-doc');
    expect(store.getState().status).toEqual({
      line: 1,
      col: 4,
      words: 6,
      chars: 11,
      selection: false,
    });
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
      wordWrap: true,
      editorBehaviour: DEFAULT_BEHAVIOUR,
      defaultViewMode: 'source',
      openedViewMode: 'preview',
      recentViewModes: [],
      defaultEncoding: 'utf-8',
      autosave: false,
      autosaveDelayMs: 2000,
      status: EMPTY_STATUS,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
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
      wordWrap: true,
      editorBehaviour: DEFAULT_BEHAVIOUR,
      defaultViewMode: 'source',
      openedViewMode: 'preview',
      recentViewModes: [],
      defaultEncoding: 'utf-8',
      autosave: false,
      autosaveDelayMs: 2000,
      status: EMPTY_STATUS,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
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
      wordWrap: true,
      editorBehaviour: DEFAULT_BEHAVIOUR,
      defaultViewMode: 'source',
      openedViewMode: 'preview',
      recentViewModes: [],
      defaultEncoding: 'utf-8',
      autosave: false,
      autosaveDelayMs: 2000,
      status: EMPTY_STATUS,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
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
      wordWrap: true,
      editorBehaviour: DEFAULT_BEHAVIOUR,
      defaultViewMode: 'source',
      openedViewMode: 'preview',
      recentViewModes: [],
      defaultEncoding: 'utf-8',
      autosave: false,
      autosaveDelayMs: 2000,
      status: EMPTY_STATUS,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
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
      wordWrap: true,
      editorBehaviour: DEFAULT_BEHAVIOUR,
      defaultViewMode: 'source',
      openedViewMode: 'preview',
      recentViewModes: [],
      defaultEncoding: 'utf-8',
      autosave: false,
      autosaveDelayMs: 2000,
      status: EMPTY_STATUS,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
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
  /**
   * A freshly opened file must be **clean**, and that is not automatic now that
   * `isDirty` compares metadata as well as text: the detected encoding and line
   * ending have to be recorded as the saved ones too. Seeding them from the
   * defaults instead would make every UTF-16 or LF file arrive with a dirty dot
   * and prompt on close, having been edited by nobody.
   */
  it('opens clean, with the detected encoding recorded as the saved one', () => {
    openDocumentInNewTab({
      path: 'C:/notes/unix.md',
      content: 'hello',
      encoding: 'utf-16le',
      lineEnding: 'lf',
    });

    const doc = activeDocument(store.getState())!;
    expect(doc.encoding).toBe('utf-16le');
    expect(doc.savedEncoding).toBe('utf-16le');
    expect(doc.savedLineEnding).toBe('lf');
    expect(isDirty(doc)).toBe(false);
  });

  /**
   * The other half of the owner's report: opening a file with the preview
   * showing closed it. This is the site that spelled `'source'` into every tab
   * it built, regardless of the window it was opening into.
   *
   * Separate from the `makeUntitledDocument` case above rather than folded into
   * it: the two mint their `Document` in different files by different routes --
   * one through `createUntitledDocument`, one from an object literal here --
   * and fixing only the route the report happened to name is exactly the bug
   * coming back through the other door.
   */
  /**
   * `openedViewMode`, not `defaultViewMode` -- an existing document has
   * something to read (design §4.27a). Both are set here, to different values,
   * so a version reading the wrong one fails rather than passing by coincidence.
   */
  it('opens in the store’s mode for existing documents, not the one for new ones', () => {
    store.setState((prev) => ({
      ...prev,
      defaultViewMode: 'source',
      openedViewMode: 'split',
    }));

    openDocumentInNewTab({
      path: 'C:/notes/opened.md',
      content: 'hello',
      encoding: 'utf-8',
      lineEnding: 'crlf',
    });

    const doc = activeDocument(store.getState())!;
    expect(doc.viewMode).toBe('split');
    expect(doc.previousViewMode).toBe('source');
  });

  /**
   * Reading mode reaches an opened document and is refused for a new one. This
   * is the asymmetry the two settings exist for, asserted on the side that
   * allows it -- `makeUntitledDocument`'s own test covers the refusal.
   */
  /**
   * Reading mode renders the document as markdown, where a single newline is a
   * soft break and consecutive lines join into one paragraph. Correct
   * CommonMark, nonsense for a text file: opening a `.txt` landed in reading
   * mode and every line ran together. Reported as "everything is stitched
   * together".
   *
   * Only the *default* is refused -- switching to reading mode from the View
   * menu still works on a `.txt`, because that is someone asking for it.
   */
  it('opens a .txt in the editor even when existing documents open in reading mode', () => {
    store.setState((prev) => ({ ...prev, openedViewMode: 'preview' }));

    openDocumentInNewTab({
      path: 'C:/notes/plain.txt',
      content: 'one\ntwo\nthree',
      encoding: 'utf-8',
      lineEnding: 'lf',
    });

    expect(activeDocument(store.getState())!.viewMode).toBe('source');
  });

  it('opens an existing document in reading mode when that is the setting', () => {
    store.setState((prev) => ({ ...prev, openedViewMode: 'preview' }));

    openDocumentInNewTab({
      path: 'C:/notes/read.md',
      content: 'hello',
      encoding: 'utf-8',
      lineEnding: 'lf',
    });

    expect(activeDocument(store.getState())!.viewMode).toBe('preview');
  });

  /**
   * The counterpart to `makeUntitledDocument`'s encoding case, and the reason
   * the two are worth stating separately: an *opened* file must keep the
   * encoding Go detected. A default that won here would silently transcode the
   * user's file the first time they pressed Ctrl+S, which is the one outcome
   * `files.defaultEncoding` must never produce.
   */
  it('keeps the detected encoding, ignoring the default', () => {
    store.setState((prev) => ({ ...prev, defaultEncoding: 'utf-16le' }));

    openDocumentInNewTab({
      path: 'C:/notes/plain.md',
      content: 'hello',
      encoding: 'utf-8',
      lineEnding: 'lf',
    });

    const doc = activeDocument(store.getState())!;
    expect(doc.encoding).toBe('utf-8');
    expect(doc.savedEncoding).toBe('utf-8');
    expect(isDirty(doc)).toBe(false);
  });

  /**
   * Go reports `mixed` because saving flattens the whole file to one convention.
   * It has to survive the trip into the model or the status bar cannot warn.
   */
  it('carries the mixed-line-endings flag through from the file', () => {
    openDocumentInNewTab({
      path: 'C:/notes/mixed.md',
      content: 'hello',
      encoding: 'utf-8',
      lineEnding: 'crlf',
      mixed: true,
    });

    expect(activeDocument(store.getState())!.mixedLineEndings).toBe(true);
  });

  it('treats an absent mixed flag as not mixed', () => {
    openDocumentInNewTab({
      path: 'C:/notes/plain.md',
      content: 'hello',
      encoding: 'utf-8',
      lineEnding: 'crlf',
    });

    expect(activeDocument(store.getState())!.mixedLineEndings).toBe(false);
  });

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
      wordWrap: true,
      editorBehaviour: DEFAULT_BEHAVIOUR,
      defaultViewMode: 'source',
      openedViewMode: 'preview',
      recentViewModes: [],
      defaultEncoding: 'utf-8',
      autosave: false,
      autosaveDelayMs: 2000,
      status: EMPTY_STATUS,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
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
      wordWrap: true,
      editorBehaviour: DEFAULT_BEHAVIOUR,
      defaultViewMode: 'source',
      openedViewMode: 'preview',
      recentViewModes: [],
      defaultEncoding: 'utf-8',
      autosave: false,
      autosaveDelayMs: 2000,
      status: EMPTY_STATUS,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
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
      wordWrap: true,
      editorBehaviour: DEFAULT_BEHAVIOUR,
      defaultViewMode: 'source',
      openedViewMode: 'preview',
      recentViewModes: [],
      defaultEncoding: 'utf-8',
      autosave: false,
      autosaveDelayMs: 2000,
      status: EMPTY_STATUS,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
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
      wordWrap: true,
      editorBehaviour: DEFAULT_BEHAVIOUR,
      defaultViewMode: 'source',
      openedViewMode: 'preview',
      recentViewModes: [],
      defaultEncoding: 'utf-8',
      autosave: false,
      autosaveDelayMs: 2000,
      status: EMPTY_STATUS,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
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
      wordWrap: true,
      editorBehaviour: DEFAULT_BEHAVIOUR,
      defaultViewMode: 'source',
      openedViewMode: 'preview',
      recentViewModes: [],
      defaultEncoding: 'utf-8',
      autosave: false,
      autosaveDelayMs: 2000,
      status: EMPTY_STATUS,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
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
      wordWrap: true,
      editorBehaviour: DEFAULT_BEHAVIOUR,
      defaultViewMode: 'source',
      openedViewMode: 'preview',
      recentViewModes: [],
      defaultEncoding: 'utf-8',
      autosave: false,
      autosaveDelayMs: 2000,
      status: EMPTY_STATUS,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
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
      wordWrap: true,
      editorBehaviour: DEFAULT_BEHAVIOUR,
      defaultViewMode: 'source',
      openedViewMode: 'preview',
      recentViewModes: [],
      defaultEncoding: 'utf-8',
      autosave: false,
      autosaveDelayMs: 2000,
      status: EMPTY_STATUS,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
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
      wordWrap: true,
      editorBehaviour: DEFAULT_BEHAVIOUR,
      defaultViewMode: 'source',
      openedViewMode: 'preview',
      recentViewModes: [],
      defaultEncoding: 'utf-8',
      autosave: false,
      autosaveDelayMs: 2000,
      status: EMPTY_STATUS,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
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
      wordWrap: true,
      editorBehaviour: DEFAULT_BEHAVIOUR,
      defaultViewMode: 'source',
      openedViewMode: 'preview',
      recentViewModes: [],
      defaultEncoding: 'utf-8',
      autosave: false,
      autosaveDelayMs: 2000,
      status: EMPTY_STATUS,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
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
      wordWrap: true,
      editorBehaviour: DEFAULT_BEHAVIOUR,
      defaultViewMode: 'source',
      openedViewMode: 'preview',
      recentViewModes: [],
      defaultEncoding: 'utf-8',
      autosave: false,
      autosaveDelayMs: 2000,
      status: EMPTY_STATUS,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
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
      wordWrap: true,
      editorBehaviour: DEFAULT_BEHAVIOUR,
      defaultViewMode: 'source',
      openedViewMode: 'preview',
      recentViewModes: [],
      defaultEncoding: 'utf-8',
      autosave: false,
      autosaveDelayMs: 2000,
      status: EMPTY_STATUS,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
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
      wordWrap: true,
      editorBehaviour: DEFAULT_BEHAVIOUR,
      defaultViewMode: 'source',
      openedViewMode: 'preview',
      recentViewModes: [],
      defaultEncoding: 'utf-8',
      autosave: false,
      autosaveDelayMs: 2000,
      status: EMPTY_STATUS,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
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
      wordWrap: true,
      editorBehaviour: DEFAULT_BEHAVIOUR,
      defaultViewMode: 'source',
      openedViewMode: 'preview',
      recentViewModes: [],
      defaultEncoding: 'utf-8',
      autosave: false,
      autosaveDelayMs: 2000,
      status: EMPTY_STATUS,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
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

/**
 * One tab per file (H.10).
 *
 * Reported by the owner: the same file could be opened over and over, each time
 * getting its own tab. Two tabs over one path are two buffers that drift apart,
 * and then whichever is saved second silently wins -- so this is a data-loss
 * shape, not a tidiness one.
 */
describe('opening a file that is already open', () => {
  const contents = {
    path: 'C:/notes/a.md',
    content: 'hello',
    encoding: 'utf-8',
    lineEnding: 'crlf',
  };

  it('adds no second tab', () => {
    openDocumentInNewTab(contents);
    expect(store.getState().documents).toHaveLength(1);

    openDocumentInNewTab(contents);

    expect(store.getState().documents).toHaveLength(1);
  });

  it('switches to the tab that already holds it', () => {
    openDocumentInNewTab(contents);
    const first = activeDocument(store.getState())!.id;
    openDocumentInNewTab({ ...contents, path: 'C:/notes/b.md', content: 'other' });
    expect(activeDocument(store.getState())!.id).not.toBe(first);

    openDocumentInNewTab(contents);

    expect(activeDocument(store.getState())!.id).toBe(first);
  });

  /**
   * **The one that matters.** A fix that replaced the open document with the
   * freshly read contents would pass every other case here and quietly throw
   * away whatever the user had typed but not saved. The existing tab is left
   * completely alone.
   */
  it('does not overwrite unsaved changes in that tab', () => {
    openDocumentInNewTab(contents);
    const id = activeDocument(store.getState())!.id;
    // Stand in for typing: the buffer diverges from what is on disk.
    store.setState((prev) => ({
      ...prev,
      documents: prev.documents.map((doc) =>
        doc.id === id
          ? {
              ...doc,
              editorState: doc.editorState.update({ changes: { from: 5, insert: ' world' } }).state,
            }
          : doc,
      ),
    }));
    expect(isDirty(store.getState().documents[0]!)).toBe(true);

    // The file on disk has moved on too -- so a re-read would visibly clobber.
    openDocumentInNewTab({ ...contents, content: 'something else entirely' });

    const doc = store.getState().documents[0]!;
    expect(doc.editorState.doc.toString()).toBe('hello world');
    expect(isDirty(doc)).toBe(true);
  });

  /**
   * Re-opening the tab that is already in front must be a genuine no-op --
   * `switchToDocument` skips a redundant swap, and without that this would
   * reinitialise the view and throw away the caret and scroll position.
   */
  it('leaves the view untouched when that tab is already in front', () => {
    openDocumentInNewTab(contents);
    const before = getEditorView().state;

    openDocumentInNewTab(contents);

    expect(getEditorView().state).toBe(before);
  });

  it('still opens a different path in its own tab', () => {
    openDocumentInNewTab(contents);

    openDocumentInNewTab({ ...contents, path: 'C:/notes/b.md' });

    expect(store.getState().documents).toHaveLength(2);
  });

  /**
   * Opening a file while untitled tabs are around gives it its own tab rather
   * than hijacking one of theirs.
   *
   * True by *typing* rather than by a guard: `contents.path` is a `string` and
   * an untitled tab's `filePath` is `null`, so they cannot compare equal. An
   * explicit null check was written here and deleted -- removing it broke
   * nothing, because it could not. The case stays because the behaviour is
   * worth stating even where the type system is what enforces it.
   */
  it('does not treat untitled documents as already open', () => {
    store.setState((prev) => ({
      ...prev,
      documents: [makeUntitledDocument(), makeUntitledDocument()],
      activeDocumentId: null,
    }));

    openDocumentInNewTab(contents);

    expect(store.getState().documents.filter((doc) => doc.filePath !== null)).toHaveLength(1);
  });

  /**
   * `reopenLastClosed` reaches `openDocumentInNewTab` without going through
   * `openPaths`, so a guard placed in the latter would miss this: close a file,
   * open it again from the dialog, then press Ctrl+Shift+T.
   */
  it('is not duplicated by reopening a closed tab', async () => {
    vi.mocked(ReadFile).mockResolvedValue(contents as never);
    store.setState((prev) => ({ ...prev, closedPaths: [contents.path] }));
    openDocumentInNewTab(contents);

    await reopenLastClosed();

    expect(store.getState().documents).toHaveLength(1);
  });
});
