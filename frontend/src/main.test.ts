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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildExtensions } from './editor/extensions';
import {
  DEFAULT_OUTLINE_WIDTH,
  createUntitledDocument,
  EMPTY_STATUS,
  isDirty,
  type Document,
  DEFAULT_BEHAVIOUR,
} from './state/document';
import { getEditorView, store } from './state/appcontext';
import { setWordWrap } from './editor/extensions';
import { COMMAND_EVENT } from './ui/menubar';
import { DEFAULT_PINNED } from './ui/toolbar';
import {
  ReadFile,
  ResetSettings,
  SaveSettings,
  ShowWindow,
  SystemThemeIsDark,
  WriteFile,
} from '../wailsjs/go/app/App';

vi.mock('../wailsjs/runtime/runtime', () => ({
  EventsOn: vi.fn(() => () => {}),
  Quit: vi.fn(),
  WindowMinimise: vi.fn(),
  // ui/filedrop.ts subscribes at module load. A missing export here is a hard
  // mock error rather than a silent fallback, which is how these five files
  // announced themselves the moment main.ts imported it.
  OnFileDrop: vi.fn(),
  OnFileDropOff: vi.fn(),
  // ui/fullscreen.ts reads this at startup. It returns a promise, so a bare
  // vi.fn() would make `await` yield undefined and set the flag to that.
  WindowIsFullscreen: vi.fn(async () => false),
  WindowFullscreen: vi.fn(),
  WindowUnfullscreen: vi.fn(),
  WindowSetBackgroundColour: vi.fn(),
  WindowSetTitle: vi.fn(),
  WindowShow: vi.fn(),
  WindowToggleMaximise: vi.fn(),
}));

