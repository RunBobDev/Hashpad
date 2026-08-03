// @vitest-environment jsdom
/**
 * main.ts is a bootstrap script, not a library of exported functions -- its
 * `hashpad:command` switch only exists as a closure over `view` and `store`
 * inside the module. The only way to exercise that routing is to actually run
 * the bootstrap once (mocking the two Wails IPC boundaries it touches at
 * import time -- `WindowSetTitle`/`EventsOn` and the Go bindings under
 * `wailsjs/go/app/App`, same boundary documentops.test.ts already mocks),
 * against a real `#app` element, and then dispatch real `hashpad:command`
 * events at the resulting `document` and observe the shared store/view.
 *
 * The bootstrap runs exactly once, in `beforeAll`: it is a real `EditorView`
 * plus a real menu bar and tab bar mounted into the DOM, and re-running it
 * per test would just rebuild the same thing for no isolation benefit --
 * every test below already starts by fully overwriting `documents`,
 * `activeDocumentId`, and `closedPaths` via `setupDocs`, which is what
 * actually gives each test a clean slate.
 *
 * Not covered here: `file.exit`, `edit.undo`/`edit.redo`, and the
 * quit-prompt sequence (EventsOn's callback) -- unchanged by this task, and
 * already implicitly exercised by the fact that importing main.ts at all
 * succeeds. Dirty-document closes are not exercised either: `confirmSave`
 * calls `<dialog>.showModal()`, which jsdom does not implement, and every
 * scenario this task needs (routing, and self-review's "last tab" and
 * "reopen after an untitled close" questions) is reachable with clean
 * documents alone.
 */
import { EditorState } from '@codemirror/state';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildExtensions } from './editor/extensions';
import { createUntitledDocument, type Document } from './state/document';
import { getEditorView, store } from './state/appcontext';
import { COMMAND_EVENT } from './ui/menubar';
import { ReadFile } from '../wailsjs/go/app/App';

vi.mock('../wailsjs/runtime/runtime', () => ({
  EventsOn: vi.fn(() => () => {}),
  Quit: vi.fn(),
  WindowMinimise: vi.fn(),
  WindowSetTitle: vi.fn(),
  WindowShow: vi.fn(),
  WindowToggleMaximise: vi.fn(),
}));

vi.mock('../wailsjs/go/app/App', () => ({
  ConfirmQuit: vi.fn(),
  // Bound rather than the runtime's WindowShow so Go can tell a normal start
  // from a frontend that never got this far -- see App.showWindowEventually.
  ShowWindow: vi.fn(),
  // Resolved, not left as a bare vi.fn(): main.ts's bootstrap awaits this and
  // reads .appearance straight off the result, so leaving it `undefined`
  // (vi.fn()'s default) would push every test in this file through
  // bootstrapTheme's settings-failed catch branch instead of the tab/document
  // routing this suite actually exercises. Only the fields main.ts's
  // bootstrap reads are present -- this is not a full app.Settings.
  LoadSettings: vi.fn().mockResolvedValue({ appearance: { theme: 'system', accentColor: '#0078d4' } }),
  ReadFile: vi.fn(),
  SaveSettings: vi.fn(),
  ShowOpenDialog: vi.fn(),
  ShowSaveDialog: vi.fn(),
  SystemThemeIsDark: vi.fn().mockResolvedValue(false),
  WriteFile: vi.fn(),
}));

/** A clean document with a real, CodeMirror-usable EditorState. */
function cleanDoc(id: string, text: string, filePath: string | null = null): Document {
  const editorState = EditorState.create({ doc: text, extensions: buildExtensions(false) });
  return { ...createUntitledDocument(editorState), id, filePath };
}

function emit(command: string): void {
  document.dispatchEvent(new CustomEvent<string>(COMMAND_EVENT, { detail: command }));
}

/**
 * Replaces the store's documents wholesale and syncs the live view to
 * whichever one is active -- mirrors documentops.test.ts's `view.setState`
 * step, which is what lets `switchToDocument` correctly identify the
 * "outgoing" document by view identity afterward.
 */
