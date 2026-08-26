// @vitest-environment jsdom
/**
 * The Ctrl+Shift+P half of Task 6, in its own file for the same reason
 * main.toolbarSeed.test.ts is: a bootstrap runs once per module instance, and
 * this one needs a settings file whose `window.previewSplitRatio` is
 * deliberately *not* the compiled-in default, so "the store was seeded from
 * settings" is falsifiable rather than true by coincidence.
 *
 * What this file covers that pane.test.ts cannot: the pane is reached through
 * a dynamic import, so only a real bootstrap proves the toggle actually loads
 * it, wires it to the split container main.ts built, and moves the document's
 * `viewMode` -- including putting back the mode it interrupted.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getEditorView, store } from './state/appcontext';
import { activeDocument } from './state/documents';
import { COMMAND_EVENT } from './ui/menubar';
import { SaveSettings, ShowWindow } from '../wailsjs/go/app/App';

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
  ConfirmQuit: vi.fn(),
  ShowWindow: vi.fn(),
  LoadSettings: vi.fn().mockResolvedValue({
    appearance: { theme: 'system', accentColor: '#0078d4' },
    toolbar: { visible: true, pinned: ['bold'] },
    // Not 0.5: the compiled-in default is 0.5, so a bootstrap that never read
    // settings at all would pass a 0.5 assertion.
    window: {
      previewSplitRatio: 0.3,
      statusBarVisible: true,
      outlineVisible: false,
      outlineWidth: 240,
    },
    // False for the same reason, the compiled-in default being true (Go's
    // `DefaultSettings`, and state/appcontext.ts's placeholder).
    preview: { syncScroll: false },
    // Likewise false against a compiled-in true, so a bootstrap that never read
    // settings cannot pass by coincidence.
    editor: { wordWrap: false },
    // Go always sends this block, so a mock without it makes bootstrap throw
    // where the real app never can -- and a bootstrap that throws runs its
    // catch path, seeding every setting from the compiled-in defaults instead
    // of from this mock. See main.toolbarSeed.test.ts for the time that bit.
    files: { defaultEncoding: 'utf-8' },
  }),
  ReadFile: vi.fn(),
  ResetSettings: vi.fn(),
  SaveSettings: vi.fn(),
  ShowOpenDialog: vi.fn(),
  ShowSaveDialog: vi.fn(),
  SystemThemeIsDark: vi.fn().mockResolvedValue(false),
  WriteFile: vi.fn(),
}));

function emit(command: string): void {
  document.dispatchEvent(new CustomEvent<string>(COMMAND_EVENT, { detail: command }));
}

/**
 * The toggle is async (it imports the pane), so every case has to wait.
 *
 * The explicit timeout is not padding. `vi.waitFor` defaults to 1000 ms, and
 * what this waits on is a dynamic import of the whole preview chunk --
 * markdown-it, DOMPurify, style-mod and CodeMirror's language data, ~155 kB,
 * transformed on first use. Alone on an idle machine that lands in ~500 ms; in
 * a full-suite run competing with 25 other files it has been measured at
 * 1279 ms, and every `view.preview` case then failed at once with "expected
 * false to be true". A test whose result depends on how busy the machine is
 * reports a load average, not a defect.
 */
function waitForPane(present: boolean): Promise<void> {
  return vi.waitFor(
    () => {
      expect(document.querySelector('.preview-pane') !== null).toBe(present);
    },
    { timeout: 10_000 },
  );
}

/**
 * `previousViewMode` is deliberately reset to 'source' rather than to `mode`:
 * a live document whose remembered mode already said 'live' would let a
 * toggle that never records anything still restore correctly, and that is the
 * exact bug the restore test below exists to catch.
 */
function setViewModeOf(id: string, mode: 'source' | 'live'): void {
  store.setState((prev) => ({
    ...prev,
    documents: prev.documents.map((doc) =>
      doc.id === id ? { ...doc, viewMode: mode, previousViewMode: 'source' as const } : doc,
    ),
  }));
}

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  await import('./main');
  await vi.waitFor(() => expect(ShowWindow).toHaveBeenCalled());
});