vi.mock('../wailsjs/go/app/App', () => ({
  // bootstrap asks Go which files this launch was given (files/openwith.ts).
  // Without it the default parameter throws on property access, which happens
  // outside that function's try/catch and lands as an unhandled rejection --
  // the same way OnFileDrop announced itself in the runtime mock above.
  PendingFiles: vi.fn().mockResolvedValue([]),
  ConfirmQuit: vi.fn(),
  // Bound rather than the runtime's WindowShow so Go can tell a normal start
  // from a frontend that never got this far -- see App.showWindowEventually.
  ShowWindow: vi.fn(),
  // Resolved, not left as a bare vi.fn(): main.ts's bootstrap awaits this and
  // reads .appearance and .toolbar straight off the result, so leaving it
  // `undefined` (vi.fn()'s default) would push every test in this file
  // through bootstrap's settings-failed catch branch instead of the
  // tab/document routing this suite actually exercises. Only the fields
  // main.ts's bootstrap reads are present -- this is not a full app.Settings.
  // The pinned list is spelled out literally, not imported from
  // ui/toolbar.ts's DEFAULT_PINNED: vi.mock factories are hoisted above every
  // import in the file, so a reference to an imported binding here would hit
  // the temporal dead zone. It is still the same ten ids -- see the
  // 'defaults to the pinned set SPEC §6.13 names' test in toolbar.test.ts,
  // which is what pins DEFAULT_PINNED to this exact list.
  LoadSettings: vi.fn().mockResolvedValue({
    appearance: { theme: 'system', accentColor: '#0078d4' },
    // bootstrap validates `window.previewSplitRatio` and seeds the store with it.
    window: {
      previewSplitRatio: 0.5,
      statusBarVisible: true,
      outlineVisible: false,
      outlineWidth: 240,
    },
    // Also read by bootstrap. Go always sends the block, so a mock without it
    // would make bootstrap throw where the real app never can.
    // Both blocks are read by bootstrap and Go always sends them, so a mock
    // without them makes bootstrap throw where the real app never can -- and a
    // bootstrap that throws silently runs its `catch` path, seeding every
    // setting from the compiled-in defaults instead of from this mock. That is
    // exactly what happened to this file between G.1 and G.2: `editor` was
    // added to the read and not to the mock, and no test noticed.
    preview: { syncScroll: true },
    editor: { wordWrap: true },
    // Go always sends this block, so a mock without it makes bootstrap throw
    // where the real app never can -- and a bootstrap that throws runs its
    // catch path, seeding every setting from the compiled-in defaults instead
    // of from this mock. See main.toolbarSeed.test.ts for the time that bit.
    files: { defaultEncoding: 'utf-8' },
    toolbar: {
      visible: true,
      pinned: [
        'bold',
        'italic',
        'strikethrough',
        'inlineCode',
        'heading',
        'bulletList',
        'numberedList',
        'taskList',
        'link',
        'table',
      ],
    },
  }),
  ReadFile: vi.fn(),
  ResetSettings: vi.fn(),
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
  store.setState(() => ({
    documents: docs,
    activeDocumentId: activeId,
    isDark: false,
    closedPaths,
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
  const active = docs.find((d) => d.id === activeId);
  if (active) getEditorView().setState(active.editorState);
}

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  // Dynamic, not static: main.ts reads `#app` from the DOM the instant it is
  // evaluated, so the element above must exist before that happens -- a
  // static top-level import would run before this callback's body does.
  await import('./main');
  // bootstrap() (main.ts) is fire-and-forget (`void bootstrap()`), and since
  // Task 8 it resolves settings.toolbar before mounting anything, so its
  // work is not necessarily done the instant the import above settles.
  // ShowWindow() is the last thing bootstrap's finally block does, so
  // waiting for it is waiting for bootstrap to have fully finished.
  await vi.waitFor(() => expect(ShowWindow).toHaveBeenCalled());
});

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * ui/toolbar.ts's buttons dispatch `format.<id>` rather than calling a
 * command directly (see its header comment for why); this is the one place
 * that routing actually reaches a live `EditorView` rather than a bare
 * COMMANDS lookup, which toolbar.test.ts cannot exercise since buildToolbar
 * never touches the store or the view.
 */
describe('format.<id> commands', () => {
  it('runs the named command against the active document', () => {
    const a = cleanDoc('a', 'hello world');
    setupDocs([a], 'a');
    getEditorView().dispatch({ selection: { anchor: 0, head: 5 } }); // select "hello"

    emit('format.bold');

    expect(getEditorView().state.doc.toString()).toBe('**hello** world');
  });

  // heading and overflow are inert in this task (Task 7 owns their popups),
  // so no button ever emits these today -- but the router must not throw if
  // one somehow arrives, e.g. from a future caller that gets the id wrong.
  it('does nothing for an id with no matching command, rather than throwing', () => {
    const a = cleanDoc('a', 'hello world');
    setupDocs([a], 'a');

    expect(() => emit('format.heading')).not.toThrow();
    expect(getEditorView().state.doc.toString()).toBe('hello world');
  });
});

/**
 * ui/toolbar.ts's right-click pin/unpin popup emits these on the shared bus
 * (`choosePinItem`) for this router to persist -- see setToolbarPinned's own
 * comment for why the toolbar's own redraw does not wait for any of this.
 */
describe('toolbar.pin: / toolbar.unpin: commands', () => {
  beforeEach(() => {
    store.setState((prev) => ({ ...prev, pinnedToolbarCommands: [...DEFAULT_PINNED] }));
  });

  // A wrong implementation that persists but forgets to update the store
  // (e.g. only ever calling LoadSettings/SaveSettings) would still get
  // 'italic' onto disk eventually, but the store -- SPEC §6.13's "every
  // setting takes effect immediately" -- would lag behind, which is what
  // this catches by asserting with no `await`.
  it('adds the command to pinnedToolbarCommands immediately, before any persistence round trip', () => {
    expect(store.getState().pinnedToolbarCommands).not.toContain('highlight');

    emit('toolbar.pin:highlight');

    expect(store.getState().pinnedToolbarCommands).toContain('highlight');
  });

  it('removes the command from pinnedToolbarCommands immediately when unpinned', () => {
    expect(store.getState().pinnedToolbarCommands).toContain('bold');

    emit('toolbar.unpin:bold');

    expect(store.getState().pinnedToolbarCommands).not.toContain('bold');
  });

  // Pins the *set*, not just membership: a wrong implementation that always
  // appended on 'pin' -- even to an id already present -- would leave 'bold'
  // twice in the list. buildToolbar itself would render that harmlessly (it
  // asks "is this id pinned", not "how many times"), so only a length
  // assertion on the raw list catches the duplicate.
  it('does not duplicate an id that is already pinned when told to pin it again', () => {
    emit('toolbar.pin:bold'); // 'bold' is already in DEFAULT_PINNED

    const pinned = store.getState().pinnedToolbarCommands;
    expect(pinned.filter((id) => id === 'bold')).toHaveLength(1);
  });

  it('persists the updated pinned list through SaveSettings', async () => {
    emit('toolbar.pin:highlight');

    await vi.waitFor(() => expect(SaveSettings).toHaveBeenCalled());
    const saved = vi.mocked(SaveSettings).mock.calls[0]![0];
    expect(saved.toolbar.pinned).toContain('highlight');
  });

  // Same ordering and error handling as setThemeMode: the visible change
  // (the store update above) already happened, so a disk error must be
  // logged, not thrown, and must not undo it.
  it('logs, but does not throw or revert the store, when the persistence round trip fails', async () => {
    vi.mocked(SaveSettings).mockRejectedValueOnce(new Error('disk full'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => emit('toolbar.pin:highlight')).not.toThrow();
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());

    expect(store.getState().pinnedToolbarCommands).toContain('highlight');
    consoleError.mockRestore();
  });
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

describe('theme.system / theme.light / theme.dark commands', () => {
  it('theme.light applies the light theme immediately, with no await needed', () => {
    // Start from a known non-light state so the assertion below can't pass
    // by accident (e.g. the dataset attribute never having been set).
    emit('theme.dark');
    expect(document.documentElement.dataset.theme).toBe('dark');

    emit('theme.light');

    // setThemeMode applies before its first await (LoadSettings), so this is
    // true synchronously right after the event dispatch returns.
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(store.getState().isDark).toBe(false);
  });

  it('theme.dark applies the dark theme immediately, with no await needed', () => {
    emit('theme.light');
    expect(document.documentElement.dataset.theme).toBe('light');

    emit('theme.dark');

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(store.getState().isDark).toBe(true);
  });

  it('theme.system re-reads the system preference immediately rather than keeping the prior theme', async () => {
    // Windows currently reports light, matching SPEC's example of switching
    // Dark -> System while the OS is light -- this must go light right away,
    // not wait for the next focus event to notice.
    vi.mocked(SystemThemeIsDark).mockResolvedValueOnce(false);
    emit('theme.dark');
    expect(document.documentElement.dataset.theme).toBe('dark');

    emit('theme.system');

    await vi.waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    expect(store.getState().isDark).toBe(false);
  });

  it.each([
    ['theme.system', 'system'],
    ['theme.light', 'light'],
    ['theme.dark', 'dark'],
  ])('%s persists "%s" through SaveSettings', async (command, mode) => {
    emit(command);

    await vi.waitFor(() => expect(SaveSettings).toHaveBeenCalled());
    const saved = vi.mocked(SaveSettings).mock.calls[0]![0];
    expect(saved.appearance.theme).toBe(mode);
  });

  // The regression this guards against: picking Light (or Dark) and then
  // alt-tabbing back into the window must not silently revert to the system
  // theme. themeMode is set synchronously at the top of setThemeMode, before
  // any await, so the focus listener's `themeMode !== 'system'` guard must
  // already see 'light' by the time this dispatch runs -- proven here by the
  // fact that it never even asks the OS for the system preference.
  it('an explicit Light choice survives a window focus event', async () => {
    emit('theme.light');
    await vi.waitFor(() => expect(SaveSettings).toHaveBeenCalled());
    expect(document.documentElement.dataset.theme).toBe('light');

    vi.mocked(SystemThemeIsDark).mockClear();
    window.dispatchEvent(new Event('focus'));

    expect(SystemThemeIsDark).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(store.getState().isDark).toBe(false);
  });

  it('an explicit Dark choice survives a window focus event', async () => {
    emit('theme.dark');
    await vi.waitFor(() => expect(SaveSettings).toHaveBeenCalled());
    expect(document.documentElement.dataset.theme).toBe('dark');

    vi.mocked(SystemThemeIsDark).mockClear();
    window.dispatchEvent(new Event('focus'));

    expect(SystemThemeIsDark).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(store.getState().isDark).toBe(true);
  });
});

/**
 * The status bar's encoding and line-ending menus (SPEC 6.11). `statusbar.ts`
 * emits the command; this is the half that acts on it.
 */
describe('the encoding and line-ending commands', () => {
  it('writes the choice to the active document and makes it dirty', () => {
    const doc = cleanDoc('enc', 'hello', 'C:/notes.md');
    setupDocs([doc], doc.id);
    expect(isDirty(store.getState().documents[0]!)).toBe(false);

    emit('document.lineEnding:lf');

    const after = store.getState().documents[0]!;
    expect(after.lineEnding).toBe('lf');
    // The point of the whole file-model change: a metadata edit is a real,
    // saveable change, so the tab shows a dirty dot and Ctrl+S has work to do.
    expect(isDirty(after)).toBe(true);
    // And it did not touch the disk on its own -- opening a dropdown is not a
    // request to write the file.
    expect(WriteFile).not.toHaveBeenCalled();
  });

  it('writes the encoding too, leaving the line ending alone', () => {
    const doc = cleanDoc('enc2', 'hello', 'C:/notes.md');
    setupDocs([doc], doc.id);

    emit('document.encoding:utf-16le');

    const after = store.getState().documents[0]!;
    expect(after.encoding).toBe('utf-16le');
    expect(after.lineEnding).toBe(doc.lineEnding);
  });

  it('only touches the active document', () => {
    const active = cleanDoc('a', 'one');
    const other = cleanDoc('b', 'two');
    setupDocs([active, other], active.id);

    emit('document.encoding:utf-8-bom');

    expect(store.getState().documents.find((d) => d.id === 'b')!.encoding).toBe(other.encoding);
  });

  /**
   * The bus is a `document`-level event anything can dispatch to, and the value
   * ends up in Go's `WriteFile`. An unrecognised one must be dropped rather than
   * written into the document as an encoding no decoder knows.
   */
  it('ignores a value it does not recognise', () => {
    const doc = cleanDoc('enc3', 'hello');
    setupDocs([doc], doc.id);

    emit('document.encoding:latin-1');

    expect(store.getState().documents[0]!.encoding).toBe(doc.encoding);
    expect(isDirty(store.getState().documents[0]!)).toBe(false);
  });
});

/**
 * Edit > Find (SPEC 6.7). The keymap binds `openSearchPanel` straight into the
 * editor; this is the menu's way to the same command, and the only part of the
 * find feature that lives in main.ts.
 */
describe('the Find and Replace menu items', () => {
  it('opens the find panel', () => {
    expect(document.querySelector('.findbar')).toBeNull();

    emit('edit.find');

    expect(document.querySelector('.findbar')).not.toBeNull();
    // Put it away again: main.ts is a module singleton shared by this file, and
    // a panel left open changes what the next test sees.
    document.querySelector<HTMLButtonElement>('.findbar__close')!.click();
  });

  /**
   * One entry, not two, at the owner's request. Asserted against the rendered
   * menu rather than against main.ts's routing: an `edit.replace` item could be
   * added back to the menu and route nowhere, which is invisible to a test that
   * only emits commands -- and that is exactly what the first version of this
   * checked.
   */
  it('offers one combined Edit menu entry rather than one for each', () => {
    const edit = [...document.querySelectorAll<HTMLButtonElement>('.menubar button')].find(
      (button) => button.textContent === 'Edit',
    )!;
    edit.click();

    const items = [...document.querySelectorAll('.menu-popup [role="menuitem"]')].map((item) => ({
      label: item.querySelector('span')?.textContent ?? '',
      shortcut: item.querySelector('kbd')?.textContent ?? '',
    }));

    expect(items.filter((item) => /find|replace/i.test(item.label))).toEqual([
      { label: 'Find and Replace…', shortcut: 'Ctrl+F' },
    ]);
    edit.click();
  });

  /** And the command it replaced is gone from the router with it. */
  it('no longer routes a separate replace command', () => {
    emit('edit.replace');

    expect(document.querySelector('.findbar')).toBeNull();
  });
});

/**
 * The frameless window's resize border. `ui/windowedges.test.ts` covers what
 * each strip does; this is the half that puts them on screen at all, which
 * nothing else would notice going missing.
 */
describe('the window resize border', () => {
  it('mounts all eight strips onto #app', () => {
    const edges = document.querySelectorAll('#app > .window-edge');

    expect([...edges].map((e) => (e as HTMLElement).dataset.edge)).toEqual([
      'n',
      's',
      'e',
      'w',
      'ne',
      'nw',
      'se',
      'sw',
    ]);
  });
});

/**
 * View > Outline, Ctrl+Shift+O (SPEC 6.9). The sidebar itself is
 * `ui/outlinepane.test.ts`'s subject; this is main.ts's half.
 */
describe('the outline toggle', () => {
  beforeEach(() => {
    vi.mocked(SaveSettings).mockClear();
  });

  /**
   * Closed through the real command rather than by removing the node, so the
   * handle and the settings write come back to rest too.
   *
   * In `afterEach` and not at the end of each test body, because a failing
   * assertion aborts before that line -- `main.ts` is a module singleton shared
   * by this whole file, so one failure would leave the sidebar open and the
   * *next* test's toggle would close it instead of opening it. That is exactly
   * what happened when the resize gutter first changed this row's children: one
   * real failure arrived wearing two.
   */
  afterEach(() => {
    if (document.querySelector('.outline-column') !== null) emit('view.outline');
  });

  /**
   * Hidden by default (SPEC 6.9), and the mocked settings say so -- so a sidebar
   * present before anything is clicked would mean bootstrap ignored the setting.
   */
  it('starts hidden, then mounts and unmounts on the command', async () => {
    expect(document.querySelector('.outline-column')).toBeNull();

    emit('view.outline');
    expect(document.querySelector('.outline-column')).not.toBeNull();
    await vi.waitFor(() => expect(SaveSettings).toHaveBeenCalled());
    expect(vi.mocked(SaveSettings).mock.calls[0]![0].window.outlineVisible).toBe(true);

    emit('view.outline');
    expect(document.querySelector('.outline-column')).toBeNull();
  });

  /**
   * Inside the workspace row, not beside it in `#app`. If it landed in `#app`
   * the sidebar would sit *above* the editor rather than left of it, because
   * `#app` is a flex column -- the same mistake the toolbar once made.
   */
  /**
   * **Asserted by `classList`, not by the whole `className` string**, and that
   * is a flake fix rather than a style preference. The original compared the
   * exact class attribute, which made it depend on state no part of this test
   * sets: a case that leaves a document in reading mode adds
   * `editor-split--reading` to that same element, and the assertion then failed
   * with `"editor-split editor-split--reading"` against `"editor-split"`.
   *
   * Caught by `--sequence.shuffle`, on two runs out of three, and *not*
   * reproducible on demand -- six further runs on the same tree and six on the
   * commit before it all passed. A test that depends on the order it happens to
   * run in reports the shuffle seed, not a defect. What this case is actually
   * about is which column comes first, so that is all it now asserts.
   */
  it('mounts inside the workspace row, to the left of the editor', () => {
    emit('view.outline');
    const children = [...document.querySelector('.workspace')!.children];
    expect(children).toHaveLength(2);
    expect(children[0]!.classList.contains('outline-column')).toBe(true);
    expect(children[1]!.classList.contains('editor-split')).toBe(true);
  });

  it('lists the active document’s headings', () => {
    const doc = cleanDoc('outlined', ['# Title', '', '## Section'].join(String.fromCharCode(10)));
    setupDocs([doc], doc.id);

    emit('view.outline');

    const labels = [...document.querySelectorAll('.outline__item')].map((b) => b.textContent);
    expect(labels).toEqual(['Title', 'Section']);
  });
});

/**
 * View > Status Bar (SPEC 6.11). The row itself is `ui/statusbar.test.ts`'s
 * subject; what these prove is main.ts's half -- that the command mounts and
 * unmounts rather than hiding, and that the choice reaches settings.json.
 */
describe('the status bar toggle', () => {
  beforeEach(() => {
    vi.mocked(SaveSettings).mockClear();
  });

  /**
   * Unmounted, not hidden. A row left in the DOM behind a `display: none` would
   * keep its store subscription and keep rebuilding six spans on every
   * keystroke -- and it would satisfy any assertion written against
   * visibility rather than presence. Same reasoning, and the same shape of
   * test, as `main.toolbarHidden.test.ts`.
   */
  it('removes the row from the DOM and puts it back', async () => {
    // Snapshotted at call time, not read off `mock.calls` afterwards.
    // `LoadSettings` resolves one shared object and `setStatusBarSetting`
    // mutates it in place, so `calls[0][0]` and `calls[1][0]` are the *same*
    // object and both would read whatever the last write left -- an assertion
    // that happens to hold only because of where it sits in this test.
    const saved: boolean[] = [];
    vi.mocked(SaveSettings).mockImplementation(async (settings) => {
      saved.push(settings.window.statusBarVisible);
    });

    expect(document.querySelector('.statusbar')).not.toBeNull();

    emit('view.statusBar');
    expect(document.querySelector('.statusbar')).toBeNull();
    await vi.waitFor(() => expect(saved).toHaveLength(1));

    emit('view.statusBar');
    expect(document.querySelector('.statusbar')).not.toBeNull();
    await vi.waitFor(() => expect(saved).toHaveLength(2));

    expect(saved).toEqual([false, true]);
  });

  /**
   * It stays the last child. `mountStatusBar` appends, so a row remounted while
   * anything else had been added after it would come back in the wrong place --
   * and today nothing is, which is exactly why an assertion about order is
   * worth having before G.3 adds something.
   */
  it('comes back as the last row', () => {
    emit('view.statusBar');
    emit('view.statusBar');

    const app = document.querySelector('#app')!;
    expect([...app.children].pop()!.className).toBe('statusbar');
  });

  /**
   * The failure has already happened by the time the disk write is attempted --
   * SPEC 6.13's "every setting takes effect immediately" -- so a rejected
   * SaveSettings must not put the row back.
   */
  it('keeps the change when persisting it fails', async () => {
    vi.mocked(SaveSettings).mockRejectedValueOnce(new Error('disk full'));

    emit('view.statusBar');
    await vi.waitFor(() => expect(SaveSettings).toHaveBeenCalled());

    expect(document.querySelector('.statusbar')).toBeNull();
    // Put it back: main.ts is a module singleton shared by every test in this
    // file, so a test that leaves the row off is a test that changes what the
    // next one sees -- and `--sequence.shuffle` decides which one that is.
    emit('view.statusBar');
  });
});

/**
 * SPEC §6.13's dialog reached through the bus, which is what makes File >
 * Settings and Ctrl+, one implementation rather than two.
 *
 * `ui/settingsdialog.test.ts` covers what the dialog *does*; this covers only
 * that the command finds it -- a route that is easy to leave out, because both
 * halves pass their own tests while the menu entry does nothing.
 */
describe('settings.open', () => {
  afterEach(() => {
    document.querySelector('.settings-dialog')?.remove();
  });

  it('opens the settings dialog', async () => {
    emit('settings.open');

    await vi.waitFor(() => {
      expect(document.querySelector('.settings-dialog')).not.toBeNull();
    });
  });

  /**
   * Two modals in the top layer is not a state worth being able to reach, and
   * the menu entry stays clickable behind a dialog whose backdrop has not
   * rendered. `ui/shortcuts.ts` already refuses to forward chords while a
   * `dialog[open]` is up, so this is the other door.
   */
  it('does not stack a second dialog on the first', async () => {
    emit('settings.open');
    await vi.waitFor(() => expect(document.querySelectorAll('.settings-dialog')).toHaveLength(1));

    emit('settings.open');
    // The second call has to be given the same chance the first had. Its guard
    // runs synchronously, but the code it guards does not: without the guard
    // `openSettings` awaits `LoadSettings` and only then appends, so asserting
    // straight after the `emit` would count one dialog whether or not the guard
    // exists. Long enough for a resolved mock promise and an append; a real
    // stack would have happened many times over.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(document.querySelectorAll('.settings-dialog')).toHaveLength(1);
  });
});

/**
 * `settings.reset` — the command behind the dialog's Reset button.
 *
 * What matters here and nowhere else is that the defaults are *re-applied to
 * the running app*, not merely written to disk. Go owns what "default" means;
 * settingsdialog.test.ts owns the button and the prompt. This is the join.
 */
describe('settings.reset', () => {
  /**
   * Deliberately unlike Go's defaults in every block this handler reads, so a
   * handler that applied its own idea of the defaults -- or applied nothing and
   * relied on the store already being right -- cannot pass.
   */
  function defaults(): unknown {
    return {
      version: 2,
      appearance: { theme: 'system', accentColor: '#0078d4', uiFontSize: 14 },
      editor: {
        fontFamily: 'Cascadia Mono',
        fontSize: 14,
        lineHeight: 1.6,
        wordWrap: true,
        maxContentWidth: 0,
        showLineNumbers: false,
        tabSize: 2,
        insertSpaces: true,
        defaultViewMode: 'source',
        openedViewMode: 'preview',
        recentViewModes: [],
      },
      preview: { fontFamily: 'Segoe UI', fontSize: 15, syncScroll: true },
      files: {
        autosave: false,
        autosaveDelayMs: 2000,
        assetFolder: 'assets',
        defaultEncoding: 'utf-8',
      },
      window: {
        width: 1000,
        height: 700,
        maximized: false,
        outlineVisible: false,
        outlineWidth: 240,
        statusBarVisible: true,
        previewSplitRatio: 0.5,
      },
      toolbar: { visible: true, pinned: ['bold', 'italic'] },
    };
  }

  /** Everything this handler touches, moved off its default first. */
  function derange(): void {
    store.setState((prev) => ({
      ...prev,
      wordWrap: false,
      editorBehaviour: { showLineNumbers: true, tabSize: 8, insertSpaces: false },
      defaultViewMode: 'split',
      openedViewMode: 'preview',
      recentViewModes: [],
      defaultEncoding: 'utf-16le',
      syncScroll: false,
      autosave: true,
      autosaveDelayMs: 9000,
      previewSplitRatio: 0.2,
      outlineWidth: 400,
    }));
  }

  afterEach(() => {
    document.querySelector('.settings-dialog')?.remove();
  });

  it('puts every store field back', async () => {
    vi.mocked(ResetSettings).mockResolvedValue(defaults() as never);
    derange();

    emit('settings.reset');

    await vi.waitFor(() => expect(store.getState().wordWrap).toBe(true));
    const state = store.getState();
    expect(state.editorBehaviour).toEqual({
      showLineNumbers: false,
      tabSize: 2,
      insertSpaces: true,
    });
    expect(state.defaultViewMode).toBe('source');
    expect(state.defaultEncoding).toBe('utf-8');
    expect(state.syncScroll).toBe(true);
    // Autosave especially: a reset that left it on would keep writing the
    // user's files on a timer they have just asked to be rid of.
    expect(state.autosave).toBe(false);
    expect(state.autosaveDelayMs).toBe(2000);
    expect(state.previewSplitRatio).toBeCloseTo(0.5);
    expect(state.outlineWidth).toBeCloseTo(240);
  });

  /**
   * The store alone is a half-wired reset: the editor is already constructed,
   * and only a reconfigure reaches it. This is the same gap mutation testing
   * found in `settings/live.ts` -- worth asserting on the path that re-applies
   * *everything*, because it is the one where forgetting is least visible.
   */
  it('reconfigures the live editor, not just the store', async () => {
    vi.mocked(ResetSettings).mockResolvedValue(defaults() as never);
    store.setState((prev) => ({ ...prev, wordWrap: false }));
    setWordWrap(getEditorView(), false);
    expect(getEditorView().contentDOM.className).not.toContain('cm-lineWrapping');

    emit('settings.reset');

    await vi.waitFor(() => {
      expect(getEditorView().contentDOM.className).toContain('cm-lineWrapping');
    });
  });

  it('re-applies the typography to the page', async () => {
    vi.mocked(ResetSettings).mockResolvedValue(defaults() as never);
    document.documentElement.style.setProperty('--size-ui', '99px');

    emit('settings.reset');

    await vi.waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--size-ui')).toBe('14px');
    });
  });

  /**
   * Rebuilt rather than left showing the old values. Every control is populated
   * when the dialog is built, so a reset that skipped this would leave the user
   * looking at the settings they had just thrown away.
   */
  it('rebuilds the settings dialog with the new values', async () => {
    vi.mocked(ResetSettings).mockResolvedValue(defaults() as never);
    emit('settings.open');
    await vi.waitFor(() => expect(document.querySelector('.settings-dialog')).not.toBeNull());
    const first = document.querySelector('.settings-dialog');

    emit('settings.reset');

    await vi.waitFor(() => {
      const now = document.querySelector('.settings-dialog');
      expect(now).not.toBeNull();
      expect(now).not.toBe(first);
    });
  });

  /**
   * **A failed reset changes nothing.** Wails rejects the promise and discards
   * the value, so there is no half-state to land in -- and a reset that seemed
   * to work while the file still held the old settings would be discovered at
   * the next launch, with nothing to connect it to.
   */
  it('leaves the running app alone when the write fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(ResetSettings).mockRejectedValue(new Error('disk full'));
    derange();

    emit('settings.reset');

    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    expect(store.getState().wordWrap).toBe(false);
    expect(store.getState().editorBehaviour.tabSize).toBe(8);
    errors.mockRestore();
  });
});

/**
 * SPEC §3.2's autosave from the File menu (H.6).
 *
 * The switch exists in two places now -- here and the settings dialog -- and
 * the point of this group is that they are one switch. Both route through
 * `settings/live.ts`, so the store is what proves it: a menu entry with its own
 * private copy of the logic would still reach `SaveSettings` and still look
 * right in a test that only watched the disk.
 */
describe('file.autosave', () => {
  it('turns autosave on, in the store and on disk', async () => {
    store.setState((prev) => ({ ...prev, autosave: false }));

    emit('file.autosave');

    expect(store.getState().autosave).toBe(true);
    await vi.waitFor(() => {
      expect(vi.mocked(SaveSettings).mock.lastCall?.[0].files.autosave).toBe(true);
    });
  });

  it('turns it off again', async () => {
    store.setState((prev) => ({ ...prev, autosave: true }));

    emit('file.autosave');

    expect(store.getState().autosave).toBe(false);
    await vi.waitFor(() => {
      expect(vi.mocked(SaveSettings).mock.lastCall?.[0].files.autosave).toBe(false);
    });
  });

  /**
   * **The tick in the real menu, not one a test supplied.**
   *
   * `menubar.test.ts` hands `mountMenuBar` its own `isChecked`, so it can prove
   * the *bar* renders a tick and can never prove main.ts's callback reads
   * anything. Replacing that callback's body with `return false` left the whole
   * suite green until this existed -- the menu would have shown Autosave off
   * forever while it was on. Mutation testing said so.
   */
  it('shows the store’s value as the tick in the File menu', async () => {
    store.setState((prev) => ({ ...prev, autosave: true }));

    const file = [...document.querySelectorAll<HTMLButtonElement>('.menubar button')].find(
      (button) => button.textContent === 'File',
    )!;
    // Popups are rebuilt on every open, so the state is read now rather than
    // cached -- which is what makes opening the menu the way to observe it.
    file.click();
    const entry = [...document.querySelectorAll('.menu-popup [role="menuitemcheckbox"]')].find(
      (candidate) => candidate.querySelector('.menu-item__label')?.textContent === 'Autosave',
    )!;

    expect(entry.getAttribute('aria-checked')).toBe('true');
    file.click();
  });

  /**
   * A toggle reads the *current* value rather than assuming one. Hard-coding
   * `true` would work the first time and never turn it off again -- which is
   * the failure a single "it turns on" case would miss entirely.
   */
  it('reflects the store rather than a value of its own', async () => {
    store.setState((prev) => ({ ...prev, autosave: false }));
    emit('file.autosave');
    await vi.waitFor(() => expect(store.getState().autosave).toBe(true));

    emit('file.autosave');
    await vi.waitFor(() => expect(store.getState().autosave).toBe(false));
  });
});
