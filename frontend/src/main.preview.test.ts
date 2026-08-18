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
    window: { previewSplitRatio: 0.3 },
    // False for the same reason, the compiled-in default being true (Go's
    // `DefaultSettings`, and state/appcontext.ts's placeholder).
    preview: { syncScroll: false },
    // Likewise false against a compiled-in true, so a bootstrap that never read
    // settings cannot pass by coincidence.
    editor: { wordWrap: false },
  }),
  ReadFile: vi.fn(),
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
  if (document.querySelector('.preview-pane') === null) return;
  emit('view.preview');
  await waitForPane(false);
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
    const app = document.querySelector('#app')!;
    expect([...app.children].map((child) => child.className)).toEqual([
      'menubar',
      'tabbar',
      'toolbar',
      'editor-split',
    ]);
    expect([...app.querySelector('.editor-split')!.children].map((c) => c.className)).toEqual([
      'editor-area',
    ]);
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

    emit('file.new');
    expect(document.querySelector('.preview-pane')).toBeNull();

    emit('tab.previous');

    const pane = document.querySelector<HTMLElement>('.preview-pane')!;
    expect(pane).not.toBeNull();
    expect(pane.querySelector('h1')?.textContent).toBe('Split tab');
  });

  // The menu item shipped disabled and was flipped by this task. An
  // aria-disabled item is still focusable but `activateItem` refuses to run
  // its command (ui/menubar.ts), so this is what proves the flip happened.
  it('is reachable from View > Preview', async () => {
    const active = activeDocument(store.getState())!;
    setViewModeOf(active.id, 'source');

    document.querySelector<HTMLButtonElement>('#menubar-trigger-view')!.click();
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (button) => button.textContent?.startsWith('Preview'),
    )!;
    expect(item.getAttribute('aria-disabled')).toBeNull();

    item.click();
    await waitForPane(true);
  });
});