/**
 * `main.ts` is a module singleton: one bootstrap, one `#app` tree and one
 * cached `previewHandle` for the whole file, so a case that finishes with the
 * pane open changes what the next case starts from. Under
 * `--sequence.shuffle.tests` "the next case" is any of them -- which is how
 * the bootstrap layout assertion below, written when it could rely on running
 * first, failed with the pane's two nodes still in the split row.
 *
 * Closed through the real command rather than by removing the nodes, so the
 * handle and the document's `viewMode` come back to rest too.
 */
afterEach(async () => {
  if (document.querySelector('.preview-pane') !== null) {
    emit('view.preview');
    await waitForPane(false);
  }
  // The toggle is sticky now, so it leaves `defaultViewMode` behind in the
  // shared store -- and the early return above means a case that ended in
  // source mode never even ran the toggle that would have reset it. Under
  // `--sequence.shuffle` the next test to open a tab would inherit whatever
  // this one happened to leave, so it is reset explicitly rather than by
  // side effect.
  store.setState((prev) => ({ ...prev, defaultViewMode: 'source' }));
});

describe('bootstrap', () => {
  it('seeds the split ratio from settings rather than the compiled-in default', () => {
    expect(store.getState().previewSplitRatio).toBeCloseTo(0.3);
  });

  it('seeds word wrap from settings, and applies it to the live view', () => {
    expect(store.getState().wordWrap).toBe(false);
    // The store alone would be a half-wired setting: the editor is constructed
    // before LoadSettings resolves, so bootstrap has to reconfigure the view too.
    expect(getEditorView().contentDOM.className).not.toContain('cm-lineWrapping');
  });

  /**
   * Same reasoning as the ratio above, and the same reason the mock says
   * `false`: the store's placeholder and Go's default are both `true`, so this
   * only passes if bootstrap really read the file.
   */
  it('seeds the scroll-sync setting from settings too', () => {
    expect(store.getState().syncScroll).toBe(false);
  });

  // #app is a flex column, so the editor and the preview need a row of their
  // own -- and the toolbar has to keep landing above that row, not inside it.
  it('wraps the editor in a split row, with the toolbar still above it', () => {
    // `.window-edge` children are the frameless window's resize border
    // (ui/windowedges.ts), fixed to the viewport rather than laid out in the
    // column -- not rows, so not part of this assertion.
    const rows = [...document.querySelector('#app')!.children]
      .map((child) => child.className)
      .filter((name) => !name.startsWith('window-edge'));

    expect(rows).toEqual([
      'menubar',
      'tabbar',
      'toolbar',
      // The outline sidebar lives *inside* this row, not beside it in `#app` --
      // see main.ts for why the two rows are nested.
      'workspace',
      'statusbar',
    ]);
    const split = document.querySelector('.editor-split')!;
    expect([...split.children].map((c) => c.className)).toEqual(['editor-area']);
  });
});

describe('view.wordWrap', () => {
  /**
   * Toggled back at the end rather than left flipped: `main.ts` is a module
   * singleton, so this is shared state and the bootstrap assertions above read
   * it. Under `--sequence.shuffle.tests` "above" means nothing.
   */
  afterEach(() => {
    if (store.getState().wordWrap) emit('view.wordWrap');
  });

  it('toggles the store, the live view, and the settings file together', async () => {
    expect(store.getState().wordWrap).toBe(false);

    emit('view.wordWrap');

    expect(store.getState().wordWrap).toBe(true);
    // The store on its own would leave the editor unchanged until the next
    // document; the view is what the user is looking at.
    expect(getEditorView().contentDOM.className).toContain('cm-lineWrapping');
    await vi.waitFor(() => expect(SaveSettings).toHaveBeenCalled());
    expect(vi.mocked(SaveSettings).mock.calls.at(-1)![0]).toMatchObject({
      editor: { wordWrap: true },
    });
  });
});

