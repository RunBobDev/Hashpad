// @vitest-environment jsdom
/**
 * `editor.openedViewMode` (design §4.27a): what an *existing* document opens in,
 * by every route to one -- Ctrl+O, File > Open, a drop, a double-click,
 * Ctrl+Shift+T.
 *
 * **Its own file because the pane must start unmounted.** The gap this covers is
 * that opening a file can now ask for a mode with a pane from `documentops.ts`,
 * which cannot import the preview at all: it is in the entry bundle and the pane
 * is the lazy chunk. Before this, the store subscription returned early on a
 * null handle, so the document carried the right mode and showed nothing.
 *
 * That state is unreachable in `main.preview.test.ts`, where a bootstrap runs
 * once per module instance and any earlier case may already have mounted the
 * pane. Measured: with the fallback removed, all 1354 tests still passed.
 *
 * So this file boots with `defaultViewMode: 'source'` -- nothing mounts a pane
 * at startup -- and `openedViewMode: 'split'`, and then opens a file.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { store } from './state/appcontext';
import { activeDocument } from './state/documents';
import { ShowWindow, ReadFile, ShowOpenDialog } from '../wailsjs/go/app/App';
import { COMMAND_EVENT } from './ui/menubar';

vi.mock('../wailsjs/runtime/runtime', () => ({
  EventsOn: vi.fn(() => () => {}),
  Quit: vi.fn(),
  WindowMinimise: vi.fn(),
  OnFileDrop: vi.fn(),
  OnFileDropOff: vi.fn(),
  WindowIsFullscreen: vi.fn(async () => false),
  WindowFullscreen: vi.fn(),
  WindowUnfullscreen: vi.fn(),
  WindowSetBackgroundColour: vi.fn(),
  WindowSetTitle: vi.fn(),
  WindowShow: vi.fn(),
  WindowToggleMaximise: vi.fn(),
}));

vi.mock('../wailsjs/go/app/App', () => ({
  PendingFiles: vi.fn().mockResolvedValue([]),
  ConfirmQuit: vi.fn(),
  ShowWindow: vi.fn(),
  LoadSettings: vi.fn().mockResolvedValue({
    appearance: { theme: 'system', accentColor: '#0078d4' },
    toolbar: { visible: true, pinned: ['bold'] },
    window: {
      previewSplitRatio: 0.5,
      statusBarVisible: true,
      outlineVisible: false,
      outlineWidth: 240,
    },
    preview: { syncScroll: true },
    editor: {
      wordWrap: true,
      // Source at startup, so nothing mounts the pane before the test runs --
      // which is the whole point of this file.
      defaultViewMode: 'source',
      openedViewMode: 'split',
      recentViewModes: [],
    },
    files: { defaultEncoding: 'utf-8' },
  }),
  ReadFile: vi.fn(),
  ResetSettings: vi.fn(),
  SaveSettings: vi.fn().mockResolvedValue(undefined),
  ShowOpenDialog: vi.fn(),
  ShowSaveDialog: vi.fn(),
  SystemThemeIsDark: vi.fn().mockResolvedValue(false),
  WriteFile: vi.fn(),
}));

function emit(command: string): void {
  document.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: command }));
}

describe('opening a file when the preview has never been mounted', () => {
  beforeAll(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await import('./main');
    await vi.waitFor(() => expect(ShowWindow).toHaveBeenCalled());
  });

  /**
   * **One test, not two, and that is a correctness point rather than tidiness.**
   *
   * The starting state -- source mode, no pane -- was its own case at first, and
   * it is not an independent fact: the case below *opens a file*, which makes a
   * split document active and leaves the pane mounted. Run in that order, the
   * precondition is already gone and the assertion fails. Caught by
   * `--sequence.shuffle`, on two runs out of three; the default order happened
   * to be the passing one.
   *
   * A precondition belongs to the scenario that needs it. Asserted here so a
   * failure still says which half broke.
   *
   * Both halves below fail separately, too. The mode reaching the document is
   * `documentops.ts` reading the right setting; the pane appearing is the
   * subscription importing the chunk on demand. The first without the second is
   * exactly the bug this file exists for: a document that says split, over an
   * editor with nothing beside it.
   */
  it('opens the file in the mode for existing documents, and mounts the pane for it', async () => {
    // The precondition: nothing has mounted a pane yet, because the startup
    // document is in source mode. Without this the case below could pass
    // against a pane some earlier work had already put on screen.
    expect(activeDocument(store.getState())!.viewMode).toBe('source');
    expect(document.querySelector('.preview-pane')).toBeNull();

    vi.mocked(ShowOpenDialog).mockResolvedValue(['C:/notes/opened.md']);
    vi.mocked(ReadFile).mockResolvedValue({
      path: 'C:/notes/opened.md',
      content: '# Opened\n',
      encoding: 'utf-8',
      lineEnding: 'lf',
      mixed: false,
    } as unknown as Awaited<ReturnType<typeof ReadFile>>);

    emit('file.open');

    await vi.waitFor(() => {
      expect(activeDocument(store.getState())!.filePath).toBe('C:/notes/opened.md');
    });
    expect(activeDocument(store.getState())!.viewMode).toBe('split');

    // The pane arrives a tick later than the mode: the import is a real await.
    await vi.waitFor(() => {
      expect(document.querySelector('.preview-pane')).not.toBeNull();
    });
  });
});