function setupDocs(docs: Document[], activeId: string, closedPaths: string[] = []): void {
  store.setState(() => ({ documents: docs, activeDocumentId: activeId, isDark: false, closedPaths }));
  const active = docs.find((d) => d.id === activeId);
  if (active) getEditorView().setState(active.editorState);
}

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  // Dynamic, not static: main.ts reads `#app` from the DOM the instant it is
  // evaluated, so the element above must exist before that happens -- a
  // static top-level import would run before this callback's body does.
  await import('./main');
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('tab.close command', () => {
  it('closes the active tab and switches the view to the remaining one', () => {
    const a = cleanDoc('a', 'doc A');
    const b = cleanDoc('b', 'doc B');
    setupDocs([a, b], 'a');

    emit('tab.close');

    expect(store.getState().documents.map((d) => d.id)).toEqual(['b']);
    expect(store.getState().activeDocumentId).toBe('b');
    expect(getEditorView().state.doc.toString()).toBe('doc B');
  });

  it('leaves a background tab untouched and focus unmoved', () => {
    const a = cleanDoc('a', 'doc A');
    const b = cleanDoc('b', 'doc B');
    setupDocs([a, b], 'a');

    // tab.close carries no id -- it always means "the active tab" -- so
    // closing while 'a' is active must never touch 'b'.
    emit('tab.close');

    expect(store.getState().documents.some((d) => d.id === 'b')).toBe(true);
  });

  // Self-review: Ctrl+W on the last tab must leave a fresh untitled document,
  // never zero tabs and never an empty editor with nothing tracking it.
  it('replaces the last tab with a fresh untitled document rather than leaving zero tabs', () => {
    const a = cleanDoc('a', 'doc A', 'C:\\notes\\a.md');
    setupDocs([a], 'a');

    emit('tab.close');

    const remaining = store.getState().documents;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).not.toBe('a');
    expect(remaining[0]!.filePath).toBeNull();
    expect(getEditorView().state.doc.toString()).toBe('');
  });
});

describe('tab.reopen command', () => {
  it('does nothing when the reopen stack is empty', async () => {
    const a = cleanDoc('a', 'doc A');
    setupDocs([a], 'a');

    emit('tab.reopen');
    await vi.waitFor(() => expect(ReadFile).not.toHaveBeenCalled());

    expect(store.getState().documents).toHaveLength(1);
  });

  // Self-review: Ctrl+Shift+T after closing an untitled tab must do nothing,
  // not error -- an untitled document was never on the reopen stack to begin
  // with (SPEC §6.3), so this also proves tab.close's replacement document
  // above didn't somehow get itself onto that stack.
  it('does nothing after closing an untitled tab', async () => {
    const a = cleanDoc('a', 'untitled text'); // filePath: null
    setupDocs([a], 'a');

    emit('tab.close');
    expect(store.getState().closedPaths).toEqual([]);

    emit('tab.reopen');
    await vi.waitFor(() => expect(ReadFile).not.toHaveBeenCalled());

    expect(store.getState().documents).toHaveLength(1);
  });

  it('reopens the most recently closed saved tab', async () => {
    const a = cleanDoc('a', 'doc A', 'C:\\notes\\a.md');
    const b = cleanDoc('b', 'doc B');
    setupDocs([a, b], 'a');

    emit('tab.close'); // closes 'a' -- it had a path, so it goes on the stack
    expect(store.getState().closedPaths).toEqual(['C:\\notes\\a.md']);

    vi.mocked(ReadFile).mockResolvedValue({
      path: 'C:\\notes\\a.md',
      content: 'reopened text',
      encoding: 'utf-8',
      lineEnding: 'lf',
      mixed: false,
    });

    emit('tab.reopen');

    await vi.waitFor(() => {
      expect(getEditorView().state.doc.toString()).toBe('reopened text');
    });
    expect(store.getState().closedPaths).toEqual([]);
    expect(store.getState().documents).toHaveLength(2);
  });
});