/**
 * The owner's report: "when I open Hashpad and press Ctrl+Shift+P, nothing
 * happens -- the only time I can use macros is when I press inside the editor".
 *
 * `ui/shortcuts.test.ts` covers the router in isolation; this is the wiring, and
 * it is here because this is the file already equipped to open and close the
 * pane (its `afterEach` puts it back). The key is dispatched at `document.body`,
 * which is where focus sits before anything has been clicked -- the exact
 * situation reported. `keyCode` as well as `key` because CodeMirror resolves a
 * shifted binding through it; see the note in `ui/shortcuts.test.ts`.
 */
describe('shortcuts with focus outside the editor', () => {
  it('opens the preview on a real Ctrl+Shift+P pressed on the body', async () => {
    const active = activeDocument(store.getState())!;
    setViewModeOf(active.id, 'source');

    document.body.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'P',
        keyCode: 80,
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      } as KeyboardEventInit),
    );
    await waitForPane(true);

    expect(document.querySelector('.editor-split > .preview-pane')).not.toBeNull();
    expect(activeDocument(store.getState())!.viewMode).toBe('split');
  });
});

describe('view.preview', () => {
  it('opens the pane inside the split row and puts the document in split mode', async () => {
    const active = activeDocument(store.getState())!;
    setViewModeOf(active.id, 'source');

    emit('view.preview');
    await waitForPane(true);

    expect(document.querySelector('.editor-split > .preview-pane')).not.toBeNull();
    expect(activeDocument(store.getState())!.viewMode).toBe('split');
  });

  /**
   * The content assertion is what pins the *order* inside `togglePreview`:
   * `show()` renders once, immediately, and it only renders when the document
   * is already in split mode -- so showing before setting the mode would leave
   * this pane blank until the user's next keystroke.
   */
  it('renders the document it opened on, at the ratio settings asked for', async () => {
    const active = activeDocument(store.getState())!;
    setViewModeOf(active.id, 'source');
    const view = getEditorView();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '# Live\n' } });

    emit('view.preview');
    await waitForPane(true);

    const pane = document.querySelector<HTMLElement>('.preview-pane')!;
    expect(pane.querySelector('h1')?.textContent).toBe('Live');
    expect(parseFloat(pane.style.flexBasis)).toBeCloseTo(30);
  });

  it('closes the pane again and restores source mode', async () => {
    const active = activeDocument(store.getState())!;
    setViewModeOf(active.id, 'source');
    emit('view.preview');
    await waitForPane(true);

    emit('view.preview');
    await waitForPane(false);

    expect(activeDocument(store.getState())!.viewMode).toBe('source');
    expect(document.querySelector('.preview-divider')).toBeNull();
  });

  /**
   * The reason `previousViewMode` exists at all. A document opened under
   * `editor.defaultViewMode: "live"` must come back as 'live' -- restoring a
   * hard-coded 'source' would silently downgrade it, and no test that only
   * ever toggles a source document could tell the difference.
   */
  it('returns a live-mode document to live, not to source', async () => {
    const active = activeDocument(store.getState())!;
    setViewModeOf(active.id, 'live');

    emit('view.preview');
    await waitForPane(true);
    expect(activeDocument(store.getState())!.previousViewMode).toBe('live');

    emit('view.preview');
    await waitForPane(false);
    expect(activeDocument(store.getState())!.viewMode).toBe('live');
  });

  /**
   * `viewMode` is per document but the pane is one shared widget, so it has to
   * follow the active tab. The failure this catches is quiet and specific: the
   * pane skips rendering a document that is not in split mode, so a pane left
   * open across a switch would sit there showing the tab you just left.
   */
  it('follows the active tab: gone on a source tab, back on the split one', async () => {
    const first = activeDocument(store.getState())!;
    setViewModeOf(first.id, 'source');
    const view = getEditorView();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '# Split tab\n' } });
    emit('view.preview');
    await waitForPane(true);

    // Put back into source mode by hand. A new tab *inherits* the split now
    // -- that is what `defaultViewMode` is for, and it is asserted below --
    // so `file.new` alone no longer produces the source tab this test needs.
    // What is being tested here is the pane following the tab, not what mode a
    // new tab starts in.
    emit('file.new');
    setViewModeOf(activeDocument(store.getState())!.id, 'source');
    expect(document.querySelector('.preview-pane')).toBeNull();

    emit('tab.previous');

    const pane = document.querySelector<HTMLElement>('.preview-pane')!;
    expect(pane).not.toBeNull();
    expect(pane.querySelector('h1')?.textContent).toBe('Split tab');
  });

  /**
   * **View > Preview is sticky, like every other View toggle.**
   *
   * Reported by the owner: open the preview, then open a document or close the
   * app, and it was gone. Word wrap, line numbers, the status bar and the
   * outline all write their setting the moment they are clicked; the preview
   * was the one that did not, and `editor.defaultViewMode` sat unread on both
   * sides of the bridge.
   *
   * Both destinations are asserted because they answer different questions.
   * The store field is what the *next tab in this session* reads
   * (documentops.ts); `settings.editor.defaultViewMode` is what the next launch
   * reads. An implementation that wrote only the store would fix "open another
   * document" and leave "close the app" broken -- which is half the report.
   */
  it('persists an opened preview to settings and to the store', async () => {
    setViewModeOf(activeDocument(store.getState())!.id, 'source');
    vi.mocked(SaveSettings).mockClear();

    emit('view.preview');
    await waitForPane(true);

    await vi.waitFor(() => {
      expect(vi.mocked(SaveSettings).mock.lastCall?.[0].editor.defaultViewMode).toBe('split');
    });
    expect(store.getState().defaultViewMode).toBe('split');
  });

  /**
   * The other direction, and not symmetric with the one above: toggling *off*
   * writes the mode it restored, not a hard-coded `'source'`. A live document
   * that had the preview opened over it must persist `'live'`, or the next
   * launch quietly downgrades it -- the same failure `previousViewMode` exists
   * to prevent, one layer out.
   */
  it('persists the restored mode when the preview is closed', async () => {
    setViewModeOf(activeDocument(store.getState())!.id, 'live');
    emit('view.preview');
    await waitForPane(true);

    vi.mocked(SaveSettings).mockClear();
    emit('view.preview');
    await waitForPane(false);

    await vi.waitFor(() => {
      expect(vi.mocked(SaveSettings).mock.lastCall?.[0].editor.defaultViewMode).toBe('live');
    });
    expect(store.getState().defaultViewMode).toBe('live');
  });

  /**
   * The report's own words: "if I ... open another document the preview
   * disappears". Through the real command, not by calling
   * `makeUntitledDocument` directly -- documentops.test.ts covers the unit, and
   * what this adds is that the store field the toggle wrote is the one the new
   * tab reads, with the pane still on screen at the end of it.
   */
  it('keeps the preview on a tab opened while it is showing', async () => {
    setViewModeOf(activeDocument(store.getState())!.id, 'source');
    emit('view.preview');
    await waitForPane(true);
    // The toggle writes the store field after the pane is mounted, so waiting
    // on the pane alone would race it.
    await vi.waitFor(() => {
      expect(store.getState().defaultViewMode).toBe('split');
    });

    emit('file.new');

    expect(activeDocument(store.getState())!.viewMode).toBe('split');
    expect(document.querySelector('.preview-pane')).not.toBeNull();
  });

  // The menu item shipped disabled and was flipped by this task. An
  // aria-disabled item is still focusable but `activateItem` refuses to run
  // its command (ui/menubar.ts), so this is what proves the flip happened.
  it('is reachable from View > Preview', async () => {
    const active = activeDocument(store.getState())!;
    setViewModeOf(active.id, 'source');

    document.querySelector<HTMLButtonElement>('#menubar-trigger-view')!.click();
    // `[role^="menuitem"]`, not `[role="menuitem"]`: Preview is a toggle and so
    // carries `menuitemcheckbox`, which is what makes a screen reader announce
    // its state. Matching on the label span rather than `textContent`, because
    // the latter now leads with the state indicator when the item is on.
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].find(
      (button) => button.querySelector('.menu-item__label')?.textContent === 'Preview',
    )!;
    expect(item.getAttribute('aria-disabled')).toBeNull();

    item.click();
    await waitForPane(true);
  });
});
