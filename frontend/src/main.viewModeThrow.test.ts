// @vitest-environment jsdom
/**
 * What happens when restoring the saved view mode *fails*.
 *
 * Not a hypothetical worth its own file for its own sake -- it is here because
 * restoring `"split"` put a new `await` in front of `ShowWindow()`, and
 * main.go's StartHidden means an unguarded throw there leaves the window
 * permanently invisible. That is the exact failure Checkpoint D hit and had to
 * add a Go-side backstop for, and it is worth a test rather than a comment
 * saying it was thought about.
 *
 * Its own file for the usual reason: a bootstrap runs once per module instance,
 * and this one needs the preview module to be unloadable.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { store } from './state/appcontext';
import { activeDocument } from './state/documents';
import { ShowWindow } from '../wailsjs/go/app/App';

// A factory that throws makes the dynamic `import()` in `showPreview` reject,
// which is the closest stand-in for the real failure (a missing or corrupt
// chunk) that a test can arrange.
vi.mock('./preview/pane', () => {
  throw new Error('preview chunk unavailable');
});

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
  ConfirmQuit: vi.fn(),
  ShowWindow: vi.fn(),
  LoadSettings: vi.fn().mockResolvedValue({
    appearance: { theme: 'system', accentColor: '#0078d4' },
    toolbar: { visible: true, pinned: ['bold'] },
    window: {
      previewSplitRatio: 0.3,
      statusBarVisible: true,
      outlineVisible: false,
      outlineWidth: 240,
    },
    preview: { syncScroll: true },
    editor: { wordWrap: true, defaultViewMode: 'split' },
    // Go always sends this block, so a mock without it makes bootstrap throw
    // where the real app never can -- and a bootstrap that throws runs its
    // catch path, seeding every setting from the compiled-in defaults instead
    // of from this mock. See main.toolbarSeed.test.ts for the time that bit.
    files: { defaultEncoding: 'utf-8' },
  }),
  ReadFile: vi.fn(),
  SaveSettings: vi.fn(),
  ShowOpenDialog: vi.fn(),
  ShowSaveDialog: vi.fn(),
  SystemThemeIsDark: vi.fn().mockResolvedValue(false),
  WriteFile: vi.fn(),
}));

describe('a saved view mode that cannot be restored', () => {
  beforeAll(async () => {
    // The rejection is logged, not thrown -- silenced here so a deliberate
    // failure path does not print a stack into a passing run.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    document.body.innerHTML = '<div id="app"></div>';
    await import('./main');
    await vi.waitFor(() => expect(ShowWindow).toHaveBeenCalled());
  });

  /** The whole point. An invisible window is not a degraded app, it is no app. */
  it('still shows the window', () => {
    expect(ShowWindow).toHaveBeenCalled();
  });

  it('leaves the editor usable, in source mode', () => {
    expect(activeDocument(store.getState())!.viewMode).toBe('source');
    expect(document.querySelector('.cm-content')).not.toBeNull();
  });

  /**
   * The seeded `'split'` has to come back out of the store, not just be left
   * there unused. Every tab opened afterwards reads this field, so a `'split'`
   * that outlived the pane would mint documents the subscription cannot show --
   * View > Preview sitting checked over an editor with no preview beside it,
   * which is a worse outcome than losing the setting for one session.
   */
  it('does not leave the store claiming a mode it could not enter', () => {
    expect(store.getState().defaultViewMode).toBe('source');
  });
});