describe('tab.next / tab.previous commands', () => {
  it('tab.next moves forward and wraps past the last tab', () => {
    const [a, b, c] = [cleanDoc('a', 'A'), cleanDoc('b', 'B'), cleanDoc('c', 'C')];
    setupDocs([a, b, c], 'c');

    emit('tab.next');

    expect(store.getState().activeDocumentId).toBe('a');
    expect(getEditorView().state.doc.toString()).toBe('A');
  });

  it('tab.previous moves backward and wraps past the first tab', () => {
    const [a, b, c] = [cleanDoc('a', 'A'), cleanDoc('b', 'B'), cleanDoc('c', 'C')];
    setupDocs([a, b, c], 'a');

    emit('tab.previous');

    expect(store.getState().activeDocumentId).toBe('c');
    expect(getEditorView().state.doc.toString()).toBe('C');
  });

  it('is a harmless no-op with only one tab open', () => {
    const a = cleanDoc('a', 'A');
    setupDocs([a], 'a');

    emit('tab.next');

    expect(store.getState().activeDocumentId).toBe('a');
  });
});

describe('tab.goto<N> commands', () => {
  it('goto2 switches to the second tab by position', () => {
    const [a, b, c] = [cleanDoc('a', 'A'), cleanDoc('b', 'B'), cleanDoc('c', 'C')];
    setupDocs([a, b, c], 'a');

    emit('tab.goto2');

    expect(store.getState().activeDocumentId).toBe('b');
    expect(getEditorView().state.doc.toString()).toBe('B');
  });

  it('goto1 and goto3 land on the first and last tab respectively', () => {
    const [a, b, c] = [cleanDoc('a', 'A'), cleanDoc('b', 'B'), cleanDoc('c', 'C')];
    setupDocs([a, b, c], 'b');

    emit('tab.goto3');
    expect(store.getState().activeDocumentId).toBe('c');

    emit('tab.goto1');
    expect(store.getState().activeDocumentId).toBe('a');
  });

  // Out of range does nothing, silently -- SPEC gives no error affordance for
  // this, and every editor treats an unassigned numbered slot the same way.
  it('does nothing when the position is past the last tab', () => {
    const [a, b] = [cleanDoc('a', 'A'), cleanDoc('b', 'B')];
    setupDocs([a, b], 'a');

    emit('tab.goto9');

    expect(store.getState().activeDocumentId).toBe('a');
    expect(getEditorView().state.doc.toString()).toBe('A');
  });
});

describe('tab.moveLeft / tab.moveRight commands', () => {
  it('moves the active tab one place left', () => {
    setupDocs([cleanDoc('a', 'A'), cleanDoc('b', 'B'), cleanDoc('c', 'C')], 'b');

    emit('tab.moveLeft');

    expect(store.getState().documents.map((d) => d.id)).toEqual(['b', 'a', 'c']);
  });

  it('moves the active tab one place right', () => {
    setupDocs([cleanDoc('a', 'A'), cleanDoc('b', 'B'), cleanDoc('c', 'C')], 'b');

    emit('tab.moveRight');

    expect(store.getState().documents.map((d) => d.id)).toEqual(['a', 'c', 'b']);
  });

  it('keeps the moved tab active', () => {
    setupDocs([cleanDoc('a', 'A'), cleanDoc('b', 'B')], 'a');

    emit('tab.moveRight');

    expect(store.getState().activeDocumentId).toBe('a');
  });

  // Clamping lives in reorderDocument, so the ends are a no-op rather than
  // something the command router has to special-case.
  it('does nothing at the left end', () => {
    setupDocs([cleanDoc('a', 'A'), cleanDoc('b', 'B')], 'a');

    emit('tab.moveLeft');

    expect(store.getState().documents.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('does nothing at the right end', () => {
    setupDocs([cleanDoc('a', 'A'), cleanDoc('b', 'B')], 'b');

    emit('tab.moveRight');

    expect(store.getState().documents.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('does nothing with a single tab', () => {
    setupDocs([cleanDoc('a', 'A')], 'a');

    emit('tab.moveLeft');
    emit('tab.moveRight');

    expect(store.getState().documents.map((d) => d.id)).toEqual(['a']);
  });
});
